/* eslint-disable no-console */
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import fs from "fs"
import path from "path"
import os from "os"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy, log } = deployments
  const { deployer } = await getNamedAccounts()

  log("🚀 Starting isolated BridgeGovernance redeployment...")

  // CRITICAL: Ensure we use existing Bridge proxy address without redeployment
  const bridgeAddress = await resolveBridgeAddress(deployments)
  if (!bridgeAddress) {
    throw new Error(
      "Bridge address not found. Cannot deploy governance without existing Bridge proxy."
    )
  }

  log(`✅ Using existing Bridge proxy at: ${bridgeAddress}`)

  // Verify the Bridge is actually deployed
  const bridgeCode = await hre.ethers.provider.getCode(bridgeAddress)
  if (bridgeCode === "0x") {
    throw new Error(
      `Bridge at ${bridgeAddress} has no code. Cannot deploy governance for non-existent Bridge.`
    )
  }

  // Deploy BridgeGovernanceParameters library (always redeploy for potential updates)
  log("📚 Deploying BridgeGovernanceParameters library...")
  const bridgeGovernanceParameters = await deploy(
    "BridgeGovernanceParameters",
    {
      from: deployer,
      log: true,
      waitConfirmations: 1,
      // Force redeploy to ensure latest version
      skipIfAlreadyDeployed: false,
    }
  )

  // Calculate governance delay: 60 seconds for Sepolia, 48 hours otherwise
  const GOVERNANCE_DELAY = hre.network.name === "sepolia" ? 60 : 172800
  log(`⏰ Using governance delay: ${GOVERNANCE_DELAY} seconds`)

  // Deploy BridgeGovernance (force redeploy to get latest version)
  log("🏛️ Deploying BridgeGovernance contract...")
  const bridgeGovernance = await deploy("BridgeGovernance", {
    contract: "BridgeGovernance",
    from: deployer,
    args: [bridgeAddress, GOVERNANCE_DELAY],
    log: true,
    libraries: {
      BridgeGovernanceParameters: bridgeGovernanceParameters.address,
    },
    waitConfirmations: 1,
    // Force redeploy to ensure latest version with new functionality
    skipIfAlreadyDeployed: false,
  })

  log(`✅ BridgeGovernance deployed at: ${bridgeGovernance.address}`)

  // Verification on Etherscan
  if (hre.network.tags.etherscan) {
    log("🔍 Verifying contracts on Etherscan...")
    await helpers.etherscan.verify(bridgeGovernanceParameters)
    await helpers.etherscan.verify(bridgeGovernance)
    log("✅ Etherscan verification completed")
  }

  // Verification on Tenderly
  if (hre.network.tags.tenderly) {
    const tenderlyConfigPath = path.join(
      os.homedir(),
      ".tenderly",
      "config.yaml"
    )
    if (fs.existsSync(tenderlyConfigPath)) {
      log("🔍 Verifying contract on Tenderly...")
      await hre.tenderly.verify({
        name: "BridgeGovernance",
        address: bridgeGovernance.address,
      })
      log("✅ Tenderly verification completed")
    } else {
      log(
        "⚠️ Skipping Tenderly verification; ~/.tenderly/config.yaml not found."
      )
    }
  }

  log("🎉 BridgeGovernance redeployment completed successfully!")
}

/**
 * Resolves Bridge proxy address from existing deployment or environment.
 * This function ensures we reference the existing Bridge without triggering redeployment.
 */
async function resolveBridgeAddress(
  deployments: HardhatRuntimeEnvironment["deployments"]
): Promise<string | undefined> {
  // First, check if Bridge is in deployment cache
  const cachedBridge = await deployments.getOrNull("Bridge")
  if (cachedBridge?.address) {
    deployments.log(
      `Found cached Bridge deployment at: ${cachedBridge.address}`
    )
    return cachedBridge.address
  }

  // Fall back to environment variable
  const envBridgeAddress = process.env.BRIDGE_ADDRESS
  if (envBridgeAddress && envBridgeAddress.length > 0) {
    deployments.log(
      `Using Bridge address from BRIDGE_ADDRESS env: ${envBridgeAddress}`
    )

    const allowCacheWrite = process.env.ALLOW_BRIDGE_CACHE_FROM_ENV === "true"
    if (allowCacheWrite) {
      const bridgeArtifact = await deployments.getArtifact("Bridge")
      await deployments.save("Bridge", {
        address: envBridgeAddress,
        abi: bridgeArtifact.abi,
      })
      deployments.log(
        "Saved Bridge deployment cache from env (ALLOW_BRIDGE_CACHE_FROM_ENV=true)."
      )
    } else {
      deployments.log(
        "Not writing Bridge deployment cache from env; downstream scripts must rely on BRIDGE_ADDRESS."
      )
    }

    return envBridgeAddress
  }

  return undefined
}

export default func

func.tags = ["RedeployGovernanceOnly"]

// CRITICAL: No dependencies to prevent cascade redeployment
// We resolve Bridge address manually in the function
func.dependencies = []

// Skip by default to prevent accidental execution
func.skip = async () => {
  const shouldRun = process.env.ENABLE_REDEPLOY_GOVERNANCE === "true"
  if (!shouldRun) {
    console.log(
      "ℹ️  Skipping governance redeployment. Set ENABLE_REDEPLOY_GOVERNANCE=true to run."
    )
  }
  return !shouldRun
}
