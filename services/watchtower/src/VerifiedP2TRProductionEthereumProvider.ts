import { createHash } from "node:crypto"
import {
  P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS,
  computeP2TRCanonicalEthereumDescriptorSetHash,
  type P2TRCanonicalEthereumEventDescriptor,
} from "./P2TRCanonicalEthereumJournal.js"
import {
  hashP2TRActivationLinkedLibraryDescriptorSet,
  P2TR_ECDSA_FRAUD_ROUTER_CURRENT_V3,
  type P2TRActivationLinkedLibraryBinding,
  type P2TRProductionActivationManifest,
  type P2TRProductionEcdsaCutover,
  type P2TRProductionEthereumPoint,
  type P2TRProductionEthereumProvider,
  type P2TRProductionEthereumState,
  type P2TREthereumHistoryCoverageCounters,
} from "./P2TRProductionActivation.js"
import { JsonRpcP2TRCanonicalEthereumProvider } from "./HttpP2TREthereumJsonRpc.js"
import { ethereumKeccak256 } from "./EthereumKeccak256.js"

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
export const P2TR_EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
const ZERO_WORD = `0x${"00".repeat(32)}`
const ZERO_ADDRESS = `0x${"00".repeat(20)}`
const MAX_ECDSA_ROUTER_ANCESTRY_DEPTH = 8

const ECDSA_SELECTORS = Object.freeze({
  bridge: "0xe78cea92",
  fraudProtocolID: "0x73fb85f4",
  predecessor: "0xb719d032",
  predecessorCodeHash: "0x5f85db09",
  ancestryDepth: "0x223a1ee4",
  challengeIdentityExists: "0xe4aeee1d",
  openFraudChallengeCount: "0x0b5e50af",
  unattributedOpenFraudChallengeCount: "0x0e6794c1",
  openFraudChallengeEscrow: "0xfb570298",
  migratedChallengesActivatedAt: "0xbe50c221",
  fraudChallenges: "0x33e957cb",
  bridgeRouter: "0x9fa00083",
  bridgeRouterCodeHash: "0x8bb6cc67",
  bridgeRouterInDrain: "0x8f6c6ab6",
  bridgeRouterRetired: "0x32f97871",
  cutoverReadiness: "0x4c1a700d",
  governanceTransferChangeInitiated: "0x8c382a53",
})

export type P2TRPinnedEthereumProtocolState = Pick<
  P2TRProductionEthereumState,
  | "ecdsaCutover"
  | "bridgeBindings"
  | "completeDepositKeyInventory"
  | "frostArchive"
  | "frostWalletGroupInventory"
>

export type P2TRPinnedEthereumStateReader = {
  readonly decoderCodeHash: string
  readPinnedState(context: {
    point: P2TRProductionEthereumPoint
    callAt(to: string, data: string): Promise<string>
  }): Promise<P2TRPinnedEthereumProtocolState>
}

export type P2TRProductionEthereumHistoryAccumulator = {
  readonly profile: "durable-incremental-receipt-complete"
  readonly storeID: string
  readonly storeFingerprint: string
  readonly clusterFingerprint: string
  synchronizeTo(request: {
    provider: JsonRpcP2TRCanonicalEthereumProvider
    chainID: number
    checkpoint: P2TRProductionEthereumPoint
    target: P2TRProductionEthereumPoint
    descriptors: readonly P2TRCanonicalEthereumEventDescriptor[]
    maxTailBlocks: number
    maxTailTransactions: number
    maxTailLogs: number
    maxDecodedPayloadBytes: number
    deadlineAt: number
  }): Promise<{
    point: P2TRProductionEthereumPoint
    requiredEventHistoryDigest: string
    requiredEventCount: number
    coverageCounters: P2TREthereumHistoryCoverageCounters
    processedBlocks: number
    complete: boolean
  }>
}

