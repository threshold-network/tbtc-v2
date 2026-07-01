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
import "../bridge/MigrationExtraData.sol";
import "../GovernanceUtils.sol";
import "./ITBTCVaultMigrationDebt.sol";
import "./TBTCMigrationDebtOperations.sol";
import "./ITBTCVaultMigrationSweepNotifier.sol";

/// @title TBTC Optimistic Minting
/// @notice The Optimistic Minting mechanism allows to mint TBTC before
///         `TBTCVault` receives the Bank balance. There are two permissioned
///         sets in the system: Minters and Guardians, both set up in 1-of-n
///         mode. Minters observe the revealed deposits and request minting TBTC.
///         Any single Minter can perform this action. There is an
///         `optimisticMintingDelay` between the time of the request from
///         a Minter to the time TBTC is minted. During the time of the delay,
///         any Guardian can cancel the minting.
/// @dev This functionality is a part of `TBTCVault`. It is implemented in
///      a separate abstract contract to achieve better separation of concerns
///      and easier-to-follow code.
abstract contract TBTCOptimisticMinting is Ownable, ITBTCVaultMigrationDebt {
    uint256 public constant MAX_MIGRATION_SWEEP_BATCH_SIZE = 100;

    // Represents optimistic minting request for the given deposit revealed
    // to the Bridge.
    struct OptimisticMintingRequest {
        // UNIX timestamp at which the optimistic minting was requested.
        uint64 requestedAt;
        // UNIX timestamp at which the optimistic minting was finalized.
        // 0 if not yet finalized.
        uint64 finalizedAt;
    }

    /// @notice The time delay that needs to pass between initializing and
    ///         finalizing the upgrade of governable parameters.
    uint256 public constant GOVERNANCE_DELAY = 24 hours;

    /// @notice Multiplier to convert satoshi to TBTC token units.
    uint256 public constant SATOSHI_MULTIPLIER = 10**10;

    /// @notice The minimum allowed value for a non-zero optimistic minting fee
    ///         divisor. A divisor of 0 is a valid out-of-band sentinel meaning
    ///         "no fee" — handled by the `divisor > 0 ? ... : 0` branch in the
    ///         fee formula. Any non-zero divisor must be at or above this
    ///         minimum to prevent excessively high fee rates; divisors in the
    ///         range [1, 9] are blocked because they correspond to fee rates of
    ///         11%-100%. A divisor of 10 caps the fee rate at 10%.
    uint32 public constant MIN_OPTIMISTIC_MINTING_FEE_DIVISOR = 10;

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

    /// @notice Migration debt value per migration revealer address.
    /// @dev This storage is append-only to preserve upgrade safety.
    mapping(address => uint256) public override migrationDebt;

    /// @notice Indicates whether the address is allowed to reveal migration
    ///         deposits.
    /// @dev This storage is append-only to preserve upgrade safety.
    mapping(address => bool) public override isMigrationRevealer;

    /// @notice Address notified when a migration sweep finishes repaying the
    ///         migration debt for a revealer.
    /// @dev This storage is append-only to preserve upgrade safety.
    address public migrationSweepNotifier;

    /// @notice Reserve routed to the migration sweep notifier for the given
    ///         revealer once its migration debt reaches zero.
    /// @dev This storage is append-only to preserve upgrade safety.
    mapping(address => address) public migrationSweepReserve;

    /// @notice Indicates a revealer whose migration debt reached zero and is
    ///         awaiting a sweep-derived completion callback.
    /// @dev This storage is append-only to preserve upgrade safety.
    mapping(address => bool) private pendingMigrationSweepCompletion;

    /// @notice Tracks the number of revealers with nonzero outstanding
    ///         migration debt. Incremented on registerMigrationDebt,
    ///         decremented when a revealer's debt reaches zero via repayment
    ///         or owner-authorized residual debt clear-out.
    /// @dev This storage is append-only to preserve upgrade safety.
    ///
    ///      MIGRATION SAFETY: TBTCVault is deployed as a direct
    ///      (non-proxy) contract, so replacing the vault requires
    ///      deploying a new TBTCVault instance. A freshly-deployed
    ///      TBTCVault starts with this counter at zero, which means
    ///      `hasOutstandingMigrationDebt()` returns false on the new
    ///      contract even when the prior contract still had in-flight
    ///      revealer debt. Rotating TBTCVault MUST NOT occur while any
    ///      revealer has nonzero `migrationDebt` on the current
    ///      deployment; migration runbooks must snapshot outstanding
    ///      debt on the current vault and replay it on the successor
    ///      before the Bridge is repointed.
    uint256 private _outstandingMigrationDebtCount;

    /// @notice Tracks the number of depositors with nonzero outstanding
    ///         optimistic minting debt. Incremented in
    ///         `finalizeOptimisticMint` when a depositor's debt transitions
    ///         from zero to nonzero, decremented in
    ///         `repayOptimisticMintingDebt` when a depositor's debt
    ///         transitions back to zero. Enables an O(1)
    ///         `hasOutstandingOptimisticMintingDebt()` query without
    ///         enumerating depositors.
    /// @dev This storage is append-only to preserve upgrade safety.
    ///
    ///      MIGRATION SAFETY: like `_outstandingMigrationDebtCount`, this
    ///      counter is local to the current TBTCVault deployment. Because
    ///      TBTCVault is a direct (non-proxy) contract, a freshly-deployed
    ///      vault starts this counter at zero even if the prior deployment
    ///      still held in-flight optimistic minting debt. Governance levers
    ///      that change sweep routing for in-flight deposits (untrust,
    ///      canonical rotation, vault upgrade) rely on this counter to block
    ///      the operation while optimistic debt is outstanding; those
    ///      operations MUST be performed on the vault that actually holds the
    ///      debt.
    ///
    ///      Visibility is `internal` (rather than `private` like
    ///      `_outstandingMigrationDebtCount`) so a test harness that seeds
    ///      `optimisticMintingDebt` directly can keep this aggregate
    ///      consistent with the per-depositor mapping; production debt
    ///      creation and repayment maintain it through
    ///      `finalizeOptimisticMint` and `repayOptimisticMintingDebt`.
    uint256 internal _outstandingOptimisticMintingDebtCount;

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
    event MigrationSweepNotifierUpdated(
        address indexed previousNotifier,
        address indexed newNotifier
    );
    event MigrationSweepReserveUpdated(
        address indexed revealer,
        address indexed reserve
    );
    event MigrationSweepNotified(
        address indexed revealer,
        address indexed reserve,
        bytes32 indexed sweepTxHash
    );
    event MigrationSweepCompletionPendingCleared(address indexed revealer);

    modifier onlyMinter() {
        require(isMinter[msg.sender], "Caller is not a minter");
        _;
    }

    modifier onlyGuardian() {
        require(isGuardian[msg.sender], "Caller is not a guardian");
        _;
    }

    modifier onlyOwnerOrBridge() {
        require(
            owner() == msg.sender || address(bridge) == msg.sender,
            "Caller is not the owner or Bridge"
        );
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
        require(
            !MigrationExtraData.isMigrationReveal(deposit.extraData),
            "Migration deposits can not use optimistic minting"
        );

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
        require(
            !MigrationExtraData.isMigrationReveal(deposit.extraData),
            "Migration deposits can not use optimistic minting"
        );

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

        // Both the optimistic minting fee and the share that goes to the
        // depositor are optimistically minted. All TBTC that is optimistically
        // minted should be added to the optimistic minting debt. When the
        // deposit is swept, it is paying off both the depositor's share and the
        // treasury's share (optimistic minting fee).
        uint256 oldDebt = optimisticMintingDebt[deposit.depositor];
        uint256 newDebt = oldDebt + amountToMint;
        optimisticMintingDebt[deposit.depositor] = newDebt;

        // Track the aggregate count of depositors with nonzero optimistic
        // debt. Only count the zero-to-nonzero transition so the counter
        // equals the number of distinct depositors currently in debt, not the
        // number of optimistic mints.
        if (oldDebt == 0 && newDebt > 0) {
            _outstandingOptimisticMintingDebtCount++;
        }

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

        // Delete it. It allows to request optimistic minting for the given
        // deposit again. Useful in case of an errant Guardian.
        delete optimisticMintingRequests[depositKey];

        emit OptimisticMintingCancelled(msg.sender, depositKey);
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
    /// @dev The divisor is validated at both begin and finalize time. The
    ///      begin-time check provides early feedback so governance does not
    ///      wait the full delay only to have finalization revert. The
    ///      finalize-time check is retained as defense-in-depth.
    function beginOptimisticMintingFeeUpdate(
        uint32 _newOptimisticMintingFeeDivisor
    ) external onlyOwner {
        require(
            _newOptimisticMintingFeeDivisor == 0 ||
                _newOptimisticMintingFeeDivisor >=
                MIN_OPTIMISTIC_MINTING_FEE_DIVISOR,
            "New fee divisor must be 0 or >= minimum"
        );
        /* solhint-disable-next-line not-rely-on-time */
        optimisticMintingFeeUpdateInitiatedTimestamp = block.timestamp;
        newOptimisticMintingFeeDivisor = _newOptimisticMintingFeeDivisor;
        emit OptimisticMintingFeeUpdateStarted(_newOptimisticMintingFeeDivisor);
    }

    /// @notice Finalizes the update process of the optimistic minting fee.
    ///         The new fee divisor must be either 0 (disables the fee) or at
    ///         or above `MIN_OPTIMISTIC_MINTING_FEE_DIVISOR` to prevent
    ///         excessively high fee rates.
    /// @dev Defense-in-depth: validated at both begin and finalize time.
    function finalizeOptimisticMintingFeeUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(optimisticMintingFeeUpdateInitiatedTimestamp)
    {
        require(
            newOptimisticMintingFeeDivisor == 0 ||
                newOptimisticMintingFeeDivisor >=
                MIN_OPTIMISTIC_MINTING_FEE_DIVISOR,
            "New fee divisor must be 0 or >= minimum"
        );

        optimisticMintingFeeDivisor = newOptimisticMintingFeeDivisor;
        emit OptimisticMintingFeeUpdated(newOptimisticMintingFeeDivisor);

        newOptimisticMintingFeeDivisor = 0;
        optimisticMintingFeeUpdateInitiatedTimestamp = 0;
    }

    /// @notice Begins the process of updating optimistic minting delay.
    /// @dev The delay is validated at both begin and finalize time. The
    ///      begin-time check provides early feedback so governance does not
    ///      wait the full delay only to have finalization revert. The
    ///      finalize-time check is retained as defense-in-depth.
    function beginOptimisticMintingDelayUpdate(
        uint32 _newOptimisticMintingDelay
    ) external onlyOwner {
        require(
            _newOptimisticMintingDelay > 0,
            "Optimistic minting delay must be > 0"
        );
        /* solhint-disable-next-line not-rely-on-time */
        optimisticMintingDelayUpdateInitiatedTimestamp = block.timestamp;
        newOptimisticMintingDelay = _newOptimisticMintingDelay;
        emit OptimisticMintingDelayUpdateStarted(_newOptimisticMintingDelay);
    }

    /// @notice Finalizes the update process of the optimistic minting delay.
    ///         The new delay must be greater than zero to preserve the
    ///         guardian review window for optimistic minting requests.
    /// @dev Defense-in-depth: validated at both begin and finalize time.
    function finalizeOptimisticMintingDelayUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(optimisticMintingDelayUpdateInitiatedTimestamp)
    {
        require(
            newOptimisticMintingDelay > 0,
            "Optimistic minting delay must be > 0"
        );

        optimisticMintingDelay = newOptimisticMintingDelay;
        emit OptimisticMintingDelayUpdated(newOptimisticMintingDelay);

        newOptimisticMintingDelay = 0;
        optimisticMintingDelayUpdateInitiatedTimestamp = 0;
    }

    /// @inheritdoc ITBTCVaultMigrationDebt
    /// @dev Only callable by the contract owner. Verifies this vault is
    ///      the Bridge's canonical migration debt vault via
    ///      `requireCanonicalMigrationDebtVault()`.
    ///
    ///      Over-registration scenario: when `amount` exceeds the actual
    ///      post-fee sweep proceeds for this revealer, a residual positive
    ///      debt remains after all migration deposits are swept. The vault
    ///      still holds positive `migrationDebt[revealer]` and
    ///      `canRevealMigration()` continues to return true (since
    ///      `migrationDebt > 0`), but no further deposits should be
    ///      revealed. The reserve transitions to MIGRATED state through
    ///      an owner-initiated `notifyMigrationSweep` call on the
    ///      strategy contract, which does not require zero vault debt.
    ///      The owner can later call `clearMigrationDebt` to close out the
    ///      residual debt once migration completion is confirmed.
    ///
    ///      Under-registration scenario: when `amount` is less than the
    ///      actual post-fee sweep proceeds, the excess
    ///      (`proceeds - debt`) is minted as tBTC. This results in more
    ///      tBTC in circulation than intended for the migration.
    ///
    ///      Pending-completion guard: re-registration is blocked while
    ///      `pendingMigrationSweepCompletion[revealer]` is true. After a
    ///      revealer's debt reaches zero through repayment the flag stays
    ///      true until either the migration sweep notifier callback
    ///      consumes it (`notifyPendingMigrationSweep*`) or the reserve
    ///      mapping is explicitly cleared
    ///      (`setMigrationSweepReserve(revealer, address(0))`). Allowing
    ///      registration before the flag is consumed would let a stale
    ///      callback pull and clear the reserve associated with the new
    ///      registration, breaking the per-revealer completion lifecycle.
    function registerMigrationDebt(address revealer, uint256 amount)
        external
        override
        onlyOwner
    {
        requireCanonicalMigrationDebtVault();
        // Reject re-registration until any pending sweep completion from
        // the previous registration has been consumed by the notifier
        // path or explicitly cleared by zeroing the reserve. See the
        // pending-completion guard note in the function NatSpec.
        require(
            !pendingMigrationSweepCompletion[revealer],
            "Pending migration sweep completion must be consumed first"
        );
        // Guard the counter invariant locally: the counter assumes each
        // successful registration adds exactly one new revealer. This
        // duplicates the check in TBTCMigrationDebtOperations.registerDebt
        // as defense-in-depth against future library refactoring. The
        // error string is intentionally distinct from the library guard's
        // string so post-incident triage can identify which layer fired.
        require(
            migrationDebt[revealer] == 0,
            "Migration debt already registered (counter invariant)"
        );
        // reason: registerDebt returns the registered amount, which equals the `amount` argument already in scope; the return value is redundant for the caller
        // slither-disable-next-line unused-return
        TBTCMigrationDebtOperations.registerDebt(
            migrationDebt,
            revealer,
            amount
        );
        _outstandingMigrationDebtCount++;
        emit MigrationDebtRegistered(revealer, amount);
    }

    /// @inheritdoc ITBTCVaultMigrationDebt
    function clearMigrationDebt(address revealer) external override onlyOwner {
        uint256 debt = migrationDebt[revealer];
        require(debt > 0, "Migration debt not registered");

        migrationDebt[revealer] = 0;
        _outstandingMigrationDebtCount--;

        if (pendingMigrationSweepCompletion[revealer]) {
            pendingMigrationSweepCompletion[revealer] = false;
            emit MigrationSweepCompletionPendingCleared(revealer);
        }

        if (isMigrationRevealer[revealer]) {
            isMigrationRevealer[revealer] = false;
            emit MigrationRevealerSet(revealer, false);
        }

        emit MigrationDebtCleared(revealer, debt);
    }

    /// @inheritdoc ITBTCVaultMigrationDebt
    function setMigrationRevealer(address revealer, bool allowed)
        external
        override
        onlyOwner
    {
        if (allowed) {
            requireCanonicalMigrationDebtVault();
        } else {
            // Prevent de-registering a revealer while they still hold
            // outstanding migration debt. Doing so would silently block
            // migration sweep completion for that revealer.
            require(
                migrationDebt[revealer] == 0,
                "Revealer has outstanding migration debt"
            );
        }
        TBTCMigrationDebtOperations.setRevealer(
            isMigrationRevealer,
            revealer,
            allowed
        );

        emit MigrationRevealerSet(revealer, allowed);
    }

    /// @notice Updates the migration sweep notifier to the supplied address.
    /// @param notifier Address of the contract implementing
    ///        `ITBTCVaultMigrationSweepNotifier`, or `address(0)` to disable
    ///        downstream notifications.
    /// @dev Reverts if `notifier` is a non-zero address with no deployed
    ///      bytecode at the time of this call. The check rejects EOAs and
    ///      future-but-undeployed addresses at set-time so misconfiguration
    ///      surfaces here instead of at sweep-callback time, where vault
    ///      reverts are swallowed by the Bridge low-level call. The
    ///      `address(0)` value remains a valid disable state because the
    ///      callback path checks for nonzero before invoking the notifier
    ///      interface.
    ///
    ///      Note: this guard does not protect against subsequent
    ///      self-destruct of the notifier contract; the callback retry
    ///      path remains the recovery mechanism for that case.
    function setMigrationSweepNotifier(address notifier) external onlyOwner {
        require(
            notifier == address(0) || notifier.code.length > 0,
            "Notifier must be contract or zero address"
        );

        address previousNotifier = migrationSweepNotifier;
        migrationSweepNotifier = notifier;

        emit MigrationSweepNotifierUpdated(previousNotifier, notifier);
    }

    /// @notice Sets or clears the migration sweep reserve associated with a
    ///         revealer. The reserve is the address routed to the migration
    ///         sweep notifier when the revealer's debt completes.
    /// @param revealer Address whose reserve mapping is being updated. Must
    ///        not be the zero address.
    /// @param reserve Address that should receive the migration sweep
    ///        completion callback for `revealer`. Pass `address(0)` to clear
    ///        the mapping.
    /// @dev Passing `reserve == address(0)` while the revealer has a
    ///      pending migration sweep completion (debt previously reached
    ///      zero but the downstream notifier callback has not yet
    ///      consumed it) clears `pendingMigrationSweepCompletion[revealer]`
    ///      and emits `MigrationSweepCompletionPendingCleared(revealer)`.
    ///      This intentionally drops the queued completion so that
    ///      restoring the reserve to a non-zero address afterwards does
    ///      not replay an already-acknowledged sweep. Callers that wish to
    ///      preserve the pending callback must update the reserve directly
    ///      to the new non-zero address rather than zero-then-set.
    ///
    ///      In all cases this emits `MigrationSweepReserveUpdated(revealer,
    ///      reserve)` reflecting the post-update mapping value.
    function setMigrationSweepReserve(address revealer, address reserve)
        external
        onlyOwner
    {
        if (
            TBTCMigrationDebtOperations.setSweepReserve(
                migrationSweepReserve,
                pendingMigrationSweepCompletion,
                revealer,
                reserve
            )
        ) {
            emit MigrationSweepCompletionPendingCleared(revealer);
        }

        emit MigrationSweepReserveUpdated(revealer, reserve);
    }

    function notifyPendingMigrationSweep(
        bytes32 sweepTxHash,
        address[] calldata revealers
    ) external onlyOwnerOrBridge {
        require(sweepTxHash != bytes32(0), "Sweep tx hash must not be zero");
        require(
            revealers.length <= MAX_MIGRATION_SWEEP_BATCH_SIZE,
            "Too many revealers in batch"
        );

        address notifier = migrationSweepNotifier;
        if (notifier == address(0)) {
            return;
        }

        for (uint256 i = 0; i < revealers.length; i++) {
            _notifyPendingMigrationSweep(notifier, sweepTxHash, revealers[i]);
        }
    }

    function notifyPendingMigrationSweepForRevealer(
        bytes32 sweepTxHash,
        address revealer
    ) external onlyOwnerOrBridge {
        require(sweepTxHash != bytes32(0), "Sweep tx hash must not be zero");

        address notifier = migrationSweepNotifier;
        if (notifier == address(0)) {
            return;
        }

        _notifyPendingMigrationSweep(notifier, sweepTxHash, revealer);
    }

    /// @inheritdoc ITBTCVaultMigrationDebt
    function canRevealMigration(address revealer)
        external
        view
        override
        returns (bool)
    {
        return isMigrationRevealer[revealer] && migrationDebt[revealer] > 0;
    }

    /// @inheritdoc ITBTCVaultMigrationDebt
    /// @dev Called by Bridge.sol via staticcall during vault rotation and
    ///      untrust operations, and by `TBTCVault.finalizeUpgrade` to block
    ///      the upgrade while migration state is in flight. Visibility is
    ///      `public` so subclasses can read it without paying for an
    ///      external self-call.
    function hasOutstandingMigrationDebt() public view override returns (bool) {
        return _outstandingMigrationDebtCount > 0;
    }

    /// @inheritdoc ITBTCVaultMigrationDebt
    /// @dev Read by `TBTCVault.finalizeUpgrade` to block finalizing a vault
    ///      upgrade while optimistic minting debt is in flight, and by
    ///      Bridge.sol via a fail-open staticcall during vault untrust and
    ///      canonical rotation. Visibility is `public` so subclasses can read
    ///      it without paying for an external self-call.
    function hasOutstandingOptimisticMintingDebt()
        public
        view
        override
        returns (bool)
    {
        return _outstandingOptimisticMintingDebtCount > 0;
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
            // Debt transitioned from nonzero to zero: decrement the aggregate
            // count of depositors with outstanding optimistic debt.
            // The single SSTORE is required per fully-repaid depositor and this
            // function is invoked once per depositor by the caller's sweep loop.
            // slither-disable-next-line costly-loop
            _outstandingOptimisticMintingDebtCount--;
            emit OptimisticMintingDebtRepaid(depositor, 0);
            return amount - debt;
        } else {
            uint256 remainingDebt = debt - amount;
            optimisticMintingDebt[depositor] = remainingDebt;
            // Decrement the aggregate count only when the debt is fully
            // repaid (amount == debt). A partial repayment leaves the
            // depositor in debt and must not touch the counter.
            if (remainingDebt == 0) {
                // slither-disable-next-line costly-loop
                _outstandingOptimisticMintingDebtCount--;
            }
            emit OptimisticMintingDebtRepaid(depositor, remainingDebt);
            return 0;
        }
    }

    /// @notice Used by `TBTCVault.receiveBalanceIncrease` to repay migration
    ///         debt before TBTC is minted.
    /// @dev The `amount` has already been reduced by Bridge fee deductions
    ///      (per-deposit treasury fee and Bitcoin miner fee share) before
    ///      reaching this function through the `receiveBalanceIncrease`
    ///      callback. See `DepositSweep.submitDepositSweepProof` for the
    ///      fee deduction logic. Emits
    ///      `MigrationDebtRepaid(revealer, remainingDebt)`.
    /// @param revealer Address used to reveal migration deposit.
    /// @param amount The balance increase amount for the revealer,
    ///        post-fee in 1e18 precision.
    /// @return The TBTC amount that should be minted after paying off the
    ///         migration debt.
    function repayMigrationDebt(address revealer, uint256 amount)
        internal
        returns (uint256)
    {
        bool hadDebt = migrationDebt[revealer] > 0;

        (
            uint256 mintableAmount,
            uint256 remainingDebt
        ) = TBTCMigrationDebtOperations.repayDebt(
                migrationDebt,
                pendingMigrationSweepCompletion,
                revealer,
                amount
            );

        // Decrement the outstanding counter when debt transitions to zero.
        if (hadDebt && remainingDebt == 0) {
            // reason: per-revealer counter decrement; reached from the per-depositor receiveBalanceIncrease loop at TBTCVault.sol:130 via repayMigrationDebt. Depositors originate from Bitcoin sweep tx outputs validated by Bridge.submitDepositSweepProof; counter atomicity is a contract invariant.
            // slither-disable-next-line costly-loop
            _outstandingMigrationDebtCount--;
        }

        emit MigrationDebtRepaid(revealer, remainingDebt);
        return mintableAmount;
    }

    function _notifyPendingMigrationSweep(
        address notifier,
        bytes32 sweepTxHash,
        address revealer
    ) internal {
        address reserve = TBTCMigrationDebtOperations.pullPendingSweepReserve(
            migrationSweepReserve,
            pendingMigrationSweepCompletion,
            revealer
        );
        if (reserve == address(0)) {
            return;
        }

        // reason: single typed external call to the governance-set migrationSweepNotifier address; calls-loop is flagged because notifyPendingMigrationSweep at :826 dispatches per-revealer in a for loop at :842. The notifier is a trusted governance-controlled contract; failures revert this hook and are surfaced via the outer Bridge fail-open wrapper at DepositSweep.notifyMigrationSweepCallback.
        // slither-disable-next-line calls-loop
        ITBTCVaultMigrationSweepNotifier(notifier).notifyMigrationSweep(
            reserve,
            sweepTxHash
        );

        // reason: event emitted after a typed external notifier call that reverts on failure; if execution reaches this emit, the notifier succeeded. The reentrancy-events detector flags this because the external call precedes the emit; the call target is the trusted governance-set notifier.
        // slither-disable-next-line reentrancy-events
        emit MigrationSweepNotified(revealer, reserve, sweepTxHash);
    }

    function requireCanonicalMigrationDebtVault() internal view {
        require(
            bridge.migrationDebtVault() == address(this),
            "Bridge migration debt vault mismatch"
        );
    }
}
