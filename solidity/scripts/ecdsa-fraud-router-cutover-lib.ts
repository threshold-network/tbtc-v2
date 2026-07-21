/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { BigNumber, ethers, providers } from "ethers"
import {
  CanonicalHistoryEvidence,
  CanonicalHistoryEmitter,
  CanonicalHistoryScan,
  canonicalEmitterSetCommitment,
  scanCanonicalHistory,
} from "./ecdsa-fraud-router-canonical-history"

export {
  CanonicalHistoryEvidence,
  CanonicalHistoryEmitter,
  CanonicalHistoryScan,
  canonicalEmitterSetCommitment,
}

export const ECDSA_CUTOVER_MIN_AUTHENTICATED_TAIL_BLOCKS = 64
export const ECDSA_CUTOVER_MAX_AUTHENTICATED_TAIL_BLOCKS = 255
export const ECDSA_CUTOVER_BLOCKHASH_WINDOW = 255
export const ECDSA_CUTOVER_DEFAULT_PREFLIGHT_CONFIRMATIONS = 64
export const ECDSA_CUTOVER_DEFAULT_MIN_BEGIN_SLACK_BLOCKS = 16

export type CutoverPreflightTiming = {
  preflightBlock: number
  maxTailBlocks: number
  earliestBeginBlock: number
  latestBeginBlock: number
  beginSlackBlocks: number
}

/**
 * Selects a recent canonical checkpoint P for a permissionless begin at B.
 * The checkpoint is already 64 blocks deep. The caller must still recheck the
 * actual begin transaction block against 64 <= B-P <= T. The contract derives
 * the staging deadline as D=B+255 after begin succeeds.
 */
export function cutoverPreflightTiming(
  headBlock: number,
  confirmations: number,
  maxTailBlocks: number,
  minimumBeginSlackBlocks: number
): CutoverPreflightTiming {
  const values = [
    headBlock,
    confirmations,
    maxTailBlocks,
    minimumBeginSlackBlocks,
  ]
  if (values.some((value) => !Number.isSafeInteger(value)) || headBlock < 1) {
    throw new Error("cutover preflight timing contains an invalid integer")
  }
  if (
    confirmations < ECDSA_CUTOVER_DEFAULT_PREFLIGHT_CONFIRMATIONS ||
    maxTailBlocks < ECDSA_CUTOVER_MIN_AUTHENTICATED_TAIL_BLOCKS ||
    maxTailBlocks > ECDSA_CUTOVER_MAX_AUTHENTICATED_TAIL_BLOCKS ||
    minimumBeginSlackBlocks < 1
  ) {
    throw new Error("cutover preflight timing bounds are invalid")
  }
  const preflightBlock = headBlock - confirmations
  if (preflightBlock < 0) {
    throw new Error("chain is too young for the requested preflight checkpoint")
  }
  // A transaction can land no earlier than the next block.
  const earliestBeginBlock = headBlock + 1
  const latestBeginBlock = preflightBlock + maxTailBlocks
  const beginSlackBlocks = latestBeginBlock - earliestBeginBlock
  if (beginSlackBlocks < minimumBeginSlackBlocks) {
    throw new Error(
      `preflight leaves ${beginSlackBlocks} begin blocks of slack; ` +
        `${minimumBeginSlackBlocks} required`
    )
  }
  return {
    preflightBlock,
    maxTailBlocks,
    earliestBeginBlock,
    latestBeginBlock,
    beginSlackBlocks,
  }
}

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

export type AuthorityContext = {
  durableStoreIdentity: string
  endpointIdentity: string
  trustDomain: string
  policyHash: string
}

export type HandoffManifest = {
  version: 4
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
  historyEmitters: HistoryEmitter[]
  replacementRouter: string
  replacementRouterRuntimeCodeHash: string
  scanStartBlock: number
  expectedUnrelatedBridgeBalance: string
  legacyInventorySourcePreflight: LegacyInventorySourcePreflight
  sourceCheckpointCommitment: string
  maxTailBlocks: number
  sourceSigner: string
  sourceId: string
  sourceContext: AuthorityContext
  reconciler: string
  reconcilerSourceId: string
  reconcilerContext: AuthorityContext
  phase: string
  transactions?: Record<string, string>
}

export type HistoryEmitter = CanonicalHistoryEmitter & {
  kind: "bridge" | "ecdsa-router-v2" | "ecdsa-router-v3"
  expectedUnrelatedBalance: string
}

export type LegacyInventorySourcePreflight = {
  history: CanonicalHistoryEvidence
  sourceEventCount: number
  sourceEventDigest: string
  lifecycleEventCount: number
  lifecycleEventDigest: string
  challengeIdentityCount: number
  challengeIdentityDigest: string
  unresolvedChallengeCount: number
  totalEscrow: string
  legacyLiabilityDigest: string
  bridgeBalance: string
  unrelatedBridgeBalance: string
  routerStates: RouterLifecycleState[]
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
  oldRouterOpenChallengeEscrow: string
  routerStates: RouterLifecycleState[]
  bridgeBalance: string
  unrelatedBridgeBalance: string
  sourceEventCount: number
  sourceEventDigest: string
  lifecycleEventCount: number
  lifecycleEventDigest: string
  legacyLiabilityDigest: string
  history: CanonicalHistoryEvidence
  historyEvidenceHash: string
}

