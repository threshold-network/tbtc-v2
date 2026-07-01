import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { execute, read } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://book.wormhole.com/reference/contracts.html
  // This ID is valid for both Optimism Goerli and Mainnet
  const optimismWormholeChainID = 24
  const disabledGateway = await read(
    "PolygonWormholeGateway",
    "DISABLED_GATEWAY"
  )

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    optimismWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockOptimismGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway"]
