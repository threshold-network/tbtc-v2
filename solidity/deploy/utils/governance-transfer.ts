/* eslint-disable no-console */

import type { Contract } from "ethers"
import type { BigNumber } from "ethers"
import type { DeployFunction } from "hardhat-deploy/types"

/**
 * Begins and finalizes a Bridge governance transfer, respecting the configured
 * governance delay and waiting long enough for finalization to succeed.
 *
 * The provided `bridgeGovernance` contract is expected to expose:
 * - function governanceDelays(uint256) view returns (uint256)
 * - function bridgeGovernanceTransferChangeInitiated() view returns (uint256)
 * - function beginBridgeGovernanceTransfer(address)
 * - function finalizeBridgeGovernanceTransfer()
 */
export async function transferBridgeGovernanceWithDelay(
  bridgeGovernance: Contract,
  newGovernance: string,
  log: (message: string) => void = console.log
): Promise<void> {
  const delay: BigNumber = await bridgeGovernance.governanceDelays(0)
  let changeInitiated: BigNumber =
    await bridgeGovernance.bridgeGovernanceTransferChangeInitiated()

  if (changeInitiated.eq(0)) {
    const beginTx = await bridgeGovernance.beginBridgeGovernanceTransfer(
      newGovernance
    )
    log(
      `Initiated bridge governance transfer (tx: ${beginTx.hash}), waiting for delay…`
    )
    await beginTx.wait(1)

    changeInitiated =
      await bridgeGovernance.bridgeGovernanceTransferChangeInitiated()
  } else {
    log("Bridge governance transfer already initiated; skipping begin.")
  }

  const earliestFinalization = changeInitiated.add(delay)
  const block = await bridgeGovernance.provider.getBlock("latest")
  if (block.timestamp < earliestFinalization.toNumber()) {
    // Add a small buffer to avoid edge cases where the block timestamp is
    // exactly equal to the finalization time.
    const waitSeconds = earliestFinalization.toNumber() - block.timestamp + 5
    log(`Waiting ${waitSeconds} seconds for governance delay to elapse…`)
    await delayMs(waitSeconds * 1000)
  }

  const finalizeTx = await bridgeGovernance.finalizeBridgeGovernanceTransfer()
  log(`Finalized bridge governance transfer in tx: ${finalizeTx.hash}`)
  await finalizeTx.wait(1)
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Expose a no-op deploy script so that hardhat-deploy can safely load this
// helper module under the `deploy/` tree without attempting to execute any
// on-chain actions.
const noopDeploy: DeployFunction = async () => {}
noopDeploy.skip = async () => true

export default noopDeploy
