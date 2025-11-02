import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

import { syncBridgeControllerAuthorizations } from "./utils/bridge-controller-authorization"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await syncBridgeControllerAuthorizations(hre, {
    bridgeAddress: process.env.BRIDGE_ADDRESS,
    increaserAddresses: process.env.BRIDGE_AUTHORIZED_INCREASERS?.split(","),
    governancePrivateKey: process.env.BRIDGE_GOVERNANCE_PK,
  })
}

export default func

func.tags = ["ConfigureBridgeControllers"]
func.skip = async () => true
