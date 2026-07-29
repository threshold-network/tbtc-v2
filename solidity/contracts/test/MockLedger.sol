// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../staking/api/IWalletExposureLedger.sol";

/// @dev Test helper implementing `IWalletExposureLedger` with directly
///      settable state. Used by the staking module unit tests.
contract MockLedger is IWalletExposureLedger {
    mapping(address => uint64) public override currentEpoch;
    mapping(address => uint32) public override liveWalletCount;
    mapping(address => mapping(uint64 => bool)) internal liveExposure;
    mapping(address => bool) public exposureForAllEpochs;

    uint256 public onWalletRegisteredCalls;
    uint256 public onWalletClosedCalls;

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
}
