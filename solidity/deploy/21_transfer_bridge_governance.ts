import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { ethers } from "hardhat"

import { transferBridgeGovernanceWithDelay } from "./utils/governance-transfer"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre

  // This script is intended for live networks (e.g. Sepolia/mainnet). For the
  // in-process Hardhat network used in tests we skip to avoid unnecessary
  // governance transfer attempts against ephemeral fixtures.
  if (hre.network.name === "hardhat") {
    deployments.log(
      "Skipping Bridge governance transfer on hardhat network (tests use their own fixture wiring)."
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

  await transferBridgeGovernanceWithDelay(
    bridgeGovernance,
    newGovernance,
    deployments.log
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
