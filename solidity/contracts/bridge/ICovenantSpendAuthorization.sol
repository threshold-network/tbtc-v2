// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title Covenant spend authorization interface
/// @notice Read interface the Bridge uses to check whether a covenant active
///         UTXO spend was authorized through the account-control covenant proof
///         flow. Implemented by `CovenantSpendAuthorization`.
interface ICovenantSpendAuthorization {
    /// @notice Returns true when the given covenant active UTXO is authorized
    ///         to be spent by the given wallet for the given value into the
    ///         given set of transaction outputs.
    /// @param utxoKey UTXO key of the covenant active outpoint, computed as
    ///        `uint256(keccak256(abi.encodePacked(fundingTxHash, fundingOutputIndex)))`
    ///        with the funding transaction hash in Bitcoin internal
    ///        (little-endian) byte order — the same key the Bridge uses for
    ///        deposits and spent UTXOs.
    /// @param walletPubKeyHash 20-byte public key hash of the tBTC wallet the
    ///        covenant spend is authorized for.
    /// @param value Value in satoshi of the covenant active UTXO as validated
    ///        by the covenant proof flow.
    /// @param outputsHash BIP-143 `hashOutputs` of the covenant migration
    ///        transaction — the `hash256` of the serialized transaction
    ///        outputs. Binds the authorization to the exact migration
    ///        destination and anchor the covenant spend must fund.
    function isAuthorized(
        uint256 utxoKey,
        bytes20 walletPubKeyHash,
        uint64 value,
        bytes32 outputsHash
    ) external view returns (bool);
}
