import { Provider, Account } from "starknet"

/**
 * Represents a StarkNet provider that can be either a Provider or Account instance.
 * This follows the pattern similar to Solana's Connection type.
 *
 * - Provider: For read-only operations (e.g., balance queries)
 * - Account: For write operations (e.g., transactions)
 */
export type StarkNetProvider = Provider | Account