export type RouterLifecycleState = {
  address: string
  runtimeCodeHash: string
  protocolId: string
  identityCount: number
  unresolvedChallengeCount: number
  totalEscrow: string
  balance: string
  unrelatedBalance: string
  liabilityDigest: string
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
const fraudLifecycleInterface = new ethers.utils.Interface([
  "event FraudChallengeSubmitted(bytes20 indexed walletPubKeyHash,bytes32 sighash,uint8 v,bytes32 r,bytes32 s)",
  "event FraudChallengeDefeated(bytes20 indexed walletPubKeyHash,bytes32 sighash)",
  "event FraudChallengeDefeatTimedOut(bytes20 indexed walletPubKeyHash,bytes32 sighash)",
  "event LegacyFraudChallengeMigrated(uint8 indexed routerKind,uint256 indexed challengeKey,address indexed challenger,uint256 depositAmount)",
  "event FraudChallengeMigratedFromBridge(uint256 indexed challengeKey,address indexed challenger,uint256 depositAmount)",
  "event MigratedFraudChallengesActivated(uint64 activatedAt)",
])
const FRAUD_LIFECYCLE_TOPICS = [
  "FraudChallengeSubmitted",
  "FraudChallengeDefeated",
  "FraudChallengeDefeatTimedOut",
  "LegacyFraudChallengeMigrated",
  "FraudChallengeMigratedFromBridge",
  "MigratedFraudChallengesActivated",
].map((event) => fraudLifecycleInterface.getEventTopic(event))
const FRAUD_SUBMISSION_SELECTOR = fraudSubmissionInterface.getSighash(
  "submitFraudChallenge"
)
const CURRENT_V2_PROTOCOL_ID = ethers.utils.id(
  "tbtc/ecdsa-signature-fraud/router/current-v2"
)
const CURRENT_V3_PROTOCOL_ID = ethers.utils.id(
  "tbtc/ecdsa-signature-fraud/router/current-v3"
)
const routerHistoryInterface = new ethers.utils.Interface([
  "function fraudProtocolID() view returns (bytes32)",
  "function predecessor() view returns (address)",
  "function predecessorCodeHash() view returns (bytes32)",
  "function openFraudChallengeCount() view returns (uint256)",
  "function openFraudChallengeEscrow() view returns (uint256)",
  "function fraudChallenges(uint256) view returns (address challenger,uint256 depositAmount,uint32 reportedAt,bool resolved)",
])

async function strictRouterCall(
  provider: providers.Provider,
  router: string,
  signature: string,
  args: unknown[] = [],
  blockTag?: number
): Promise<ethers.utils.Result> {
  const result = await provider.call(
    {
      to: router,
      data: routerHistoryInterface.encodeFunctionData(signature, args),
    },
    blockTag
  )
  return routerHistoryInterface.decodeFunctionResult(signature, result)
}

export async function discoverHistoryEmitters(
  provider: providers.Provider,
  bridge: string,
  oldRouter: string,
  expectedUnrelatedBalances: Record<string, string>,
  blockTag?: number
): Promise<HistoryEmitter[]> {
  const normalizedBridge = ethers.utils.getAddress(bridge)
  const bridgeCode = await provider.getCode(normalizedBridge, blockTag)
  if (bridgeCode === "0x") throw new Error("Bridge history emitter has no code")
  const lookupBalance = (address: string): string => {
    const entry = Object.entries(expectedUnrelatedBalances).find(
      ([candidate]) => candidate.toLowerCase() === address.toLowerCase()
    )
    if (!entry) {
      throw new Error(
        `explicit unrelated-funds allowance missing for emitter ${address}`
      )
    }
    return BigNumber.from(entry[1]).toString()
  }
  const emitters: HistoryEmitter[] = [
    {
      address: normalizedBridge,
      runtimeCodeHash: ethers.utils.keccak256(bridgeCode),
      kind: "bridge",
      expectedUnrelatedBalance: lookupBalance(normalizedBridge),
    },
  ]
  const seen = new Set([normalizedBridge.toLowerCase()])
  let cursor = ethers.utils.getAddress(oldRouter)
  for (let depth = 0; depth <= 8; depth++) {
    if (seen.has(cursor.toLowerCase())) {
      throw new Error(`cyclic or duplicate ECDSA history emitter ${cursor}`)
    }
    seen.add(cursor.toLowerCase())
    const code = await provider.getCode(cursor, blockTag)
    if (code === "0x")
      throw new Error(`router history emitter ${cursor} has no code`)
    const runtimeCodeHash = ethers.utils.keccak256(code)
    const protocolId = String(
      (
        await strictRouterCall(
          provider,
          cursor,
          "fraudProtocolID",
          [],
          blockTag
        )
      )[0]
    )
    if (
      protocolId.toLowerCase() !== CURRENT_V2_PROTOCOL_ID.toLowerCase() &&
      protocolId.toLowerCase() !== CURRENT_V3_PROTOCOL_ID.toLowerCase()
    ) {
      throw new Error(`unsupported router history protocol at ${cursor}`)
    }
    emitters.push({
      address: cursor,
      runtimeCodeHash,
      kind:
        protocolId.toLowerCase() === CURRENT_V3_PROTOCOL_ID.toLowerCase()
          ? "ecdsa-router-v3"
          : "ecdsa-router-v2",
      expectedUnrelatedBalance: lookupBalance(cursor),
    })
    if (protocolId.toLowerCase() === CURRENT_V2_PROTOCOL_ID.toLowerCase()) {
      return emitters
    }
    const predecessor = ethers.utils.getAddress(
      String(
        (
          await strictRouterCall(provider, cursor, "predecessor", [], blockTag)
        )[0]
      )
    )
    const pinnedCodeHash = String(
      (
        await strictRouterCall(
          provider,
          cursor,
          "predecessorCodeHash",
          [],
          blockTag
        )
      )[0]
    )
    if (predecessor === ethers.constants.AddressZero) {
      if (pinnedCodeHash !== ethers.constants.HashZero) {
        throw new Error(
          `terminal router ${cursor} pins a nonzero predecessor hash`
        )
      }
      return emitters
    }
    const predecessorCode = await provider.getCode(predecessor, blockTag)
    if (
      predecessorCode === "0x" ||
      ethers.utils.keccak256(predecessorCode).toLowerCase() !==
        pinnedCodeHash.toLowerCase()
    ) {
      throw new Error(`router ${cursor} predecessor code hash mismatch`)
    }
    cursor = predecessor
  }
  throw new Error("ECDSA router history ancestry exceeds eight predecessors")
}

type SubmissionCandidate = {
  emitter: string
  walletPubKeyHash: string
  sighash: string
  v: number
  r: string
  s: string
  challengeKey: string
  challenger: string
  depositAmount: string
}

type RecoveredSubmissionSources = {
  logs: providers.Log[]
  challengeKeys: string[]
  candidatesByKey: Map<string, SubmissionCandidate>
  sourceEventDigest: string
}

type LegacyLifecycleReconciliation = {
  challengeKeys: string[]
  challenges: InventoryBundle["challenges"]
  totalEscrow: BigNumber
  lifecycleEventCount: number
  lifecycleEventDigest: string
  legacyLiabilityDigest: string
  routerStates: RouterLifecycleState[]
}

function compareChallengeKeys(left: string, right: string): number {
  const leftKey = BigNumber.from(left)
  const rightKey = BigNumber.from(right)
  if (leftKey.lt(rightKey)) return -1
  if (leftKey.gt(rightKey)) return 1
  return 0
}

function parseSubmissionCandidate(
  data: string,
  emitter: string,
  challenger: string,
  depositAmount: string
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
    emitter: ethers.utils.getAddress(emitter),
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
    challenger: ethers.utils.getAddress(challenger),
    depositAmount: BigNumber.from(depositAmount).toString(),
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
    candidate.s.toLowerCase() === String(parsed.args.s).toLowerCase() &&
    candidate.emitter.toLowerCase() === log.address.toLowerCase()
  )
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

function recoverSubmissionSources(
  history: CanonicalHistoryScan
): RecoveredSubmissionSources {
  const submissionTopic = fraudSubmissionInterface
    .getEventTopic("FraudChallengeSubmitted")
    .toLowerCase()
  const logs = history.selectedLogs.filter(
    (log) => log.topics[0]?.toLowerCase() === submissionTopic
  )
  const logsByTransaction = new Map<string, providers.Log[]>()
  logs.forEach((log) => {
    const transactionLogs = logsByTransaction.get(log.transactionHash) ?? []
    transactionLogs.push(log)
    logsByTransaction.set(log.transactionHash, transactionLogs)
  })
  const candidatesByTransaction = new Map<string, SubmissionCandidate[]>()
  history.candidateCalls.forEach((call) => {
    const candidate = parseSubmissionCandidate(
      call.input,
      call.to,
      call.from,
      call.value
    )
    if (!candidate) {
      throw new Error(
        `canonical candidate call ${call.transactionHash} is malformed`
      )
    }
    const transactionCandidates =
      candidatesByTransaction.get(call.transactionHash) ?? []
    transactionCandidates.push(candidate)
    candidatesByTransaction.set(call.transactionHash, transactionCandidates)
  })

  const challengeKeys: string[] = []
  const candidatesByKey = new Map<string, SubmissionCandidate>()
  const transactionHashes = new Set([
    ...logsByTransaction.keys(),
    ...candidatesByTransaction.keys(),
  ])
  transactionHashes.forEach((transactionHash) => {
    const transactionLogs = logsByTransaction.get(transactionHash) ?? []
    const candidates = candidatesByTransaction.get(transactionHash) ?? []

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
          `fraud submission event ${transactionHash}:${log.logIndex} maps to ${matches.length} successful canonical calls`
        )
      }
      consumed.add(matches[0].index)
      const { candidate } = matches[0]
      if (candidatesByKey.has(candidate.challengeKey)) {
        throw new Error(
          `duplicate canonical fraud challenge identity ${candidate.challengeKey}`
        )
      }
      challengeKeys.push(candidate.challengeKey)
      candidatesByKey.set(candidate.challengeKey, candidate)
    })
    if (consumed.size !== candidates.length) {
      throw new Error(
        `fraud submission transaction ${transactionHash} has ${
          candidates.length - consumed.size
        } successful call(s) without canonical receipt logs`
      )
    }
  })

  return {
    logs,
    challengeKeys,
    candidatesByKey,
    sourceEventDigest: sourceEventDigest(logs),
  }
}

