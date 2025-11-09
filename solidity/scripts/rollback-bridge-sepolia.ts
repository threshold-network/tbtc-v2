/* eslint-disable no-console */
import fs from "fs"
import path from "path"
import hre from "hardhat"
import type { Contract } from "ethers"
import { Wallet, BigNumber } from "ethers"
import { syncBridgeControllerAuthorizations } from "../deploy/utils/bridge-controller-authorization"

type Address = string

interface BigNumberRecord {
  [key: string]: string
}

interface BridgeSnapshot {
  label: string
  network: string
  timestamp: string
  bridgeAddress: Address
  bridgeImplementation: Address
  bridgeGovernance: Address
  proxyAdmin?: Address
  depositParameters: BigNumberRecord
  redemptionParameters: BigNumberRecord
  movingFundsParameters: BigNumberRecord
  walletParameters: BigNumberRecord
  treasury: Address
  authorizedControllers: { address: Address; authorized: boolean }[]
  trustedVaults: { address: Address; trusted: boolean }[]
  spvMaintainers: { address: Address; trusted: boolean }[]
}

const SNAPSHOT_FILE =
  process.env.BRIDGE_SNAPSHOT_FILE || process.env.SNAPSHOT_OUTFILE
const ROLLBACK_DRY_RUN =
  process.env.BRIDGE_ROLLBACK_DRY_RUN === "true" ||
  process.env.DRY_RUN === "true"

if (
  !process.env.BRIDGE_GOVERNANCE_PK &&
  process.env.TLABS_SEPOLIA_BANK_OWNER_PK
) {
  process.env.BRIDGE_GOVERNANCE_PK =
    process.env.TLABS_SEPOLIA_BANK_OWNER_PK
  console.log(
    "ℹ️  Falling back to TLABS_SEPOLIA_BANK_OWNER_PK for BRIDGE_GOVERNANCE_PK"
  )
}

function requireSnapshotPath(): string {
  if (!SNAPSHOT_FILE) {
    throw new Error(
      "Snapshot file not provided. Set BRIDGE_SNAPSHOT_FILE or SNAPSHOT_OUTFILE."
    )
  }
  return path.resolve(SNAPSHOT_FILE)
}

function loadPreUpgradeSnapshot(): BridgeSnapshot {
  const file = requireSnapshotPath()
  if (!fs.existsSync(file)) {
    throw new Error(`Snapshot file not found: ${file}`)
  }
  const raw = fs.readFileSync(file, "utf8")
  const parsed = JSON.parse(raw) as BridgeSnapshot | BridgeSnapshot[]
  const snapshots: BridgeSnapshot[] = Array.isArray(parsed)
    ? parsed
    : [parsed]

  const preSnapshot =
    snapshots.find((s) => s.label === "pre-upgrade") ?? snapshots[0]

  if (!preSnapshot) {
    throw new Error("Pre-upgrade snapshot not found in snapshot file.")
  }

  return preSnapshot
}

async function main(): Promise<void> {
  if (hre.network.name !== "sepolia") {
    throw new Error(
      `Rollback script is tailored for Sepolia. Current network: ${hre.network.name}`
    )
  }

  const snapshot = loadPreUpgradeSnapshot()
  console.log(
    `Loaded pre-upgrade snapshot (${snapshot.timestamp}) targeting Bridge ${snapshot.bridgeAddress}`
  )

  if (ROLLBACK_DRY_RUN) {
    console.log("🛑 Dry-run enabled, no transactions will be sent.")
  }

  const { deployments, ethers, getNamedAccounts } = hre

  const bridgeDeployment = await deployments.getOrNull("Bridge")
  const bridgeAddress =
    process.env.BRIDGE_ADDRESS ?? bridgeDeployment?.address
  if (!bridgeAddress) {
    throw new Error(
      "Bridge address not available. Provide BRIDGE_ADDRESS or ensure deployments cache exists."
    )
  }

  const proxyAdminDeployment = await deployments.getOrNull(
    "BridgeProxyAdminWithDeputy"
  )
  const proxyAdminAddress =
    proxyAdminDeployment?.address ?? process.env.BRIDGE_PROXY_ADMIN_ADDRESS
  if (!proxyAdminAddress) {
    throw new Error(
      "Bridge proxy admin address not available. Provide BRIDGE_PROXY_ADMIN_ADDRESS."
    )
  }

  const currentBridge: Contract = await ethers.getContractAt(
    "Bridge",
    bridgeAddress
  )
  const currentGovernance: string = await currentBridge.governance()

  console.log(
    `Current Bridge governance: ${currentGovernance}. Pre-upgrade governance: ${snapshot.bridgeGovernance}`
  )

  if (!ROLLBACK_DRY_RUN) {
    await revertBridgeImplementation(
      ethers,
      proxyAdminAddress,
      bridgeAddress,
      snapshot.bridgeImplementation
    )

    await revertBridgeGovernance(
      ethers,
      getNamedAccounts,
      snapshot.bridgeAddress,
      currentGovernance,
      snapshot.bridgeGovernance
    )

    await restoreControllerAllowlist(
      snapshot,
      snapshot.bridgeGovernance
    )
  } else {
    console.log(
      `Dry-run: would revert proxy to implementation ${snapshot.bridgeImplementation}`
    )
    console.log(
      `Dry-run: would transfer governance back to ${snapshot.bridgeGovernance}`
    )
    console.log(
      `Dry-run: would re-sync controller allowlist to ${snapshot.authorizedControllers
        .filter((c) => c.authorized)
        .map((c) => c.address)
        .join(", ")}`
    )
  }

  console.log("Rollback procedure completed.")
}

