"use strict"
/**
 * Patched copy of @keep-network/ecdsa/export/deploy/07_approve_wallet_registry.js
 *
 * keep-core Phase F already calls approveApplication(WalletRegistry). Phase H must not revert
 * when the application is already APPROVED.
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments } = hre
  const { deployer } = await getNamedAccounts()
  const { execute, read, log } = deployments

  const WalletRegistry = await deployments.get("WalletRegistry")
  const info = await read(
    "TokenStaking",
    {},
    "applicationInfo",
    WalletRegistry.address
  )
  const raw = Array.isArray(info) ? info[0] : info.status
  const status =
    raw && typeof raw.toNumber === "function"
      ? raw.toNumber()
      : Number(raw)

  if (status === 1) {
    log(
      "WalletRegistry already approved in TokenStaking (keep-core Phase F); skipping approveApplication"
    )
    return
  }

  await execute(
    "TokenStaking",
    { from: deployer, log: true, waitConfirmations: 1 },
    "approveApplication",
    WalletRegistry.address
  )
}

module.exports = func
func.tags = ["WalletRegistryApprove"]
func.dependencies = ["TokenStaking", "WalletRegistry"]
func.skip = async function (hre) {
  return hre.network.name === "mainnet"
}
