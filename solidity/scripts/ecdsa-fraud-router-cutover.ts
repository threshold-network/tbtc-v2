import fs from "fs"
import path from "path"
import { deployments, ethers, network } from "hardhat"
import type { BigNumber, Contract } from "ethers"
import {
  assertCanonicalInventory,
  assertLegacyGovernanceReadyForHandoff,
  assertLegacyInventorySourcePreflight,
  assertManifestSignature,
  BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
  buildCanonicalInventory,
  buildLegacyInventorySourcePreflight,
  handoffPlanHash,
  HandoffManifest,
  InventoryBundle,
  readLegacyGovernanceStorage,
} from "./ecdsa-fraud-router-cutover-lib"

const CURRENT_PROTOCOL_ID = ethers.utils.id(
  "tbtc/ecdsa-signature-fraud/router/current-v3"
)
const ZERO_ADDRESS = ethers.constants.AddressZero
const ZERO_HASH = ethers.constants.HashZero
const FINALITY_CONFIRMATIONS = 64
const MAX_BLOCKHASH_AGE = 255

type CutoverAction =
  | "inspect"
  | "print-plan-hash"
  | "build-inventory"
  | "begin-governance-handoff"
  | "finalize-governance-handoff"
  | "begin-drain"
  | "stage-inventory"
  | "confirm-inventory"
  | "migrate"
  | "begin-reconciler-update"
  | "finalize-reconciler-update"
  | "confirm-migration"
  | "finalize"

type CutoverState = {
  phase: number
  oldRouter: string
  newRouter: string
  oldRouterCodeHash: string
  newRouterCodeHash: string
  drainBlock: BigNumber
  scanStartBlock: BigNumber
  finalizedBlock: BigNumber
  finalizedBlockHash: string
  challengeSetHash: string
  challengeCount: number
  totalEscrow: BigNumber
  reconciler: string
  inventoryCommitment: string
  postMigrationCommitment: string
  migratedBlock: BigNumber
  migrationConfirmedAt: BigNumber
  governanceDelay: BigNumber
  pendingReconciler: string
  reconcilerUpdateStartedAt: BigNumber
}

const ACTIONS: CutoverAction[] = [
  "inspect",
  "print-plan-hash",
  "build-inventory",
  "begin-governance-handoff",
  "finalize-governance-handoff",
  "begin-drain",
  "stage-inventory",
  "confirm-inventory",
  "migrate",
  "begin-reconciler-update",
  "finalize-reconciler-update",
  "confirm-migration",
  "finalize",
]

const MUTATING_ACTIONS = new Set<CutoverAction>([
  "begin-governance-handoff",
  "finalize-governance-handoff",
  "begin-drain",
  "stage-inventory",
  "confirm-inventory",
  "migrate",
  "finalize",
])

function parseAction(value: string | undefined): CutoverAction {
  const action = (value ?? "inspect") as CutoverAction
  if (!ACTIONS.includes(action)) {
    throw new Error(
      `ECDSA_CUTOVER_ACTION must be one of: ${ACTIONS.join(", ")}`
    )
  }
  return action
}

function manifestPath(): string {
  return (
    process.env.ECDSA_CUTOVER_MANIFEST ??
    path.join(
      __dirname,
      "..",
      "deployments",
      network.name,
      "ecdsa-fraud-router-cutover-manifest.json"
    )
  )
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T
}

function loadManifest(): HandoffManifest {
  const file = manifestPath()
  if (!fs.existsSync(file)) {
    throw new Error(
      `cutover manifest not found at ${file}; run deployment 87 first`
    )
  }
  return readJson<HandoffManifest>(file)
}

