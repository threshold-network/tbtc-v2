/* eslint-disable no-console */

import type { HardhatRuntimeEnvironment } from "hardhat/types"

// eslint-disable-next-line import/no-extraneous-dependencies
import { syncBridgeControllerAuthorizations } from "../deploy/utils/bridge-controller-authorization"

/**
 * Controller configuration script
 *
 * Ensures the Bridge controller pointer matches the desired controller
 * contract (typically MintBurnGuard) from the environment configuration.
 *
 * Usage (examples):
 *   npx hardhat run scripts/configure-bridge-controllers.ts --network sepolia \
 *     --show-stack-traces
 *
 * Environment variables:
 *   BRIDGE_ADDRESS                  - optional, Bridge proxy address; falls
 *                                     back to deployments cache when omitted
 *   BRIDGE_GOVERNANCE_PK            - optional, private key for governance
 *                                     signer; falls back to named `governance`
 *                                     account when omitted
 *   BRIDGE_CONTROLLER_ADDRESS        - controller contract address to set on
 *                                     the Bridge (e.g., MintBurnGuard)
 *   BRIDGE_CONTROLLER_SYNC_DRY_RUN  - when set to \"true\" or \"1\", computes
 *                                     and logs the plan without sending txs
 */

async function main(): Promise<void> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const hre = require("hardhat") as HardhatRuntimeEnvironment

  console.log("\n🔧 Synchronizing Bridge controller configuration…")

  await syncBridgeControllerAuthorizations(hre, {
    bridgeAddress: process.env.BRIDGE_ADDRESS,
    controllerAddress: process.env.BRIDGE_CONTROLLER_ADDRESS,
    governancePrivateKey: process.env.BRIDGE_GOVERNANCE_PK,
    dryRun:
      process.env.BRIDGE_CONTROLLER_SYNC_DRY_RUN === "true" ||
      process.env.BRIDGE_CONTROLLER_SYNC_DRY_RUN === "1",
  })

  console.log("\n✅ Controller configuration synchronization complete.")
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Controller allowlist synchronization failed:", error)
    process.exit(1)
  })