function lifecyclePair(walletPubKeyHash: string, sighash: string): string {
  return `${walletPubKeyHash.toLowerCase()}:${sighash.toLowerCase()}`
}

async function reconcileLegacyLifecycle(
  provider: providers.Provider,
  bridge: string,
  finalizedBlock: number,
  history: CanonicalHistoryScan,
  recovered: RecoveredSubmissionSources,
  historyEmitters: HistoryEmitter[]
): Promise<LegacyLifecycleReconciliation> {
  const allKeys = [...recovered.challengeKeys].sort(compareChallengeKeys)
  const keysByPair = new Map<string, string>()
  recovered.candidatesByKey.forEach((candidate, key) => {
    const pair = lifecyclePair(candidate.walletPubKeyHash, candidate.sighash)
    if (keysByPair.has(pair)) {
      throw new Error(`ambiguous fraud lifecycle identity ${pair}`)
    }
    keysByPair.set(pair, key)
  })

  const resolutions = new Map<string, { name: string; emitter: string }>()
  const migrations = new Map<
    string,
    { challenger: string; depositAmount: string; routerKind: number }
  >()
  const routerMigrations = new Map<
    string,
    { emitter: string; challenger: string; depositAmount: string }
  >()
  const submissionTopic = fraudLifecycleInterface
    .getEventTopic("FraudChallengeSubmitted")
    .toLowerCase()
  history.selectedLogs.forEach((log) => {
    if (log.topics[0]?.toLowerCase() === submissionTopic) return
    const parsed = fraudLifecycleInterface.parseLog(log)
    if (
      parsed.name === "FraudChallengeDefeated" ||
      parsed.name === "FraudChallengeDefeatTimedOut"
    ) {
      const pair = lifecyclePair(
        String(parsed.args.walletPubKeyHash),
        String(parsed.args.sighash)
      )
      const key = keysByPair.get(pair)
      if (!key) {
        throw new Error(
          `${parsed.name} event has no canonical submission identity`
        )
      }
      if (resolutions.has(key)) {
        throw new Error(`duplicate fraud resolution for identity ${key}`)
      }
      resolutions.set(key, {
        name: parsed.name,
        emitter: ethers.utils.getAddress(log.address),
      })
      return
    }
    if (parsed.name === "LegacyFraudChallengeMigrated") {
      const key = BigNumber.from(parsed.args.challengeKey).toString()
      if (!recovered.candidatesByKey.has(key)) {
        throw new Error(
          `legacy migration event has no canonical submission identity ${key}`
        )
      }
      if (migrations.has(key)) {
        throw new Error(`duplicate legacy migration for identity ${key}`)
      }
      migrations.set(key, {
        challenger: ethers.utils.getAddress(parsed.args.challenger),
        depositAmount: BigNumber.from(parsed.args.depositAmount).toString(),
        routerKind: Number(parsed.args.routerKind),
      })
      return
    }
    if (parsed.name === "FraudChallengeMigratedFromBridge") {
      const key = BigNumber.from(parsed.args.challengeKey).toString()
      if (!recovered.candidatesByKey.has(key)) {
        throw new Error(
          `router migration event has no canonical submission identity ${key}`
        )
      }
      if (routerMigrations.has(key)) {
        throw new Error(`duplicate router migration for identity ${key}`)
      }
      routerMigrations.set(key, {
        emitter: ethers.utils.getAddress(log.address),
        challenger: ethers.utils.getAddress(parsed.args.challenger),
        depositAmount: BigNumber.from(parsed.args.depositAmount).toString(),
      })
    }
  })

  const challengeKeys: string[] = []
  const challenges: InventoryBundle["challenges"] = []
  let totalEscrow = BigNumber.from(0)
  const liabilityRecords: Array<{
    key: string
    challenger: string
    depositAmount: string
    reportedAt: number
    resolved: boolean
    resolution: string
    migrated: boolean
    routerKind: number
    sourceEmitter: string
    currentEmitter: string
  }> = []
  const routerRecords = new Map<
    string,
    Array<{
      key: string
      challenger: string
      depositAmount: string
      reportedAt: number
      resolved: boolean
    }>
  >()
  for (let index = 0; index < allKeys.length; index++) {
    const key = allKeys[index]
    const submitted = recovered.candidatesByKey.get(key)
    if (!submitted) {
      throw new Error(`missing canonical submission for identity ${key}`)
    }
    const resolution = resolutions.get(key)
    const migration = migrations.get(key)
    const routerMigration = routerMigrations.get(key)
    if (Boolean(migration) !== Boolean(routerMigration)) {
      throw new Error(`fraud migration event pair is incomplete for ${key}`)
    }
    if (migration && routerMigration) {
      if (submitted.emitter.toLowerCase() !== bridge.toLowerCase()) {
        throw new Error(
          `non-Bridge fraud identity ${key} was migrated from Bridge`
        )
      }
      if (
        migration.challenger.toLowerCase() !==
          submitted.challenger.toLowerCase() ||
        !BigNumber.from(migration.depositAmount).eq(submitted.depositAmount) ||
        routerMigration.challenger.toLowerCase() !==
          submitted.challenger.toLowerCase() ||
        !BigNumber.from(routerMigration.depositAmount).eq(
          submitted.depositAmount
        )
      ) {
        throw new Error(
          `legacy migration liability differs from submission ${key}`
        )
      }
      // The Bridge source record must have been deleted atomically with the
      // paired destination event.
      // eslint-disable-next-line no-await-in-loop
      const bridgeRecord = await readLegacyChallenge(
        provider,
        bridge,
        key,
        finalizedBlock
      )
      if (
        bridgeRecord.reportedAt !== 0 ||
        bridgeRecord.challenger !== ethers.constants.AddressZero ||
        !BigNumber.from(bridgeRecord.depositAmount).isZero()
      ) {
        throw new Error(
          `migrated fraud identity ${key} still has Bridge storage`
        )
      }
    }
    const currentEmitter = routerMigration?.emitter ?? submitted.emitter
    // eslint-disable-next-line no-await-in-loop
    const challenge =
      currentEmitter.toLowerCase() === bridge.toLowerCase()
        ? // eslint-disable-next-line no-await-in-loop
          await readLegacyChallenge(provider, bridge, key, finalizedBlock)
        : // eslint-disable-next-line no-await-in-loop
          await readRouterChallenge(
            provider,
            currentEmitter,
            key,
            finalizedBlock
          )
    if (
      challenge.reportedAt === 0 ||
      challenge.challenger.toLowerCase() !==
        submitted.challenger.toLowerCase() ||
      !BigNumber.from(challenge.depositAmount).eq(submitted.depositAmount)
    ) {
      throw new Error(
        `fraud identity ${key} storage/submission liability mismatch`
      )
    }
    if (
      challenge.resolved !== Boolean(resolution) ||
      (resolution &&
        resolution.emitter.toLowerCase() !== currentEmitter.toLowerCase())
    ) {
      throw new Error(
        `fraud identity ${key} storage/lifecycle resolution mismatch`
      )
    }
    if (currentEmitter.toLowerCase() === bridge.toLowerCase()) {
      if (!challenge.resolved) {
        challengeKeys.push(key)
        challenges.push(challenge)
        totalEscrow = totalEscrow.add(challenge.depositAmount)
      }
    } else {
      const records = routerRecords.get(currentEmitter.toLowerCase()) ?? []
      records.push({ key, ...challenge })
      routerRecords.set(currentEmitter.toLowerCase(), records)
    }
    liabilityRecords.push({
      key,
      challenger: challenge.challenger,
      depositAmount: challenge.depositAmount,
      reportedAt: challenge.reportedAt,
      resolved: challenge.resolved,
      resolution: resolution?.name ?? "",
      migrated: Boolean(migration),
      routerKind: migration?.routerKind ?? 0,
      sourceEmitter: submitted.emitter,
      currentEmitter,
    })
  }

  const routerStates: RouterLifecycleState[] = []
  // eslint-disable-next-line no-restricted-syntax
  for (const emitter of historyEmitters.filter(
    (item) => item.kind !== "bridge"
  )) {
    const records = (
      routerRecords.get(emitter.address.toLowerCase()) ?? []
    ).sort((left, right) => compareChallengeKeys(left.key, right.key))
    const unresolved = records.filter((record) => !record.resolved)
    const computedEscrow = unresolved.reduce(
      (sum, record) => sum.add(record.depositAmount),
      BigNumber.from(0)
    )
    // eslint-disable-next-line no-await-in-loop
    const observedCount = BigNumber.from(
      (
        await strictRouterCall(
          provider,
          emitter.address,
          "openFraudChallengeCount",
          [],
          finalizedBlock
        )
      )[0]
    )
    if (!observedCount.eq(unresolved.length)) {
      throw new Error(`router ${emitter.address} lifecycle/count mismatch`)
    }
    if (emitter.kind === "ecdsa-router-v3") {
      // eslint-disable-next-line no-await-in-loop
      const observedEscrow = BigNumber.from(
        (
          await strictRouterCall(
            provider,
            emitter.address,
            "openFraudChallengeEscrow",
            [],
            finalizedBlock
          )
        )[0]
      )
      if (!observedEscrow.eq(computedEscrow)) {
        throw new Error(`router ${emitter.address} lifecycle/escrow mismatch`)
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const balance = await provider.getBalance(emitter.address, finalizedBlock)
    if (!balance.eq(computedEscrow.add(emitter.expectedUnrelatedBalance))) {
      throw new Error(`router ${emitter.address} has unattributed ETH balance`)
    }
    const liabilityDigest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(uint256 key,address challenger,uint256 depositAmount,uint32 reportedAt,bool resolved)[]",
        ],
        [records]
      )
    )
    routerStates.push({
      address: emitter.address,
      runtimeCodeHash: emitter.runtimeCodeHash,
      protocolId:
        emitter.kind === "ecdsa-router-v3"
          ? CURRENT_V3_PROTOCOL_ID
          : CURRENT_V2_PROTOCOL_ID,
      identityCount: records.length,
      unresolvedChallengeCount: unresolved.length,
      totalEscrow: computedEscrow.toString(),
      balance: balance.toString(),
      unrelatedBalance: BigNumber.from(
        emitter.expectedUnrelatedBalance
      ).toString(),
      liabilityDigest,
    })
  }

  const lifecycleEventDigest = sourceEventDigest(history.selectedLogs)
  const legacyLiabilityDigest = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(uint256 key,address challenger,uint256 depositAmount,uint32 reportedAt,bool resolved,string resolution,bool migrated,uint8 routerKind,address sourceEmitter,address currentEmitter)[]",
      ],
      [liabilityRecords]
    )
  )
  return {
    challengeKeys,
    challenges,
    totalEscrow,
    lifecycleEventCount: history.selectedLogs.length,
    lifecycleEventDigest,
    legacyLiabilityDigest,
    routerStates,
  }
}

