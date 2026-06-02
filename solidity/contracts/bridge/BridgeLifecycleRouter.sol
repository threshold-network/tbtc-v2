// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./IBridgeLifecycleRouter.sol";

interface IBridgeFrostLifecycleContext {
    function frostLifecycleContext(bytes20 walletPubKeyHash)
        external
        view
        returns (address frostRegistry, bytes32 walletID);
}

interface IFrostWalletLifecycleRegistry {
    function closeWallet(bytes32 walletID) external;

    function seize(
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs
    ) external;

    function isWalletMember(
        bytes32 walletID,
        uint32[] calldata walletMembersIDs,
        address operator,
        uint256 walletMemberIndex
    ) external view returns (bool);

    function lifecycleOwner() external view returns (address);
}

/// @title BridgeLifecycleRouter
/// @notice Resolves Bridge FROST wallet aliases and forwards lifecycle calls
///         to the canonical FrostWalletRegistry.
contract BridgeLifecycleRouter is IBridgeLifecycleRouter {
    error BridgeAddressZero();
    error CallerIsNotBridge();
    error FrostWalletRegistryNotSet();
    error FrostWalletIdIsZero();
    error LifecycleOwnerMismatch();

    address public immutable bridge;

    constructor(address _bridge) {
        if (_bridge == address(0)) {
            revert BridgeAddressZero();
        }

        bridge = _bridge;
    }

    modifier onlyBridge() {
        if (msg.sender != bridge) {
            revert CallerIsNotBridge();
        }
        _;
    }

    function closeWallet(bytes20 walletPubKeyHash) external onlyBridge {
        (IFrostWalletLifecycleRegistry registry, bytes32 walletID) = context(
            walletPubKeyHash
        );

        registry.closeWallet(walletID);
    }

    function seize(
        bytes20 walletPubKeyHash,
        uint96 amount,
        uint32 rewardMultiplier,
        address notifier,
        uint32[] calldata walletMembersIDs
    ) external onlyBridge {
        (IFrostWalletLifecycleRegistry registry, bytes32 walletID) = context(
            walletPubKeyHash
        );

        registry.seize(
            amount,
            rewardMultiplier,
            notifier,
            walletID,
            walletMembersIDs
        );
    }

    function isWalletMember(
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs,
        address operator,
        uint256 walletMemberIndex
    ) external view returns (bool) {
        (IFrostWalletLifecycleRegistry registry, bytes32 walletID) = context(
            walletPubKeyHash
        );

        return
            registry.isWalletMember(
                walletID,
                walletMembersIDs,
                operator,
                walletMemberIndex
            );
    }

    function context(bytes20 walletPubKeyHash)
        internal
        view
        returns (IFrostWalletLifecycleRegistry registry, bytes32 walletID)
    {
        address frostRegistry;
        (frostRegistry, walletID) = IBridgeFrostLifecycleContext(bridge)
            .frostLifecycleContext(walletPubKeyHash);

        if (frostRegistry == address(0)) {
            revert FrostWalletRegistryNotSet();
        }
        if (walletID == bytes32(0)) {
            revert FrostWalletIdIsZero();
        }

        registry = IFrostWalletLifecycleRegistry(frostRegistry);
        if (registry.lifecycleOwner() != address(this)) {
            revert LifecycleOwnerMismatch();
        }
    }
}
