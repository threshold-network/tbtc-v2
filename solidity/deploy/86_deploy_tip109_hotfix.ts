import fs from "fs"
import path from "path"
import https from "https"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { BigNumber, providers, utils } from "ethers"

import {
  EIP_1967_ADMIN_SLOT,
  KNOWN_PROXY_ADMIN,
  KNOWN_TIMELOCK,
  KNOWN_COUNCIL_SAFE,
} from "./85_deploy_tip109_governance_upgrade"

const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
]

const BRIDGE_GOVERNANCE_ABI = [
  "function seedFraudChallengeEscrow(uint256 preUpgradeOpenEscrow)",
  "function seedWalletRegistrationOrder(bytes20[] wallets)",
  "function beginBridgeGovernanceTransfer(address newBridgeGovernance)",
  "function finalizeBridgeGovernanceTransfer()",
  "function transferOwnership(address newOwner)",
  "function setVaultStatus(address vault, bool isTrusted)",
  "function setMigrationDebtVault(address vault)",
  "function initiateLegacyVaultUpgrade(address coordinator, address successorVault)",
  "function finalizeLegacyVaultMigration(address coordinator, uint256 snapshotBlockNumber, bytes32 snapshotBlockHash, bytes32 evidenceHash)",
]

const TBTC_VAULT_ABI = [
  "function initiateUpgrade(address newVault)",
  "function finalizeUpgrade()",
  "function transferOwnership(address newOwner)",
  "function pauseOptimisticMinting()",
]

// Exact mainnet identity of the legacy optimistic-minting TBTCVault, mirroring
// the Bridge constants. The pinned optimistic-minting scan hard-codes its
// deployment block on chain 1.
const LEGACY_MAINNET_TBTC_VAULT = "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD"
const LEGACY_MAINNET_TBTC_VAULT_DEPLOYMENT_BLOCK = 16472741
// keccak256 of the immutable legacy TBTCVault's on-chain runtime code, mirroring
// the Bridge's `LEGACY_MAINNET_TBTC_VAULT_CODE_HASH` constant. Used by the
// Phase-I preflight (runbook section 7 step 1) to abort — before any deployment
// or action generation — if the resolved legacy vault is not the exact audited
// mainnet bytecode. The post-deployment check re-derives the same value from the
// freshly compiled Bridge implementation as an independent second binding check.
const LEGACY_MAINNET_TBTC_VAULT_CODE_HASH =
  "0x549c4b627e40d0e38e6d874c56066ad033004f3f5e26ffba9b15806064f6f0df"
// Domain tag bound into the retirement evidence digest.
const OM_RETIREMENT_DOMAIN = utils.keccak256(
  utils.toUtf8Bytes("TBTC_LEGACY_OM_RETIREMENT_V1")
)
// Confirmations behind chain head used to pin a finalized snapshot block.
const SNAPSHOT_CONFIRMATIONS = 64
// Legacy vault's 24-hour upgrade governance delay.
const LEGACY_UPGRADE_DELAY_SECONDS = 86400

// Read ABI for the pinned optimistic-minting retirement scan: the Bridge
// per-deposit request, the legacy vault's pause/owner/upgrade state, the
// coordinator lock, the residual per-depositor debt mapping, and the
// finalization event.
const LEGACY_OM_SCAN_ABI = [
  "function deposits(uint256 depositKey) view returns (tuple(address depositor, uint64 amount, uint32 revealedAt, address vault, uint64 treasuryFee, uint32 sweptAt, bytes32 extraData))",
  "function isOptimisticMintingPaused() view returns (bool)",
  "function owner() view returns (address)",
  "function newVault() view returns (address)",
  "function upgradeInitiatedTimestamp() view returns (uint256)",
  "function migrationLocked() view returns (bool)",
  "function optimisticMintingDebt(address depositor) view returns (uint256)",
  "event OptimisticMintingFinalized(address indexed minter, uint256 indexed depositKey, address indexed depositor, uint256 optimisticMintingDebt)",
]

const COORDINATOR_ABI = [
  "function controller() view returns (address)",
  "function legacyVault() view returns (address)",
  "function bridge() view returns (address)",
]

// Retirement-time reads used to gate cutover generation. The two legacy
// constants are read from the freshly compiled Bridge implementation so the
// generated cutover is bound to the exact legacy address and runtime code hash
// the on-chain guard enforces; the trust/pointer/owner getters are read live at
// the chain head immediately before generation (spec section 7 step 12).
const RETIREMENT_STATE_ABI = [
  "function LEGACY_MAINNET_TBTC_VAULT() view returns (address)",
  "function LEGACY_MAINNET_TBTC_VAULT_CODE_HASH() view returns (bytes32)",
  "function isVaultTrusted(address vault) view returns (bool)",
  "function migrationDebtVault() view returns (address)",
  "function owner() view returns (address)",
]

// Canonical Multicall3 deployment, present on mainnet long before the legacy
// vault's deployment block. The pinned scan batches its per-deposit and
// per-depositor reads through it with all-or-nothing decoding.
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11"
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
]

const BRIDGE_EVENT_ABI = [
  "event FraudChallengeSubmitted(bytes20 indexed walletPubKeyHash, bytes32 sighash, uint8 v, bytes32 r, bytes32 s)",
  "event FraudChallengeDefeated(bytes20 indexed walletPubKeyHash, bytes32 sighash)",
  "event FraudChallengeDefeatTimedOut(bytes20 indexed walletPubKeyHash, bytes32 sighash)",
  "event NewWalletRegistered(bytes32 indexed ecdsaWalletID, bytes20 indexed walletPubKeyHash)",
]

const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)
const bridgeGovernanceInterface = new utils.Interface(BRIDGE_GOVERNANCE_ABI)
const tbtcVaultInterface = new utils.Interface(TBTC_VAULT_ABI)
const bridgeEventInterface = new utils.Interface(BRIDGE_EVENT_ABI)
const legacyOmScanInterface = new utils.Interface(LEGACY_OM_SCAN_ABI)
const coordinatorInterface = new utils.Interface(COORDINATOR_ABI)
const retirementStateInterface = new utils.Interface(RETIREMENT_STATE_ABI)
const multicall3Interface = new utils.Interface(MULTICALL3_ABI)
const FRAUD_LOG_SCAN_CHUNK_SIZE = 100000
// Bounded batch size for Multicall3 aggregate reads: keeps each aggregate call's
// calldata/returndata within RPC limits while collapsing thousands of scan reads
// into a few round-trips.
const MULTICALL_BATCH_SIZE = 500

/**
 * Deterministically derives the retirement evidence digest that the Council
 * signs and the Bridge records via the attestation. The digest is a pure
 * function of the scan inputs — chain, addresses, block range, finalized-event
 * count, and the ascending set of finalized deposit keys — so two independent
 * archive providers producing the same complete set produce the same digest.
 * The trailing `uint256(0)` is the unswept finalized-deposit count, which the
 * scan enforces to be zero before generating a cutover.
 */
export function computeEvidenceDigest(params: {
  chainId: number
  legacyVault: string
  bridge: string
  fromBlock: number
  snapshotBlockNumber: number
  snapshotBlockHash: string
  finalizedEventCount: number
  depositKeys: BigNumber[]
}): { depositSetHash: string; evidenceHash: string } {
  const sortedKeys = [...params.depositKeys].sort((left, right) => {
    if (left.lt(right)) {
      return -1
    }
    return left.gt(right) ? 1 : 0
  })
  const depositSetHash = utils.keccak256(
    utils.hexConcat(
      sortedKeys.map((key) => utils.hexZeroPad(key.toHexString(), 32))
    )
  )
  const evidenceHash = utils.keccak256(
    utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint256",
        "address",
        "address",
        "uint256",
        "uint256",
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
      ],
      [
        OM_RETIREMENT_DOMAIN,
        params.chainId,
        params.legacyVault,
        params.bridge,
        params.fromBlock,
        params.snapshotBlockNumber,
        params.snapshotBlockHash,
        params.finalizedEventCount,
        depositSetHash,
        0,
      ]
    )
  )
  return { depositSetHash, evidenceHash }
}

interface PendingOptimisticMint {
  depositKey: string
  depositor: string
  amount: string
  revealedAt: number
  fundingEvent: {
    blockNumber: number
    transactionHash: string
    logIndex: number
  }
}

interface OptimisticMintScanResult {
  fromBlock: number
  snapshotBlockNumber: number
  snapshotBlockHash: string
  finalizedEventCount: number
  finalizedDepositKeys: string[]
  pending: PendingOptimisticMint[]
  residualDebtorCount: number
  residualDebtTotal: string
  depositSetHash: string
  evidenceHash: string
}

