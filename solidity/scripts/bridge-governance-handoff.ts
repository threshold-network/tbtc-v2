/* eslint-disable no-console */
import { config as dotenvConfig } from "dotenv"
import { ethers, getNamedAccounts } from "hardhat"
import type { BridgeGovernance } from "../typechain-types"

dotenvConfig({ override: true })

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

function getEnvAddress(name: string, fallback?: string): string | undefined {
  const value = process.env[name]
  if (value && value.length > 0) {
    return value
  }
  return fallback
}

async function main() {
  console.log("🔄 Governance Transfer Script (with validation)")

  const { governance: namedGovernance, deployer } = await getNamedAccounts()

  const bridgeAddress =
    getEnvAddress("BRIDGE_ADDRESS") ?? getEnvAddress("BRIDGE_PROXY_ADDRESS")
  const currentGovernanceAddress =
    getEnvAddress("BRIDGE_GOVERNANCE_ADDRESS") ??
    process.env.OLD_BRIDGE_GOVERNANCE ??
    ZERO_ADDRESS
  const newGovernanceAddress =
    getEnvAddress("NEW_BRIDGE_GOVERNANCE") ??
    process.env.BRIDGE_GOVERNANCE_NEW ??
    ZERO_ADDRESS
  const signerPrivateKey =
    process.env.BRIDGE_GOVERNANCE_PK ?? process.env.GOVERNANCE_PK ?? undefined

  if (!bridgeAddress || bridgeAddress === ZERO_ADDRESS) {
    throw new Error("BRIDGE_ADDRESS is required for governance transfer.")
  }

  if (!currentGovernanceAddress || !newGovernanceAddress) {
    throw new Error(
      "Both current and new governance addresses must be provided."
    )
  }

  const signer =
    signerPrivateKey && signerPrivateKey.length > 0
      ? new ethers.Wallet(signerPrivateKey, ethers.provider)
      : await ethers.getSigner(namedGovernance ?? deployer)

  console.log("🔑 Signer:", signer.address)

  const bridge = await ethers.getContractAt("Bridge", bridgeAddress)
  const governanceContract = await ethers.getContractAt<BridgeGovernance>(
    "BridgeGovernance",
    currentGovernanceAddress,
    signer
  )

  const owner = await governanceContract.owner()
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the BridgeGovernance owner (${owner}).`
    )
  }

  const onChainGovernance = await bridge.governance()
  if (
    onChainGovernance.toLowerCase() !== currentGovernanceAddress.toLowerCase()
  ) {
    console.warn(
      `⚠️  Bridge currently points to ${onChainGovernance} (expected ${currentGovernanceAddress}).`
    )
  }

  console.log("🏛️  Transferring governance:")
  console.log(`    Current governance: ${currentGovernanceAddress}`)
  console.log(`    Target governance:  ${newGovernanceAddress}`)

  const transferInitiated =
    await governanceContract.bridgeGovernanceTransferChangeInitiated()
  if (transferInitiated.eq(0)) {
    console.log("🚦 Initiating governance transfer...")
    const tx = await governanceContract.beginBridgeGovernanceTransfer(
      newGovernanceAddress
    )
    console.log("📡 beginBridgeGovernanceTransfer tx:", tx.hash)
    await tx.wait(1)
  } else {
    const initiatedTimestamp = transferInitiated.toNumber()
    const delay = await governanceContract.governanceDelays(0)
    const finalizeReadyAt = initiatedTimestamp + delay.toNumber()
    console.log(
      `⏳ Transfer already initiated at ${initiatedTimestamp} (delay ${delay.toString()}s).`
    )
    console.log(`   It can be finalized after unix ${finalizeReadyAt}.`)
  }

  console.log("🕒 Waiting for governance delay (if necessary)...")
  const latestBlock = await ethers.provider.getBlock("latest")
  const delay = await governanceContract.governanceDelays(0)
  const readyAt = transferInitiated.gt(0)
    ? transferInitiated.toNumber() + delay.toNumber()
    : latestBlock.timestamp + delay.toNumber()
  if (latestBlock.timestamp < readyAt) {
    const waitSeconds = readyAt - latestBlock.timestamp
    console.log(
      `⏳ Finalization not yet allowed. Wait ~${waitSeconds}s (unix ${readyAt}) then rerun to finalize.`
    )
    process.exitCode = 1
    return
  }

  console.log("🔄 Finalizing governance transfer...")
  const finalizeTx = await governanceContract.finalizeBridgeGovernanceTransfer()
  console.log("📡 finalizeBridgeGovernanceTransfer tx:", finalizeTx.hash)
  await finalizeTx.wait(1)

  const postGovernance = await bridge.governance()
  console.log("📋 Bridge governance now points to:", postGovernance)

  if (postGovernance.toLowerCase() === newGovernanceAddress.toLowerCase()) {
    console.log("🎉 SUCCESS: Governance transfer complete.")
  } else {
    throw new Error(
      `Bridge governance mismatch after finalize (${postGovernance} !== ${newGovernanceAddress}).`
    )
  }

  const newGovOwner = await ethers
    .getContractAt("BridgeGovernance", newGovernanceAddress, signer)
    .catch(() => null)
  if (newGovOwner) {
    console.log("✅ New governance contract exists and is accessible.")
  }
}

main().catch((error) => {
  console.error("❌ Governance transfer failed:", error)
  process.exitCode = 1
})
