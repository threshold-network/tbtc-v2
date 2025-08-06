// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IRouter {
  error OnlyOffRamp();

  /// @notice Returns the configured onramp for a specific destination chain.
  /// @param destChainSelector The destination chain Id to get the onRamp for.
  /// @return onRampAddress The address of the onRamp.
  function getOnRamp(
    uint64 destChainSelector
  ) external view returns (address onRampAddress);

  /// @notice Return true if the given offRamp is a configured offRamp for the given source chain.
  /// @param sourceChainSelector The source chain selector to check.
  /// @param offRamp The address of the offRamp to check.
  function isOffRamp(uint64 sourceChainSelector, address offRamp) external view returns (bool isOffRamp);
}
