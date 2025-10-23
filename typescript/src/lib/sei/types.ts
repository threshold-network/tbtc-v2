import { ethers } from "ethers"

/**
 * Sei provider type - uses standard Ethereum provider since Sei is EVM-compatible
 */
export type SeiProvider = ethers.providers.Provider

/**
 * Sei signer type - uses standard Ethereum signer
 */
export type SeiSigner = ethers.Signer