export async function buildLegacyInventorySourcePreflight(
  provider: providers.Provider,
  bridge: string,
  scanStartBlock: number,
  finalizedBlock: number,
  historyEmitters: HistoryEmitter[],
  checkpoint?: CanonicalHistoryScan
): Promise<LegacyInventorySourcePreflight> {
  if (finalizedBlock < scanStartBlock) {
    throw new Error("source preflight finalized block predates scan floor")
  }
  const history = await scanCanonicalHistory(
    provider,
    historyEmitters,
    scanStartBlock,
    finalizedBlock,
    FRAUD_LIFECYCLE_TOPICS,
    FRAUD_SUBMISSION_SELECTOR,
    checkpoint
  )
  const recovered = recoverSubmissionSources(history)
  const lifecycle = await reconcileLegacyLifecycle(
    provider,
    bridge,
    finalizedBlock,
    history,
    recovered,
    historyEmitters
  )
  const identities = [...new Set(recovered.challengeKeys)].sort(
    compareChallengeKeys
  )
  const bridgeBalance = await provider.getBalance(bridge, finalizedBlock)
  if (bridgeBalance.lt(lifecycle.totalEscrow)) {
    throw new Error("Bridge balance is below canonical legacy escrow")
  }
  return {
    history: history.evidence,
    sourceEventCount: recovered.logs.length,
    sourceEventDigest: recovered.sourceEventDigest,
    lifecycleEventCount: lifecycle.lifecycleEventCount,
    lifecycleEventDigest: lifecycle.lifecycleEventDigest,
    challengeIdentityCount: identities.length,
    challengeIdentityDigest: ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(["uint256[]"], [identities])
    ),
    unresolvedChallengeCount: lifecycle.challengeKeys.length,
    totalEscrow: lifecycle.totalEscrow.toString(),
    legacyLiabilityDigest: lifecycle.legacyLiabilityDigest,
    bridgeBalance: bridgeBalance.toString(),
    unrelatedBridgeBalance: bridgeBalance.sub(lifecycle.totalEscrow).toString(),
    routerStates: lifecycle.routerStates,
  }
}

