import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute, log } = deployments
  const { deployer } = await getNamedAccounts()

  // Fake PolygonWormholeGateway for local development purposes only.
  const fakePolygonWormholeGateway =
    "0x1af5DC16568EFF2d480a43A77E6C409e497FcFb9"

  // This ID is valid for Polygon Mainnet. Wormhole does not support the
  // Sepolia-based Amoy Testnet yet.
  // TODO: Update the ID once the support is added.
  const polygonWormholeChainID = 5

  const polygonWormholeGateway = await deployments.getOrNull(
    "PolygonWormholeGateway"
  )

  let polygonWormholeGatewayAddress = polygonWormholeGateway?.address
  if (!polygonWormholeGatewayAddress && hre.network.name === "hardhat") {
    polygonWormholeGatewayAddress = fakePolygonWormholeGateway
    log(`fake PolygonWormholeGateway address ${polygonWormholeGatewayAddress}`)
  }

  await execute(
    "ArbitrumWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    polygonWormholeChainID,
    ethers.utils.hexZeroPad(polygonWormholeGatewayAddress, 32)
  )
}

export default func

func.tags = ["SetPolygonGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway", "ArbitrumWormholeGateway"]
