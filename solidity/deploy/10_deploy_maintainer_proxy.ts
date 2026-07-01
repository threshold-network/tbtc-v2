import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")
  const ReimbursementPool = await deployments.get("ReimbursementPool")

  const maintainerProxy = await deploy("MaintainerProxy", {
    contract: "MaintainerProxy",
    from: deployer,
    args: [Bridge.address, ReimbursementPool.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(maintainerProxy)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "MaintainerProxy",
      address: maintainerProxy.address,
    })
  }
}

export default func

func.tags = ["MaintainerProxy"]
func.dependencies = ["Bridge", "ReimbursementPool"]
