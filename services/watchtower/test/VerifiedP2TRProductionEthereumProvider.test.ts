import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS,
  computeP2TRCanonicalEthereumDescriptorSetHash,
  type P2TRCanonicalEthereumEventDescriptor,
} from "../src/P2TRCanonicalEthereumJournal.js"
import { ethereumKeccak256 } from "../src/EthereumKeccak256.js"
import type { JsonRpcP2TRCanonicalEthereumProvider } from "../src/HttpP2TREthereumJsonRpc.js"
import {
  hashP2TRActivationLinkedLibraryDescriptorSet,
  hashP2TRActivationLinkedLibraryInventory,
  P2TR_ECDSA_FRAUD_ROUTER_CURRENT_V3,
  type P2TRActivationLinkedLibraryBinding,
  type P2TRProductionEthereumState,
} from "../src/P2TRProductionActivation.js"
import {
  P2TR_EIP1967_ADMIN_SLOT,
  VerifiedP2TRProductionEthereumProvider,
  type P2TRPinnedEthereumStateReader,
} from "../src/VerifiedP2TRProductionEthereumProvider.js"

const checkpoint = { blockNumber: 10, blockHash: `0x${"10".repeat(32)}` }
const point = { blockNumber: 11, blockHash: `0x${"11".repeat(32)}` }
const code = "0x01"

describe("verified production Ethereum provider", () => {
  it("hashes runtime code locally and ignores a malicious web3_sha3 answer", async () => {
    let maliciousHashCalls = 0
    const provider = fakeProvider({
      code: "0x02",
      parentHash: checkpoint.blockHash,
      maliciousHash: () => {
        maliciousHashCalls++
        return ethereumKeccak256(code)
      },
    })
    await assert.rejects(
      configuredProvider(provider).readActivationState(point, 11),
      /runtime code does not match activation/
    )
    assert.equal(maliciousHashCalls, 0)
  })

  it("rejects a first history block not rooted at the signed checkpoint", async () => {
    const provider = fakeProvider({
      code,
      parentHash: `0x${"ff".repeat(32)}`,
    })
    await assert.rejects(
      configuredProvider(provider).readActivationState(point, 11),
      /not rooted at its checkpoint/
    )
  })

  it("requires exact cleared ECDSA cutover and zero live inventory readbacks", async () => {
    const provider = exactEcdsaProvider(0n)
    const state = await configuredExactProvider(provider).readActivationState(
      point,
      11
    )
    assert.equal(state.ecdsaCutover.mode, "fresh")

    await assert.rejects(
      configuredExactProvider(exactEcdsaProvider(1n)).readActivationState(
        point,
        11
      ),
      /open inventory/
    )
  })

  it("reads the canonical EIP-1967 admin slot for upgradeable proxies", async () => {
    assert.equal(
      P2TR_EIP1967_ADMIN_SLOT,
      "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
    )
    const storageCalls: string[] = []
    const provider = exactEcdsaProvider(0n, storageCalls, true)
    await configuredExactProvider(provider, true).readActivationState(point, 11)
    assert.deepEqual(storageCalls, [
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      P2TR_EIP1967_ADMIN_SLOT,
    ])
  })

  it("rejects malformed fixed ECDSA readiness tuple widths", async () => {
    for (const [malformation, pattern] of [
      ["phase", /phase exceeds its ABI width/],
      ["address", /nonzero ABI address padding/],
      ["uint64", /finalized block exceeds its ABI width/],
    ] as const) {
      await assert.rejects(
        configuredExactProvider(
          exactEcdsaProvider(0n, [], false, malformation)
        ).readActivationState(point, 11),
        pattern
      )
    }
  })

  it("verifies every compiler-pinned linked-library reference and code hash", async () => {
    const libraryAddress = `0x${"aa".repeat(20)}`
    const ownerCode = `0x60${libraryAddress.slice(2)}00`
    const libraryCode = "0x60016000"
    const linkedLibraries: P2TRActivationLinkedLibraryBinding[] = [
      {
        protocolRole: "solidity/contracts/bridge/Deposit.sol:Deposit",
        address: libraryAddress,
        runtimeCodeHash: ethereumKeccak256(libraryCode),
        references: [{ start: 1, length: 20 }],
        linkedLibraryDescriptorHash: hashP2TRActivationLinkedLibraryInventory(
          []
        ),
        linkedLibraries: [],
      },
    ]
    const base = fakeProvider({
      code: ownerCode,
      parentHash: checkpoint.blockHash,
    })
    const provider = {
      ...base,
      getCode: async (target: string) =>
        target.toLowerCase() === libraryAddress ? libraryCode : ownerCode,
    } as JsonRpcP2TRCanonicalEthereumProvider
    const runtime = configuredProvider(provider, ownerCode, linkedLibraries)
    await (
      runtime as unknown as {
        verifyContractBindings(point: typeof point): Promise<void>
      }
    ).verifyContractBindings(point)

    const corrupt = configuredProvider(
      {
        ...provider,
        getCode: async (target: string) =>
          target.toLowerCase() === libraryAddress ? "0x60026000" : ownerCode,
      } as JsonRpcP2TRCanonicalEthereumProvider,
      ownerCode,
      linkedLibraries
    )
    await assert.rejects(
      (
        corrupt as unknown as {
          verifyContractBindings(point: typeof point): Promise<void>
        }
      ).verifyContractBindings(point),
      /linked-library runtime code changed/
    )
  })
})

