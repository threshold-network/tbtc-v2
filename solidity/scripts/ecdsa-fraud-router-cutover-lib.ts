import { BigNumber, ethers, providers } from "ethers"

export const LEGACY_GOVERNANCE_STORAGE_LAYOUT = {
  contract: "BridgeGovernance",
  compiler: "0.8.17",
  ownerSlot: 0,
  pendingParameterSlots: { first: 1, last: 68 },
  bridgeSlot: 69,
  governanceDelaySlots: { current: 70, pending: 71, initiatedAt: 72 },
  bridgeTransferSlots: { initiatedAt: 73, newGovernance: 74 },
} as const

export const LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(JSON.stringify(LEGACY_GOVERNANCE_STORAGE_LAYOUT))
)

export const BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT = {
  contract: "Bridge",
  compiler: "0.8.17",
  bridgeSelfSlot: 51,
  fraudChallengesRelativeSlot: 25,
  fraudChallengesAbsoluteSlot: 76,
  valueSlots: {
    challenger: 0,
    depositAmount: 1,
    reportedAtAndResolved: 2,
  },
} as const

export const BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(JSON.stringify(BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT))
)

export type HandoffManifest = {
  version: 1
  chainId: number
  bridge: string
  bridgeDeploymentBlock: number
  oldGovernance: string
  oldGovernanceRuntimeCodeHash: string
  oldGovernanceStorageLayoutHash: string
  bridgeLegacyFraudStorageLayoutHash: string
  newGovernance: string
  newGovernanceRuntimeCodeHash: string
  governanceOwner: string
  governanceDelay: string
  oldRouter: string
  oldRouterRuntimeCodeHash: string
  replacementRouter: string
  replacementRouterRuntimeCodeHash: string
  scanStartBlock: number
  legacyInventorySourcePreflight: LegacyInventorySourcePreflight
  reconciler: string
  phase: string
  transactions?: Record<string, string>
}

export type LegacyInventorySourcePreflight = {
  finalizedBlock: number
  finalizedBlockHash: string
  sourceEventCount: number
  sourceEventDigest: string
  challengeIdentityCount: number
  challengeIdentityDigest: string
}

export type InventoryBundle = {
  scanStartBlock: number
  scanEndBlock: number
  finalizedBlock: number
  finalizedBlockHash: string
  challengeKeys: string[]
  challenges: Array<{
    challenger: string
    depositAmount: string
    reportedAt: number
    resolved: boolean
  }>
  challengeSetHash: string
  challengeCount: number
  totalEscrow: string
  oldRouterOpenChallengeCount: string
  bridgeLegacyEscrowBalance: string
  sourceEventCount: number
  sourceEventDigest: string
}

export type LegacyGovernanceSnapshot = {
  owner: string
  bridge: string
  governanceDelay: string
  pendingParameterSlots: number[]
  pendingGovernanceDelay: string
  governanceDelayChangeInitiated: string
  bridgeTransferChangeInitiated: string
  newBridgeGovernance: string
}

const LEGACY_FRAUD_CHALLENGES_MAPPING_SLOT =
  BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT.fraudChallengesAbsoluteSlot
const fraudSubmissionInterface = new ethers.utils.Interface([
  "event FraudChallengeSubmitted(bytes20 indexed walletPubKeyHash,bytes32 sighash,uint8 v,bytes32 r,bytes32 s)",
  "function submitFraudChallenge(bytes walletPublicKey,bytes preimageSha256,(uint8 v,bytes32 r,bytes32 s) signature)",
])

type SubmissionCandidate = {
  walletPubKeyHash: string
  sighash: string
  v: number
  r: string
  s: string
  challengeKey: string
}

type CallTraceFrame = {
  to?: string
  input?: string
  error?: string
  calls?: CallTraceFrame[]
}

type RecoveredSubmissionSources = {
  logs: providers.Log[]
  challengeKeys: string[]
  sourceEventDigest: string
}

