/* eslint-disable no-console */
import { ethers } from "hardhat"
import { config as dotenvConfig } from "dotenv"

dotenvConfig({ override: true })

/**
 * Manual Bridge upgrade script that bypasses OpenZeppelin's upgrade plugin.
 * Deploys a new implementation and calls ProxyAdmin directly.
 *
 * Run with:
 * npx hardhat run scripts/manual-bridge-upgrade.ts --network sepolia
 */
async function main() {
  const bridgeProxyAddress = process.env.BRIDGE_ADDRESS
  const proxyAdminAddress = "0x39f60B25C4598Caf7e922d6fC063E9002db45845"

  if (!bridgeProxyAddress) {
    throw new Error("BRIDGE_ADDRESS not set")
  }

  const proxyAdminPK = process.env.PROXY_ADMIN_PK
  if (!proxyAdminPK) {
    throw new Error("PROXY_ADMIN_PK not set")
  }

  const signer = new ethers.Wallet(proxyAdminPK, ethers.provider)
  console.log(`Using signer: ${await signer.getAddress()}`)

  // Library addresses from .env
  const libraryAddresses = {
    Deposit: process.env.DEPOSIT_LIB_ADDRESS!,
    DepositSweep: process.env.DEPOSITSWEEP_LIB_ADDRESS!,
    Redemption: process.env.REDEMPTION_LIB_ADDRESS!,
    Wallets: process.env.WALLETS_LIB_ADDRESS!,
    Fraud: process.env.FRAUD_LIB_ADDRESS!,
    MovingFunds: process.env.MOVINGFUNDS_LIB_ADDRESS!,
  }

  console.log("Library addresses:", libraryAddresses)

  // Validate library addresses
  for (const [name, address] of Object.entries(libraryAddresses)) {
    if (!address || address === "undefined") {
      throw new Error(`${name} library address not set`)
    }
    const code = await ethers.provider.getCode(address)
    if (code === "0x") {
      throw new Error(`No code at ${name} library address: ${address}`)
    }
    console.log(`  ✓ ${name}: ${address}`)
  }

  // Get current implementation
  const implSlot =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  const currentImplRaw = await ethers.provider.getStorageAt(
    bridgeProxyAddress,
    implSlot
  )
  const currentImpl = ethers.utils.getAddress(
    "0x" + currentImplRaw.slice(-40)
  )
  console.log(`\nCurrent Bridge implementation: ${currentImpl}`)

  // Deploy new Bridge implementation
  console.log("\nDeploying new Bridge implementation...")
  const BridgeFactory = await ethers.getContractFactory("Bridge", {
    signer,
    libraries: libraryAddresses,
  })

  const newImpl = await BridgeFactory.deploy()
  await newImpl.deployed()
  console.log(`New Bridge implementation deployed at: ${newImpl.address}`)

  // Verify new implementation has controllerBalanceIncreaser
  console.log("\nVerifying new implementation has controllerBalanceIncreaser...")
  const bridgeArtifact = await ethers.getContractFactory("Bridge", {
    libraries: libraryAddresses,
  })
  const hasFunction = bridgeArtifact.interface.fragments.some(
    (f) => f.type === "function" && f.name === "controllerBalanceIncreaser"
  )
  if (!hasFunction) {
    throw new Error(
      "New Bridge implementation does not have controllerBalanceIncreaser function!"
    )
  }
  console.log("  ✓ controllerBalanceIncreaser function exists in ABI")

  // Call ProxyAdmin.upgrade(proxy, newImpl)
  console.log(`\nUpgrading proxy via ProxyAdmin at ${proxyAdminAddress}...`)
  const proxyAdminAbi = [
    "function upgrade(address proxy, address implementation) external",
    "function owner() external view returns (address)",
  ]
  const proxyAdmin = new ethers.Contract(proxyAdminAddress, proxyAdminAbi, signer)

  const owner = await proxyAdmin.owner()
  const signerAddr = await signer.getAddress()
  if (owner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `ProxyAdmin owner is ${owner}, but signer is ${signerAddr}`
    )
  }
  console.log(`  ProxyAdmin owner: ${owner} ✓`)

  const upgradeTx = await proxyAdmin.upgrade(bridgeProxyAddress, newImpl.address)
  console.log(`  Upgrade tx submitted: ${upgradeTx.hash}`)
  const receipt = await upgradeTx.wait()
  console.log(`  Upgrade confirmed in block ${receipt.blockNumber}`)

  // Verify upgrade
  const newImplRaw = await ethers.provider.getStorageAt(
    bridgeProxyAddress,
    implSlot
  )
  const verifiedImpl = ethers.utils.getAddress("0x" + newImplRaw.slice(-40))
  console.log(`\nVerification:`)
  console.log(`  New implementation address: ${verifiedImpl}`)

  if (verifiedImpl.toLowerCase() === newImpl.address.toLowerCase()) {
    console.log("  ✓ Upgrade successful!")
  } else {
    console.log("  ✗ Upgrade verification failed!")
  }

  // Test controllerBalanceIncreaser call
  console.log("\nTesting controllerBalanceIncreaser() call...")
  const bridge = await ethers.getContractAt("Bridge", bridgeProxyAddress)
  try {
    const controller = await bridge.controllerBalanceIncreaser()
    console.log(`  controllerBalanceIncreaser() returns: ${controller}`)
    console.log("  ✓ Function call successful!")
  } catch (e: any) {
    console.log(`  ✗ Function call failed: ${e.message}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
