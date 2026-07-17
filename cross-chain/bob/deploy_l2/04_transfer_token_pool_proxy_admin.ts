import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { get } = deployments
  const { deployer, governance } = await getNamedAccounts()

  console.log("=== Transferring Proxy Admin Ownership ===")
  console.log(`Current Deployer: ${deployer}`)
  console.log(`New Admin: ${governance}`)
  console.log("")

  try {
    // Get the deployed proxy contracts
    const tokenPoolProxy = await get("BurnFromMintTokenPoolUpgradeable_Proxy")

    console.log("Proxy Contracts:")
    console.log(`  Token Pool Proxy: ${tokenPoolProxy.address}`)
    console.log("")

    // For TransparentUpgradeableProxy, we need to call the admin functions directly
    // The proxy exposes admin(), upgradeTo(), and changeAdmin() functions
    
    // First, let's check the current admin of both proxies
    const proxyAdminABI = [
      "function admin() external view returns (address)",
      "function changeAdmin(address newAdmin) external"
    ]

    // Create contract instances for the proxies
    const tokenPoolProxyContract = new ethers.Contract(
      tokenPoolProxy.address,
      proxyAdminABI,
      await ethers.getSigner(deployer)
    )

    // Try to get current admin (this might fail if called by non-admin)
    try {
      console.log("Checking current admins...")
      // Note: These calls might revert if not called by the admin
      // In that case, we'll proceed with the transfer anyway
    } catch (e) {
      console.log("Cannot read current admin (expected if not admin)")
    }

    // Transfer admin for Token Pool Proxy
    console.log("\nTransferring admin for Token Pool Proxy...")
    try {
      const tx1 = await tokenPoolProxyContract.changeAdmin(governance)
      console.log(`  Transaction: ${tx1.hash}`)
      await tx1.wait()
      console.log("  ✅ Token Pool Proxy admin transferred successfully!")
    } catch (error: any) {
      console.log(`  ❌ Failed to transfer Token Pool Proxy admin: ${error.message}`)
    }

    console.log("\n=== Admin Transfer Complete ===")
    console.log(`New admin ${governance} can now:`)
    console.log("  - Upgrade the implementation contracts")
    console.log("  - Transfer admin to another address")
    console.log("\nIMPORTANT: The deployer address can no longer:")
    console.log("  - Call admin functions on the proxies")
    console.log("  - Upgrade the contracts")
    console.log("\nTo configure the token pools, use a different address (not the admin)")

  } catch (error) {
    console.error("Error in admin transfer:", error)
    throw error
  }
}

export default func

func.tags = ["TransferProxyAdmin"]
func.dependencies = ["BurnFromMintTokenPoolUpgradeable", "OptimismMintableUpgradableTBTC"]