function compareChallengeKeys(left: string, right: string): number {
  const leftKey = BigNumber.from(left)
  const rightKey = BigNumber.from(right)
  if (leftKey.lt(rightKey)) return -1
  if (leftKey.gt(rightKey)) return 1
  return 0
}

async function getSubmissionLogs(
  provider: providers.Provider,
  bridge: string,
  fromBlock: number,
  toBlock: number
): Promise<providers.Log[]> {
  const logs: providers.Log[] = []
  const topic = fraudSubmissionInterface.getEventTopic(
    "FraudChallengeSubmitted"
  )
  // Keep archive-provider requests serialized. Mainnet's canonical range can
  // span many chunks and an unbounded Promise.all is likely to trigger RPC
  // throttling halfway through the safety proof.
  // eslint-disable-next-line no-restricted-syntax
  for (let start = fromBlock; start <= toBlock; start += 10_000) {
    logs.push(
      // eslint-disable-next-line no-await-in-loop
      ...(await provider.getLogs({
        address: bridge,
        topics: [topic],
        fromBlock: start,
        toBlock: Math.min(start + 9_999, toBlock),
      }))
    )
  }
  return logs.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber - right.blockNumber
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex
    }
    return left.logIndex - right.logIndex
  })
}

function parseSubmissionCandidate(
  data: string
): SubmissionCandidate | undefined {
  let parsed: ethers.utils.TransactionDescription
  try {
    parsed = fraudSubmissionInterface.parseTransaction({ data })
  } catch (_) {
    return undefined
  }
  if (parsed.name !== "submitFraudChallenge") return undefined

  const walletPublicKey = ethers.utils.hexlify(parsed.args.walletPublicKey)
  if (ethers.utils.hexDataLength(walletPublicKey) !== 64) {
    throw new Error("fraud submission wallet public key must be 64 bytes")
  }
  const preimageSha256 = ethers.utils.hexlify(parsed.args.preimageSha256)
  const sighash = ethers.utils.sha256(preimageSha256)
  const x = ethers.utils.hexDataSlice(walletPublicKey, 0, 32)
  const yLastByte = Number(
    BigNumber.from(ethers.utils.hexDataSlice(walletPublicKey, 63, 64))
  )
  const compressedKey = ethers.utils.hexConcat([
    yLastByte % 2 === 0 ? "0x02" : "0x03",
    x,
  ])
  const { signature } = parsed.args
  const v = Number(signature.v ?? signature[0])
  const r = ethers.utils.hexZeroPad(
    ethers.utils.hexlify(signature.r ?? signature[1]),
    32
  )
  const s = ethers.utils.hexZeroPad(
    ethers.utils.hexlify(signature.s ?? signature[2]),
    32
  )

  return {
    walletPubKeyHash: ethers.utils.ripemd160(
      ethers.utils.sha256(compressedKey)
    ),
    sighash,
    v,
    r,
    s,
    challengeKey: BigNumber.from(
      ethers.utils.keccak256(
        ethers.utils.solidityPack(
          ["bytes", "bytes32"],
          [walletPublicKey, sighash]
        )
      )
    ).toString(),
  }
}

function candidateMatchesLog(
  candidate: SubmissionCandidate,
  log: providers.Log
): boolean {
  const parsed = fraudSubmissionInterface.parseLog(log)
  return (
    candidate.walletPubKeyHash.toLowerCase() ===
      String(parsed.args.walletPubKeyHash).toLowerCase() &&
    candidate.sighash.toLowerCase() ===
      String(parsed.args.sighash).toLowerCase() &&
    candidate.v === Number(parsed.args.v) &&
    candidate.r.toLowerCase() === String(parsed.args.r).toLowerCase() &&
    candidate.s.toLowerCase() === String(parsed.args.s).toLowerCase()
  )
}

function collectBridgeSubmissionCandidates(
  frame: CallTraceFrame,
  bridge: string,
  candidates: SubmissionCandidate[]
): void {
  if (frame.error) return
  if (frame.to?.toLowerCase() === bridge.toLowerCase() && frame.input) {
    const candidate = parseSubmissionCandidate(frame.input)
    if (candidate) candidates.push(candidate)
  }
  const childFrames = frame.calls ?? []
  childFrames.forEach((child) => {
    collectBridgeSubmissionCandidates(child, bridge, candidates)
  })
}

