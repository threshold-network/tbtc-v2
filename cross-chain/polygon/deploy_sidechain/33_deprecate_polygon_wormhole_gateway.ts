import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { execute, read, log } = deployments
  const { deployer } = await getNamedAccounts()

  // Fresh deployments: the deployer still owns the gateway, so apply the
  // zero minting limit before ownership moves to governance. Live
  // deployments: governance executes the call instead (see
  // 34_manual_deprecate_polygon_wormhole_gateway.ts and
  // governance/update-minting-limit-zero.safe-batch.json).
  const owner: string = await read("PolygonWormholeGateway", "owner")
  if (owner.toLowerCase() !== deployer.toLowerCase()) {
    log(
      `PolygonWormholeGateway is owned by ${owner}, not the deployer; ` +
        "governance must execute updateMintingLimit(0)"
    )
    return
  }

  await execute(
    "PolygonWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateMintingLimit",
    0
  )
}

export default func

func.tags = ["DeprecatePolygonWormholeGateway", "DeprecatePolygon"]
func.dependencies = ["PolygonWormholeGateway"]