async function getOptimisticMintingFinalizedLogs(
  provider: providers.Provider,
  vaultAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<providers.Log[]> {
  const topics = [
    legacyOmScanInterface.getEventTopic("OptimisticMintingFinalized"),
  ]
  const logs: providers.Log[] = []
  for (let startBlock = fromBlock; startBlock <= toBlock; ) {
    const endBlock = Math.min(
      startBlock + FRAUD_LOG_SCAN_CHUNK_SIZE - 1,
      toBlock
    )
    // eslint-disable-next-line no-await-in-loop
    const chunk = await provider.getLogs({
      address: vaultAddress,
      topics,
      fromBlock: startBlock,
      toBlock: endBlock,
    })
    logs.push(...chunk)
    startBlock = endBlock + 1
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

async function readAtBlock(
  provider: providers.Provider,
  to: string,
  data: string,
  blockTag: number
): Promise<string> {
  return provider.call({ to, data }, blockTag)
}

/**
 * Reads a batch of static calls pinned to a single block through Multicall3, in
 * bounded chunks, with all-or-nothing decoding. `allowFailure` is false, so
 * Multicall3 reverts the whole aggregate if any subcall fails; a returned result
 * therefore already implies every subcall succeeded. Each entry is nonetheless
 * re-checked for success and nonempty data, and any failure aborts the scan.
 * Collapsing thousands of per-deposit/per-depositor reads into a handful of
 * batched round-trips is the spec's (section 3.3) required scan hardening.
 */
async function batchReadAtBlock(
  provider: providers.Provider,
  calls: { target: string; callData: string }[],
  blockTag: number
): Promise<string[]> {
  const results: string[] = []
  for (let start = 0; start < calls.length; start += MULTICALL_BATCH_SIZE) {
    const chunk = calls.slice(start, start + MULTICALL_BATCH_SIZE)
    const aggregateCalldata = multicall3Interface.encodeFunctionData(
      "aggregate3",
      [
        chunk.map((call) => ({
          target: call.target,
          allowFailure: false,
          callData: call.callData,
        })),
      ]
    )
    // eslint-disable-next-line no-await-in-loop
    const raw = await provider.call(
      { to: MULTICALL3_ADDRESS, data: aggregateCalldata },
      blockTag
    )
    const [decoded] = multicall3Interface.decodeFunctionResult(
      "aggregate3",
      raw
    )
    decoded.forEach((entry: { success: boolean; returnData: string }) => {
      if (!entry.success || entry.returnData === "0x") {
        throw new Error(
          "Multicall3 subcall failed or returned empty data during the pinned scan"
        )
      }
      results.push(entry.returnData)
    })
  }
  return results
}

/**
 * Aborts unless the just-deployed coordinator's on-chain runtime bytecode matches
 * the compiled artifact. The coordinator embeds three immutable addresses in its
 * runtime, so the immutable byte ranges (from the build-info
 * `immutableReferences`) are masked to zero in both the on-chain code and the
 * compiled `deployedBytecode` before comparison; the immutables themselves are
 * separately validated by the binding reads. This is defense against a
 * coordinator that reports correct bindings but was deployed from different or
 * tampered bytecode (spec section 3.3: verify runtime code, not merely bindings).
 */
async function assertCoordinatorRuntimeMatchesArtifact(
  hre: HardhatRuntimeEnvironment,
  provider: providers.Provider,
  coordinatorAddress: string
): Promise<void> {
  const sourceName = "contracts/vault/LegacyTBTCVaultMigrationCoordinator.sol"
  const contractName = "LegacyTBTCVaultMigrationCoordinator"
  const buildInfo = await hre.artifacts.getBuildInfo(
    `${sourceName}:${contractName}`
  )
  const compiled = (buildInfo as any)?.output?.contracts?.[sourceName]?.[
    contractName
  ]
  const deployedBytecode = compiled?.evm?.deployedBytecode
  if (!deployedBytecode || typeof deployedBytecode.object !== "string") {
    throw new Error(
      "Coordinator compiled deployedBytecode not found for runtime verification"
    )
  }
  const expectedHex = deployedBytecode.object.startsWith("0x")
    ? deployedBytecode.object
    : `0x${deployedBytecode.object}`
  const immutableReferences = deployedBytecode.immutableReferences ?? {}
  const onchainHex = await provider.getCode(coordinatorAddress)

  const expectedBytes = utils.arrayify(expectedHex)
  const onchainBytes = utils.arrayify(onchainHex)
  if (onchainBytes.length !== expectedBytes.length) {
    throw new Error(
      `Coordinator runtime bytecode length ${onchainBytes.length} does not ` +
        `match the compiled artifact length ${expectedBytes.length}`
    )
  }
  const maskImmutables = (bytes: Uint8Array): string => {
    const copy = Uint8Array.from(bytes)
    ;(
      Object.values(immutableReferences) as Array<
        Array<{ start: number; length: number }>
      >
    ).forEach((refs) => {
      refs.forEach(({ start, length }) => {
        for (let i = 0; i < length && start + i < copy.length; i += 1) {
          copy[start + i] = 0
        }
      })
    })
    return utils.hexlify(copy)
  }
  if (maskImmutables(onchainBytes) !== maskImmutables(expectedBytes)) {
    throw new Error(
      "Coordinator runtime bytecode does not match the compiled artifact"
    )
  }
}

/**
 * Runs the pinned, all-or-nothing scan that proves the dangerous set
 *
 *   P = { depositKey | legacy emitted OptimisticMintingFinalized AND
 *         Bridge.deposits(depositKey).sweptAt == 0 }
 *
 * is empty before the legacy vault is retired. Every event query and every
 * per-deposit state read is pinned to the same finalized snapshot block; any
 * subcall failure or data-integrity mismatch aborts the scan. A nonzero residual
 * `optimisticMintingDebt` for a fully-swept depositor is reported informationally
 * and never gates the migration.
 */
export async function scanPendingOptimisticMints(
  provider: providers.Provider,
  params: {
    chainId: number
    legacyVault: string
    bridge: string
    coordinator: string
    successorVault: string
    fromBlockOverride?: number
    snapshotBlockNumberOverride?: number
    requireLockedState: boolean
  }
): Promise<OptimisticMintScanResult> {
  // 1. Enforce the hard-coded legacy deployment origin on mainnet; reject any
  //    override that would start the scan later and miss finalized mints.
  const isKnownMainnetLegacy =
    params.chainId === 1 &&
    params.legacyVault.toLowerCase() === LEGACY_MAINNET_TBTC_VAULT.toLowerCase()
  let fromBlock = LEGACY_MAINNET_TBTC_VAULT_DEPLOYMENT_BLOCK
  if (isKnownMainnetLegacy) {
    if (
      params.fromBlockOverride !== undefined &&
      params.fromBlockOverride > LEGACY_MAINNET_TBTC_VAULT_DEPLOYMENT_BLOCK
    ) {
      throw new Error(
        `Refusing scan: from-block override ${params.fromBlockOverride} starts ` +
          "after the enforced legacy deployment block " +
          `${LEGACY_MAINNET_TBTC_VAULT_DEPLOYMENT_BLOCK}`
      )
    }
  } else if (params.fromBlockOverride !== undefined) {
    fromBlock = params.fromBlockOverride
  }

  // 2. Pin a finalized snapshot block and record its hash. Any override MUST be
  //    at or behind the finality boundary. An unfinalized snapshot can be
  //    orphaned by a shallow reorg, which would let the Council attest
  //    zero-pending evidence bound to a block hash that is no longer on the
  //    canonical chain: a later sweep would then take the untrusted-legacy Bank
  //    credit branch without optimistic-debt repayment and reopen the
  //    double-mint window. This throws before any evidence digest, summary JSON,
  //    or cutover calldata is produced.
  const latest = await provider.getBlockNumber()
  const finalityBoundary = latest - SNAPSHOT_CONFIRMATIONS
  const snapshotBlockNumber =
    params.snapshotBlockNumberOverride ?? finalityBoundary
  if (snapshotBlockNumber > finalityBoundary) {
    throw new Error(
      `Refusing scan: snapshot block ${snapshotBlockNumber} is newer than the ` +
        `finalized boundary ${finalityBoundary} (latest ${latest} - ` +
        `${SNAPSHOT_CONFIRMATIONS} confirmations). An unfinalized snapshot can ` +
        "be orphaned by a reorg and invalidate the retirement evidence."
    )
  }
  const snapshotBlock = await provider.getBlock(snapshotBlockNumber)
  if (!snapshotBlock || !snapshotBlock.hash) {
    throw new Error(`Snapshot block ${snapshotBlockNumber} is not available`)
  }
  const snapshotBlockHash = snapshotBlock.hash

  // 3-4. Collect every finalized deposit key through the snapshot; duplicates
  //      are a data-integrity error.
  const logs = await getOptimisticMintingFinalizedLogs(
    provider,
    params.legacyVault,
    fromBlock,
    snapshotBlockNumber
  )
  const depositKeys: BigNumber[] = []
  const depositorByKey = new Map<string, string>()
  const eventByKey = new Map<string, providers.Log>()
  // eslint-disable-next-line no-restricted-syntax
  for (const log of logs) {
    const parsed = legacyOmScanInterface.parseLog(log)
    const key = BigNumber.from(parsed.args.depositKey)
    const keyHex = key.toHexString()
    if (depositorByKey.has(keyHex)) {
      throw new Error(`Duplicate finalized deposit key ${keyHex}`)
    }
    depositKeys.push(key)
    depositorByKey.set(keyHex, utils.getAddress(String(parsed.args.depositor)))
    eventByKey.set(keyHex, log)
  }

  // 5-7. Read every deposit at the snapshot block through bounded, all-or-nothing
  //      Multicall3 batches; validate integrity; collect the unswept finalized
  //      set P. A short or failed subcall aborts the whole scan.
  const depositRaws = await batchReadAtBlock(
    provider,
    depositKeys.map((key) => ({
      target: params.bridge,
      callData: legacyOmScanInterface.encodeFunctionData("deposits", [key]),
    })),
    snapshotBlockNumber
  )
  const pending: PendingOptimisticMint[] = []
  depositKeys.forEach((key, index) => {
    const keyHex = key.toHexString()
    const [request] = legacyOmScanInterface.decodeFunctionResult(
      "deposits",
      depositRaws[index]
    )
    if (Number(request.revealedAt) === 0) {
      throw new Error(`Deposit ${keyHex} has no reveal at the snapshot block`)
    }
    if (
      utils.getAddress(request.vault) !== utils.getAddress(params.legacyVault)
    ) {
      throw new Error(
        `Deposit ${keyHex} is routed to ${request.vault}, not the legacy vault`
      )
    }
    if (utils.getAddress(request.depositor) !== depositorByKey.get(keyHex)) {
      throw new Error(`Deposit ${keyHex} depositor mismatch vs the event`)
    }
    if (Number(request.sweptAt) === 0) {
      const event = eventByKey.get(keyHex) as providers.Log
      pending.push({
        depositKey: keyHex,
        depositor: depositorByKey.get(keyHex) as string,
        amount: BigNumber.from(request.amount).toString(),
        revealedAt: Number(request.revealedAt),
        fundingEvent: {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          logIndex: event.logIndex,
        },
      })
    }
  })

  // 8. Require the freeze state at the snapshot block. Skipped for the
  //    informational preparation-phase scan (before ownership has moved).
  if (params.requireLockedState) {
    const [paused] = legacyOmScanInterface.decodeFunctionResult(
      "isOptimisticMintingPaused",
      await readAtBlock(
        provider,
        params.legacyVault,
        legacyOmScanInterface.encodeFunctionData("isOptimisticMintingPaused"),
        snapshotBlockNumber
      )
    )
    if (!paused) {
      throw new Error("Legacy vault is not paused at the snapshot block")
    }

    const [legacyOwner] = legacyOmScanInterface.decodeFunctionResult(
      "owner",
      await readAtBlock(
        provider,
        params.legacyVault,
        legacyOmScanInterface.encodeFunctionData("owner"),
        snapshotBlockNumber
      )
    )
    if (
      utils.getAddress(legacyOwner) !== utils.getAddress(params.coordinator)
    ) {
      throw new Error(
        "Legacy vault is not owned by the coordinator at the snapshot block"
      )
    }

    const [locked] = legacyOmScanInterface.decodeFunctionResult(
      "migrationLocked",
      await readAtBlock(
        provider,
        params.coordinator,
        legacyOmScanInterface.encodeFunctionData("migrationLocked"),
        snapshotBlockNumber
      )
    )
    if (!locked) {
      throw new Error(
        "Coordinator is not migration-locked at the snapshot block"
      )
    }

    const [pendingNewVault] = legacyOmScanInterface.decodeFunctionResult(
      "newVault",
      await readAtBlock(
        provider,
        params.legacyVault,
        legacyOmScanInterface.encodeFunctionData("newVault"),
        snapshotBlockNumber
      )
    )
    if (
      utils.getAddress(pendingNewVault) !==
      utils.getAddress(params.successorVault)
    ) {
      throw new Error(
        "Legacy vault newVault does not match the successor at the snapshot block"
      )
    }

    const [initiatedAt] = legacyOmScanInterface.decodeFunctionResult(
      "upgradeInitiatedTimestamp",
      await readAtBlock(
        provider,
        params.legacyVault,
        legacyOmScanInterface.encodeFunctionData("upgradeInitiatedTimestamp"),
        snapshotBlockNumber
      )
    )
    if (
      BigNumber.from(initiatedAt).eq(0) ||
      snapshotBlock.timestamp - Number(initiatedAt) <
        LEGACY_UPGRADE_DELAY_SECONDS
    ) {
      throw new Error(
        "Legacy upgrade 24-hour delay has not elapsed at the snapshot block"
      )
    }
  }

  // 9. Read residual per-depositor debt at the SAME snapshot block through the
  //    same bounded, all-or-nothing Multicall3 batching. Purely informational;
  //    never gates the migration.
  const distinctDepositors = [...new Set(depositorByKey.values())]
  const debtRaws = await batchReadAtBlock(
    provider,
    distinctDepositors.map((depositor) => ({
      target: params.legacyVault,
      callData: legacyOmScanInterface.encodeFunctionData(
        "optimisticMintingDebt",
        [depositor]
      ),
    })),
    snapshotBlockNumber
  )
  let residualDebtorCount = 0
  let residualDebtTotal = BigNumber.from(0)
  debtRaws.forEach((raw) => {
    const [debt] = legacyOmScanInterface.decodeFunctionResult(
      "optimisticMintingDebt",
      raw
    )
    if (BigNumber.from(debt).gt(0)) {
      residualDebtorCount += 1
      residualDebtTotal = residualDebtTotal.add(debt)
    }
  })

  const { depositSetHash, evidenceHash } = computeEvidenceDigest({
    chainId: params.chainId,
    legacyVault: params.legacyVault,
    bridge: params.bridge,
    fromBlock,
    snapshotBlockNumber,
    snapshotBlockHash,
    finalizedEventCount: depositKeys.length,
    depositKeys,
  })

  return {
    fromBlock,
    snapshotBlockNumber,
    snapshotBlockHash,
    finalizedEventCount: depositKeys.length,
    finalizedDepositKeys: depositKeys.map((key) => key.toHexString()),
    pending,
    residualDebtorCount,
    residualDebtTotal: residualDebtTotal.toString(),
    depositSetHash,
    evidenceHash,
  }
}

function encodeUpgrade(proxy: string, newImpl: string): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [proxy, newImpl])
}

function encodeSeedFraudChallengeEscrow(
  preUpgradeOpenEscrow: BigNumber
): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "seedFraudChallengeEscrow",
    [preUpgradeOpenEscrow]
  )
}

