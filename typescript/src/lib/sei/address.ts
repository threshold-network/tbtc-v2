import { ChainIdentifier } from "../contracts"
import { Hex } from "../utils"

/**
 * Represents a Sei address. Since Sei is EVM-compatible, addresses follow
 * the Ethereum address format (20 bytes, 0x-prefixed).
 */
export class SeiAddress implements ChainIdentifier {
  /**
   * The address as a hex string (without 0x prefix).
   * This is normalized to lowercase and represents the 20-byte EVM address.
   */
  readonly identifierHex: string

  private constructor(address: string) {
    // Normalize address - ensure 0x prefix
    const normalized = address.startsWith("0x") ? address : `0x${address}`
    
    // Validate Ethereum-style address format
    if (!normalized.match(/^0x[0-9a-fA-F]{40}$/)) {
      throw new Error(
        `Invalid Sei address format: ${address}. Expected 0x followed by 40 hex characters.`
      )
    }
    
    // Store without 0x prefix, lowercase
    this.identifierHex = normalized.slice(2).toLowerCase()
  }

  /**
   * Creates a SeiAddress from a string or Hex.
   * @param address - The address as string or Hex
   * @returns A new SeiAddress instance
   */
  static from(address: string | Hex): SeiAddress {
    const addressStr = typeof address === "string" ? address : address.toString()
    return new SeiAddress(addressStr)
  }

  /**
   * Returns the string representation of the address.
   * @returns The Sei address as a 0x-prefixed string
   */
  toString(): string {
    return `0x${this.identifierHex}`
  }

  /**
   * Compares this address with another chain identifier.
   * @param otherValue - The other identifier to compare with
   * @returns True if addresses are equal, false otherwise
   */
  equals(otherValue: ChainIdentifier): boolean {
    if (!(otherValue instanceof SeiAddress)) {
      return false
    }
    return this.identifierHex === otherValue.identifierHex
  }
}

