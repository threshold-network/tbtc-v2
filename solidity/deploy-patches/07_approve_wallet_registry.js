/**
 * Patched copy of @keep-network/ecdsa@2.1.0-dev.19/export/deploy/07_approve_wallet_registry.js
 *
 * keep-core Phase F already calls approveApplication(WalletRegistry). Phase H must not revert
 * when the application is already APPROVED.
 *
 * Some Threshold TokenStaking variants do not expose applicationInfo/approveApplication; and
 * deployments.read("applicationInfo") can throw CALL_EXCEPTION (ABI/decode/RPC/proxy quirks)
 * even when the on-chain getter is a plain mapping. Mirror 05_approve_random_beacon_in_token_staking.js:
 * probe the ABI, tolerate read failures, and handle absent/already-approved approveApplication.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, ethers } = hre
  const { deployer } = await getNamedAccounts()
  const { execute, read, log } = deployments

  const WalletRegistry = await deployments.get("WalletRegistry")
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
      WalletRegistry.address
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
      "WalletRegistry already approved in TokenStaking (keep-core Phase F); skipping approveApplication"
    )
    return
  }

  try {
    await execute(
      "TokenStaking",
      { from: deployer, log: true, waitConfirmations: 1 },
      "approveApplication",
      WalletRegistry.address
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("Can't approve application")) {
      log(
        "approveApplication reverted (likely already APPROVED after keep-core Phase F); skipping"
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
func.tags = ["WalletRegistryApprove"]
func.dependencies = ["TokenStaking", "WalletRegistry"]
func.skip = async function (hre) {
  return hre.network.name === "mainnet"
}
