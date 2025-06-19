import { ethers } from "hardhat"
import type { HardhatRuntimeEnvironment } from "hardhat/types"

async function main() {
  const hre = require("hardhat") as HardhatRuntimeEnvironment
  const { deployments, getNamedAccounts } = hre
  const { deployer, governance } = await getNamedAccounts()

  console.log("Checking StarkNetBitcoinDepositor ownership...")
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

  // Check if ownership transfer is needed
  if (currentOwner.toLowerCase() === deployer.toLowerCase()) {
    console.log("✅ Contract is owned by deployer. Ownership transfer to governance is needed.")
  } else if (currentOwner.toLowerCase() === governance.toLowerCase()) {
    console.log("✅ Contract is already owned by governance. No transfer needed.")
  } else {
    console.log("⚠️  Contract is owned by unknown address:", currentOwner)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})