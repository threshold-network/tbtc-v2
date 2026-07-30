import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import {
  abortLiveBridgeUpgradeWithoutVettedCompleteV2,
  isEphemeralLocalNetwork,
} from "./45_deploy_p2tr_signature_fraud_router"

/// @notice Write-free guard placed first in every FROST deployment dependency
///         chain. Live/custom networks fail before FROST dependencies deploy.
const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  if (isEphemeralLocalNetwork(hre.network.name)) {
    return
  }

  await abortLiveBridgeUpgradeWithoutVettedCompleteV2(
    hre,
    "47_assert_frost_custody_no_go"
  )
}

export default func

func.tags = ["FrostCustodyNoGo"]
