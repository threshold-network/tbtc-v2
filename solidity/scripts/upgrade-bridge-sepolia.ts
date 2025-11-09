/* eslint-disable no-console */
import fs from "fs"
import path from "path"
import { BigNumber } from "ethers"
import hre from "hardhat"
import type { Contract } from "ethers"
import upgradeBridge from "../deploy/80_upgrade_bridge_v2"
import deployBridgeGovernance from "../deploy/09_deploy_bridge_governance"
import transferBridgeGovernance from "../deploy/21_transfer_bridge_governance"
import transferBridgeGovernanceOwnership from "../deploy/22_transfer_bridge_governance_ownership"
import configureBridgeControllers from "../deploy/99_configure_bridge_controllers"

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

const SNAPSHOT_OUTFILE = process.env.SNAPSHOT_OUTFILE
const SHOULD_SYNC_CONTROLLERS =
  process.env.SYNC_BRIDGE_CONTROLLERS === "true" ||
  (process.env.BRIDGE_AUTHORIZED_INCREASERS?.length ?? 0) > 0
const DRY_RUN =
  process.env.BRIDGE_UPGRADE_DRY_RUN === "true" ||
  process.env.DRY_RUN === "true" ||
  process.argv.includes("--dry-run")

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

if (!SNAPSHOT_OUTFILE) {
  console.warn(
    "⚠️  SNAPSHOT_OUTFILE not set; snapshots will only be printed to the console."
  )
}

function assertPrerequisites(): void {
  if (!process.env.USE_EXTERNAL_DEPLOY) {
    console.warn(
      "⚠️  USE_EXTERNAL_DEPLOY is not set; make sure Sepolia uses external deploy keys."
    )
  }
  if (SHOULD_SYNC_CONTROLLERS && !process.env.BRIDGE_GOVERNANCE_PK) {
    console.warn(
      "⚠️  Controller sync requested but BRIDGE_GOVERNANCE_PK is not configured. Falling back to Hardhat named account `governance`."
    )
  }
  const networkUrl = (hre.network.config as any).url ?? ""
  if (!networkUrl || networkUrl.trim().length === 0) {
    const message =
      "Sepolia RPC URL is not configured. Set SEPOLIA_CHAIN_API_URL in your environment."
    if (DRY_RUN) {
      console.warn(`⚠️  ${message}`)
    } else {
      throw new Error(message)
    }
  }
}

async function main(): Promise<void> {
  if (hre.network.name !== "sepolia") {
    throw new Error(
      `This script is tailored for Sepolia. Current network: ${hre.network.name}`
    )
  }

  assertPrerequisites()

  console.log("🚀 Starting Bridge upgrade orchestration for Sepolia")

  let preSnapshot: BridgeSnapshot | undefined
  try {
    preSnapshot = await snapshotWithRetry("pre-upgrade")
    await persistSnapshot(preSnapshot)
  } catch (error) {
    if (DRY_RUN) {
      console.warn(
        "⚠️  Failed to capture pre-upgrade snapshot during dry run:",
        error
      )
    } else {
      throw error
    }
  }

  if (DRY_RUN) {
    console.log(
      "\n🛑 Dry-run mode enabled. Skipping on-chain transactions after recording pre-upgrade snapshot."
    )
    return
  }

  console.log("\n[1/4] Upgrading Bridge implementation…")
  await upgradeBridge(hre)

  console.log("[2/4] Redeploying BridgeGovernance…")
  await deleteDeploymentIfExists("BridgeGovernance")
  await deleteDeploymentIfExists("BridgeGovernanceParameters")
  await deployBridgeGovernance(hre)

  console.log("[3/4] Transferring Bridge governance to the new contract…")
  await transferBridgeGovernance(hre)

  // Ensure the freshly deployed BridgeGovernance is owned by the configured
  // governance account (not the deployer), to match mainnet practices.
  try {
    await transferBridgeGovernanceOwnership(hre)
  } catch (error) {
    console.warn(
      "⚠️  BridgeGovernance ownership transfer step failed or was skipped:",
      error
    )
  }

  if (!preSnapshot) {
    throw new Error("Pre-upgrade snapshot missing; cannot reapply governance state.")
  }
  await reapplyGovernanceState(preSnapshot)

  if (SHOULD_SYNC_CONTROLLERS) {
    console.log("[4/4] Synchronizing authorized controller allowlist…")
    await configureBridgeControllers(hre)
  } else {
    console.log(
      "[4/4] Skipping controller allowlist sync (set SYNC_BRIDGE_CONTROLLERS=true or provide BRIDGE_AUTHORIZED_INCREASERS to run automatically)"
    )
  }

  const postSnapshot = await snapshotWithRetry("post-upgrade")
  await persistSnapshot(postSnapshot)

  logSummary(preSnapshot, postSnapshot)
}

