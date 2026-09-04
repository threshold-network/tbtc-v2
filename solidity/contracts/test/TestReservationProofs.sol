// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/Reservation.sol";
import "../bridge/ReservationProofs.sol";
import "../bridge/Wallets.sol";
import "../bridge/Deposit.sol";
import "../bridge/BitcoinTx.sol";
import "../bank/Bank.sol";
import "../vault/IVault.sol";

/// @notice Mock reservation vault implementing IVault for testing Bank balance increase.
contract MockReservationVault is IVault {
    address public bank;
    uint256 public totalReceived;
    address[] public lastDepositors;
    uint256[] public lastAmounts;
    // In-kind miner fees financed by the re-anchor settlement path; the mock
    // records them so tests can assert the financing leg without token logic.
    uint256 public inKindFeesFinanced;

    function financeInKindFee(uint64 feeSat) external {
        inKindFeesFinanced += feeSat;
    }

    constructor(address _bank) {
        bank = _bank;
    }

    function receiveBalanceIncrease(
        address[] calldata depositors,
        uint256[] calldata depositedAmounts
    ) external override {
        require(msg.sender == bank, "Caller is not bank");
        for (uint256 i = 0; i < depositedAmounts.length; i++) {
            totalReceived += depositedAmounts[i];
        }
        lastDepositors = depositors;
        lastAmounts = depositedAmounts;
    }

    function receiveBalanceApproval(
        address,
        uint256,
        bytes calldata
    ) external override {}

    function getLastDepositors() external view returns (address[] memory) {
        return lastDepositors;
    }

    function getLastAmounts() external view returns (uint256[] memory) {
        return lastAmounts;
    }
}

