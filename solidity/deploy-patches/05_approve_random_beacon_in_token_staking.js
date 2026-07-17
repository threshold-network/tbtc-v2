/**
 * Patched copy of @keep-network/random-beacon@2.1.0-dev.18/export/deploy/05_approve_random_beacon_in_token_staking.js
 *
 * keep-core Phase D already calls approveApplication(RandomBeacon). Phase H runs the same script again;
 * TokenStaking reverts with "Can't approve application" when status is already APPROVED.
 *
 * deployments.read("applicationInfo") can throw CALL_EXCEPTION (ABI/decode/RPC/proxy quirks) even though
 * the on-chain getter is a plain mapping — mirror upstream: catch read failures, then try approveApplication.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, ethers } = hre
  const { deployer } = await getNamedAccounts()
  const { execute, read, log } = deployments

  const RandomBeacon = await deployments.get("RandomBeacon")
  const TokenStaking = await deployments.get("TokenStaking")
  const iface = new ethers.utils.Interface(TokenStaking.abi)
  try {
    iface.getFunction("approveApplication")
  } catch {
    log(
      "TokenStaking does not have approveApplication (Threshold TokenStaking); skipping"
    )
    return
  }

  let status = null
  try {
    const info = await read(
      "TokenStaking",
      {},
      "applicationInfo",
      RandomBeacon.address
    )
    const raw = Array.isArray(info) ? info[0] : info.status
    status =
      raw && typeof raw.toNumber === "function" ? raw.toNumber() : Number(raw)
  } catch (e) {
    log(
      `Could not read TokenStaking.applicationInfo (${
        e instanceof Error ? e.message : String(e)
      }); continuing to approveApplication`
    )
  }

  // ApplicationStatus: NOT_APPROVED=0, APPROVED=1, PAUSED=2, DISABLED=3
  if (status === 1) {
    log(
      "RandomBeacon already approved in TokenStaking (keep-core Phase D); skipping approveApplication"
    )
    return
  }

  try {
    await execute(
      "TokenStaking",
      { from: deployer, log: true, waitConfirmations: 1 },
      "approveApplication",
      RandomBeacon.address
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("Can't approve application")) {
      log(
        "approveApplication reverted (likely already APPROVED after keep-core Phase D); skipping"
      )
      return
    }
    if (msg.includes("No method named") && msg.includes("approveApplication")) {
      log(
        "TokenStaking has no approveApplication callable on this network; skipping"
      )
      return
    }
    throw e
  }
}

module.exports = func
func.tags = ["RandomBeaconApprove"]
func.dependencies = ["TokenStaking", "RandomBeacon"]
func.skip = async function (hre) {
  return hre.network.name === "mainnet"
}
