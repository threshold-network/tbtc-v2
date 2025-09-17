import { ChainIdentifier, ExtraDataEncoder } from "../contracts"
import { EthereumAddress } from "../ethereum"
import { Hex } from "../utils"

/**
 * Sei implementation of the ExtraDataEncoder.
 *
 * Since SeiEVM is fully EVM compatible, this implementation is essentially
 * identical to the Ethereum cross-chain extra data encoder. It handles
 * encoding and decoding of deposit owner addresses for cross-chain deposits.
 *
 * The extra data format follows the same pattern as other EVM chains:
 * - 20-byte Ethereum-compatible address
 * - Left-padded with zeros to make it 32 bytes
 */
export class SeiExtraDataEncoder implements ExtraDataEncoder {
  /**
   * Encodes the deposit owner identifier as extra data.
   * @param depositOwner The deposit owner identifier (must be an EthereumAddress)
   * @returns The encoded extra data as a Hex string
   * @throws Error if the deposit owner is not an EthereumAddress
   */
  encodeDepositOwner(depositOwner: ChainIdentifier): Hex {
    if (!(depositOwner instanceof EthereumAddress)) {
      throw new Error(
        "Sei deposit owner must be an Ethereum-compatible address"
      )
    }

    // Convert the 20-byte address to a 32-byte hex string (left-padded with zeros)
    const paddedAddress = depositOwner.identifierHex.padStart(64, "0")
    return Hex.from(paddedAddress)
  }

  /**
   * Decodes the extra data to get the deposit owner identifier.
   * @param extraData The extra data as a Hex string
   * @returns The decoded deposit owner identifier as an EthereumAddress
   * @throws Error if the extra data format is invalid
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier {
    const extraDataHex = extraData.toString()

    // Validate the extra data length (should be 32 bytes = 64 hex chars)
    if (extraDataHex.length !== 64) {
      throw new Error(
        `Invalid extra data length: expected 64 hex characters, got ${extraDataHex.length}`
      )
    }

    // Extract the last 20 bytes (40 hex chars) as the address
    const addressHex = extraDataHex.slice(-40)

    // Validate that it's a valid Ethereum address format
    if (!/^[0-9a-fA-F]{40}$/.test(addressHex)) {
      throw new Error(`Invalid address format in extra data: ${addressHex}`)
    }

    return EthereumAddress.from(addressHex)
  }

  /**
   * Validates that the given identifier can be encoded as extra data.
   * @param depositOwner The deposit owner identifier to validate
   * @returns True if the identifier can be encoded, false otherwise
   */
  canEncode(depositOwner: ChainIdentifier): boolean {
    return depositOwner instanceof EthereumAddress
  }

  /**
   * Gets the expected length of encoded extra data in bytes.
   * @returns The length (32 bytes)
   */
  getEncodedLength(): number {
    return 32
  }

  /**
   * Creates a SeiExtraDataEncoder instance from an Ethereum address string.
   * @param address The Ethereum address string (with or without 0x prefix)
   * @returns A new EthereumAddress that can be used with this encoder
   */
  static addressFromString(address: string): EthereumAddress {
    return EthereumAddress.from(address)
  }

  /**
   * Encodes an Ethereum address string directly as extra data.
   * @param address The Ethereum address string (with or without 0x prefix)
   * @returns The encoded extra data as a Hex string
   */
  static encodeAddress(address: string): Hex {
    const encoder = new SeiExtraDataEncoder()
    const ethAddress = EthereumAddress.from(address)
    return encoder.encodeDepositOwner(ethAddress)
  }

  /**
   * Decodes extra data directly to an Ethereum address string.
   * @param extraData The extra data as a Hex string
   * @returns The decoded Ethereum address string with 0x prefix
   */
  static decodeToAddressString(extraData: Hex): string {
    const encoder = new SeiExtraDataEncoder()
    const ethAddress = encoder.decodeDepositOwner(extraData)
    return `0x${ethAddress.identifierHex}`
  }
}
