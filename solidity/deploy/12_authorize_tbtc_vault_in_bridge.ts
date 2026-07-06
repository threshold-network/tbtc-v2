import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  const TBTCVault = await deployments.get("TBTCVault")

  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "setVaultStatus",
    TBTCVault.address,
    true
  )
}

export default func

func.tags = ["AuthorizeTBTCVault"]
func.dependencies = ["Bridge", "TBTCVault"]
