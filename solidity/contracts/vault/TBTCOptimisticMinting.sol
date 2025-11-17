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
///         any Guardian can cancel the minting.
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

        // Both the optimistic minting fee and the share that goes to the
        // depositor are optimistically minted. All TBTC that is optimistically
        // minted should be added to the optimistic minting debt. When the
        // deposit is swept, it is paying off both the depositor's share and the
        // treasury's share (optimistic minting fee).
        uint256 newDebt = optimisticMintingDebt[deposit.depositor] +
            amountToMint;
        optimisticMintingDebt[deposit.depositor] = newDebt;

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
            emit OptimisticMintingDebtRepaid(depositor, 0);
            return amount - debt;
        } else {
            optimisticMintingDebt[depositor] = debt - amount;
            emit OptimisticMintingDebtRepaid(depositor, debt - amount);
            return 0;
        }
    }
}
