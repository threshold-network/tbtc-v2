import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { verifyDeployment } from "../scripts/verify-deployment"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Only verify on Base Sepolia
  if (hre.network.name !== "baseSepolia") {
    console.log(`⏭️  Skipping Base Sepolia verification on ${hre.network.name}`)
    return
  }

  console.log("🔍 Verifying L2TBTC on Base Sepolia...")

  // Get proxy address from environment variable - required for Base Sepolia
  const proxyAddress = process.env.PROXY_ADDRESS

  if (!proxyAddress) {
    throw new Error(
      "Please provide PROXY_ADDRESS environment variable for Base Sepolia verification"
    )
  }

  console.log(`📋 Verifying proxy: ${proxyAddress}`)

  try {
    const result = await verifyDeployment(hre, proxyAddress)

    console.log("\n📋 Base Sepolia Verification Summary:")
    console.log(`   Network: ${result.network}`)
    console.log(`   Proxy: ${result.proxy}`)
    console.log(`   Owner: ${result.owner}`)
    console.log(`   Is Minter: ${result.isMinter}`)
    console.log(`   Total Supply: ${result.totalSupply}`)
    console.log(`   Status: ${result.success ? "✅ Success" : "❌ Failed"}`)

    return result
  } catch (error: any) {
    console.error("❌ Base Sepolia verification failed:", error.message)
    throw error
  }
}

export default func

func.tags = ["VerifyBaseSepoliaToken", "Verify"]
func.dependencies = ["BaseSepoliaToken"] // Run after deployment
