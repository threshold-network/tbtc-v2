import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  // Skip deployment for hardhat network (testing)
  if (hre.network.name === "hardhat") {
    console.log("Skipping L1 deployment on hardhat network")
    return
  }
  
  const { deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()
  const { execute } = deployments
  const l2Deployments = hre.companionNetworks.l2.deployments

  const baseL2BitcoinDepositor = await l2Deployments.get(
    "BaseL2BitcoinDepositor"
  )

  await execute(
    "BaseL1BitcoinDepositor",
    { from: deployer, log: true, waitConfirmations: 1 },
    "attachL2BitcoinDepositor",
    baseL2BitcoinDepositor.address
  )
}

export default func

func.tags = ["AttachBaseL2BitcoinDepositor"]
func.dependencies = ["BaseL1BitcoinDepositor"]