export async function extendCanonicalHistoryJournal(
  provider: providers.Provider,
  historyEmitters: HistoryEmitter[],
  scanStartBlock: number,
  finalizedBlock: number,
  checkpoint?: CanonicalHistoryScan
): Promise<CanonicalHistoryScan> {
  return scanCanonicalHistory(
    provider,
    historyEmitters,
    scanStartBlock,
    finalizedBlock,
    FRAUD_LIFECYCLE_TOPICS,
    FRAUD_SUBMISSION_SELECTOR,
    checkpoint
  )
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

async function readRouterChallenge(
  provider: providers.Provider,
  router: string,
  challengeKey: string,
  blockTag: number
): Promise<{
  challenger: string
  depositAmount: string
  reportedAt: number
  resolved: boolean
}> {
  const result = await strictRouterCall(
    provider,
    router,
    "fraudChallenges",
    [challengeKey],
    blockTag
  )
  return {
    challenger: ethers.utils.getAddress(result.challenger ?? result[0]),
    depositAmount: BigNumber.from(result.depositAmount ?? result[1]).toString(),
    reportedAt: Number(result.reportedAt ?? result[2]),
    resolved: Boolean(result.resolved ?? result[3]),
  }
}

export async function buildCanonicalInventory(
  provider: providers.Provider,
  manifest: HandoffManifest,
  finalizedBlock: number,
  checkpoint?: CanonicalHistoryScan
): Promise<InventoryBundle> {
  if (finalizedBlock < manifest.scanStartBlock) {
    throw new Error("finalized inventory block predates canonical scan floor")
  }
  const history = await scanCanonicalHistory(
    provider,
    manifest.historyEmitters,
    manifest.scanStartBlock,
    finalizedBlock,
    FRAUD_LIFECYCLE_TOPICS,
    FRAUD_SUBMISSION_SELECTOR,
    checkpoint
  )
  const recovered = recoverSubmissionSources(history)
  const lifecycle = await reconcileLegacyLifecycle(
    provider,
    manifest.bridge,
    finalizedBlock,
    history,
    recovered,
    manifest.historyEmitters
  )
  const { challengeKeys, challenges, totalEscrow } = lifecycle
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
    "function openFraudChallengeEscrow() view returns (uint256)",
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
  let oldRouterOpenChallengeEscrow = BigNumber.from(0)
  try {
    const result = await provider.call(
      {
        to: manifest.oldRouter,
        data: countInterface.encodeFunctionData("openFraudChallengeEscrow"),
      },
      finalizedBlock
    )
    if (ethers.utils.hexDataLength(result) !== 32) {
      throw new Error("old router escrow selector returned malformed data")
    }
    oldRouterOpenChallengeEscrow = BigNumber.from(
      countInterface.decodeFunctionResult("openFraudChallengeEscrow", result)[0]
    )
  } catch (error) {
    // Terminal v2 routers predate the escrow counter. Only a clean selector
    // absence is compatible; malformed successful return data is not.
    if (String(error).includes("malformed data")) throw error
  }
  const bridgeBalance = await provider.getBalance(
    manifest.bridge,
    finalizedBlock
  )
  if (bridgeBalance.lt(totalEscrow)) {
    throw new Error("Bridge balance is below canonical legacy escrow")
  }
  const inventory: InventoryBundle = {
    scanStartBlock: manifest.scanStartBlock,
    scanEndBlock: finalizedBlock,
    finalizedBlock,
    finalizedBlockHash: history.evidence.finalizedBlockHash,
    challengeKeys,
    challenges,
    challengeSetHash,
    challengeCount: challengeKeys.length,
    totalEscrow: totalEscrow.toString(),
    oldRouterOpenChallengeCount: oldRouterOpenChallengeCount.toString(),
    oldRouterOpenChallengeEscrow: oldRouterOpenChallengeEscrow.toString(),
    routerStates: lifecycle.routerStates,
    bridgeBalance: bridgeBalance.toString(),
    unrelatedBridgeBalance: bridgeBalance.sub(totalEscrow).toString(),
    sourceEventCount: recovered.logs.length,
    sourceEventDigest: recovered.sourceEventDigest,
    lifecycleEventCount: lifecycle.lifecycleEventCount,
    lifecycleEventDigest: lifecycle.lifecycleEventDigest,
    legacyLiabilityDigest: lifecycle.legacyLiabilityDigest,
    history: history.evidence,
    historyEvidenceHash: ethers.constants.HashZero,
  }
  inventory.historyEvidenceHash = canonicalInventoryHistoryHash(inventory)
  assertCanonicalInventory(manifest, inventory)
  return inventory
}

export function canonicalInventoryHistoryHash(
  inventory: InventoryBundle
): string {
  return ethers.utils.keccak256(encodeInventoryHistoryEvidence(inventory))
}

const HISTORY_EVIDENCE_TYPE =
  "tuple(bytes32 historyCommitment,bytes32 emitterSetCommitment,uint64 blockCount,uint64 transactionCount,uint64 receiptCount,uint64 logCount,uint64 emitterLogCount,uint64 candidateCallCount,uint64 sourceEventCount,uint64 lifecycleEventCount,bytes32 emitterLogDigest,bytes32 candidateCallDigest,bytes32 sourceEventDigest,bytes32 lifecycleEventDigest,bytes32 legacyLiabilityDigest,uint256 bridgeBalance,uint256 unrelatedBridgeBalance)"

export function inventoryHistoryEvidence(
  inventory: InventoryBundle
): Record<string, unknown> {
  return {
    historyCommitment: inventory.history.historyCommitment,
    emitterSetCommitment: inventory.history.emitterSetCommitment,
    blockCount: inventory.history.blockCount,
    transactionCount: inventory.history.transactionCount,
    receiptCount: inventory.history.receiptCount,
    logCount: inventory.history.logCount,
    emitterLogCount: inventory.history.emitterLogCount,
    candidateCallCount: inventory.history.candidateCallCount,
    sourceEventCount: inventory.sourceEventCount,
    lifecycleEventCount: inventory.lifecycleEventCount,
    emitterLogDigest: inventory.history.emitterLogDigest,
    candidateCallDigest: inventory.history.candidateCallDigest,
    sourceEventDigest: inventory.sourceEventDigest,
    lifecycleEventDigest: inventory.lifecycleEventDigest,
    legacyLiabilityDigest: inventory.legacyLiabilityDigest,
    bridgeBalance: inventory.bridgeBalance,
    unrelatedBridgeBalance: inventory.unrelatedBridgeBalance,
  }
}

export function encodeInventoryHistoryEvidence(
  inventory: InventoryBundle
): string {
  return ethers.utils.defaultAbiCoder.encode(
    [HISTORY_EVIDENCE_TYPE],
    [inventoryHistoryEvidence(inventory)]
  )
}

export function inventorySnapshot(
  inventory: InventoryBundle
): Record<string, unknown> {
  return {
    finalizedBlock: inventory.finalizedBlock,
    finalizedBlockHash: inventory.finalizedBlockHash,
    challengeSetHash: inventory.challengeSetHash,
    challengeCount: inventory.challengeCount,
    totalEscrow: inventory.totalEscrow,
    history: inventoryHistoryEvidence(inventory),
  }
}

export function encodeInventorySnapshot(inventory: InventoryBundle): string {
  return ethers.utils.defaultAbiCoder.encode(
    [
      `tuple(uint64 finalizedBlock,bytes32 finalizedBlockHash,bytes32 challengeSetHash,uint32 challengeCount,uint256 totalEscrow,${HISTORY_EVIDENCE_TYPE} history)`,
    ],
    [inventorySnapshot(inventory)]
  )
}

const INVENTORY_SOURCE_ATTESTATION_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(
    "tbtc/ecdsa-fraud-cutover/inventory-source-attestation/v1"
  )
)
const SOURCE_CONTEXT_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/source-context/v1")
)
const RECONCILER_CONTEXT_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/reconciler-context/v1")
)
const SOURCE_CHECKPOINT_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/source-checkpoint/v1")
)
const RECONCILER_CHECKPOINT_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/reconciler-checkpoint/v1")
)
const SOURCE_STAGE_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/source-stage/v1")
)
const RECONCILER_STAGE_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/reconciler-stage/v1")
)

export function authorityContextCommitment(
  role: "source" | "reconciler",
  signer: string,
  sourceId: string,
  context: AuthorityContext
): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "address",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        role === "source" ? SOURCE_CONTEXT_DOMAIN : RECONCILER_CONTEXT_DOMAIN,
        signer,
        sourceId,
        context.durableStoreIdentity,
        context.endpointIdentity,
        context.trustDomain,
        context.policyHash,
      ]
    )
  )
}

