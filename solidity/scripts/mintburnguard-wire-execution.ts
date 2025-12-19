/* eslint-disable no-console */

import { config as dotenvConfig } from "dotenv"
import { deployments, ethers, getNamedAccounts } from "hardhat"

dotenvConfig({ override: true })

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

async function main(): Promise<void> {
  console.log("\n🔧 MintBurnGuard execution target wiring")

  const { deployer, governance } = await getNamedAccounts()

  const mintBurnGuardAddress =
    process.env.MINTBURN_GUARD_ADDRESS ||
    (await deployments.getOrNull("MintBurnGuard"))?.address

  if (!mintBurnGuardAddress || mintBurnGuardAddress === ZERO_ADDRESS) {
    throw new Error(
      "MintBurnGuard address missing. Set MINTBURN_GUARD_ADDRESS or ensure deployment cache exists."
    )
  }

  const bridgeAddress = process.env.BRIDGE_ADDRESS
  const bankAddress = process.env.BANK_ADDRESS
  const vaultAddress = process.env.TBTC_VAULT_ADDRESS

  validateAddress(bridgeAddress, "BRIDGE_ADDRESS")
  validateAddress(bankAddress, "BANK_ADDRESS")
  validateAddress(vaultAddress, "TBTC_VAULT_ADDRESS")

  const signerPrivateKey =
    readPrivateKey(
      process.env.MINTBURN_GUARD_OWNER_PK,
      "MINTBURN_GUARD_OWNER_PK"
    ) ??
    readPrivateKey(
      process.env.BRIDGE_GOVERNANCE_PK,
      "BRIDGE_GOVERNANCE_PK"
    ) ??
    readPrivateKey(process.env.GOVERNANCE_PK, "GOVERNANCE_PK")

  const signer = signerPrivateKey
    ? new ethers.Wallet(signerPrivateKey, ethers.provider)
    : await ethers.getSigner(governance ?? deployer)

  console.log("🛡️  MintBurnGuard:", mintBurnGuardAddress)
  console.log("🏛️  Bridge:", bridgeAddress)
  console.log("🏦  Bank:", bankAddress)
  console.log("🔐 Vault:", vaultAddress)
  console.log("🔑 Signer:", signer.address)

  const guard = await ethers.getContractAt(
    "MintBurnGuard",
    mintBurnGuardAddress,
    signer
  )

  const owner = await guard.owner()
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the MintBurnGuard owner (${owner}).`
    )
  }

  console.log("📋 Current targets:")
  console.log("   bridge:", await guard.bridge())
  console.log("   bank:", await guard.bank())
  console.log("   vault:", await guard.vault())

  console.log("🧾 Submitting configureExecutionTargets…")
  const tx = await guard.configureExecutionTargets(
    bridgeAddress as string,
    bankAddress as string,
    vaultAddress as string
  )
  console.log("📡 Tx:", tx.hash)
  await tx.wait(1)

  console.log("✅ Wiring complete. Updated targets:")
  console.log("   bridge:", await guard.bridge())
  console.log("   bank:", await guard.bank())
  console.log("   vault:", await guard.vault())
}

function validateAddress(value: string | undefined, name: string): void {
  if (!value || value === ZERO_ADDRESS) {
    throw new Error(`${name} must be set to a non-zero address.`)
  }
}

function readPrivateKey(
  value: string | undefined,
  name: string
): string | undefined {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (ethers.utils.isHexString(trimmed, 32)) {
    return trimmed
  }
  console.warn(`⚠️  ${name} is set but invalid; ignoring.`)
  return undefined
}

main().catch((error) => {
  console.error("❌ MintBurnGuard wiring failed:", error)
  process.exitCode = 1
})
