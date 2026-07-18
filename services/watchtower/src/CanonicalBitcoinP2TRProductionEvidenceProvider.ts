import { createHash } from "node:crypto"
import type {
  P2TRCanonicalBitcoinBlockSource,
  P2TRCanonicalBitcoinTransaction,
} from "./P2TRCanonicalBitcoinIndex.js"
import type {
  P2TRProductionBitcoinCandidate,
  P2TRProductionBitcoinCandidateIdentity,
  P2TRProductionBitcoinCandidateAttestation,
  P2TRProductionBitcoinEvidenceProvider,
  P2TRProductionBitcoinState,
} from "./P2TRProductionActivation.js"
import { deriveP2TRProductionCandidateObservationID } from "./P2TRProductionActivation.js"

export type CanonicalBitcoinP2TRProductionEvidenceProviderOptions = {
  /** Stable audited operator identity; the adapter hashes it locally. */
  operatorIdentity: string
  providerIdentity?: object
}

/**
 * Adapts a canonical, unpruned txindex-backed Bitcoin Core source into the
 * activation/reconciliation API. Candidate presence is authenticated from the
 * exact canonical block, never from tx metadata alone.
 */
export class CanonicalBitcoinP2TRProductionEvidenceProvider
  implements P2TRProductionBitcoinEvidenceProvider
{
  readonly trustDomainID: string
  readonly endpointFingerprint: string
  readonly operatorFingerprint: string
  readonly providerIdentity: object

  constructor(
    private readonly source: P2TRCanonicalBitcoinBlockSource,
    options: CanonicalBitcoinP2TRProductionEvidenceProviderOptions
  ) {
    this.trustDomainID = boundedString(
      source.trustDomainID,
      128,
      "Bitcoin provider trust domain"
    )
    this.endpointFingerprint = bytes32(
      (source as P2TRCanonicalBitcoinBlockSource & {
        endpointFingerprint?: string
      }).endpointFingerprint ?? "",
      "derived Bitcoin endpoint fingerprint"
    )
    this.operatorFingerprint = hashIdentity(
      options.operatorIdentity,
      "Bitcoin operator identity"
    )
    this.providerIdentity = options.providerIdentity ?? source
    if (
      typeof this.providerIdentity !== "object" ||
      this.providerIdentity === null
    ) {
      throw new Error("Bitcoin provider identity must be an object")
    }
  }

  async readState(confirmationDepth: number): Promise<P2TRProductionBitcoinState> {
    const depth = positiveInteger(confirmationDepth, "Bitcoin confirmation depth")
    const [head, genesisHash] = await Promise.all([
      this.source.getSyncedHead(),
      this.source.getBlockHash(0),
    ])
    if (head.height < depth) {
      throw new Error("Bitcoin chain has not reached the confirmation depth")
    }
    const finalizedHeight = head.height - depth
    const finalizedHash = await this.source.getBlockHash(finalizedHeight)
    return {
      network: boundedString(this.source.network, 32, "Bitcoin network"),
      genesisHash: bitcoinHash(genesisHash, "Bitcoin genesis hash"),
      txIndex: true,
      unpruned: true,
      synchronized: true,
      finalizedThrough: {
        height: finalizedHeight,
        hash: bitcoinHash(finalizedHash, "Bitcoin finalized block"),
      },
    }
  }

  async getBlockHash(height: number): Promise<string> {
    return bitcoinHash(
      await this.source.getBlockHash(
        nonNegativeInteger(height, "Bitcoin block height")
      ),
      "Bitcoin block hash"
    )
  }

  async attestCandidate(
    candidate: P2TRProductionBitcoinCandidateIdentity
  ): Promise<P2TRProductionBitcoinCandidateAttestation> {
    const normalized = normalizeCandidate(candidate)
    const head = await this.source.getSyncedHead()
    if (head.height < normalized.blockHeight) {
      throw new Error("Bitcoin candidate block is above the synchronized head")
    }
    const block = await this.source.getBlock(normalized.blockHeight)
    if (bitcoinHash(block.hash, "candidate block hash") !== normalized.blockHash) {
      throw new Error("Bitcoin candidate block hash is noncanonical")
    }
    const matching = block.transactions.filter(
      (transaction) =>
        bitcoinHash(transaction.txid, "candidate transaction ID") ===
          normalized.txid &&
        bitcoinHash(transaction.wtxid, "candidate witness transaction ID") ===
          normalized.wtxid
    )
    if (matching.length !== 1) {
      throw new Error("Bitcoin candidate transaction is absent or duplicated")
    }
    assertAuthenticatedTransaction(matching[0])
    // The gate independently verifies this returned point and both providers'
    // block hashes after the attestation, closing head-sampling races.
    return {
      ...normalized,
      finalizedThrough: {
        height: head.height,
        hash: bitcoinHash(head.hash, "Bitcoin attestation head"),
      },
      present: true,
    }
  }
}

function assertAuthenticatedTransaction(
  transaction: P2TRCanonicalBitcoinTransaction
): void {
  if (transaction.rawTransactionHex.length === 0) {
    throw new Error("Bitcoin candidate raw transaction is absent")
  }
  if (transaction.coinbase) return
  for (const input of transaction.inputs) {
    if (
      input.authenticatedPrevout === undefined ||
      bitcoinHash(input.authenticatedPrevout.txid, "authenticated prevout txid") !==
        bitcoinHash(input.txid, "candidate input txid") ||
      input.authenticatedPrevout.vout !== input.vout
    ) {
      throw new Error("Bitcoin candidate has an unauthenticated prevout")
    }
  }
}

function normalizeCandidate(
  candidate: P2TRProductionBitcoinCandidateIdentity
): P2TRProductionBitcoinCandidate {
  const identity = {
    txid: bitcoinHash(candidate.txid, "candidate txid"),
    wtxid: bitcoinHash(candidate.wtxid, "candidate wtxid"),
    blockHeight: nonNegativeInteger(candidate.blockHeight, "candidate block height"),
    blockHash: bitcoinHash(candidate.blockHash, "candidate block hash"),
  }
  return {
    observationID: deriveP2TRProductionCandidateObservationID(identity),
    ...identity,
  }
}

function bitcoinHash(value: string, label: string): string {
  return bytes32(value, label).slice(2)
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return `0x${normalized}`
}

function boundedString(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
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
