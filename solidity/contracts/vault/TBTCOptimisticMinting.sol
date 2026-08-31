// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

import "../bridge/Bridge.sol";
import "../bridge/Deposit.sol";
import "../GovernanceUtils.sol";

/// @title TBTC Optimistic Minting
/// @notice The Optimistic Minting mechanism allows to mint TBTC before
///         `TBTCVault` receives the Bank balance. There are two permissioned
///         sets in the system: Minters and Guardians, both set up in 1-of-n
///         mode. Minters observe the revealed deposits and request minting TBTC.
///         Any single Minter can perform this action. There is an
///         `optimisticMintingDelay` between the time of the request from
///         a Minter to the time TBTC is minted. During the time of the delay,
///         any Guardian can cancel the minting. For non-exempt requesters,
///         total outstanding optimistic minting exposure — TBTC minted
///         optimistically but not yet backed by swept deposits, plus the
///         value of in-flight requests — is capped; per-Minter token buckets
///         refill continuously at their configured capacity per 24 hours;
///         and the size of a single deposit eligible for optimistic minting
///         is bounded.
/// @dev This functionality is a part of `TBTCVault`. It is implemented in
///      a separate abstract contract to achieve better separation of concerns
///      and easier-to-follow code.
abstract contract TBTCOptimisticMinting is Ownable {
    // Represents optimistic minting request for the given deposit revealed
    // to the Bridge.
    struct OptimisticMintingRequest {
        // UNIX timestamp at which the optimistic minting was requested.
        uint64 requestedAt;
        // UNIX timestamp at which the optimistic minting was finalized.
        // 0 if not yet finalized.
        uint64 finalizedAt;
    }

    // Tracks the remaining optimistic minting allowance of a Minter's
    // rate-limiting buckets. Each dimension refills continuously over time,
    // at a rate of the full cap per 24 hours, up to the cap. A dimension is
    // tracked only while its limit is enabled; a dimension with a zero
    // timestamp has never been tracked and is considered full.
    struct OptimisticMintingAllowance {
        // Remaining value of deposits (in satoshi) that can be a subject of
        // an optimistic minting request before the bucket exhausts.
        uint64 valueRemaining;
        // UNIX timestamp at which value tokens were last credited. Zero if
        // the value dimension has never been tracked.
        uint64 valueRefilledAt;
        // Remaining number of optimistic minting requests that can be
        // submitted before the bucket exhausts.
        uint32 requestsRemaining;
        // UNIX timestamp at which request tokens were last credited. Zero if
        // the request count dimension has never been tracked.
        uint64 requestsRefilledAt;
    }

    /// @notice The time delay that needs to pass between initializing and
    ///         finalizing the upgrade of governable parameters.
    uint256 public constant GOVERNANCE_DELAY = 24 hours;

    /// @notice Multiplier to convert satoshi to TBTC token units.
    uint256 public constant SATOSHI_MULTIPLIER = 10**10;

    Bridge public immutable bridge;

    /// @notice Indicates if the optimistic minting has been paused. Only the
    ///         Governance can pause optimistic minting. Note that the pause of
    ///         the optimistic minting does not stop the standard minting flow
    ///         where wallets sweep deposits.
    bool public isOptimisticMintingPaused;

    /// @notice Divisor used to compute the treasury fee taken from each
    ///         optimistically minted deposit and transferred to the treasury
    ///         upon finalization of the optimistic mint. This fee is computed
    ///         as follows: `fee = amount / optimisticMintingFeeDivisor`.
    ///         For example, if the fee needs to be 2%, the
    ///         `optimisticMintingFeeDivisor` should be set to `50` because
    ///         `1/50 = 0.02 = 2%`.
    ///         The optimistic minting fee does not replace the deposit treasury
    ///         fee cut by the Bridge. The optimistic fee is a percentage AFTER
    ///         the treasury fee is cut:
    ///         `optimisticMintingFee = (depositAmount - treasuryFee) / optimisticMintingFeeDivisor`
    uint32 public optimisticMintingFeeDivisor = 500; // 1/500 = 0.002 = 0.2%

    /// @notice The time that needs to pass between the moment the optimistic
    ///         minting is requested and the moment optimistic minting is
    ///         finalized with minting TBTC.
    uint32 public optimisticMintingDelay = 3 hours;

    /// @notice The maximum total optimistic minting exposure (in satoshi)
    ///         that can be outstanding at any moment for non-exempt
    ///         requesters. When enforcing the cap, pending satoshi and the
    ///         cap are converted to 1e18 TBTC units with
    ///         `SATOSHI_MULTIPLIER` before being added to
    ///         `optimisticMintingDebtTotal` (also in 1e18 units). Sweep
    ///         miner-fee residuals excluded via
    ///         `optimisticMintingDebtCapExcludedTotal` do not consume cap
    ///         headroom. A request is rejected if it would push the exposure
    ///         above the cap. Capacity is recycled as deposits get swept and
    ///         the debt is repaid. Debt of deposits that never get swept
    ///         consumes the cap until governance resolves the situation, e.g.
    ///         by raising the cap; this acts as an automatic circuit breaker
    ///         when optimistically minted deposits do not settle. Zero value
    ///         means no limit.
    uint64 public optimisticMintingDebtCap = 1_000_000_000; // 10 BTC

    /// @notice The maximum total value of deposits (in satoshi) that can be
    ///         a subject of optimistic minting requests of a single Minter.
    ///         The limit is enforced with a token bucket that starts at the
    ///         configured capacity and refills continuously at the full
    ///         capacity per 24 hours. Zero value means no limit.
    ///         Per-Minter caps are meant to overlap: the sum of all Minters'
    ///         caps may exceed `optimisticMintingDebtCap`, which remains the
    ///         binding total limit.
    uint64 public optimisticMintingCapPerMinter = 1_000_000_000; // 10 BTC

    /// @notice The maximum size of a single deposit (in satoshi) that can be
    ///         a subject of an optimistic minting request. Deposits above
    ///         this size follow the standard flow and are minted when swept.
    ///         Zero value means no limit. Note the effective bound on
    ///         a single optimistically minted deposit is the smallest of this
    ///         limit, the per-Minter cap, and the debt cap, out of those that
    ///         are enabled.
    uint64 public optimisticMintingMaxDepositSize = 500_000_000; // 5 BTC

    /// @notice The maximum number of optimistic minting requests a single
    ///         Minter can submit. The limit is enforced with a token bucket
    ///         that starts at the configured capacity and refills continuously
    ///         at the full capacity per 24 hours. Zero value means no limit.
    ///         Independently of the value caps, this limit bounds the number
    ///         of requests Guardians may need to validate and cancel.
    uint32 public optimisticMintingRequestLimitPerMinter = 100;

    /// @notice Indicates if the given address is a Minter. Only Minters can
    ///         request optimistic minting.
    mapping(address => bool) public isMinter;

    /// @notice List of all Minters.
    /// @dev May be used to establish an order in which the Minters should
    ///      request for an optimistic minting.
    address[] public minters;

    /// @notice Indicates if the given address is a Guardian. Only Guardians can
    ///         cancel requested optimistic minting.
    mapping(address => bool) public isGuardian;

    /// @notice Collection of all revealed deposits for which the optimistic
    ///         minting was requested. Indexed by a deposit key computed as
    ///         `keccak256(fundingTxHash | fundingOutputIndex)`.
    mapping(uint256 => OptimisticMintingRequest)
        public optimisticMintingRequests;

    /// @notice Optimistic minting debt value per depositor's address. The debt
    ///         represents the total value of all depositor's deposits revealed
    ///         to the Bridge that has not been yet swept and led to the
    ///         optimistic minting of TBTC. When `TBTCVault` sweeps a deposit,
    ///         the debt is fully or partially paid off, no matter if that
    ///         particular swept deposit was used for the optimistic minting or
    ///         not. The values are in 1e18 Ethereum precision.
    mapping(address => uint256) public optimisticMintingDebt;

    /// @notice New optimistic minting fee divisor value. Set only when the
    ///         parameter update process is pending. Once the update gets
    //          finalized, this will be the value of the divisor.
    uint32 public newOptimisticMintingFeeDivisor;
    /// @notice The timestamp at which the update of the optimistic minting fee
    ///         divisor started. Zero if update is not in progress.
    uint256 public optimisticMintingFeeUpdateInitiatedTimestamp;

    /// @notice New optimistic minting delay value. Set only when the parameter
    ///         update process is pending. Once the update gets finalized, this
    //          will be the value of the delay.
    uint32 public newOptimisticMintingDelay;
    /// @notice The timestamp at which the update of the optimistic minting
    ///         delay started. Zero if update is not in progress.
    uint256 public optimisticMintingDelayUpdateInitiatedTimestamp;

    /// @notice Total value of deposits (in satoshi) with a pending — not yet
    ///         finalized and not cancelled — optimistic minting request.
    ///         Counted against `optimisticMintingDebtCap` together with the
    ///         outstanding `optimisticMintingDebtTotal`.
    uint64 public optimisticMintingPendingTotal;

    /// @notice The total outstanding optimistic minting debt across all
    ///         depositors, in 1e18 Ethereum precision. Increased when an
    ///         optimistic mint is finalized and decreased when the debt is
    ///         repaid by a swept deposit. Always equals the sum of all
    ///         `optimisticMintingDebt` values.
    uint256 public optimisticMintingDebtTotal;

    /// @notice Portion of `optimisticMintingDebtTotal` excluded from the
    ///         debt cap after a sweep leaves only the documented Bitcoin
    ///         miner-fee residual on a depositor's ledger.
    uint256 public optimisticMintingDebtCapExcludedTotal;

    /// @notice Per-depositor debt excluded from the debt cap. Set when a
    ///         sweep repayment leaves only miner-fee residual debt; cleared
    ///         when the depositor's debt is fully repaid.
    mapping(address => uint256) public optimisticMintingDebtCapExcluded;

    /// @notice Rate-limiting buckets tracking the remaining optimistic
    ///         minting allowance of individual Minters.
    /// @dev Raw bucket state; dimensions whose limits are disabled hold
    ///      stale values. Use `getOptimisticMintingAllowance` for
    ///      interpreted values.
    mapping(address => OptimisticMintingAllowance) public minterAllowances;

    /// @notice New optimistic minting debt cap value. Set only when the
    ///         parameter update process is pending. Once the update gets
    ///         finalized, this will be the value of the cap.
    uint64 public newOptimisticMintingDebtCap;
    /// @notice New per-Minter optimistic minting cap value. Set only when the
    ///         parameter update process is pending.
    uint64 public newOptimisticMintingCapPerMinter;
    /// @notice New maximum size of an optimistically minted deposit. Set only
    ///         when the parameter update process is pending.
    uint64 public newOptimisticMintingMaxDepositSize;
    /// @notice New per-Minter optimistic minting request limit. Set only when
    ///         the parameter update process is pending.
    uint32 public newOptimisticMintingRequestLimitPerMinter;
    /// @notice The timestamp at which the update of the optimistic minting
    ///         rate limits started. Zero if update is not in progress.
    uint256 public optimisticMintingCapsUpdateInitiatedTimestamp;

    event OptimisticMintingRequested(
        address indexed minter,
        uint256 indexed depositKey,
        address indexed depositor,
        uint256 amount, // amount in 1e18 Ethereum precision
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    );
    event OptimisticMintingFinalized(
        address indexed minter,
        uint256 indexed depositKey,
        address indexed depositor,
        uint256 optimisticMintingDebt
    );
    event OptimisticMintingCancelled(
        address indexed guardian,
        uint256 indexed depositKey
    );
    event OptimisticMintingPendingReleased(
        address indexed releaser,
        uint256 indexed depositKey
    );
    event OptimisticMintingDebtRepaid(
        address indexed depositor,
        uint256 optimisticMintingDebt
    );
    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);
    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);
    event OptimisticMintingPaused();
    event OptimisticMintingUnpaused();

    event OptimisticMintingFeeUpdateStarted(
        uint32 newOptimisticMintingFeeDivisor
    );
    event OptimisticMintingFeeUpdated(uint32 newOptimisticMintingFeeDivisor);

    event OptimisticMintingDelayUpdateStarted(uint32 newOptimisticMintingDelay);
    event OptimisticMintingDelayUpdated(uint32 newOptimisticMintingDelay);

    event OptimisticMintingCapsUpdateStarted(
        uint64 newOptimisticMintingDebtCap,
        uint64 newOptimisticMintingCapPerMinter,
        uint64 newOptimisticMintingMaxDepositSize,
        uint32 newOptimisticMintingRequestLimitPerMinter
    );
    event OptimisticMintingCapsUpdated(
        uint64 optimisticMintingDebtCap,
        uint64 optimisticMintingCapPerMinter,
        uint64 optimisticMintingMaxDepositSize,
        uint32 optimisticMintingRequestLimitPerMinter
    );

    event OptimisticMintingAllowanceConsumed(
        address indexed minter,
        uint64 amount, // amount in satoshi
        uint64 minterValueRemaining, // type(uint64).max if no per-Minter cap
        uint64 globalHeadroomRemaining // satoshi; type(uint64).max if no debt cap
    );

    modifier onlyMinter() {
        require(isMinter[msg.sender], "Caller is not a minter");
        _;
    }

    modifier onlyGuardian() {
        require(isGuardian[msg.sender], "Caller is not a guardian");
        _;
    }

    modifier onlyOwnerOrGuardian() {
        require(
            owner() == msg.sender || isGuardian[msg.sender],
            "Caller is not the owner or guardian"
        );
        _;
    }

    modifier whenOptimisticMintingNotPaused() {
        require(!isOptimisticMintingPaused, "Optimistic minting paused");
        _;
    }

    modifier onlyAfterGovernanceDelay(uint256 updateInitiatedTimestamp) {
        GovernanceUtils.onlyAfterGovernanceDelay(
            updateInitiatedTimestamp,
            GOVERNANCE_DELAY
        );
        _;
    }

    constructor(Bridge _bridge) {
        require(
            address(_bridge) != address(0),
            "Bridge can not be the zero address"
        );

        bridge = _bridge;
    }

    /// @dev Mints the given amount of TBTC to the given depositor's address.
    ///      Implemented by TBTCVault.
    function _mint(address minter, uint256 amount) internal virtual;

    /// @notice Allows to fetch a list of all Minters.
    function getMinters() external view returns (address[] memory) {
        return minters;
    }

    /// @notice Allows a Minter to request for an optimistic minting of TBTC.
    ///         The following conditions must be met:
    ///         - There is no optimistic minting request for the deposit,
    ///           finalized or not.
    ///         - The deposit with the given Bitcoin funding transaction hash
    ///           and output index has been revealed to the Bridge.
    ///         - The deposit has not been swept yet.
    ///         - The deposit is targeted into the TBTCVault.
    ///         - The optimistic minting is not paused.
    ///         - For non-exempt requesters, each enabled control must pass:
    ///           the deposit-size limit, the per-Minter value and request-count
    ///           token buckets, and the global outstanding-plus-pending
    ///           exposure cap.
    ///         After calling this function, the Minter has to wait for
    ///         `optimisticMintingDelay` before finalizing the mint with a call
    ///         to finalizeOptimisticMint.
    /// @dev The deposit done on the Bitcoin side must be revealed early enough
    ///      to the Bridge on Ethereum to pass the Bridge's validation. The
    ///      validation passes successfully only if the deposit reveal is done
    ///      respectively earlier than the moment when the deposit refund
    ///      locktime is reached, i.e. the deposit becomes refundable. It may
    ///      happen that the wallet does not sweep a revealed deposit and one of
    ///      the Minters requests an optimistic mint for that deposit just
    ///      before the locktime is reached. Guardians must cancel optimistic
    ///      minting for this deposit because the wallet will not be able to
    ///      sweep it. The on-chain optimistic minting code does not perform any
    ///      validation for gas efficiency: it would have to perform the same
    ///      validation as `validateDepositRefundLocktime` and expect the entire
    ///      `DepositRevealInfo` to be passed to assemble the expected script
    ///      hash on-chain. Guardians must validate if the deposit happened on
    ///      Bitcoin, that the script hash has the expected format, and that the
    ///      wallet is an active one so they can also validate the time left for
    ///      the refund.
    function requestOptimisticMint(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    ) external onlyMinter whenOptimisticMintingNotPaused {
        uint256 depositKey = calculateDepositKey(
            fundingTxHash,
            fundingOutputIndex
        );

        OptimisticMintingRequest storage request = optimisticMintingRequests[
            depositKey
        ];
        require(
            request.requestedAt == 0,
            "Optimistic minting already requested for the deposit"
        );

        Deposit.DepositRequest memory deposit = bridge.deposits(depositKey);

        require(deposit.revealedAt != 0, "The deposit has not been revealed");
        require(deposit.sweptAt == 0, "The deposit is already swept");
        require(deposit.vault == address(this), "Unexpected vault address");

        if (!_isOptimisticMintingThrottleExempt(msg.sender)) {
            _consumeOptimisticMintingAllowance(deposit.amount);
        }

        // The in-flight requested value is tracked for all requests,
        // including the ones of throttle-exempt requesters, so that
        // `optimisticMintingPendingTotal` always measures the actual
        // in-flight exposure.
        optimisticMintingPendingTotal += deposit.amount;

        if (_isOptimisticMintingThrottleExempt(msg.sender)) {
            _emitOptimisticMintingAllowanceConsumed(
                msg.sender,
                deposit.amount,
                true,
                0,
                0
            );
        }

        /* solhint-disable-next-line not-rely-on-time */
        request.requestedAt = uint64(block.timestamp);

        emit OptimisticMintingRequested(
            msg.sender,
            depositKey,
            deposit.depositor,
            deposit.amount * SATOSHI_MULTIPLIER,
            fundingTxHash,
            fundingOutputIndex
        );
    }

    /// @notice Allows a Minter to finalize previously requested optimistic
    ///         minting. The following conditions must be met:
    ///         - The optimistic minting has been requested for the given
    ///           deposit.
    ///         - The deposit has not been swept yet.
    ///         - At least `optimisticMintingDelay` passed since the optimistic
    ///           minting was requested for the given deposit.
    ///         - The optimistic minting has not been finalized earlier for the
    ///           given deposit.
    ///         - The optimistic minting request for the given deposit has not
    ///           been canceled by a Guardian.
    ///         - The optimistic minting is not paused.
    ///         This function mints TBTC and increases `optimisticMintingDebt`
    ///         for the given depositor. The optimistic minting request is
    ///         marked as finalized.
    function finalizeOptimisticMint(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    ) external onlyMinter whenOptimisticMintingNotPaused {
        uint256 depositKey = calculateDepositKey(
            fundingTxHash,
            fundingOutputIndex
        );

        OptimisticMintingRequest storage request = optimisticMintingRequests[
            depositKey
        ];
        require(
            request.requestedAt != 0,
            "Optimistic minting not requested for the deposit"
        );
        require(
            request.finalizedAt == 0,
            "Optimistic minting already finalized for the deposit"
        );

        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp > request.requestedAt + optimisticMintingDelay,
            "Optimistic minting delay has not passed yet"
        );

        Deposit.DepositRequest memory deposit = bridge.deposits(depositKey);
        require(deposit.sweptAt == 0, "The deposit is already swept");

        // Bridge, when sweeping, cuts a deposit treasury fee and splits
        // Bitcoin miner fee for the sweep transaction evenly between the
        // depositors in the sweep.
        //
        // When tokens are optimistically minted, we do not know what the
        // Bitcoin miner fee for the sweep transaction will look like.
        // The Bitcoin miner fee is ignored. When sweeping, the miner fee is
        // subtracted so the optimisticMintingDebt may stay non-zero after the
        // deposit is swept.
        //
        // This imbalance is supposed to be solved by a donation to the Bridge.
        uint256 amountToMint = (deposit.amount - deposit.treasuryFee) *
            SATOSHI_MULTIPLIER;

        // The Optimistic Minting mechanism may additionally cut a fee from the
        // amount that is left after deducting the Bridge deposit treasury fee.
        // Think of this fee as an extra payment for faster processing of
        // deposits. One does not need to use the Optimistic Minting mechanism
        // and they may wait for the Bridge to sweep their deposit if they do
        // not want to pay the Optimistic Minting fee.
        uint256 optimisticMintFee = optimisticMintingFeeDivisor > 0
            ? (amountToMint / optimisticMintingFeeDivisor)
            : 0;

        // The request is no longer in-flight: its value moves from the
        // pending total to the outstanding debt total.
        optimisticMintingPendingTotal -= deposit.amount;

        // Both the optimistic minting fee and the share that goes to the
        // depositor are optimistically minted. All TBTC that is optimistically
        // minted should be added to the optimistic minting debt. When the
        // deposit is swept, it is paying off both the depositor's share and the
        // treasury's share (optimistic minting fee).
        uint256 newDebt = optimisticMintingDebt[deposit.depositor] +
            amountToMint;
        optimisticMintingDebt[deposit.depositor] = newDebt;
        optimisticMintingDebtTotal += amountToMint;

        _mint(deposit.depositor, amountToMint - optimisticMintFee);
        if (optimisticMintFee > 0) {
            _mint(bridge.treasury(), optimisticMintFee);
        }

        /* solhint-disable-next-line not-rely-on-time */
        request.finalizedAt = uint64(block.timestamp);

        emit OptimisticMintingFinalized(
            msg.sender,
            depositKey,
            deposit.depositor,
            newDebt
        );
    }

    /// @notice Allows a Guardian to cancel optimistic minting request. The
    ///         following conditions must be met:
    ///         - The optimistic minting request for the given deposit exists.
    ///         - The optimistic minting request for the given deposit has not
    ///           been finalized yet.
    ///         Optimistic minting request is removed. It is possible to request
    ///         optimistic minting again for the same deposit later.
    ///         Cancelling releases the deposit value from the in-flight
    ///         requested total counted against `optimisticMintingDebtCap`.
    ///         For non-exempt requesters, any per-Minter allowance consumed by
    ///         the request is deliberately not restored, preventing
    ///         cancellation from bypassing those limits. Exempt requests
    ///         consume no per-Minter allowance. Deposits swept before
    ///         finalization can also be released permissionlessly via
    ///         `releaseOptimisticMintForSweptDeposit`.
    /// @dev Guardians must validate the following conditions for every deposit
    ///      for which the optimistic minting was requested:
    ///      - The deposit happened on Bitcoin side and it has enough
    ///        confirmations.
    ///      - The optimistic minting has been requested early enough so that
    ///        the wallet has enough time to sweep the deposit.
    ///      - The wallet is an active one and it does perform sweeps or it will
    ///        perform sweeps once the sweeps are activated.
    function cancelOptimisticMint(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    ) external onlyGuardian {
        uint256 depositKey = calculateDepositKey(
            fundingTxHash,
            fundingOutputIndex
        );

        OptimisticMintingRequest storage request = optimisticMintingRequests[
            depositKey
        ];
        require(
            request.requestedAt != 0,
            "Optimistic minting not requested for the deposit"
        );
        require(
            request.finalizedAt == 0,
            "Optimistic minting already finalized for the deposit"
        );

        // Release pending exposure; any per-Minter allowance consumed by the
        // request is intentionally not restored.
        optimisticMintingPendingTotal -= bridge.deposits(depositKey).amount;

        // Delete it. It allows to request optimistic minting for the given
        // deposit again. Useful in case of an errant Guardian.
        delete optimisticMintingRequests[depositKey];

        emit OptimisticMintingCancelled(msg.sender, depositKey);
    }

    /// @notice Releases an unfinalized optimistic minting request whose
    ///         Bridge deposit has already been swept. Permissionless once the
    ///         deposit is swept because the request can no longer finalize.
    ///         Releases pending exposure without restoring any per-Minter
    ///         allowance consumed by the original request.
    /// @param fundingTxHash Bitcoin funding transaction hash of the deposit.
    /// @param fundingOutputIndex Funding transaction output index.
    function releaseOptimisticMintForSweptDeposit(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    ) external {
        uint256 depositKey = calculateDepositKey(
            fundingTxHash,
            fundingOutputIndex
        );

        OptimisticMintingRequest storage request = optimisticMintingRequests[
            depositKey
        ];
        require(
            request.requestedAt != 0,
            "Optimistic minting not requested for the deposit"
        );
        require(
            request.finalizedAt == 0,
            "Optimistic minting already finalized for the deposit"
        );

        Deposit.DepositRequest memory deposit = bridge.deposits(depositKey);
        require(deposit.sweptAt != 0, "The deposit is not swept yet");

        optimisticMintingPendingTotal -= deposit.amount;
        delete optimisticMintingRequests[depositKey];

        emit OptimisticMintingPendingReleased(msg.sender, depositKey);
    }

    /// @notice Returns the current optimistic minting allowance of the given
    ///         Minter, including the continuous refill accrued up to the
    ///         current block timestamp, and the remaining global debt cap
    ///         headroom.
    /// @dev Fields corresponding to disabled limits are returned as maximum
    ///      values of their types. Intended for off-chain Minter clients and
    ///      monitoring.
    /// @param minter The Minter to return the allowance for.
    /// @return minterValueRemaining Remaining value (in satoshi) the Minter
    ///         can request before their bucket exhausts.
    /// @return minterRequestsRemaining Remaining number of requests the
    ///         Minter can submit before their bucket exhausts.
    /// @return globalHeadroomRemaining Remaining value (in satoshi) that a
    ///         non-exempt request can add before the total outstanding and
    ///         in-flight exposure reaches `optimisticMintingDebtCap`.
    function getOptimisticMintingAllowance(address minter)
        external
        view
        returns (
            uint64 minterValueRemaining,
            uint32 minterRequestsRemaining,
            uint64 globalHeadroomRemaining
        )
    {
        uint64 capPerMinter = optimisticMintingCapPerMinter;
        uint32 requestLimit = optimisticMintingRequestLimitPerMinter;
        OptimisticMintingAllowance memory allowance = _refillAllowance(
            minterAllowances[minter],
            capPerMinter,
            requestLimit
        );
        minterValueRemaining = capPerMinter != 0
            ? allowance.valueRemaining
            : type(uint64).max;
        minterRequestsRemaining = requestLimit != 0
            ? allowance.requestsRemaining
            : type(uint32).max;

        uint64 debtCap = optimisticMintingDebtCap;
        globalHeadroomRemaining = debtCap != 0
            ? _globalHeadroomRemaining(0)
            : type(uint64).max;
    }

    /// @notice Adds the address to the Minter list.
    function addMinter(address minter) external onlyOwner {
        require(!isMinter[minter], "This address is already a minter");
        isMinter[minter] = true;
        minters.push(minter);
        emit MinterAdded(minter);
    }

    /// @notice Removes the address from the Minter list.
    function removeMinter(address minter) external onlyOwnerOrGuardian {
        require(isMinter[minter], "This address is not a minter");
        delete isMinter[minter];

        // We do not expect too many Minters so a simple loop is safe.
        for (uint256 i = 0; i < minters.length; i++) {
            if (minters[i] == minter) {
                minters[i] = minters[minters.length - 1];
                // slither-disable-next-line costly-loop
                minters.pop();
                break;
            }
        }

        emit MinterRemoved(minter);
    }

    /// @notice Adds the address to the Guardian set.
    function addGuardian(address guardian) external onlyOwner {
        require(!isGuardian[guardian], "This address is already a guardian");
        isGuardian[guardian] = true;
        emit GuardianAdded(guardian);
    }

    /// @notice Removes the address from the Guardian set.
    function removeGuardian(address guardian) external onlyOwner {
        require(isGuardian[guardian], "This address is not a guardian");
        delete isGuardian[guardian];
        emit GuardianRemoved(guardian);
    }

    /// @notice Pauses the optimistic minting. Note that the pause of the
    ///         optimistic minting does not stop the standard minting flow
    ///         where wallets sweep deposits.
    function pauseOptimisticMinting() external onlyOwner {
        require(
            !isOptimisticMintingPaused,
            "Optimistic minting already paused"
        );
        isOptimisticMintingPaused = true;
        emit OptimisticMintingPaused();
    }

    /// @notice Unpauses the optimistic minting.
    function unpauseOptimisticMinting() external onlyOwner {
        require(isOptimisticMintingPaused, "Optimistic minting is not paused");
        isOptimisticMintingPaused = false;
        emit OptimisticMintingUnpaused();
    }

    /// @notice Begins the process of updating optimistic minting fee.
    ///         The fee is computed as follows:
    ///         `fee = amount / optimisticMintingFeeDivisor`.
    ///         For example, if the fee needs to be 2% of each deposit,
    ///         the `optimisticMintingFeeDivisor` should be set to `50` because
    ///         `1/50 = 0.02 = 2%`.
    /// @dev See the documentation for optimisticMintingFeeDivisor.
    function beginOptimisticMintingFeeUpdate(
        uint32 _newOptimisticMintingFeeDivisor
    ) external onlyOwner {
        /* solhint-disable-next-line not-rely-on-time */
        optimisticMintingFeeUpdateInitiatedTimestamp = block.timestamp;
        newOptimisticMintingFeeDivisor = _newOptimisticMintingFeeDivisor;
        emit OptimisticMintingFeeUpdateStarted(_newOptimisticMintingFeeDivisor);
    }

    /// @notice Finalizes the update process of the optimistic minting fee.
    function finalizeOptimisticMintingFeeUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(optimisticMintingFeeUpdateInitiatedTimestamp)
    {
        optimisticMintingFeeDivisor = newOptimisticMintingFeeDivisor;
        emit OptimisticMintingFeeUpdated(newOptimisticMintingFeeDivisor);

        newOptimisticMintingFeeDivisor = 0;
        optimisticMintingFeeUpdateInitiatedTimestamp = 0;
    }

    /// @notice Begins the process of updating optimistic minting delay.
    function beginOptimisticMintingDelayUpdate(
        uint32 _newOptimisticMintingDelay
    ) external onlyOwner {
        /* solhint-disable-next-line not-rely-on-time */
        optimisticMintingDelayUpdateInitiatedTimestamp = block.timestamp;
        newOptimisticMintingDelay = _newOptimisticMintingDelay;
        emit OptimisticMintingDelayUpdateStarted(_newOptimisticMintingDelay);
    }

    /// @notice Finalizes the update process of the optimistic minting delay.
    function finalizeOptimisticMintingDelayUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(optimisticMintingDelayUpdateInitiatedTimestamp)
    {
        optimisticMintingDelay = newOptimisticMintingDelay;
        emit OptimisticMintingDelayUpdated(newOptimisticMintingDelay);

        newOptimisticMintingDelay = 0;
        optimisticMintingDelayUpdateInitiatedTimestamp = 0;
    }

    /// @notice Begins the process of updating the optimistic minting limits:
    ///         the debt cap, the per-Minter cap, the maximum size of an
    ///         optimistically minted deposit, and the per-Minter request
    ///         limit. The limits are updated together as they form a single
    ///         exposure-limiting policy. Zero value disables the given limit.
    /// @dev See the documentation of `optimisticMintingDebtCap`,
    ///      `optimisticMintingCapPerMinter`, `optimisticMintingMaxDepositSize`
    ///      and `optimisticMintingRequestLimitPerMinter`.
    /// @param _optimisticMintingDebtCap The new debt cap, in satoshi.
    /// @param _optimisticMintingCapPerMinter The new per-Minter cap,
    ///        in satoshi.
    /// @param _optimisticMintingMaxDepositSize The new maximum size of an
    ///        optimistically minted deposit, in satoshi.
    /// @param _optimisticMintingRequestLimitPerMinter The new per-Minter
    ///        request limit.
    function beginOptimisticMintingCapsUpdate(
        uint64 _optimisticMintingDebtCap,
        uint64 _optimisticMintingCapPerMinter,
        uint64 _optimisticMintingMaxDepositSize,
        uint32 _optimisticMintingRequestLimitPerMinter
    ) external onlyOwner {
        /* solhint-disable-next-line not-rely-on-time */
        optimisticMintingCapsUpdateInitiatedTimestamp = block.timestamp;
        newOptimisticMintingDebtCap = _optimisticMintingDebtCap;
        newOptimisticMintingCapPerMinter = _optimisticMintingCapPerMinter;
        newOptimisticMintingMaxDepositSize = _optimisticMintingMaxDepositSize;
        // solhint-disable-next-line max-line-length
        newOptimisticMintingRequestLimitPerMinter = _optimisticMintingRequestLimitPerMinter;
        emit OptimisticMintingCapsUpdateStarted(
            _optimisticMintingDebtCap,
            _optimisticMintingCapPerMinter,
            _optimisticMintingMaxDepositSize,
            _optimisticMintingRequestLimitPerMinter
        );
    }

    /// @notice Finalizes the update process of the optimistic minting
    ///         limits.
    function finalizeOptimisticMintingCapsUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(optimisticMintingCapsUpdateInitiatedTimestamp)
    {
        optimisticMintingDebtCap = newOptimisticMintingDebtCap;
        optimisticMintingCapPerMinter = newOptimisticMintingCapPerMinter;
        optimisticMintingMaxDepositSize = newOptimisticMintingMaxDepositSize;
        // solhint-disable-next-line max-line-length
        optimisticMintingRequestLimitPerMinter = newOptimisticMintingRequestLimitPerMinter;
        emit OptimisticMintingCapsUpdated(
            newOptimisticMintingDebtCap,
            newOptimisticMintingCapPerMinter,
            newOptimisticMintingMaxDepositSize,
            newOptimisticMintingRequestLimitPerMinter
        );

        newOptimisticMintingDebtCap = 0;
        newOptimisticMintingCapPerMinter = 0;
        newOptimisticMintingMaxDepositSize = 0;
        newOptimisticMintingRequestLimitPerMinter = 0;
        optimisticMintingCapsUpdateInitiatedTimestamp = 0;
    }

    /// @notice Calculates deposit key the same way as the Bridge contract.
    ///         The deposit key is computed as
    ///         `keccak256(fundingTxHash | fundingOutputIndex)`.
    function calculateDepositKey(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    ) public pure returns (uint256) {
        return
            uint256(
                keccak256(abi.encodePacked(fundingTxHash, fundingOutputIndex))
            );
    }

    /// @notice Used by `TBTCVault.receiveBalanceIncrease` to repay the optimistic
    ///         minting debt before TBTC is minted. When optimistic minting is
    ///         finalized, debt equal to the value of the deposit being
    ///         a subject of the optimistic minting is incurred. When `TBTCVault`
    ///         sweeps a deposit, the debt is fully or partially paid off, no
    ///         matter if that particular deposit was used for the optimistic
    ///         minting or not.
    /// @dev See `TBTCVault.receiveBalanceIncrease`
    /// @param depositor The depositor whose balance increase is received.
    /// @param amount The balance increase amount for the depositor received.
    /// @return The TBTC amount that should be minted after paying off the
    ///         optimistic minting debt.
    function repayOptimisticMintingDebt(address depositor, uint256 amount)
        internal
        returns (uint256)
    {
        uint256 debt = optimisticMintingDebt[depositor];
        if (debt == 0) {
            return amount;
        }

        if (amount > debt) {
            optimisticMintingDebt[depositor] = 0;
            // slither-disable-next-line costly-loop
            optimisticMintingDebtTotal -= debt;
            _clearOptimisticMintingDebtCapExclusion(depositor);
            emit OptimisticMintingDebtRepaid(depositor, 0);
            return amount - debt;
        } else {
            optimisticMintingDebt[depositor] = debt - amount;
            // slither-disable-next-line costly-loop
            optimisticMintingDebtTotal -= amount;
            if (debt - amount == 0) {
                _clearOptimisticMintingDebtCapExclusion(depositor);
            }
            emit OptimisticMintingDebtRepaid(depositor, debt - amount);
            return 0;
        }
    }

    /// @notice Checks the enabled deposit-size, per-Minter token-bucket, and
    ///         global exposure limits for `amount`, then consumes the
    ///         applicable per-Minter allowances. The caller records an accepted
    ///         amount in pending exposure after this function returns.
    /// @dev Consumed allowance is not restored when the request gets
    ///      cancelled by a Guardian. See `cancelOptimisticMint`.
    /// @param amount The deposit amount in satoshi.
    function _consumeOptimisticMintingAllowance(uint64 amount) internal {
        if (optimisticMintingMaxDepositSize != 0) {
            require(
                amount <= optimisticMintingMaxDepositSize,
                "Deposit exceeds optimistic minting size cap"
            );
        }

        uint64 minterValueRemaining = type(uint64).max;
        uint64 globalHeadroomRemaining = type(uint64).max;

        uint64 capPerMinter = optimisticMintingCapPerMinter;
        uint32 requestLimit = optimisticMintingRequestLimitPerMinter;
        if (capPerMinter != 0 || requestLimit != 0) {
            OptimisticMintingAllowance memory allowance = _refillAllowance(
                minterAllowances[msg.sender],
                capPerMinter,
                requestLimit
            );
            if (capPerMinter != 0) {
                require(
                    allowance.valueRemaining >= amount,
                    "Optimistic minting minter cap exceeded"
                );
                allowance.valueRemaining -= amount;
                minterValueRemaining = allowance.valueRemaining;
            }
            if (requestLimit != 0) {
                require(
                    allowance.requestsRemaining >= 1,
                    "Optimistic minting request limit exceeded"
                );
                allowance.requestsRemaining -= 1;
            }
            minterAllowances[msg.sender] = allowance;
        }

        uint64 debtCap = optimisticMintingDebtCap;
        if (debtCap != 0) {
            require(
                _globalExposure(amount) <= uint256(debtCap) * SATOSHI_MULTIPLIER,
                "Optimistic minting debt cap exceeded"
            );
            globalHeadroomRemaining = _globalHeadroomRemaining(amount);
        }

        _emitOptimisticMintingAllowanceConsumed(
            msg.sender,
            amount,
            false,
            minterValueRemaining,
            globalHeadroomRemaining
        );
    }

    /// @notice Indicates whether the given optimistic minting requester is
    ///         exempt from the optimistic minting limits. Always false in
    ///         this contract.
    /// @dev Derived contracts may override this function to exempt classes of
    ///      requesters whose issuance is bounded by separate, dedicated
    ///      exposure limits. Exempt requesters bypass the debt cap, value,
    ///      request count, and deposit size checks and do not consume any
    ///      per-Minter allowance. Their requests still count toward the
    ///      `optimisticMintingPendingTotal` and `optimisticMintingDebtTotal`
    ///      measurements, reducing the headroom available to non-exempt
    ///      Minters; overriding contracts must account for this overlap.
    function _isOptimisticMintingThrottleExempt(address)
        internal
        view
        virtual
        returns (bool)
    {
        return false;
    }

    function _capRelevantDebtTotal() internal view returns (uint256) {
        uint256 excluded = optimisticMintingDebtCapExcludedTotal;
        uint256 total = optimisticMintingDebtTotal;
        return excluded >= total ? 0 : total - excluded;
    }

    function _globalExposure(uint64 additionalPendingSat)
        internal
        view
        returns (uint256)
    {
        return (uint256(optimisticMintingPendingTotal) + additionalPendingSat) *
            SATOSHI_MULTIPLIER +
            _capRelevantDebtTotal();
    }

    function _globalHeadroomRemaining(uint64 additionalPendingSat)
        internal
        view
        returns (uint64)
    {
        uint256 cap = uint256(optimisticMintingDebtCap) * SATOSHI_MULTIPLIER;
        uint256 exposure = _globalExposure(additionalPendingSat);
        return exposure >= cap
            ? 0
            : uint64((cap - exposure) / SATOSHI_MULTIPLIER);
    }

    function _markOptimisticMintingDebtExcludedFromCap(
        address depositor,
        uint256 amount
    ) internal {
        uint256 previous = optimisticMintingDebtCapExcluded[depositor];
        if (amount > previous) {
            optimisticMintingDebtCapExcludedTotal += amount - previous;
            optimisticMintingDebtCapExcluded[depositor] = amount;
        }
    }

    function _clearOptimisticMintingDebtCapExclusion(address depositor)
        internal
    {
        uint256 excluded = optimisticMintingDebtCapExcluded[depositor];
        if (excluded > 0) {
            optimisticMintingDebtCapExcludedTotal -= excluded;
            delete optimisticMintingDebtCapExcluded[depositor];
        }
    }

    function _emitOptimisticMintingAllowanceConsumed(
        address minter,
        uint64 amount,
        bool isExempt,
        uint64 minterValueRemaining,
        uint64 globalHeadroomRemaining
    ) internal {
        if (isExempt) {
            uint64 capPerMinter = optimisticMintingCapPerMinter;
            minterValueRemaining = capPerMinter != 0
                ? capPerMinter
                : type(uint64).max;
            globalHeadroomRemaining = optimisticMintingDebtCap != 0
                ? _globalHeadroomRemaining(0)
                : type(uint64).max;
        }

        emit OptimisticMintingAllowanceConsumed(
            minter,
            amount,
            minterValueRemaining,
            globalHeadroomRemaining
        );
    }

    function _refillBucket(
        uint256 remaining,
        uint64 refilledAt,
        uint256 limit
    ) private view returns (uint256 updatedRemaining, uint64 updatedRefilledAt) {
        if (limit == 0) {
            return (remaining, refilledAt);
        }

        // slither-disable-next-line incorrect-equality
        if (refilledAt == 0) {
            return (limit, uint64(block.timestamp));
        }

        /* solhint-disable-next-line not-rely-on-time */
        uint256 elapsed = block.timestamp - refilledAt;
        uint256 credit = (limit * elapsed) / 24 hours;
        if (credit == 0) {
            return (remaining, refilledAt);
        }

        uint256 updated = remaining + credit;
        if (updated >= limit) {
            return (limit, uint64(block.timestamp));
        }

        return (updated, refilledAt + _refillTimeForCredit(credit, limit));
    }

    /// @notice Computes the refilled state of a Minter's rate-limiting
    ///         buckets without modifying storage. Each dimension refills
    ///         continuously at a rate of the full cap per 24 hours, up to
    ///         the cap. A dimension that has never been tracked, or whose
    ///         limit was enabled after a period of being disabled, is
    ///         considered full.
    /// @param allowance The current state of the buckets.
    /// @param valueCap The value cap, in satoshi. Zero if disabled.
    /// @param requestLimit The request count limit. Zero if disabled.
    /// @return The refilled state of the buckets.
    function _refillAllowance(
        OptimisticMintingAllowance memory allowance,
        uint64 valueCap,
        uint32 requestLimit
    ) private view returns (OptimisticMintingAllowance memory) {
        // Each dimension is tracked independently and only while its limit
        // is enabled. A dimension that was disabled keeps its old timestamp,
        // so when governance re-enables the limit — which takes at least the
        // 24-hour governance delay — the accrued refill covers the full cap
        // and every Minter starts from a full bucket. For a partially filled
        // bucket, advance the timestamp only by the time represented by
        // credited whole tokens so uncredited elapsed time is preserved.
        // Once the bucket reaches its cap, reset the timestamp to the current
        // block because refill cannot accumulate above the cap.
        if (valueCap != 0) {
            (uint256 valueRemaining, uint64 valueRefilledAt) = _refillBucket(
                allowance.valueRemaining,
                allowance.valueRefilledAt,
                valueCap
            );
            allowance.valueRemaining = uint64(valueRemaining);
            allowance.valueRefilledAt = valueRefilledAt;
            if (allowance.valueRemaining > valueCap) {
                allowance.valueRemaining = valueCap;
            }
        }

        if (requestLimit != 0) {
            (uint256 requestsRemaining, uint64 requestsRefilledAt) =
                _refillBucket(
                    allowance.requestsRemaining,
                    allowance.requestsRefilledAt,
                    requestLimit
                );
            allowance.requestsRemaining = uint32(requestsRemaining);
            allowance.requestsRefilledAt = requestsRefilledAt;
            if (allowance.requestsRemaining > requestLimit) {
                allowance.requestsRemaining = requestLimit;
            }
        }

        return allowance;
    }

    /// @dev Returns the whole seconds represented by an integer refill credit.
    ///      Rounding up preserves every whole second of fractional accrual
    ///      without making the next token available early for limits that do
    ///      not divide 24 hours evenly.
    function _refillTimeForCredit(uint256 credit, uint256 limit)
        private
        pure
        returns (uint64)
    {
        return uint64((credit * 24 hours + limit - 1) / limit);
    }
}
