import { ChainIdentifier, ExtraDataEncoder } from "../contracts"
import { Hex } from "../utils"
import { SeiAddress } from "./address"

/**
 * Implementation of the ExtraDataEncoder for Sei chain.
 * Encodes Sei addresses as 32-byte values for use in Bitcoin deposit scripts.
 * Since Sei uses EVM-compatible addresses (20 bytes), they are left-padded
 * with zeros to create a 32-byte value.
 */
export class SeiExtraDataEncoder implements ExtraDataEncoder {
  /**
   * Encodes a Sei address into a 32-byte hex string.
   * @param depositOwner - The Sei address to encode
   * @returns A Hex object representing the 32-byte encoded address
   * @throws Error if depositOwner is not a SeiAddress
   */
  encodeDepositOwner(depositOwner: ChainIdentifier): Hex {
    if (!(depositOwner instanceof SeiAddress)) {
      throw new Error("Deposit owner must be a Sei address")
    }

    // Get the address (already without 0x prefix from identifierHex property)
    const addressHex = depositOwner.identifierHex

    // Pad the 20-byte address to 32 bytes (64 hex characters) by prepending zeros
    const paddedAddress = addressHex.padStart(64, "0")

    return Hex.from(`0x${paddedAddress}`)
  }

  /**
   * Decodes a 32-byte hex string back to a Sei address.
   * @param extraData - The 32-byte encoded data as Hex
   * @returns A SeiAddress instance
   * @throws Error if the data cannot be decoded as a Sei address
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier {
    const extraDataHex = extraData.toString()

    // Remove 0x prefix if present
    const cleanHex = extraDataHex.replace(/^0x/, "")

    // Validate length (should be 64 hex characters for 32 bytes)
    if (cleanHex.length !== 64) {
      throw new Error(
        `Invalid extra data length: ${cleanHex.length}. Expected 64 hex characters (32 bytes).`
      )
    }

    // Take the last 40 hex characters (20 bytes) as the Sei address
    // This removes the left-padding zeros
    const addressHex = cleanHex.slice(-40)

    return SeiAddress.from(`0x${addressHex}`)
  }
}
