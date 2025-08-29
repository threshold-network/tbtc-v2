import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://book.wormhole.com/reference/contracts.html
  // This ID is valid for both Polygon Testnet (Mumbai) and Mainnet
  // TODO: check ID for the Amoy testnet once it's supported by Wormhole.
  const wormholeChainID = 5

  const polygonWormholeGateway = await deployments.get("PolygonWormholeGateway")

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    wormholeChainID,
    ethers.utils.hexZeroPad(polygonWormholeGateway.address, 32)
  )
}

export default func

func.tags = ["SetPolygonGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway"]
