import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre
  const { execute } = deployments
  const { governance } = await getNamedAccounts()

  const FrostWalletRegistry = await deployments.get("FrostWalletRegistry")
  const reimbursementPool = await ethers.getContractAt(
    "ReimbursementPool",
    (
      await deployments.get("ReimbursementPool")
    ).address
  )

  if (await reimbursementPool.isAuthorized(FrostWalletRegistry.address)) {
    console.log(
      `FrostWalletRegistry ${FrostWalletRegistry.address} is already authorized in ReimbursementPool`
    )
    // Still emit the calldata so the operator has a script-ready artifact
    // for mainnet, mirroring the sibling frost scripts (44/45/48/49/53).
    const existingAuthCalldata =
      reimbursementPool.interface.encodeFunctionData("authorize", [
        FrostWalletRegistry.address,
      ])
    console.log(
      "ReimbursementPool.authorize() calldata (idempotent, for reference):\n" +
        `  target: ${reimbursementPool.address}\n` +
        `  data:   ${existingAuthCalldata}`
    )
    return
  }

  // Emit the exact calldata the operator needs regardless of which branch
  // runs (mainnet skip, non-mainnet execute). On non-mainnet this is
  // redundant with the `execute(...)` below; on mainnet it is the only
  // scripted artifact the Threshold Council / DAO can execute by hand.
  const authorizeCalldata = reimbursementPool.interface.encodeFunctionData(
    "authorize",
    [FrostWalletRegistry.address]
  )
  console.log(
    "ReimbursementPool.authorize() calldata for manual governance execution:\n" +
      `  target: ${reimbursementPool.address}\n` +
      `  data:   ${authorizeCalldata}`
  )

  // On mainnet, the ReimbursementPool ownership has been handed off to
  // the Threshold Council / DAO and that address is not controlled by the
  // dev team. The calldata printed above is the audit-ready handoff
  // artifact; skip the in-process send.
  if (hre.network.name === "mainnet") {
    return
  }

  await execute(
    "ReimbursementPool",
    { from: governance, log: true, waitConfirmations: 1 },
    "authorize",
    FrostWalletRegistry.address
  )
}

export default func

func.tags = ["AuthorizeFrostWalletRegistryInReimbursementPool"]
func.dependencies = ["ReimbursementPool", "FrostWalletRegistry"]