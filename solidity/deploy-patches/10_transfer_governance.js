"use strict"
/**
 * Patched copy of @keep-network/ecdsa/export/deploy/10_transfer_governance.js
 *
 * Same situation as random-beacon 08: Phase F (keep-core) may already have run this; Phase H replays
 * it with a new WalletRegistryGovernance deploy — transferGovernance must be called by current
 * governance, not deployer.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()
  const { execute, read, log } = deployments

  const WalletRegistryGovernance = await deployments.get("WalletRegistryGovernance")
  const currentRegistryGovernance = await read("WalletRegistry", {}, "governance")

  if (
    helpers.address.equal(
      currentRegistryGovernance,
      WalletRegistryGovernance.address
    )
  ) {
    log(
      "WalletRegistry governance already points to this WalletRegistryGovernance deployment; skipping transfer steps"
    )
    return
  }

  const wrgOwner = await read("WalletRegistryGovernance", {}, "owner")
  if (helpers.address.equal(wrgOwner, deployer)) {
    await helpers.ownable.transferOwnership(
      "WalletRegistryGovernance",
      governance,
      deployer
    )
  } else {
    log(
      `WalletRegistryGovernance owner is ${wrgOwner}; skipping Ownable transfer (not deployer)`
    )
  }

  if (!helpers.address.equal(currentRegistryGovernance, deployer)) {
    log(
      "WalletRegistry governance is not deployer; keep-core Phase F already transferred governance. " +
        "Skipping transferGovernance — use the existing WalletRegistryGovernance contract to migrate if needed."
    )
    return
  }

  await execute(
    "WalletRegistry",
    { from: deployer, log: true, waitConfirmations: 1 },
    "transferGovernance",
    WalletRegistryGovernance.address
  )
}

module.exports = func
func.tags = ["WalletRegistryTransferGovernance"]
func.dependencies = ["WalletRegistryGovernance"]
