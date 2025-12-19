/* eslint-disable no-console */
import { config as dotenvConfig } from "dotenv"
import { ethers, deployments, getNamedAccounts } from "hardhat"

dotenvConfig({ override: true })

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

async function main(): Promise<void> {
  console.log("\n🔧 MintBurnGuard controller wiring")

  const { governance, deployer } = await getNamedAccounts()

  const mintBurnGuardAddress =
    process.env.MINTBURN_GUARD_ADDRESS ||
    (await deployments.getOrNull("MintBurnGuard"))?.address
  if (!mintBurnGuardAddress || mintBurnGuardAddress === ZERO_ADDRESS) {
    throw new Error(
      "MintBurnGuard address missing. Set MINTBURN_GUARD_ADDRESS or ensure the deployment cache exists."
    )
  }

  const targetController =
    process.env.MINT_BURN_GUARD_CONTROLLER ||
    process.env.MINTBURN_GUARD_CONTROLLER
  if (!targetController || targetController === ZERO_ADDRESS) {
    throw new Error(
      "Target controller missing. Set MINT_BURN_GUARD_CONTROLLER in the environment (AccountControl address)."
    )
  }

  const signerPrivateKey =
    process.env.MINTBURN_GUARD_OWNER_PK ||
    process.env.BRIDGE_GOVERNANCE_PK ||
    process.env.GOVERNANCE_PK

  const signer = signerPrivateKey
    ? new ethers.Wallet(signerPrivateKey, ethers.provider)
    : await ethers.getSigner(governance ?? deployer)

  console.log("🛡️  MintBurnGuard:", mintBurnGuardAddress)
  console.log("🎯 Target controller:", targetController)
  console.log("🔑 Signer:", signer.address)

  const mintBurnGuard = await ethers.getContractAt(
    "MintBurnGuard",
    mintBurnGuardAddress,
    signer
  )

  const owner = await mintBurnGuard.owner()
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the MintBurnGuard owner (${owner}).`
    )
  }

  const currentController = await mintBurnGuard.controller()
  console.log("📋 Current controller:", currentController)

  if (currentController.toLowerCase() === targetController.toLowerCase()) {
    console.log("✅ Controller already matches target; nothing to do.")
    return
  }

  console.log("🧾 Submitting setController transaction...")
  const tx = await mintBurnGuard.setController(targetController)
  console.log("📡 Transaction hash:", tx.hash)
  await tx.wait(1)

  const updatedController = await mintBurnGuard.controller()
  console.log("📋 Updated controller:", updatedController)
  if (updatedController.toLowerCase() !== targetController.toLowerCase()) {
    throw new Error("MintBurnGuard controller mismatch after transaction.")
  }

  console.log("🎉 MintBurnGuard controller wiring completed.")
}

main().catch((error) => {
  console.error("❌ MintBurnGuard controller wiring failed:", error)
  process.exit(1)
})
