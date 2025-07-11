import { ExtraDataEncoder, ChainIdentifier } from "../contracts"
import { SolanaAddress } from "./address"
import { Hex } from "../utils"

/**
 * Implementation of the Solana ExtraDataEncoder.
 *
 * This encoder handles the encoding and decoding of Solana addresses
 * for cross-chain deposits. Solana addresses are 32-byte values.
 *
 * @see {ExtraDataEncoder} for reference.
 */
export class SolanaExtraDataEncoder implements ExtraDataEncoder {
  /**
   * Encodes a StarkNet address into extra data for cross-chain deposits.
   *
   * @param depositOwner The deposit owner identifier. Must be a SolanaAddress.
   * @returns The encoded extra data as a 32-byte hex value.
   * @throws Error if the deposit owner is not a SolanaAddress instance.
   *
   * @see {ExtraDataEncoder#encodeDepositOwner}
   */
  encodeDepositOwner(depositOwner: ChainIdentifier): Hex {
    if (!depositOwner || !(depositOwner instanceof SolanaAddress)) {
      throw new Error("Deposit owner must be a Solana address")
    }

    const buffer = Hex.from(depositOwner.identifierHex).toBuffer()
    return Hex.from(buffer)
  }

  /**
   * Decodes extra data back into a StarkNet address.
   *
   * @param extraData The extra data to decode. Must be exactly 32 bytes.
   * @returns The decoded StarkNetAddress instance.
   * @throws Error if the extra data is missing, null, or not exactly 32 bytes.
   *
   * @see {ExtraDataEncoder#decodeDepositOwner}
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier {
    if (!extraData) {
      throw new Error("Extra data is required")
    }
    const buffer = extraData.toBuffer()

    // This should always be 32 bytes if our system is consistent
    if (buffer.length !== 32) {
      throw new Error(`Extra data must be 32 bytes. Got ${buffer.length}.`)
    }

    // Create sOLANA address from the extra data
    return SolanaAddress.from(Hex.from(buffer).toString())
  }
}

/**
 * @deprecated Use SolanaExtraDataEncoder instead
 */
export const SolanaCrossChainExtraDataEncoder = SolanaExtraDataEncoder
