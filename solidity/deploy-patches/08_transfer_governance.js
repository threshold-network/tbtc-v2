"use strict"
/**
 * Patched copy of @keep-network/random-beacon/export/deploy/08_transfer_governance.js
 *
 * keep-core Phase D runs this script first: RandomBeacon.governance becomes RandomBeaconGovernance.
 * Phase H deploys a *new* RandomBeaconGovernance and replays 08; transferGovernance must be called
 * by the *current* governance (the old RandomBeaconGovernance contract), not deployer → revert.
 *
 * We skip transferGovernance when governance is already set and not deployer; we still move Ownable
 * on a newly deployed RandomBeaconGovernance from deployer → governance EOA when applicable.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()
  const { execute, read, log } = deployments

  const RandomBeaconGovernance = await deployments.get("RandomBeaconGovernance")
  const currentBeaconGovernance = await read("RandomBeacon", {}, "governance")

  if (
    helpers.address.equal(
      currentBeaconGovernance,
      RandomBeaconGovernance.address
    )
  ) {
    log(
      "RandomBeacon governance already points to this RandomBeaconGovernance deployment; skipping transfer steps"
    )
    return
  }

  const rbgOwner = await read("RandomBeaconGovernance", {}, "owner")
  if (helpers.address.equal(rbgOwner, deployer)) {
    await helpers.ownable.transferOwnership(
      "RandomBeaconGovernance",
      governance,
      deployer
    )
  } else {
    log(
      `RandomBeaconGovernance owner is ${rbgOwner}; skipping Ownable transfer (not deployer)`
    )
  }

  if (!helpers.address.equal(currentBeaconGovernance, deployer)) {
    log(
      "RandomBeacon governance is not deployer; keep-core Phase D already transferred governance to the prior RandomBeaconGovernance contract. " +
        "Skipping transferGovernance — use that contract's begin/finalizeRandomBeaconGovernanceTransfer if you must point RandomBeacon at a new governance contract."
    )
    return
  }

  await execute(
    "RandomBeacon",
    { from: deployer, log: true, waitConfirmations: 1 },
    "transferGovernance",
    RandomBeaconGovernance.address
  )
}

module.exports = func
func.tags = ["RandomBeaconTransferGovernance"]
func.dependencies = ["RandomBeaconGovernance"]
