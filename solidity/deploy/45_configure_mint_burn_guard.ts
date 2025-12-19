import { config as dotenvConfig } from "dotenv"
import { Contract, BigNumber, ethers as ethersTypes } from "ethers"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

dotenvConfig({ override: true })

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { log } = deployments

  const { deployer } = await getNamedAccounts()

  const cachedMintBurnGuard = await deployments.getOrNull("MintBurnGuard")
  const mintBurnGuardAddress =
    cachedMintBurnGuard?.address ?? process.env.MINTBURN_GUARD_ADDRESS
  if (!mintBurnGuardAddress) {
    throw new Error(
      "MintBurnGuard address not found. Provide MINTBURN_GUARD_ADDRESS or ensure deployments cache exists."
    )
  }

  const mintBurnGuard = await ethers.getContractAt(
    "MintBurnGuard",
    mintBurnGuardAddress
  )

  const signer = await ethers.getSigner(deployer)

  log("🛡️  Configuring MintBurnGuard security parameters...")
  log(`MintBurnGuard address: ${mintBurnGuardAddress}`)
  log(`Configuring with signer: ${signer.address}`)

  // Check if signer is owner
  const owner = await mintBurnGuard.owner()
  const isOwner = owner.toLowerCase() === signer.address.toLowerCase()
  log(`MintBurnGuard owner: ${owner}`)
  log(`Current signer is owner: ${isOwner}`)

  if (!isOwner) {
    throw new Error(
      "Current signer is not the MintBurnGuard owner; configuration aborted."
    )
  }

  // Configuration parameters (env overrides supported)
  const maxMintCapTbtc = parseEnvEther(
    process.env.MINT_BURN_GUARD_GLOBAL_CAP,
    "MINT_BURN_GUARD_GLOBAL_CAP"
  )
  const rateLimitTbtc = parseEnvEther(
    process.env.MINT_BURN_GUARD_RATE_LIMIT,
    "MINT_BURN_GUARD_RATE_LIMIT"
  )
  const rateLimitWindowSeconds = rateLimitTbtc.isZero()
    ? 0
    : parseEnvInt(
        process.env.MINT_BURN_GUARD_RATE_WINDOW,
        "MINT_BURN_GUARD_RATE_WINDOW"
      )

  log("\n📋 Configuration parameters:")
  log(`  Global Mint Cap: ${ethers.utils.formatEther(maxMintCapTbtc)} TBTC`)
  log(
    `  Rate Limit: ${ethers.utils.formatEther(rateLimitTbtc)} TBTC per window`
  )
  log(`  Rate Window: ${rateLimitWindowSeconds} seconds (24 hours)`)

  // Check current configuration to avoid unnecessary transactions
  const currentGlobalCapTbtc = await mintBurnGuard.globalMintCapTbtc()
  const currentRateLimitTbtc = await mintBurnGuard.mintRateLimitTbtc()
  const currentRateWindowSeconds =
    await mintBurnGuard.mintRateLimitWindowSeconds()

  let configNeeded = false

  // Step 1: Set global mint cap if needed
  if (!currentGlobalCapTbtc.eq(maxMintCapTbtc)) {
    log("1️⃣  Setting global mint cap...")
    const capTx = await mintBurnGuard
      .connect(signer)
      .setGlobalMintCapTbtc(maxMintCapTbtc)
    log(`   Transaction submitted: ${capTx.hash}`)
    await capTx.wait()
    log("   ✅ Global mint cap set successfully")
    configNeeded = true
  } else {
    log("1️⃣  Global mint cap already correctly configured")
  }

  // Step 2: Set rate limits if needed
  if (
    !currentRateLimitTbtc.eq(rateLimitTbtc) ||
    !currentRateWindowSeconds.eq(rateLimitWindowSeconds)
  ) {
    log("2️⃣  Setting rate limits...")
    const rateTx = await mintBurnGuard
      .connect(signer)
      .setMintRateLimit(rateLimitTbtc, rateLimitWindowSeconds)
    log(`   Transaction submitted: ${rateTx.hash}`)
    await rateTx.wait()
    log("   ✅ Rate limits set successfully")
    configNeeded = true
  } else {
    log("2️⃣  Rate limits already correctly configured")
  }

  if (!configNeeded) {
    log("✅ All security parameters already configured correctly")
  }

  await verifyMintBurnGuardSecurity(mintBurnGuard, ethers, log)

  log("\n🎉 MintBurnGuard security configuration completed")
}