async function traceSubmissionCandidates(
  provider: providers.Provider,
  bridge: string,
  transactionHash: string
): Promise<SubmissionCandidate[]> {
  const rpcProvider = provider as providers.Provider & {
    send?: (method: string, params: unknown[]) => Promise<unknown>
  }
  if (typeof rpcProvider.send !== "function") {
    throw new Error(
      `provider cannot trace forwarded fraud submission ${transactionHash}`
    )
  }

  let trace: unknown
  try {
    trace = await rpcProvider.send("debug_traceTransaction", [
      transactionHash,
      { tracer: "callTracer", timeout: "30s" },
    ])
  } catch (error) {
    throw new Error(
      `execution trace unavailable for forwarded fraud submission ${transactionHash}: ${String(
        error
      )}`
    )
  }
  if (!trace || typeof trace !== "object") {
    throw new Error(`invalid execution trace for ${transactionHash}`)
  }
  const candidates: SubmissionCandidate[] = []
  collectBridgeSubmissionCandidates(trace as CallTraceFrame, bridge, candidates)
  return candidates
}

function sourceEventDigest(logs: providers.Log[]): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(uint256 blockNumber,bytes32 transactionHash,uint256 logIndex,bytes32 logHash)[]",
      ],
      [
        logs.map((log) => ({
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          logHash: ethers.utils.keccak256(
            ethers.utils.concat([...log.topics, log.data])
          ),
        })),
      ]
    )
  )
}

async function recoverSubmissionSources(
  provider: providers.Provider,
  bridge: string,
  fromBlock: number,
  toBlock: number
): Promise<RecoveredSubmissionSources> {
  const logs = await getSubmissionLogs(provider, bridge, fromBlock, toBlock)
  const logsByTransaction = new Map<string, providers.Log[]>()
  logs.forEach((log) => {
    const transactionLogs = logsByTransaction.get(log.transactionHash) ?? []
    transactionLogs.push(log)
    logsByTransaction.set(log.transactionHash, transactionLogs)
  })

  const challengeKeys: string[] = []
  // Trace one transaction at a time so a large historical recovery cannot
  // exhaust or rate-limit the archive node used for the irreversible preflight.
  // eslint-disable-next-line no-restricted-syntax
  for (const [transactionHash, transactionLogs] of logsByTransaction) {
    // eslint-disable-next-line no-await-in-loop
    const transaction = await provider.getTransaction(transactionHash)
    if (!transaction) {
      throw new Error(`missing fraud submission transaction ${transactionHash}`)
    }

    let candidates: SubmissionCandidate[] = []
    if (transaction.to?.toLowerCase() === bridge.toLowerCase()) {
      const direct = parseSubmissionCandidate(transaction.data)
      if (
        direct &&
        transactionLogs.length === 1 &&
        candidateMatchesLog(direct, transactionLogs[0])
      ) {
        candidates = [direct]
      }
    }
    if (candidates.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      candidates = await traceSubmissionCandidates(
        provider,
        bridge,
        transactionHash
      )
    }

    const consumed = new Set<number>()
    transactionLogs.forEach((log) => {
      const matches = candidates
        .map((candidate, index) => ({ candidate, index }))
        .filter(
          ({ candidate, index }) =>
            !consumed.has(index) && candidateMatchesLog(candidate, log)
        )
      if (matches.length !== 1) {
        throw new Error(
          `fraud submission event ${transactionHash}:${log.logIndex} maps to ${matches.length} successful Bridge calls`
        )
      }
      consumed.add(matches[0].index)
      challengeKeys.push(matches[0].candidate.challengeKey)
    })
  }

  return { logs, challengeKeys, sourceEventDigest: sourceEventDigest(logs) }
}

