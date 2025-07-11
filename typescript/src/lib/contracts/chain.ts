/* eslint-disable no-unused-vars */
/**
 * Chains supported by tBTC v2 contracts.
 */
export namespace Chains {
  export enum Ethereum {
    Mainnet = "1",
    Sepolia = "11155111",
    Local = "1101",
  }

  export enum Base {
    Base = "8453",
    BaseSepolia = "84532",
  }

  export enum Arbitrum {
    Arbitrum = "42161",
    ArbitrumSepolia = "421614",
  }

  export enum Solana {
    Solana = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    Devnet = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  }

  /**
   * StarkNet L2 chains.
   */
  export enum StarkNet {
    /**
     * StarkNet Mainnet.
     */
    Mainnet = "0x534e5f4d41494e", // SN_MAIN in hex
    /**
     * StarkNet Sepolia testnet.
     */
    Sepolia = "0x534e5f5345504f4c4941", // SN_SEPOLIA in hex
  }

  /**
   * SUI L2 chains.
   */
  export enum Sui {
    /**
     * SUI Mainnet.
     */
    Mainnet = "sui:mainnet",
    /**
     * SUI Testnet.
     */
    Testnet = "sui:testnet",
    /**
     * SUI Devnet.
     */
    Devnet = "sui:devnet",
  }
}

/**
 * Destination chains supported by tBTC v2 contracts.
 * These are chains other than the main Ethereum L1 chain.
 */
export type DestinationChainName = Exclude<keyof typeof Chains, "Ethereum">

/**
 * @deprecated Use DestinationChainName instead
 */
export type L2Chain = DestinationChainName

/**
 * Type representing a mapping between specific L1 and L2 chains.
 */
export type ChainMapping = {
  /**
   * Identifier of the Ethereum L1 chain.
   */
  ethereum?: Chains.Ethereum
  /**
   * Identifier of the Base L2 chain.
   */
  base?: Chains.Base

  /**
   * Identifier of the Arbitrum L2 chain.
   */
  arbitrum?: Chains.Arbitrum

  /**
   * Identifier of the Arbitrum L2 chain.
   */
  solana?: Chains.Solana
  /**
   * Identifier of the StarkNet L2 chain.
   */
  starknet?: Chains.StarkNet
  /**
   * Identifier of the SUI L2 chain.
   */
  sui?: Chains.Sui
}

/**
 * List of chain mappings supported by tBTC v2 contracts.
 */
export const ChainMappings: ChainMapping[] = [
  {
    ethereum: Chains.Ethereum.Mainnet,
    base: Chains.Base.Base,
    arbitrum: Chains.Arbitrum.Arbitrum,
    solana: Chains.Solana.Solana,
    starknet: Chains.StarkNet.Mainnet,
    sui: Chains.Sui.Mainnet,
  },
  {
    ethereum: Chains.Ethereum.Sepolia,
    base: Chains.Base.BaseSepolia,
    arbitrum: Chains.Arbitrum.ArbitrumSepolia,
    solana: Chains.Solana.Devnet,
    starknet: Chains.StarkNet.Sepolia,
    sui: Chains.Sui.Testnet,
  },
]