export function cutoverAuthorityCommitment(manifest: HandoffManifest): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "bytes32", "bytes32", "address", "bytes32", "bytes32"],
      [
        manifest.sourceSigner,
        manifest.sourceId,
        authorityContextCommitment(
          "source",
          manifest.sourceSigner,
          manifest.sourceId,
          manifest.sourceContext
        ),
        manifest.reconciler,
        manifest.reconcilerSourceId,
        authorityContextCommitment(
          "reconciler",
          manifest.reconciler,
          manifest.reconcilerSourceId,
          manifest.reconcilerContext
        ),
      ]
    )
  )
}

export function checkpointRoleDigests(manifest: HandoffManifest): {
  source: string
  reconciler: string
} {
  return {
    source: ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [
          SOURCE_CHECKPOINT_DOMAIN,
          manifest.sourceCheckpointCommitment,
          authorityContextCommitment(
            "source",
            manifest.sourceSigner,
            manifest.sourceId,
            manifest.sourceContext
          ),
        ]
      )
    ),
    reconciler: ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [
          RECONCILER_CHECKPOINT_DOMAIN,
          manifest.sourceCheckpointCommitment,
          authorityContextCommitment(
            "reconciler",
            manifest.reconciler,
            manifest.reconcilerSourceId,
            manifest.reconcilerContext
          ),
        ]
      )
    ),
  }
}

export function inventoryAuthorityAttestationHashes(
  manifest: HandoffManifest,
  inventory: InventoryBundle
): { source: string; reconciler: string } {
  const routingCommitment = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint64"],
      [manifest.oldRouter, manifest.replacementRouter, inventory.scanStartBlock]
    )
  )
  const snapshotHash = ethers.utils.keccak256(
    encodeInventorySnapshot(inventory)
  )
  const digest = (role: "source" | "reconciler"): string =>
    ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "bytes32",
          "uint256",
          "address",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
        ],
        [
          INVENTORY_SOURCE_ATTESTATION_DOMAIN,
          role === "source" ? SOURCE_STAGE_DOMAIN : RECONCILER_STAGE_DOMAIN,
          manifest.chainId,
          manifest.bridge,
          routingCommitment,
          snapshotHash,
          inventory.historyEvidenceHash,
          authorityContextCommitment(
            role,
            role === "source" ? manifest.sourceSigner : manifest.reconciler,
            role === "source" ? manifest.sourceId : manifest.reconcilerSourceId,
            role === "source"
              ? manifest.sourceContext
              : manifest.reconcilerContext
          ),
          handoffPlanHash(manifest),
        ]
      )
    )
  return { source: digest("source"), reconciler: digest("reconciler") }
}

export function inventorySourceAttestationHash(
  manifest: HandoffManifest,
  inventory: InventoryBundle
): string {
  return inventoryAuthorityAttestationHashes(manifest, inventory).source
}

const BEGIN_AUTHORITY_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/begin-authority/v1")
)
const OWNER_AUTHORIZATION_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/owner-authorization/v1")
)

export function ownerAuthorizationHash(manifest: HandoffManifest): string {
  const routerCommitment = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "bytes32", "address", "bytes32"],
      [
        manifest.oldRouter,
        manifest.oldRouterRuntimeCodeHash,
        manifest.replacementRouter,
        manifest.replacementRouterRuntimeCodeHash,
      ]
    )
  )
  const authorityCommitment = cutoverAuthorityCommitment(manifest)
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint256",
        "address",
        "address",
        "bytes32",
        "uint64",
        "uint256",
        "bytes32",
        "bytes32",
      ],
      [
        OWNER_AUTHORIZATION_DOMAIN,
        manifest.chainId,
        manifest.newGovernance,
        manifest.bridge,
        routerCommitment,
        manifest.scanStartBlock,
        manifest.governanceDelay,
        authorityCommitment,
        canonicalEmitterSetCommitment(manifest.historyEmitters),
      ]
    )
  )
}

export function handoffPlanHash(manifest: HandoffManifest): string {
  const preflight = manifest.legacyInventorySourcePreflight
  const checkpointDigests = checkpointRoleDigests(manifest)
  const preflightCommitment = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint64",
        "bytes32",
        "uint8",
      ],
      [
        canonicalEmitterSetCommitment(manifest.historyEmitters),
        legacyInventorySourcePreflightHash(preflight),
        checkpointDigests.source,
        checkpointDigests.reconciler,
        preflight.history.finalizedBlock,
        preflight.history.finalizedBlockHash,
        manifest.maxTailBlocks,
      ]
    )
  )
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes32"],
      [
        BEGIN_AUTHORITY_DOMAIN,
        ownerAuthorizationHash(manifest),
        preflightCommitment,
      ]
    )
  )
}

export function encodeAuthorityProof(
  manifest: HandoffManifest,
  sourceManifestSignature: string,
  reconcilerManifestSignature: string
): string {
  const preflight = manifest.legacyInventorySourcePreflight
  return ethers.utils.defaultAbiCoder.encode(
    [
      "tuple(address sourceSigner,bytes32 sourceId,tuple(bytes32 durableStoreIdentity,bytes32 endpointIdentity,bytes32 trustDomain,bytes32 policyHash) sourceContext,address reconciler,bytes32 reconcilerSourceId,tuple(bytes32 durableStoreIdentity,bytes32 endpointIdentity,bytes32 trustDomain,bytes32 policyHash) reconcilerContext,bytes32 manifestPlanHash,bytes32 emitterSetCommitment,bytes32 sourcePreflightCommitment,bytes32 sourceCheckpointCommitment,uint64 sourcePreflightFinalizedBlock,bytes32 sourcePreflightFinalizedBlockHash,uint8 maxTailBlocks,bytes sourceManifestSignature,bytes reconcilerManifestSignature)",
    ],
    [
      {
        sourceSigner: manifest.sourceSigner,
        sourceId: manifest.sourceId,
        sourceContext: manifest.sourceContext,
        reconciler: manifest.reconciler,
        reconcilerSourceId: manifest.reconcilerSourceId,
        reconcilerContext: manifest.reconcilerContext,
        manifestPlanHash: handoffPlanHash(manifest),
        emitterSetCommitment: canonicalEmitterSetCommitment(
          manifest.historyEmitters
        ),
        sourcePreflightCommitment:
          legacyInventorySourcePreflightHash(preflight),
        sourceCheckpointCommitment: manifest.sourceCheckpointCommitment,
        sourcePreflightFinalizedBlock: preflight.history.finalizedBlock,
        sourcePreflightFinalizedBlockHash: preflight.history.finalizedBlockHash,
        maxTailBlocks: manifest.maxTailBlocks,
        sourceManifestSignature,
        reconcilerManifestSignature,
      },
    ]
  )
}

export function legacyInventorySourcePreflightHash(
  preflight: LegacyInventorySourcePreflight
): string {
  const { history } = preflight
  const historyHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "uint256",
        "address",
        "bytes32",
        "uint256",
        "uint256",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
      ],
      [
        history.chainId,
        history.bridge,
        history.emitterSetCommitment,
        history.scanStartBlock,
        history.finalizedBlock,
        history.startParentHash,
        history.startBlockHash,
        history.finalizedBlockHash,
        history.historyCommitment,
        history.blockCount,
        history.transactionCount,
        history.receiptCount,
        history.logCount,
        history.emitterLogCount,
        history.emitterLogDigest,
        history.candidateCallCount,
        history.candidateCallDigest,
      ]
    )
  )
  const routerStateHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(address emitter,bytes32 runtimeCodeHash,bytes32 protocolId,uint256 identityCount,uint256 unresolvedChallengeCount,uint256 totalEscrow,uint256 balance,uint256 unrelatedBalance,bytes32 liabilityDigest)[]",
      ],
      [
        preflight.routerStates.map((state) => ({
          emitter: state.address,
          runtimeCodeHash: state.runtimeCodeHash,
          protocolId: state.protocolId,
          identityCount: state.identityCount,
          unresolvedChallengeCount: state.unresolvedChallengeCount,
          totalEscrow: state.totalEscrow,
          balance: state.balance,
          unrelatedBalance: state.unrelatedBalance,
          liabilityDigest: state.liabilityDigest,
        })),
      ]
    )
  )
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
        "uint256",
        "bytes32",
        "uint256",
        "uint256",
        "bytes32",
      ],
      [
        historyHash,
        preflight.sourceEventCount,
        preflight.sourceEventDigest,
        preflight.lifecycleEventCount,
        preflight.lifecycleEventDigest,
        preflight.challengeIdentityCount,
        preflight.challengeIdentityDigest,
        preflight.unresolvedChallengeCount,
        preflight.totalEscrow,
        preflight.legacyLiabilityDigest,
        preflight.bridgeBalance,
        preflight.unrelatedBridgeBalance,
        routerStateHash,
      ]
    )
  )
}

