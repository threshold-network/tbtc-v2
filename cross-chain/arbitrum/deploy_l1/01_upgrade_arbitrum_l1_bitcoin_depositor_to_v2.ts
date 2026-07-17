import type { Artifact, HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, Deployment } from "hardhat-deploy/types"
import { ContractFactory, providers } from "ethers"

const CONTRACT_NAME = "L1BTCDepositorWormholeV2Arbitrum"
const DEPLOYMENT_NAME = "ArbitrumOneL1BitcoinDepositor"

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

  // Deploy new implementation contract
  const newImplementationAddress: string = (await upgrades.prepareUpgrade(
    proxyDeployment,
    implementationContractFactory,
    {
      kind: "transparent",
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

func.tags = ["UpgradeArbitrumL1BitcoinDepositorToV2"]

// Upgrade deployed on 2026-04-02. Implementation: 0x82FDDF79765Ed75325bCBdf65F67dF0879AAbe8C
func.skip = async () => true
