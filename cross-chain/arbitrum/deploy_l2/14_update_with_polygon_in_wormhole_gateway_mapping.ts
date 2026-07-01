import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

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

func.tags = ["BlockPolygonGatewayAddress"]
func.dependencies = ["ArbitrumWormholeGateway"]
