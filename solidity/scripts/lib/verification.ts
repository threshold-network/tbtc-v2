/* eslint-disable no-console */
import { ethers, HardhatRuntimeEnvironment } from "hardhat"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/**
 * Validates that an address is non-zero and properly formatted
 * @param address - The address to validate
 * @param name - The name of the address (for error messages)
 * @throws Error if address is invalid
 */
export function validateAddress(address: string, name: string): void {
  if (!address || address === ZERO_ADDRESS) {
    throw new Error(`${name} cannot be zero address`)
  }
  if (!ethers.utils.isAddress(address)) {
    throw new Error(`${name} is not a valid Ethereum address: ${address}`)
  }
}

/**
 * Checks if two addresses match (case-insensitive)
 * @param a - First address
 * @param b - Second address
 * @returns true if addresses match
 */
export function addressesMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Represents a single alignment check result
 */
export interface AlignmentCheck {
  name: string
  expected: string
  actual: string
  passed: boolean
  critical: boolean
}

/**
 * Prints an alignment check result with appropriate icon
 * @param check - The alignment check result
 */
export function printAlignmentResult(check: AlignmentCheck): void {
  const icon = check.passed ? "✅" : "❌"
  const critical = check.critical ? " ⚠️ CRITICAL" : ""
  console.log(`  ${icon} ${check.name}${critical}`)
  if (!check.passed) {
    console.log(`     Actual: ${check.actual}`)
    console.log(`     Expected: ${check.expected}`)
  }
}

/**
 * Runs multiple alignment checks and exits if any fail
 * @param checks - Array of alignment checks to run
 * @returns true if all checks pass, false otherwise
 */
export function verifyAlignmentChecks(checks: AlignmentCheck[]): boolean {
  const allPassed = checks.every((check) => check.passed)
  const failedChecks = checks.filter((check) => !check.passed)

  if (allPassed) {
    console.log("\n✅ All alignment checks passed.")
    return true
  }

  console.log("\n❌ Some alignment checks failed.")

  if (failedChecks.length > 0) {
    console.log("\n🔧 Remediation:")
    failedChecks.forEach((check) => {
      console.log(`  ❌ ${check.name}`)
      console.log(`     Fix: ${check.name}`)
    })
  }

  return false
}

/**
 * MintBurnGuard alignment verification options
 */
export interface MintBurnGuardAlignmentOptions {
  mintBurnGuardAddress: string
  hre: HardhatRuntimeEnvironment
  bridgeAddress?: string
  controllerAddress?: string
  bankAddress?: string
  vaultAddress?: string
}

/**
 * Verifies bidirectional alignment between MintBurnGuard and dependent contracts
 * @param options - Verification options including addresses and hre
 * @throws Error if alignment checks fail
 */
export async function verifyMintBurnGuardAlignment(
  options: MintBurnGuardAlignmentOptions
): Promise<void> {
  const { mintBurnGuardAddress, hre } = options
  const { deployments } = hre

  // Check if verification should be skipped
  if (process.env.SKIP_DEPLOYMENT_VERIFICATION === "true") {
    console.log("⚠️  Verification skipped (SKIP_DEPLOYMENT_VERIFICATION=true)")
    return
  }

  console.log("\n🔍 Verifying MintBurnGuard configuration alignment...")

  // Get addresses from options or deployment cache
  const bridgeAddress =
    options.bridgeAddress ||
    process.env.BRIDGE_ADDRESS ||
    (await deployments.get("Bridge")).address

  const controllerAddress =
    options.controllerAddress ||
    process.env.MINT_BURN_GUARD_CONTROLLER ||
    (await deployments.get("BridgeGovernance")).address

  const bankAddress =
    options.bankAddress ||
    process.env.BANK_ADDRESS ||
    (await deployments.get("Bank")).address

  const vaultAddress =
    options.vaultAddress ||
    process.env.TBTC_VAULT_ADDRESS ||
    (await deployments.get("TBTCVault")).address

  // Get contract instances
  const mintBurnGuard = await ethers.getContractAt(
    "MintBurnGuard",
    mintBurnGuardAddress
  )
  const bridge = await ethers.getContractAt("Bridge", bridgeAddress)

  // Run alignment checks
  const checks: AlignmentCheck[] = []

  // Check 1: MintBurnGuard.bridge() == Bridge.address
  const mbgBridge = await mintBurnGuard.bridge()
  checks.push({
    name: "MintBurnGuard.bridge() == Bridge.address",
    expected: bridgeAddress,
    actual: mbgBridge,
    passed: addressesMatch(mbgBridge, bridgeAddress),
    critical: true,
  })

  // Check 2: MintBurnGuard.controller() == Controller.address
  const mbgController = await mintBurnGuard.controller()
  checks.push({
    name: "MintBurnGuard.controller() == Controller.address",
    expected: controllerAddress,
    actual: mbgController,
    passed: addressesMatch(mbgController, controllerAddress),
    critical: true,
  })

  // Check 3: Bridge.controllerBalanceIncreaser() == MintBurnGuard.address (CRITICAL)
  const bridgeController = await bridge.controllerBalanceIncreaser()
  checks.push({
    name: "Bridge.controllerBalanceIncreaser() == MintBurnGuard.address",
    expected: mintBurnGuardAddress,
    actual: bridgeController,
    passed: addressesMatch(bridgeController, mintBurnGuardAddress),
    critical: true,
  })

  // Check 4: MintBurnGuard.bank() == Bank.address
  const mbgBank = await mintBurnGuard.bank()
  checks.push({
    name: "MintBurnGuard.bank() == Bank.address",
    expected: bankAddress,
    actual: mbgBank,
    passed: addressesMatch(mbgBank, bankAddress),
    critical: true,
  })

  // Check 5: MintBurnGuard.vault() == TBTCVault.address
  const mbgVault = await mintBurnGuard.vault()
  checks.push({
    name: "MintBurnGuard.vault() == TBTCVault.address",
    expected: vaultAddress,
    actual: mbgVault,
    passed: addressesMatch(mbgVault, vaultAddress),
    critical: true,
  })

  // Print results
  console.log("\n🔬 Alignment Check Results:")
  checks.forEach(printAlignmentResult)

  // Verify all critical checks pass
  const allPassed = verifyAlignmentChecks(checks)

  if (!allPassed) {
    // Provide specific remediation for the critical Bridge misconfiguration
    const bridgeCheck = checks[2] // Bridge.controllerBalanceIncreaser check
    if (!bridgeCheck.passed) {
      console.log("\n🔧 Remediation for Bridge.controllerBalanceIncreaser:")
      console.log(`   Run: yarn bridge:authorize --network ${hre.network.name}`)
      console.log(`   Set: BRIDGE_CONTROLLER_ADDRESS=${mintBurnGuardAddress}`)
    }

    throw new Error(
      "Configuration drift detected. Deployment verification failed."
    )
  }

  console.log("✅ MintBurnGuard configuration alignment verified.")
}