function encodeSeedWalletRegistrationOrder(wallets: string[]): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "seedWalletRegistrationOrder",
    [wallets]
  )
}

function encodeBeginBridgeGovernanceTransfer(
  newBridgeGovernance: string
): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "beginBridgeGovernanceTransfer",
    [newBridgeGovernance]
  )
}

function encodeFinalizeBridgeGovernanceTransfer(): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "finalizeBridgeGovernanceTransfer",
    []
  )
}

function encodeTransferOwnership(newOwner: string): string {
  return bridgeGovernanceInterface.encodeFunctionData("transferOwnership", [
    newOwner,
  ])
}

function encodeTransferVaultOwnership(newOwner: string): string {
  return tbtcVaultInterface.encodeFunctionData("transferOwnership", [newOwner])
}

function encodePauseOptimisticMinting(): string {
  return tbtcVaultInterface.encodeFunctionData("pauseOptimisticMinting", [])
}

function encodeInitiateLegacyVaultUpgrade(
  coordinator: string,
  successorVault: string
): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "initiateLegacyVaultUpgrade",
    [coordinator, successorVault]
  )
}

function encodeFinalizeLegacyVaultMigration(
  coordinator: string,
  snapshotBlockNumber: number,
  snapshotBlockHash: string,
  evidenceHash: string
): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "finalizeLegacyVaultMigration",
    [coordinator, snapshotBlockNumber, snapshotBlockHash, evidenceHash]
  )
}

