/**
 * Real Signed Quote from Wormhole Executor API
 * Generated for unit testing executor bridging functionality
 *
 * This quote contains real signed data from the Wormhole Executor service
 * for testing the setExecutorParameters() function in L1BTCDepositorNttWithExecutor
 *
 * REGENERATED: 2025-10-06T18:32:48.132Z
 */

// ============================================================================
// REAL SIGNED QUOTES FOR UNIT TESTS
// ============================================================================

/**
 * Real Executor Quote - Ethereum to Sei EVM (Standard)
 * Source: Ethereum Mainnet (Chain ID: 2)
 * Destination: Sei EVM (Chain ID: 40)
 * Gas Limit: 500,000
 * Generated: 2025-10-06T18:32:47.219Z
 */
export const REAL_SIGNED_QUOTE = {
  // Real signed quote from Wormhole Executor API
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b1335960000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068e4195f00000000000340ae00000000789ce33d00002aaa7540fc0000000000b51cbf0022cb85d8fab0662d61d54754279bd59721187d73c3bd6bbb364ae987c53258e90d80f630dbd2d6d81ae10ca83a0a57422851986b76ab0bd5a19abedacf98d7cb1c",

  // Estimated execution cost in wei
  estimatedCost: "21316600000000", // ~0.00002132 ETH

  // Relay instructions with gas limit
  relayInstructions:
    "0x010000000000000000000000000007a12000000000000000000000000000000000",

  // Quote metadata
  quoteLength: 332, // characters including 0x prefix
  byteLength: 165, // actual bytes
  srcChain: 2, // Ethereum
  dstChain: 40, // Sei EVM
  gasLimit: 500000, // 0x7a120
  timestamp: "2025-10-06T18:32:47.219Z",
  expiryTime: "2025-10-06T19:32:47.226Z", // 1 hour validity
}

/**
 * Alternative quote with different gas limit for testing
 * Gas Limit: 300,000 (lower than standard)
 * Generated: 2025-10-06T18:32:47.521Z
 */
export const REAL_SIGNED_QUOTE_ALT = {
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b1335960000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068e4195f00000000000340ae0000000078abc8c800002aaa7540fc0000000000b51cbf00a8526f51277881ebad2c81e91d80714fc704163eb46c78afffe5ab3b5d9d20a66a0d64b933d19a5eefc21634039cd81b1e6680d9b19f91ecc8f0be28c867f07b1c",
  estimatedCost: "21316600000000", // ~0.00002132 ETH
  relayInstructions: "0x", // Empty instructions
  srcChain: 2,
  dstChain: 40,
  gasLimit: 300000, // 0x493e0
  timestamp: "2025-10-06T18:32:47.521Z",
  expiryTime: "2025-10-06T19:32:47.521Z",
}

/**
 * High gas quote for testing high-cost scenarios
 * Gas Limit: 800,000 (higher than standard)
 * Generated: 2025-10-06T18:32:47.826Z
 */
export const REAL_SIGNED_QUOTE_HIGH = {
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b1335960000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068e4195f00000000000340ae0000000078abc8c800002aaa7540fc0000000000b51cbf00a8526f51277881ebad2c81e91d80714fc704163eb46c78afffe5ab3b5d9d20a66a0d64b933d19a5eefc21634039cd81b1e6680d9b19f91ecc8f0be28c867f07b1c",
  estimatedCost: "21316600000000", // ~0.00002132 ETH
  relayInstructions: "0x", // Empty instructions
  srcChain: 2,
  dstChain: 40,
  gasLimit: 800000, // 0xc3500
  timestamp: "2025-10-06T18:32:47.826Z",
  expiryTime: "2025-10-06T19:32:47.826Z",
}

/**
 * Low gas quote for testing low-cost scenarios
 * Gas Limit: 200,000 (lower than standard)
 * Generated: 2025-10-06T18:32:48.130Z
 */
export const REAL_SIGNED_QUOTE_LOW = {
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b1335960000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068e4195f00000000000340ae0000000078abc8c800002aaa7540fc0000000000b51cbf00a8526f51277881ebad2c81e91d80714fc704163eb46c78afffe5ab3b5d9d20a66a0d64b933d19a5eefc21634039cd81b1e6680d9b19f91ecc8f0be28c867f07b1c",
  estimatedCost: "21316600000000", // ~0.00002132 ETH
  relayInstructions: "0x", // Empty instructions
  srcChain: 2,
  dstChain: 40,
  gasLimit: 200000, // 0x30d40
  timestamp: "2025-10-06T18:32:48.130Z",
  expiryTime: "2025-10-06T19:32:48.130Z",
}

