import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership(
    "PolygonWormholeGateway",
    governance,
    deployer
  )
}

export default func

func.tags = ["TransferPolygonWormholeGatewayOwnership"]
// The zero minting limit is applied while the deployer still owns the gateway.
func.dependencies = [
  "PolygonWormholeGateway",
  "DeprecatePolygonWormholeGateway",
]
func.runAtTheEnd = true
