import type { Provider } from "@ethersproject/providers"
import type { Signer } from "@ethersproject/abstract-signer"

/**
 * Sei provider type - uses standard Ethereum provider since Sei is EVM-compatible
 */
export type SeiProvider = Provider

/**
 * Sei signer type - uses standard Ethereum signer
 */
export type SeiSigner = Signer
