// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../staking/api/IWalletExposureLedger.sol";

/// @dev Test helper implementing `IWalletExposureLedger` with directly
///      settable state. Used by the staking module unit tests.
contract MockLedger is IWalletExposureLedger {
    address public override frostWalletRegistry;
    mapping(address => uint64) public override currentEpoch;
    mapping(address => uint32) public override liveWalletCount;
    mapping(address => mapping(uint64 => bool)) internal liveExposure;
    mapping(address => bool) public exposureForAllEpochs;

    uint256 public onWalletRegisteredCalls;
    uint256 public onWalletClosedCalls;

    function setFrostWalletRegistry(address registry) external {
        frostWalletRegistry = registry;
    }

    function setCurrentEpoch(address stakingProvider, uint64 epoch) external {
        currentEpoch[stakingProvider] = epoch;
    }

    function setLiveWalletCount(address stakingProvider, uint32 count)
        external
    {
        liveWalletCount[stakingProvider] = count;
    }

    function setExposureForAllEpochs(address stakingProvider, bool exposed)
        external
    {
        exposureForAllEpochs[stakingProvider] = exposed;
    }

    function onWalletRegistered(
        bytes32,
        address[] calldata,
        uint32[] calldata
    ) external override {
        onWalletRegisteredCalls += 1;
    }

    function onWalletClosed(bytes32) external override {
        onWalletClosedCalls += 1;
    }

    function hasLiveExposureAtOrBefore(address stakingProvider, uint64)
        external
        view
        override
        returns (bool)
    {
        return exposureForAllEpochs[stakingProvider];
    }

    function getWalletExposure(bytes32)
        external
        pure
        override
        returns (
            address[] memory,
            uint64[] memory,
            uint32[] memory,
            bool
        )
    {
        return (new address[](0), new uint64[](0), new uint32[](0), false);
    }

    function advanceOldestLiveEpoch(address)
        external
        pure
        override
        returns (uint64)
    {
        return 0;
    }
}

/// @dev Test-only forwarding ledger that can deterministically reject wallet
///      registration while leaving a real WalletExposureLedger implementation
///      and its state intact. This avoids mutating proxy bytecode through
///      Hardhat-specific RPC methods when exercising swallowed lifecycle hooks.
contract ControlledWalletExposureLedger is IWalletExposureLedger {
    address public immutable controller;
    address public immutable override frostWalletRegistry;

    IWalletExposureLedger public target;
    bool public revertOnWalletRegistered;

    error NotController();
    error NotWalletRegistry();
    error TargetAlreadySet();
    error InvalidTarget();

    constructor(address registry) {
        controller = msg.sender;
        frostWalletRegistry = registry;
    }

    modifier onlyController() {
        if (msg.sender != controller) {
            revert NotController();
        }
        _;
    }

    modifier onlyWalletRegistry() {
        if (msg.sender != frostWalletRegistry) {
            revert NotWalletRegistry();
        }
        _;
    }

    function setTarget(address newTarget) external onlyController {
        if (address(target) != address(0)) {
            revert TargetAlreadySet();
        }
        if (
            newTarget == address(0) ||
            newTarget.code.length == 0 ||
            IWalletExposureLedger(newTarget).frostWalletRegistry() !=
            address(this)
        ) {
            revert InvalidTarget();
        }
        target = IWalletExposureLedger(newTarget);
    }

    function setRevertOnWalletRegistered(bool shouldRevert)
        external
        onlyController
    {
        revertOnWalletRegistered = shouldRevert;
    }

    function onWalletRegistered(
        bytes32 walletID,
        address[] calldata stakingProviders,
        uint32[] calldata seatCounts
    ) external override onlyWalletRegistry {
        require(!revertOnWalletRegistered, "wallet registration reverted");
        target.onWalletRegistered(walletID, stakingProviders, seatCounts);
    }

    function onWalletClosed(bytes32 walletID)
        external
        override
        onlyWalletRegistry
    {
        target.onWalletClosed(walletID);
    }

    function currentEpoch(address stakingProvider)
        external
        view
        override
        returns (uint64)
    {
        return target.currentEpoch(stakingProvider);
    }

    function liveWalletCount(address stakingProvider)
        external
        view
        override
        returns (uint32)
    {
        return target.liveWalletCount(stakingProvider);
    }

    function hasLiveExposureAtOrBefore(address stakingProvider, uint64 epoch)
        external
        view
        override
        returns (bool)
    {
        return target.hasLiveExposureAtOrBefore(stakingProvider, epoch);
    }

    function getWalletExposure(bytes32 walletID)
        external
        view
        override
        returns (
            address[] memory stakingProviders,
            uint64[] memory epochs,
            uint32[] memory seatCounts,
            bool live
        )
    {
        return target.getWalletExposure(walletID);
    }

    function advanceOldestLiveEpoch(address stakingProvider)
        external
        override
        returns (uint64)
    {
        return target.advanceOldestLiveEpoch(stakingProvider);
    }
}

/// @dev Correctly-bound ledger whose registration hook deliberately consumes
///      all forwarded gas. Used to prove DKG approval cannot swallow a
///      gas-tuned out-of-gas registration and continue.
contract GasBurningWalletExposureLedger is IWalletExposureLedger {
    address public immutable override frostWalletRegistry;

    constructor(address registry) {
        frostWalletRegistry = registry;
    }

    function onWalletRegistered(
        bytes32,
        address[] calldata,
        uint32[] calldata
    ) external pure override {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            for {

            } 1 {

            } {

            }
        }
    }

    function onWalletClosed(bytes32) external pure override {}

    function currentEpoch(address) external pure override returns (uint64) {
        return 0;
    }

    function liveWalletCount(address) external pure override returns (uint32) {
        return 0;
    }

    function hasLiveExposureAtOrBefore(address, uint64)
        external
        pure
        override
        returns (bool)
    {
        return false;
    }

    function getWalletExposure(bytes32)
        external
        pure
        override
        returns (
            address[] memory,
            uint64[] memory,
            uint32[] memory,
            bool
        )
    {
        return (new address[](0), new uint64[](0), new uint32[](0), false);
    }

    function advanceOldestLiveEpoch(address)
        external
        pure
        override
        returns (uint64)
    {
        return 0;
    }
}
