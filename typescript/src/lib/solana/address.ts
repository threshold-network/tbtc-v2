import { ChainIdentifier } from "../contracts"
import { PublicKey } from "@solana/web3.js"

/**
 * Represents a Solana address.
 */
export class SolanaAddress implements ChainIdentifier {
  readonly identifierHex: string

  private constructor(address: string) {
    try {
      // This will throw if `address` is not a valid Solana public key
      const pubKey = new PublicKey(address)

      // Convert the PublicKey buffer to hex for a consistent internal representation
      this.identifierHex = pubKey.toBuffer().toString("hex").toLowerCase()
    } catch (error) {
      throw new Error(`Invalid Solana address: ${address}`)
    }
  }

  static from(address: string): SolanaAddress {
    return new SolanaAddress(address)
  }

  equals(otherValue: SolanaAddress): boolean {
    return this.identifierHex === otherValue.identifierHex
  }
}