function configuredProvider(
  provider: JsonRpcP2TRCanonicalEthereumProvider,
  contractCode = code,
  linkedLibraries: readonly P2TRActivationLinkedLibraryBinding[] = []
) {
  const descriptors = eventDescriptors()
  const contracts = Object.fromEntries(
    [
      "bridge",
      "completeRouter",
      "authorizationRegistry",
      "frostWalletRegistry",
      "ecdsaFraudRouter",
      "ecdsaCutoverCoordinator",
      "frostProposalValidator",
      "frostSortitionPool",
    ].map((role, index) => [
      role,
      {
        address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
        runtimeCodeHash: ethereumKeccak256(contractCode),
        protocolID: `0x${"01".repeat(32)}`,
        deploymentBlock: 11,
        relevantEventStartBlock: 11,
        linkedLibraryDescriptorHash:
          hashP2TRActivationLinkedLibraryInventory(linkedLibraries),
        linkedLibraries,
        upgradeability: { kind: "immutable" as const },
      },
    ])
  ) as never
  return new VerifiedP2TRProductionEthereumProvider(
    provider,
    {
      decoderCodeHash: `0x${"ab".repeat(32)}`,
      readPinnedState: async () => ({} as never),
    } satisfies P2TRPinnedEthereumStateReader,
    {
      operatorIdentity: "independent-ethereum-operator-a",
      expectedStateReaderCodeHash: `0x${"ab".repeat(32)}`,
      expectedDescriptorSetHash:
        computeP2TRCanonicalEthereumDescriptorSetHash(descriptors),
      expectedLinkedLibraryDescriptorSetHash:
        hashP2TRActivationLinkedLibraryDescriptorSet(contracts),
      chainID: 1,
      checkpoint,
      scanStartBlock: 11,
      contracts,
      descriptors,
      historyAccumulator: {
        profile: "durable-incremental-receipt-complete",
        storeID: "independent-history-a",
        storeFingerprint: `0x${"de".repeat(32)}`,
        clusterFingerprint: `0x${"ce".repeat(32)}`,
        synchronizeTo: async ({ provider, checkpoint, target }) => {
          const targetBlock = await provider.getBlock(target.blockNumber)
          if (targetBlock?.parentHash !== checkpoint.blockHash) {
            throw new Error(
              "Ethereum activation history is not rooted at its checkpoint"
            )
          }
          return {
            point: target,
            requiredEventHistoryDigest: `0x${"00".repeat(32)}`,
            requiredEventCount: 0,
            coverageCounters: {
              blocks: 0,
              transactions: 0,
              receipts: 0,
              logs: 0,
              requiredEvents: 0,
            },
            processedBlocks: 1,
            complete: true,
          }
        },
      },
      expectedHistoryStoreID: "independent-history-a",
      expectedHistoryStoreFingerprint: `0x${"de".repeat(32)}`,
      expectedHistoryClusterFingerprint: `0x${"ce".repeat(32)}`,
      maxTailBlocks: 10,
      maxTailTransactions: 10,
      maxTailLogs: 10,
      maxDecodedPayloadBytes: 1024,
      maxActivationReadMs: 10_000,
    }
  )
}

function eventDescriptors(): P2TRCanonicalEthereumEventDescriptor[] {
  return P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS.map((kind, index) => ({
    kind,
    emitter: `0x${(index + 100).toString(16).padStart(40, "0")}`,
    topic0: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    decoderSchemaID: `test-${kind}`,
    decoderCodeHash: `0x${"cd".repeat(32)}`,
    decode: () => ({}),
  }))
}

