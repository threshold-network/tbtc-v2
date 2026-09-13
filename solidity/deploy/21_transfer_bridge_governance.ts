import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre
  const { deployer } = await getNamedAccounts()

  const BridgeGovernance = await deployments.get("BridgeGovernance")

  await deployments.execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "transferGovernance",
    BridgeGovernance.address
  )
}

export default func

func.tags = ["TransferBridgeGovernance"]
func.dependencies = [
  "Bridge",
  "AuthorizeTBTCVault",
  "AuthorizeMaintainerProxyInBridge",
  "SetDepositParameters",
  "SetWalletParameters",
  "DisableFraudChallenges",
  "DisableRedemptions",
  "DisableMovingFunds",
  "AuthorizeSpvMaintainer",
]
func.runAtTheEnd = true
