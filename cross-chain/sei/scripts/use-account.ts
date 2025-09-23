/**
 * Generic Account Usage Script
 * Uses any .encrypted-key-N file to interact with L2TBTC contract
 */

import fs from "fs"
import path from "path"
import CryptoJS from "crypto-js"
import { password } from "@inquirer/prompts"
import { ethers } from "hardhat"

async function getDecryptedAccountKey(accountNumber: string): Promise<string> {
  const encryptedKeyFile =
    accountNumber === "1" ? ".encrypted-key" : `.encrypted-key-${accountNumber}`
  const encryptedKeyPath = path.join(__dirname, "..", encryptedKeyFile)

  if (!fs.existsSync(encryptedKeyPath)) {
    throw new Error(
      `No encrypted Account #${accountNumber} key found. Run encrypt-account.ts first.`
    )
  }

  const masterPassword = await password({
    message: `Enter master password to decrypt Account #${accountNumber} key:`,
    mask: "*",
  })

  try {
    const encryptedData = fs.readFileSync(encryptedKeyPath, "utf8")
    const decrypted = CryptoJS.AES.decrypt(encryptedData, masterPassword)
    const privateKey = decrypted.toString(CryptoJS.enc.Utf8)

    if (!privateKey || privateKey.length !== 64) {
      throw new Error("Invalid password or corrupted key file")
    }

    return privateKey
  } catch (error) {
    throw new Error("Failed to decrypt account key. Check your password.")
  }
}

async function main() {
  // Get account number from environment variable
  const accountNumber = process.env.ACCOUNT_NUMBER

  if (!accountNumber || isNaN(Number(accountNumber))) {
    console.error("❌ Please provide a valid account number")
    console.log(
      "Usage: ACCOUNT_NUMBER=2 npx hardhat run scripts/use-account.ts --network <network>"
    )
    console.log(
      "Example: ACCOUNT_NUMBER=2 npx hardhat run scripts/use-account.ts --network baseSepolia"
    )
    process.exit(1)
  }

  console.log(
    `🔧 Using Account #${accountNumber} to interact with L2TBTC contract...`
  )

  try {
    // Decrypt account private key
    console.log(`🔐 Decrypting Account #${accountNumber} private key...`)
    const privateKey = await getDecryptedAccountKey(accountNumber)

    // Create wallet from decrypted key
    const wallet = new ethers.Wallet(privateKey)
    console.log(`✅ Using Account #${accountNumber}:`, wallet.address)

    // Connect to BaseSepolia provider
    const provider = new ethers.providers.JsonRpcProvider(
      "https://sepolia.base.org"
    )
    const connectedWallet = wallet.connect(provider)

    // Check ETH balance
    const ethBalance = await connectedWallet.getBalance()
    console.log("💰 ETH balance:", ethers.utils.formatEther(ethBalance), "ETH")

    if (ethBalance.eq(0)) {
      console.error("❌ Account has no ETH for gas fees")
      console.log("💡 Transfer some ETH to:", wallet.address)
      process.exit(1)
    }

    // Contract address from fresh deployment
    const proxyAddress = "0x98096d139FCE8d218658e33ce8b767c12E937B0C"

    // Get the L2TBTC contract instance
    const L2TBTC = await ethers.getContractFactory("L2TBTC", connectedWallet)
    const l2tbtc = L2TBTC.attach(proxyAddress)

    console.log("\n📋 Contract Information:")
    console.log("   Proxy Address:", proxyAddress)
    console.log(`   Account #${accountNumber}:`, wallet.address)

    // Check if contract is initialized
    console.log("\n🔍 Checking contract status...")
    let owner: string
    let isInitialized = false

    try {
      owner = await l2tbtc.owner()
      isInitialized = true
      console.log("✅ Contract is already initialized")
    } catch (error) {
      console.log("⚠️  Contract not initialized yet")
      isInitialized = false
    }

    // Initialize contract if needed
    if (!isInitialized) {
      console.log("🚀 Initializing contract...")
      const initTx = await l2tbtc.initialize("Base tBTC v2", "tBTC")
      console.log("   Transaction hash:", initTx.hash)
      console.log("   Waiting for confirmation...")
      await initTx.wait()
      console.log("✅ Contract initialized!")

      // Get the owner after initialization
      owner = await l2tbtc.owner()
      console.log("   Contract owner after init:", owner)
    }

    const isMinter = await l2tbtc.isMinter(wallet.address)
    const tbtcBalance = await l2tbtc.balanceOf(wallet.address)

    console.log("   Contract Owner:", owner)
    console.log(`   Is Account #${accountNumber} Minter?`, isMinter)
    console.log(
      "   Current tBTC Balance:",
      ethers.utils.formatEther(tbtcBalance),
      "tBTC"
    )

    // Transfer ownership if proxy is still the owner or if owner is zero address
    if (
      (owner === proxyAddress ||
        owner === "0x0000000000000000000000000000000000000000") &&
      wallet.address !== owner
    ) {
      console.log(`\n🔄 Transferring ownership to Account #${accountNumber}...`)
      const transferTx = await l2tbtc.transferOwnership(wallet.address)
      console.log("   Transaction hash:", transferTx.hash)
      console.log("   Waiting for confirmation...")
      await transferTx.wait()
      console.log(`✅ Ownership transferred to Account #${accountNumber}!`)

      // Update owner status
      owner = await l2tbtc.owner()
      console.log("   New owner:", owner)
    }

    if (!isMinter) {
      console.log(`\n🪙 Adding Account #${accountNumber} as minter...`)
      const tx = await l2tbtc.addMinter(wallet.address)
      console.log("   Transaction hash:", tx.hash)
      console.log("   Waiting for confirmation...")
      await tx.wait()
      console.log(`✅ Account #${accountNumber} added as minter!`)
    } else {
      console.log(`✅ Account #${accountNumber} is already a minter`)
    }

    // Mint some tokens
    console.log("\n💰 Minting tokens...")
    const mintAmount = ethers.utils.parseEther("1000") // 1000 tBTC
    const mintTx = await l2tbtc.mint(wallet.address, mintAmount)
    console.log("   Transaction hash:", mintTx.hash)
    console.log("   Waiting for confirmation...")
    await mintTx.wait()
    console.log("✅ Minted 1000 tBTC!")

    // Check final status
    console.log("\n📊 Final Status:")
    const finalTbtcBalance = await l2tbtc.balanceOf(wallet.address)
    const totalSupply = await l2tbtc.totalSupply()
    const allMinters = await l2tbtc.getMinters()

    console.log(
      `   Account #${accountNumber} tBTC Balance:`,
      ethers.utils.formatEther(finalTbtcBalance),
      "tBTC"
    )
    console.log(
      "   Total Supply:",
      ethers.utils.formatEther(totalSupply),
      "tBTC"
    )
    console.log("   All Minters:", allMinters)

    console.log(
      `\n🎉 Success! Account #${accountNumber} can now mint and transfer tokens.`
    )
    console.log(
      "🔗 Explorer: https://sepolia.basescan.org/address/" + proxyAddress
    )
  } catch (error: any) {
    console.error("❌ Operation failed:", error.message)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
