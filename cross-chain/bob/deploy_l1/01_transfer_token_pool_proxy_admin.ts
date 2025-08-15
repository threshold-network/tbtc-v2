import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { get } = deployments
  const { deployer, governance } = await getNamedAccounts()

  console.log("=== Transferring Proxy Admin Ownership on L1 ===")
  console.log(`Network: ${hre.network.name}`)
  console.log(`Current Deployer: ${deployer}`)
  console.log(`New Admin: ${governance}`)
  console.log("")

  try {
    // Get the deployed proxy contract
    const tokenPoolProxy = await get("LockReleaseTokenPoolUpgradeable_Proxy")

    console.log("Proxy Contract:")
    console.log(`  LockReleaseTokenPoolUpgradeable Proxy: ${tokenPoolProxy.address}`)
    console.log("")

    // For TransparentUpgradeableProxy, we need to call the admin functions directly
    const proxyAdminABI = [
      "function admin() external view returns (address)",
      "function changeAdmin(address newAdmin) external"
    ]

    // Create contract instance for the proxy
    const tokenPoolProxyContract = new ethers.Contract(
      tokenPoolProxy.address,
      proxyAdminABI,
      await ethers.getSigner(deployer)
    )

    // Transfer admin for Token Pool Proxy
    console.log("Transferring admin for LockReleaseTokenPoolUpgradeable Proxy...")
    try {
      const tx = await tokenPoolProxyContract.changeAdmin(governance)
      console.log(`  Transaction: ${tx.hash}`)
      console.log("  Waiting for confirmation...")
      const receipt = await tx.wait()
      console.log(`  ✅ Admin transferred successfully in block ${receipt.blockNumber}!`)
    } catch (error: any) {
      if (error.message.includes("admin cannot fallback")) {
        console.log("  ❌ Error: You are not the current admin of this proxy")
        console.log("     The proxy admin may have already been transferred")
      } else {
        console.log(`  ❌ Failed to transfer admin: ${error.message}`)
      }
      throw error
    }

    console.log("\n=== Admin Transfer Complete ===")
    console.log(`New admin ${governance} can now:`)
    console.log("  - Upgrade the implementation contract")
    console.log("  - Transfer admin to another address")
    console.log("\nIMPORTANT: The deployer address can no longer:")
    console.log("  - Call admin functions on the proxy")
    console.log("  - Upgrade the contract")
    console.log("\nTo configure the token pool, use a different address (not the admin)")

  } catch (error) {
    console.error("\nError in admin transfer:", error)
    throw error
  }
}

export default func

func.tags = ["TransferProxyAdmin"]
func.dependencies = ["LockReleaseTokenPoolUpgradeable"]
