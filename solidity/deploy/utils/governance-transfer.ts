/* eslint-disable no-console */

import type { Contract, BigNumber } from "ethers"
import type { DeployFunction } from "hardhat-deploy/types"

export type GovernanceTransferMode = "full" | "begin" | "finalize"

export interface GovernanceTransferOptions {
  // Mode selection:
  // - "full": begin + wait for delay + finalize (default)
  // - "begin": only initiate transfer and log earliest finalization time
  // - "finalize": only attempt finalization (no waiting), assuming begin was
  //               done previously and the governance delay has elapsed
  mode?: GovernanceTransferMode

  // Extra buffer applied when waiting in "full" mode, in seconds.
  waitBufferSeconds?: number
}

/**
 * Begins and/or finalizes a Bridge governance transfer, respecting the
 * configured governance delay.
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
  log: (message: string) => void = console.log,
  options: GovernanceTransferOptions = {}
): Promise<void> {
  const mode: GovernanceTransferMode = options.mode ?? "full"
  const waitBufferSeconds = options.waitBufferSeconds ?? 5

  if (
    !newGovernance ||
    newGovernance === "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error("New governance address must be non-zero")
  }

  const delay: BigNumber = await bridgeGovernance.governanceDelays(0)
  let changeInitiated: BigNumber =
    await bridgeGovernance.bridgeGovernanceTransferChangeInitiated()

  if (mode !== "finalize" && changeInitiated.eq(0)) {
    const beginTx = await bridgeGovernance.beginBridgeGovernanceTransfer(
      newGovernance
    )
    log(`Initiated bridge governance transfer (tx: ${beginTx.hash}).`)
    await beginTx.wait(1)

    changeInitiated =
      await bridgeGovernance.bridgeGovernanceTransferChangeInitiated()
  } else if (mode !== "finalize") {
    log("Bridge governance transfer already initiated; skipping begin.")
  }

  const earliestFinalization = changeInitiated.add(delay)

  log(
    `Bridge governance transfer mode=${mode}, delay=${delay.toString()} seconds, ` +
      `changeInitiated=${changeInitiated.toString()}, earliestFinalization=${earliestFinalization.toString()}`
  )

  if (mode === "begin") {
    log(
      `Bridge governance transfer initiated. Earliest finalization timestamp (unix): ${earliestFinalization.toString()}`
    )
    return
  }

  if (changeInitiated.eq(0)) {
    log(
      "Bridge governance transfer has not been initiated yet; cannot finalize."
    )
    return
  }

  if (mode === "full") {
    const block = await bridgeGovernance.provider.getBlock("latest")
    if (block.timestamp < earliestFinalization.toNumber()) {
      // Add a small buffer to avoid edge cases where the block timestamp is
      // exactly equal to the finalization time.
      const waitSeconds =
        earliestFinalization.toNumber() - block.timestamp + waitBufferSeconds
      log(
        `Waiting ${waitSeconds} seconds for governance delay to elapse (currentTime=${block.timestamp}, ` +
          `earliestFinalization=${earliestFinalization.toNumber()})…`
      )
      await delayMs(waitSeconds * 1000)
    }
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
