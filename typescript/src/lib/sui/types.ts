import { SuiClient } from "@mysten/sui/client"
import { Transaction } from "@mysten/sui/transactions"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"

/**
 * SUI client interface for interacting with the SUI network.
 */
export type { SuiClient }

/**
 * SUI transaction builder interface.
 */
export type { Transaction }

/**
 * SUI keypair interface for signing transactions.
 */
export type { Ed25519Keypair }

/**
 * SUI signer type - can be a keypair or wallet adapter.
 * The actual signing is done by the SuiClient, not the signer itself.
 */
export type SuiSigner = Ed25519Keypair | any

/**
 * Extended SUI signer type that includes wallet adapters with address getters.
 */
export interface SuiSignerWithAddress {
  getAddress?: () => Promise<string>
  address?: string
  getPublicKey?: () => any
}

/**
 * SUI coin balance response.
 */
export interface SuiCoinBalance {
  coinType: string
  coinObjectCount: number
  totalBalance: string
  lockedBalance: Record<string, string>
}

/**
 * SUI transaction effects.
 */
export interface SuiTransactionEffects {
  status: {
    status: "success" | "failure"
    error?: string
  }
  gasUsed: {
    computationCost: string
    storageCost: string
    storageRebate: string
    nonRefundableStorageFee: string
  }
  transactionDigest: string
  created?: Array<{
    owner: any
    reference: {
      objectId: string
      version: number
      digest: string
    }
  }>
  events?: Array<{
    id: {
      txDigest: string
      eventSeq: string
    }
    packageId: string
    transactionModule: string
    sender: string
    type: string
    parsedJson: any
  }>
}

/**
 * Error thrown when SUI SDK operations fail.
 */
export class SuiError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "SuiError"
  }
}
