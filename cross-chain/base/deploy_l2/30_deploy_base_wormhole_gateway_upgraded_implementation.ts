import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  // Get the current proxy deployment to ensure we have the same initialization parameters
  const proxyDeployment = await deployments.get("BaseWormholeGateway")

  // Deploy only the new implementation contract
  // This does NOT upgrade the proxy - that must be done manually
  const implementationDeployment = await deploy(
    "BaseWormholeGatewayUpgradedImplementation",
    {
      contract:
        "contracts/wormhole/BaseWormholeGatewayUpgraded.sol:BaseWormholeGatewayUpgraded",
      from: deployer,
      args: [], // Implementation contracts should not have constructor args
      log: true,
      waitConfirmations: 1,
    }
  )

  deployments.log(
    `BaseWormholeGatewayUpgraded implementation deployed at: ${implementationDeployment.address}`
  )

  // Get proxy admin for logging upgrade instructions
  const proxyAdmin = await hre.upgrades.admin.getInstance()
  const proxyAdminOwner = await proxyAdmin.owner()

  // Encode the upgrade transaction data
  const upgradeTxData = await proxyAdmin.interface.encodeFunctionData(
    "upgrade",
    [proxyDeployment.address, implementationDeployment.address]
  )

  deployments.log(
    `\n========================================\n` +
      `MANUAL UPGRADE REQUIRED\n` +
      `========================================\n` +
      `To upgrade the proxy to use the new implementation:\n\n` +
      `Proxy Admin Owner: ${proxyAdminOwner}\n` +
      `Proxy Admin Contract: ${proxyAdmin.address}\n` +
      `Current Proxy: ${proxyDeployment.address}\n` +
      `New Implementation: ${implementationDeployment.address}\n\n` +
      `Transaction details:\n` +
      `  From: ${proxyAdminOwner}\n` +
      `  To: ${proxyAdmin.address}\n` +
      `  Data: ${upgradeTxData}\n` +
      `========================================\n`
  )

  // Verify the implementation contract on Basescan if applicable
  if (hre.network.tags.basescan) {
    try {
      await hre.run("verify:verify", {
        address: implementationDeployment.address,
        constructorArguments: [],
      })
    } catch (error) {
      console.log("Verification failed:", error)
    }
  }
}

export default func

func.tags = ["BaseWormholeGatewayUpgradedImplementation"]
// No dependencies - we just read the existing proxy deployment

// To run this deployment:
// yarn deploy --tags BaseWormholeGatewayUpgradedImplementation --network base
