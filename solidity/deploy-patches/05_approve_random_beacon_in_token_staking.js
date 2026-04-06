"use strict"
/**
 * Patched copy of @keep-network/random-beacon/export/deploy/05_approve_random_beacon_in_token_staking.js
 *
 * keep-core Phase D already calls approveApplication(RandomBeacon). Phase H runs the same script again;
 * TokenStaking reverts with "Can't approve application" when status is already APPROVED.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments } = hre
  const { deployer } = await getNamedAccounts()
  const { execute, read, log } = deployments

  const RandomBeacon = await deployments.get("RandomBeacon")
  const info = await read(
    "TokenStaking",
    {},
    "applicationInfo",
    RandomBeacon.address
  )
  const raw = Array.isArray(info) ? info[0] : info.status
  const status =
    raw && typeof raw.toNumber === "function"
      ? raw.toNumber()
      : Number(raw)

  // ApplicationStatus: NOT_APPROVED=0, APPROVED=1, PAUSED=2, DISABLED=3
  if (status === 1) {
    log(
      "RandomBeacon already approved in TokenStaking (keep-core Phase D); skipping approveApplication"
    )
    return
  }

  await execute(
    "TokenStaking",
    { from: deployer, log: true, waitConfirmations: 1 },
    "approveApplication",
    RandomBeacon.address
  )
}

module.exports = func
func.tags = ["RandomBeaconApprove"]
func.dependencies = ["TokenStaking", "RandomBeacon"]
func.skip = async function (hre) {
  return hre.network.name === "mainnet"
}
