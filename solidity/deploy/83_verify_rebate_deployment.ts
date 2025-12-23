import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import fs from "fs"
import path from "path"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments } = hre

  console.log("\n========== VERIFYING REBATE DEPLOYMENT ==========")
  console.log("Network:", hre.network.name)
  console.log("==================================================\n")

  // Step 1: Find the most recent deployment summary
  const deploymentsDir = path.join(
    __dirname,
    `../deployments/${hre.network.name}`
  )
  const files = fs.readdirSync(deploymentsDir)
  const rebateDeployments = files
    .filter((f) => f.startsWith("rebate-deployment-") && f.endsWith(".json"))
    .sort()
    .reverse()

  if (rebateDeployments.length === 0) {
    console.log("❌ No rebate deployment summary found!")
    console.log("   Please run script 82_deploy_rebate_and_prepare_txs first.")
    return
  }

  const latestDeployment = rebateDeployments[0]
  const summaryPath = path.join(deploymentsDir, latestDeployment)
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"))

  console.log("Using deployment summary from:", summary.timestamp)
  console.log("File:", latestDeployment)
  console.log()

  // Step 2: Check if Bridge was upgraded
  console.log("Step 1: Checking Bridge proxy upgrade...")

  const Bridge = await deployments.get("Bridge")
  const bridgeContract = await ethers.getContractAt("Bridge", Bridge.address)

  // Get the implementation address from the proxy
  // Implementation slot for TransparentUpgradeableProxy is at:
  // 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
  const implementationSlot =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  const implementationData = await ethers.provider.getStorageAt(
    Bridge.address,
    implementationSlot
  )
  const currentImplementation = ethers.utils.getAddress(
    `0x${implementationData.slice(26)}`
  )

  // Check if upgraded to our implementation
  const isUpgraded =
    currentImplementation.toLowerCase() ===
    summary.deployedContracts.bridgeImplementation.toLowerCase()

  if (isUpgraded) {
    console.log("✅ Bridge proxy has been upgraded to new implementation!")
    console.log("   Current implementation:", currentImplementation)
  } else {
    console.log("⚠️  Bridge proxy has NOT been upgraded yet")
    console.log("   Current implementation: ", currentImplementation)
    console.log(
      "   Expected implementation:",
      summary.deployedContracts.bridgeImplementation
    )
    console.log("\n   Waiting for ProxyAdmin owner to execute:")
    console.log("   To:  ", summary.requiredActions.proxyAdminOwner.to)
    console.log("   Data:", summary.requiredActions.proxyAdminOwner.data)
  }

  // Step 3: Check if RebateStaking is set in Bridge
  console.log("\nStep 2: Checking RebateStaking configuration...")

  let rebateStakingAddress = "0x0000000000000000000000000000000000000000"

  try {
    // Try to call getRebateStaking() - this will only work if Bridge has been upgraded
    rebateStakingAddress = await bridgeContract.getRebateStaking()
  } catch (error) {
    console.log(
      "⚠️  Cannot read RebateStaking from Bridge (upgrade may be pending)"
    )
  }

  if (rebateStakingAddress === summary.deployedContracts.rebateStaking) {
    console.log("✅ RebateStaking has been set in Bridge!")
    console.log("   RebateStaking address:", rebateStakingAddress)
  } else if (
    rebateStakingAddress === "0x0000000000000000000000000000000000000000"
  ) {
    console.log("⚠️  RebateStaking has NOT been set in Bridge yet")
    console.log(
      "   Expected RebateStaking:",
      summary.deployedContracts.rebateStaking
    )

    // Check if there's a pending governance action
    const bridgeGovernanceAddress = summary.existingContracts.bridgeGovernance
    const bridgeGovernanceABI = [
      "function governanceDelays(uint256) view returns (uint256)",
      "function governanceUpdates(uint256) view returns (uint256 timelock, bytes4[] memory functionSelectors, address[] memory targets, uint256[] memory values, bytes[] memory calldatas)",
      "function governanceUpdatesCount() view returns (uint256)",
    ]

    try {
      const bridgeGovernance = await ethers.getContractAt(
        bridgeGovernanceABI,
        bridgeGovernanceAddress
      )

      const updatesCount = await bridgeGovernance.governanceUpdatesCount()
      console.log("\n   Checking for pending governance actions...")
      console.log("   Total governance updates:", updatesCount.toString())

      if (updatesCount.gt(0)) {
        // Check the latest update
        const latestUpdate = await bridgeGovernance.governanceUpdates(
          updatesCount.sub(1)
        )
        const timelockTimestamp = latestUpdate.timelock.toNumber()
        const currentTimestamp = Math.floor(Date.now() / 1000)

        if (timelockTimestamp > currentTimestamp) {
          const remainingTime = timelockTimestamp - currentTimestamp
          const hours = Math.floor(remainingTime / 3600)
          const minutes = Math.floor((remainingTime % 3600) / 60)

          console.log("   ⏰ Governance action is in timelock!")
          console.log(`      Time remaining: ${hours}h ${minutes}m`)
          console.log(
            `      Executable at: ${new Date(
              timelockTimestamp * 1000
            ).toISOString()}`
          )
        } else {
          console.log("   ✅ Governance action is ready to execute!")
          console.log(
            "      Call finalizeGovernanceUpdate() on BridgeGovernance"
          )
        }
      } else {
        console.log("\n   Waiting for Governance to execute transaction:")
        console.log("   To:  ", summary.requiredActions.governance.to)
        console.log("   Data:", summary.requiredActions.governance.data)
      }
    } catch (error) {
      console.log("   Could not check governance status")
    }
  } else {
    console.log(
      "⚠️  Unexpected RebateStaking address in Bridge:",
      rebateStakingAddress
    )
    console.log("   Expected:", summary.deployedContracts.rebateStaking)
  }

  // Step 4: Verify RebateStaking contract configuration
  console.log("\nStep 3: Verifying RebateStaking contract...")

  try {
    const rebateStakingABI = [
      "function bridge() view returns (address)",
      "function token() view returns (address)",
      "function rollingWindow() view returns (uint256)",
      "function unstakingPeriod() view returns (uint256)",
      "function rebatePerToken() view returns (uint256)",
    ]

    const rebateStaking = await ethers.getContractAt(
      rebateStakingABI,
      summary.deployedContracts.rebateStaking
    )

    const bridge = await rebateStaking.bridge()
    const token = await rebateStaking.token()
    const rollingWindow = await rebateStaking.rollingWindow()
    const unstakingPeriod = await rebateStaking.unstakingPeriod()
    const rebatePerToken = await rebateStaking.rebatePerToken()

    console.log("✅ RebateStaking contract is deployed and configured:")
    console.log(
      "   Address:          ",
      summary.deployedContracts.rebateStaking
    )
    console.log("   Bridge:           ", bridge)
    console.log("   Token:            ", token)
    console.log(
      "   Rolling window:   ",
      rollingWindow.toString(),
      "seconds (",
      rollingWindow.div(86400).toString(),
      "days)"
    )
    console.log(
      "   Unstaking period: ",
      unstakingPeriod.toString(),
      "seconds (",
      unstakingPeriod.div(86400).toString(),
      "days)"
    )
    console.log(
      "   Rebate per token: ",
      rebatePerToken.toString(),
      "(0.001 BTC per 100,000 T)"
    )
  } catch (error) {
    console.log("❌ Could not verify RebateStaking contract")
  }

  // Step 5: Summary
  console.log("\n========== DEPLOYMENT STATUS SUMMARY ==========")

  const bridgeUpgraded =
    currentImplementation.toLowerCase() ===
    summary.deployedContracts.bridgeImplementation.toLowerCase()
  const isConnected =
    rebateStakingAddress === summary.deployedContracts.rebateStaking

  if (bridgeUpgraded && isConnected) {
    console.log("✅ DEPLOYMENT COMPLETE!")
    console.log("   All contracts are deployed and configured correctly.")
  } else {
    console.log("⚠️  DEPLOYMENT IN PROGRESS")
    if (!bridgeUpgraded) {
      console.log("   [ ] Bridge proxy upgrade (waiting for ProxyAdmin)")
    } else {
      console.log("   [✓] Bridge proxy upgrade")
    }

    if (!isConnected) {
      console.log("   [ ] RebateStaking connection (waiting for Governance)")
    } else {
      console.log("   [✓] RebateStaking connection")
    }

    console.log("\n   Run this script again later to check status.")
  }

  console.log("================================================\n")
}

export default func

func.tags = ["VerifyRebateDeployment"]
// This script can be run at any time to check status
func.skip = async () => false
