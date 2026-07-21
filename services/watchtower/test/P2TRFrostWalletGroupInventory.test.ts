import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA,
  assertP2TRProductionFrostHandshake,
  computeP2TRFrostWalletGroupInventory,
  type P2TRFrostWalletGroupInventoryEntry,
  type P2TRProductionActivationManifest,
  type P2TRProductionFrostHandshakeState,
} from "../src/P2TRProductionActivation.js"

const point = { blockNumber: 120, blockHash: `0x${"12".repeat(32)}` }

const entry = (
  walletByte: string,
  actualGroupSize: number,
  lifecycle: P2TRFrostWalletGroupInventoryEntry["lifecycle"] = "live"
): P2TRFrostWalletGroupInventoryEntry => ({
  walletID: `0x${walletByte.repeat(32)}`,
  retainedGroupHash: `0x${"ab".repeat(31)}${walletByte}`,
  actualGroupSize,
  lifecycle,
  creationPoint: {
    blockNumber: 20,
    blockHash: `0x${"20".repeat(32)}`,
    transactionHash: `0x${"21".repeat(32)}`,
    transactionIndex: 1,
    logIndex: 4,
  },
  bridgeRegistrationPoint: {
    blockNumber: 20,
    blockHash: `0x${"20".repeat(32)}`,
    transactionHash: `0x${"21".repeat(32)}`,
    transactionIndex: 1,
    logIndex: 5,
  },
  lifecyclePoint: {
    blockNumber: lifecycle === "live" ? 20 : 80,
    blockHash: `0x${(lifecycle === "live" ? "20" : "80").repeat(32)}`,
    transactionHash: `0x${(lifecycle === "live" ? "21" : "81").repeat(32)}`,
    transactionIndex: 1,
    logIndex: lifecycle === "live" ? 5 : 2,
  },
  ...(lifecycle === "closed" || lifecycle === "terminated"
    ? {
        registryClosurePoint: {
          blockNumber: 80,
          blockHash: `0x${"80".repeat(32)}`,
          transactionHash: `0x${"81".repeat(32)}`,
          transactionIndex: 1,
          logIndex: 3,
        },
      }
    : {}),
})

describe("FROST retained-group inventory", () => {
  it("commits exact 51..100 retained groups independently of input order", () => {
    const entries = [
      entry("01", 51),
      entry("02", 73, "closing"),
      entry("03", 100, "closed"),
    ]
    const left = computeP2TRFrostWalletGroupInventory(point, 9, entries)
    const right = computeP2TRFrostWalletGroupInventory(
      point,
      9,
      [...entries].reverse()
    )

    assert.deepEqual(left, right)
    assert.equal(left.schema, P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA)
    assert.equal(left.walletCount, 3)
    assert.equal(left.minimumActualGroupSize, 51)
    assert.equal(left.maximumActualGroupSize, 100)
  })

  it("binds lifecycle history and signer snapshot generation", () => {
    const live = computeP2TRFrostWalletGroupInventory(point, 9, [
      entry("01", 51, "live"),
    ])
    const closing = computeP2TRFrostWalletGroupInventory(point, 9, [
      entry("01", 51, "closing"),
    ])
    const nextGeneration = computeP2TRFrostWalletGroupInventory(point, 10, [
      entry("01", 51, "live"),
    ])

    assert.notEqual(live.inventoryRoot, closing.inventoryRoot)
    assert.notEqual(live.inventoryRoot, nextGeneration.inventoryRoot)
  })

  it("rejects ambiguous or unsafe retained groups", () => {
    assert.throws(
      () =>
        computeP2TRFrostWalletGroupInventory(point, 1, [
          entry("01", 51),
          entry("01", 51),
        ]),
      /ambiguous wallet membership/
    )
    assert.throws(
      () => computeP2TRFrostWalletGroupInventory(point, 1, [entry("01", 50)]),
      /between 51 and 100/
    )
    assert.throws(
      () => computeP2TRFrostWalletGroupInventory(point, 1, [entry("01", 101)]),
      /between 51 and 100/
    )
  })

  it("binds signer readiness to independent canonical and quarantine journals", () => {
    const inventory = computeP2TRFrostWalletGroupInventory(point, 9, [
      entry("01", 51),
    ])
    const expected = frostSignerManifest()
    const handshake = frostSignerHandshake(inventory)

    assert.doesNotThrow(() =>
      assertP2TRProductionFrostHandshake(handshake, expected, inventory)
    )

    const mutations: P2TRProductionFrostHandshakeState[] = [
      {
        ...handshake,
        canonicalJournal: {
          ...handshake.canonicalJournal,
          current: { ...point, blockHash: word("99") },
        },
      },
      {
        ...handshake,
        canonicalJournal: {
          ...handshake.canonicalJournal,
          generation: 8,
        },
      },
      {
        ...handshake,
        quarantineJournal: {
          ...handshake.quarantineJournal,
          root: word("00"),
        },
      },
      {
        ...handshake,
        quarantineJournal: {
          ...handshake.quarantineJournal,
          storeID: handshake.canonicalJournal.storeID,
        },
      },
      {
        ...handshake,
        canonicalJournal: {
          ...handshake.canonicalJournal,
          storeFingerprint: handshake.durableSessionStoreFingerprint,
        },
      },
    ]
    for (const mutation of mutations) {
      assert.throws(() =>
        assertP2TRProductionFrostHandshake(mutation, expected, inventory)
      )
    }
  })
})

