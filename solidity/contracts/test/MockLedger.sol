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
