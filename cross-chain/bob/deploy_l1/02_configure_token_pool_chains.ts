import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, deployments } = hre
  const { deployer } = await getNamedAccounts()

  console.log(
    "=== Configuring Token Pool Chain Updates on Ethereum Sepolia ==="
  )
  console.log(`Deployer: ${deployer}`)

  const tokenPoolDeployment = await deployments.get(
    "LockReleaseTokenPoolUpgradeable"
  )
  console.log(`Token Pool Address: ${tokenPoolDeployment.address}`)

  const tokenPool = await ethers.getContractAt(
    "LockReleaseTokenPoolUpgradeable",
    tokenPoolDeployment.address,
    await ethers.getSigner(deployer)
  )

  const BOB_CHAIN_SELECTOR = "5535534526963509396"
  const BOB_POOL = "0x32a88b83DeD5F06bc05eC60F2cF45CC0FEdC6C25"
  const BOB_TBTC = "0xD23F06550b0A7bC98B20eb81D4c21572a97598FA"

  const encodedBobPool = ethers.utils.defaultAbiCoder.encode(
    ["address"],
    [BOB_POOL]
  )
  const encodedBobToken = ethers.utils.defaultAbiCoder.encode(
    ["address"],
    [BOB_TBTC]
  )

  const outboundRateLimiterConfig = {
    rate: ethers.utils.parseEther("0"),
    capacity: ethers.utils.parseEther("0"),
    isEnabled: false,
  }

  const inboundRateLimiterConfig = {
    rate: ethers.utils.parseEther("0"),
    capacity: ethers.utils.parseEther("0"),
    isEnabled: false,
  }

  const chainUpdate = {
    remoteChainSelector: BOB_CHAIN_SELECTOR,
    remotePoolAddresses: [encodedBobPool],
    remoteTokenAddress: encodedBobToken,
    outboundRateLimiterConfig: outboundRateLimiterConfig,
    inboundRateLimiterConfig: inboundRateLimiterConfig,
  }

  console.log("\nChain Configuration:")
  console.log("  Remote Chain: Bob")
  console.log(`  Chain Selector: ${BOB_CHAIN_SELECTOR}`)
  console.log(`  Remote Pool: ${BOB_POOL}`)
  console.log(`  Remote Pool (encoded): ${encodedBobPool}`)
  console.log(`  Remote Token: ${BOB_TBTC}`)
  console.log(`  Remote Token (encoded): ${encodedBobToken}`)
  console.log("  Outbound Rate Limiter: DISABLED")
  console.log("  Inbound Rate Limiter: DISABLED")

  try {
    const isSupported = await tokenPool.isSupportedChain(BOB_CHAIN_SELECTOR)
    console.log(`\nChain already supported: ${isSupported}`)

    if (isSupported) {
      const existingPools = await tokenPool.getRemotePools(BOB_CHAIN_SELECTOR)
      console.log(`Existing remote pools: ${existingPools.join(", ")}`)

      try {
        const currentRemoteToken = await tokenPool.getRemoteToken(
          BOB_CHAIN_SELECTOR
        )
        console.log(`Current remote token: ${currentRemoteToken}`)
        console.log(
          `Is properly encoded (66 chars): ${currentRemoteToken.length === 66}`
        )
      } catch (e) {
        console.log("Could not fetch current remote token")
      }
    }
  } catch (e) {
    console.log("\nUnable to check current configuration")
  }

  console.log("\nApplying chain updates...")
  try {
    const tx = await tokenPool.applyChainUpdates([], [chainUpdate])

    console.log(`Transaction hash: ${tx.hash}`)
    console.log("Waiting for confirmation...")

    const receipt = await tx.wait()
    console.log(`Transaction confirmed in block: ${receipt.blockNumber}`)
    console.log("✅ Chain configuration applied successfully!")

    const isNowSupported = await tokenPool.isSupportedChain(BOB_CHAIN_SELECTOR)
    const remotePools = await tokenPool.getRemotePools(BOB_CHAIN_SELECTOR)
    const remoteToken = await tokenPool.getRemoteToken(BOB_CHAIN_SELECTOR)

    console.log("\nVerification:")
    console.log(`  Chain supported: ${isNowSupported}`)
    console.log(`  Remote pools: ${remotePools.join(", ")}`)
    console.log(`  Remote token: ${remoteToken}`)
    console.log(`  Remote token length: ${remoteToken.length} chars`)
    console.log(
      `  Is properly encoded: ${remoteToken.length === 66 ? "✅ YES" : "❌ NO"}`
    )

    if (remoteToken.length === 66) {
      try {
        const decoded = ethers.utils.defaultAbiCoder.decode(
          ["address"],
          remoteToken
        )
        console.log(`  Decoded address: ${decoded[0]}`)
        console.log(
          `  Matches expected: ${
            decoded[0].toLowerCase() === BOB_TBTC.toLowerCase()
              ? "✅ YES"
              : "❌ NO"
          }`
        )
      } catch (e) {
        console.log("  Could not decode remote token")
      }
    }
  } catch (error) {
    console.error("Error applying chain updates:", error)
    throw error
  }
}

func.tags = ["ConfigureTokenPoolChains"]

export default func
