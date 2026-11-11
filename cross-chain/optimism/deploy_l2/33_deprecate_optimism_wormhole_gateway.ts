import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateMintingLimit",
    0
  )
}

export default func

func.tags = ["DeprecateOptimismWormholeGateway", "DeprecateOptimism"]
func.skip = async (hre: HardhatRuntimeEnvironment) =>
  hre.network.name !== "hardhat"
func.dependencies = ["OptimismWormholeGateway"]
