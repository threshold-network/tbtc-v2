import fs from "fs"
import path from "path"
import { ethers as ethersSdk } from "ethers"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { canonicalHistoryCheckpointCommitment } from "../scripts/ecdsa-fraud-router-canonical-history"
import {
  CanonicalHistoryJournalFile,
  loadCanonicalHistoryJournal,
  nextCanonicalHistoryJournal,
  normalizeDurableStoreIdentity,
  saveCanonicalHistoryJournal,
} from "../scripts/ecdsa-fraud-router-journal-store"
import {
  assertIndependentArtifactStores,
  readPrivateFileWithHash,
} from "../scripts/durable-artifact"
import {
  loadCutoverManifest,
  writeCutoverManifest,
} from "../scripts/ecdsa-fraud-router-cutover-artifacts"
import {
  assertCutoverAuthoritySeparation,
  assertLegacyGovernanceReadyForHandoff,
  AuthorityContext,
  BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
  buildLegacyInventorySourcePreflight,
  CanonicalHistoryScan,
  cutoverPreflightTiming,
  discoverHistoryEmitters,
  extendCanonicalHistoryJournal,
  HandoffManifest,
  LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH,
} from "../scripts/ecdsa-fraud-router-cutover-lib"

function requiredBytes32(name: string): string {
  const value = process.env[name]
  if (!value || !ethersSdk.utils.isHexString(value, 32)) {
    throw new Error(`${name} must be bytes32`)
  }
  const normalized = ethersSdk.utils.hexZeroPad(value, 32)
  if (normalized === ethersSdk.constants.HashZero) {
    throw new Error(`${name} cannot be zero`)
  }
  return normalized
}

