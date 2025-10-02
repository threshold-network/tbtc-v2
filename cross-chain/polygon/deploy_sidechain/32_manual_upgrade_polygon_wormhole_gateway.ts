import type { Artifact, HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, Deployment } from "hardhat-deploy/types"
import { ContractFactory } from "ethers"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments } = hre

  const { deployer } = await helpers.signers.getNamedSigners()

  const proxyDeployment: Deployment = await deployments.get(
    "PolygonWormholeGateway"
  )
  const implementationContractFactory: ContractFactory =
    await ethers.getContractFactory("L2WormholeGateway", {
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
    hre.artifacts.readArtifactSync("L2WormholeGateway")

  await deployments.save("PolygonWormholeGateway", {
    ...proxyDeployment,
    abi: gatewayArtifact.abi,
    implementation: newImplementationAddress,
  })

  // Contracts can be verified on L2 Polygonscan in a similar way as we do it on
  // L1 Etherscan
  if (hre.network.tags.polygonscan) {
    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to verify the proxy’s implementation
    // contract, the proxy itself and any proxy-related contracts, as well as
    // link the proxy to the implementation contract’s ABI on (Ether)scan.
    await hre.run("verify", {
      address: newImplementationAddress,
      constructorArgsParams: proxyDeployment.args,
    })
  }
}

export default func

func.tags = ["ManualUpgradePolygonWormholeGateway"]

// Comment this line when running an upgrade.
// yarn deploy --tags ManualUpgradePolygonWormholeGateway --network <network>
func.skip = async () => true
