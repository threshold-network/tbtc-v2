import type { Artifact, HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, Deployment } from "hardhat-deploy/types"
import { ContractFactory } from "ethers"

const CONTRACT_NAME = "L1BitcoinDepositor"
const DEPLOYMENT_NAME = "ArbitrumOneL1BitcoinDepositor"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments } = hre

  const { deployer } = await helpers.signers.getNamedSigners()

  const proxyDeployment: Deployment = await deployments.get(DEPLOYMENT_NAME)

  const implementationContractFactory: ContractFactory =
    await ethers.getContractFactory(CONTRACT_NAME, {
      signer: deployer,
    })

  // Deploy new implementation contract
  const newImplementationAddress: string = (await hre.upgrades.prepareUpgrade(
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
  const proxyAdmin = await hre.upgrades.admin.getInstance()
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
  const gatewayArtifact: Artifact =
    hre.artifacts.readArtifactSync(CONTRACT_NAME)

  await deployments.save(DEPLOYMENT_NAME, {
    ...proxyDeployment,
    abi: gatewayArtifact.abi,
    implementation: newImplementationAddress,
  })

  await hre.run("verify", {
    address: newImplementationAddress,
    constructorArgsParams: proxyDeployment.args,
  })
}

export default func

func.tags = ["ManualUpgradeArbitrumL1BitcoinDepositor"]

// Comment this line when running an upgrade.
// yarn deploy --tags ManualUpgradeArbitrumL1BitcoinDepositor --network <network>
func.skip = async () => false
