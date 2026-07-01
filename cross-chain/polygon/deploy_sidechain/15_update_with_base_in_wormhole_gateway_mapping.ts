import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  // See https://docs.wormhole.com/wormhole/blockchain-environments/evm#base
  // This ID is valid for both Base Goerli and Mainnet
  const baseWormholeChainID = 30
  const polygonWormholeGateway = await get("PolygonWormholeGateway")
  const disabledGateway = ethers.utils.hexZeroPad("0x01", 32)

  if (
    !(await isDisabledGatewaySupported(
      hre,
      polygonWormholeGateway.address,
      "PolygonWormholeGateway",
      "Base",
      disabledGateway
    ))
  ) {
    return
  }

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    baseWormholeChainID,
    disabledGateway
  )
}

async function isDisabledGatewaySupported(
  hre: HardhatRuntimeEnvironment,
  gatewayAddress: string,
  gatewayName: string,
  destinationName: string,
  disabledGateway: string
): Promise<boolean> {
  if (hre.network.name === "hardhat") {
    return true
  }

  const encodedDisabledGateway = await hre.ethers.provider.call({
    to: gatewayAddress,
    data: hre.ethers.utils.id("DISABLED_GATEWAY()").slice(0, 10),
  })

  if (encodedDisabledGateway.toLowerCase() === disabledGateway) {
    return true
  }

  const message =
    `${gatewayName} is not upgraded with disabled gateway support; ` +
    `skipping ${destinationName} gateway block. Upgrade the gateway ` +
    "implementation, then rerun this deployment."

  if (process.env.REQUIRE_DISABLED_GATEWAY_SUPPORT === "true") {
    throw new Error(message)
  }

  hre.deployments.log(message)
  return false
}

export default func

func.tags = ["BlockBaseGatewayAddress"]
func.dependencies = ["PolygonWormholeGateway"]
