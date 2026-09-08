import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { isDisabledGatewaySupported } from "../../deploy_helpers/disabled_gateway"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://book.wormhole.com/reference/contracts.html
  // This ID is valid for both Arbitrum Goerli and Mainnet
  const arbitrumWormholeChainID = 23
  const polygonWormholeGateway = await get("PolygonWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (
    !(await isDisabledGatewaySupported(
      hre,
      polygonWormholeGateway.address,
      "PolygonWormholeGateway",
      "Arbitrum",
      disabledGateway
    ))
  ) {
    return
  }

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    arbitrumWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockArbitrumGatewayAddress", "DeprecatePolygon"]
func.dependencies = ["PolygonWormholeGateway"]