export async function buildLegacyInventorySourcePreflight(
  provider: providers.Provider,
  bridge: string,
  scanStartBlock: number,
  finalizedBlock: number
): Promise<LegacyInventorySourcePreflight> {
  if (finalizedBlock < scanStartBlock) {
    throw new Error("source preflight finalized block predates scan floor")
  }
  const block = await provider.getBlock(finalizedBlock)
  if (!block?.hash) throw new Error(`finalized block ${finalizedBlock} missing`)
  const recovered = await recoverSubmissionSources(
    provider,
    bridge,
    scanStartBlock,
    finalizedBlock
  )
  const identities = [...new Set(recovered.challengeKeys)].sort(
    compareChallengeKeys
  )
  return {
    finalizedBlock,
    finalizedBlockHash: block.hash,
    sourceEventCount: recovered.logs.length,
    sourceEventDigest: recovered.sourceEventDigest,
    challengeIdentityCount: identities.length,
    challengeIdentityDigest: ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(["uint256[]"], [identities])
    ),
  }
}

async function readLegacyChallenge(
  provider: providers.Provider,
  bridge: string,
  challengeKey: string,
  blockTag: number
): Promise<{
  challenger: string
  depositAmount: string
  reportedAt: number
  resolved: boolean
}> {
  const base = BigNumber.from(
    ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256"],
        [challengeKey, LEGACY_FRAUD_CHALLENGES_MAPPING_SLOT]
      )
    )
  )
  const [challengerWord, depositWord, statusWord] = await Promise.all([
    provider.getStorageAt(bridge, base, blockTag),
    provider.getStorageAt(bridge, base.add(1), blockTag),
    provider.getStorageAt(bridge, base.add(2), blockTag),
  ])
  const packedStatus = BigNumber.from(statusWord)
  return {
    challenger: slotAddress(challengerWord),
    depositAmount: BigNumber.from(depositWord).toString(),
    reportedAt: packedStatus.and("0xffffffff").toNumber(),
    resolved: !packedStatus.shr(32).and(0xff).isZero(),
  }
}

export async function buildCanonicalInventory(
  provider: providers.Provider,
  manifest: HandoffManifest,
  finalizedBlock: number
): Promise<InventoryBundle> {
  if (finalizedBlock < manifest.scanStartBlock) {
    throw new Error("finalized inventory block predates canonical scan floor")
  }
  const block = await provider.getBlock(finalizedBlock)
  if (!block?.hash) throw new Error(`finalized block ${finalizedBlock} missing`)
  const recovered = await recoverSubmissionSources(
    provider,
    manifest.bridge,
    manifest.scanStartBlock,
    finalizedBlock
  )
  const discoveredKeys = new Set(recovered.challengeKeys)

  const allKeys = [...discoveredKeys].sort(compareChallengeKeys)
  const allChallenges = await Promise.all(
    allKeys.map((key) =>
      readLegacyChallenge(provider, manifest.bridge, key, finalizedBlock)
    )
  )
  const challengeKeys: string[] = []
  const challenges: InventoryBundle["challenges"] = []
  let totalEscrow = BigNumber.from(0)
  for (let i = 0; i < allKeys.length; i++) {
    if (allChallenges[i].reportedAt !== 0 && !allChallenges[i].resolved) {
      challengeKeys.push(allKeys[i])
      challenges.push(allChallenges[i])
      totalEscrow = totalEscrow.add(allChallenges[i].depositAmount)
    }
  }
  const challengeSetHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "uint256[]",
        "tuple(address challenger,uint256 depositAmount,uint32 reportedAt,bool resolved)[]",
      ],
      [challengeKeys, challenges]
    )
  )
  const countInterface = new ethers.utils.Interface([
    "function openFraudChallengeCount() view returns (uint256)",
  ])
  const oldRouterOpenChallengeCount = BigNumber.from(
    countInterface.decodeFunctionResult(
      "openFraudChallengeCount",
      await provider.call(
        {
          to: manifest.oldRouter,
          data: countInterface.encodeFunctionData("openFraudChallengeCount"),
        },
        finalizedBlock
      )
    )[0]
  )
  const inventory: InventoryBundle = {
    scanStartBlock: manifest.scanStartBlock,
    scanEndBlock: finalizedBlock,
    finalizedBlock,
    finalizedBlockHash: block.hash,
    challengeKeys,
    challenges,
    challengeSetHash,
    challengeCount: challengeKeys.length,
    totalEscrow: totalEscrow.toString(),
    oldRouterOpenChallengeCount: oldRouterOpenChallengeCount.toString(),
    bridgeLegacyEscrowBalance: (
      await provider.getBalance(manifest.bridge, finalizedBlock)
    ).toString(),
    sourceEventCount: recovered.logs.length,
    sourceEventDigest: recovered.sourceEventDigest,
  }
  assertCanonicalInventory(manifest, inventory)
  return inventory
}

