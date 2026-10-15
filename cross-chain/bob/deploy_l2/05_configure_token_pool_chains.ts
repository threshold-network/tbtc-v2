import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

// Ethereum-mainnet side of the BOB CCIP route, verified against live
// BOB-mainnet state on 2026-09-01 (BurnFromMintTokenPoolUpgradeable proxy on
// BOB).
//
// Provenance: this script previously held the matching Sepolia-testnet record
// -- Ethereum Sepolia's chain selector (16015286601757825753) with the sepolia
// pool and the sepolia tBTC that
// deploy_l1/00_deploy_lock_release_token_pool.ts still lists as
// TBTC_ADDRESS.sepolia. Those values were a coherent testnet configuration,
// not stray wrong addresses; the testnet record was converted to the mainnet
// record here because the mainnet route is what this deprecation has to
// document. Exported so test/DeprecatedBobCcipDeployScripts.test.ts pins them.
export const ETHEREUM_CHAIN_SELECTOR = "5009297550715157269"
export const ETHEREUM_POOL = "0x03E342731c08FDDc34cFb43E91cB3a7e424ee0F6"
export const ETHEREUM_TBTC = "0x18084fbA666a33d37592fA2633fD49a74DD93a88"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // The constants above describe the BOB-mainnet pool's remote (Ethereum
  // mainnet) side, so applying them anywhere else would write a mainnet route
  // into an unrelated deployment.
  if (hre.network.name !== "bobMainnet") {
    throw new Error(
      `This script configures the BOB mainnet side of the BOB CCIP route; refusing to run on network "${hre.network.name}" (expected "bobMainnet")`
    )
  }

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
// BOB CCIP support is deprecated. Keep this script for historical reference
// without configuring new BOB CCIP routes.
func.skip = async () => true

export default func
