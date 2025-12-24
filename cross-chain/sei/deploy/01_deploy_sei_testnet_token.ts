import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import {
  deployL2TBTC,
  NETWORK_CONFIGS,
} from "../scripts/deploy-l2tbtc-encrypted"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Only deploy on Sei Testnet
  if (hre.network.name !== "seiTestnet") {
    console.log(`⏭️  Skipping Sei Testnet deployment on ${hre.network.name}`)
    return
  }

  console.log("🎯 Deploying L2TBTC on Sei Testnet...")

  const result = await deployL2TBTC(hre, NETWORK_CONFIGS.seiTestnet)

  console.log("\n📋 Sei Testnet Deployment Summary:")
  console.log(`   Network: ${result.network}`)
  console.log(`   Proxy: ${result.proxy}`)
  console.log(`   Implementation: ${result.implementation}`)
  console.log(`   Admin: ${result.admin}`)
  console.log(`   Owner: ${result.owner}`)

  return result
}

export default func

func.tags = ["SeiTestnetToken", "L2TBTC"]
func.dependencies = []
