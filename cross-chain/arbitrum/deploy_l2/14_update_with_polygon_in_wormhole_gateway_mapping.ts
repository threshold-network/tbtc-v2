import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { isDisabledGatewaySupported } from "../../deploy_helpers/disabled_gateway"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // This ID is valid for both Polygon Goerli-based Testnet (Mumbai) and
  // Mainnet. Wormhole does not support the Sepolia-based Amoy Testnet yet.
  // TODO: Update the ID once the support is added.
  const polygonWormholeChainID = 5
  const arbitrumWormholeGateway = await get("ArbitrumWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (
    !(await isDisabledGatewaySupported(
      hre,
      arbitrumWormholeGateway.address,
      "ArbitrumWormholeGateway",
      "Polygon",
      disabledGateway
    ))
  ) {
    return
  }

  await execute(
    "ArbitrumWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    polygonWormholeChainID,
    disabledGateway
  )
}

export default func

func.tags = ["BlockPolygonGatewayAddress"]
func.dependencies = ["ArbitrumWormholeGateway"]