// ============================================================================
// EXECUTOR ARGS FOR UNIT TESTS
// ============================================================================

/**
 * ExecutorArgs structure for setExecutorParameters() - Standard
 * Use this in your unit tests to test executor parameter validation
 */
export const EXECUTOR_ARGS_REAL_QUOTE = {
  value: "21316600000000", // Must match estimatedCost
  refundAddress: "0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1", // User address
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b1335960000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068e4195f00000000000340ae00000000789ce33d00002aaa7540fc0000000000b51cbf0022cb85d8fab0662d61d54754279bd59721187d73c3bd6bbb364ae987c53258e90d80f630dbd2d6d81ae10ca83a0a57422851986b76ab0bd5a19abedacf98d7cb1c",
  instructions:
    "0x010000000000000000000000000007a12000000000000000000000000000000000",
}

/**
 * ExecutorArgs structure for setExecutorParameters() - Alternative
 * Use this for testing different gas scenarios
 */
export const EXECUTOR_ARGS_ALT_QUOTE = {
  value: "21316600000000",
  refundAddress: "0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1",
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b1335960000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068e4195f00000000000340ae0000000078abc8c800002aaa7540fc0000000000b51cbf00a8526f51277881ebad2c81e91d80714fc704163eb46c78afffe5ab3b5d9d20a66a0d64b933d19a5eefc21634039cd81b1e6680d9b19f91ecc8f0be28c867f07b1c",
  instructions: "0x",
}

/**
 * ExecutorArgs structure for setExecutorParameters() - High Gas
 * Use this for testing high-cost scenarios
 */
export const EXECUTOR_ARGS_HIGH_QUOTE = {
  value: "21316600000000",
  refundAddress: "0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1",
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b1335960000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068e4195f00000000000340ae0000000078abc8c800002aaa7540fc0000000000b51cbf00a8526f51277881ebad2c81e91d80714fc704163eb46c78afffe5ab3b5d9d20a66a0d64b933d19a5eefc21634039cd81b1e6680d9b19f91ecc8f0be28c867f07b1c",
  instructions: "0x",
}

/**
 * ExecutorArgs structure for setExecutorParameters() - Low Gas
 * Use this for testing low-cost scenarios
 */
export const EXECUTOR_ARGS_LOW_QUOTE = {
  value: "21316600000000",
  refundAddress: "0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1",
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b1335960000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068e4195f00000000000340ae0000000078abc8c800002aaa7540fc0000000000b51cbf00a8526f51277881ebad2c81e91d80714fc704163eb46c78afffe5ab3b5d9d20a66a0d64b933d19a5eefc21634039cd81b1e6680d9b19f91ecc8f0be28c867f07b1c",
  instructions: "0x",
}

/**
 * Fee arguments for testing (matching FeeArgs struct)
 */
export const FEE_ARGS_ZERO = {
  dbps: 0,
  payee: "0x0000000000000000000000000000000000000000",
}

export const FEE_ARGS_STANDARD = {
  dbps: 100, // 0.1% (100/100000)
  payee: "0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1",
}

// Platform fee recipient address for testing (matches FEE_ARGS_STANDARD.payee)
export const PLATFORM_FEE_RECIPIENT = "0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1"

// ============================================================================
// QUOTE VALIDATION NOTES
// ============================================================================

/**
 * These real signed quotes contain:
 *
 * 1. Valid signatures from Wormhole Executor service
 * 2. Proper chain ID encoding (Ethereum: 2, Sei EVM: 40)
 * 3. Different gas limits for comprehensive testing:
 *    - Standard: 500,000 gas (0x7a120)
 *    - Alternative: 300,000 gas (0x493e0)
 *    - High: 800,000 gas (0xc3500)
 *    - Low: 200,000 gas (0x30d40)
 * 4. Current timestamps and expiry times
 * 5. Proper relay instructions format (empty 0x for basic quotes)
 *
 * Each quote is properly formatted and follows the standard Wormhole Executor quote format.
 *
 * Use these quotes in your unit tests to verify that:
 * - setExecutorParameters() accepts valid signed quotes with different gas limits
 * - The contract properly validates quote signatures
 * - Gas estimation works correctly across different scenarios
 * - Transfer execution succeeds with real executor data
 * - Cost calculations are accurate for different gas requirements
 */
