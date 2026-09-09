import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { utils } from "ethers"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, deployments } = hre

  console.log("\n========== VERIFYING PEG KEEPER DEPLOYMENT ==========")
  console.log("Network:", hre.network.name)
  console.log("======================================================\n")

  // --- Load deployed contract addresses from hardhat-deploy records ---
  const Bridge = await deployments.get("Bridge")
  const RebateStaking = await deployments.get("RebateStaking")
  const BridgeGovernanceV2 = await deployments.get("BridgeGovernanceV2")

  const bridgeContract = await ethers.getContractAt("Bridge", Bridge.address)
  const rebateStakingContract = await ethers.getContractAt(
    "RebateStaking",
    RebateStaking.address
  )
  const bridgeGovernanceV2Contract = await ethers.getContractAt(
    "BridgeGovernance",
    BridgeGovernanceV2.address
  )

  const { INITIAL_PEG_KEEPER } = process.env
  if (!INITIAL_PEG_KEEPER || !utils.isAddress(INITIAL_PEG_KEEPER)) {
    console.log(
      "⚠️  INITIAL_PEG_KEEPER env var not set; skipping peg keeper allowlist check"
    )
  }

  // --- Step 1: Verify Bridge governance is BridgeGovernanceV2 ---
  console.log("Step 1: Checking Bridge governance pointer...")

  const currentGovernance = await bridgeContract.governance()
  const isGovernanceV2 =
    currentGovernance.toLowerCase() === BridgeGovernanceV2.address.toLowerCase()

  if (isGovernanceV2) {
    console.log("✅ Bridge.governance() points to BridgeGovernanceV2")
    console.log("   BridgeGovernanceV2 address:", BridgeGovernanceV2.address)
  } else {
    console.log("❌ Bridge.governance() does NOT point to BridgeGovernanceV2")
    console.log("   Current governance:", currentGovernance)
    console.log("   Expected:", BridgeGovernanceV2.address)
  }

  // --- Step 2: Verify BridgeGovernanceV2 owner is the Council/governance account ---
  console.log("\nStep 2: Checking BridgeGovernanceV2 owner...")

  const governanceNamedAccount = (await hre.getNamedAccounts()).governance
  const bgV2Owner = await bridgeGovernanceV2Contract.owner()
  const isOwnerCorrect =
    bgV2Owner.toLowerCase() === governanceNamedAccount.toLowerCase()

  if (isOwnerCorrect) {
    console.log("✅ BridgeGovernanceV2 owner is the governance account")
    console.log("   Owner:", bgV2Owner)
  } else {
    console.log("❌ BridgeGovernanceV2 owner is NOT the governance account")
    console.log("   Current owner:", bgV2Owner)
    console.log("   Expected:", governanceNamedAccount)
  }

  // --- Step 3: Verify initial peg keeper is allowlisted ---
  console.log("\nStep 3: Checking peg keeper allowlist...")

  let pegKeeperCheckPassed = false
  if (INITIAL_PEG_KEEPER && utils.isAddress(INITIAL_PEG_KEEPER)) {
    const isPegKeeper = await bridgeContract.isPegKeeper(INITIAL_PEG_KEEPER)
    if (isPegKeeper) {
      console.log("✅ Initial peg keeper is allowlisted")
      console.log("   Peg keeper:", INITIAL_PEG_KEEPER)
      pegKeeperCheckPassed = true
    } else {
      console.log("❌ Initial peg keeper is NOT allowlisted")
      console.log("   Peg keeper:", INITIAL_PEG_KEEPER)
    }
  } else {
    console.log("⚠️  INITIAL_PEG_KEEPER not provided; cannot verify allowlist")
  }

  // --- Step 4: Verify RebateStaking is deprecated ---
  console.log("\nStep 4: Checking RebateStaking deprecation...")

  const isDeprecated = await rebateStakingContract.deprecated()
  if (isDeprecated) {
    console.log("✅ RebateStaking is deprecated")
  } else {
    console.log("❌ RebateStaking is NOT deprecated")
  }

  // --- Step 5: Verify Bridge rebate hook is disabled ---
  console.log("\nStep 5: Checking Bridge rebate hook disabled flag...")

  const isRebateDisabled = await bridgeContract.isRebateStakingDisabled()
  if (isRebateDisabled) {
    console.log("✅ Bridge.isRebateStakingDisabled() = true")
  } else {
    console.log("❌ Bridge.isRebateStakingDisabled() = false (expected true)")
  }

  // --- Step 6: Verify Bridge getRebateStaking returns zero ---
  console.log("\nStep 6: Checking Bridge legacy rebate staking address...")

  const bridgeRebateStaking = await bridgeContract.getRebateStaking()
  const zeroAddress = "0x0000000000000000000000000000000000000000"
  if (bridgeRebateStaking.toLowerCase() === zeroAddress) {
    console.log(
      "✅ Bridge.getRebateStaking() returns zero (legacy wiring removed)"
    )
  } else {
    console.log("❌ Bridge.getRebateStaking() is NOT zero")
    console.log("   Current:", bridgeRebateStaking)
    console.log("   Expected:", zeroAddress)
  }

  // --- Step 7: Verify RebateStaking implementation is upgraded ---
  console.log("\nStep 7: Checking RebateStaking proxy implementation...")

  // EIP-1967 implementation slot
  const IMPLEMENTATION_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  const implData = await ethers.provider.getStorageAt(
    RebateStaking.address,
    IMPLEMENTATION_SLOT
  )
  const rebateImpl = utils.getAddress(`0x${implData.slice(26)}`)

  const rebateStakingV6Impl = await deployments.get(
    "RebateStakingV6Implementation"
  )
  const isRebateImplCorrect =
    rebateImpl.toLowerCase() === rebateStakingV6Impl.address.toLowerCase()

  if (isRebateImplCorrect) {
    console.log("✅ RebateStaking proxy points to V6 implementation")
    console.log("   Implementation:", rebateImpl)
  } else {
    console.log("❌ RebateStaking proxy does NOT point to V6 implementation")
    console.log("   Current:", rebateImpl)
    console.log("   Expected:", rebateStakingV6Impl.address)
  }

  // --- Step 8: Verify Bridge implementation is upgraded ---
  console.log("\nStep 8: Checking Bridge proxy implementation...")

  const bridgeImplData = await ethers.provider.getStorageAt(
    Bridge.address,
    IMPLEMENTATION_SLOT
  )
  const bridgeImpl = utils.getAddress(`0x${bridgeImplData.slice(26)}`)

  const bridgeV6Impl = await deployments.get("BridgeV6PegKeeperImplementation")
  const isBridgeImplCorrect =
    bridgeImpl.toLowerCase() === bridgeV6Impl.address.toLowerCase()

  if (isBridgeImplCorrect) {
    console.log("✅ Bridge proxy points to V6 implementation")
    console.log("   Implementation:", bridgeImpl)
  } else {
    console.log("❌ Bridge proxy does NOT point to V6 implementation")
    console.log("   Current:", bridgeImpl)
    console.log("   Expected:", bridgeV6Impl.address)
  }

  // --- Summary ---
  console.log("\n========== MIGRATION STATUS SUMMARY ==========")

  const allChecks = [
    { name: "Bridge governance → BridgeGovernanceV2", passed: isGovernanceV2 },
    { name: "BridgeGovernanceV2 owner = governance", passed: isOwnerCorrect },
    { name: "Initial peg keeper allowlisted", passed: pegKeeperCheckPassed },
    { name: "RebateStaking deprecated", passed: isDeprecated },
    { name: "Bridge rebate hook disabled", passed: isRebateDisabled },
    {
      name: "Bridge getRebateStaking = zero",
      passed: bridgeRebateStaking.toLowerCase() === zeroAddress,
    },
    { name: "RebateStaking impl = V6", passed: isRebateImplCorrect },
    { name: "Bridge impl = V6", passed: isBridgeImplCorrect },
  ]

  const allPassed = allChecks.every((c) => c.passed)

  allChecks.forEach((c) => {
    console.log(`${c.passed ? "[✓]" : "[ ]"} ${c.name}`)
  })

  if (allPassed) {
    console.log("\n✅ MIGRATION COMPLETE!")
    console.log("   All contracts are deployed and configured correctly.")
  } else {
    console.log("\n⚠️  MIGRATION INCOMPLETE")
    console.log("   Some post-conditions are not met.")
    console.log("\n   Re-run this script after the Timelock batch executes.")
  }

  console.log("==============================================\n")
}

export default func

func.tags = ["VerifyPegKeeperDeployment"]
func.skip = async () => process.env.VERIFY_PEG_KEEPER !== "true"
