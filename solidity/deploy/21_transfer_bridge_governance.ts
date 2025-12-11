import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { ethers } from "hardhat"

import {
  transferBridgeGovernanceWithDelay,
  type GovernanceTransferMode,
} from "./utils/governance-transfer"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre

  // For the in-process Hardhat network used in tests we want to preserve the
  // original behaviour of this script and transfer governance immediately,
  // without waiting for any delay. Tests rely on `BridgeGovernance` being the
  // active governance contract for `Bridge`.
  if (hre.network.name === "hardhat") {
    const { deployer } = await getNamedAccounts()
    const BridgeGovernance = await deployments.get("BridgeGovernance")

    await deployments.execute(
      "Bridge",
      { from: deployer, log: true, waitConfirmations: 1 },
      "transferGovernance",
      BridgeGovernance.address
    )
    return
  }

  const { governance } = await getNamedAccounts()

  // Use the governance key or named governance account; do not fall back to
  // ProxyAdmin signer for governance actions.
  let signer: import("ethers").Signer
  const governancePk = process.env.BRIDGE_GOVERNANCE_PK
  if (governancePk) {
    signer = new ethers.Wallet(governancePk, ethers.provider)
  } else {
    signer = await ethers.getSigner(governance)
  }

  const bridgeDeployment = await deployments.get("Bridge")
  const bridge = await ethers.getContractAt(
    "Bridge",
    bridgeDeployment.address,
    signer
  )

  const currentGovernance = await bridge.governance()
  const newGovernanceDeployment = await deployments.get("BridgeGovernance")
  const newGovernance = newGovernanceDeployment.address

  if (currentGovernance.toLowerCase() === newGovernance.toLowerCase()) {
    deployments.log("Bridge governance already transferred; skipping.")
    return
  }

  const bridgeGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    currentGovernance,
    signer
  )

  if (
    bridgeGovernance.address.toLowerCase() !== currentGovernance.toLowerCase()
  ) {
    throw new Error(
      "Resolved BridgeGovernance address does not match Bridge.governance(); aborting transfer."
    )
  }

  const modeEnv = process.env.BRIDGE_GOVERNANCE_TRANSFER_MODE
  const mode: GovernanceTransferMode =
    modeEnv === "full" || modeEnv === "begin" || modeEnv === "finalize"
      ? modeEnv
      : "begin"

  await transferBridgeGovernanceWithDelay(
    bridgeGovernance,
    newGovernance,
    deployments.log,
    { mode }
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
