// Script to upgrade OptimismMintableUpgradableERC20 to L2TBTC-like functionality
// This script handles the proxy upgrade and initial configuration

import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  console.log("Upgrading OptimismMintableUpgradableERC20 with account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());

  // IMPORTANT: Replace with your actual proxy address
  const PROXY_ADDRESS = "YOUR_PROXY_ADDRESS_HERE";
  
  // IMPORTANT: Replace with the desired owner address (governance)
  const OWNER_ADDRESS = "YOUR_GOVERNANCE_ADDRESS_HERE";
  
  // Get the new implementation contract factory
  const OptimismMintableUpgradableERC20V2 = await ethers.getContractFactory(
    "OptimismMintableUpgradableERC20"
  );

  console.log("Preparing upgrade...");
  
  // Upgrade the proxy to the new implementation
  const upgraded = await upgrades.upgradeProxy(
    PROXY_ADDRESS,
    OptimismMintableUpgradableERC20V2
  );

  await upgraded.deployed();
  
  console.log("Proxy upgraded successfully!");
  console.log("New implementation deployed at:", await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS));

  // Verify the upgrade
  const version = await upgraded.version();
  console.log("Contract version:", version);
  
  // IMPORTANT: Initialize V2 to set up new functionality
  console.log("\nInitializing V2 functionality...");
  const initTx = await upgraded.initializeV2(OWNER_ADDRESS);
  await initTx.wait();
  console.log("V2 initialized successfully!");
  
  // Verify initialization
  const owner = await upgraded.owner();
  console.log("Contract owner set to:", owner);
  
  // Verify the bridge is now a minter
  const bridge = await upgraded.BRIDGE();
  const isBridgeMinter = await upgraded.isMinter(bridge);
  console.log(`Bridge (${bridge}) is minter:`, isBridgeMinter);
  
  // Optional: Add additional minters or guardians
  // Note: These must be called by the owner account
  // await upgraded.connect(ownerSigner).addMinter("0x...");
  // await upgraded.connect(ownerSigner).addGuardian("0x...");
  
  console.log("\nUpgrade complete!");
  
  // Print current state
  const minters = await upgraded.getMinters();
  const guardians = await upgraded.getGuardians();
  
  console.log("\nCurrent configuration:");
  console.log("Owner:", owner);
  console.log("Minters:", minters);
  console.log("Guardians:", guardians);
  console.log("Paused:", await upgraded.paused());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 