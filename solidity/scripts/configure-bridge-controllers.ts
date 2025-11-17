/* eslint-disable no-console */

import type { HardhatRuntimeEnvironment } from "hardhat/types"

// eslint-disable-next-line import/no-extraneous-dependencies
import { syncBridgeControllerAuthorizations } from "../deploy/utils/bridge-controller-authorization"

/**
 * Controller allowlist configuration script
 *
 * Keeps the Bridge controller allowlist (`authorizedBalanceIncreasers`) in
 * sync with environment configuration.
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
 *   BRIDGE_AUTHORIZED_INCREASERS    - comma-separated list of controller
 *                                     addresses to authorize
 *   BRIDGE_ALLOW_MASS_CONTROLLER_REVOKE=true
 *                                   - optional safeguard override; when set
 *                                     together with BRIDGE_ALLOW_MASS_CONTROLLER_REVOKE_CONFIRM=YES,
 *                                     an empty desired set will revoke all
 *                                     existing controller authorizations
 *   BRIDGE_ALLOW_MASS_CONTROLLER_REVOKE_CONFIRM=YES
 *                                   - explicit confirmation required to allow
 *                                     mass-revoking all existing controllers
 *   BRIDGE_CONTROLLER_SYNC_DRY_RUN  - when set to \"true\" or \"1\", computes
 *                                     and logs the plan without sending txs
 */

async function main(): Promise<void> {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const hre = require("hardhat") as HardhatRuntimeEnvironment

  console.log("\n🔧 Synchronizing Bridge controller allowlist…")

  await syncBridgeControllerAuthorizations(hre, {
    bridgeAddress: process.env.BRIDGE_ADDRESS,
    increaserAddresses: process.env.BRIDGE_AUTHORIZED_INCREASERS?.split(","),
    governancePrivateKey: process.env.BRIDGE_GOVERNANCE_PK,
    dryRun:
      process.env.BRIDGE_CONTROLLER_SYNC_DRY_RUN === "true" ||
      process.env.BRIDGE_CONTROLLER_SYNC_DRY_RUN === "1",
  })

  console.log("\n✅ Controller allowlist synchronization complete.")
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Controller allowlist synchronization failed:", error)
    process.exit(1)
  })