async function revertBridgeImplementation(
  ethers: typeof hre.ethers,
  proxyAdminAddress: string,
  bridgeAddress: string,
  targetImplementation: string
): Promise<void> {
  console.log("\n[1/3] Reverting Bridge implementation via proxy admin…")

  const signer = await resolveProxyAdminSigner(ethers)
  const proxyAdmin = new ethers.Contract(
    proxyAdminAddress,
    ["function upgrade(address proxy, address implementation) external"],
    signer
  )

  const tx = await proxyAdmin.upgrade(bridgeAddress, targetImplementation)
  console.log(
    `   • Sent upgrade transaction ${tx.hash}, waiting for confirmations…`
  )
  await tx.wait()
  console.log("   • Bridge implementation reverted successfully.")
}

async function resolveProxyAdminSigner(ethers: typeof hre.ethers) {
  if (process.env.PROXY_ADMIN_PK) {
    return new Wallet(process.env.PROXY_ADMIN_PK, ethers.provider)
  }
  const { deployer } = await hre.getNamedAccounts()
  return await ethers.getSigner(deployer)
}

async function revertBridgeGovernance(
  ethers: typeof hre.ethers,
  getNamedAccounts: typeof hre.getNamedAccounts,
  bridgeAddress: string,
  currentGovernance: string,
  targetGovernance: string
): Promise<void> {
  console.log("\n[2/3] Restoring Bridge governance…")

  if (currentGovernance.toLowerCase() === targetGovernance.toLowerCase()) {
    console.log("   • Governance already matches pre-upgrade value, skipping.")
    return
  }

  const governanceSigner = await resolveGovernanceSigner(ethers, getNamedAccounts)
  const bridgeGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    currentGovernance,
    governanceSigner
  )

  // BridgeGovernance exposes governance delay via the public array slot [0].
  const delay: BigNumber = await bridgeGovernance.governanceDelays(0)
  const changeInitiated: BigNumber =
    await bridgeGovernance.bridgeGovernanceTransferChangeInitiated()

  if (changeInitiated.eq(0)) {
    const beginTx = await bridgeGovernance.beginBridgeGovernanceTransfer(
      targetGovernance
    )
    console.log(
      `   • Initiated governance transfer -> ${beginTx.hash}, waiting for receipt…`
    )
    await beginTx.wait()
    console.log(
      `   • Governance transfer initiated. Minimum delay: ${delay.toString()} seconds`
    )
  } else {
    console.log("   • Governance transfer already initiated, skipping begin.")
  }

  const earliestFinalization =
    changeInitiated.eq(0)
      ? (await bridgeGovernance.bridgeGovernanceTransferChangeInitiated()).add(
          delay
        )
      : changeInitiated.add(delay)

  const block = await ethers.provider.getBlock("latest")
  if (block.timestamp < earliestFinalization.toNumber()) {
    const waitSeconds = earliestFinalization.toNumber() - block.timestamp
    console.log(
      `   • Waiting ${waitSeconds} seconds for governance delay to elapse…`
    )
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))
  }

  const finalizeTx = await bridgeGovernance.finalizeBridgeGovernanceTransfer()
  console.log(
    `   • Finalizing governance transfer -> ${finalizeTx.hash}, waiting for receipt…`
  )
  await finalizeTx.wait()

  const bridge = await ethers.getContractAt("Bridge", bridgeAddress)
  const newGovernance = await bridge.governance()
  console.log(
    `   • Governance restored to ${newGovernance}. Expected: ${targetGovernance}`
  )
}

async function resolveGovernanceSigner(
  ethers: typeof hre.ethers,
  getNamedAccounts: typeof hre.getNamedAccounts
) {
  if (process.env.BRIDGE_GOVERNANCE_PK) {
    return new Wallet(process.env.BRIDGE_GOVERNANCE_PK, ethers.provider)
  }
  const { governance } = await getNamedAccounts()
  return await ethers.getSigner(governance)
}

async function restoreControllerAllowlist(
  snapshot: BridgeSnapshot,
  currentGovernance: string
): Promise<void> {
  console.log("\n[3/3] Restoring controller allowlist to pre-upgrade state…")

  const desiredControllers = snapshot.authorizedControllers
    .filter((c) => c.authorized)
    .map((c) => c.address)

  await syncBridgeControllerAuthorizations(hre, {
    bridgeAddress: snapshot.bridgeAddress,
    bridgeGovernanceAddress: currentGovernance,
    increaserAddresses: desiredControllers,
    governancePrivateKey: process.env.BRIDGE_GOVERNANCE_PK || undefined,
  })
}

main().catch((error) => {
  console.error("Bridge rollback failed:", error)
  process.exitCode = 1
})