const word = (byte: string): string => `0x${byte.repeat(32)}`
const account = (byte: string): string => `0x${byte.repeat(20)}`

function frostSignerManifest(): P2TRProductionActivationManifest["frostSigner"] {
  return {
    trustDomainID: "frost-signer-domain",
    durableSessionStoreFingerprint: word("01"),
    protocolID: word("02"),
    reservationProtocolID: word("03"),
    bitcoinOutboxProtocolID: word("04"),
    signingPolicyHash: word("05"),
    completeRouterAddress: account("06"),
    authorizationRegistryAddress: account("07"),
    attestationSignerKeyHash: word("08"),
    handshakeEndpointFingerprint: word("09"),
    handshakeOperatorFingerprint: word("0a"),
    threshold: 51,
    maximumGroupSize: 100,
    retainedGroupInventoryProtocolID: word("0b"),
    canonicalJournal: {
      storeID: "canonical-retained-groups",
      storeFingerprint: word("0c"),
      clusterFingerprint: word("0d"),
      checkpoint: { blockNumber: 10, blockHash: word("0e") },
      descriptorSetHash: word("0f"),
      sourceTrustDomainID: "independent-ethereum-source",
      sourceEndpointFingerprint: word("10"),
      sourceOperatorFingerprint: word("11"),
      minimumGeneration: 9,
    },
    quarantineJournal: {
      protocolID: word("12"),
      storeID: "frost-quarantine",
      storeFingerprint: word("13"),
      clusterFingerprint: word("14"),
      minimumGeneration: 4,
    },
    exactRetainedGroupInventoryRequired: true,
    finalizedReservationReceiptRequired: true,
    exactReservationIdentityRequired: true,
    authorizationRootRequired: true,
    durableSessionPersistenceRequired: true,
    durableBitcoinOutboxRequired: true,
    quarantineFailClosed: true,
  }
}

function frostSignerHandshake(
  inventory: ReturnType<typeof computeP2TRFrostWalletGroupInventory>
): P2TRProductionFrostHandshakeState {
  const expected = frostSignerManifest()
  return {
    protocolID: expected.protocolID,
    reservationProtocolID: expected.reservationProtocolID,
    bitcoinOutboxProtocolID: expected.bitcoinOutboxProtocolID,
    signingPolicyHash: expected.signingPolicyHash,
    durableSessionStoreFingerprint: expected.durableSessionStoreFingerprint,
    completeRouterAddress: expected.completeRouterAddress,
    authorizationRegistryAddress: expected.authorizationRegistryAddress,
    threshold: 51,
    maximumGroupSize: 100,
    retainedGroupInventoryProtocolID: expected.retainedGroupInventoryProtocolID,
    frostWalletGroupInventory: inventory,
    canonicalJournal: {
      storeID: expected.canonicalJournal.storeID,
      storeFingerprint: expected.canonicalJournal.storeFingerprint,
      clusterFingerprint: expected.canonicalJournal.clusterFingerprint,
      checkpoint: expected.canonicalJournal.checkpoint,
      current: inventory.point,
      descriptorSetHash: expected.canonicalJournal.descriptorSetHash,
      sourceTrustDomainID: expected.canonicalJournal.sourceTrustDomainID,
      sourceEndpointFingerprint:
        expected.canonicalJournal.sourceEndpointFingerprint,
      sourceOperatorFingerprint:
        expected.canonicalJournal.sourceOperatorFingerprint,
      generation: inventory.snapshotGeneration,
      complete: true,
    },
    quarantineJournal: {
      protocolID: expected.quarantineJournal.protocolID,
      storeID: expected.quarantineJournal.storeID,
      storeFingerprint: expected.quarantineJournal.storeFingerprint,
      clusterFingerprint: expected.quarantineJournal.clusterFingerprint,
      root: word("15"),
      generation: 4,
      currentQuarantineCount: 0,
      complete: true,
    },
    finalizedReservationReadbackEnforced: true,
    exactTransactionAuthorizationRootEnforced: true,
    nonceShareGateEnforced: true,
    durableBitcoinOutboxRecovered: true,
    quarantineFailClosed: true,
    healthy: true,
  }
}
