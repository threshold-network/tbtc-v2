import { ChainIdentifier } from "../contracts"
import { getAddress } from "viem"

/**
 * Represents an Ethereum address.
 */
// TODO: Make EthereumAddress extends Hex. Remember about keeping the address
//       validation while creating EthereumAddress instance.
export class EthereumAddress implements ChainIdentifier {
  readonly identifierHex: string

  private constructor(address: string) {
    let validAddress: string

    try {
      const prefixedAddress = address.startsWith("0x")
        ? address
        : `0x${address}`
      validAddress = getAddress(prefixedAddress)
      const addressBody = prefixedAddress.substring(2)
      // Unchecksummed addresses may use either uniform case. Mixed-case
      // input must already match EIP-55, before normalizing it for storage.
      if (
        addressBody !== addressBody.toLowerCase() &&
        addressBody !== addressBody.toUpperCase() &&
        prefixedAddress !== validAddress
      ) {
        throw new Error("Invalid Ethereum address checksum")
      }
    } catch (e) {
      throw new Error(`Invalid Ethereum address`)
    }

    this.identifierHex = validAddress.substring(2).toLowerCase()
  }

  static from(address: string): EthereumAddress {
    return new EthereumAddress(address)
  }

  equals(otherValue: EthereumAddress): boolean {
    return this.identifierHex === otherValue.identifierHex
  }
}