/// @notice Test harness for ReservationProofs library.
contract TestReservationProofs {
    using BridgeState for BridgeState.Storage;
    using Reservation for BridgeState.Storage;

    BridgeState.Storage internal state;
    event ReservationAccepted(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        bytes32 anchorTxHash,
        uint64 anchorAmount,
        uint32 expiresAt
    );

    event ReservationActionSuperseded(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    event ReservationRetryCreditMinted(uint256 indexed reservationKey);

    event ReservationReanchored(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed newWalletPubKeyHash,
        bytes32 newAnchorTxHash,
        uint64 newAnchorAmount,
        uint64 minerFee
    );

    event ReservationLateSettled(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionType
    );

    event ReservationStranded(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        uint64 anchorAmount
    );

    constructor(address _bank) {
        state.bank = Bank(_bank);
    }

    function submitReservationProof(
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata utxo,
        uint256 reservationKey,
        uint64 requestNonce
    ) external {
        ReservationProofs.submitReservationProof(
            state,
            proofType,
            txInfo,
            proof,
            utxo,
            reservationKey,
            requestNonce
        );
    }

    function loadSettleableAction(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType expectedType
    )
        external
        view
        returns (Reservation.ReservationAction memory action, bool late)
    {
        (
            Reservation.ReservationAction storage actionStorage,
            bool isLate
        ) = ReservationProofs.loadSettleableAction(
                state,
                reservationKey,
                requestNonce,
                expectedType
            );
        return (actionStorage, isLate);
    }

    function consumeAcceptedDeposit(
        bytes memory inputVector,
        uint256 reservationKey
    ) external {
        ReservationProofs.consumeAcceptedDeposit(
            state,
            inputVector,
            reservationKey
        );
    }

    function parseSingleOutput(bytes memory outputVector)
        external
        pure
        returns (bytes memory output)
    {
        return ReservationProofs.parseSingleOutput(outputVector);
    }

    function validateAnchorOutput(
        bytes memory outputVector,
        uint256 reservationKey,
        uint64 requestNonce
    ) external view returns (uint64 anchorAmount) {
        Reservation.ReservationAction storage action = state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        return
            ReservationProofs.validateAnchorOutput(state, outputVector, action);
    }

    function settleAcceptance(
        uint256 reservationKey,
        uint64 requestNonce,
        bool late,
        bytes32 anchorTxHash,
        uint64 anchorAmount
    ) external {
        Reservation.ReservationAction storage action = state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        ReservationProofs.settleAcceptance(
            state,
            reservationKey,
            requestNonce,
            action,
            late,
            anchorTxHash,
            anchorAmount
        );
    }

    function unwindPendingAction(
        uint256 reservationKey,
        bool restoreRetryCredit
    ) external {
        ReservationProofs.unwindPendingAction(
            state,
            state.reservations[reservationKey],
            reservationKey,
            restoreRetryCredit
        );
    }

    function strandLateSettlementIfTargetWalletClosed(
        uint256 reservationKey,
        bool evidenceAlreadyEmitted
    ) external {
        ReservationProofs.strandLateSettlementIfTargetWalletClosed(
            state,
            state.reservations[reservationKey],
            reservationKey,
            evidenceAlreadyEmitted
        );
    }

    function strandReservation(uint256 reservationKey) external {
        Reservation.strandReservation(
            state,
            state.reservations[reservationKey],
            reservationKey
        );
    }

    /// @notice Drives the entire acceptance pipeline unit-style without SPV merkle check
    function executeAcceptancePipeline(
        bytes memory inputVector,
        bytes memory outputVector,
        uint256 reservationKey,
        uint64 requestNonce,
        bytes32 anchorTxHash
    ) external returns (uint64 anchorAmount) {
        (
            Reservation.ReservationAction storage action,
            bool late
        ) = ReservationProofs.loadSettleableAction(
                state,
                reservationKey,
                requestNonce,
                Reservation.ActionType.Acceptance
            );

        require(
            state.reservations[reservationKey].state ==
                Reservation.ReservationState.Unknown,
            "Reservation already exists"
        );
        require(
            state.pendingReservedDeposit[reservationKey].isReserved,
            "Deposit was not revealed as reserved"
        );

        ReservationProofs.consumeAcceptedDeposit(
            state,
            inputVector,
            reservationKey
        );

        anchorAmount = ReservationProofs.validateAnchorOutput(
            state,
            outputVector,
            action
        );

        ReservationProofs.settleAcceptance(
            state,
            reservationKey,
            requestNonce,
            action,
            late,
            anchorTxHash,
            anchorAmount
        );
    }

    // Storage Setters
    function setBank(address _bank) external {
        state.bank = Bank(_bank);
    }

    function setRelay(address _relay) external {
        state.relay = IRelay(_relay);
    }

    function setReservationVault(address vault) external {
        state.reservationVault = vault;
    }

    function setVaultTrusted(address vault, bool trusted) external {
        state.isVaultTrusted[vault] = trusted;
    }

    function setReservationParameters(
        uint32 reservationTermSeconds,
        uint32 reservationDissolutionDelay,
        uint64 reservationTxMaxFee
    ) external {
        state.reservationTermSeconds = reservationTermSeconds;
        state.reservationDissolutionDelay = reservationDissolutionDelay;
        state.reservationTxMaxFee = reservationTxMaxFee;
    }

    function setReservationAction(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ReservationAction memory action
    ) external {
        state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ] = action;
    }

    function setReservation(
        uint256 reservationKey,
        Reservation.ReservationRequest memory request
    ) external {
        state.reservations[reservationKey] = request;
    }

    function setPendingReservedDeposit(
        uint256 reservationKey,
        BridgeState.PendingReservedDeposit memory pending
    ) external {
        state.pendingReservedDeposit[reservationKey] = pending;
    }

    function setDeposit(
        uint256 reservationKey,
        Deposit.DepositRequest memory deposit
    ) external {
        state.deposits[reservationKey] = deposit;
    }

    function setWalletState(
        bytes20 walletPubKeyHash,
        Wallets.WalletState walletState
    ) external {
        state.registeredWallets[walletPubKeyHash].state = walletState;
    }

    function setActiveReservationsCount(uint32 count) external {
        state.activeReservationsCount = count;
    }

    function setReservationTotalAmount(uint64 amount) external {
        state.reservationTotalAmount = amount;
    }

    function setWalletReservationsCount(bytes20 walletPubKeyHash, uint32 count)
        external
    {
        state.walletReservationInfo[walletPubKeyHash].count = count;
    }

    function setWalletReservationsAmount(
        bytes20 walletPubKeyHash,
        uint64 amount
    ) external {
        state.walletReservationInfo[walletPubKeyHash].amount = amount;
    }

    function setPendingReservedDeposits(uint64 count) external {
        state.pendingReservedDeposits = count;
    }

    function setWalletPendingDissolution(
        bytes20 walletPubKeyHash,
        uint256 reservationKey
    ) external {
        state.walletPendingDissolution[walletPubKeyHash] = reservationKey;
    }

    function setReservationByAnchorUtxo(uint256 utxoKey, uint256 reservationKey)
        external
    {
        state.reservationsByAnchorUtxo[utxoKey] = reservationKey;
    }

    function addWalletReservationKey(
        bytes20 walletPubKeyHash,
        uint256 reservationKey
    ) external {
        Reservation.addWalletReservationKey(
            state,
            walletPubKeyHash,
            reservationKey
        );
    }

    function initializeProducerStub(
        uint256 reservationKey,
        bytes20 walletPubKeyHash,
        uint32 refundDeadline,
        address depositor,
        uint64 amount,
        address vault
    ) external {
        state.pendingReservedDeposit[reservationKey] = BridgeState
            .PendingReservedDeposit({
                isReserved: true,
                walletPubKeyHash: walletPubKeyHash,
                refundDeadline: refundDeadline,
                refundDeadlineValidated: true
            });
        /* solhint-disable-next-line not-rely-on-time */
        uint32 revealedAt = uint32(block.timestamp);
        state.deposits[reservationKey] = Deposit.DepositRequest({
            depositor: depositor,
            amount: amount,
            revealedAt: revealedAt,
            vault: vault,
            treasuryFee: 0,
            sweptAt: 0,
            extraData: bytes32(0)
        });
        state.pendingReservedDeposits += 1;
    }

    // Storage Getters
    function getReservation(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationRequest memory)
    {
        return state.reservations[reservationKey];
    }

    function getReservationAction(uint256 reservationKey, uint64 requestNonce)
        external
        view
        returns (Reservation.ReservationAction memory)
    {
        return
            state.reservationActions[
                Reservation.actionKey(reservationKey, requestNonce)
            ];
    }

    function getPendingReservedDeposit(uint256 reservationKey)
        external
        view
        returns (BridgeState.PendingReservedDeposit memory)
    {
        return state.pendingReservedDeposit[reservationKey];
    }

    function getDeposit(uint256 reservationKey)
        external
        view
        returns (Deposit.DepositRequest memory)
    {
        return state.deposits[reservationKey];
    }

    function getReservationByAnchorUtxo(uint256 utxoKey)
        external
        view
        returns (uint256)
    {
        return state.reservationsByAnchorUtxo[utxoKey];
    }

    function getWalletReservationKeys(bytes20 walletPubKeyHash)
        external
        view
        returns (uint256[] memory)
    {
        return state.walletReservationKeys[walletPubKeyHash];
    }

    function getWalletReservationKeyIndex(uint256 reservationKey)
        external
        view
        returns (uint256)
    {
        return state.walletReservationKeyIndex[reservationKey];
    }

    function getActiveReservationsCount() external view returns (uint32) {
        return state.activeReservationsCount;
    }

    function getReservationTotalAmount() external view returns (uint64) {
        return state.reservationTotalAmount;
    }

    function getWalletReservationsCount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint32)
    {
        return state.walletReservationInfo[walletPubKeyHash].count;
    }

    function getWalletReservationsAmount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint64)
    {
        return state.walletReservationInfo[walletPubKeyHash].amount;
    }

    function getPendingReservedDeposits() external view returns (uint64) {
        return state.pendingReservedDeposits;
    }

    function getWalletState(bytes20 walletPubKeyHash)
        external
        view
        returns (Wallets.WalletState)
    {
        return state.registeredWallets[walletPubKeyHash].state;
    }

    function getWalletPendingDissolution(bytes20 walletPubKeyHash)
        external
        view
        returns (uint256)
    {
        return state.walletPendingDissolution[walletPubKeyHash];
    }
}