export type VerifiedP2TRProductionEthereumProviderOptions = {
  /** Stable audited operator identity; the adapter hashes it locally. */
  operatorIdentity: string
  expectedStateReaderCodeHash: string
  expectedDescriptorSetHash: string
  expectedLinkedLibraryDescriptorSetHash: string
  chainID: number
  checkpoint: P2TRProductionEthereumPoint
  scanStartBlock: number
  contracts: P2TRProductionActivationManifest["ethereum"]["contracts"]
  descriptors: readonly P2TRCanonicalEthereumEventDescriptor[]
  historyAccumulator: P2TRProductionEthereumHistoryAccumulator
  expectedHistoryStoreID: string
  expectedHistoryStoreFingerprint: string
  expectedHistoryClusterFingerprint: string
  maxTailBlocks: number
  maxTailTransactions: number
  maxTailLogs: number
  maxDecodedPayloadBytes: number
  maxActivationReadMs: number
}

/**
 * Pinned-block Ethereum activation adapter. It verifies proxy slots, all
 * runtime code, protocol readbacks, and a receipt-complete event history at
 * the exact requested block. Two independently configured instances are then
 * compared byte-for-byte by the activation gate.
 */
export class VerifiedP2TRProductionEthereumProvider
  implements P2TRProductionEthereumProvider
{
  readonly trustDomainID: string
  readonly providerIdentity: object
  readonly endpointFingerprint: string
  readonly operatorFingerprint: string
  readonly historyStoreID: string
  readonly historyStoreFingerprint: string
  readonly historyClusterFingerprint: string
  private readonly descriptorSetHash: string

  constructor(
    private readonly provider: JsonRpcP2TRCanonicalEthereumProvider,
    private readonly stateReader: P2TRPinnedEthereumStateReader,
    private readonly options: VerifiedP2TRProductionEthereumProviderOptions
  ) {
    this.trustDomainID = provider.trustDomainID
    this.providerIdentity = provider.providerIdentity
    this.endpointFingerprint = bytes32(
      provider.endpointFingerprint,
      "derived Ethereum endpoint fingerprint"
    )
    this.operatorFingerprint = hashIdentity(
      options.operatorIdentity,
      "Ethereum operator identity"
    )
    this.historyStoreID = boundedString(
      options.historyAccumulator.storeID,
      128,
      "Ethereum history store ID"
    )
    this.historyStoreFingerprint = bytes32(
      options.historyAccumulator.storeFingerprint,
      "Ethereum history store fingerprint"
    )
    this.historyClusterFingerprint = bytes32(
      options.historyAccumulator.clusterFingerprint,
      "Ethereum history cluster fingerprint"
    )
    positiveInteger(options.chainID, "Ethereum chain ID")
    positiveInteger(options.scanStartBlock, "Ethereum scan start")
    if (
      nonNegativeInteger(
        options.checkpoint.blockNumber,
        "Ethereum checkpoint block"
      ) +
        1 !==
      options.scanStartBlock
    ) {
      throw new Error("Ethereum history checkpoint must be the scan parent")
    }
    bytes32(options.checkpoint.blockHash, "Ethereum checkpoint hash")
    positiveInteger(options.maxTailBlocks, "Ethereum history tail block bound")
    positiveInteger(
      options.maxTailTransactions,
      "Ethereum history tail transaction bound"
    )
    positiveInteger(options.maxTailLogs, "Ethereum history tail log bound")
    positiveInteger(
      options.maxDecodedPayloadBytes,
      "Ethereum decoded payload bound"
    )
    positiveInteger(
      options.maxActivationReadMs,
      "Ethereum activation read deadline"
    )
    if (
      options.historyAccumulator.profile !==
        "durable-incremental-receipt-complete" ||
      this.historyStoreID !== options.expectedHistoryStoreID ||
      bytes32(
        this.historyStoreFingerprint,
        "Ethereum history store fingerprint"
      ) !==
        bytes32(
          options.expectedHistoryStoreFingerprint,
          "expected Ethereum history store fingerprint"
        ) ||
      this.historyClusterFingerprint !==
        bytes32(
          options.expectedHistoryClusterFingerprint,
          "expected Ethereum history cluster fingerprint"
        )
    ) {
      throw new Error(
        "Ethereum history accumulator is not the pinned durable store"
      )
    }
    if (
      bytes32(stateReader.decoderCodeHash, "Ethereum state reader code") !==
      bytes32(options.expectedStateReaderCodeHash, "expected state reader code")
    ) {
      throw new Error(
        "Ethereum pinned state reader is not this binary's decoder"
      )
    }
    validateDescriptors(options.descriptors)
    this.descriptorSetHash = computeP2TRCanonicalEthereumDescriptorSetHash(
      options.descriptors
    )
    if (
      this.descriptorSetHash !==
      bytes32(options.expectedDescriptorSetHash, "expected descriptor set")
    ) {
      throw new Error(
        "Ethereum activation descriptors do not match the manifest"
      )
    }
    if (
      hashP2TRActivationLinkedLibraryDescriptorSet(options.contracts) !==
      bytes32(
        options.expectedLinkedLibraryDescriptorSetHash,
        "expected linked-library descriptor set"
      )
    ) {
      throw new Error(
        "Ethereum linked-library descriptors do not match this binary"
      )
    }
  }

  getChainID(): Promise<number> {
    return this.provider.getChainID()
  }

  async getFinalizedPoint(
    confirmationDepth: number
  ): Promise<P2TRProductionEthereumPoint> {
    const depth = positiveInteger(
      confirmationDepth,
      "Ethereum confirmation depth"
    )
    const head = await this.provider.getBlockNumber()
    if (head < depth) {
      throw new Error("Ethereum chain has not reached the confirmation depth")
    }
    const finalizedBlock = head - depth
    const block = await this.provider.getBlock(finalizedBlock)
    if (block === null) {
      throw new Error("Ethereum finalized block is absent")
    }
    return { blockNumber: finalizedBlock, blockHash: block.blockHash }
  }

  async getBlockHash(blockNumber: number): Promise<string> {
    const block = await this.provider.getBlock(
      nonNegativeInteger(blockNumber, "Ethereum block number")
    )
    if (block === null) throw new Error("Ethereum block is absent")
    return block.blockHash
  }

  async readActivationState(
    point: P2TRProductionEthereumPoint,
    scanStartBlock: number
  ): Promise<P2TRProductionEthereumState> {
    const deadlineAt = Date.now() + this.options.maxActivationReadMs
    const normalizedPoint = {
      blockNumber: nonNegativeInteger(
        point.blockNumber,
        "Ethereum state block"
      ),
      blockHash: bytes32(point.blockHash, "Ethereum state block hash"),
    }
    if (scanStartBlock !== this.options.scanStartBlock) {
      throw new Error("Ethereum activation scan start is not pinned")
    }
    const actualBlock = await this.provider.getBlock(
      normalizedPoint.blockNumber
    )
    if (actualBlock?.blockHash !== normalizedPoint.blockHash) {
      throw new Error("Ethereum activation state point is noncanonical")
    }
    const chainID = await this.getChainID()
    if (chainID !== this.options.chainID) {
      throw new Error("Ethereum activation provider chain ID changed")
    }
    await this.verifyContractBindings(normalizedPoint)
    const [protocolState, history] = await Promise.all([
      this.stateReader.readPinnedState({
        point: normalizedPoint,
        callAt: (to, data) => this.provider.callAt(to, data, normalizedPoint),
      }),
      this.options.historyAccumulator.synchronizeTo({
        provider: this.provider,
        chainID,
        checkpoint: this.options.checkpoint,
        target: normalizedPoint,
        descriptors: this.options.descriptors,
        maxTailBlocks: this.options.maxTailBlocks,
        maxTailTransactions: this.options.maxTailTransactions,
        maxTailLogs: this.options.maxTailLogs,
        maxDecodedPayloadBytes: this.options.maxDecodedPayloadBytes,
        deadlineAt,
      }),
    ])
    await this.verifyExactEcdsaReadback(
      normalizedPoint,
      protocolState.ecdsaCutover
    )
    if (
      Date.now() > deadlineAt ||
      history.complete !== true ||
      history.processedBlocks > this.options.maxTailBlocks ||
      history.point.blockNumber !== normalizedPoint.blockNumber ||
      bytes32(history.point.blockHash, "history accumulator point") !==
        normalizedPoint.blockHash
    ) {
      throw new Error(
        "Ethereum durable history tail is incomplete, stale, or exceeded its dispatch deadline"
      )
    }
    return {
      point: normalizedPoint,
      contracts: structuredClone(this.options.contracts),
      ...structuredClone(protocolState),
      requiredEventHistoryDigest: bytes32(
        history.requiredEventHistoryDigest,
        "Ethereum history accumulator root"
      ),
      requiredEventCount: nonNegativeInteger(
        history.requiredEventCount,
        "Ethereum history event count"
      ),
      requiredEventCoverage: normalizeCoverageCounters(
        history.coverageCounters
      ),
    }
  }

  private async verifyContractBindings(
    point: P2TRProductionEthereumPoint
  ): Promise<void> {
    for (const [role, binding] of Object.entries(this.options.contracts)) {
      const proxyCode = await this.provider.getCode(binding.address, point)
      const proxyCodeHash = ethereumKeccak256(proxyCode)
      if (
        proxyCode === "0x" ||
        proxyCodeHash !==
          bytes32(binding.runtimeCodeHash, `${role} runtime code`)
      ) {
        throw new Error(
          `Ethereum ${role} runtime code does not match activation`
        )
      }
      if (binding.upgradeability.kind === "immutable") {
        await this.verifyLinkedLibraries(
          proxyCode,
          binding.linkedLibraries,
          point,
          role
        )
        continue
      }
      const [implementationSlot, adminSlot] = await Promise.all([
        this.provider.getStorageAt(
          binding.address,
          EIP1967_IMPLEMENTATION_SLOT,
          point
        ),
        this.provider.getStorageAt(
          binding.address,
          P2TR_EIP1967_ADMIN_SLOT,
          point
        ),
      ])
      if (
        implementationSlot !==
          bytes32(
            binding.upgradeability.implementationSlotValue,
            `${role} implementation slot`
          ) ||
        adminSlot !==
          bytes32(
            binding.upgradeability.adminSlotValue,
            `${role} admin slot`
          ) ||
        slotAddress(implementationSlot) !==
          address(
            binding.upgradeability.implementationAddress,
            `${role} implementation`
          ) ||
        slotAddress(adminSlot) !==
          address(binding.upgradeability.adminAddress, `${role} admin`)
      ) {
        throw new Error(
          `Ethereum ${role} EIP-1967 slots do not match activation`
        )
      }
      const [implementationCode, adminCode] = await Promise.all([
        this.provider.getCode(
          binding.upgradeability.implementationAddress,
          point
        ),
        this.provider.getCode(binding.upgradeability.adminAddress, point),
      ])
      const implementationHash = ethereumKeccak256(implementationCode)
      const adminHash = ethereumKeccak256(adminCode)
      if (
        implementationCode === "0x" ||
        implementationHash !==
          bytes32(
            binding.upgradeability.implementationRuntimeCodeHash,
            `${role} implementation code`
          ) ||
        adminHash !==
          bytes32(
            binding.upgradeability.adminRuntimeCodeHash,
            `${role} admin code`
          )
      ) {
        throw new Error(`Ethereum ${role} implementation/admin code changed`)
      }
      await this.verifyLinkedLibraries(
        implementationCode,
        binding.linkedLibraries,
        point,
        `${role} implementation`
      )
    }
  }

  private async verifyLinkedLibraries(
    ownerCode: string,
    libraries: readonly P2TRActivationLinkedLibraryBinding[],
    point: P2TRProductionEthereumPoint,
    ownerRole: string
  ): Promise<void> {
    const code = canonicalBytecode(ownerCode, `${ownerRole} runtime bytecode`)
    for (const library of libraries) {
      const libraryAddress = address(
        library.address,
        `${ownerRole} ${library.protocolRole} address`
      )
      const embeddedAddress = libraryAddress.slice(2)
      for (const reference of library.references) {
        const start =
          nonNegativeInteger(reference.start, "linked-library byte offset") * 2
        if (
          reference.length !== 20 ||
          start + 40 > code.length ||
          code.slice(start, start + 40) !== embeddedAddress
        ) {
          throw new Error(
            `Ethereum ${ownerRole} linked-library reference changed`
          )
        }
      }
      const libraryCodeValue = await this.provider.getCode(
        libraryAddress,
        point
      )
      const libraryCode = canonicalBytecode(
        libraryCodeValue,
        `${ownerRole} ${library.protocolRole} runtime bytecode`
      )
      if (
        ethereumKeccak256(`0x${libraryCode}`) !==
        bytes32(
          library.runtimeCodeHash,
          `${ownerRole} ${library.protocolRole} runtime code`
        )
      ) {
        throw new Error(
          `Ethereum ${ownerRole} linked-library runtime code changed`
        )
      }
      await this.verifyLinkedLibraries(
        `0x${libraryCode}`,
        library.linkedLibraries,
        point,
        `${ownerRole}/${library.protocolRole}`
      )
    }
  }

  /**
   * Independently reads the exact router/cutover ABI instead of trusting an
   * injected high-level state reader. Production activation is deliberately
   * limited to an empty ECDSA inventory across the full pinned ancestry.
   */
  private async verifyExactEcdsaReadback(
    point: P2TRProductionEthereumPoint,
    cutover: P2TRProductionEcdsaCutover
  ): Promise<void> {
    const bridge = address(
      this.options.contracts.bridge.address,
      "ECDSA Bridge"
    )
    const activeRouter = address(
      this.options.contracts.ecdsaFraudRouter.address,
      "active ECDSA router"
    )
    const coordinator = address(
      this.options.contracts.ecdsaCutoverCoordinator.address,
      "ECDSA cutover coordinator"
    )
    const expectedActive = address(
      cutover.mode === "fresh"
        ? cutover.routerAddress
        : cutover.replacementRouterAddress,
      "cutover active ECDSA router"
    )
    const expectedPredecessor =
      cutover.mode === "fresh"
        ? ZERO_ADDRESS
        : address(cutover.previousRouterAddress, "ECDSA predecessor")
    if (activeRouter !== expectedActive) {
      throw new Error("ECDSA cutover does not name the active router")
    }

    const [bridgeRouter, bridgeCodeHash, bridgeDrain, activeRetired] =
      await Promise.all([
        this.readAddress(
          bridge,
          ECDSA_SELECTORS.bridgeRouter,
          point,
          "Bridge ECDSA router"
        ),
        this.readWord(
          bridge,
          ECDSA_SELECTORS.bridgeRouterCodeHash,
          point,
          "Bridge ECDSA router code hash"
        ),
        this.readAddress(
          bridge,
          ECDSA_SELECTORS.bridgeRouterInDrain,
          point,
          "Bridge ECDSA drain router"
        ),
        this.readBool(
          bridge,
          calldataAddress(ECDSA_SELECTORS.bridgeRouterRetired, activeRouter),
          point,
          "active ECDSA retirement"
        ),
      ])
    if (
      bridgeRouter !== activeRouter ||
      bridgeCodeHash !==
        bytes32(
          this.options.contracts.ecdsaFraudRouter.runtimeCodeHash,
          "manifest ECDSA router code hash"
        ) ||
      bridgeDrain !== ZERO_ADDRESS ||
      activeRetired
    ) {
      throw new Error("Bridge ECDSA router binding/drain state is unsafe")
    }

    const cutoverWords = validateEcdsaCutoverReadinessWords(
      abiWords(
        await this.provider.callAt(
          coordinator,
          ECDSA_SELECTORS.cutoverReadiness,
          point
        ),
        15,
        "ECDSA cutover readiness"
      )
    )
    const pendingGovernanceTransfer = await this.readUint(
      coordinator,
      ECDSA_SELECTORS.governanceTransferChangeInitiated,
      point,
      "Bridge governance transfer timestamp"
    )
    if (
      cutoverWords.some((word) => word !== ZERO_WORD) ||
      pendingGovernanceTransfer !== 0n
    ) {
      throw new Error("ECDSA cutover coordinator is not cleared and idle")
    }
    const migratedChallengesActivatedAt = await this.readUint(
      activeRouter,
      ECDSA_SELECTORS.migratedChallengesActivatedAt,
      point,
      "ECDSA migrated challenge activation epoch"
    )
    if (
      (cutover.mode === "fresh" && migratedChallengesActivatedAt !== 0n) ||
      (cutover.mode === "migrated" && migratedChallengesActivatedAt === 0n)
    ) {
      throw new Error(
        "ECDSA migrated challenge activation epoch is inconsistent"
      )
    }

    const activeDepth = safeNumber(
      await this.readUint(
        activeRouter,
        ECDSA_SELECTORS.ancestryDepth,
        point,
        "active ECDSA ancestry depth"
      ),
      "active ECDSA ancestry depth"
    )
    if (activeDepth > MAX_ECDSA_ROUTER_ANCESTRY_DEPTH) {
      throw new Error("ECDSA router ancestry exceeds its protocol bound")
    }

    let cursor = activeRouter
    let expectedDepth = activeDepth
    let pinnedCodeHash = bytes32(
      this.options.contracts.ecdsaFraudRouter.runtimeCodeHash,
      "active ECDSA router code hash"
    )
    const seen = new Set<string>()
    for (
      let generation = 0;
      generation <= MAX_ECDSA_ROUTER_ANCESTRY_DEPTH;
      generation++
    ) {
      if (seen.has(cursor)) {
        throw new Error("ECDSA router ancestry contains a cycle")
      }
      seen.add(cursor)
      const code = await this.provider.getCode(cursor, point)
      if (code === "0x" || ethereumKeccak256(code) !== pinnedCodeHash) {
        throw new Error("ECDSA router ancestry code hash changed")
      }
      const [routerBridge, protocol, openCount] = await Promise.all([
        this.readAddress(
          cursor,
          ECDSA_SELECTORS.bridge,
          point,
          "ECDSA router Bridge"
        ),
        this.readWord(
          cursor,
          ECDSA_SELECTORS.fraudProtocolID,
          point,
          "ECDSA router protocol"
        ),
        this.readUint(
          cursor,
          ECDSA_SELECTORS.openFraudChallengeCount,
          point,
          "ECDSA open challenge count"
        ),
      ])
      if (routerBridge !== bridge || openCount !== 0n) {
        throw new Error(
          "ECDSA router ancestry has another Bridge or open inventory"
        )
      }

      if (protocol !== P2TR_ECDSA_FRAUD_ROUTER_CURRENT_V3) {
        // The only allowed non-v3 generation is the terminal deployed v2
        // compatibility root. Its public challenge mapping must retain the
        // exact four-word ABI and its authoritative open count is already zero.
        if (
          generation === 0 ||
          expectedDepth !== 0 ||
          protocol !== ECDSA_ROUTER_CURRENT_V2
        ) {
          throw new Error("ECDSA router ancestry protocol is unsupported")
        }
        abiWords(
          await this.provider.callAt(
            cursor,
            calldataUint256(ECDSA_SELECTORS.fraudChallenges, 0n),
            point
          ),
          4,
          "legacy ECDSA fraud challenge mapping"
        )
        return
      }

      const [depth, unattributed, escrow, predecessor, predecessorCodeHash] =
        await Promise.all([
          this.readUint(
            cursor,
            ECDSA_SELECTORS.ancestryDepth,
            point,
            "ECDSA ancestry depth"
          ),
          this.readUint(
            cursor,
            ECDSA_SELECTORS.unattributedOpenFraudChallengeCount,
            point,
            "ECDSA unattributed challenge count"
          ),
          this.readUint(
            cursor,
            ECDSA_SELECTORS.openFraudChallengeEscrow,
            point,
            "ECDSA open challenge escrow"
          ),
          this.readAddress(
            cursor,
            ECDSA_SELECTORS.predecessor,
            point,
            "ECDSA predecessor"
          ),
          this.readWord(
            cursor,
            ECDSA_SELECTORS.predecessorCodeHash,
            point,
            "ECDSA predecessor code hash"
          ),
        ])
      await this.readBool(
        cursor,
        calldataUint256(ECDSA_SELECTORS.challengeIdentityExists, 0n),
        point,
        "ECDSA challenge identity readback"
      )
      if (
        depth !== BigInt(expectedDepth) ||
        unattributed !== 0n ||
        escrow !== 0n ||
        (generation === 0 && predecessor !== expectedPredecessor)
      ) {
        throw new Error("ECDSA v3 router ancestry/readback is inconsistent")
      }
      if (expectedDepth === 0) {
        if (predecessor !== ZERO_ADDRESS || predecessorCodeHash !== ZERO_WORD) {
          throw new Error("ECDSA ancestry root has an unexpected predecessor")
        }
        return
      }
      if (predecessor === ZERO_ADDRESS || predecessorCodeHash === ZERO_WORD) {
        throw new Error("ECDSA ancestry predecessor pin is absent")
      }
      const retired = await this.readBool(
        bridge,
        calldataAddress(ECDSA_SELECTORS.bridgeRouterRetired, predecessor),
        point,
        "ECDSA predecessor retirement"
      )
      if (!retired) {
        throw new Error("ECDSA predecessor is not permanently retired")
      }
      cursor = predecessor
      pinnedCodeHash = predecessorCodeHash
      expectedDepth--
    }
    throw new Error("ECDSA router ancestry did not terminate")
  }

  private async readWord(
    to: string,
    data: string,
    point: P2TRProductionEthereumPoint,
    label: string
  ): Promise<string> {
    return abiWords(await this.provider.callAt(to, data, point), 1, label)[0]
  }

  private async readAddress(
    to: string,
    data: string,
    point: P2TRProductionEthereumPoint,
    label: string
  ): Promise<string> {
    const word = await this.readWord(to, data, point, label)
    if (!word.startsWith("0x000000000000000000000000")) {
      throw new Error(`${label} is not a canonical ABI address`)
    }
    return address(`0x${word.slice(-40)}`, label)
  }

  private async readUint(
    to: string,
    data: string,
    point: P2TRProductionEthereumPoint,
    label: string
  ): Promise<bigint> {
    return BigInt(await this.readWord(to, data, point, label))
  }

  private async readBool(
    to: string,
    data: string,
    point: P2TRProductionEthereumPoint,
    label: string
  ): Promise<boolean> {
    const value = await this.readUint(to, data, point, label)
    if (value !== 0n && value !== 1n) {
      throw new Error(`${label} is not a canonical ABI boolean`)
    }
    return value === 1n
  }
}

