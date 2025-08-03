// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.19;

import "../interfaces/IRouter.sol";

contract MockRouter is IRouter {
    mapping(uint64 => address) public onRamps;
    mapping(uint64 => mapping(address => bool)) public offRamps;

    function getOnRamp(
        uint64 chainSelector
    ) external view override returns (address) {
        return onRamps[chainSelector];
    }

    function isOffRamp(
        uint64 chainSelector,
        address offRamp
    ) external view override returns (bool) {
        return offRamps[chainSelector][offRamp];
    }

    function setOnRamp(uint64 chainSelector, address onRamp) external {
        onRamps[chainSelector] = onRamp;
    }

    function setOffRamp(uint64 chainSelector, address offRamp) external {
        offRamps[chainSelector][offRamp] = true;
    }
}