async function snapshotBridgeState(label: string): Promise<BridgeSnapshot> {
  const { deployments, ethers } = hre

  const bridgeDeployment = await deployments.getOrNull("Bridge")
  const bridgeAddress =
    process.env.BRIDGE_ADDRESS ?? bridgeDeployment?.address
  if (!bridgeAddress) {
    throw new Error(
      "Bridge address not found. Provide BRIDGE_ADDRESS in environment or ensure deployments cache exists."
    )
  }
  const bridge: Contract = await ethers.getContractAt(
    "Bridge",
    bridgeAddress
  )

  const proxyAdminDeployment = await deployments.getOrNull(
    "BridgeProxyAdminWithDeputy"
  )
  let proxyImplementation = "0x0000000000000000000000000000000000000000"
  let proxyAdminAddress: string | undefined
  if (proxyAdminDeployment) {
    proxyAdminAddress = proxyAdminDeployment.address
    const proxyAdmin = await ethers.getContractAt(
      ["function getProxyImplementation(address) view returns (address)"],
      proxyAdminDeployment.address
    )
    proxyImplementation = await proxyAdmin.getProxyImplementation(
      bridgeAddress
    )
  } else {
    proxyAdminAddress = process.env.BRIDGE_PROXY_ADMIN_ADDRESS
    if (!proxyAdminAddress) {
      throw new Error(
        "BridgeProxyAdminWithDeputy deployment not found and BRIDGE_PROXY_ADMIN_ADDRESS not provided."
      )
    }
    const proxyContract = await ethers.getContractAt(
      ["function implementation() view returns (address)"],
      bridgeAddress
    )
    try {
      proxyImplementation = await proxyContract.implementation()
    } catch {
      proxyImplementation =
        process.env.BRIDGE_IMPLEMENTATION_ADDRESS ?? proxyImplementation
    }
  }

  const bridgeGovernanceAddress: string =
    process.env.BRIDGE_GOVERNANCE_ADDRESS ?? (await bridge.governance())

  const depositParameters = await bridge.depositParameters()
  const redemptionParameters = await bridge.redemptionParameters()
  const movingFundsParameters = await bridge.movingFundsParameters()
  const walletParameters = await bridge.walletParameters()
  const treasuryAddress: string = await bridge.treasury()

  const skipEvents =
    process.env.BRIDGE_SNAPSHOT_SKIP_EVENTS === "true" && label === "pre-upgrade"

  const controllerMap = await fetchAuthorizedControllers(
    bridge,
    getBridgeDeployBlock(bridgeDeployment),
    label,
    skipEvents
  )
  const vaultStatusMap = await fetchAddressStatuses(
    bridge,
    bridge.filters.VaultStatusUpdated(),
    getBridgeDeployBlock(bridgeDeployment),
    label,
    skipEvents
  )
  const spvStatusMap = await fetchAddressStatuses(
    bridge,
    bridge.filters.SpvMaintainerStatusUpdated(),
    getBridgeDeployBlock(bridgeDeployment),
    label,
    skipEvents
  )

  return {
    label,
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    bridgeAddress,
    bridgeImplementation: proxyImplementation,
    bridgeGovernance: bridgeGovernanceAddress,
    proxyAdmin: proxyAdminAddress,
    depositParameters: toRecord(depositParameters),
    redemptionParameters: toRecord(redemptionParameters),
    movingFundsParameters: toRecord(movingFundsParameters),
    walletParameters: toRecord(walletParameters),
    treasury: treasuryAddress,
    authorizedControllers: Array.from(controllerMap.entries())
      .map(([address, authorized]) => ({ address, authorized }))
      .sort((a, b) => a.address.localeCompare(b.address)),
    trustedVaults: Array.from(vaultStatusMap.entries())
      .map(([address, trusted]) => ({ address, trusted }))
      .sort((a, b) => a.address.localeCompare(b.address)),
    spvMaintainers: Array.from(spvStatusMap.entries())
      .map(([address, trusted]) => ({ address, trusted }))
      .sort((a, b) => a.address.localeCompare(b.address)),
  }
}

