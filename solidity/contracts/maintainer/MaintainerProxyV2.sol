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

import "../bridge/IReservationBridge.sol";
import "./MaintainerProxy.sol";

/// @title Maintainer Proxy V2
/// @notice Reservation-proof successor of `MaintainerProxy` adding the routed
///         UTXO-reservation SPV proof endpoint. A separate contract is used
///         because the production `MaintainerProxy` is not upgradeable; that
///         proxy can remain active for legacy and wallet-maintainer calls.
contract MaintainerProxyV2 is MaintainerProxy {
    /// @notice Gas that is meant to balance the submission of a reservation
    ///         proof overall cost. Can be updated by governance based on the
    ///         current market conditions.
    uint256 public submitReservationProofGasOffset;

    event ReservationProofGasOffsetUpdated(
        uint256 submitReservationProofGasOffset
    );

    constructor(Bridge _bridge, ReimbursementPool _reimbursementPool)
        MaintainerProxy(_bridge, _reimbursementPool)
    {
        submitReservationProofGasOffset = 30000;
    }

    /// @notice Wraps `ReservationRouter.submitReservationProof`, called at the
    ///         Bridge address, and reimburses the caller's transaction cost.
    /// @dev See `ReservationRouter.submitReservationProof` documentation.
    function submitReservationProof(
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata mainUtxo,
        uint256 reservationKey,
        uint64 requestNonce
    ) external onlySpvMaintainer {
        uint256 gasStart = gasleft();

        IReservationBridge(address(bridge)).submitReservationProof(
            proofType,
            txInfo,
            proof,
            mainUtxo,
            reservationKey,
            requestNonce
        );

        reimbursementPool.refund(
            (gasStart - gasleft()) + submitReservationProofGasOffset,
            msg.sender
        );
    }

    /// @notice Updates the gas offset used for reservation proof refunds.
    /// @dev Can be called only by the contract owner. The caller is responsible
    ///      for validating the parameter.
    /// @param newSubmitReservationProofGasOffset New reservation proof gas
    ///        offset.
    function updateReservationProofGasOffset(
        uint256 newSubmitReservationProofGasOffset
    ) external onlyOwner {
        submitReservationProofGasOffset = newSubmitReservationProofGasOffset;

        emit ReservationProofGasOffsetUpdated(
            newSubmitReservationProofGasOffset
        );
    }
}
