import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import {
  deployL1BTCDepositorNttWithExecutor,
  NETWORK_CONFIGS,
} from "../scripts/deploy-l1btc-depositor-ntt-executor"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Only deploy on Sepolia network
  if (hre.network.name !== "sepolia") {
    console.log(
      `⏭️  Skipping Sepolia L1BTCDepositorNttWithExecutor deployment on ${hre.network.name}`
    )
    return
  }

  console.log("🎯 Deploying L1BTCDepositorNttWithExecutor on Sepolia...")

  const result = await deployL1BTCDepositorNttWithExecutor(
    hre,
    NETWORK_CONFIGS.sepolia
  )

  console.log("\n📋 Sepolia L1BTCDepositorNttWithExecutor Deployment Summary:")
  console.log(`   Network: ${result.network}`)
  console.log(`   Proxy: ${result.proxy}`)
  console.log(`   Implementation: ${result.implementation}`)
  console.log(`   Admin: ${result.admin}`)
  console.log(`   Owner: ${result.owner}`)
  console.log(`   tBTC Bridge: ${result.tbtcBridge}`)
  console.log(`   tBTC Vault: ${result.tbtcVault}`)
  console.log(`   NTT Manager With Executor: ${result.nttManagerWithExecutor}`)
  console.log(`   Underlying NTT Manager: ${result.underlyingNttManager}`)

  return result
}

export default func

func.tags = [
  "SepoliaL1BTCDepositorNttExecutor",
  "L1BTCDepositorNttWithExecutor",
]
func.dependencies = []