// Exported so the Stage-3 combined upgrade script (88) can reuse the same
// tested fraud-challenge log scanner instead of duplicating it.
export async function getFraudChallengeLogs(
  provider: providers.Provider,
  bridgeAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<providers.Log[]> {
  const topics = [
    [
      bridgeEventInterface.getEventTopic("FraudChallengeSubmitted"),
      bridgeEventInterface.getEventTopic("FraudChallengeDefeated"),
      bridgeEventInterface.getEventTopic("FraudChallengeDefeatTimedOut"),
    ],
  ]

  const logs: providers.Log[] = []

  for (let startBlock = fromBlock; startBlock <= toBlock; ) {
    const endBlock = Math.min(
      startBlock + FRAUD_LOG_SCAN_CHUNK_SIZE - 1,
      toBlock
    )

    // eslint-disable-next-line no-await-in-loop
    const chunk = await provider.getLogs({
      address: bridgeAddress,
      topics,
      fromBlock: startBlock,
      toBlock: endBlock,
    })
    logs.push(...chunk)

    startBlock = endBlock + 1
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

// Exported so the Stage-3 combined upgrade script (88) can reuse the same
// tested open-escrow computation instead of duplicating it.
export async function computeOpenFraudChallengeEscrow(
  provider: providers.Provider,
  bridgeAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<BigNumber> {
  const logs = await getFraudChallengeLogs(
    provider,
    bridgeAddress,
    fromBlock,
    toBlock
  )
  const openChallenges = new Map<string, BigNumber>()
  const txValues = new Map<string, BigNumber>()
  let openEscrow = BigNumber.from(0)

  // eslint-disable-next-line no-restricted-syntax
  for (const log of logs) {
    const parsed = bridgeEventInterface.parseLog(log)
    const challengeKey = `${String(
      parsed.args.walletPubKeyHash
    ).toLowerCase()}:${String(parsed.args.sighash).toLowerCase()}`

    if (parsed.name === "FraudChallengeSubmitted") {
      let txValue = txValues.get(log.transactionHash)
      if (!txValue) {
        // eslint-disable-next-line no-await-in-loop
        const tx = await provider.getTransaction(log.transactionHash)
        if (!tx) {
          throw new Error(`Missing transaction ${log.transactionHash}`)
        }
        if (tx.to?.toLowerCase() !== bridgeAddress.toLowerCase()) {
          throw new Error(
            `Fraud challenge ${challengeKey} was not submitted directly to ` +
              "the Bridge; compute the escrow seed with transaction traces"
          )
        }

        txValue = tx.value
        txValues.set(log.transactionHash, txValue)
      }

      if (openChallenges.has(challengeKey)) {
        throw new Error(`Duplicate open fraud challenge ${challengeKey}`)
      }

      openChallenges.set(challengeKey, txValue)
      openEscrow = openEscrow.add(txValue)
    } else {
      const txValue = openChallenges.get(challengeKey)
      if (!txValue) {
        throw new Error(`Resolved unknown fraud challenge ${challengeKey}`)
      }

      openChallenges.delete(challengeKey)
      openEscrow = openEscrow.sub(txValue)
    }
  }

  return openEscrow
}

/**
 * Reconstructs the canonical wallet registration order by scanning
 * `NewWalletRegistered` events and returning the wallet public key hashes in
 * event-emission order. This mirrors both the off-chain keep-core target-wallet
 * selection and the on-chain append order of `walletRegistrationOrder`, so the
 * returned list is exactly what `seedWalletRegistrationOrder` must be seeded
 * with for the deterministic moving-funds target selection to be enforced for
 * pre-upgrade wallets. Duplicate hashes cannot occur because a wallet is
 * registered at most once.
 */
// Exported so the Stage-3 combined upgrade script (88) can reuse the same
// tested wallet-registration-order scanner instead of duplicating it.
export async function computeWalletRegistrationOrder(
  provider: providers.Provider,
  bridgeAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<string[]> {
  const topics = [bridgeEventInterface.getEventTopic("NewWalletRegistered")]

  const logs: providers.Log[] = []

  for (let startBlock = fromBlock; startBlock <= toBlock; ) {
    const endBlock = Math.min(
      startBlock + FRAUD_LOG_SCAN_CHUNK_SIZE - 1,
      toBlock
    )

    // eslint-disable-next-line no-await-in-loop
    const chunk = await provider.getLogs({
      address: bridgeAddress,
      topics,
      fromBlock: startBlock,
      toBlock: endBlock,
    })
    logs.push(...chunk)

    startBlock = endBlock + 1
  }

  logs.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber - right.blockNumber
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex
    }
    return left.logIndex - right.logIndex
  })

  return logs.map(
    (log) => bridgeEventInterface.parseLog(log).args.walletPubKeyHash as string
  )
}

/**
 * Submits a contract for source verification on Etherscan using the v2 API.
 * The legacy v1 API used by @nomiclabs/hardhat-etherscan is deprecated.
 */
async function etherscanVerifyV2(
  apiKey: string,
  chainId: number,
  contractAddress: string,
  contractName: string,
  compilerVersion: string,
  solcInputJson: string
): Promise<string> {
  const queryString = `chainid=${chainId}`
  const postData = new URLSearchParams({
    apikey: apiKey,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: contractAddress,
    sourceCode: solcInputJson,
    codeformat: "solidity-standard-json-input",
    contractname: contractName,
    compilerversion: compilerVersion,
    optimizationUsed: "1",
    runs: "1000",
  }).toString()

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.etherscan.io",
        path: `/v2/api?${queryString}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk) => {
          data += chunk
        })
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.status === "1" && parsed.result) {
              resolve(parsed.result)
            } else {
              reject(
                new Error(parsed.result || parsed.message || "Unknown error")
              )
            }
          } catch {
            reject(new Error(`Invalid response: ${data.substring(0, 200)}`))
          }
        })
      }
    )
    req.on("error", reject)
    req.write(postData)
    req.end()
  })
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, artifacts } = hre
  const { deploy, get, save } = deployments
  const { deployer } = await getNamedAccounts()
  const { ethers } = hre

  // Patch ethers.js v5 Formatter to handle empty-string `to` field returned
  // by some RPC providers for contract-creation transactions. Without this
  // patch, hardhat-deploy fails with "invalid address" on deploy receipts.
  // Same pattern used in cross-chain Wormhole V2 upgrade scripts.
  const originalFormat = providers.Formatter.prototype.transactionResponse
  providers.Formatter.prototype.transactionResponse = function (tx: any): any {
    const patched = tx.to === "" ? { ...tx, to: null } : tx
    return originalFormat.call(this, patched)
  }

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  console.log("=".repeat(80))
  console.log("TIP-109 Hotfix Deployment")
  console.log("Fixes: missing forceStakeTransfer (PR #939)")
  console.log("       missing zero-address redeemer guard (PR #940)")
  console.log("=".repeat(80))
  console.log(`Network: ${hre.network.name}`)
  console.log(`Deployer: ${deployer}`)

  // --- Phase-I preflight: chain and exact legacy-vault identity ---
  // Runbook section 7 step 1 mandates aborting on any chain/identity mismatch
  // BEFORE deploying anything or emitting any executable migration action. This
  // preflight runs in BOTH the default (preparation) and cutover modes. On any
  // mismatch it throws immediately, so no contract is deployed, no preparation
  // or cutover calldata is constructed, and no summary JSON is written. The
  // post-deployment Bridge-implementation-constant comparison further below is
  // retained as an independent SECOND binding check: it re-derives the same
  // identity from the freshly compiled implementation, so the generated cutover
  // is bound to the on-chain guard's exact constants as well.
  const preflightChainId = Number(await hre.getChainId())
  if (preflightChainId !== 1) {
    throw new Error(
      `Refusing TIP-109 legacy-retirement deployment: chain ${preflightChainId} ` +
        "is not Ethereum mainnet (1). This script deploys and prepares the " +
        "legacy-vault optimistic-minting retirement and may only run against " +
        "mainnet or a mainnet fork with chain id 1."
    )
  }
  const legacyVaultDeployment = await get("TBTCVault")
  if (
    utils.getAddress(legacyVaultDeployment.address) !==
    utils.getAddress(LEGACY_MAINNET_TBTC_VAULT)
  ) {
    throw new Error(
      "Refusing TIP-109 legacy-retirement deployment: resolved TBTCVault " +
        `${legacyVaultDeployment.address} is not the exact legacy vault ` +
        `${LEGACY_MAINNET_TBTC_VAULT}.`
    )
  }
  const legacyRuntimeCodeHash = utils.keccak256(
    await ethers.provider.getCode(legacyVaultDeployment.address)
  )
  if (legacyRuntimeCodeHash !== LEGACY_MAINNET_TBTC_VAULT_CODE_HASH) {
    throw new Error(
      "Refusing TIP-109 legacy-retirement deployment: legacy vault runtime " +
        `code hash ${legacyRuntimeCodeHash} does not match the expected ` +
        `mainnet code hash ${LEGACY_MAINNET_TBTC_VAULT_CODE_HASH}.`
    )
  }
  console.log(
    "  Preflight passed: chain 1, exact legacy vault address and runtime code hash"
  )

  // --- Step 1: Deploy updated deposit libraries ---
  // The Bridge implementation must link to the versions compiled from this
  // tree. Reusing old mainnet deployments would bypass migration-debt logic.
  console.log("\n--- Deploying updated deposit libraries ---")
  const Deposit = await deploy("DepositTIP109Hotfix", {
    ...deployOptions,
    contract: "Deposit",
    skipIfAlreadyDeployed: false,
  })

  const DepositSweep = await deploy("DepositSweepTIP109Hotfix", {
    ...deployOptions,
    contract: "DepositSweep",
    skipIfAlreadyDeployed: false,
  })

  // --- Step 2: Deploy new Redemption library (PR #940) ---
  console.log("\n--- Deploying new Redemption library ---")
  const Redemption = await deploy("RedemptionTIP109Hotfix", {
    ...deployOptions,
    contract: "Redemption",
    skipIfAlreadyDeployed: false,
  })

  // --- Step 3: Deploy new Fraud library ---
  console.log("\n--- Deploying new Fraud library ---")
  const Fraud = await deploy("FraudTIP109Hotfix", {
    ...deployOptions,
    contract: "Fraud",
    skipIfAlreadyDeployed: false,
  })

  // --- Step 3b: Deploy new VaultManagement library ---
  // The vault trust list, canonical migration-debt vault management, and the
  // legacy-vault optimistic-minting retirement guard/attestation live in this
  // external library so the Bridge stays within the EIP-170 size limit.
  console.log("\n--- Deploying new VaultManagement library ---")
  const VaultManagement = await deploy("VaultManagementTIP109Hotfix", {
    ...deployOptions,
    contract: "VaultManagement",
    skipIfAlreadyDeployed: false,
  })

  // --- Step 4: Resolve unchanged existing libraries ---
  console.log("\n--- Resolving existing libraries ---")
  const Wallets = await get("Wallets")
  const MovingFunds = await get("MovingFunds")

  // --- Step 5: Deploy new Bridge implementation ---
  // Linked to fresh deployments for every modified linked library.
  console.log("\n--- Deploying Bridge implementation ---")
  const bridgeLibraries = {
    Deposit: Deposit.address,
    DepositSweep: DepositSweep.address,
    Redemption: Redemption.address,
    Wallets: Wallets.address,
    Fraud: Fraud.address,
    MovingFunds: MovingFunds.address,
    VaultManagement: VaultManagement.address,
  }

  const bridgeImpl = await deploy("BridgeTIP109HotfixImplementation", {
    ...deployOptions,
    contract: "Bridge",
    skipIfAlreadyDeployed: false,
    libraries: bridgeLibraries,
  })

  // --- Step 6: Deploy new RebateStaking implementation (PR #939) ---
  console.log("\n--- Deploying RebateStaking implementation ---")
  const rebateImpl = await deploy("RebateStakingTIP109HotfixImplementation", {
    ...deployOptions,
    contract: "RebateStaking",
    skipIfAlreadyDeployed: false,
  })

  // --- Deployment Summary ---
  console.log(`\n${"-".repeat(80)}`)
  console.log("Deployed contract addresses:")
  console.log(`  Deposit library (NEW):         ${Deposit.address}`)
  console.log(`  DepositSweep library (NEW):    ${DepositSweep.address}`)
  console.log(`  Redemption library (NEW):      ${Redemption.address}`)
  console.log(`  Fraud library (NEW):           ${Fraud.address}`)
  console.log(`  Bridge implementation (NEW):   ${bridgeImpl.address}`)
  console.log(`  RebateStaking impl (NEW):      ${rebateImpl.address}`)
  console.log("-".repeat(80))

  // --- Step 7: Update proxy deployment artifacts ---
  // Following the pattern from Wormhole V2 upgrade scripts: update the
  // proxy artifact with the new implementation address and ABI so that
  // hardhat-deploy and downstream tooling reflect the upgraded state.
  console.log("\n--- Updating proxy deployment artifacts ---")

  const Bridge = await get("Bridge")
  const RebateStaking = await get("RebateStaking")
  const BridgeGovernance = await get("BridgeGovernance")

  // --- Step 7a: Deploy a new BridgeGovernance (PR #957) ---
  // The existing mainnet BridgeGovernance predates `seedFraudChallengeEscrow`
  // and has no fallback, so routing the post-upgrade seed call at it would
  // revert and leave `fraudChallengeEscrowSeeded` false — permanently blocking
  // all new fraud challenges. Deploy a fresh BridgeGovernance built from this
  // tree (which forwards `seedFraudChallengeEscrow` to the Bridge), preserving
  // the current governance delay, so governance can transfer Bridge ownership
  // to it before seeding.
  console.log("\n--- Deploying new BridgeGovernance ---")
  const existingBridgeGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    BridgeGovernance.address
  )
  const bridgeGovernanceDelay = await existingBridgeGovernance.governanceDelays(
    0
  )
  console.log(
    `  Preserving governance delay: ${bridgeGovernanceDelay.toString()}s`
  )
  const newBridgeGovernance = await deploy("BridgeGovernanceTIP109Hotfix", {
    ...deployOptions,
    contract: "BridgeGovernance",
    skipIfAlreadyDeployed: false,
    args: [Bridge.address, bridgeGovernanceDelay],
  })
  console.log(`  New BridgeGovernance: ${newBridgeGovernance.address}`)

  // --- Step 7b: Deploy a new migration-debt TBTCVault (PR #957) ---
  // The existing mainnet TBTCVault predates the migration-debt read interface
  // (`hasOutstandingMigrationDebt`, `isMigrationRevealer`, `canRevealMigration`),
  // so the upgraded Bridge would reject it as the canonical migration debt
  // vault (`MigrationDebtVaultInterfaceMissing`). Deploy a fresh TBTCVault
  // built from this tree, wired to the same Bank, TBTC token, and Bridge, so
  // governance can complete the non-proxy vault rotation and activate the
  // migration-debt path.
  console.log("\n--- Deploying new migration-debt TBTCVault ---")
  const Bank = await get("Bank")
  const TBTCToken = await get("TBTC")
  // Reuse the deployment resolved and identity-checked by the Phase-I preflight.
  const TBTCVault = legacyVaultDeployment
  const newTBTCVault = await deploy("TBTCVaultTIP109Hotfix", {
    ...deployOptions,
    contract: "TBTCVault",
    skipIfAlreadyDeployed: false,
    args: [Bank.address, TBTCToken.address, Bridge.address],
  })
  console.log(`  New TBTCVault: ${newTBTCVault.address}`)

  // --- Deploy the legacy-vault migration coordinator (finding TOB-19) ---
  // Controlled by the new BridgeGovernance, it becomes (after preparation) the
  // sole owner of the immutable legacy TBTCVault and the only path able to
  // retire it. Its three bindings are immutable and are verified on-chain before
  // any migration action is produced.
  console.log("\n--- Deploying LegacyTBTCVaultMigrationCoordinator ---")
  const coordinator = await deploy(
    "LegacyTBTCVaultMigrationCoordinatorTIP109Hotfix",
    {
      ...deployOptions,
      contract: "LegacyTBTCVaultMigrationCoordinator",
      skipIfAlreadyDeployed: false,
      args: [newBridgeGovernance.address, TBTCVault.address, Bridge.address],
    }
  )
  console.log(`  Coordinator: ${coordinator.address}`)

  const coordinatorCode = await ethers.provider.getCode(coordinator.address)
  if (coordinatorCode === "0x" || coordinatorCode === "0x0") {
    throw new Error("Coordinator deployment has no runtime code")
  }
  const readCoordinatorBinding = async (fn: string): Promise<string> => {
    const raw = await ethers.provider.call({
      to: coordinator.address,
      data: coordinatorInterface.encodeFunctionData(fn),
    })
    return coordinatorInterface.decodeFunctionResult(fn, raw)[0] as string
  }
  const [boundController, boundLegacy, boundBridge] = await Promise.all([
    readCoordinatorBinding("controller"),
    readCoordinatorBinding("legacyVault"),
    readCoordinatorBinding("bridge"),
  ])
  if (
    utils.getAddress(boundController) !==
      utils.getAddress(newBridgeGovernance.address) ||
    utils.getAddress(boundLegacy) !== utils.getAddress(TBTCVault.address) ||
    utils.getAddress(boundBridge) !== utils.getAddress(Bridge.address)
  ) {
    throw new Error(
      "Coordinator immutable bindings do not match the expected addresses"
    )
  }
  console.log(
    "  Coordinator bindings verified: controller=new BridgeGovernance, " +
      "legacyVault=existing TBTCVault, bridge=Bridge proxy"
  )

  // Verify the coordinator's RUNTIME bytecode, not merely its three bindings, so
  // a coordinator that reports correct bindings but was deployed from different
  // or tampered bytecode is rejected before any migration action is produced.
  await assertCoordinatorRuntimeMatchesArtifact(
    hre,
    ethers.provider,
    coordinator.address
  )
  console.log(
    "  Coordinator runtime bytecode verified against the compiled artifact"
  )

  const bridgeArtifact = artifacts.readArtifactSync("Bridge")
  await save("Bridge", {
    ...Bridge,
    abi: bridgeArtifact.abi,
    implementation: bridgeImpl.address,
  })
  console.log(`  Bridge proxy artifact updated (impl → ${bridgeImpl.address})`)

  const rebateArtifact = artifacts.readArtifactSync("RebateStaking")
  await save("RebateStaking", {
    ...RebateStaking,
    abi: rebateArtifact.abi,
    implementation: rebateImpl.address,
  })
  console.log(
    `  RebateStaking proxy artifact updated (impl → ${rebateImpl.address})`
  )

  // --- Step 8: Discover ProxyAdmin and generate calldata ---
  console.log("\n--- Discovering ProxyAdmin ---")
  const adminData = await ethers.provider.getStorageAt(
    Bridge.address,
    EIP_1967_ADMIN_SLOT
  )
  const proxyAdminAddress = ethers.utils.getAddress(`0x${adminData.slice(26)}`)
  console.log(`  ProxyAdmin: ${proxyAdminAddress}`)

  if (proxyAdminAddress.toLowerCase() !== KNOWN_PROXY_ADMIN.toLowerCase()) {
    console.log(`  WARNING: does not match known ${KNOWN_PROXY_ADMIN}`)
  }

  console.log("\n--- Generating governance calldata ---")

  const latestBlock = await ethers.provider.getBlockNumber()
  const fraudScanFromBlock = Number(
    process.env.BRIDGE_FRAUD_EVENT_FROM_BLOCK ||
      Bridge.receipt?.blockNumber ||
      0
  )
  const preUpgradeOpenEscrow = await computeOpenFraudChallengeEscrow(
    ethers.provider,
    Bridge.address,
    fraudScanFromBlock,
    latestBlock
  )
  console.log(
    `  Fraud challenge escrow seed at block ${latestBlock}: ` +
      `${preUpgradeOpenEscrow.toString()} wei`
  )
  console.log(
    "  Recompute this seed immediately after the Bridge upgrade executes " +
      "and before calling seedFraudChallengeEscrow."
  )
  console.log(
    "  recoverETH and new fraud challenges remain disabled until the seed " +
      "call succeeds."
  )

  const walletRegistrationScanFromBlock = Number(
    process.env.BRIDGE_WALLET_EVENT_FROM_BLOCK ||
      Bridge.receipt?.blockNumber ||
      0
  )
  const preUpgradeWalletRegistrationOrder =
    await computeWalletRegistrationOrder(
      ethers.provider,
      Bridge.address,
      walletRegistrationScanFromBlock,
      latestBlock
    )
  console.log(
    `  Wallet registration order at block ${latestBlock}: ` +
      `${preUpgradeWalletRegistrationOrder.length} wallet(s)`
  )
  console.log(
    "  Recompute this ordered list immediately after the Bridge upgrade " +
      "executes, then run seedWalletRegistrationOrder. Wallets that register " +
      "between the upgrade and the seed are folded in automatically: the seed " +
      "prepends the pre-upgrade wallets and de-duplicates any that the scan " +
      "also captured on-chain, so it does not require an empty order."
  )

  const rebateUpgradeCalldata = encodeUpgrade(
    RebateStaking.address,
    rebateImpl.address
  )
  console.log("\n  Timelock Action [0]: RebateStaking upgrade")
  console.log(`    Target: ProxyAdmin (${proxyAdminAddress})`)
  console.log(`    Calldata: ${rebateUpgradeCalldata}`)
  console.log(`    Selector: ${rebateUpgradeCalldata.slice(0, 10)}`)
  console.log(`    Proxy: ${RebateStaking.address}`)
  console.log(`    New impl: ${rebateImpl.address}`)

  const bridgeUpgradeCalldata = encodeUpgrade(
    Bridge.address,
    bridgeImpl.address
  )
  console.log("\n  Timelock Action [1]: Bridge upgrade")
  console.log(`    Target: ProxyAdmin (${proxyAdminAddress})`)
  console.log(`    Calldata: ${bridgeUpgradeCalldata}`)
  console.log(`    Selector: ${bridgeUpgradeCalldata.slice(0, 10)}`)
  console.log(`    Proxy: ${Bridge.address}`)
  console.log(`    New impl: ${bridgeImpl.address}`)

  // The executable seed calldata is intentionally NOT precomputed and saved.
  // The open pre-upgrade fraud-challenge escrow can grow between this script's
  // run and the post-upgrade seed execution, because new pre-upgrade challenges
  // can still be opened during the governance timelock delay. Persisting a
  // fixed value would let a stale, under-counted seed be executed, which
  // understates `openFraudChallengeEscrow`, exposes challenger deposits to
  // `recoverETH`, and can underflow later challenge resolution.
  // --- BridgeGovernance transfer calldata (finding TOB-18) ---
  // Governance must transfer Bridge ownership to the new BridgeGovernance
  // before the seed action, otherwise `seedFraudChallengeEscrow` (forwarded to
  // the Bridge's `onlyGovernance` entry point) reverts. The freshly deployed
  // BridgeGovernance is owned by the deployer, so its ownership is first handed
  // to the Council Safe.
  // `KNOWN_COUNCIL_SAFE` is stored without an EIP-55 checksum; normalize it to
  // its canonical checksummed form before ABI-encoding it as an address arg.
  const councilSafeAddress = utils.getAddress(KNOWN_COUNCIL_SAFE.toLowerCase())
  const newBridgeGovernanceOwnershipCalldata =
    encodeTransferOwnership(councilSafeAddress)
  const beginBridgeGovernanceTransferCalldata =
    encodeBeginBridgeGovernanceTransfer(newBridgeGovernance.address)
  const finalizeBridgeGovernanceTransferCalldata =
    encodeFinalizeBridgeGovernanceTransfer()

  console.log("\n  Deployer Action: transfer new BridgeGovernance ownership")
  console.log(
    `    Target: new BridgeGovernance (${newBridgeGovernance.address})`
  )
  console.log(`    New owner: Council Safe (${KNOWN_COUNCIL_SAFE})`)

  console.log("\n  Council Safe Action [A]: beginBridgeGovernanceTransfer")
  console.log(
    `    Target: existing BridgeGovernance (${BridgeGovernance.address})`
  )
  console.log(`    New BridgeGovernance: ${newBridgeGovernance.address}`)
  console.log(
    `    Then, after ${bridgeGovernanceDelay.toString()}s, call ` +
      "finalizeBridgeGovernanceTransfer on the existing BridgeGovernance."
  )

  const referenceSeedCalldata =
    encodeSeedFraudChallengeEscrow(preUpgradeOpenEscrow)
  console.log(
    "\n  Council Safe Action [B]: seedFraudChallengeEscrow (RECOMPUTE REQUIRED)"
  )
  console.log(
    `    Target: new BridgeGovernance (${newBridgeGovernance.address})`
  )
  console.log(
    "    Only after the Bridge upgrade AND the BridgeGovernance transfer above."
  )
  console.log("    Recompute the open escrow immediately before execution and")
  console.log("    encode seedFraudChallengeEscrow with that fresh value.")
  console.log(
    `    Reference-only calldata (DO NOT EXECUTE AS-IS): ${referenceSeedCalldata}`
  )
  console.log(
    `    Reference-only seed: ${preUpgradeOpenEscrow.toString()} wei ` +
      `(scanned blocks ${fraudScanFromBlock}..${latestBlock})`
  )

  const referenceWalletOrderCalldata = encodeSeedWalletRegistrationOrder(
    preUpgradeWalletRegistrationOrder
  )
  console.log(
    "\n  Council Safe Action [C]: seedWalletRegistrationOrder (RECOMPUTE REQUIRED)"
  )
  console.log(
    `    Target: new BridgeGovernance (${newBridgeGovernance.address})`
  )
  console.log(
    "    Only after the Bridge upgrade AND the BridgeGovernance transfer above,"
  )
  console.log(
    "    (wallets that register in between are folded in automatically; the " +
      "seed de-duplicates and does not require an empty order)."
  )
  console.log(
    "    REQUIRED PRECONDITION: until this executes, submitMovingFundsCommitment"
  )
  console.log(
    "    reverts because the deterministic target selection cannot be rebuilt."
  )
  console.log(
    "    Recompute the event-ordered wallet list immediately before execution"
  )
  console.log(
    "    and encode seedWalletRegistrationOrder with that fresh list."
  )
  console.log(
    `    Reference-only calldata (DO NOT EXECUTE AS-IS): ${referenceWalletOrderCalldata}`
  )
  console.log(
    `    Reference-only order: ${preUpgradeWalletRegistrationOrder.length} ` +
      `wallet(s) (scanned blocks ${walletRegistrationScanFromBlock}..${latestBlock})`
  )

  // --- Legacy vault retirement: preparation calldata (finding TOB-17) ---
  // The legacy TBTCVault is immutable and predates both the finalizeUpgrade
  // optimistic-minting guard and the aggregate optimistic-minting-debt selector.
  // Retirement therefore runs through the dedicated coordinator: the Council
  // pauses optimistic minting (if not already paused), hands the legacy vault to
  // the coordinator, and initiates the upgrade through the new BridgeGovernance.
  // Only the single atomic cutover — generated below strictly after the pinned
  // scan proves the dangerous set empty — untrusts and finalizes the legacy
  // vault. The new TBTCVault's ownership is handed to the Council first so the
  // canonical vault is governance-owned the moment the cutover moves TBTC
  // ownership and the Bank balance to it.
  const transferNewVaultOwnershipCalldata =
    encodeTransferVaultOwnership(councilSafeAddress)
  const pauseLegacyOptimisticMintingCalldata = encodePauseOptimisticMinting()
  const transferLegacyVaultOwnershipCalldata = encodeTransferVaultOwnership(
    coordinator.address
  )
  const initiateLegacyVaultUpgradeCalldata = encodeInitiateLegacyVaultUpgrade(
    coordinator.address,
    newTBTCVault.address
  )

  // --- Cutover generation (finding TOB-17) ---
  // The executable cutover calldata is produced only in an explicit cutover
  // mode, after preparation has moved the legacy vault to the coordinator and
  // the 24h delay has elapsed, and only when the pinned scan proves the
  // dangerous set P empty and every live retirement assertion holds. In cutover
  // mode any failed precondition throws, which prevents the summary JSON from
  // being written.
  const chainIdNumber = Number(await hre.getChainId())
  const cutoverMode = process.env.GENERATE_TBTC_VAULT_CUTOVER === "true"
  const scanFromBlockOverride = process.env.TBTCVAULT_OM_EVENT_FROM_BLOCK
    ? Number(process.env.TBTCVAULT_OM_EVENT_FROM_BLOCK)
    : undefined
  const scanSnapshotOverride = process.env.TBTCVAULT_OM_SNAPSHOT_BLOCK
    ? Number(process.env.TBTCVAULT_OM_SNAPSHOT_BLOCK)
    : undefined

  let cutoverAction: Record<string, unknown>
  let scanResult: OptimisticMintScanResult | undefined

  if (cutoverMode) {
    console.log(
      "\n--- Cutover mode: running the pinned optimistic-minting scan ---"
    )
    scanResult = await scanPendingOptimisticMints(ethers.provider, {
      chainId: chainIdNumber,
      legacyVault: TBTCVault.address,
      bridge: Bridge.address,
      coordinator: coordinator.address,
      successorVault: newTBTCVault.address,
      fromBlockOverride: scanFromBlockOverride,
      snapshotBlockNumberOverride: scanSnapshotOverride,
      requireLockedState: true,
    })

    if (scanResult.pending.length > 0) {
      console.log(
        `  BLOCKING: ${scanResult.pending.length} unswept finalized optimistic ` +
          "mint(s) remain. Do NOT attest, untrust, or finalize. Keep the legacy " +
          "vault trusted and let its Bitcoin wallet sweep these deposits."
      )
      // eslint-disable-next-line no-restricted-syntax
      for (const entry of scanResult.pending) {
        console.log(
          `    key ${entry.depositKey} depositor ${entry.depositor} ` +
            `amount ${entry.amount} revealedAt ${entry.revealedAt} ` +
            `funded ${entry.fundingEvent.blockNumber}:${entry.fundingEvent.logIndex}`
        )
      }
      throw new Error(
        `Refusing cutover: ${scanResult.pending.length} unswept finalized ` +
          "optimistic mint(s) remain in the dangerous set P"
      )
    }

    console.log(
      `  Scan clean: ${scanResult.finalizedEventCount} finalized mint(s), 0 ` +
        `pending; snapshot block ${scanResult.snapshotBlockNumber} ` +
        `(${scanResult.snapshotBlockHash})`
    )
    console.log(
      "  Residual (informational, not a gate): " +
        `${scanResult.residualDebtorCount} debtor(s), ` +
        `${scanResult.residualDebtTotal} wei`
    )
    console.log(`  Evidence hash: ${scanResult.evidenceHash}`)

    // --- Immediate live/identity assertions (spec sections 3.3 and 7) ---
    // Executable cutover calldata is produced only for the real mainnet
    // migration and only when every live precondition holds. Any failure throws
    // before the cutover calldata or the summary JSON is produced.

    // 1. Chain: cutover is only ever generated on Ethereum mainnet (or a mainnet
    //    fork with chain id 1).
    if (chainIdNumber !== 1) {
      throw new Error(
        `Refusing cutover: chain ${chainIdNumber} is not Ethereum mainnet (1). ` +
          "The executable legacy-retirement cutover may only be generated " +
          "against mainnet or a mainnet fork."
      )
    }

    // 2. Legacy identity: the vault about to be retired must be exactly the
    //    address and runtime code hash the freshly compiled Bridge
    //    implementation recognizes. Reading the constants from that
    //    implementation binds the generated cutover to the on-chain guard.
    const readImplConstant = async (fn: string): Promise<string> =>
      retirementStateInterface.decodeFunctionResult(
        fn,
        await ethers.provider.call({
          to: bridgeImpl.address,
          data: retirementStateInterface.encodeFunctionData(fn),
        })
      )[0] as string
    const implKnownLegacy = await readImplConstant("LEGACY_MAINNET_TBTC_VAULT")
    if (
      utils.getAddress(TBTCVault.address) !== utils.getAddress(implKnownLegacy)
    ) {
      throw new Error(
        `Refusing cutover: legacy vault ${TBTCVault.address} does not match the ` +
          `Bridge implementation's known legacy vault ${implKnownLegacy}`
      )
    }
    const implKnownCodeHash = await readImplConstant(
      "LEGACY_MAINNET_TBTC_VAULT_CODE_HASH"
    )
    const legacyCodeHash = utils.keccak256(
      await ethers.provider.getCode(TBTCVault.address)
    )
    if (legacyCodeHash !== implKnownCodeHash) {
      throw new Error(
        `Refusing cutover: legacy vault code hash ${legacyCodeHash} does not ` +
          `match the Bridge implementation's known code hash ${implKnownCodeHash}`
      )
    }

    // 3. Live state, read at the chain head (the proxy is already upgraded by
    //    cutover time, so the new getters resolve): the successor vault is
    //    Council-owned; the legacy vault is still trusted; the successor vault is
    //    not yet trusted; and no canonical migration-debt vault is set on this
    //    mainnet migration.
    const readLive = async (
      to: string,
      fn: string,
      fnArgs: unknown[] = []
    ): Promise<unknown> =>
      retirementStateInterface.decodeFunctionResult(
        fn,
        await ethers.provider.call({
          to,
          data: retirementStateInterface.encodeFunctionData(fn, fnArgs),
        })
      )[0]

    const successorOwner = (await readLive(
      newTBTCVault.address,
      "owner"
    )) as string
    if (
      utils.getAddress(successorOwner) !== utils.getAddress(councilSafeAddress)
    ) {
      throw new Error(
        `Refusing cutover: successor vault owner ${successorOwner} is not the ` +
          `Council Safe ${councilSafeAddress}`
      )
    }
    const legacyTrusted = (await readLive(Bridge.address, "isVaultTrusted", [
      TBTCVault.address,
    ])) as boolean
    if (!legacyTrusted) {
      throw new Error(
        "Refusing cutover: the legacy vault is not currently trusted by the Bridge"
      )
    }
    const successorTrusted = (await readLive(Bridge.address, "isVaultTrusted", [
      newTBTCVault.address,
    ])) as boolean
    if (successorTrusted) {
      throw new Error(
        "Refusing cutover: the successor vault is already trusted by the Bridge"
      )
    }
    const canonicalDebtVault = (await readLive(
      Bridge.address,
      "migrationDebtVault"
    )) as string
    if (canonicalDebtVault !== ethers.constants.AddressZero) {
      throw new Error(
        `Refusing cutover: Bridge.migrationDebtVault() is ${canonicalDebtVault}, ` +
          "expected the zero address on this mainnet migration"
      )
    }
    console.log(
      "  Live assertions passed: successor Council-owned, legacy trusted, " +
        "successor untrusted, canonical migration-debt vault zero"
    )

    cutoverAction = {
      target: newBridgeGovernance.address,
      data: encodeFinalizeLegacyVaultMigration(
        coordinator.address,
        scanResult.snapshotBlockNumber,
        scanResult.snapshotBlockHash,
        scanResult.evidenceHash
      ),
      value: 0,
      function: "finalizeLegacyVaultMigration(address,uint256,bytes32,bytes32)",
      coordinator: coordinator.address,
      snapshotBlockNumber: scanResult.snapshotBlockNumber,
      snapshotBlockHash: scanResult.snapshotBlockHash,
      evidenceHash: scanResult.evidenceHash,
      description:
        "Council Safe (via new BridgeGovernance): the single atomic legacy " +
        "vault retirement cutover. Attests the residual-only state, untrusts " +
        "the legacy vault, finalizes the immutable legacy upgrade through the " +
        "coordinator, trusts the successor, and makes it the canonical " +
        "migration-debt vault. Any failed assertion rolls back the whole cutover.",
    }
  } else {
    console.log(
      "\n--- Preparation-only run: no executable cutover calldata generated ---"
    )
    console.log(
      "  Rerun with GENERATE_TBTC_VAULT_CUTOVER=true after preparation and the " +
        "24h delay to run the pinned scan and produce the cutover calldata."
    )
    cutoverAction = {
      target: newBridgeGovernance.address,
      function: "finalizeLegacyVaultMigration(address,uint256,bytes32,bytes32)",
      coordinator: coordinator.address,
      value: 0,
      requiresCutoverMode: true,
      // Executable calldata is intentionally absent: preparation must complete
      // and the pinned scan must prove P empty before it can be produced.
      description:
        "NOT executable. Rerun this script with GENERATE_TBTC_VAULT_CUTOVER=true " +
        "after preparation completes and the 24h delay elapses; the pinned scan " +
        "then produces the finalizeLegacyVaultMigration calldata only when the " +
        "dangerous set is empty.",
    }
  }

  // --- Step 9: Save deployment summary JSON ---
  const chainId = await hre.getChainId()

  const deploymentSummary = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer,
    chainId,
    purpose:
      "TIP-109 hotfix: add forceStakeTransfer (PR #939) and " +
      "zero-address redeemer guard (PR #940), with fresh Bridge " +
      "libraries for migration-debt and fraud-escrow changes",
    deployedContracts: {
      DepositTIP109Hotfix: Deposit.address,
      DepositSweepTIP109Hotfix: DepositSweep.address,
      RedemptionTIP109Hotfix: Redemption.address,
      FraudTIP109Hotfix: Fraud.address,
      VaultManagementTIP109Hotfix: VaultManagement.address,
      BridgeTIP109HotfixImplementation: bridgeImpl.address,
      RebateStakingTIP109HotfixImplementation: rebateImpl.address,
      BridgeGovernanceTIP109Hotfix: newBridgeGovernance.address,
      TBTCVaultTIP109Hotfix: newTBTCVault.address,
      LegacyTBTCVaultMigrationCoordinatorTIP109Hotfix: coordinator.address,
    },
    reusedContracts: {
      Wallets: Wallets.address,
      MovingFunds: MovingFunds.address,
    },
    existingContracts: {
      Bridge: Bridge.address,
      ProxyAdmin: proxyAdminAddress,
      Timelock: KNOWN_TIMELOCK,
      CouncilSafe: KNOWN_COUNCIL_SAFE,
      RebateStaking: RebateStaking.address,
      BridgeGovernance: BridgeGovernance.address,
      TBTCVault: TBTCVault.address,
      Bank: Bank.address,
      TBTC: TBTCToken.address,
    },
    // --- Legacy vault retirement (finding TOB-17) ---
    // Two phases. Preparation freezes the legacy vault under the coordinator and
    // starts its 24h delay; NO preparation action untrusts or finalizes it, and
    // no action targets the legacy vault's `finalizeUpgrade`. The single cutover
    // action is executable only when this script is rerun in cutover mode
    // (GENERATE_TBTC_VAULT_CUTOVER=true) after the delay and the pinned scan
    // proves the dangerous set P empty.
    legacyVaultMigration: {
      coordinator: coordinator.address,
      legacyVault: TBTCVault.address,
      successorVault: newTBTCVault.address,
      preparationActions: [
        {
          target: newTBTCVault.address,
          data: transferNewVaultOwnershipCalldata,
          value: 0,
          description:
            "Deployer: transfer ownership of the new TBTCVault to the Council " +
            "Safe, so the canonical vault is governance-owned the moment the " +
            "cutover moves TBTC ownership and the Bank balance to it.",
        },
        {
          target: TBTCVault.address,
          data: pauseLegacyOptimisticMintingCalldata,
          value: 0,
          precondition:
            "Only if legacy.isOptimisticMintingPaused() == false. " +
            "pauseOptimisticMinting() reverts when already paused, and the " +
            "legacy vault is currently paused, so this action is typically " +
            "skipped after verifying the paused state.",
          description:
            "Council Safe: pause legacy optimistic minting if not already paused.",
        },
        {
          target: TBTCVault.address,
          data: transferLegacyVaultOwnershipCalldata,
          value: 0,
          description:
            "Council Safe: transfer legacy TBTCVault ownership to the " +
            "coordinator. After this, no minter can create new finalized " +
            "optimistic debt and no direct Safe finalization is possible.",
        },
        {
          target: newBridgeGovernance.address,
          data: initiateLegacyVaultUpgradeCalldata,
          value: 0,
          governanceDelaySeconds: "86400",
          description:
            "Council Safe (via new BridgeGovernance): initiate the legacy vault " +
            "upgrade through the coordinator, then wait at least 24 hours.",
        },
      ],
      cutoverAction,
      // Present only in cutover mode; the digest inputs the Council verifies
      // against a second independent archive provider before signing.
      scan: scanResult
        ? {
            chainId: chainIdNumber,
            fromBlock: scanResult.fromBlock,
            snapshotBlockNumber: scanResult.snapshotBlockNumber,
            snapshotBlockHash: scanResult.snapshotBlockHash,
            finalizedEventCount: scanResult.finalizedEventCount,
            depositSetHash: scanResult.depositSetHash,
            evidenceHash: scanResult.evidenceHash,
            unsweptFinalizedCount: scanResult.pending.length,
            residualDebtorCount: scanResult.residualDebtorCount,
            residualDebtTotalWei: scanResult.residualDebtTotal,
          }
        : undefined,
    },
    // The Council Safe must run these BridgeGovernance actions, in order,
    // before the post-upgrade seed action. Without them the seed call reverts
    // (the existing BridgeGovernance lacks `seedFraudChallengeEscrow`), leaving
    // fraud challenges permanently disabled after the Bridge upgrade.
    deployerActions: [
      {
        target: newBridgeGovernance.address,
        data: newBridgeGovernanceOwnershipCalldata,
        value: 0,
        description:
          "Transfer ownership of the new BridgeGovernance from the deployer " +
          "to the Council Safe so it can run seedFraudChallengeEscrow",
      },
    ],
    bridgeGovernanceTransferActions: [
      {
        target: BridgeGovernance.address,
        data: beginBridgeGovernanceTransferCalldata,
        value: 0,
        description:
          "Council Safe: begin transferring Bridge governance to the new " +
          "BridgeGovernance (existing BridgeGovernance.onlyOwner)",
      },
      {
        target: BridgeGovernance.address,
        data: finalizeBridgeGovernanceTransferCalldata,
        value: 0,
        governanceDelaySeconds: bridgeGovernanceDelay.toString(),
        description:
          "Council Safe: after the governance delay, finalize the transfer, " +
          "handing Bridge governance to the new BridgeGovernance",
      },
    ],
    timelockActions: [
      {
        target: proxyAdminAddress,
        data: rebateUpgradeCalldata,
        value: 0,
        description: "RebateStaking proxy upgrade via ProxyAdmin.upgrade()",
      },
      {
        target: proxyAdminAddress,
        data: bridgeUpgradeCalldata,
        value: 0,
        description: "Bridge proxy upgrade via ProxyAdmin.upgrade()",
      },
    ],
    postUpgradeActions: [
      {
        // Route the seed at the NEW BridgeGovernance, which forwards it to the
        // upgraded Bridge. It is executable only after both the Bridge upgrade
        // and the BridgeGovernance transfer above have completed.
        target: newBridgeGovernance.address,
        // Executable calldata is intentionally omitted so a stale, precomputed
        // seed value cannot be copied into the Council Safe action. The seed
        // must be recomputed immediately before execution (see below) and the
        // calldata encoded from the freshly computed open escrow at that time.
        function: "seedFraudChallengeEscrow(uint256)",
        requiresRecomputation: true,
        value: 0,
        description:
          "Recompute the open pre-upgrade fraud challenge escrow immediately " +
          "before execution by scanning fraud challenge events from " +
          "`eventScan.fromBlock` to the current chain head, then encode " +
          "seedFraudChallengeEscrow with that value. Do not reuse the " +
          "reference values below.",
        eventScan: {
          fromBlock: fraudScanFromBlock,
          referenceToBlock: latestBlock,
          referenceOpenEscrowWei: preUpgradeOpenEscrow.toString(),
        },
      },
      {
        // Backfill the wallet registration order so the upgraded Bridge can
        // enforce the deterministic moving-funds target-wallet selection for
        // wallets registered before this upgrade. Routed at the NEW
        // BridgeGovernance, which forwards it to the upgraded Bridge. This is a
        // required precondition for resuming moving funds: until it executes,
        // `submitMovingFundsCommitment` reverts with "Wallet registration order
        // cannot reconstruct the target selection" for any wallet whose targets
        // predate the on-chain order (there is no permissive fallback).
        target: newBridgeGovernance.address,
        // Executable calldata is intentionally omitted. Like the fraud escrow
        // seed, the ordered wallet list must be recomputed immediately before
        // execution: wallets can register between this script running and the
        // action executing. The seed prepends the pre-upgrade wallets ahead of
        // any post-upgrade registrations and de-duplicates any wallet the scan
        // also captured on-chain, so it stays valid regardless of in-window
        // registrations and does not require an empty on-chain order. Encode
        // seedWalletRegistrationOrder(bytes20[]) from the freshly scanned,
        // event-ordered list at execution time.
        function: "seedWalletRegistrationOrder(bytes20[])",
        requiresRecomputation: true,
        value: 0,
        description:
          "Recompute the wallet registration order immediately before " +
          "execution by scanning NewWalletRegistered events from " +
          "`eventScan.fromBlock` to the current chain head in emission order, " +
          "then encode seedWalletRegistrationOrder with that list. Wallets that " +
          "register between the upgrade and this call are folded in " +
          "automatically: the seed prepends the pre-upgrade wallets and " +
          "de-duplicates any that the scan also captured on-chain, so it does " +
          "not require an empty order and can run at any point after the " +
          "upgrade. This action is a required precondition for resuming moving " +
          "funds: until it executes, submitMovingFundsCommitment reverts " +
          "because the deterministic target selection cannot be reconstructed. " +
          "Do not reuse the reference list below.",
        eventScan: {
          fromBlock: walletRegistrationScanFromBlock,
          referenceToBlock: latestBlock,
          referenceWalletCount: preUpgradeWalletRegistrationOrder.length,
          referenceWallets: preUpgradeWalletRegistrationOrder,
        },
      },
    ],
    libraries: bridgeLibraries,
  }

  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `tip109-hotfix-deployment-${Date.now()}.json`
  )

  try {
    fs.writeFileSync(summaryPath, JSON.stringify(deploymentSummary, null, 2))
    console.log(`\nDeployment summary saved to: ${summaryPath}`)
  } catch (error) {
    console.log(`WARNING: Failed to write summary: ${(error as Error).message}`)
  }

  console.log(`\n${"=".repeat(80)}`)
  console.log("DEPLOYMENT SUMMARY")
  console.log("=".repeat(80))
  console.log(`  Network:  ${hre.network.name}`)
  console.log(`  Chain ID: ${chainId}`)
  console.log(`  Deployer: ${deployer}`)
  console.log(`  Summary:  ${summaryPath}`)
  // Print the runbook in execution order. The BridgeGovernance transfer must
  // land BEFORE the Bridge upgrade: the upgraded Bridge blocks new fraud
  // challenges until the escrow is seeded, and only the new BridgeGovernance
  // exposes seedFraudChallengeEscrow. Transferring governance first lets the
  // seed run immediately after the upgrade instead of leaving fraud challenges
  // disabled for the whole governance-transfer delay.
  console.log(
    "\n  STEP 1 - Pre-upgrade Council Safe actions (transfer Bridge governance):"
  )
  console.log(
    "    [A] beginBridgeGovernanceTransfer on the existing BridgeGovernance"
  )
  console.log(`        To: ${BridgeGovernance.address}`)
  console.log(`        New BridgeGovernance: ${newBridgeGovernance.address}`)
  console.log(
    "    [B] finalizeBridgeGovernanceTransfer on the existing BridgeGovernance"
  )
  console.log(`        To: ${BridgeGovernance.address}`)
  console.log(
    "        Run [A] and [B] BEFORE the STEP 2 Bridge upgrade so the new"
  )
  console.log(
    "        BridgeGovernance owns the Bridge and the STEP 3 seed can execute"
  )
  console.log(
    "        immediately after the upgrade, not after the transfer delay."
  )
  console.log("\n  STEP 2 - Timelock Actions (minDelay=86400s / 24h):")
  console.log("    [0] RebateStaking upgrade (plain)")
  console.log(`        Proxy: ${RebateStaking.address}`)
  console.log(`        New impl: ${rebateImpl.address}`)
  console.log("    [1] Bridge upgrade (plain)")
  console.log(`        Proxy: ${Bridge.address}`)
  console.log(`        New impl: ${bridgeImpl.address}`)
  console.log(
    "\n  STEP 3 - Post-upgrade Council Safe actions (run immediately after STEP 2):"
  )
  console.log("    [C] seedFraudChallengeEscrow on the NEW BridgeGovernance")
  console.log(`        To: ${newBridgeGovernance.address}`)
  console.log(
    "        Seed: RECOMPUTE the open pre-upgrade escrow immediately before"
  )
  console.log(
    "              executing this action. Do NOT reuse an earlier snapshot;"
  )
  console.log(
    "              new pre-upgrade challenges may open during the timelock delay."
  )
  console.log(
    `        Reference-only snapshot (NOT executable): ${preUpgradeOpenEscrow.toString()} wei`
  )
  console.log("    [D] seedWalletRegistrationOrder on the NEW BridgeGovernance")
  console.log(`        To: ${newBridgeGovernance.address}`)
  console.log(
    "        Order: RECOMPUTE the event-ordered wallet list immediately before"
  )
  console.log(
    "               executing. Wallets that register between the upgrade and"
  )
  console.log(
    "               this call are folded in automatically; the seed prepends the"
  )
  console.log(
    "               pre-upgrade wallets and de-duplicates any also captured"
  )
  console.log("               on-chain, so it does not require an empty order.")
  console.log(
    `        Reference-only snapshot (NOT executable): ${preUpgradeWalletRegistrationOrder.length} wallet(s)`
  )
  console.log(
    "\n  STEP 4 - Legacy vault retirement (preparation, then one atomic cutover):"
  )
  console.log(`        Coordinator: ${coordinator.address}`)
  console.log(
    "    [E] transferOwnership(CouncilSafe) on the new TBTCVault (deployer)"
  )
  console.log(`        To: ${newTBTCVault.address}`)
  console.log(`        New owner: Council Safe (${KNOWN_COUNCIL_SAFE})`)
  console.log(
    "    [F] pauseOptimisticMinting() on the legacy TBTCVault, ONLY if not"
  )
  console.log(`        already paused (Council Safe). To: ${TBTCVault.address}`)
  console.log(
    "    [G] transferOwnership(coordinator) on the legacy TBTCVault (Council"
  )
  console.log(`        Safe). To: ${TBTCVault.address}`)
  console.log(
    "        After [G] the legacy vault is frozen: no new finalized optimistic"
  )
  console.log("        debt, and no direct Safe finalization is possible.")
  console.log(
    "    [H] initiateLegacyVaultUpgrade(coordinator, newTBTCVault) on the NEW"
  )
  console.log(
    `        BridgeGovernance (Council Safe). To: ${newBridgeGovernance.address}`
  )
  console.log("        Then wait at least 24 hours.")
  console.log(
    "    [I] CUTOVER: finalizeLegacyVaultMigration(coordinator, B, blockHash,"
  )
  console.log(
    "        evidenceHash) on the NEW BridgeGovernance (Council Safe)."
  )
  console.log(
    "        Generated ONLY by rerunning this script with " +
      "GENERATE_TBTC_VAULT_CUTOVER=true"
  )
  console.log(
    "        after [H] + the 24h delay, and only when the pinned scan proves the"
  )
  console.log(
    "        dangerous set empty. It atomically attests, untrusts the legacy"
  )
  console.log(
    "        vault, finalizes through the coordinator, trusts the successor, and"
  )
  console.log("        sets it as the canonical migration-debt vault.")
  console.log(
    "    NOTE: setMigrationRevealer(revealer, true) is a post-cutover owner"
  )
  console.log(
    "        action on the new Council-owned TBTCVault; it needs a revealer"
  )
  console.log("        address not known at deploy time and is omitted here.")
  console.log("=".repeat(80))

  // --- Step 10: Verify contracts on Etherscan (v2 API) ---
  if (hre.network.tags.etherscan) {
    const etherscanApiKey = process.env.ETHERSCAN_API_KEY
    if (!etherscanApiKey) {
      console.log(
        "\nSkipping Etherscan verification: ETHERSCAN_API_KEY not set"
      )
    } else {
      console.log("\n--- Verifying contracts on Etherscan (v2 API) ---")

      const buildInfoDir = path.join(__dirname, "..", "build", "build-info")
      const buildInfoFiles = fs
        .readdirSync(buildInfoDir)
        .filter((f) => f.endsWith(".json"))

      let solcInput: string | null = null
      let compilerVersion = ""

      // eslint-disable-next-line no-restricted-syntax
      for (const biFile of buildInfoFiles) {
        const bi = JSON.parse(
          fs.readFileSync(path.join(buildInfoDir, biFile), "utf-8")
        )
        if (bi.output?.contracts?.["contracts/bridge/Deposit.sol"]?.Deposit) {
          solcInput = JSON.stringify(bi.input)
          compilerVersion = `v${bi.solcVersion}`
          break
        }
      }

      if (!solcInput) {
        console.log("  Could not find build-info. Skipping verification.")
      } else {
        const networkChainId = parseInt(await hre.getChainId(), 10)
        const contractsToVerify = [
          {
            address: Deposit.address,
            name: "contracts/bridge/Deposit.sol:Deposit",
            label: "Deposit",
          },
          {
            address: DepositSweep.address,
            name: "contracts/bridge/DepositSweep.sol:DepositSweep",
            label: "DepositSweep",
          },
          {
            address: Redemption.address,
            name: "contracts/bridge/Redemption.sol:Redemption",
            label: "Redemption",
          },
          {
            address: Fraud.address,
            name: "contracts/bridge/Fraud.sol:Fraud",
            label: "Fraud",
          },
          {
            address: VaultManagement.address,
            name: "contracts/bridge/VaultManagement.sol:VaultManagement",
            label: "VaultManagement",
          },
          {
            address: bridgeImpl.address,
            name: "contracts/bridge/Bridge.sol:Bridge",
            label: "Bridge",
          },
          {
            address: rebateImpl.address,
            name: "contracts/bridge/RebateStaking.sol:RebateStaking",
            label: "RebateStaking",
          },
          {
            address: coordinator.address,
            name: "contracts/vault/LegacyTBTCVaultMigrationCoordinator.sol:LegacyTBTCVaultMigrationCoordinator",
            label: "LegacyTBTCVaultMigrationCoordinator",
          },
        ]

        // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
        for (const contract of contractsToVerify) {
          console.log(`Verifying ${contract.label} at ${contract.address}...`)
          try {
            // eslint-disable-next-line no-await-in-loop
            const guid = await etherscanVerifyV2(
              etherscanApiKey,
              networkChainId,
              contract.address,
              contract.name,
              compilerVersion,
              solcInput
            )
            console.log(`  Submitted: GUID=${guid}`)
          } catch (err) {
            console.log(`  Verification failed: ${(err as Error).message}`)
          }
        }
      }
    }
  }
}

export default func

func.tags = ["DeployTIP109Hotfix"]
func.skip = async () => process.env.DEPLOY_TIP109_HOTFIX !== "true"
