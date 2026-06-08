import type { Artifact, HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, Deployment } from "hardhat-deploy/types"
import { ContractFactory, providers } from "ethers"

const CONTRACT_NAME = "StarkNetBitcoinDepositor"
const DEPLOYMENT_NAME = "StarkNetBitcoinDepositor"

// Flip to `true` once the best-effort-reimbursement upgrade has been broadcast
// on mainnet. Combined with the mainnet-only network guard below, this prevents
// a second mainnet run from deploying a fresh (and unused) implementation and
// overwriting the deployment artifact with an address that no longer matches
// the on-chain implementation.
const ALREADY_EXECUTED = false

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, upgrades, artifacts, run } = hre

  // Patch ethers.js v5 Formatter to handle empty-string `to` field returned by
  // some RPC providers for contract-creation transactions. Without this patch,
  // `prepareUpgrade` fails with "invalid address" after the implementation is
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

  // Deploy new implementation contract. The StarkNet depositor links an
  // external library, and the unchanged `DepositState` enum cannot be
  // auto-compared against the recorded baseline ("insufficient data to compare
  // enums"). Both relaxations keep the rest of the storage-safety check active.
  const newImplementationAddress: string = (await upgrades.prepareUpgrade(
    proxyDeployment,
    implementationContractFactory,
    {
      kind: "transparent",
      unsafeAllow: ["external-library-linking"],
      unsafeAllowCustomTypes: true,
    }
  )) as string

  deployments.log(
    `new implementation contract deployed at: ${newImplementationAddress}`
  )

  // Assemble proxy upgrade transaction.
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

  // Update Deployment Artifact
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

func.tags = ["UpgradeStarkNetBitcoinDepositorTo968"]

// Implementation-swap tooling for the live mainnet StarkNet proxy. Guarded on
// two axes: only mainnet (never auto-runs against sepolia/hardhat during a
// full deploy, where StarkNet's hardhat.config.ts wires `deploy_l1` for every
// network) AND a post-execution sentinel (ALREADY_EXECUTED above), so a re-run
// on mainnet after governance has upgraded does not deploy a fresh
// implementation and overwrite the deployment artifact. Run via
// `yarn deploy --tags UpgradeStarkNetBitcoinDepositorTo968 --network mainnet`.
func.skip = async (hre: HardhatRuntimeEnvironment) =>
  hre.network.name !== "mainnet" || ALREADY_EXECUTED