export default func

func.tags = ["MintBurnGuardSecurity"]
func.dependencies = ["MintBurnGuard"]
// Skip this configuration by default to avoid accidental execution
// Set CONFIGURE_MINT_BURN_GUARD=true to enable
func.skip = async () => process.env.CONFIGURE_MINT_BURN_GUARD !== "true"

function parseEnvEther(
  value: string | undefined,
  variableName: string
): BigNumber {
  if (!value || value.length === 0) {
    throw new Error(
      `${variableName} must be set (string representing an ether amount).`
    )
  }
  try {
    return ethersTypes.utils.parseEther(value)
  } catch (error) {
    throw new Error(
      `Invalid ether value for ${variableName}: ${value} (${
        (error as Error).message
      })`
    )
  }
}

function parseEnvInt(value: string | undefined, variableName: string): number {
  if (!value || value.length === 0) {
    throw new Error(`${variableName} must be set (positive integer).`)
  }
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer value for ${variableName}: ${value}`)
  }
  return parsed
}

async function verifyMintBurnGuardSecurity(
  mintBurnGuard: Contract,
  ethers: HardhatRuntimeEnvironment["ethers"],
  log: (message: string) => void
): Promise<void> {
  const globalCapTbtc = await mintBurnGuard.globalMintCapTbtc()
  const rateLimitTbtc = await mintBurnGuard.mintRateLimitTbtc()
  const rateWindowSeconds = await mintBurnGuard.mintRateLimitWindowSeconds()

  const totalMintedTbtc = await mintBurnGuard.totalMintedTbtc()
  const rateWindowAmountTbtc = await mintBurnGuard.mintRateWindowAmountTbtc()
  const mintingPaused = await mintBurnGuard.mintingPaused()

  const remainingGlobalTbtc = globalCapTbtc.gt(totalMintedTbtc)
    ? globalCapTbtc.sub(totalMintedTbtc)
    : ethers.constants.Zero
  const remainingRateTbtc = rateLimitTbtc.gt(rateWindowAmountTbtc)
    ? rateLimitTbtc.sub(rateWindowAmountTbtc)
    : ethers.constants.Zero
  const currentCapacityTbtc = remainingGlobalTbtc.lt(remainingRateTbtc)
    ? remainingGlobalTbtc
    : remainingRateTbtc

  log("\n🔍 MintBurnGuard security verification:")
  log(`  Global Mint Cap: ${ethers.utils.formatEther(globalCapTbtc)} TBTC`)
  log(`  Rate Limit: ${ethers.utils.formatEther(rateLimitTbtc)} TBTC`)
  log(`  Rate Window: ${rateWindowSeconds.toString()} seconds`)
  log(`  Minting paused: ${mintingPaused}`)
  log(
    `  Total minted so far: ${ethers.utils.formatEther(totalMintedTbtc)} TBTC`
  )
  log(
    `  Rate window amount: ${ethers.utils.formatEther(
      rateWindowAmountTbtc
    )} TBTC`
  )
  log(
    `  Remaining global capacity: ${ethers.utils.formatEther(
      remainingGlobalTbtc
    )} TBTC`
  )
  log(
    `  Remaining rate capacity: ${ethers.utils.formatEther(
      remainingRateTbtc
    )} TBTC`
  )
  log(
    `  Effective minting capacity: ${ethers.utils.formatEther(
      currentCapacityTbtc
    )} TBTC`
  )

  log("  🔐 Minted vs cap check:")
  if (totalMintedTbtc.gt(globalCapTbtc)) {
    log("  ❌ Total minted exceeds global cap! Investigate before continuing.")
    throw new Error("MintBurnGuard total minted exceeds configured cap.")
  } else {
    log("  ✅ Total minted remains within global cap.")
  }

  if (mintingPaused) {
    log("  ⚠️  Minting is paused; ensure governance expects this state")
  } else {
    log("  ✅ Minting is active")
  }
}
