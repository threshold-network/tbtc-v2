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

pragma solidity ^0.8.0;

/// @notice Namespace which groups all types relevant to the IBridge interface.
/// @dev This is a mirror of the real types used in the Bridge contract.
///      This way, the `integrator` subpackage does not need to import
///      anything from the `bridge` subpackage and explicitly depend on it.
///      This simplifies the dependency graph for integrators.
library IBridgeTypes {
    /// @dev See bridge/BitcoinTx.sol#Info
    struct BitcoinTxInfo {
        bytes4 version;
        bytes inputVector;
        bytes outputVector;
        bytes4 locktime;
    }

    /// @dev See bridge/Deposit.sol#DepositRevealInfo
    struct DepositRevealInfo {
        uint32 fundingOutputIndex;
        bytes8 blindingFactor;
        bytes20 walletPubKeyHash;
        bytes20 refundPubKeyHash;
        bytes4 refundLocktime;
        address vault;
    }

    /// @dev See bridge/Deposit.sol#DepositRequest
    struct DepositRequest {
        address depositor;
        uint64 amount;
        uint32 revealedAt;
        address vault;
        uint64 treasuryFee;
        uint32 sweptAt;
        bytes32 extraData;
    }
}

/// @notice Interface of the Bridge contract.
/// @dev See bridge/Bridge.sol
interface IBridge {
    /// @dev See {Bridge#revealDepositWithExtraData}
    function revealDepositWithExtraData(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external;

    /// @dev See {Bridge#deposits}
    function deposits(uint256 depositKey)
        external
        view
        returns (IBridgeTypes.DepositRequest memory);

    /// @dev See {Bridge#depositParameters}
    function depositParameters()
        external
        view
        returns (
            uint64 depositDustThreshold,
            uint64 depositTreasuryFeeDivisor,
            uint64 depositTxMaxFee,
            uint32 depositRevealAheadPeriod
        );
}
