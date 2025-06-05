import { ChainIdentifier } from "../contracts"

/**
 * Represents a StarkNet address compliant with the ChainIdentifier interface.
 * StarkNet addresses are field elements (felt252) in the StarkNet prime field.
 */
export class StarkNetAddress implements ChainIdentifier {
  /**
   * The address as a 64-character hex string (without 0x prefix).
   * This is always normalized to lowercase and padded to 32 bytes.
   */
  readonly identifierHex: string

  private constructor(address: string) {
    // Normalize the address - remove 0x prefix if present and convert to lowercase
    const normalized = address.toLowerCase().replace(/^0x/, "")

    // Validate it's a valid hex string
    if (!/^[0-9a-f]+$/.test(normalized)) {
      throw new Error(`Invalid StarkNet address format: ${address}`)
    }

    // Validate it's within felt252 range (prime field element)
    // For simplicity, we'll just check it's not too long
    if (normalized.length > 64) {
      throw new Error(
        `StarkNet address exceeds maximum field element size: ${address}`
      )
    }

    // Pad to 64 characters (32 bytes)
    this.identifierHex = normalized.padStart(64, "0")
  }

  /**
   * Creates a StarkNetAddress instance from a hex string.
   * @param address The StarkNet address as a hex string (with or without 0x prefix)
   * @returns A new StarkNetAddress instance
   * @throws Error if the address format is invalid or exceeds field element size
   */
  static from(address: string): StarkNetAddress {
    return new StarkNetAddress(address)
  }

  /**
   * Checks if this address equals another ChainIdentifier.
   * @param otherValue The other value to compare with
   * @returns true if both are StarkNetAddress instances with the same identifierHex
   */
  equals(otherValue: ChainIdentifier): boolean {
    if (!(otherValue instanceof StarkNetAddress)) {
      return false
    }
    return this.identifierHex === otherValue.identifierHex
  }

  /**
   * Converts the address to a bytes32 hex string format.
   * This is useful for L1 contract interactions that expect bytes32.
   * @returns The address as a 0x-prefixed 64-character hex string
   */
  toBytes32(): string {
    return "0x" + this.identifierHex
  }

  /**
   * Returns the address as a string in the standard StarkNet format.
   * @returns The address as a 0x-prefixed hex string
   */
  toString(): string {
    return "0x" + this.identifierHex
  }
}
