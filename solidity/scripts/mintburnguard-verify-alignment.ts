/* eslint-disable no-console */
import { config as dotenvConfig } from "dotenv"
import { ethers, deployments } from "hardhat"
import type { MintBurnGuard, Bridge } from "../typechain-types"

import {
  validateAddress,
  addressesMatch,
  AlignmentCheck,
  printAlignmentResult,
  verifyAlignmentChecks,
} from "./lib/verification"

dotenvConfig({ override: true })

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

function getAddress(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value || value === ZERO_ADDRESS) {
    console.warn(`⚠️  ${name} not set, will attempt to use deployment cache`)
  }
  return value || ""
}

async function main() {
  console.log("🔍 MintBurnGuard Configuration Alignment Check\n")

  // Get addresses from environment variables or deployment cache
  let mintBurnGuardAddress = getAddress(
    "MINTBURN_GUARD_ADDRESS",
    process.env.MINTBURN_GUARD_ADDRESS
  )
  let bridgeAddress = getAddress(
    "BRIDGE_ADDRESS",
    process.env.BRIDGE_PROXY_ADDRESS
  )
  let controllerAddress = getAddress(
    "MINT_BURN_GUARD_CONTROLLER",
    process.env.BRIDGE_GOVERNANCE_ADDRESS
  )
  let bankAddress = getAddress("BANK_ADDRESS")
  let vaultAddress = getAddress("TBTC_VAULT_ADDRESS")

  // Fallback to deployment cache for missing addresses
  if (!mintBurnGuardAddress) {
    try {
      const deployment = await deployments.get("MintBurnGuard")
      mintBurnGuardAddress = deployment.address
      console.log(
        `✅ MintBurnGuard from deployment cache: ${mintBurnGuardAddress}`
      )
    } catch (e) {
      console.log("⚠️  MintBurnGuard not found in deployment cache")
    }
  }

  if (!bridgeAddress) {
    try {
      const deployment = await deployments.get("Bridge")
      bridgeAddress = deployment.address
      console.log(`✅ Bridge from deployment cache: ${bridgeAddress}`)
    } catch (e) {
      console.log("⚠️  Bridge not found in deployment cache")
    }
  }

  if (!controllerAddress) {
    try {
      const deployment = await deployments.get("BridgeGovernance")
      controllerAddress = deployment.address
      console.log(`✅ Controller from deployment cache: ${controllerAddress}`)
    } catch (e) {
      console.log("⚠️  Controller not found in deployment cache")
    }
  }

  if (!bankAddress) {
    try {
      const deployment = await deployments.get("Bank")
      bankAddress = deployment.address
      console.log(`✅ Bank from deployment cache: ${bankAddress}`)
    } catch (e) {
      console.log("⚠️  Bank not found in deployment cache")
    }
  }

  if (!vaultAddress) {
    try {
      const deployment = await deployments.get("TBTCVault")
      vaultAddress = deployment.address
      console.log(`✅ Vault from deployment cache: ${vaultAddress}`)
    } catch (e) {
      console.log("⚠️  Vault not found in deployment cache")
    }
  }

  // Validate required addresses
  validateAddress(mintBurnGuardAddress, "MintBurnGuard")
  validateAddress(bridgeAddress, "Bridge")
  validateAddress(controllerAddress, "Controller")
  validateAddress(bankAddress, "Bank")
  validateAddress(vaultAddress, "Vault")

  console.log("\n📋 Contracts:")
  console.log(`  MintBurnGuard: ${mintBurnGuardAddress}`)
  console.log(`  Bridge: ${bridgeAddress}`)
  console.log(`  Controller: ${controllerAddress}`)
  console.log(`  Bank: ${bankAddress}`)
  console.log(`  Vault: ${vaultAddress}`)

  // Get contract instances
  const mintBurnGuard = await ethers.getContractAt<MintBurnGuard>(
    "MintBurnGuard",
    mintBurnGuardAddress
  )
  const bridge = await ethers.getContractAt<Bridge>("Bridge", bridgeAddress)

  console.log("\n🔬 Alignment Check Results:")

  // Check 1: MintBurnGuard.bridge() == Bridge.address
  const mbgBridge = await mintBurnGuard.bridge()
  const check1: AlignmentCheck = {
    name: "MintBurnGuard.bridge() == Bridge.address",
    expected: bridgeAddress,
    actual: mbgBridge,
    passed: addressesMatch(mbgBridge, bridgeAddress),
    critical: true,
  }
  printAlignmentResult(check1)

  // Check 2: MintBurnGuard.controller() == Controller.address
  const mbgController = await mintBurnGuard.controller()
  const check2: AlignmentCheck = {
    name: "MintBurnGuard.controller() == Controller.address",
    expected: controllerAddress,
    actual: mbgController,
    passed: addressesMatch(mbgController, controllerAddress),
    critical: true,
  }
  printAlignmentResult(check2)

  // Check 3: Bridge.controllerBalanceIncreaser() == MintBurnGuard.address (CRITICAL)
  const bridgeController = await bridge.controllerBalanceIncreaser()
  const check3: AlignmentCheck = {
    name: "Bridge.controllerBalanceIncreaser() == MintBurnGuard.address",
    expected: mintBurnGuardAddress,
    actual: bridgeController,
    passed: addressesMatch(bridgeController, mintBurnGuardAddress),
    critical: true,
  }
  printAlignmentResult(check3)

  // Check 4: MintBurnGuard.bank() == Bank.address
  const mbgBank = await mintBurnGuard.bank()
  const check4: AlignmentCheck = {
    name: "MintBurnGuard.bank() == Bank.address",
    expected: bankAddress,
    actual: mbgBank,
    passed: addressesMatch(mbgBank, bankAddress),
    critical: true,
  }
  printAlignmentResult(check4)

  // Check 5: MintBurnGuard.vault() == TBTCVault.address
  const mbgVault = await mintBurnGuard.vault()
  const check5: AlignmentCheck = {
    name: "MintBurnGuard.vault() == TBTCVault.address",
    expected: vaultAddress,
    actual: mbgVault,
    passed: addressesMatch(mbgVault, vaultAddress),
    critical: true,
  }
  printAlignmentResult(check5)

  // Verify all checks pass
  const checks = [check1, check2, check3, check4, check5]
  const allPassed = verifyAlignmentChecks(checks)

  // Provide specific remediation for failures
  if (!allPassed) {
    if (!check3.passed) {
      console.log("\n🔧 Remediation for Bridge.controllerBalanceIncreaser:")
      console.log(
        `   Fix: Run 'yarn bridge:authorize --network ${ethers.provider.network.name}'`
      )
      console.log(
        `        Set BRIDGE_CONTROLLER_ADDRESS=${mintBurnGuardAddress}`
      )
    }

    if (!check1.passed) {
      console.log("\n🔧 Remediation for MintBurnGuard.bridge():")
      console.log(
        "   Fix: MintBurnGuard may need to be redeployed with correct Bridge address"
      )
      console.log(
        `        Or run wire script: 'yarn mintburn:wire --network ${ethers.provider.network.name}'`
      )
    }

    if (!check2.passed) {
      console.log("\n🔧 Remediation for MintBurnGuard.controller():")
      console.log(
        `   Fix: Run 'yarn mintburn:set-controller --network ${ethers.provider.network.name}'`
      )
      console.log(`        Set MINT_BURN_GUARD_CONTROLLER=${controllerAddress}`)
    }

    if (!check4.passed) {
      console.log("\n🔧 Remediation for MintBurnGuard.bank():")
      console.log(
        "   Fix: MintBurnGuard may need to be redeployed with correct Bank address"
      )
    }

    if (!check5.passed) {
      console.log("\n🔧 Remediation for MintBurnGuard.vault():")
      console.log(
        "   Fix: MintBurnGuard may need to be redeployed with correct Vault address"
      )
    }

    process.exitCode = 1
  } else {
    console.log("\n🎉 All MintBurnGuard configuration alignments are correct!")
  }
}

main().catch((error) => {
  console.error("❌ Alignment check failed:", error)
  process.exitCode = 1
})
