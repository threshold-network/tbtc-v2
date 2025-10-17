import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments, getNamedAccounts } = hre
  const { deployer } = await getNamedAccounts()

  console.log("\n========== FINALIZING GOVERNANCE UPDATE ==========")
  console.log("Network:", hre.network.name)
  console.log("Executor:", deployer)
  console.log("===================================================\n")

  // Get BridgeGovernance contract
  const bridgeGovernanceAddress = (await deployments.get("BridgeGovernance"))
    .address
  const bridgeGovernanceABI = [
    "function governanceUpdates(uint256) view returns (uint256 timelock, bytes4[] memory functionSelectors, address[] memory targets, uint256[] memory values, bytes[] memory calldatas)",
    "function governanceUpdatesCount() view returns (uint256)",
    "function finalizeGovernanceUpdate()",
  ]

  const bridgeGovernance = await ethers.getContractAt(
    bridgeGovernanceABI,
    bridgeGovernanceAddress,
    await ethers.getSigner(deployer)
  )

  // Check if there's a pending governance update
  const updatesCount = await bridgeGovernance.governanceUpdatesCount()

  if (updatesCount.eq(0)) {
    console.log("❌ No governance updates found!")
    console.log("   Make sure the governance proposal was submitted first.")
    return
  }

  // Get the latest update (assuming it's the one we want)
  const latestUpdateIndex = updatesCount.sub(1)
  const latestUpdate = await bridgeGovernance.governanceUpdates(
    latestUpdateIndex
  )
  const timelockTimestamp = latestUpdate.timelock.toNumber()
  const currentTimestamp = Math.floor(Date.now() / 1000)

  console.log(`Governance update #${latestUpdateIndex.toString()} details:`)
  console.log("  Timelock timestamp:", timelockTimestamp)
  console.log("  Current timestamp: ", currentTimestamp)

  if (timelockTimestamp > currentTimestamp) {
    const remainingTime = timelockTimestamp - currentTimestamp
    const hours = Math.floor(remainingTime / 3600)
    const minutes = Math.floor((remainingTime % 3600) / 60)
    const seconds = remainingTime % 60

    console.log("\n⏰ Governance update is still in timelock!")
    console.log(`   Time remaining: ${hours}h ${minutes}m ${seconds}s`)
    console.log(
      `   Executable at: ${new Date(timelockTimestamp * 1000).toISOString()}`
    )
    console.log(
      "\n   Please wait for the timelock to expire before running this script again."
    )
    return
  }

  // Timelock has expired, we can finalize
  console.log("\n✅ Timelock has expired! Finalizing governance update...")

  try {
    const tx = await bridgeGovernance.finalizeGovernanceUpdate()
    console.log("\n📤 Transaction submitted!")
    console.log("   Transaction hash:", tx.hash)

    console.log("\n⏳ Waiting for confirmation...")
    const receipt = await tx.wait()

    console.log("\n✅ Governance update finalized!")
    console.log("   Block number:", receipt.blockNumber)
    console.log("   Gas used:", receipt.gasUsed.toString())

    // Verify the result
    const Bridge = await deployments.get("Bridge")
    const bridgeContract = await ethers.getContractAt(
      ["function getRebateStaking() view returns (address)"],
      Bridge.address
    )

    try {
      const rebateStaking = await bridgeContract.getRebateStaking()
      console.log("\n✅ RebateStaking is now set in Bridge:", rebateStaking)
    } catch (error) {
      console.log("\n⚠️  Could not verify RebateStaking setting")
    }
  } catch (error: any) {
    console.log("\n❌ Failed to finalize governance update!")
    console.log("   Error:", error.message)

    if (error.message.includes("Governance delay has not passed yet")) {
      console.log("\n   The timelock hasn't expired yet. Please wait.")
    } else if (error.message.includes("No governance update to finalize")) {
      console.log("\n   The governance update may have already been finalized.")
    }
  }

  console.log("\n===================================================\n")
}

export default func

func.tags = ["FinalizeGovernanceUpdate"]
// This script should only run when explicitly called
func.skip = async () => true
