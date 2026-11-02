/* eslint-disable no-console -- this script's output is the 3a deployment record and the follow-up list */

/**
 * Release step 3a: deploy the M1 `WalletProposalValidator`.
 *
 * `deploy/39_deploy_wallet_proposal_validator.ts` remains the definition of the
 * contract and its constructor argument. This script is the *operator path* to
 * it, because the hardhat-deploy tag path is not safe on mainnet: `hardhat
 * deploy --tags WalletProposalValidator` resolves the `Bridge` dependency and
 * re-runs the whole deployment graph in front of it. On a mainnet fork of
 * block 26320694 that path starts redeploying `Bank`, `LightRelay` and the
 * libraries and would end by deploying a new Bridge proxy with new storage.
 * Measured, not assumed: run it against a fork before trusting a tag-based
 * invocation.
 *
 * What this script does:
 *   1. preflight: `mainnet`, chain id 1, the Bridge deployment record, code at
 *      the Bridge address, and the Bridge runtime carrying
 *      `isReservedDeposit(uint256)`;
 *   2. refuse to proceed if the current `WalletProposalValidator` record
 *      already resolves to a reservations build (nothing to do);
 *   3. archive the current record as `WalletProposalValidator.pre-m1.json` so
 *      the pre-M1 address survives the overwrite;
 *   4. deploy `WalletProposalValidator(Bridge)` through hardhat-deploy, which
 *      writes `deployments/mainnet/WalletProposalValidator.json` - the record
 *      the published npm package and, through it, the keep-core release take
 *      the client's validator address from;
 *   5. verify the on-chain runtime against the 3a discriminators.
 *
 * The deploy is inert: the validator holds no state and the client picks it up
 * only in the release that names the new address. The client cut-over must NOT
 * precede the Bridge upgrade - with a pre-reservation Bridge the guard's
 * `isReservedDeposit` call reverts and every deposit-sweep proposal fails.
 *
 * Follow-ups printed by this script, in order:
 *   - publish `@keep-network/tbtc-v2` so its `deployments/mainnet/
 *     WalletProposalValidator.json` carries the new address,
 *   - in keep-core run `make` in `pkg/chain/ethereum/tbtc/gen` with
 *     `environment=mainnet` (it extracts `_address/WalletProposalValidator`
 *     from that artifact) and build the release binary,
 *   - run `scripts/check-reservation-activation-gate.ts` with the release's
 *     activation block before the ceremony.
 */

import fs from "fs"
import path from "path"
import hardhatRuntime from "hardhat"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import {
  assertNotFixtureMode,
  bridgeAnswersIsReservedDeposit,
  validatorRuntimeChecks,
} from "./validator-runtime-guard"

export interface DeployOptions {
  /** Proceed while the Bridge still lacks the reservation surface. */
  allowPreUpgradeBridge?: boolean
  /** Submit an Etherscan verification request for the new validator. */
  verify?: boolean
}

export interface DeployResult {
  address: string
  deploymentFile: string
  archivedRecord?: string
  alreadyDeployed: boolean
}

function fail(message: string): never {
  throw new Error(message)
}

/**
 * Deploys the M1 validator and verifies its runtime. Returns the address and
 * the record path so the caller (and the rehearsal) can assert on them.
 */
