"use strict"
/**
 * Patched copy of @keep-network/ecdsa/export/deploy/13_authorize_in_random_beacon.js
 *
 * RandomBeacon.setRequesterAuthorization is onlyGovernance: msg.sender must equal RandomBeacon.governance().
 * RandomBeaconGovernance calls through to RandomBeacon, so msg.sender on RandomBeacon is the RBG contract
 * address. That must match the governance address stored on RandomBeacon.
 *
 * keep-core Phase D already set RandomBeacon.governance to the Phase D RandomBeaconGovernance. Phase H may
 * deploy a *new* RandomBeaconGovernance JSON; calling setRequesterAuthorization through the new contract
 * fails with "Caller is not the governance". Skip when the active on-chain governance is not this deploy.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()
  const { execute, read, log } = deployments

  const WalletRegistry = await deployments.get("WalletRegistry")
  const RandomBeaconGovernance = await deployments.get("RandomBeaconGovernance")
  const currentBeaconGovernance = await read("RandomBeacon", {}, "governance")

  if (
    !helpers.address.equal(
      currentBeaconGovernance,
      RandomBeaconGovernance.address
    )
  ) {
    log(
      "RandomBeacon governance is not this RandomBeaconGovernance deployment; skipping setRequesterAuthorization (WalletRegistry should already be authorized via keep-core Phase D / F)."
    )
    return
  }

  const from = hre.network.name === "mainnet" ? deployer : governance

  await execute(
    "RandomBeaconGovernance",
    { from, log: true, waitConfirmations: 1 },
    "setRequesterAuthorization",
    WalletRegistry.address,
    true
  )
}

module.exports = func
func.tags = ["WalletRegistryAuthorizeInBeacon"]
func.dependencies = ["RandomBeaconGovernance", "WalletRegistry"]
