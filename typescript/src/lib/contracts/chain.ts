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
   * Identifier of the StarkNet L2 chain.
   */
  starknet?: Chains.StarkNet
}

/**
 * List of chain mappings supported by tBTC v2 contracts.
 */
export const ChainMappings: ChainMapping[] = [
  {
    ethereum: Chains.Ethereum.Mainnet,
    base: Chains.Base.Base,
    arbitrum: Chains.Arbitrum.Arbitrum,
    starknet: Chains.StarkNet.Mainnet,
  },
  {
    ethereum: Chains.Ethereum.Sepolia,
    base: Chains.Base.BaseSepolia,
    arbitrum: Chains.Arbitrum.ArbitrumSepolia,
    starknet: Chains.StarkNet.Sepolia,
  },
]
