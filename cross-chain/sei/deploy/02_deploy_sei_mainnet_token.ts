import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import {
  deployL2TBTC,
  NETWORK_CONFIGS,
} from "../scripts/deploy-l2tbtc-encrypted"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Only deploy on Sei Pacific-1
  if (hre.network.name !== "pacific-1") {
    console.log(`⏭️  Skipping Sei Pacific-1 deployment on ${hre.network.name}`)
    return
  }

  console.log("🎯 Deploying L2TBTC on Sei Pacific-1...")

  const result = await deployL2TBTC(hre, NETWORK_CONFIGS.seiMainnet)

  console.log("\n📋 Sei Mainnet Deployment Summary:")
  console.log(`   Network: ${result.network}`)
  console.log(`   Proxy: ${result.proxy}`)
  console.log(`   Implementation: ${result.implementation}`)
  console.log(`   Admin: ${result.admin}`)
  console.log(`   Owner: ${result.owner}`)

  return true
}

export default func

func.tags = ["SeiMainnetToken", "L2TBTC"]
func.dependencies = []