export function handoffPlanHash(manifest: HandoffManifest): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "uint256",
        "uint256",
        "address",
        "uint256",
        "address",
        "bytes32",
        "bytes32",
        "bytes32",
        "address",
        "bytes32",
        "address",
        "uint256",
        "address",
        "bytes32",
        "address",
        "bytes32",
        "uint256",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
        "address",
      ],
      [
        manifest.version,
        manifest.chainId,
        manifest.bridge,
        manifest.bridgeDeploymentBlock,
        manifest.oldGovernance,
        manifest.oldGovernanceRuntimeCodeHash,
        manifest.oldGovernanceStorageLayoutHash,
        manifest.bridgeLegacyFraudStorageLayoutHash,
        manifest.newGovernance,
        manifest.newGovernanceRuntimeCodeHash,
        manifest.governanceOwner,
        manifest.governanceDelay,
        manifest.oldRouter,
        manifest.oldRouterRuntimeCodeHash,
        manifest.replacementRouter,
        manifest.replacementRouterRuntimeCodeHash,
        manifest.scanStartBlock,
        manifest.legacyInventorySourcePreflight.finalizedBlock,
        manifest.legacyInventorySourcePreflight.finalizedBlockHash,
        manifest.legacyInventorySourcePreflight.sourceEventCount,
        manifest.legacyInventorySourcePreflight.sourceEventDigest,
        manifest.legacyInventorySourcePreflight.challengeIdentityCount,
        manifest.legacyInventorySourcePreflight.challengeIdentityDigest,
        manifest.reconciler,
      ]
    )
  )
}

export function assertLegacyInventorySourcePreflight(
  manifest: HandoffManifest,
  observed: LegacyInventorySourcePreflight = manifest.legacyInventorySourcePreflight
): void {
  const expected = manifest.legacyInventorySourcePreflight
  if (
    !Number.isSafeInteger(expected.finalizedBlock) ||
    expected.finalizedBlock < manifest.scanStartBlock ||
    expected.finalizedBlock < manifest.bridgeDeploymentBlock ||
    !Number.isSafeInteger(expected.sourceEventCount) ||
    expected.sourceEventCount < 0 ||
    !Number.isSafeInteger(expected.challengeIdentityCount) ||
    expected.challengeIdentityCount < 0 ||
    expected.challengeIdentityCount > expected.sourceEventCount
  ) {
    throw new Error("signed legacy inventory source preflight is malformed")
  }
  if (
    observed.finalizedBlock !== expected.finalizedBlock ||
    observed.finalizedBlockHash.toLowerCase() !==
      expected.finalizedBlockHash.toLowerCase() ||
    observed.sourceEventCount !== expected.sourceEventCount ||
    observed.sourceEventDigest.toLowerCase() !==
      expected.sourceEventDigest.toLowerCase() ||
    observed.challengeIdentityCount !== expected.challengeIdentityCount ||
    observed.challengeIdentityDigest.toLowerCase() !==
      expected.challengeIdentityDigest.toLowerCase()
  ) {
    throw new Error(
      "legacy inventory source preflight differs from signed manifest"
    )
  }
}