const ECDSA_ROUTER_CURRENT_V2 =
  "0x2ec27e6ba7e92f8ce2c5e8d180e5220c899e662e87c4084d1dec5bc9150d2bf8"

function abiWords(value: string, count: number, label: string): string[] {
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length !== count * 64) {
    throw new Error(`${label} returned malformed ABI data`)
  }
  return Array.from(
    { length: count },
    (_, index) => `0x${normalized.slice(index * 64, (index + 1) * 64)}`
  )
}

function validateEcdsaCutoverReadinessWords(words: string[]): string[] {
  if (words.length !== 15) {
    throw new Error("ECDSA cutover readiness word count is invalid")
  }
  abiBoundedUint(words[0], 5n, "ECDSA cutover phase")
  for (const [index, label] of [
    [1, "old router"],
    [2, "new router"],
    [5, "source signer"],
    [7, "reconciler"],
    [9, "pending reconciler"],
  ] as const) {
    abiAddressWord(words[index], `ECDSA cutover ${label}`)
  }
  for (const [index, label] of [
    [11, "finalized block"],
    [13, "migrated block"],
    [14, "migration confirmation time"],
  ] as const) {
    abiBoundedUint(words[index], 0xffffffffffffffffn, `ECDSA cutover ${label}`)
  }
  return words
}

