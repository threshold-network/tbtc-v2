import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, deployments } = hre
  const { deployer } = await getNamedAccounts()

  console.log("=== Configuring Token Pool Chain Updates on Ethereum Sepolia ===")
  console.log(`Deployer: ${deployer}`)

  // Get the deployed token pool
  const tokenPoolDeployment = await deployments.get("LockReleaseTokenPoolUpgradeable")
  console.log(`Token Pool Address: ${tokenPoolDeployment.address}`)

  // Connect to the token pool contract
  const tokenPool = await ethers.getContractAt(
    "LockReleaseTokenPoolUpgradeable",
    tokenPoolDeployment.address,
    await ethers.getSigner(deployer)
  )

  // Configuration for Bob
  const BOB_CHAIN_SELECTOR = "5535534526963509396"
  const BOB_POOL = "0x5580A6201B83ba6C1019866484AB6a34d085471F"
  const BOB_TBTC = "0xD23F06550b0A7bC98B20eb81D4c21572a97598FA"

  // Rate limiter configurations - DISABLED
  // Setting isEnabled to false disables rate limiting entirely
  // Note: Even when disabled, rate and capacity must be > 0 for validation
  const outboundRateLimiterConfig = {
    rate: ethers.utils.parseEther("1"), // Must be > 0 even when disabled
    capacity: ethers.utils.parseEther("1"), // Must be > 0 even when disabled
    isEnabled: false // Disable rate limiting
  }

  const inboundRateLimiterConfig = {
    rate: ethers.utils.parseEther("1"), // Must be > 0 even when disabled
    capacity: ethers.utils.parseEther("1"), // Must be > 0 even when disabled
    isEnabled: false // Disable rate limiting
  }

  // Prepare chain update
  const chainUpdate = {
    remoteChainSelector: BOB_CHAIN_SELECTOR,
    remotePoolAddresses: [BOB_POOL],
    remoteTokenAddress: BOB_TBTC,
    outboundRateLimiterConfig: outboundRateLimiterConfig,
    inboundRateLimiterConfig: inboundRateLimiterConfig
  }

  console.log("\nChain Configuration:")
  console.log("  Remote Chain: Bob")
  console.log(`  Chain Selector: ${BOB_CHAIN_SELECTOR}`)
  console.log(`  Remote Pool: ${BOB_POOL}`)
  console.log(`  Remote Token: ${BOB_TBTC}`)
  console.log("  Outbound Rate Limiter: DISABLED")
  console.log("  Inbound Rate Limiter: DISABLED")

  // Check current configuration
  try {
    const isSupported = await tokenPool.isSupportedChain(BOB_CHAIN_SELECTOR)
    console.log(`\nChain already supported: ${isSupported}`)
    
    if (isSupported) {
      const existingPools = await tokenPool.getRemotePools(BOB_CHAIN_SELECTOR)
      console.log(`Existing remote pools: ${existingPools.join(", ")}`)
    }
  } catch (e) {
    console.log("\nUnable to check current configuration")
  }

  // Apply chain updates
  console.log("\nApplying chain updates...")
  try {
    const tx = await tokenPool.applyChainUpdates(
      [], // No chains to remove
      [chainUpdate] // Add Bob configuration
    )
    
    console.log(`Transaction hash: ${tx.hash}`)
    console.log("Waiting for confirmation...")
    
    const receipt = await tx.wait()
    console.log(`Transaction confirmed in block: ${receipt.blockNumber}`)
    console.log("✅ Chain configuration applied successfully!")

    // Verify configuration
    const isNowSupported = await tokenPool.isSupportedChain(BOB_CHAIN_SELECTOR)
    const remotePools = await tokenPool.getRemotePools(BOB_CHAIN_SELECTOR)
    const remoteToken = await tokenPool.getRemoteToken(BOB_CHAIN_SELECTOR)
    
    console.log("\nVerification:")
    console.log(`  Chain supported: ${isNowSupported}`)
    console.log(`  Remote pools: ${remotePools.join(", ")}`)
    console.log(`  Remote token: ${remoteToken}`)
    
  } catch (error) {
    console.error("Error applying chain updates:", error)
    throw error
  }
}

func.tags = ["ConfigureTokenPoolChains"]

export default func