export function assertLegacyInventorySourcePreflight(
  manifest: HandoffManifest,
  observed: LegacyInventorySourcePreflight = manifest.legacyInventorySourcePreflight
): void {
  const expected = manifest.legacyInventorySourcePreflight
  const expectedHistory = expected.history
  const observedHistory = observed.history
  if (
    !Number.isSafeInteger(expectedHistory.finalizedBlock) ||
    expectedHistory.scanStartBlock !== manifest.scanStartBlock ||
    expectedHistory.finalizedBlock < manifest.scanStartBlock ||
    expectedHistory.finalizedBlock < manifest.bridgeDeploymentBlock ||
    expectedHistory.chainId !== manifest.chainId ||
    expectedHistory.bridge.toLowerCase() !== manifest.bridge.toLowerCase() ||
    expectedHistory.emitterSetCommitment.toLowerCase() !==
      canonicalEmitterSetCommitment(manifest.historyEmitters).toLowerCase() ||
    expectedHistory.blockCount !==
      expectedHistory.finalizedBlock - expectedHistory.scanStartBlock + 1 ||
    expectedHistory.transactionCount !== expectedHistory.receiptCount ||
    expectedHistory.candidateCallCount !== expected.sourceEventCount ||
    !Number.isSafeInteger(expected.sourceEventCount) ||
    expected.sourceEventCount < 0 ||
    !Number.isSafeInteger(expected.challengeIdentityCount) ||
    expected.challengeIdentityCount < 0 ||
    expected.challengeIdentityCount > expected.sourceEventCount ||
    expected.unresolvedChallengeCount > expected.challengeIdentityCount ||
    expected.unresolvedChallengeCount !== 0 ||
    BigNumber.from(expected.bridgeBalance).lt(expected.totalEscrow) ||
    !BigNumber.from(expected.unrelatedBridgeBalance).eq(
      manifest.expectedUnrelatedBridgeBalance
    ) ||
    !BigNumber.from(expected.bridgeBalance).eq(
      BigNumber.from(expected.totalEscrow).add(expected.unrelatedBridgeBalance)
    ) ||
    expected.routerStates.length !== manifest.historyEmitters.length - 1 ||
    expected.routerStates.some((state, index) => {
      const emitter = manifest.historyEmitters[index + 1]
      return (
        state.address.toLowerCase() !== emitter.address.toLowerCase() ||
        state.runtimeCodeHash.toLowerCase() !==
          emitter.runtimeCodeHash.toLowerCase() ||
        state.unresolvedChallengeCount !== 0 ||
        !BigNumber.from(state.totalEscrow).isZero() ||
        !BigNumber.from(state.unrelatedBalance).eq(
          emitter.expectedUnrelatedBalance
        )
      )
    })
  ) {
    throw new Error("signed legacy inventory source preflight is malformed")
  }
  if (
    legacyInventorySourcePreflightHash(observed).toLowerCase() !==
      legacyInventorySourcePreflightHash(expected).toLowerCase() ||
    observedHistory.finalizedBlockHash.toLowerCase() !==
      expectedHistory.finalizedBlockHash.toLowerCase() ||
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

const EIP1271_MAGIC_VALUE = "0x1626ba7e"
const eip1271Interface = new ethers.utils.Interface([
  "function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)",
])

export async function assertAuthoritySignature(
  provider: providers.Provider,
  signer: string,
  digest: string,
  signature: string,
  label: string
): Promise<void> {
  const normalizedSigner = ethers.utils.getAddress(signer)
  const signedMessageHash = ethers.utils.hashMessage(
    ethers.utils.arrayify(digest)
  )
  const code = await provider.getCode(normalizedSigner)
  if (code !== "0x") {
    let result: string
    try {
      result = await provider.call({
        to: normalizedSigner,
        data: eip1271Interface.encodeFunctionData("isValidSignature", [
          signedMessageHash,
          signature,
        ]),
      })
    } catch (error) {
      throw new Error(`${label} EIP-1271 validation failed: ${String(error)}`)
    }
    if (
      ethers.utils.hexDataLength(result) < 4 ||
      ethers.utils.hexDataSlice(result, 0, 4).toLowerCase() !==
        EIP1271_MAGIC_VALUE
    ) {
      throw new Error(`${label} EIP-1271 signature is invalid`)
    }
    return
  }

  let recovered: string
  try {
    recovered = ethers.utils.verifyMessage(
      ethers.utils.arrayify(digest),
      signature
    )
  } catch (error) {
    throw new Error(`${label} EOA signature is invalid: ${String(error)}`)
  }
  if (recovered.toLowerCase() !== normalizedSigner.toLowerCase()) {
    throw new Error(`${label} signature is not from ${normalizedSigner}`)
  }
}

export async function assertManifestSignature(
  provider: providers.Provider,
  manifest: HandoffManifest,
  signature: string,
  signer: "source" | "reconciler" = "reconciler"
): Promise<void> {
  const expected =
    signer === "source" ? manifest.sourceSigner : manifest.reconciler
  await assertAuthoritySignature(
    provider,
    expected,
    handoffPlanHash(manifest),
    signature,
    `${signer} manifest`
  )
}

const RECONCILER_RECOVERY_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/reconciler-recovery/v1")
)
const RECONCILER_ENROLLMENT_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/reconciler-enrollment/v1")
)

function storedAuthorityCommitment(
  manifest: HandoffManifest,
  currentReconciler: string,
  currentReconcilerSourceId: string,
  currentReconcilerContext: AuthorityContext
): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "bytes32", "bytes32", "address", "bytes32", "bytes32"],
      [
        manifest.sourceSigner,
        manifest.sourceId,
        authorityContextCommitment(
          "source",
          manifest.sourceSigner,
          manifest.sourceId,
          manifest.sourceContext
        ),
        currentReconciler,
        currentReconcilerSourceId,
        authorityContextCommitment(
          "reconciler",
          currentReconciler,
          currentReconcilerSourceId,
          currentReconcilerContext
        ),
      ]
    )
  )
}

