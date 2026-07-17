import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import "@nomiclabs/hardhat-ethers"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { get } = deployments
  const { deployer } = await getNamedAccounts()

  // Get the existing proxy deployment
  const proxyDeployment = await get("OptimismMintableUpgradableERC20_Proxy")
  console.log("Existing proxy address:", proxyDeployment.address)

  // Get the new implementation deployment
  const newImplementation = await get("OptimismMintableUpgradableTBTC")
  console.log("New implementation address:", newImplementation.address)

  // @ts-ignore - ethers is added by hardhat-ethers plugin
  const { ethers } = hre

  // Get the proxy contract as TransparentUpgradeableProxy
  const proxy = await ethers.getContractAt(
    "ITransparentUpgradeableProxy",
    proxyDeployment.address,
    await ethers.getSigner(deployer)
  )

  // Get the new implementation contract factory to encode initializeV2
  const OptimismMintableUpgradableTBTC = await ethers.getContractFactory(
    "OptimismMintableUpgradableTBTC",
    await ethers.getSigner(deployer)
  )

  // Encode initializeV2 function call
  const initializeV2Data =
    OptimismMintableUpgradableTBTC.interface.encodeFunctionData(
      "initializeV2",
      [] // initializeV2 takes no parameters
    )

  console.log("\nPerforming upgrade...")

  // Perform upgrade and call initializeV2 in one transaction
  const tx = await proxy.upgradeToAndCall(
    newImplementation.address,
    initializeV2Data
  )

  console.log("Upgrade transaction sent:", tx.hash)
  const receipt = await tx.wait()
  console.log("Upgrade completed in block:", receipt.blockNumber)

  console.log("\n========================================")
  console.log("UPGRADE COMPLETED SUCCESSFULLY!")
  console.log("========================================")
  console.log("Proxy address:", proxyDeployment.address)
  console.log("New implementation:", newImplementation.address)
  console.log("========================================\n")

  // NOTE: Cannot verify state from deployer address as it's the proxy admin
  // To verify the upgrade worked:
  // 1. Check the proxy from a different address (not the admin)
  // 2. Check on block explorer that the implementation slot was updated
  // 3. Call functions like owner(), paused(), getLegacyCapRemaining() from a non-admin address

  console.log("State verification must be done from a non-admin address")
  console.log(
    "The proxy admin cannot call implementation functions due to security restrictions"
  )

  // If on a network with etherscan verification
  if (hre.network.tags?.bobscan) {
    console.log("Waiting for confirmations before verification...")
    await tx.wait(5) // Wait for 5 confirmations

    // The proxy contract should already be verified, but we can verify that it's properly linked
    console.log(
      "Proxy should now be linked to the new implementation on Bobscan"
    )
  }
}

export default func

func.tags = ["UpgradeOptimismMintableUpgradableERC20"]
func.dependencies = [
  "OptimismMintableUpgradableERC20",
  "OptimismMintableUpgradableTBTC",
]
