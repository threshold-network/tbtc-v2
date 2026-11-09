import * as fs from "fs"
import * as path from "path"

import type { Artifact, HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, Deployment } from "hardhat-deploy/types"
import { ContractFactory, providers } from "ethers"

const CONTRACT_NAME = "BTCDepositorWormhole"
const DEPLOYMENT_NAME = "SuiBTCDepositorWormhole"

// Flip to `true` once the best-effort-reimbursement upgrade has been broadcast
// on mainnet. Combined with the mainnet-only network guard below, this prevents
// a second mainnet run from deploying a fresh (and unused) implementation and
// overwriting the deployment artifact with an address that no longer matches
// the on-chain implementation.
const ALREADY_EXECUTED = false

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, upgrades, artifacts, run } = hre

  // Patch ethers.js v5 Formatter to tolerate the empty-string `to` field some
  // RPC providers return for contract-creation receipts; without it
  // `prepareUpgrade` throws "invalid address" after the implementation is
  // already deployed on-chain.
  const originalFormat = providers.Formatter.prototype.transactionResponse
  providers.Formatter.prototype.transactionResponse = function (tx: any): any {
    const patched = tx.to === "" ? { ...tx, to: null } : tx
    return originalFormat.call(this, patched)
  }

  const { deployer } = await helpers.signers.getNamedSigners()

  const proxyDeployment: Deployment = await deployments.get(DEPLOYMENT_NAME)

  const implementationContractFactory: ContractFactory =
    await ethers.getContractFactory(CONTRACT_NAME, {
      signer: deployer,
    })

  // Deploy the new best-effort-reimbursement implementation. Sui consumes the
  // shared `BTCDepositorWormhole` staged from the solidity package's #968 build
  // (see copyBTCDepositorWormholeArtifact in hardhat.config.ts), so
  // `prepareUpgrade` deploys fresh bytecode distinct from the current on-chain
  // implementation.
  //
  // `unsafeAllowCustomTypes` relaxes ONLY the enum/struct comparison: the
  // `DepositState` enum is unchanged, but OpenZeppelin cannot auto-compare
  // custom types against the recorded baseline ("insufficient data to compare
  // enums"); the rest of the storage-safety check stays active, and the fork
  // regression test asserts the post-gap storage fields are byte-identical.
  const newImplementationAddress: string = (await upgrades.prepareUpgrade(
    proxyDeployment,
    implementationContractFactory,
    {
      kind: "transparent",
      unsafeAllowCustomTypes: true,
    }
  )) as string

  deployments.log(
    `new implementation contract deployed at: ${newImplementationAddress}`
  )

  // Assemble the proxy upgrade transaction for the owner (a single-key EOA on
  // mainnet, managed by the Sui integration team) to execute. This script does
  // NOT broadcast the upgrade.
  const proxyAdmin = await upgrades.admin.getInstance()
  const proxyAdminOwner = await proxyAdmin.owner()

  const upgradeTxData = await proxyAdmin.interface.encodeFunctionData(
    "upgrade",
    [proxyDeployment.address, newImplementationAddress]
  )

  deployments.log(
    `proxy admin owner ${proxyAdminOwner} is required to upgrade proxy implementation with transaction:\n` +
      `\t\tfrom: ${proxyAdminOwner}\n` +
      `\t\tto: ${proxyAdmin.address}\n` +
      `\t\tdata: ${upgradeTxData}`
  )

  // Persist the governance calldata to a tracked JSON file alongside the
  // log. The log line is ephemeral (stdout-scraped); the JSON is the durable
  // hand-off artifact the Sui-integration team's EOA proposer can verify
  // against — and the file diff doubles as a code-review surface for the
  // upgrade proposal. Written outside `deployments/` because hardhat-deploy
  // treats that directory as its own deployment-artifact namespace.
  const calldataDir = path.join(hre.config.paths.root, "governance-calldata")
  fs.mkdirSync(calldataDir, { recursive: true })
  const calldataPath = path.join(calldataDir, `968-${DEPLOYMENT_NAME}.json`)
  const calldataPayload = {
    network: hre.network.name,
    contract: CONTRACT_NAME,
    proxy: proxyDeployment.address,
    newImpl: newImplementationAddress,
    proxyAdmin: proxyAdmin.address,
    proxyAdminOwner,
    upgradeTx: {
      from: proxyAdminOwner,
      to: proxyAdmin.address,
      data: upgradeTxData,
    },
  }
  fs.writeFileSync(
    calldataPath,
    `${JSON.stringify(calldataPayload, null, 2)}\n`
  )
  deployments.log(`governance calldata written to ${calldataPath}`)

  // Update the deployment artifact to reflect the new implementation + ABI.
  const contractArtifact: Artifact = artifacts.readArtifactSync(CONTRACT_NAME)

  await deployments.save(DEPLOYMENT_NAME, {
    ...proxyDeployment,
    abi: contractArtifact.abi,
    implementation: newImplementationAddress,
  })

  await run("verify", {
    address: newImplementationAddress,
    constructorArgsParams: [],
  })
}

export default func

func.tags = ["UpgradeSuiBTCDepositorWormholeTo968"]

// Implementation-swap tooling for the live mainnet Sui proxy. Guarded on two
// axes: only mainnet (never auto-runs against sepolia/hardhat during a full
// deploy) AND a post-execution sentinel (ALREADY_EXECUTED above), so a re-run
// on mainnet after governance has upgraded does not deploy a fresh
// implementation and overwrite the deployment artifact. Run via
// `yarn deploy --tags UpgradeSuiBTCDepositorWormholeTo968 --network mainnet`.
func.skip = async (hre: HardhatRuntimeEnvironment) =>
  hre.network.name !== "mainnet" || ALREADY_EXECUTED