function authorityContext(role: "SOURCE" | "RECONCILER"): AuthorityContext {
  return {
    durableStoreIdentity: normalizeDurableStoreIdentity(
      requiredBytes32(`ECDSA_CUTOVER_${role}_DURABLE_STORE_IDENTITY`)
    ),
    endpointIdentity: requiredBytes32(
      `ECDSA_CUTOVER_${role}_ENDPOINT_IDENTITY`
    ),
    trustDomain: requiredBytes32(`ECDSA_CUTOVER_${role}_TRUST_DOMAIN`),
    policyHash: requiredBytes32(`ECDSA_CUTOVER_${role}_POLICY_HASH`),
  }
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts, network } = hre
  const { deploy, get, save } = deployments
  const { deployer } = await getNamedAccounts()

  const bridgeDeployment = await get("Bridge")
  const canonicalGovernanceDeployment = await get("BridgeGovernance")
  const bridge = await ethers.getContractAt("Bridge", bridgeDeployment.address)
  const oldGovernanceAddress = await bridge.governance()
  const configuredManifestPath = process.env.ECDSA_CUTOVER_MANIFEST
  const legacyManifestPath = process.env.ECDSA_CUTOVER_MANIFEST_OUT
  if (
    configuredManifestPath &&
    legacyManifestPath &&
    path.resolve(configuredManifestPath) !== path.resolve(legacyManifestPath)
  ) {
    throw new Error(
      "ECDSA_CUTOVER_MANIFEST and legacy ECDSA_CUTOVER_MANIFEST_OUT must identify the same file"
    )
  }
  if (
    !configuredManifestPath &&
    !legacyManifestPath &&
    !["hardhat", "development", "localhost"].includes(network.name)
  ) {
    throw new Error(
      "ECDSA_CUTOVER_MANIFEST is required outside local development networks"
    )
  }
  const outputPath =
    configuredManifestPath ??
    legacyManifestPath ??
    path.join(
      hre.config.paths.deployments,
      network.name,
      "ecdsa-fraud-router-cutover-manifest.json"
    )
  const historicalGovernanceDeployment = await deployments.getOrNull(
    "BridgeGovernanceBeforeEcdsaCutover"
  )
  const historicalRouterDeployment = await deployments.getOrNull(
    "EcdsaFraudRouterBeforeEcdsaCutover"
  )
  if (fs.existsSync(outputPath)) {
    const existing = loadCutoverManifest(outputPath).value
    assertCutoverAuthoritySeparation(existing)
    if (
      existing.chainId !== (await ethers.provider.getNetwork()).chainId ||
      existing.bridge.toLowerCase() !== bridge.address.toLowerCase() ||
      existing.oldGovernance.toLowerCase() !==
        historicalGovernanceDeployment?.address.toLowerCase() ||
      (oldGovernanceAddress.toLowerCase() !==
        existing.oldGovernance.toLowerCase() &&
        oldGovernanceAddress.toLowerCase() !==
          existing.newGovernance.toLowerCase()) ||
      historicalRouterDeployment?.address.toLowerCase() !==
        existing.oldRouter.toLowerCase()
    ) {
      throw new Error(`existing cutover manifest ${outputPath} is inconsistent`)
    }
    console.log(
      `cutover manifest already exists at ${outputPath}; preserving all ` +
        "historical/canonical deployment aliases and resuming through the CLI"
    )
    return
  }
  if (
    canonicalGovernanceDeployment.address.toLowerCase() !==
    oldGovernanceAddress.toLowerCase()
  ) {
    throw new Error(
      `canonical BridgeGovernance deployment ${canonicalGovernanceDeployment.address} ` +
        `is not live Bridge.governance() ${oldGovernanceAddress}; repair the ` +
        "deployment record before preparing handoff"
    )
  }

  // Preserve the incumbent record under a permanent name before creating any
  // replacement. The canonical alias is intentionally untouched until the
  // delayed handoff has finalized and Bridge.governance() is read back.
  if (historicalGovernanceDeployment) {
    if (
      historicalGovernanceDeployment.address.toLowerCase() !==
      oldGovernanceAddress.toLowerCase()
    ) {
      throw new Error(
        "historical BridgeGovernance record already pins a different address"
      )
    }
  } else {
    await save("BridgeGovernanceBeforeEcdsaCutover", {
      ...canonicalGovernanceDeployment,
      address: oldGovernanceAddress,
    })
  }

  const oldGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    oldGovernanceAddress
  )
  const [governanceOwner, governanceDelay, oldRouter] = await Promise.all([
    oldGovernance.owner(),
    oldGovernance.governanceDelays(0),
    bridge.ecdsaFraudRouter(),
  ])
  const canonicalRouterDeployment = await get("EcdsaFraudRouter")
  if (
    canonicalRouterDeployment.address.toLowerCase() !== oldRouter.toLowerCase()
  ) {
    throw new Error(
      `canonical EcdsaFraudRouter ${canonicalRouterDeployment.address} is not ` +
        `live Bridge router ${oldRouter}`
    )
  }
  if (historicalRouterDeployment) {
    if (
      historicalRouterDeployment.address.toLowerCase() !==
      oldRouter.toLowerCase()
    ) {
      throw new Error("historical EcdsaFraudRouter record pins another address")
    }
  } else {
    await save("EcdsaFraudRouterBeforeEcdsaCutover", {
      ...canonicalRouterDeployment,
      address: oldRouter,
    })
  }
  const expectedOldGovernanceCodeHash =
    process.env.ECDSA_CUTOVER_OLD_GOVERNANCE_CODE_HASH
  if (!expectedOldGovernanceCodeHash) {
    throw new Error(
      "ECDSA_CUTOVER_OLD_GOVERNANCE_CODE_HASH is required and must come " +
        "from the reviewed handoff manifest"
    )
  }

  const parameters = await deploy(
    "BridgeGovernanceParametersEcdsaFraudCutover",
    {
      contract: "BridgeGovernanceParameters",
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }
  )
  const verifier = await deploy(
    "EcdsaFraudRouterCutoverVerifierGovernanceLibrary",
    {
      contract: "EcdsaFraudRouterCutoverVerifier",
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }
  )
  const coordinator = await deploy("EcdsaFraudRouterCutoverGovernanceLibrary", {
    contract: "EcdsaFraudRouterCutover",
    from: deployer,
    libraries: {
      EcdsaFraudRouterCutoverVerifier: verifier.address,
    },
    log: true,
    waitConfirmations: 1,
  })
  const newGovernanceDeployment = await deploy(
    "BridgeGovernanceEcdsaFraudCutover",
    {
      contract: "BridgeGovernance",
      from: deployer,
      args: [bridge.address, governanceDelay],
      libraries: {
        BridgeGovernanceParameters: parameters.address,
        EcdsaFraudRouterCutover: coordinator.address,
      },
      log: true,
      waitConfirmations: 1,
    }
  )
  const newGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    newGovernanceDeployment.address
  )
  if (!(await newGovernance.governanceDelays(0)).eq(governanceDelay)) {
    throw new Error(
      "new BridgeGovernance did not preserve the exact live delay"
    )
  }

  const currentNewOwner = await newGovernance.owner()
  if (currentNewOwner.toLowerCase() !== governanceOwner.toLowerCase()) {
    if (currentNewOwner.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error(
        `unexpected new BridgeGovernance owner ${currentNewOwner}`
      )
    }
    const tx = await newGovernance.transferOwnership(governanceOwner)
    await tx.wait(1)
  }
  if (
    (await newGovernance.owner()).toLowerCase() !==
    governanceOwner.toLowerCase()
  ) {
    throw new Error("new BridgeGovernance ownership transfer/readback failed")
  }

  const replacementDeployment = await deploy(
    "EcdsaFraudRouterEcdsaCutoverReplacement",
    {
      contract: "EcdsaFraudRouter",
      from: deployer,
      args: [bridge.address, oldRouter],
      log: true,
      waitConfirmations: 1,
    }
  )
  const requestedReplacement = process.env.ECDSA_CUTOVER_REPLACEMENT
  if (
    requestedReplacement &&
    requestedReplacement.toLowerCase() !==
      replacementDeployment.address.toLowerCase()
  ) {
    throw new Error(
      `ECDSA_CUTOVER_REPLACEMENT ${requestedReplacement} does not match ` +
        `distinct deployment ${replacementDeployment.address}`
    )
  }
  const replacement = ethers.utils.getAddress(replacementDeployment.address)
  const replacementContract = await ethers.getContractAt(
    "EcdsaFraudRouter",
    replacement
  )
  const [
    replacementBridge,
    replacementProtocol,
    replacementOpenCount,
    replacementUnattributedCount,
    replacementEscrow,
    replacementMigratedChallengesActivatedAt,
    replacementPredecessor,
    replacementPredecessorCodeHash,
    replacementAncestryDepth,
    oldRouterRuntimeCode,
  ] = await Promise.all([
    replacementContract.bridge(),
    replacementContract.fraudProtocolID(),
    replacementContract.openFraudChallengeCount(),
    replacementContract.unattributedOpenFraudChallengeCount(),
    replacementContract.openFraudChallengeEscrow(),
    replacementContract.migratedChallengesActivatedAt(),
    replacementContract.predecessor(),
    replacementContract.predecessorCodeHash(),
    replacementContract.ancestryDepth(),
    ethers.provider.getCode(oldRouter),
  ])
  const oldRouterRuntimeCodeHash = ethers.utils.keccak256(oldRouterRuntimeCode)
  if (
    replacementBridge.toLowerCase() !== bridge.address.toLowerCase() ||
    replacementProtocol.toLowerCase() !==
      ethers.utils
        .id("tbtc/ecdsa-signature-fraud/router/current-v3")
        .toLowerCase() ||
    replacementPredecessor.toLowerCase() !== oldRouter.toLowerCase() ||
    replacementPredecessorCodeHash.toLowerCase() !==
      oldRouterRuntimeCodeHash.toLowerCase() ||
    replacementAncestryDepth === 0 ||
    replacementAncestryDepth > 8 ||
    !replacementOpenCount.isZero() ||
    !replacementUnattributedCount.isZero() ||
    !replacementEscrow.isZero() ||
    !replacementMigratedChallengesActivatedAt.isZero()
  ) {
    throw new Error(
      "replacement router is not an empty, Bridge-bound current router"
    )
  }
  const reconciler = process.env.ECDSA_CUTOVER_RECONCILER
  if (!reconciler) throw new Error("ECDSA_CUTOVER_RECONCILER is required")
  const sourceSigner = process.env.ECDSA_CUTOVER_SOURCE_SIGNER
  if (!sourceSigner) throw new Error("ECDSA_CUTOVER_SOURCE_SIGNER is required")
  const sourceId = process.env.ECDSA_CUTOVER_SOURCE_ID
  if (!sourceId || ethers.utils.hexDataLength(sourceId) !== 32) {
    throw new Error("ECDSA_CUTOVER_SOURCE_ID must be bytes32")
  }
  const reconcilerSourceId = process.env.ECDSA_CUTOVER_RECONCILER_SOURCE_ID
  if (
    !reconcilerSourceId ||
    ethers.utils.hexDataLength(reconcilerSourceId) !== 32
  ) {
    throw new Error("ECDSA_CUTOVER_RECONCILER_SOURCE_ID must be bytes32")
  }
  const localSourceId = process.env.ECDSA_CUTOVER_LOCAL_SOURCE_ID
  if (
    !localSourceId ||
    ethers.utils.hexZeroPad(localSourceId, 32).toLowerCase() !==
      ethers.utils.hexZeroPad(sourceId, 32).toLowerCase()
  ) {
    throw new Error(
      "deployment provider must match the pinned canonical source identity"
    )
  }
  const sourceJournalPath = process.env.ECDSA_CUTOVER_SOURCE_JOURNAL
  const reconcilerJournalPath = process.env.ECDSA_CUTOVER_RECONCILER_JOURNAL
  if (!sourceJournalPath || !reconcilerJournalPath) {
    throw new Error(
      "ECDSA_CUTOVER_SOURCE_JOURNAL and ECDSA_CUTOVER_RECONCILER_JOURNAL are required"
    )
  }
  assertIndependentArtifactStores(sourceJournalPath, reconcilerJournalPath)
  const sourceContext = authorityContext("SOURCE")
  const reconcilerContext = authorityContext("RECONCILER")
  if (!fs.existsSync(reconcilerJournalPath)) {
    throw new Error(
      "the independently maintained reconciler journal must exist before deployment"
    )
  }
  loadCanonicalHistoryJournal(
    reconcilerJournalPath,
    ethers.utils.hexZeroPad(reconcilerSourceId, 32),
    reconcilerContext.durableStoreIdentity
  )
  const expectedUnrelatedBridgeBalance =
    process.env.ECDSA_CUTOVER_EXPECTED_UNRELATED_BRIDGE_BALANCE
  if (expectedUnrelatedBridgeBalance === undefined) {
    throw new Error(
      "ECDSA_CUTOVER_EXPECTED_UNRELATED_BRIDGE_BALANCE is required"
    )
  }
  const expectedEmitterBalancesInput =
    process.env.ECDSA_CUTOVER_EXPECTED_UNRELATED_EMITTER_BALANCES
  if (!expectedEmitterBalancesInput) {
    throw new Error(
      "ECDSA_CUTOVER_EXPECTED_UNRELATED_EMITTER_BALANCES JSON is required"
    )
  }
  let expectedEmitterBalances: Record<string, string>
  try {
    expectedEmitterBalances = JSON.parse(expectedEmitterBalancesInput)
  } catch (_) {
    throw new Error(
      "ECDSA_CUTOVER_EXPECTED_UNRELATED_EMITTER_BALANCES must be a JSON object"
    )
  }
  expectedEmitterBalances[bridge.address] = ethers.BigNumber.from(
    expectedUnrelatedBridgeBalance
  ).toString()
  const bridgeDeploymentBlock = bridgeDeployment.receipt?.blockNumber
  if (bridgeDeploymentBlock === undefined) {
    throw new Error("Bridge deployment receipt block is required")
  }
  const head = await ethers.provider.getBlockNumber()
  const preflightConfirmations = Number(
    process.env.ECDSA_CUTOVER_PREFLIGHT_CONFIRMATIONS ?? "64"
  )
  const maximumPreflightAge = Number(
    process.env.ECDSA_CUTOVER_MAX_PREFLIGHT_AGE_BLOCKS ?? "255"
  )
  const minimumBeginSlack = Number(
    process.env.ECDSA_CUTOVER_MIN_BEGIN_SLACK_BLOCKS ?? "16"
  )
  const timing = cutoverPreflightTiming(
    head,
    preflightConfirmations,
    maximumPreflightAge,
    minimumBeginSlack
  )
  const sourcePreflightFinalizedBlock = timing.preflightBlock
  if (sourcePreflightFinalizedBlock < bridgeDeploymentBlock) {
    throw new Error(
      "Bridge deployment must be at least 64 confirmations deep before " +
        "the signed legacy-inventory source preflight can be prepared"
    )
  }
  const historyEmitters = await discoverHistoryEmitters(
    ethers.provider,
    bridge.address,
    oldRouter,
    expectedEmitterBalances
  )
  let checkpoint: CanonicalHistoryScan | undefined
  let previousJournal: CanonicalHistoryJournalFile | undefined
  let previousJournalFileHash: string | undefined
  if (fs.existsSync(sourceJournalPath)) {
    previousJournalFileHash =
      readPrivateFileWithHash(sourceJournalPath).contentHash
    previousJournal = loadCanonicalHistoryJournal(
      sourceJournalPath,
      ethers.utils.hexZeroPad(sourceId, 32),
      sourceContext.durableStoreIdentity
    )
    checkpoint = previousJournal.scan
  }
  const firstUnindexedBlock = checkpoint
    ? checkpoint.evidence.finalizedBlock + 1
    : bridgeDeploymentBlock
  const tailLength = sourcePreflightFinalizedBlock - firstUnindexedBlock + 1
  const maximumJournalTailLength = Number(
    process.env.ECDSA_CUTOVER_MAX_JOURNAL_TAIL_BLOCKS ?? "64"
  )
  if (
    !Number.isSafeInteger(maximumJournalTailLength) ||
    maximumJournalTailLength < 1 ||
    maximumJournalTailLength > 64 ||
    tailLength > maximumJournalTailLength
  ) {
    throw new Error(
      `canonical history journal is stale by ${tailLength} blocks; update it in bounded batches before deployment`
    )
  }
  const updatedJournal = await extendCanonicalHistoryJournal(
    ethers.provider,
    historyEmitters,
    bridgeDeploymentBlock,
    sourcePreflightFinalizedBlock,
    checkpoint
  )
  saveCanonicalHistoryJournal(
    sourceJournalPath,
    nextCanonicalHistoryJournal(
      ethers.utils.hexZeroPad(sourceId, 32),
      sourceContext.durableStoreIdentity,
      updatedJournal,
      previousJournal
    ),
    previousJournalFileHash
      ? { expectedCurrentContentHash: previousJournalFileHash }
      : { createOnly: true }
  )
  const legacyInventorySourcePreflight =
    await buildLegacyInventorySourcePreflight(
      ethers.provider,
      bridge.address,
      bridgeDeploymentBlock,
      sourcePreflightFinalizedBlock,
      historyEmitters,
      updatedJournal
    )
  const manifest: HandoffManifest = {
    version: 5,
    chainId: (await ethers.provider.getNetwork()).chainId,
    bridge: bridge.address,
    bridgeDeploymentBlock,
    oldGovernance: oldGovernanceAddress,
    oldGovernanceRuntimeCodeHash: expectedOldGovernanceCodeHash,
    oldGovernanceStorageLayoutHash: LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH,
    bridgeLegacyFraudStorageLayoutHash: BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
    newGovernance: newGovernance.address,
    newGovernanceRuntimeCodeHash: ethers.utils.keccak256(
      await ethers.provider.getCode(newGovernance.address)
    ),
    governanceOwner,
    governanceDelay: governanceDelay.toString(),
    oldRouter,
    oldRouterRuntimeCodeHash,
    historyEmitters,
    replacementRouter: replacement,
    replacementRouterRuntimeCodeHash: ethers.utils.keccak256(
      await ethers.provider.getCode(replacement)
    ),
    // The canonical floor is immutable and cannot be shortened by a later
    // staging action. Reconciler tooling rejects any inventory with another
    // start block.
    scanStartBlock: bridgeDeploymentBlock,
    expectedUnrelatedBridgeBalance: ethers.BigNumber.from(
      expectedUnrelatedBridgeBalance
    ).toString(),
    legacyInventorySourcePreflight,
    sourceCheckpointCommitment:
      canonicalHistoryCheckpointCommitment(updatedJournal),
    maxTailBlocks: timing.maxTailBlocks,
    evidenceGeneration: 0,
    evidenceAnchorArtifactHash: ethers.constants.HashZero,
    evidencePredecessorArtifactHash: ethers.constants.HashZero,
    sourceSigner: ethers.utils.getAddress(sourceSigner),
    sourceId: ethers.utils.hexZeroPad(sourceId, 32),
    sourceContext,
    reconciler: ethers.utils.getAddress(reconciler),
    reconcilerSourceId: ethers.utils.hexZeroPad(reconcilerSourceId, 32),
    reconcilerContext,
    phase: "new-governance-owned",
  }
  assertCutoverAuthoritySeparation(manifest)
  if (
    !ethers.BigNumber.from(
      legacyInventorySourcePreflight.unrelatedBridgeBalance
    ).eq(manifest.expectedUnrelatedBridgeBalance)
  ) {
    throw new Error(
      "canonical source balance does not match the explicit unrelated-funds allowance"
    )
  }
  await assertLegacyGovernanceReadyForHandoff(ethers.provider, manifest)

  writeCutoverManifest(outputPath, manifest, { createOnly: true })
  console.log(`wrote resumable handoff manifest: ${outputPath}`)
  console.log(
    "BridgeGovernance canonical alias remains the incumbent; use the cutover " +
      "CLI begin/finalize-governance-handoff actions next"
  )
}

export default func

func.tags = ["DeployEcdsaCutoverBridgeGovernance"]
func.dependencies = ["Bridge"]
func.skip = async () => process.env.ECDSA_CUTOVER_DEPLOY_GOVERNANCE !== "true"