export function reconcilerEnrollmentAttestationHash(
  manifest: HandoffManifest,
  inventoryCommitment: string,
  currentReconciler: string,
  currentReconcilerSourceId: string,
  currentReconcilerContext: AuthorityContext,
  newReconciler: string,
  newReconcilerSourceId: string,
  newReconcilerContext: AuthorityContext
): string {
  const pendingCheckpointRoleDigest = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes32"],
      [
        RECONCILER_CHECKPOINT_DOMAIN,
        manifest.sourceCheckpointCommitment,
        authorityContextCommitment(
          "reconciler",
          newReconciler,
          newReconcilerSourceId,
          newReconcilerContext
        ),
      ]
    )
  )
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint256",
        "address",
        "address",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        RECONCILER_ENROLLMENT_DOMAIN,
        manifest.chainId,
        manifest.newGovernance,
        manifest.bridge,
        inventoryCommitment,
        handoffPlanHash(manifest),
        storedAuthorityCommitment(
          manifest,
          currentReconciler,
          currentReconcilerSourceId,
          currentReconcilerContext
        ),
        pendingCheckpointRoleDigest,
      ]
    )
  )
}

export function reconcilerRecoveryAttestationHash(
  manifest: HandoffManifest,
  inventoryCommitment: string,
  currentReconciler: string,
  currentReconcilerSourceId: string,
  currentReconcilerContext: AuthorityContext,
  enrollmentDigest: string,
  enrollmentAttestation: string
): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint256",
        "address",
        "address",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        RECONCILER_RECOVERY_DOMAIN,
        manifest.chainId,
        manifest.newGovernance,
        manifest.bridge,
        inventoryCommitment,
        handoffPlanHash(manifest),
        storedAuthorityCommitment(
          manifest,
          currentReconciler,
          currentReconcilerSourceId,
          currentReconcilerContext
        ),
        enrollmentDigest,
        ethers.utils.keccak256(enrollmentAttestation),
      ]
    )
  )
}

export function assertCutoverAuthoritySeparation(
  manifest: HandoffManifest
): void {
  const preflightBlock =
    manifest.legacyInventorySourcePreflight.history.finalizedBlock
  if (
    manifest.version !== 4 ||
    !ethers.utils.isHexString(manifest.sourceCheckpointCommitment, 32) ||
    BigNumber.from(manifest.sourceCheckpointCommitment).isZero() ||
    !Number.isSafeInteger(manifest.maxTailBlocks) ||
    manifest.maxTailBlocks < ECDSA_CUTOVER_MIN_AUTHENTICATED_TAIL_BLOCKS ||
    manifest.maxTailBlocks > ECDSA_CUTOVER_MAX_AUTHENTICATED_TAIL_BLOCKS ||
    preflightBlock < ECDSA_CUTOVER_DEFAULT_PREFLIGHT_CONFIRMATIONS
  ) {
    throw new Error("cutover authenticated-tail commitment is malformed")
  }
  const zeroAddress = ethers.constants.AddressZero.toLowerCase()
  const sourceSigner = ethers.utils.getAddress(manifest.sourceSigner)
  const reconciler = ethers.utils.getAddress(manifest.reconciler)
  const governanceOwner = ethers.utils.getAddress(manifest.governanceOwner)
  const oldGovernance = ethers.utils.getAddress(manifest.oldGovernance)
  const newGovernance = ethers.utils.getAddress(manifest.newGovernance)
  const addresses = [sourceSigner, reconciler]
  if (addresses.some((address) => address.toLowerCase() === zeroAddress)) {
    throw new Error("cutover source/reconciler authority cannot be zero")
  }
  if (sourceSigner.toLowerCase() === reconciler.toLowerCase()) {
    throw new Error("cutover source signer and reconciler must be distinct")
  }
  for (const authority of addresses) {
    if (
      authority.toLowerCase() === governanceOwner.toLowerCase() ||
      authority.toLowerCase() === oldGovernance.toLowerCase() ||
      authority.toLowerCase() === newGovernance.toLowerCase()
    ) {
      throw new Error(
        "cutover source/reconciler authorities must be distinct from owner and governance"
      )
    }
  }
  const sourceId = ethers.utils.hexZeroPad(manifest.sourceId, 32)
  const reconcilerSourceId = ethers.utils.hexZeroPad(
    manifest.reconcilerSourceId,
    32
  )
  if (
    sourceId === ethers.constants.HashZero ||
    reconcilerSourceId === ethers.constants.HashZero ||
    sourceId.toLowerCase() === reconcilerSourceId.toLowerCase()
  ) {
    throw new Error(
      "cutover source and reconciler provider identities must be nonzero and distinct"
    )
  }
  const { sourceContext, reconcilerContext } = manifest
  const fields: Array<keyof AuthorityContext> = [
    "durableStoreIdentity",
    "endpointIdentity",
    "trustDomain",
    "policyHash",
  ]
  if (
    !sourceContext ||
    !reconcilerContext ||
    fields.some(
      (field) =>
        !ethers.utils.isHexString(sourceContext[field], 32) ||
        !ethers.utils.isHexString(reconcilerContext[field], 32) ||
        BigNumber.from(sourceContext[field]).isZero() ||
        BigNumber.from(reconcilerContext[field]).isZero() ||
        sourceContext[field].toLowerCase() ===
          reconcilerContext[field].toLowerCase()
    )
  ) {
    throw new Error(
      "cutover authority store, endpoint, trust-domain, and policy identities must be nonzero and role-distinct"
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
    inventory.history.chainId !== manifest.chainId ||
    inventory.history.bridge.toLowerCase() !== manifest.bridge.toLowerCase() ||
    inventory.history.emitterSetCommitment.toLowerCase() !==
      canonicalEmitterSetCommitment(manifest.historyEmitters).toLowerCase() ||
    inventory.history.scanStartBlock !== inventory.scanStartBlock ||
    inventory.history.finalizedBlock !== inventory.finalizedBlock ||
    inventory.history.finalizedBlockHash.toLowerCase() !==
      inventory.finalizedBlockHash.toLowerCase() ||
    inventory.history.blockCount !==
      inventory.finalizedBlock - inventory.scanStartBlock + 1 ||
    inventory.history.transactionCount !== inventory.history.receiptCount ||
    inventory.history.candidateCallCount !== inventory.sourceEventCount
  ) {
    throw new Error("canonical receipt history metadata mismatch")
  }
  if (
    canonicalInventoryHistoryHash(inventory).toLowerCase() !==
    inventory.historyEvidenceHash.toLowerCase()
  ) {
    throw new Error("canonical receipt history evidence hash mismatch")
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
  if (
    !BigNumber.from(inventory.oldRouterOpenChallengeCount).isZero() ||
    !BigNumber.from(inventory.oldRouterOpenChallengeEscrow).isZero() ||
    inventory.routerStates.length !== manifest.historyEmitters.length - 1 ||
    inventory.routerStates.some(
      (state) =>
        state.unresolvedChallengeCount !== 0 ||
        !BigNumber.from(state.totalEscrow).isZero()
    )
  ) {
    throw new Error("old router still has unresolved challenges")
  }
  if (
    !BigNumber.from(inventory.unrelatedBridgeBalance).eq(
      manifest.expectedUnrelatedBridgeBalance
    ) ||
    !BigNumber.from(inventory.bridgeBalance).eq(
      BigNumber.from(inventory.totalEscrow).add(
        inventory.unrelatedBridgeBalance
      )
    )
  ) {
    throw new Error(
      "Bridge balance does not equal legacy escrow plus signed unrelated funds"
    )
  }
  if (
    inventory.lifecycleEventCount < inventory.sourceEventCount ||
    inventory.challengeCount > inventory.sourceEventCount ||
    inventory.history.emitterLogCount < inventory.lifecycleEventCount
  ) {
    throw new Error("canonical lifecycle/event accounting mismatch")
  }
  if (
    inventory.challengeCount !== 0 ||
    !BigNumber.from(inventory.totalEscrow).isZero()
  ) {
    throw new Error(
      "cutover activation requires an empty Bridge legacy inventory"
    )
  }
}
