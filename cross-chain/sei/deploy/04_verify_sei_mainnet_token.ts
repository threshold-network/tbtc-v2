import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { verifyDeployment } from "../scripts/verify-deployment"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // Only verify on Sei Pacific-1
  if (hre.network.name !== "pacific-1") {
    console.log(
      `⏭️  Skipping Sei Pacific-1 verification on ${hre.network.name}`
    )
    return
  }

  console.log("🔍 Verifying L2TBTC on Sei Pacific-1...")

  // Get proxy address from environment variable - required for verification
  const proxyAddress = process.env.PROXY_ADDRESS

  if (!proxyAddress) {
    throw new Error(
      "Please provide PROXY_ADDRESS environment variable for Sei Pacific-1 verification"
    )
  }

  console.log(`📋 Verifying proxy: ${proxyAddress}`)

  try {
    const result = await verifyDeployment(hre, proxyAddress)

    console.log("\n📋 Sei Pacific-1 Verification Summary:")
    console.log(`   Network: ${result.network}`)
    console.log(`   Proxy: ${result.proxy}`)
    console.log(`   Owner: ${result.owner}`)
    console.log(`   Is Minter: ${result.isMinter}`)
    console.log(`   Total Supply: ${result.totalSupply}`)
    console.log(`   Status: ${result.success ? "✅ Success" : "❌ Failed"}`)

    return result
  } catch (error: any) {
    console.error("❌ Sei Pacific-1 verification failed:", error.message)
    throw error
  }
}

export default func

func.tags = ["VerifySeiMainnetToken", "Verify"]
func.dependencies = ["SeiMainnetToken"] // Run after deployment
