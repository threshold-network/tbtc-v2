/**
 * Generic Account Encryption Script
 * Encrypts any private key to .encrypted-key-N file
 */

import fs from "fs"
import path from "path"
import CryptoJS from "crypto-js"
import { password } from "@inquirer/prompts"

async function main() {
  // Get account number from environment variable
  const accountNumber = process.env.ACCOUNT_NUMBER

  if (!accountNumber || isNaN(Number(accountNumber))) {
    console.error("❌ Please provide a valid account number")
    console.log(
      "Usage: ACCOUNT_NUMBER=2 npx hardhat run scripts/encrypt-account.ts"
    )
    console.log(
      "Example: ACCOUNT_NUMBER=2 npx hardhat run scripts/encrypt-account.ts"
    )
    process.exit(1)
  }

  const encryptedKeyFile =
    accountNumber === "1" ? ".encrypted-key" : `.encrypted-key-${accountNumber}`
  const encryptedKeyPath = path.join(__dirname, "..", encryptedKeyFile)

  console.log(
    `🔐 Setting up encrypted Account #${accountNumber} key storage...`
  )
  console.log(`📁 Target file: ${encryptedKeyFile}`)

  // Check if file already exists
  if (fs.existsSync(encryptedKeyPath)) {
    console.log(`⚠️  Encrypted key file already exists: ${encryptedKeyFile}`)
    console.log("   This will overwrite the existing file.")
  }

  const privateKey = await password({
    message: `Enter Account #${accountNumber} private key (will be encrypted):`,
    mask: "*",
    validate: (input: string) => {
      if (!input || input.length !== 64) {
        return "Private key must be 64 characters long (without 0x prefix)"
      }
      return true
    },
  })

  const masterPassword = await password({
    message: `Create a master password to encrypt Account #${accountNumber} key:`,
    mask: "*",
    validate: (input: string) => {
      if (input.length < 8) {
        return "Master password must be at least 8 characters"
      }
      return true
    },
  })

  const confirmPassword = await password({
    message: "Confirm master password:",
    mask: "*",
    validate: (input: string) => {
      if (input !== masterPassword) {
        return "Passwords do not match"
      }
      return true
    },
  })

  // Encrypt the private key
  const encrypted = CryptoJS.AES.encrypt(privateKey, masterPassword).toString()

  // Store encrypted key
  fs.writeFileSync(encryptedKeyPath, encrypted, { mode: 0o600 })

  console.log(
    `✅ Account #${accountNumber} private key encrypted and stored securely`
  )
  console.log(`📁 Encrypted file: ${encryptedKeyPath}`)
  console.log("⚠️  Remember your master password - it cannot be recovered!")
  console.log("")
  console.log("📝 Next Steps:")
  console.log(`   1. Transfer some ETH to the account address`)
  console.log(
    `   2. Run: ACCOUNT_NUMBER=${accountNumber} npx hardhat run scripts/use-account.ts --network baseSepolia`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
