import { Hex } from "../utils"
import { networks } from "bitcoinjs-lib"

/**
 * Bitcoin networks.
 */
export enum BitcoinNetwork {
  /* eslint-disable no-unused-vars */
  /**
   * Unknown network.
   */
  Unknown = "unknown",
  /**
   * Bitcoin Testnet (testnet3).
   */
  Testnet = "testnet",
  /**
   * Bitcoin Testnet4.
   */
  Testnet4 = "testnet4",
  /**
   * Bitcoin Mainnet.
   */
  Mainnet = "mainnet",
  /* eslint-enable no-unused-vars */
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace BitcoinNetwork {
  /**
   * Gets Bitcoin Network type by comparing a provided hash to known
   * {@link https://en.bitcoin.it/wiki/Genesis_block genesis block hashes}.
   * Returns {@link BitcoinNetwork.Unknown}
   * @param hash Hash of a block.
   * @returns Bitcoin Network.
   */
  export function fromGenesisHash(hash: Hex): BitcoinNetwork {
    switch (hash.toString()) {
      case "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f": {
        return BitcoinNetwork.Mainnet
      }
      case "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943": {
        return BitcoinNetwork.Testnet
      }
      case "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043": {
        return BitcoinNetwork.Testnet4
      }
      default: {
        return BitcoinNetwork.Unknown
      }
    }
  }
}

/**
 * Converts the provided {@link BitcoinNetwork} enumeration to a format expected
 * by the `bitcoinjs-lib` library.
 * @param bitcoinNetwork - Specified Bitcoin network.
 * @returns Network representation compatible with the `bitcoinjs-lib` library.
 * @throws An error if the network is not supported by `bitcoinjs-lib`.
 */
export function toBitcoinJsLibNetwork(
  bitcoinNetwork: BitcoinNetwork
): networks.Network {
  switch (bitcoinNetwork) {
    case BitcoinNetwork.Mainnet: {
      return networks.bitcoin
    }
    case BitcoinNetwork.Testnet:
    case BitcoinNetwork.Testnet4: {
      return networks.testnet
    }
    default: {
      throw new Error(`network not supported`)
    }
  }
}
