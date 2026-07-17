import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, getNamedAccounts, deployments } = hre
  const { deployer } = await getNamedAccounts()

  console.log("=== Configuring Token Pool Chain Updates on Bob ===")
  console.log(`Deployer: ${deployer}`)

  const tokenPoolDeployment = await deployments.get(
    "BurnFromMintTokenPoolUpgradeable"
  )
  console.log(`Token Pool Address: ${tokenPoolDeployment.address}`)

  const tokenPool = await ethers.getContractAt(
    "BurnFromMintTokenPoolUpgradeable",
    tokenPoolDeployment.address,
    await ethers.getSigner(deployer)
  )

  const ETHEREUM_CHAIN_SELECTOR = "16015286601757825753"
  const ETHEREUM_POOL = "0x5b1D134fc62395AA3148128454C1a65B213334CD"
  const ETHEREUM_TBTC = "0x517f2982701695D4E52f1ECFBEf3ba31Df470161"

  const encodedEthereumPool = ethers.utils.defaultAbiCoder.encode(
    ["address"],
    [ETHEREUM_POOL]
  )
  const encodedEthereumToken = ethers.utils.defaultAbiCoder.encode(
    ["address"],
    [ETHEREUM_TBTC]
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
    remoteChainSelector: ETHEREUM_CHAIN_SELECTOR,
    remotePoolAddresses: [encodedEthereumPool],
    remoteTokenAddress: encodedEthereumToken,
    outboundRateLimiterConfig: outboundRateLimiterConfig,
    inboundRateLimiterConfig: inboundRateLimiterConfig,
  }

  console.log("\nChain Configuration:")
  console.log("  Remote Chain: Ethereum")
  console.log(`  Chain Selector: ${ETHEREUM_CHAIN_SELECTOR}`)
  console.log(`  Remote Pool: ${ETHEREUM_POOL}`)
  console.log(`  Remote Pool (encoded): ${encodedEthereumPool}`)
  console.log(`  Remote Token: ${ETHEREUM_TBTC}`)
  console.log(`  Remote Token (encoded): ${encodedEthereumToken}`)
  console.log("  Outbound Rate Limiter: DISABLED")
  console.log("  Inbound Rate Limiter: DISABLED")

  try {
    const isSupported = await tokenPool.isSupportedChain(
      ETHEREUM_CHAIN_SELECTOR
    )
    console.log(`\nChain already supported: ${isSupported}`)

    if (isSupported) {
      const existingPools = await tokenPool.getRemotePools(
        ETHEREUM_CHAIN_SELECTOR
      )
      console.log(`Existing remote pools: ${existingPools.join(", ")}`)

      try {
        const currentRemoteToken = await tokenPool.getRemoteToken(
          ETHEREUM_CHAIN_SELECTOR
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

    const isNowSupported = await tokenPool.isSupportedChain(
      ETHEREUM_CHAIN_SELECTOR
    )
    const remotePools = await tokenPool.getRemotePools(ETHEREUM_CHAIN_SELECTOR)
    const remoteToken = await tokenPool.getRemoteToken(ETHEREUM_CHAIN_SELECTOR)

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
            decoded[0].toLowerCase() === ETHEREUM_TBTC.toLowerCase()
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
