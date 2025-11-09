import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { ethers } from "hardhat"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre
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

  const governanceDelay = await bridgeGovernance.governanceDelays(0)
  const changeInitiated =
    await bridgeGovernance.bridgeGovernanceTransferChangeInitiated()

  if (changeInitiated.eq(0)) {
    const beginTx = await bridgeGovernance.beginBridgeGovernanceTransfer(
      newGovernance
    )
    deployments.log(
      `Initiated bridge governance transfer (tx: ${beginTx.hash}), waiting for delay…`
    )
    await beginTx.wait(1)
  } else {
    deployments.log("Bridge governance transfer already initiated; skipping.")
  }

  const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp
  const initiatedAt =
    await bridgeGovernance.bridgeGovernanceTransferChangeInitiated()
  const earliestFinalize = initiatedAt.add(governanceDelay)
  if (currentTimestamp < earliestFinalize.toNumber()) {
    const waitSeconds = earliestFinalize.toNumber() - currentTimestamp + 5
    deployments.log(
      `Waiting ${waitSeconds} seconds for governance delay to elapse…`
    )
    await delay(waitSeconds * 1000)
  }

  const finalizeTx = await bridgeGovernance.finalizeBridgeGovernanceTransfer()
  deployments.log(
    `Finalized bridge governance transfer in tx: ${finalizeTx.hash}`
  )
  await finalizeTx.wait(1)
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
