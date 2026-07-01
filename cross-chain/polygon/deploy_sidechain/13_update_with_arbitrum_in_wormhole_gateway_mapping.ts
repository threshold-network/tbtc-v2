import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { execute, read } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://book.wormhole.com/reference/contracts.html
  // This ID is valid for both Arbitrum Goerli and Mainnet
  const arbitrumWormholeChainID = 23
  const disabledGateway = await read(
    "PolygonWormholeGateway",
    "DISABLED_GATEWAY"
  )

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    arbitrumWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockArbitrumGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway"]