function abiAddressWord(value: string, label: string): string {
  const word = bytes32(value, label)
  if (word.slice(2, 26) !== "0".repeat(24)) {
    throw new Error(`${label} has nonzero ABI address padding`)
  }
  return `0x${word.slice(-40)}`
}

function abiBoundedUint(value: string, maximum: bigint, label: string): bigint {
  const result = BigInt(bytes32(value, label))
  if (result > maximum) throw new Error(`${label} exceeds its ABI width`)
  return result
}

function calldataAddress(selector: string, value: string): string {
  return `${selector}${address(value, "ABI address")
    .slice(2)
    .padStart(64, "0")}`
}

function calldataUint256(selector: string, value: bigint): string {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error("ABI uint256 argument is out of range")
  }
  return `${selector}${value.toString(16).padStart(64, "0")}`
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the safe integer range`)
  }
  return Number(value)
}

function validateDescriptors(
  descriptors: readonly P2TRCanonicalEthereumEventDescriptor[]
): void {
  if (
    descriptors.length !== P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS.length
  ) {
    throw new Error("Ethereum activation descriptor set is incomplete")
  }
  const kinds = new Set(descriptors.map((descriptor) => descriptor.kind))
  const filters = new Set(
    descriptors.map(
      (descriptor) =>
        `${address(descriptor.emitter, "event emitter")}:${bytes32(
          descriptor.topic0,
          "event topic0"
        )}`
    )
  )
  if (
    kinds.size !== descriptors.length ||
    filters.size !== descriptors.length ||
    P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS.some(
      (kind) => !kinds.has(kind)
    )
  ) {
    throw new Error("Ethereum activation descriptor set is not exact")
  }
}

function slotAddress(value: string): string {
  return `0x${bytes32(value, "EIP-1967 slot").slice(-40)}`
}

function canonicalJSON(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical Ethereum state contains an unsafe number")
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`
  }
  throw new Error("Canonical Ethereum state contains an unsupported value")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return `0x${normalized}`
}