async function snapshotWithRetry(
  label: string,
  attempts = 5
): Promise<BridgeSnapshot> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await snapshotBridgeState(label)
    } catch (error: any) {
      lastError = error
      const isRateLimited =
        typeof error?.message === "string" &&
        /Too Many Requests/i.test(error.message)
      const isNetworkError =
        error?.code === "NETWORK_ERROR" ||
        (typeof error?.message === "string" &&
          /could not detect network/i.test(error.message))
      if ((isRateLimited || isNetworkError) && i < attempts - 1) {
        const backoffMs = 2000 * (i + 1)
        console.warn(
          `⚠️  Provider issue (${isRateLimited ? "rate limited" : "network error"}) while capturing ${label} snapshot. Retrying in ${
            backoffMs / 1000
          }s…`
        )
        await delay(backoffMs)
        continue
      }
      throw error
    }
  }
  throw lastError
}

async function fetchAuthorizedControllers(
  bridge: Contract,
  fromBlock: number | undefined,
  label: string,
  skip: boolean
): Promise<Map<string, boolean>> {
  if (skip || (DRY_RUN && label === "pre-upgrade")) {
    return new Map()
  }
  const controllerMap = new Map<string, boolean>()
  const filter = bridge.filters.AuthorizedBalanceIncreaserUpdated()

  const events = await bridge.queryFilter(
    filter,
    fromBlock ?? 0,
    "latest"
  )

  for (const event of events) {
    const increaser = (event.args?.increaser ?? "") as string
    const authorized = (event.args?.authorized ?? false) as boolean
    if (!increaser) continue
    controllerMap.set(increaser, authorized)
  }

  return controllerMap
}

async function fetchAddressStatuses(
  bridge: Contract,
  filter: any,
  fromBlock: number | undefined,
  label: string,
  skip: boolean
): Promise<Map<string, boolean>> {
  if (skip || (DRY_RUN && label === "pre-upgrade")) {
    return new Map()
  }
  const statusMap = new Map<string, boolean>()
  const events = await bridge.queryFilter(filter, fromBlock ?? 0, "latest")
  for (const event of events) {
    const target = (event.args?.[0] ?? "") as string
    const flag = (event.args?.[1] ?? false) as boolean
    if (!target) continue
    statusMap.set(target, flag)
  }
  return statusMap
}

async function deleteDeploymentIfExists(name: string): Promise<void> {
  const { deployments } = hre
  const existing = await deployments.getOrNull(name)
  if (!existing) return
  await deployments.delete(name)
  console.log(`   • Removed cached deployment record for ${name}`)
}

