import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { execute, log } = deployments
  const { deployer } = await getNamedAccounts()

  // Fake ArbitrumWormholeGateway for local development purposes only.
  const fakeArbitrumWormholeGateway =
    "0x1af5DC16568EFF2d480a43A77E6C409e497FcFb9"

  // See https://book.wormhole.com/reference/contracts.html
  // This ID is valid for Arbitrum Mainnet.
  const arbitrumWormholeChainID = 23

  const arbitrumWormholeGateway = await deployments.getOrNull(
    "ArbitrumWormholeGateway"
  )

  let arbitrumWormholeGatewayAddress = arbitrumWormholeGateway?.address
  if (!arbitrumWormholeGatewayAddress && hre.network.name === "hardhat") {
    arbitrumWormholeGatewayAddress = fakeArbitrumWormholeGateway
    log(
      `fake ArbitrumWormholeGateway address ${arbitrumWormholeGatewayAddress}`
    )
  }

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    arbitrumWormholeChainID,
    ethers.utils.hexZeroPad(arbitrumWormholeGatewayAddress, 32)
  )
}

export default func

func.tags = ["SetArbitrumGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway"]
