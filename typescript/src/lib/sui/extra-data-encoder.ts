import { ExtraDataEncoder, ChainIdentifier } from "../contracts"
import { Hex } from "../utils"
import { SuiAddress } from "./chain-identifier"

/**
 * Implementation of the SUI extra data encoder.
 * @see {ExtraDataEncoder} for reference.
 */
export class SuiExtraDataEncoder implements ExtraDataEncoder {
  /**
   * Encodes a deposit owner identifier as extra data.
   * For SUI, the address is already 32 bytes, perfect for bytes32.
   * @param depositOwner The deposit owner identifier to encode.
   * @returns The encoded extra data as a 32-byte hex string.
   */
  encodeDepositOwner(depositOwner: ChainIdentifier): Hex {
    // SUI addresses are already 32 bytes, perfect for bytes32
    // The identifierHex doesn't include 0x prefix, so we add it
    return Hex.from(`0x${depositOwner.identifierHex}`)
  }

  /**
   * Decodes a deposit owner identifier from extra data.
   * @param extraData The extra data to decode from.
   * @returns The decoded deposit owner identifier as a SuiAddress.
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier {
    // Extract 32-byte SUI address from extra data
    // Ensure it has 0x prefix for SuiAddress validation
    let addressHex = extraData.toString()
    if (!addressHex.startsWith("0x")) {
      addressHex = `0x${addressHex}`
    }
    return SuiAddress.from(addressHex)
  }
}
