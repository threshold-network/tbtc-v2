import { CrossChainExtraDataEncoder } from "../contracts"
import { ChainIdentifier } from "../contracts"
import { StarkNetAddress } from "./address"
import { Hex } from "../utils"

/**
 * Implementation of the StarkNet CrossChainExtraDataEncoder.
 *
 * This encoder handles the encoding and decoding of StarkNet addresses
 * for cross-chain deposits. StarkNet addresses are felt252 field elements
 * that are encoded as 32-byte values for compatibility with L1 contracts.
 *
 * @see {CrossChainExtraDataEncoder} for reference.
 */
export class StarkNetCrossChainExtraDataEncoder
  implements CrossChainExtraDataEncoder
{
  /**
   * Encodes a StarkNet address into extra data for cross-chain deposits.
   *
   * @param depositOwner The deposit owner identifier. Must be a StarkNetAddress.
   * @returns The encoded extra data as a 32-byte hex value.
   * @throws Error if the deposit owner is not a StarkNetAddress instance.
   *
   * @see {CrossChainExtraDataEncoder#encodeDepositOwner}
   */
  encodeDepositOwner(depositOwner: ChainIdentifier): Hex {
    if (!depositOwner || !(depositOwner instanceof StarkNetAddress)) {
      throw new Error("Deposit owner must be a StarkNet address")
    }

    // StarkNet addresses are already 32 bytes when properly formatted
    // Remove the 0x prefix before creating Hex object
    const bytes32 = depositOwner.toBytes32()
    return Hex.from(bytes32.replace(/^0x/, ""))
  }

  /**
   * Decodes extra data back into a StarkNet address.
   *
   * @param extraData The extra data to decode. Must be exactly 32 bytes.
   * @returns The decoded StarkNetAddress instance.
   * @throws Error if the extra data is missing, null, or not exactly 32 bytes.
   *
   * @see {CrossChainExtraDataEncoder#decodeDepositOwner}
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier {
    if (!extraData) {
      throw new Error("Extra data is required")
    }

    // Remove 0x prefix and check length
    const hexString = extraData.toString().replace(/^0x/, "")
    const byteLength = hexString.length / 2

    if (byteLength !== 32) {
      throw new Error(
        `Invalid extra data length for StarkNet. Expected 32 bytes but got ${byteLength}`
      )
    }

    // Create StarkNet address from the extra data
    return StarkNetAddress.from(extraData.toString())
  }
}
