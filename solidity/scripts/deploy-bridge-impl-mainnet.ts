import { ethers } from "hardhat"

async function main() {
  // Mainnet library addresses (verified on-chain from current Bridge implementation)
  // IMPORTANT: Redemption was updated on 2025-12-22 but deployments/mainnet/Redemption.json
  // was not updated. The correct address was extracted from the current Bridge bytecode.
  const libraryAddresses = {
    Deposit: "0xCD2EbDA2beA80484C55675e1965149054dCcD137",
    DepositSweep: "0x392635646Bc22FC13C86859d1f02B27974aC9b95",
    Redemption: "0xa7fed184fe79c2ea037e65558473c04ce42f5d0d", // Updated 2025-12-22 (NOT in repo)
    Wallets: "0xc989d3E486AAe6355F65281B4d0bde08c8e32fBC",
    Fraud: "0x51bBeF1c7cC3a1D3bC5E64CE6C3BA6E66fbA3559",
    MovingFunds: "0x3E0407765FaC663d391aE738f3Aa0c98EAb67a90",
  }

  const BRIDGE_PROXY = "0x5e4861a80B55f035D899f66772117F00FA0E8e7B"

  console.log("=".repeat(80))
  console.log("Deploy Bridge Implementation with Vault Fix (Mainnet)")
  console.log("=".repeat(80))

  // Show deployer info
  const [deployer] = await ethers.getSigners()
  console.log("\nDeployer:", deployer.address)
  const balance = await ethers.provider.getBalance(deployer.address)
  console.log("Balance:", ethers.utils.formatEther(balance), "ETH")

  console.log("\nUsing libraries:")
  for (const [name, addr] of Object.entries(libraryAddresses)) {
    console.log(`  ${name}: ${addr}`)
  }

  // Verify library addresses against current Bridge implementation bytecode
  console.log("\nVerifying library addresses against current Bridge implementation...")
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  const implSlot = await ethers.provider.getStorageAt(BRIDGE_PROXY, IMPL_SLOT)
  const currentImpl = ethers.utils.getAddress("0x" + implSlot.slice(-40))
  console.log(`Current implementation: ${currentImpl}`)

  const currentImplCode = await ethers.provider.getCode(currentImpl)
  const currentImplCodeLower = currentImplCode.toLowerCase()

  let allLibrariesMatch = true
  for (const [name, addr] of Object.entries(libraryAddresses)) {
    const addrLower = addr.toLowerCase().replace("0x", "")
    const found = currentImplCodeLower.includes(addrLower)
    if (found) {
      console.log(`  ✓ ${name}: ${addr} - FOUND in current impl`)
    } else {
      console.log(`  ✗ ${name}: ${addr} - NOT FOUND in current impl`)
      allLibrariesMatch = false
    }
  }

  if (!allLibrariesMatch) {
    throw new Error(
      "Library address mismatch! One or more library addresses do not match " +
      "the current Bridge implementation. Please verify the addresses against " +
      "the on-chain bytecode before proceeding."
    )
  }
  console.log("\n✓ All library addresses verified against current implementation")

  console.log("\nCreating Bridge contract factory...")
  const BridgeFactory = await ethers.getContractFactory("Bridge", {
    libraries: libraryAddresses,
  })

  // Deploy new implementation directly (bypassing OZ upgrade cache)
  console.log("\nDeploying NEW Bridge implementation...")
  const impl = await BridgeFactory.deploy()
  console.log("Transaction sent:", impl.deployTransaction.hash)
  console.log("Waiting for confirmation...")

  await impl.deployed()
  console.log("\n" + "=".repeat(80))
  console.log("NEW IMPLEMENTATION DEPLOYED")
  console.log("=".repeat(80))
  console.log("Address:", impl.address)

  // Verify it has the reinitializer function
  console.log("\nVerifying implementation has initializeV2_FixVaultZeroDeposit...")
  const implCode = await ethers.provider.getCode(impl.address)
  const hasFunction = implCode.toLowerCase().includes("456ffee0")
  console.log("Has function selector (0x456ffee0):", hasFunction)

  if (!hasFunction) {
    throw new Error("Deployed implementation doesn't have the required function!")
  }

  // Build the calldata for Gnosis Safe
  console.log("\n" + "=".repeat(80))
  console.log("GNOSIS SAFE CALLDATA")
  console.log("=".repeat(80))

  const reinitCalldata = BridgeFactory.interface.encodeFunctionData(
    "initializeV2_FixVaultZeroDeposit"
  )
  console.log("\nReinitializer calldata:", reinitCalldata)

  // Build upgradeAndCall calldata for ProxyAdmin
  const proxyAdminInterface = new ethers.utils.Interface([
    "function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable"
  ])

  const upgradeCalldata = proxyAdminInterface.encodeFunctionData(
    "upgradeAndCall",
    [BRIDGE_PROXY, impl.address, reinitCalldata]
  )
  console.log("\nProxyAdmin.upgradeAndCall() calldata:")
  console.log(upgradeCalldata)

  // Build Timelock schedule calldata
  const salt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`bridge-v2-vault-fix-${Date.now()}`)
  )
  console.log("\nSalt:", salt)

  const timelockInterface = new ethers.utils.Interface([
    "function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) external"
  ])

  const PROXY_ADMIN = "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706"
  const scheduleCalldata = timelockInterface.encodeFunctionData(
    "schedule",
    [
      PROXY_ADMIN,
      0,
      upgradeCalldata,
      ethers.constants.HashZero,
      salt,
      86400  // 24 hours
    ]
  )

  console.log("\n" + "=".repeat(80))
  console.log("TRANSACTION 1: Schedule (submit to Gnosis Safe)")
  console.log("=".repeat(80))
  console.log("To: 0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D (Timelock)")
  console.log("Value: 0")
  console.log("Data:", scheduleCalldata)

  // Build execute calldata
  const executeInterface = new ethers.utils.Interface([
    "function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt) external payable"
  ])

  const executeCalldata = executeInterface.encodeFunctionData(
    "execute",
    [
      PROXY_ADMIN,
      0,
      upgradeCalldata,
      ethers.constants.HashZero,
      salt
    ]
  )

  console.log("\n" + "=".repeat(80))
  console.log("TRANSACTION 2: Execute (submit to Gnosis Safe AFTER 24h)")
  console.log("=".repeat(80))
  console.log("To: 0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D (Timelock)")
  console.log("Value: 0")
  console.log("Data:", executeCalldata)

  console.log("\n" + "=".repeat(80))
  console.log("SUMMARY")
  console.log("=".repeat(80))
  console.log("New Implementation:", impl.address)
  console.log("Salt:", salt)
  console.log("\nNext steps:")
  console.log("1. Verify contract on Etherscan")
  console.log("2. Submit Transaction 1 (schedule) to Gnosis Safe")
  console.log("3. Wait 24 hours")
  console.log("4. Submit Transaction 2 (execute) to Gnosis Safe")
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
