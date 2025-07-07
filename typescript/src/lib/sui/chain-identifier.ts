import { ChainIdentifier } from "../contracts"

/**
 * Represents a SUI address as a chain identifier.
 * SUI addresses are 32-byte hex strings (0x + 64 chars).
 */
export class SuiAddress implements ChainIdentifier {
  public readonly identifierHex: string

  constructor(address: string) {
    // SUI addresses are 32-byte hex strings (0x + 64 chars)
    if (!/^0x[0-9a-fA-F]{64}$/.test(address)) {
      throw new Error("Invalid SUI address format")
    }
    this.identifierHex = address.toLowerCase().substring(2)
  }

  /**
   * Creates a SuiAddress instance from the given SUI address string.
   * @param address The SUI address as a 0x-prefixed hex string.
   * @returns A SuiAddress instance.
   */
  static from(address: string): SuiAddress {
    return new SuiAddress(address)
  }

  /**
   * Checks if this SuiAddress is equal to another ChainIdentifier.
   * @param identifier The other ChainIdentifier to compare with.
   * @returns True if the identifiers are equal, false otherwise.
   */
  equals(identifier: ChainIdentifier): boolean {
    return this.identifierHex === identifier.identifierHex
  }
}
