import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Skip deployment for hardhat network (testing)
  if (hre.network.name === "hardhat") {
    console.log("Skipping L1 deployment on hardhat network")
    return
  }
  
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership(
    "BaseL1BitcoinDepositor",
    governance,
    deployer
  )
}

export default func

func.tags = ["TransferBaseL1BitcoinDepositorOwnership"]
func.dependencies = ["BaseL1BitcoinDepositor"]
func.runAtTheEnd = true
