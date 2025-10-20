// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.17;

contract WalletRegistryMock {
    function wallets(bytes32) external pure returns (
        bytes32 mainUtxoHash,
        uint32 activeWalletPubKeyHash,
        uint64 pendingRedemptionsValue,
        uint64 createdAt,
        uint64 movingFundsRequestedAt,
        uint64 closingStartedAt,
        uint64 pendingMovedFundsSweepRequestsCount,
        uint32 state,
        bytes32 movingFundsTargetWalletsCommitmentHash
    ) {
        return (
            bytes32(0),
            0,
            0,
            0,
            0,
            0,
            0,
            1,  // Live state
            bytes32(0)
        );
    }
}