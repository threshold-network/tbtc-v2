import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { syncBridgeControllerAuthorizations } from "./utils/bridge-controller-authorization"

const func: DeployFunction = async function authorizeMintBurnGuardInBridge(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts } = hre
  const { log } = deployments

  const MintBurnGuard = await deployments.get("MintBurnGuard")

  log("authorizing MintBurnGuard as Bridge minting controller...")

  // For the hardhat network, use deployer to call Bridge directly
  // (governance hasn't been fully transferred yet in test environment)
  if (hre.network.name === "hardhat") {
    const { deployer } = await getNamedAccounts()

    await deployments.execute(
      "Bridge",
      { from: deployer, log: true, waitConfirmations: 1 },
      "setMintingController",
      MintBurnGuard.address
    )
  } else {
    // For other networks, use the bridge-controller-authorization utility
    // which goes through BridgeGovernance
    await syncBridgeControllerAuthorizations(hre, {
      controllerAddress: MintBurnGuard.address,
    })
  }
}

export default func

func.tags = ["AuthorizeMintBurnGuardInBridge"]
func.dependencies = [
  "ConfigureMintBurnGuard",
  "Bridge",
  "BridgeGovernance",
  "TransferBridgeGovernance",
  "MintBurnGuard",
]