function fakeProvider(options: {
  code: string
  parentHash: string
  maliciousHash?: () => string
}): JsonRpcP2TRCanonicalEthereumProvider {
  return {
    trustDomainID: "ethereum-source-a",
    providerIdentity: {},
    endpointFingerprint: `0x${"ef".repeat(32)}`,
    getChainID: async () => 1,
    getBlockNumber: async () => point.blockNumber,
    getBlock: async (blockNumber: number) =>
      blockNumber === point.blockNumber
        ? {
            ...point,
            parentHash: options.parentHash,
            timestamp: 1,
            transactionHashes: [],
          }
        : null,
    getLogs: async () => [],
    getTransactionReceipt: async () => null,
    getCode: async () => options.code,
    getStorageAt: async () => `0x${"00".repeat(32)}`,
    callAt: async () => "0x",
    hashRuntimeCode: options.maliciousHash,
  } as unknown as JsonRpcP2TRCanonicalEthereumProvider
}

const bridgeAddress = "0x0000000000000000000000000000000000000001"
const routerAddress = "0x0000000000000000000000000000000000000005"
const coordinatorAddress = "0x0000000000000000000000000000000000000006"

function configuredExactProvider(
  provider: JsonRpcP2TRCanonicalEthereumProvider,
  upgradeableBridge = false
) {
  const descriptors = eventDescriptors()
  const contracts = Object.fromEntries(
    [
      "bridge",
      "completeRouter",
      "authorizationRegistry",
      "frostWalletRegistry",
      "ecdsaFraudRouter",
      "ecdsaCutoverCoordinator",
      "frostProposalValidator",
      "frostSortitionPool",
    ].map((role, index) => [
      role,
      {
        address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
        runtimeCodeHash: ethereumKeccak256(code),
        protocolID:
          role === "ecdsaFraudRouter"
            ? P2TR_ECDSA_FRAUD_ROUTER_CURRENT_V3
            : `0x${"01".repeat(32)}`,
        deploymentBlock: 11,
        relevantEventStartBlock: 11,
        linkedLibraryDescriptorHash: hashP2TRActivationLinkedLibraryInventory(
          []
        ),
        linkedLibraries: [],
        upgradeability: { kind: "immutable" as const },
      },
    ])
  ) as never
  if (upgradeableBridge) {
    ;(
      contracts as Record<string, { upgradeability: unknown }>
    ).bridge.upgradeability = {
      kind: "eip1967",
      implementationAddress: "0x0000000000000000000000000000000000000009",
      implementationRuntimeCodeHash: ethereumKeccak256(code),
      implementationSlotValue: `0x${"00".repeat(12)}${"00".repeat(19)}09`,
      adminAddress: "0x0000000000000000000000000000000000000008",
      adminRuntimeCodeHash: ethereumKeccak256(code),
      adminSlotValue: `0x${"00".repeat(12)}${"00".repeat(19)}08`,
    }
  }
  const protocolState = {
    ecdsaCutover: {
      mode: "fresh",
      scanStartBlock: 11,
      routerAddress,
      routerRuntimeCodeHash: ethereumKeccak256(code),
      finalizedAtBlock: 11,
      routerOpenChallengeCount: "0",
      bridgeLegacyChallengeCount: "0",
    },
    bridgeBindings: {
      p2trFraudRouter: "0x0000000000000000000000000000000000000002",
      ecdsaFraudRouter: routerAddress,
      frostWalletRegistry: "0x0000000000000000000000000000000000000004",
      completeAuthorizationRegistry:
        "0x0000000000000000000000000000000000000003",
      ecdsaRetired: true,
    },
    completeDepositKeyInventory: {
      finalizedPoint: point,
      inventoryRoot: `0x${"21".repeat(32)}`,
      storedOutputKeyRoot: `0x${"22".repeat(32)}`,
      commitmentOutputKeyRoot: `0x${"22".repeat(32)}`,
      inventoryCount: 0,
      commitmentOnlyCustodyCount: 0,
      eventCursor: point,
    },
    frostArchive: {
      mode: "fresh",
      finalizedPoint: point,
      backfillManifestHash: `0x${"23".repeat(32)}`,
      closedWalletTombstoneRoot: `0x${"24".repeat(32)}`,
      closedWalletTombstoneCount: 0,
      readbackTombstoneRoot: `0x${"24".repeat(32)}`,
      readbackTombstoneCount: 0,
      frostInactivityAddress: "0x0000000000000000000000000000000000000007",
      frostInactivityRuntimeCodeHash: `0x${"25".repeat(32)}`,
      registryFrostInactivityAddress:
        "0x0000000000000000000000000000000000000007",
      activeOnlyGetWalletSemantics: true,
    },
  } satisfies Omit<
    P2TRProductionEthereumState,
    "point" | "contracts" | "requiredEventHistoryDigest" | "requiredEventCount"
  >
  return new VerifiedP2TRProductionEthereumProvider(
    provider,
    {
      decoderCodeHash: `0x${"ab".repeat(32)}`,
      readPinnedState: async () => protocolState,
    },
    {
      operatorIdentity: "independent-ethereum-operator-a",
      expectedStateReaderCodeHash: `0x${"ab".repeat(32)}`,
      expectedDescriptorSetHash:
        computeP2TRCanonicalEthereumDescriptorSetHash(descriptors),
      expectedLinkedLibraryDescriptorSetHash:
        hashP2TRActivationLinkedLibraryDescriptorSet(contracts),
      chainID: 1,
      checkpoint,
      scanStartBlock: 11,
      contracts,
      descriptors,
      historyAccumulator: {
        profile: "durable-incremental-receipt-complete",
        storeID: "independent-history-a",
        storeFingerprint: `0x${"de".repeat(32)}`,
        clusterFingerprint: `0x${"ce".repeat(32)}`,
        synchronizeTo: async ({ target }) => ({
          point: target,
          requiredEventHistoryDigest: `0x${"00".repeat(32)}`,
          requiredEventCount: 0,
          coverageCounters: {
            blocks: 0,
            transactions: 0,
            receipts: 0,
            logs: 0,
            requiredEvents: 0,
          },
          processedBlocks: 1,
          complete: true,
        }),
      },
      expectedHistoryStoreID: "independent-history-a",
      expectedHistoryStoreFingerprint: `0x${"de".repeat(32)}`,
      expectedHistoryClusterFingerprint: `0x${"ce".repeat(32)}`,
      maxTailBlocks: 10,
      maxTailTransactions: 10,
      maxTailLogs: 10,
      maxDecodedPayloadBytes: 1024,
      maxActivationReadMs: 10_000,
    }
  )
}

