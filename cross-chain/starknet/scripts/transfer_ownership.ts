import { ethers } from "hardhat"
import type { HardhatRuntimeEnvironment } from "hardhat/types"

async function main() {
  const hre = require("hardhat") as HardhatRuntimeEnvironment
  const { deployments, getNamedAccounts } = hre
  const { deployer, governance } = await getNamedAccounts()

  console.log("=== StarkNetBitcoinDepositor Ownership Transfer ===")
  console.log("Deployer address:", deployer)
  console.log("Governance address:", governance)

  // Get the deployed contract
  const StarkNetBitcoinDepositor = await deployments.get("StarkNetBitcoinDepositor")
  console.log("Contract address:", StarkNetBitcoinDepositor.address)

  // Get contract instance
  const contract = await ethers.getContractAt("StarkNetBitcoinDepositor", StarkNetBitcoinDepositor.address)
  
  // Check current owner
  const currentOwner = await contract.owner()
  console.log("Current owner:", currentOwner)

  if (currentOwner.toLowerCase() === governance.toLowerCase()) {
    console.log("✅ Contract is already owned by governance. No transfer needed.")
    return
  }

  if (currentOwner.toLowerCase() !== deployer.toLowerCase()) {
    console.log("❌ Contract is not owned by deployer. Cannot transfer ownership.")
    console.log("   Current owner:", currentOwner)
    return
  }

  // Perform ownership transfer
  console.log("\n🔄 Transferring ownership to governance...")
  console.log("   From:", deployer)
  console.log("   To:", governance)
  
  try {
    const tx = await contract.transferOwnership(governance)
    console.log("📤 Transaction sent:", tx.hash)
    
    console.log("⏳ Waiting for confirmation...")
    const receipt = await tx.wait()
    console.log("✅ Ownership transferred successfully!")
    console.log("   Block number:", receipt.blockNumber)
    console.log("   Gas used:", receipt.gasUsed.toString())
    
    // Verify new owner
    const newOwner = await contract.owner()
    console.log("\n✅ New owner verified:", newOwner)
  } catch (error) {
    console.error("❌ Error transferring ownership:", error)
    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})