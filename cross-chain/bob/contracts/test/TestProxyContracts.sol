// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.15;

// Import proxy contracts to ensure they're compiled
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

// Empty contract just to ensure imports are compiled
contract TestProxyContracts {
    // This contract exists solely to ensure ProxyAdmin and TransparentUpgradeableProxy
    // are compiled and available in the artifacts for testing
}
