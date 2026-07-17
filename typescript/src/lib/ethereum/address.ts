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
      validAddress = getAddress(
        address.startsWith("0x") ? address : `0x${address}`
      )
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