function address(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be 20 bytes`)
  }
  return `0x${normalized}`
}

function canonicalBytecode(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (normalized.length === 0 || !/^(?:[0-9a-f]{2})+$/.test(normalized)) {
    throw new Error(`${label} must be non-empty whole bytes`)
  }
  return normalized
}

function boundedString(value: string, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function hashIdentity(value: string, label: string): string {
  const normalized = boundedString(value.trim(), 512, label).normalize("NFKC")
  return `0x${createHash("sha256")
    .update("tbtc-production-operator-identity/v1\u0000", "utf8")
    .update(normalized, "utf8")
    .digest("hex")}`
}

function normalizeCoverageCounters(
  value: P2TREthereumHistoryCoverageCounters
): P2TREthereumHistoryCoverageCounters {
  const counters = {
    blocks: nonNegativeInteger(value.blocks, "Ethereum coverage blocks"),
    transactions: nonNegativeInteger(
      value.transactions,
      "Ethereum coverage transactions"
    ),
    receipts: nonNegativeInteger(value.receipts, "Ethereum coverage receipts"),
    logs: nonNegativeInteger(value.logs, "Ethereum coverage logs"),
    requiredEvents: nonNegativeInteger(
      value.requiredEvents,
      "Ethereum coverage required events"
    ),
  }
  if (
    counters.transactions !== counters.receipts ||
    counters.requiredEvents > counters.logs
  ) {
    throw new Error("Ethereum receipt coverage counters are inconsistent")
  }
  return counters
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}