function exactEcdsaProvider(
  openChallengeCount: bigint,
  storageCalls: string[] = [],
  upgradeableBridge = false,
  malformedReadiness?: "phase" | "address" | "uint64"
): JsonRpcP2TRCanonicalEthereumProvider {
  const zeroWord = `0x${"00".repeat(32)}`
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`
  const addressWord = (value: string) => `0x${value.slice(2).padStart(64, "0")}`
  return {
    trustDomainID: "ethereum-source-a",
    providerIdentity: {},
    endpointFingerprint: `0x${"ef".repeat(32)}`,
    getChainID: async () => 1,
    getBlockNumber: async () => point.blockNumber,
    getBlock: async (blockNumber: number) =>
      blockNumber === point.blockNumber
        ? {
            ...point,
            parentHash: checkpoint.blockHash,
            timestamp: 1,
            transactionHashes: [],
          }
        : null,
    getLogs: async () => [],
    getTransactionReceipt: async () => null,
    getCode: async () => code,
    getStorageAt: async (_address: string, slot: string) => {
      if (!upgradeableBridge) return zeroWord
      storageCalls.push(slot)
      if (
        slot ===
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
      ) {
        return addressWord("0x0000000000000000000000000000000000000009")
      }
      if (slot === P2TR_EIP1967_ADMIN_SLOT) {
        return addressWord("0x0000000000000000000000000000000000000008")
      }
      throw new Error(`unexpected storage slot ${slot}`)
    },
    callAt: async (to: string, data: string) => {
      const selector = data.slice(0, 10)
      if (to === bridgeAddress) {
        if (selector === "0x9fa00083") return addressWord(routerAddress)
        if (selector === "0x8bb6cc67") return ethereumKeccak256(code)
        if (selector === "0x8f6c6ab6") return zeroWord
        if (selector === "0x32f97871") return zeroWord
      }
      if (to === coordinatorAddress) {
        if (selector === "0x4c1a700d") {
          const words = Array.from({ length: 15 }, () => zeroWord)
          if (malformedReadiness === "phase") words[0] = word(6n)
          if (malformedReadiness === "address") {
            words[1] = `0x01${"00".repeat(31)}`
          }
          if (malformedReadiness === "uint64") words[11] = word(1n << 64n)
          return `0x${words.map((entry) => entry.slice(2)).join("")}`
        }
        if (selector === "0x8c382a53") return zeroWord
      }
      if (to === routerAddress) {
        if (selector === "0xe78cea92") return addressWord(bridgeAddress)
        if (selector === "0x73fb85f4") return P2TR_ECDSA_FRAUD_ROUTER_CURRENT_V3
        if (selector === "0x0b5e50af") return word(openChallengeCount)
        if (selector === "0x223a1ee4") return zeroWord
        if (selector === "0x0e6794c1") return zeroWord
        if (selector === "0xfb570298") return zeroWord
        if (selector === "0xbe50c221") return zeroWord
        if (selector === "0xb719d032") return zeroWord
        if (selector === "0x5f85db09") return zeroWord
        if (selector === "0xe4aeee1d") return zeroWord
      }
      throw new Error(`unexpected pinned call ${to}:${selector}`)
    },
  } as unknown as JsonRpcP2TRCanonicalEthereumProvider
}