export async function deployReservationValidator(
  hre: HardhatRuntimeEnvironment,
  options: DeployOptions = {}
): Promise<DeployResult> {
  // Before the first `get`: fixture mode resolves records to the fixture
  // directory, where a missing record is not an error.
  assertNotFixtureMode()

  const { deployments, ethers, getNamedAccounts, network } = hre
  const { deploy, get, getOrNull, read } = deployments
  const { deployer } = await getNamedAccounts()

  if (network.name !== "mainnet") {
    fail(
      `this script deploys the mainnet validator record; network is ${network.name}`
    )
  }
  const chainId = Number((await ethers.provider.getNetwork()).chainId)
  if (chainId !== 1) {
    fail(`expected chain id 1 (mainnet), got ${chainId}`)
  }

  const bridgeDeployment = await get("Bridge")
  const bridgeCode = await ethers.provider.getCode(bridgeDeployment.address)
  if (bridgeCode === "0x") {
    fail(`no code at the Bridge address ${bridgeDeployment.address}`)
  }
  const bridgeProbe = await bridgeAnswersIsReservedDeposit(
    ethers.provider,
    bridgeDeployment.address
  )
  if (!bridgeProbe.ok && !options.allowPreUpgradeBridge) {
    fail(
      `the Bridge at ${bridgeDeployment.address} does not answer ` +
        `isReservedDeposit (${bridgeProbe.detail}). The ` +
        "validator's reserved-deposit rule calls that function for every " +
        "deposit in a proposal, so a client pointed at this validator now " +
        "would fail every sweep validation. Deploy after the Bridge upgrade, " +
        "or pass PRE_UPGRADE=1 to deploy the (inert) contract early."
    )
  }

  const existing = await getOrNull("WalletProposalValidator")
  if (existing) {
    const existingCode = await ethers.provider.getCode(existing.address)
    const alreadyReservationsBuild = validatorRuntimeChecks(existingCode).every(
      (check) => check.ok
    )
    if (alreadyReservationsBuild) {
      console.log(
        `WalletProposalValidator at ${existing.address} already carries the ` +
          "reservation surface; nothing to deploy."
      )
      return {
        address: existing.address,
        deploymentFile: "deployments/mainnet/WalletProposalValidator.json",
        alreadyDeployed: true,
      }
    }
  }

  let archivedRecord: string | undefined
  if (existing) {
    const deploymentDir = path.join(
      hre.config.paths.deployments,
      deployments.getNetworkName()
    )
    const currentFile = path.join(deploymentDir, "WalletProposalValidator.json")
    archivedRecord = path.join(
      deploymentDir,
      "WalletProposalValidator.pre-m1.json"
    )
    fs.copyFileSync(currentFile, archivedRecord)
    console.log(
      `archived the pre-M1 record (${existing.address}) as ${path.basename(
        archivedRecord
      )}`
    )
  }

  const deployed = await deploy("WalletProposalValidator", {
    from: deployer,
    args: [bridgeDeployment.address],
    log: true,
    waitConfirmations: 1,
  })

  const code = await ethers.provider.getCode(deployed.address)
  if (code === "0x") {
    fail(`no code at the freshly deployed address ${deployed.address}`)
  }
  const checks = validatorRuntimeChecks(code)
  checks.forEach((check) =>
    console.log(
      `[${check.ok ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`
    )
  )
  if (checks.some((check) => !check.ok)) {
    fail(
      `the deployed runtime at ${deployed.address} does not carry the M1 ` +
        "validator surface; do not publish this address"
    )
  }

  if (options.verify) {
    await hre.run("verify:verify", {
      address: deployed.address,
      constructorArguments: [bridgeDeployment.address],
    })
  }

  const bridgeGovernedBy: string = await read("Bridge", "governance")
  console.log(`\nWalletProposalValidator deployed at ${deployed.address}`)
  console.log(`  constructor argument (Bridge): ${bridgeDeployment.address}`)
  console.log(`  Bridge governance:             ${bridgeGovernedBy}`)
  console.log("\nFollow-ups, in this order:")
  console.log(
    "  1. publish @keep-network/tbtc-v2 so deployments/mainnet/" +
      "WalletProposalValidator.json carries the new address"
  )
  console.log(
    "  2. keep-core: `make` in pkg/chain/ethereum/tbtc/gen with " +
      "environment=mainnet, then build the release binary"
  )
  console.log(
    "  3. scripts/check-reservation-activation-gate.ts with the release's " +
      "activation block, before the ceremony runs setVaultStatus"
  )

  return {
    address: deployed.address,
    deploymentFile: "deployments/mainnet/WalletProposalValidator.json",
    archivedRecord,
    alreadyDeployed: false,
  }
}

async function main(): Promise<void> {
  const result = await deployReservationValidator(hardhatRuntime, {
    allowPreUpgradeBridge: process.env.PRE_UPGRADE === "1",
    verify: process.env.VERIFY === "1",
  })
  console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