export function assertManifestSignature(
  manifest: HandoffManifest,
  signature: string
): void {
  const recovered = ethers.utils.verifyMessage(
    ethers.utils.arrayify(handoffPlanHash(manifest)),
    signature
  )
  if (recovered.toLowerCase() !== manifest.reconciler.toLowerCase()) {
    throw new Error(
      `handoff manifest signature is not from reconciler ${manifest.reconciler}`
    )
  }
}

function slotAddress(word: string): string {
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(word, 12))
}

function isZeroWord(word: string): boolean {
  return BigNumber.from(word).isZero()
}

export async function readLegacyGovernanceStorage(
  provider: providers.Provider,
  governance: string
): Promise<LegacyGovernanceSnapshot> {
  const words = await Promise.all(
    Array.from({ length: 75 }, (_, slot) =>
      provider.getStorageAt(governance, slot)
    )
  )
  const pendingParameterSlots: number[] = []
  for (
    let slot = LEGACY_GOVERNANCE_STORAGE_LAYOUT.pendingParameterSlots.first;
    slot <= LEGACY_GOVERNANCE_STORAGE_LAYOUT.pendingParameterSlots.last;
    slot++
  ) {
    if (!isZeroWord(words[slot])) pendingParameterSlots.push(slot)
  }

  return {
    owner: slotAddress(words[LEGACY_GOVERNANCE_STORAGE_LAYOUT.ownerSlot]),
    bridge: slotAddress(words[LEGACY_GOVERNANCE_STORAGE_LAYOUT.bridgeSlot]),
    governanceDelay: BigNumber.from(
      words[LEGACY_GOVERNANCE_STORAGE_LAYOUT.governanceDelaySlots.current]
    ).toString(),
    pendingParameterSlots,
    pendingGovernanceDelay: BigNumber.from(
      words[LEGACY_GOVERNANCE_STORAGE_LAYOUT.governanceDelaySlots.pending]
    ).toString(),
    governanceDelayChangeInitiated: BigNumber.from(
      words[LEGACY_GOVERNANCE_STORAGE_LAYOUT.governanceDelaySlots.initiatedAt]
    ).toString(),
    bridgeTransferChangeInitiated: BigNumber.from(
      words[LEGACY_GOVERNANCE_STORAGE_LAYOUT.bridgeTransferSlots.initiatedAt]
    ).toString(),
    newBridgeGovernance: slotAddress(
      words[LEGACY_GOVERNANCE_STORAGE_LAYOUT.bridgeTransferSlots.newGovernance]
    ),
  }
}

export async function assertLegacyGovernanceReadyForHandoff(
  provider: providers.Provider,
  manifest: HandoffManifest,
  expectedPendingGovernance?: string
): Promise<void> {
  if (
    manifest.oldGovernanceStorageLayoutHash.toLowerCase() !==
    LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH.toLowerCase()
  ) {
    throw new Error(
      "legacy governance storage-layout fingerprint mismatch: expected " +
        `${LEGACY_GOVERNANCE_STORAGE_LAYOUT_HASH}, got ` +
        `${manifest.oldGovernanceStorageLayoutHash}`
    )
  }

  const codeHash = ethers.utils.keccak256(
    await provider.getCode(manifest.oldGovernance)
  )
  if (
    codeHash.toLowerCase() !==
    manifest.oldGovernanceRuntimeCodeHash.toLowerCase()
  ) {
    throw new Error(
      "old BridgeGovernance runtime code hash mismatch: expected " +
        `${manifest.oldGovernanceRuntimeCodeHash}, got ${codeHash}`
    )
  }

  const state = await readLegacyGovernanceStorage(
    provider,
    manifest.oldGovernance
  )
  if (state.owner.toLowerCase() !== manifest.governanceOwner.toLowerCase()) {
    throw new Error(`old BridgeGovernance owner mismatch: ${state.owner}`)
  }
  if (state.bridge.toLowerCase() !== manifest.bridge.toLowerCase()) {
    throw new Error(
      `old BridgeGovernance Bridge binding mismatch: ${state.bridge}`
    )
  }

  if (state.pendingParameterSlots.length > 0) {
    throw new Error(
      `old BridgeGovernance has hidden pending parameter state in slot(s) ${state.pendingParameterSlots.join(
        ", "
      )}`
    )
  }
  if (
    !BigNumber.from(state.pendingGovernanceDelay).isZero() ||
    !BigNumber.from(state.governanceDelayChangeInitiated).isZero()
  ) {
    throw new Error("old BridgeGovernance has a pending delay update")
  }
  const transferStarted = !BigNumber.from(
    state.bridgeTransferChangeInitiated
  ).isZero()
  if (expectedPendingGovernance === undefined) {
    if (
      transferStarted ||
      state.newBridgeGovernance !== ethers.constants.AddressZero
    ) {
      throw new Error("old BridgeGovernance has a pending governance transfer")
    }
  } else if (
    !transferStarted ||
    state.newBridgeGovernance.toLowerCase() !==
      expectedPendingGovernance.toLowerCase()
  ) {
    throw new Error(
      "old BridgeGovernance pending transfer mismatch: " +
        `${state.newBridgeGovernance}`
    )
  }
  const storedDelay = BigNumber.from(state.governanceDelay)
  if (!storedDelay.eq(manifest.governanceDelay)) {
    throw new Error(
      `old BridgeGovernance delay mismatch: expected ${manifest.governanceDelay}, ` +
        `got ${storedDelay.toString()}`
    )
  }
}

