import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function configureMintBurnGuard(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts } = hre
  const { execute, get, log } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await get("Bridge")
  const Bank = await get("Bank")
  const TBTCVault = await get("TBTCVault")

  log("configuring MintBurnGuard execution targets...")

  // Configure execution targets (Bridge, Bank, Vault)
  await execute(
    "MintBurnGuard",
    { from: deployer, log: true, waitConfirmations: 1 },
    "configureExecutionTargets",
    Bridge.address,
    Bank.address,
    TBTCVault.address
  )

  // Set global mint cap if provided via environment variable
  const globalMintCap = process.env.MINT_BURN_GUARD_GLOBAL_CAP
  if (globalMintCap && globalMintCap.trim().length > 0) {
    log(`setting global mint cap to ${globalMintCap} satoshis...`)
    await execute(
      "MintBurnGuard",
      { from: deployer, log: true, waitConfirmations: 1 },
      "setGlobalMintCap",
      globalMintCap
    )
  } else {
    log("No MINT_BURN_GUARD_GLOBAL_CAP provided; skipping cap configuration.")
  }

  // Set rate limit if both limit and window are provided
  const rateLimit = process.env.MINT_BURN_GUARD_RATE_LIMIT
  const rateWindow = process.env.MINT_BURN_GUARD_RATE_WINDOW
  if (
    rateLimit &&
    rateLimit.trim().length > 0 &&
    rateWindow &&
    rateWindow.trim().length > 0
  ) {
    log(
      `setting mint rate limit to ${rateLimit} satoshis per ${rateWindow} seconds...`
    )
    await execute(
      "MintBurnGuard",
      { from: deployer, log: true, waitConfirmations: 1 },
      "setMintRateLimit",
      rateLimit,
      rateWindow
    )
  } else {
    log(
      "No MINT_BURN_GUARD_RATE_LIMIT or MINT_BURN_GUARD_RATE_WINDOW provided; skipping rate limit configuration."
    )
  }
}

export default func

func.tags = ["ConfigureMintBurnGuard"]
func.dependencies = ["MintBurnGuard", "Bridge", "Bank", "TBTCVault"]
