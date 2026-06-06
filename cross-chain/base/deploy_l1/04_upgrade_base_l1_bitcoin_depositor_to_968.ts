import type { Artifact, HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, Deployment } from "hardhat-deploy/types"
import { ContractFactory, providers } from "ethers"

const CONTRACT_NAME = "L1BTCDepositorWormholeV2Base"
const DEPLOYMENT_NAME = "BaseL1BitcoinDepositor"

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

  // Deploy the new best-effort-reimbursement implementation. The Base variant
  // carries a deliberate +1 storage-slot offset from slot 200 (tbtcToken at
  // slot 201, not 200) versus the Arbitrum variant; it MUST be compiled from
  // the L1BTCDepositorWormholeV2Base source and is NOT interchangeable with the
  // Arbitrum variant.
  // `unsafeAllowCustomTypes` relaxes ONLY the custom-type (enum/struct)
  // comparison. The `deposits` mapping's `DepositState` enum is unchanged by the
  // best-effort change, but OpenZeppelin cannot auto-compare it against the
  // recorded baseline layout ("insufficient data to compare enums"); the rest of
  // the storage-safety check stays active, and the fork regression test asserts
  // the post-gap storage fields are byte-identical across the swap.
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

  // Assemble the proxy upgrade transaction for the owner (the 24h timelock that
  // also controls Arbitrum) to execute. This script does NOT broadcast the
  // upgrade.
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

func.tags = ["UpgradeBaseL1BitcoinDepositorTo968"]

// Set to `true` once the best-effort-reimbursement upgrade has been executed on
// mainnet. Until then the script is runnable via
// `yarn deploy --tags UpgradeBaseL1BitcoinDepositorTo968 --network mainnet`.
func.skip = async () => false