async function reapplyGovernanceState(
  snapshot: BridgeSnapshot
): Promise<void> {
  const { deployments, ethers, getNamedAccounts } = hre
  const deployment = await deployments.getOrNull("BridgeGovernance")
  const bridgeGovernanceAddress =
    deployment?.address ?? process.env.BRIDGE_GOVERNANCE_ADDRESS
  if (!bridgeGovernanceAddress) {
    console.warn(
      "   • BridgeGovernance deployment not found and BRIDGE_GOVERNANCE_ADDRESS missing; skipping governance state reapplication."
    )
    return
  }

  let signerAddress: string
  let signer = undefined
  if (process.env.BRIDGE_GOVERNANCE_PK) {
    signer = new ethers.Wallet(process.env.BRIDGE_GOVERNANCE_PK, ethers.provider)
    signerAddress = signer.address
  } else {
    const { governance } = await getNamedAccounts()
    signer = await ethers.getSigner(governance)
    signerAddress = await signer.getAddress()
  }

  console.log(`   • Using governance signer ${signerAddress} to reapply state`)

  const bridgeGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    bridgeGovernanceAddress,
    signer
  )

  let operations = 0

  for (const entry of snapshot.trustedVaults) {
    if (!entry.trusted) continue
    if (entry.address === "0x0000000000000000000000000000000000000000") {
      continue
    }
    operations += 1
    const tx = await bridgeGovernance.setVaultStatus(entry.address, true)
    console.log(
      `     - setVaultStatus(${entry.address}, true) -> ${tx.hash}`
    )
    await tx.wait()
  }

  for (const entry of snapshot.spvMaintainers) {
    if (!entry.trusted) continue
    if (entry.address === "0x0000000000000000000000000000000000000000") {
      continue
    }
    operations += 1
    const tx = await bridgeGovernance.setSpvMaintainerStatus(
      entry.address,
      true
    )
    console.log(
      `     - setSpvMaintainerStatus(${entry.address}, true) -> ${tx.hash}`
    )
    await tx.wait()
  }

  if (operations === 0) {
    console.log("   • No vault or SPV maintainer statuses to reapply.")
  }
}

function toRecord(struct: any): BigNumberRecord {
  return Object.entries(struct)
    .filter(([key]) => Number.isNaN(Number(key))) // drop numeric indexes
    .reduce<BigNumberRecord>((acc, [key, value]) => {
      acc[key] = BigNumber.isBigNumber(value)
        ? value.toString()
        : String(value)
      return acc
    }, {})
}

async function persistSnapshot(snapshot: BridgeSnapshot): Promise<void> {
  if (!SNAPSHOT_OUTFILE) {
    console.log(
      `\nSnapshot (${snapshot.label}):\n${JSON.stringify(
        snapshot,
        null,
        2
      )}`
    )
    return
  }

  const filePath = path.resolve(SNAPSHOT_OUTFILE)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  let existing: BridgeSnapshot[] = []
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8")
      existing = JSON.parse(raw)
      if (!Array.isArray(existing)) {
        existing = []
      }
    } catch (error) {
      console.warn(
        `⚠️  Failed to read existing snapshot file ${filePath}:`,
        error
      )
      existing = []
    }
  }
  existing.push(snapshot)
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2))
  console.log(`Snapshot (${snapshot.label}) written to ${filePath}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logSummary(
  pre: BridgeSnapshot,
  post: BridgeSnapshot
): void {
  console.log("\n✅ Upgrade sequence complete. Summary:")
  console.log(
    `  • Bridge implementation: ${pre.bridgeImplementation} -> ${post.bridgeImplementation}`
  )
  console.log(
    `  • Bridge governance: ${pre.bridgeGovernance} -> ${post.bridgeGovernance}`
  )
  console.log(`  • Treasury: ${post.treasury}`)
  console.log(
    `  • Authorized controllers (${post.authorizedControllers.length}):`
  )
  post.authorizedControllers.forEach((entry) =>
    console.log(
      `      - ${entry.address} :: ${entry.authorized ? "authorized" : "revoked"}`
    )
  )
}

function getBridgeDeployBlock(
  bridgeDeployment: Awaited<
    ReturnType<typeof hre["deployments"]["getOrNull"]>
  >
): number | undefined {
  if (process.env.BRIDGE_DEPLOY_BLOCK) {
    return Number(process.env.BRIDGE_DEPLOY_BLOCK)
  }
  const block = bridgeDeployment?.receipt?.blockNumber
  return block
}

main().catch((error) => {
  console.error("Bridge upgrade orchestration failed:", error)
  process.exitCode = 1
})
