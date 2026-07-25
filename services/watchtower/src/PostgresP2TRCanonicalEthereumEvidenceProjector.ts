import type {
  P2TRCanonicalEvidenceStore,
  P2TRFrostWalletBinding,
  P2TRTaprootDepositBinding,
  P2TRUnmatchedProofEnvelope,
} from "./P2TRCanonicalBitcoinIndex.js"
import type {
  P2TRCanonicalEthereumChainPoint,
  P2TRCanonicalEthereumEvent,
  P2TRCanonicalEthereumEvidenceProjector,
} from "./P2TRCanonicalEthereumJournal.js"

const PROOF_SPEND_TYPES = new Map<P2TRCanonicalEthereumEvent["kind"], string>([
  ["deposits-swept", "deposit-sweep"],
  ["redemptions-completed", "redemption"],
  ["moving-funds-completed", "moving-funds"],
  ["moved-funds-swept", "moved-funds-sweep"],
])

/**
 * Projects only immutable identity/evidence bindings. Current eligibility is
 * deliberately excluded and must be read from both providers at one finalized
 * Ethereum block immediately before enqueue or signing.
 */
export class PostgresP2TRCanonicalEthereumEvidenceProjector
  implements P2TRCanonicalEthereumEvidenceProjector
{
  constructor(private readonly evidenceStore: P2TRCanonicalEvidenceStore) {}

  async rollbackCanonicalEthereumEvidenceTo(
    point: P2TRCanonicalEthereumChainPoint
  ): Promise<void> {
    await this.evidenceStore.rollbackEthereumEvidenceTo({
      blockNumber: nonNegativeInteger(point.blockNumber, "rollback block"),
      blockHash: bytes32(point.blockHash, "rollback block hash"),
    })
  }

  async applyCanonicalEthereumEvents(
    events: readonly P2TRCanonicalEthereumEvent[]
  ): Promise<void> {
    for (const event of events) {
      if (event.kind === "frost-wallet-registered") {
        await this.evidenceStore.addFrostWalletBindings([
          frostWalletBinding(event),
        ])
        continue
      }
      if (event.kind === "taproot-deposit-revealed") {
        const walletPubKeyHash = bytes20(
          requiredString(event.payload, "walletPubKeyHash"),
          "Taproot deposit wallet public-key hash"
        )
        const registeredWalletID =
          await this.evidenceStore.loadFrostWalletIDByPubKeyHash(
            walletPubKeyHash
          )
        const payloadWalletID = bytes32(
          requiredString(event.payload, "walletID"),
          "Taproot deposit wallet ID"
        )
        if (
          registeredWalletID === undefined ||
          bytes32(registeredWalletID, "registered FROST wallet ID") !==
            payloadWalletID
        ) {
          throw new Error(
            "Taproot deposit is not bound to the exact registered FROST wallet"
          )
        }
        await this.evidenceStore.addTaprootDepositBindings([
          taprootDepositBinding(event),
        ])
        continue
      }
      const spendType = PROOF_SPEND_TYPES.get(event.kind)
      if (spendType !== undefined) {
        const walletPubKeyHash = bytes20(
          requiredString(event.payload, "walletPubKeyHash"),
          `${event.kind} wallet public-key hash`
        )
        const walletID = await this.evidenceStore.loadFrostWalletIDByPubKeyHash(
          walletPubKeyHash
        )
        // Generic Bridge proof events also cover legacy ECDSA wallets. With a
        // complete deployment-parent scan, absence from the FROST binding table
        // proves this event is outside the FROST evidence domain.
        if (walletID === undefined) continue
        const proof: P2TRUnmatchedProofEnvelope = {
          eventID: event.eventID,
          ethereum: eventPoint(event),
          bitcoinTxid: bytes32(
            requiredString(event.payload, "bitcoinTxid"),
            `${event.kind} Bitcoin transaction ID`
          ),
          walletID,
          spendType,
          payload: event.payload,
        }
        await this.evidenceStore.enqueueUnmatchedProofs([proof])
      }
    }
  }
}

function frostWalletBinding(
  event: P2TRCanonicalEthereumEvent
): P2TRFrostWalletBinding {
  return {
    walletID: bytes32(
      requiredString(event.payload, "walletID"),
      "FROST wallet ID"
    ),
    walletPubKeyHash: bytes20(
      requiredString(event.payload, "walletPubKeyHash"),
      "FROST wallet public-key hash"
    ),
    sourceEventID: event.eventID,
    ethereum: {
      blockNumber: event.log.blockNumber,
      blockHash: event.log.blockHash,
    },
  }
}

function taprootDepositBinding(
  event: P2TRCanonicalEthereumEvent
): P2TRTaprootDepositBinding {
  return {
    txid: bytes32(
      requiredString(event.payload, "fundingTxid"),
      "Taproot deposit funding transaction ID"
    ),
    vout: uint32(
      requiredNumber(event.payload, "fundingOutputIndex"),
      "Taproot deposit funding output index"
    ),
    walletID: bytes32(
      requiredString(event.payload, "walletID"),
      "Taproot deposit wallet ID"
    ),
    outputKey: bytes32(
      requiredString(event.payload, "outputKey"),
      "Taproot deposit output key"
    ),
    sourceEventID: event.eventID,
    ethereum: {
      blockNumber: event.log.blockNumber,
      blockHash: event.log.blockHash,
    },
  }
}

function eventPoint(event: P2TRCanonicalEthereumEvent) {
  return {
    blockNumber: event.log.blockNumber,
    blockHash: event.log.blockHash,
    transactionHash: event.log.transactionHash,
    logIndex: event.log.logIndex,
  }
}

function requiredString(
  payload: Readonly<Record<string, unknown>>,
  field: string
): string {
  const value = payload[field]
  if (typeof value !== "string") {
    throw new Error(
      `Canonical Ethereum payload field ${field} must be a string`
    )
  }
  return value
}

function requiredNumber(
  payload: Readonly<Record<string, unknown>>,
  field: string
): number {
  const value = payload[field]
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `Canonical Ethereum payload field ${field} must be an integer`
    )
  }
  return value as number
}

function bytes32(value: string, label: string): string {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return normalized
}

function bytes20(value: string, label: string): string {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be 20 bytes`)
  }
  return normalized
}

function uint32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} must be a uint32`)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value
}