function saveManifest(
  manifest: HandoffManifest,
  phase: string,
  action?: string,
  txHash?: string
): void {
  const updated: HandoffManifest = {
    ...manifest,
    phase,
    transactions: {
      ...(manifest.transactions ?? {}),
      ...(action && txHash ? { [action]: txHash } : {}),
    },
  }
  const file = manifestPath()
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`)
  fs.renameSync(temporary, file)
  // Keep subsequent idempotent readback/save steps in this invocation from
  // dropping the transaction hash that was just persisted atomically.
  // eslint-disable-next-line no-param-reassign
  manifest.phase = updated.phase
  // eslint-disable-next-line no-param-reassign
  manifest.transactions = updated.transactions
}

function inventoryPath(required: boolean): string | undefined {
  const file = process.env.ECDSA_CUTOVER_INVENTORY
  if (!file && required) {
    throw new Error("ECDSA_CUTOVER_INVENTORY is required for this action")
  }
  return file
}

function loadInventory(manifest: HandoffManifest): InventoryBundle {
  const file = inventoryPath(true) as string
  const inventory = readJson<InventoryBundle>(file)
  assertCanonicalInventory(manifest, inventory)
  return inventory
}

function normalizeState(raw: any): CutoverState {
  return {
    phase: Number(raw.phase),
    oldRouter: raw.oldRouter,
    newRouter: raw.newRouter,
    oldRouterCodeHash: raw.oldRouterCodeHash,
    newRouterCodeHash: raw.newRouterCodeHash,
    drainBlock: raw.drainBlock,
    scanStartBlock: raw.scanStartBlock,
    finalizedBlock: raw.finalizedBlock,
    finalizedBlockHash: raw.finalizedBlockHash,
    challengeSetHash: raw.challengeSetHash,
    challengeCount: Number(raw.challengeCount),
    totalEscrow: raw.totalEscrow,
    reconciler: raw.reconciler,
    inventoryCommitment: raw.inventoryCommitment,
    postMigrationCommitment: raw.postMigrationCommitment,
    migratedBlock: raw.migratedBlock,
    migrationConfirmedAt: raw.migrationConfirmedAt,
    governanceDelay: raw.governanceDelay,
    pendingReconciler: raw.pendingReconciler,
    reconcilerUpdateStartedAt: raw.reconcilerUpdateStartedAt,
  }
}

async function getState(governance: Contract): Promise<CutoverState> {
  return normalizeState(await governance.ecdsaFraudCutoverState())
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

async function runtimeCodeHash(address: string): Promise<string> {
  const code = await ethers.provider.getCode(address)
  if (code === "0x") throw new Error(`${address} has no runtime bytecode`)
  return ethers.utils.keccak256(code)
}

async function assertCodeHash(
  address: string,
  expected: string
): Promise<void> {
  const actual = await runtimeCodeHash(address)
  if (!sameHash(actual, expected)) {
    throw new Error(
      `runtime code hash mismatch for ${address}: expected ${expected}, got ${actual}`
    )
  }
}

async function assertRouterHandshake(
  address: string,
  bridge: string,
  expectedPredecessor: string,
  expectedPredecessorCodeHash: string
): Promise<void> {
  const router = await ethers.getContractAt("EcdsaFraudRouter", address)
  const [
    boundBridge,
    protocolID,
    predecessor,
    predecessorCodeHash,
    ancestryDepth,
  ] = await Promise.all([
    router.bridge(),
    router.fraudProtocolID(),
    router.predecessor(),
    router.predecessorCodeHash(),
    router.ancestryDepth(),
  ])
  if (!sameAddress(boundBridge, bridge)) {
    throw new Error(
      `${address} is bound to Bridge ${boundBridge}, not ${bridge}`
    )
  }
  if (!sameHash(protocolID, CURRENT_PROTOCOL_ID)) {
    throw new Error(`${address} exposes unsupported ECDSA fraud protocol`)
  }
  if (!sameAddress(predecessor, expectedPredecessor)) {
    throw new Error(
      `${address} inherits ${predecessor}, not signed predecessor ${expectedPredecessor}`
    )
  }
  if (!sameHash(predecessorCodeHash, expectedPredecessorCodeHash)) {
    throw new Error(
      `${address} pins predecessor code hash ${predecessorCodeHash}, not ` +
        `signed hash ${expectedPredecessorCodeHash}`
    )
  }
  if (sameAddress(expectedPredecessor, ZERO_ADDRESS)) {
    if (!sameHash(predecessorCodeHash, ZERO_HASH) || ancestryDepth !== 0) {
      throw new Error(`${address} exposes a non-empty fresh-router ancestry`)
    }
  } else if (ancestryDepth === 0 || ancestryDepth > 8) {
    throw new Error(
      `${address} exposes invalid ancestry depth ${ancestryDepth}`
    )
  }
}

async function assertManifestStatic(
  manifest: HandoffManifest,
  bridge: Contract,
  newGovernance: Contract
): Promise<void> {
  if (manifest.version !== 1) throw new Error("unsupported manifest version")
  if (!manifest.legacyInventorySourcePreflight) {
    throw new Error("manifest lacks signed legacy inventory source preflight")
  }
  assertLegacyInventorySourcePreflight(manifest)
  const { chainId } = await ethers.provider.getNetwork()
  if (manifest.chainId !== chainId) {
    throw new Error(
      `manifest chain ${manifest.chainId} does not match ${chainId}`
    )
  }
  const bridgeDeployment = await deployments.get("Bridge")
  if (!sameAddress(bridgeDeployment.address, manifest.bridge)) {
    throw new Error("manifest Bridge does not match the network deployment")
  }
  if (manifest.scanStartBlock !== manifest.bridgeDeploymentBlock) {
    throw new Error(
      "manifest scan floor must equal the Bridge deployment block"
    )
  }
  if (
    !sameHash(
      manifest.bridgeLegacyFraudStorageLayoutHash,
      BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH
    )
  ) {
    throw new Error("manifest Bridge legacy-fraud storage fingerprint mismatch")
  }
  if (
    bridgeDeployment.receipt?.blockNumber !== undefined &&
    bridgeDeployment.receipt.blockNumber !== manifest.bridgeDeploymentBlock
  ) {
    throw new Error(
      "manifest Bridge deployment block does not match deployment receipt"
    )
  }
  await Promise.all([
    assertCodeHash(
      manifest.oldGovernance,
      manifest.oldGovernanceRuntimeCodeHash
    ),
    assertCodeHash(
      manifest.newGovernance,
      manifest.newGovernanceRuntimeCodeHash
    ),
    assertCodeHash(manifest.oldRouter, manifest.oldRouterRuntimeCodeHash),
    assertCodeHash(
      manifest.replacementRouter,
      manifest.replacementRouterRuntimeCodeHash
    ),
    assertRouterHandshake(
      manifest.replacementRouter,
      manifest.bridge,
      manifest.oldRouter,
      manifest.oldRouterRuntimeCodeHash
    ),
  ])
  const sourcePreflightBlock = await ethers.provider.getBlock(
    manifest.legacyInventorySourcePreflight.finalizedBlock
  )
  if (
    !sourcePreflightBlock?.hash ||
    !sameHash(
      sourcePreflightBlock.hash,
      manifest.legacyInventorySourcePreflight.finalizedBlockHash
    )
  ) {
    throw new Error("signed legacy inventory source block is not canonical")
  }
  const [
    newOwner,
    newDelay,
    pendingDelay,
    pendingDelayStartedAt,
    pendingGovernanceTransferStartedAt,
    currentRouter,
    approvedHash,
    liveGovernance,
    replacementActivationEpoch,
  ] = await Promise.all([
    newGovernance.owner(),
    newGovernance.governanceDelays(0),
    newGovernance.governanceDelays(1),
    newGovernance.governanceDelays(2),
    newGovernance.bridgeGovernanceTransferChangeInitiated(),
    bridge.ecdsaFraudRouter(),
    bridge.ecdsaFraudRouterCodeHash(),
    bridge.governance(),
    (
      await ethers.getContractAt("EcdsaFraudRouter", manifest.replacementRouter)
    ).migratedChallengesActivatedAt(),
  ])
  if (!sameAddress(newOwner, manifest.governanceOwner)) {
    throw new Error(`new BridgeGovernance owner mismatch: ${newOwner}`)
  }
  if (!newDelay.eq(manifest.governanceDelay)) {
    throw new Error(`new BridgeGovernance delay mismatch: ${newDelay}`)
  }
  if (!pendingDelay.isZero() || !pendingDelayStartedAt.isZero()) {
    throw new Error("new BridgeGovernance has a pending delay update")
  }
  if (!pendingGovernanceTransferStartedAt.isZero()) {
    throw new Error("new BridgeGovernance has a pending governance transfer")
  }
  if (
    !sameAddress(liveGovernance, manifest.oldGovernance) &&
    !sameAddress(liveGovernance, manifest.newGovernance)
  ) {
    throw new Error(`unexpected live Bridge.governance(): ${liveGovernance}`)
  }
  if (sameAddress(currentRouter, manifest.oldRouter)) {
    if (!replacementActivationEpoch.isZero()) {
      throw new Error("inactive replacement already has an activation epoch")
    }
    if (
      !sameHash(approvedHash, ZERO_HASH) &&
      !sameHash(approvedHash, manifest.oldRouterRuntimeCodeHash)
    ) {
      throw new Error(
        `Bridge approved an unexpected old-router hash ${approvedHash}`
      )
    }
  } else if (sameAddress(currentRouter, manifest.replacementRouter)) {
    if (replacementActivationEpoch.isZero()) {
      throw new Error("active replacement has no migration activation epoch")
    }
    if (!sameHash(approvedHash, manifest.replacementRouterRuntimeCodeHash)) {
      throw new Error(
        `Bridge replacement-router hash mismatch: ${approvedHash}`
      )
    }
  } else {
    throw new Error(
      `Bridge points to router outside the signed manifest: ${currentRouter}`
    )
  }
}

function requireSignature(manifest: HandoffManifest): void {
  const signature = process.env.ECDSA_CUTOVER_MANIFEST_SIGNATURE
  if (!signature) {
    throw new Error(
      "ECDSA_CUTOVER_MANIFEST_SIGNATURE is required for mutating actions"
    )
  }
  assertManifestSignature(manifest, signature)
}

function requireRecoverySignature(
  manifest: HandoffManifest,
  expectedReconciler: string
): void {
  const signature = process.env.ECDSA_CUTOVER_RECOVERY_SIGNATURE
  if (!signature) {
    throw new Error(
      "ECDSA_CUTOVER_RECOVERY_SIGNATURE is required from the proposed/current recovery reconciler"
    )
  }
  const recovered = ethers.utils.verifyMessage(
    ethers.utils.arrayify(handoffPlanHash(manifest)),
    signature
  )
  if (!sameAddress(recovered, expectedReconciler)) {
    throw new Error(
      `recovery signature is not from reconciler ${expectedReconciler}`
    )
  }
}

function assertActivationInventoryEmpty(inventory: InventoryBundle): void {
  if (
    inventory.challengeKeys.length !== 0 ||
    inventory.challengeCount !== 0 ||
    !ethers.BigNumber.from(inventory.totalEscrow).isZero()
  ) {
    throw new Error(
      "activation requires zero unresolved legacy challenges and zero escrow; migrate/resolve legacy state through the active recovery path before beginning this cutover"
    )
  }
}

async function configuredSigner(address: string) {
  const accounts = await ethers.provider.listAccounts()
  if (!accounts.some((account) => sameAddress(account, address)))
    return undefined
  return ethers.getSigner(address)
}

async function submitOrPrint(
  target: Contract,
  expectedSender: string,
  method: string,
  args: unknown[]
): Promise<string | undefined> {
  const data = target.interface.encodeFunctionData(method, args)
  console.log(`target: ${target.address}`)
  console.log(`data:   ${data}`)
  console.log(`sender: ${expectedSender}`)
  if (process.env.ECDSA_CUTOVER_EXECUTE !== "true") {
    console.log("calldata only; set ECDSA_CUTOVER_EXECUTE=true to submit")
    return undefined
  }
  const signer = await configuredSigner(expectedSender)
  if (!signer) {
    throw new Error(
      `expected sender ${expectedSender} is not a configured signer; submit the printed calldata through its Safe/governance workflow`
    )
  }
  const transaction = await signer.sendTransaction({ to: target.address, data })
  const receipt = await transaction.wait(1)
  if (receipt.status !== 1) throw new Error(`${method} transaction failed`)
  console.log(`submitted ${method}: ${transaction.hash}`)
  return transaction.hash
}

async function requireLiveGovernance(
  bridge: Contract,
  expected: string
): Promise<void> {
  const live = await bridge.governance()
  if (!sameAddress(live, expected)) {
    throw new Error(
      `refusing wrapper call: Bridge.governance() is ${live}, expected ${expected}`
    )
  }
}

async function assertFinalizedWindow(
  inventory: InventoryBundle
): Promise<void> {
  const head = await ethers.provider.getBlockNumber()
  const age = head - inventory.finalizedBlock
  if (age < FINALITY_CONFIRMATIONS || age > MAX_BLOCKHASH_AGE) {
    throw new Error(
      `finalized block age ${age} is outside the required 64-255 block window; rebuild/restage a newer snapshot while the drain remains frozen`
    )
  }
  const block = await ethers.provider.getBlock(inventory.finalizedBlock)
  if (!block?.hash || !sameHash(block.hash, inventory.finalizedBlockHash)) {
    throw new Error(
      "inventory finalized block hash no longer matches the chain"
    )
  }
}

function inventoryFingerprint(inventory: InventoryBundle): string {
  return ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(
      JSON.stringify({
        scanStartBlock: inventory.scanStartBlock,
        scanEndBlock: inventory.scanEndBlock,
        finalizedBlock: inventory.finalizedBlock,
        finalizedBlockHash: inventory.finalizedBlockHash.toLowerCase(),
        challengeKeys: inventory.challengeKeys.map((key) =>
          ethers.BigNumber.from(key).toString()
        ),
        challenges: inventory.challenges.map((challenge) => ({
          challenger: challenge.challenger.toLowerCase(),
          depositAmount: ethers.BigNumber.from(
            challenge.depositAmount
          ).toString(),
          reportedAt: challenge.reportedAt,
          resolved: challenge.resolved,
        })),
        challengeSetHash: inventory.challengeSetHash.toLowerCase(),
        challengeCount: inventory.challengeCount,
        totalEscrow: ethers.BigNumber.from(inventory.totalEscrow).toString(),
        oldRouterOpenChallengeCount: ethers.BigNumber.from(
          inventory.oldRouterOpenChallengeCount
        ).toString(),
        bridgeLegacyEscrowBalance: ethers.BigNumber.from(
          inventory.bridgeLegacyEscrowBalance
        ).toString(),
        sourceEventCount: inventory.sourceEventCount,
        sourceEventDigest: inventory.sourceEventDigest.toLowerCase(),
      })
    )
  )
}

async function independentlyRebuildInventory(
  manifest: HandoffManifest,
  inventory: InventoryBundle
): Promise<void> {
  const canonical = await buildCanonicalInventory(
    ethers.provider,
    manifest,
    inventory.finalizedBlock
  )
  if (
    !sameHash(inventoryFingerprint(inventory), inventoryFingerprint(canonical))
  ) {
    throw new Error(
      "inventory file differs from a fresh canonical-chain rebuild"
    )
  }
}

async function verifySignedSourcePreflight(
  manifest: HandoffManifest
): Promise<void> {
  const signed = manifest.legacyInventorySourcePreflight
  const observed = await buildLegacyInventorySourcePreflight(
    ethers.provider,
    manifest.bridge,
    manifest.scanStartBlock,
    signed.finalizedBlock
  )
  assertLegacyInventorySourcePreflight(manifest, observed)
}

function assertStateManifest(
  state: CutoverState,
  manifest: HandoffManifest
): void {
  if (state.phase === 0) return
  if (
    !sameAddress(state.oldRouter, manifest.oldRouter) ||
    !sameAddress(state.newRouter, manifest.replacementRouter) ||
    !sameHash(state.oldRouterCodeHash, manifest.oldRouterRuntimeCodeHash) ||
    !sameHash(
      state.newRouterCodeHash,
      manifest.replacementRouterRuntimeCodeHash
    ) ||
    !state.scanStartBlock.eq(manifest.scanStartBlock) ||
    !state.governanceDelay.eq(manifest.governanceDelay)
  ) {
    throw new Error("on-chain cutover state differs from the signed manifest")
  }
}

function assertStateInventory(
  state: CutoverState,
  inventory: InventoryBundle
): void {
  if (!stateMatchesInventory(state, inventory)) {
    throw new Error(
      "on-chain inventory commitment fields differ from inventory file"
    )
  }
}

function stateMatchesInventory(
  state: CutoverState,
  inventory: InventoryBundle
): boolean {
  return !(
    !state.finalizedBlock.eq(inventory.finalizedBlock) ||
    !sameHash(state.finalizedBlockHash, inventory.finalizedBlockHash) ||
    !sameHash(state.challengeSetHash, inventory.challengeSetHash) ||
    state.challengeCount !== inventory.challengeCount ||
    !state.totalEscrow.eq(inventory.totalEscrow)
  )
}

async function assertDrainReadback(
  bridge: Contract,
  manifest: HandoffManifest
): Promise<void> {
  const [current, drain, retired] = await Promise.all([
    bridge.ecdsaFraudRouter(),
    bridge.ecdsaFraudRouterInDrain(),
    bridge.isEcdsaFraudRouterRetired(manifest.oldRouter),
  ])
  if (
    !sameAddress(current, manifest.oldRouter) ||
    !sameAddress(drain, manifest.oldRouter) ||
    retired
  ) {
    throw new Error(
      `drain readback mismatch: current=${current}, drain=${drain}, retired=${retired}`
    )
  }
}

async function assertMigratedReadback(
  bridge: Contract,
  manifest: HandoffManifest,
  inventory: InventoryBundle
): Promise<void> {
  const replacement = await ethers.getContractAt(
    "EcdsaFraudRouter",
    manifest.replacementRouter
  )
  const [openCount, unattributedCount, escrow, balance] = await Promise.all([
    replacement.openFraudChallengeCount(),
    replacement.unattributedOpenFraudChallengeCount(),
    replacement.openFraudChallengeEscrow(),
    ethers.provider.getBalance(manifest.replacementRouter),
  ])
  if (
    !openCount.eq(inventory.challengeCount) ||
    !unattributedCount.eq(inventory.challengeCount) ||
    !escrow.eq(inventory.totalEscrow) ||
    balance.lt(escrow)
  ) {
    throw new Error("replacement count/escrow post-migration readback mismatch")
  }
  for (let i = 0; i < inventory.challengeKeys.length; i++) {
    const key = inventory.challengeKeys[i]
    const expected = inventory.challenges[i]
    // Serialize per-key archival reads to avoid bursting a production RPC
    // when the reconciled inventory is large.
    // eslint-disable-next-line no-await-in-loop
    const [legacyExists, migrated] = await Promise.all([
      bridge.legacyFraudChallengeExists(key),
      replacement.fraudChallenges(key),
    ])
    if (
      legacyExists ||
      !sameAddress(migrated.challenger, expected.challenger) ||
      !migrated.depositAmount.eq(expected.depositAmount) ||
      Number(migrated.reportedAt) !== expected.reportedAt ||
      migrated.resolved !== expected.resolved
    ) {
      throw new Error(`post-migration record mismatch for challenge ${key}`)
    }
  }
}

async function updateCanonicalGovernanceAlias(
  manifest: HandoffManifest,
  bridge: Contract
): Promise<void> {
  const live = await bridge.governance()
  if (!sameAddress(live, manifest.newGovernance)) {
    throw new Error(
      "canonical alias cannot move before Bridge.governance readback"
    )
  }
  const distinct = await deployments.get("BridgeGovernanceEcdsaFraudCutover")
  if (!sameAddress(distinct.address, manifest.newGovernance)) {
    throw new Error("distinct new-governance deployment record mismatch")
  }
  const historical = await deployments.getOrNull(
    "BridgeGovernanceBeforeEcdsaCutover"
  )
  if (!historical || !sameAddress(historical.address, manifest.oldGovernance)) {
    throw new Error("historical BridgeGovernance deployment record is missing")
  }
  const canonical = await deployments.get("BridgeGovernance")
  if (
    !sameAddress(canonical.address, manifest.oldGovernance) &&
    !sameAddress(canonical.address, manifest.newGovernance)
  ) {
    throw new Error(
      "canonical BridgeGovernance deployment record is unexpected"
    )
  }
  if (!sameAddress(canonical.address, manifest.newGovernance)) {
    await deployments.save("BridgeGovernance", distinct)
  }
}

async function updateCanonicalRouterAlias(
  manifest: HandoffManifest,
  bridge: Contract
): Promise<void> {
  const [live, drain, retired, approvedHash] = await Promise.all([
    bridge.ecdsaFraudRouter(),
    bridge.ecdsaFraudRouterInDrain(),
    bridge.isEcdsaFraudRouterRetired(manifest.oldRouter),
    bridge.ecdsaFraudRouterCodeHash(),
  ])
  if (
    !sameAddress(live, manifest.replacementRouter) ||
    !sameAddress(drain, ZERO_ADDRESS) ||
    !retired ||
    !sameHash(approvedHash, manifest.replacementRouterRuntimeCodeHash)
  ) {
    throw new Error(
      "canonical router alias cannot move before final Bridge readback"
    )
  }

  const distinct = await deployments.get(
    "EcdsaFraudRouterEcdsaCutoverReplacement"
  )
  if (!sameAddress(distinct.address, manifest.replacementRouter)) {
    throw new Error("distinct replacement-router deployment record mismatch")
  }
  const historical = await deployments.getOrNull(
    "EcdsaFraudRouterBeforeEcdsaCutover"
  )
  if (!historical || !sameAddress(historical.address, manifest.oldRouter)) {
    throw new Error("historical EcdsaFraudRouter record is missing")
  }
  const canonical = await deployments.get("EcdsaFraudRouter")
  if (
    !sameAddress(canonical.address, manifest.oldRouter) &&
    !sameAddress(canonical.address, manifest.replacementRouter)
  ) {
    throw new Error("canonical EcdsaFraudRouter deployment is unexpected")
  }
  if (!sameAddress(canonical.address, manifest.replacementRouter)) {
    await deployments.save("EcdsaFraudRouter", distinct)
  }
}

async function beginGovernanceHandoff(
  manifest: HandoffManifest,
  bridge: Contract
): Promise<void> {
  const live = await bridge.governance()
  if (sameAddress(live, manifest.newGovernance)) {
    console.log("governance handoff is already finalized on chain")
    return
  }
  await requireLiveGovernance(bridge, manifest.oldGovernance)
  const snapshot = await readLegacyGovernanceStorage(
    ethers.provider,
    manifest.oldGovernance
  )
  if (ethers.BigNumber.from(snapshot.bridgeTransferChangeInitiated).isZero()) {
    await assertLegacyGovernanceReadyForHandoff(ethers.provider, manifest)
    const oldGovernance = new ethers.Contract(
      manifest.oldGovernance,
      [
        "function beginBridgeGovernanceTransfer(address)",
        "function owner() view returns (address)",
      ],
      ethers.provider
    )
    const txHash = await submitOrPrint(
      oldGovernance,
      manifest.governanceOwner,
      "beginBridgeGovernanceTransfer",
      [manifest.newGovernance]
    )
    if (!txHash) return
    await assertLegacyGovernanceReadyForHandoff(
      ethers.provider,
      manifest,
      manifest.newGovernance
    )
    saveManifest(manifest, "governance-handoff-pending", "begin", txHash)
  } else {
    await assertLegacyGovernanceReadyForHandoff(
      ethers.provider,
      manifest,
      manifest.newGovernance
    )
    saveManifest(manifest, "governance-handoff-pending")
    console.log("matching governance handoff is already pending")
  }
}

async function finalizeGovernanceHandoff(
  manifest: HandoffManifest,
  bridge: Contract
): Promise<void> {
  const live = await bridge.governance()
  if (!sameAddress(live, manifest.newGovernance)) {
    await requireLiveGovernance(bridge, manifest.oldGovernance)
    await assertLegacyGovernanceReadyForHandoff(
      ethers.provider,
      manifest,
      manifest.newGovernance
    )
    const oldGovernance = new ethers.Contract(
      manifest.oldGovernance,
      ["function finalizeBridgeGovernanceTransfer()"],
      ethers.provider
    )
    const txHash = await submitOrPrint(
      oldGovernance,
      manifest.governanceOwner,
      "finalizeBridgeGovernanceTransfer",
      []
    )
    if (!txHash) return
    const observed = await bridge.governance()
    if (!sameAddress(observed, manifest.newGovernance)) {
      throw new Error(`governance handoff readback failed: ${observed}`)
    }
    saveManifest(manifest, "governance-handoff-finalized", "finalize", txHash)
  }
  await updateCanonicalGovernanceAlias(manifest, bridge)
  saveManifest(manifest, "governance-handoff-finalized")
  console.log(
    "Bridge.governance and canonical deployment alias now point to the new wrapper"
  )
}

async function buildInventory(
  manifest: HandoffManifest,
  governance: Contract
): Promise<void> {
  const state = await getState(governance)
  assertStateManifest(state, manifest)
  if (state.phase !== 1 && state.phase !== 2) {
    throw new Error(
      "inventory can be built/restaged only while drain is frozen"
    )
  }
  const head = await ethers.provider.getBlockNumber()
  const requested = process.env.ECDSA_CUTOVER_FINALIZED_BLOCK
  const finalizedBlock = requested
    ? Number(requested)
    : head - FINALITY_CONFIRMATIONS
  if (!Number.isSafeInteger(finalizedBlock) || finalizedBlock < 0) {
    throw new Error("ECDSA_CUTOVER_FINALIZED_BLOCK is invalid")
  }
  if (finalizedBlock < state.drainBlock.toNumber()) {
    throw new Error(
      "wait until the drain block is at least 64 confirmations deep"
    )
  }
  const inventory = await buildCanonicalInventory(
    ethers.provider,
    manifest,
    finalizedBlock
  )
  await assertFinalizedWindow(inventory)
  const output =
    process.env.ECDSA_CUTOVER_INVENTORY_OUT ??
    path.join(
      path.dirname(manifestPath()),
      `ecdsa-fraud-router-inventory-${finalizedBlock}.json`
    )
  if (
    fs.existsSync(output) &&
    process.env.ECDSA_CUTOVER_OVERWRITE_INVENTORY !== "true"
  ) {
    throw new Error(
      `${output} exists; choose a new output or explicitly set ECDSA_CUTOVER_OVERWRITE_INVENTORY=true`
    )
  }
  fs.writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`)
  console.log(`wrote canonical inventory: ${output}`)
  console.log(`inventory fingerprint: ${inventoryFingerprint(inventory)}`)
}