export function assertCanonicalInventory(
  manifest: HandoffManifest,
  inventory: InventoryBundle
): void {
  if (inventory.scanStartBlock !== manifest.scanStartBlock) {
    throw new Error(
      "truncated inventory scan: expected canonical start block " +
        `${manifest.scanStartBlock}, got ${inventory.scanStartBlock}`
    )
  }
  if (inventory.finalizedBlock < manifest.bridgeDeploymentBlock) {
    throw new Error("inventory finalized block predates Bridge deployment")
  }
  if (inventory.scanEndBlock !== inventory.finalizedBlock) {
    throw new Error("inventory scan does not end at the finalized block")
  }
  if (
    inventory.challenges.length !== inventory.challengeCount ||
    inventory.challengeKeys.length !== inventory.challenges.length
  ) {
    throw new Error("inventory challenge record count mismatch")
  }
  if (
    inventory.challengeKeys.length !== inventory.challengeCount ||
    new Set(inventory.challengeKeys).size !== inventory.challengeKeys.length
  ) {
    throw new Error("inventory key count/uniqueness mismatch")
  }
  for (let i = 1; i < inventory.challengeKeys.length; i++) {
    if (
      BigNumber.from(inventory.challengeKeys[i]).lte(
        inventory.challengeKeys[i - 1]
      )
    ) {
      throw new Error("inventory challenge keys are not strictly increasing")
    }
  }
  let totalEscrow = BigNumber.from(0)
  inventory.challenges.forEach((challenge) => {
    if (
      challenge.reportedAt === 0 ||
      challenge.resolved ||
      challenge.challenger === ethers.constants.AddressZero
    ) {
      throw new Error("inventory contains an invalid legacy challenge")
    }
    totalEscrow = totalEscrow.add(challenge.depositAmount)
  })
  if (!totalEscrow.eq(inventory.totalEscrow)) {
    throw new Error("inventory escrow sum mismatch")
  }
  const challengeSetHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "uint256[]",
        "tuple(address challenger,uint256 depositAmount,uint32 reportedAt,bool resolved)[]",
      ],
      [inventory.challengeKeys, inventory.challenges]
    )
  )
  if (
    challengeSetHash.toLowerCase() !== inventory.challengeSetHash.toLowerCase()
  ) {
    throw new Error("inventory challenge-set hash mismatch")
  }
  if (!BigNumber.from(inventory.oldRouterOpenChallengeCount).isZero()) {
    throw new Error("old router still has unresolved challenges")
  }
  if (
    BigNumber.from(inventory.bridgeLegacyEscrowBalance).lt(
      inventory.totalEscrow
    )
  ) {
    throw new Error("Bridge balance is below committed legacy escrow")
  }
}