async function main(): Promise<void> {
  const action = parseAction(process.env.ECDSA_CUTOVER_ACTION)
  const manifest = loadManifest()
  if (action === "print-plan-hash") {
    console.log(handoffPlanHash(manifest))
    return
  }
  if (MUTATING_ACTIONS.has(action)) requireSignature(manifest)

  const bridge = await ethers.getContractAt("Bridge", manifest.bridge)
  const governance = await ethers.getContractAt(
    "BridgeGovernance",
    manifest.newGovernance
  )
  await assertManifestStatic(manifest, bridge, governance)

  if (action === "begin-governance-handoff") {
    await beginGovernanceHandoff(manifest, bridge)
    return
  }
  if (action === "finalize-governance-handoff") {
    await finalizeGovernanceHandoff(manifest, bridge)
    return
  }

  const liveGovernance = await bridge.governance()
  const currentRouter = await bridge.ecdsaFraudRouter()
  const state = await getState(governance)
  assertStateManifest(state, manifest)
  console.log(`network:              ${network.name}`)
  console.log(`Bridge:               ${manifest.bridge}`)
  console.log(`live governance:      ${liveGovernance}`)
  console.log(
    `signed old/new gov:   ${manifest.oldGovernance} -> ${manifest.newGovernance}`
  )
  console.log(`current router:       ${currentRouter}`)
  console.log(`cutover phase:        ${state.phase}`)
  console.log(`current reconciler:   ${state.reconciler}`)
  console.log(`pending reconciler:   ${state.pendingReconciler}`)
  console.log(`signed plan hash:     ${handoffPlanHash(manifest)}`)

  if (action === "inspect") return
  await requireLiveGovernance(bridge, manifest.newGovernance)

  if (action === "build-inventory") {
    await buildInventory(manifest, governance)
    return
  }

  const owner = await governance.owner()
  if (!sameAddress(owner, manifest.governanceOwner)) {
    throw new Error(`new BridgeGovernance owner changed to ${owner}`)
  }

  if (action === "begin-drain") {
    if (state.phase === 0) {
      // This is the last off-chain proof before an intentionally irreversible
      // freeze. Rebuild every signed historical source identity now; forwarded
      // submissions require an unambiguous successful Bridge call trace.
      await verifySignedSourcePreflight(manifest)
      const preDrainFinalizedBlock =
        (await ethers.provider.getBlockNumber()) - FINALITY_CONFIRMATIONS
      if (preDrainFinalizedBlock < manifest.bridgeDeploymentBlock) {
        throw new Error(
          "Bridge must be at least 64 confirmations deep before drain"
        )
      }
      const preDrainInventory = await buildCanonicalInventory(
        ethers.provider,
        manifest,
        preDrainFinalizedBlock
      )
      assertActivationInventoryEmpty(preDrainInventory)
      const txHash = await submitOrPrint(
        governance,
        owner,
        "beginEcdsaFraudRouterDrain",
        [
          manifest.oldRouter,
          manifest.oldRouterRuntimeCodeHash,
          manifest.replacementRouter,
          manifest.replacementRouterRuntimeCodeHash,
          manifest.scanStartBlock,
        ]
      )
      if (!txHash) return
      const observed = await getState(governance)
      assertStateManifest(observed, manifest)
      if (observed.phase !== 1) throw new Error("drain phase readback failed")
      await assertDrainReadback(bridge, manifest)
      saveManifest(manifest, "draining", "begin-drain", txHash)
    } else {
      await assertDrainReadback(bridge, manifest)
      console.log("matching drain is already active")
    }
    return
  }

  const inventory = loadInventory(manifest)

  if (action === "stage-inventory") {
    assertActivationInventoryEmpty(inventory)
    await assertFinalizedWindow(inventory)
    await independentlyRebuildInventory(manifest, inventory)
    if (inventory.finalizedBlock < state.drainBlock.toNumber()) {
      throw new Error("inventory finalized block predates the drain")
    }
    if (
      state.phase === 1 ||
      state.phase === 2 ||
      (state.phase === 3 && !stateMatchesInventory(state, inventory))
    ) {
      const txHash = await submitOrPrint(
        governance,
        owner,
        "stageEcdsaFraudInventory",
        [
          inventory.finalizedBlock,
          inventory.finalizedBlockHash,
          inventory.challengeSetHash,
          inventory.challengeCount,
          inventory.totalEscrow,
          manifest.reconciler,
        ]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (observed.phase !== 2)
        throw new Error("inventory stage readback failed")
      assertStateInventory(observed, inventory)
      await assertDrainReadback(bridge, manifest)
      saveManifest(manifest, "inventory-staged", "stage-inventory", txHash)
    } else {
      assertStateInventory(state, inventory)
      console.log("matching inventory is already confirmed or migrated")
    }
    return
  }

  if (action === "confirm-inventory") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (state.phase === 2) {
      await assertFinalizedWindow(inventory)
      await independentlyRebuildInventory(manifest, inventory)
      const txHash = await submitOrPrint(
        governance,
        manifest.reconciler,
        "confirmEcdsaFraudInventory",
        [state.inventoryCommitment]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (observed.phase !== 3) throw new Error("inventory confirmation failed")
      await assertDrainReadback(bridge, manifest)
      saveManifest(manifest, "inventory-confirmed", "confirm-inventory", txHash)
    } else if (state.phase >= 3) {
      console.log("matching inventory is already independently confirmed")
    } else {
      throw new Error("inventory must be staged before confirmation")
    }
    return
  }

  if (action === "migrate") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (state.phase === 3) {
      await assertFinalizedWindow(inventory)
      const txHash = await submitOrPrint(
        governance,
        owner,
        "migrateEcdsaFraudRouter",
        [inventory.challengeKeys]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (observed.phase !== 4)
        throw new Error("migration phase readback failed")
      await assertDrainReadback(bridge, manifest)
      await assertMigratedReadback(bridge, manifest, inventory)
      saveManifest(manifest, "migrated-drain-still-frozen", "migrate", txHash)
    } else if (state.phase >= 4) {
      await assertDrainReadback(bridge, manifest)
      await assertMigratedReadback(bridge, manifest, inventory)
      console.log(
        "matching inventory is already migrated; drain remains frozen"
      )
    } else {
      throw new Error(
        "inventory must be independently confirmed before migration"
      )
    }
    return
  }

  if (action === "begin-reconciler-update") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (state.phase !== 4) {
      throw new Error("reconciler recovery can begin only in migrated phase")
    }
    await assertDrainReadback(bridge, manifest)
    await assertMigratedReadback(bridge, manifest, inventory)
    const requested = process.env.ECDSA_CUTOVER_RECOVERY_RECONCILER
    if (!requested) {
      throw new Error("ECDSA_CUTOVER_RECOVERY_RECONCILER is required")
    }
    const recoveryReconciler = ethers.utils.getAddress(requested)
    if (
      sameAddress(recoveryReconciler, state.reconciler) ||
      sameAddress(recoveryReconciler, owner) ||
      sameAddress(recoveryReconciler, governance.address)
    ) {
      throw new Error(
        "recovery reconciler must be distinct from governance and the current reconciler"
      )
    }
    requireRecoverySignature(manifest, recoveryReconciler)
    const txHash = await submitOrPrint(
      governance,
      owner,
      "beginEcdsaFraudReconcilerUpdate",
      [recoveryReconciler]
    )
    if (!txHash) return
    const observed = await getState(governance)
    if (
      observed.phase !== 4 ||
      !sameAddress(observed.pendingReconciler, recoveryReconciler) ||
      observed.reconcilerUpdateStartedAt.isZero()
    ) {
      throw new Error("reconciler recovery proposal readback failed")
    }
    saveManifest(
      manifest,
      "reconciler-update-delay-running",
      "begin-reconciler-update",
      txHash
    )
    return
  }

  if (action === "finalize-reconciler-update") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (
      state.phase !== 4 ||
      sameAddress(state.pendingReconciler, ZERO_ADDRESS) ||
      state.reconcilerUpdateStartedAt.isZero()
    ) {
      throw new Error("no phase-four reconciler recovery is pending")
    }
    await assertDrainReadback(bridge, manifest)
    await assertMigratedReadback(bridge, manifest, inventory)
    requireRecoverySignature(manifest, state.pendingReconciler)
    const txHash = await submitOrPrint(
      governance,
      state.pendingReconciler,
      "finalizeEcdsaFraudReconcilerUpdate",
      []
    )
    if (!txHash) return
    const observed = await getState(governance)
    if (
      observed.phase !== 4 ||
      !sameAddress(observed.reconciler, state.pendingReconciler) ||
      !sameAddress(observed.pendingReconciler, ZERO_ADDRESS) ||
      !observed.reconcilerUpdateStartedAt.isZero()
    ) {
      throw new Error("reconciler recovery final readback failed")
    }
    saveManifest(
      manifest,
      "migrated-reconciler-recovered",
      "finalize-reconciler-update",
      txHash
    )
    return
  }

  if (action === "confirm-migration") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (sameAddress(state.reconciler, manifest.reconciler)) {
      requireSignature(manifest)
    } else {
      requireRecoverySignature(manifest, state.reconciler)
    }
    if (state.phase === 4) {
      await assertDrainReadback(bridge, manifest)
      await assertMigratedReadback(bridge, manifest, inventory)
      const txHash = await submitOrPrint(
        governance,
        state.reconciler,
        "confirmEcdsaFraudMigration",
        [inventory.challengeKeys]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (
        observed.phase !== 5 ||
        sameHash(observed.postMigrationCommitment, ZERO_HASH)
      ) {
        throw new Error("independent migration confirmation readback failed")
      }
      saveManifest(
        manifest,
        "migration-confirmed-delay-running",
        "confirm-migration",
        txHash
      )
    } else if (state.phase === 5) {
      await assertMigratedReadback(bridge, manifest, inventory)
      console.log("migration is already independently confirmed")
    } else {
      throw new Error("inventory must be migrated before confirmation")
    }
    return
  }

  if (action === "finalize") {
    assertActivationInventoryEmpty(inventory)
    if (sameAddress(currentRouter, manifest.replacementRouter)) {
      if (state.phase !== 0) {
        throw new Error("active replacement has uncleared cutover state")
      }
      const [drain, retired, approvedHash] = await Promise.all([
        bridge.ecdsaFraudRouterInDrain(),
        bridge.isEcdsaFraudRouterRetired(manifest.oldRouter),
        bridge.ecdsaFraudRouterCodeHash(),
      ])
      if (
        !sameAddress(drain, ZERO_ADDRESS) ||
        !retired ||
        !sameHash(approvedHash, manifest.replacementRouterRuntimeCodeHash)
      ) {
        throw new Error("finalized Bridge router readback mismatch")
      }
      await updateCanonicalRouterAlias(manifest, bridge)
      saveManifest(manifest, "finalized")
      console.log("cutover is already finalized")
      return
    }
    if (state.phase !== 5) {
      throw new Error("migration confirmation and full delay are required")
    }
    assertStateInventory(state, inventory)
    await assertDrainReadback(bridge, manifest)
    await assertMigratedReadback(bridge, manifest, inventory)
    const txHash = await submitOrPrint(
      governance,
      owner,
      "finalizeEcdsaFraudRouterReplacement",
      [inventory.challengeKeys]
    )
    if (!txHash) return
    const [
      observedState,
      observedRouter,
      drain,
      retired,
      approvedHash,
      activationEpoch,
    ] = await Promise.all([
      getState(governance),
      bridge.ecdsaFraudRouter(),
      bridge.ecdsaFraudRouterInDrain(),
      bridge.isEcdsaFraudRouterRetired(manifest.oldRouter),
      bridge.ecdsaFraudRouterCodeHash(),
      (
        await ethers.getContractAt(
          "EcdsaFraudRouter",
          manifest.replacementRouter
        )
      ).migratedChallengesActivatedAt(),
    ])
    if (
      observedState.phase !== 0 ||
      !sameAddress(observedRouter, manifest.replacementRouter) ||
      !sameAddress(drain, ZERO_ADDRESS) ||
      !retired ||
      activationEpoch.isZero() ||
      !sameHash(approvedHash, manifest.replacementRouterRuntimeCodeHash)
    ) {
      throw new Error("final cutover readback failed")
    }
    await updateCanonicalRouterAlias(manifest, bridge)
    saveManifest(manifest, "finalized", "finalize-cutover", txHash)
    console.log(
      "ECDSA router cutover finalized; drain cleared only after delayed readback"
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
