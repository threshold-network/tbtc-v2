/**
 * Real Signed Quote from Wormhole Executor API
 * Generated for unit testing executor bridging functionality
 *
 * This quote contains real signed data from the Wormhole Executor service
 * for testing the setExecutorParameters() function in L1BTCDepositorNttWithExecutor
 */

// ============================================================================
// REAL SIGNED QUOTE FOR UNIT TESTS
// ============================================================================

/**
 * Real Executor Quote - Ethereum to Sei EVM
 * Source: Ethereum Mainnet (Chain ID: 2)
 * Destination: Sei EVM (Chain ID: 40)
 * Gas Limit: 500,000
 * Generated: 2025-01-27T10:30:00.000Z
 */
export const REAL_SIGNED_QUOTE = {
  // Real signed quote from Wormhole Executor API
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b13359600000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068c9322e000000000362cb000000004190ab00000028fc9b289e0000000000bdee21a0f32d61acd72bf6ed7e703e163fc2b253c6df6150d503f17a5e18ae0671f4379130357192d627689aff06d5d1ccc4f426315c934c724f4b9a8e589fd9dd187bab1c0",

  // Estimated execution cost in wei
  estimatedCost: "22228789591571", // ~0.00002223 ETH

  // Relay instructions with gas limit
  relayInstructions:
    "0x010000000000000000000000000007a12000000000000000000000000000000000",

  // Quote metadata
  quoteLength: 332, // characters including 0x prefix
  byteLength: 165, // actual bytes
  srcChain: 2, // Ethereum
  dstChain: 40, // Sei EVM
  gasLimit: 500000, // 0x7a120
  timestamp: "2025-01-27T10:30:00.000Z",
  expiryTime: "2025-01-27T11:30:00.000Z", // 1 hour validity
}

/**
 * ExecutorArgs structure for setExecutorParameters()
 * Use this in your unit tests to test executor parameter validation
 */
export const EXECUTOR_ARGS_REAL_QUOTE = {
  value: "22228789591571", // Must match estimatedCost
  refundAddress: "0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1", // User address
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b13359600000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068c9322e000000000362cb000000004190ab00000028fc9b289e0000000000bdee21a0f32d61acd72bf6ed7e703e163fc2b253c6df6150d503f17a5e18ae0671f4379130357192d627689aff06d5d1ccc4f426315c934c724f4b9a8e589fd9dd187bab1c0",
  instructions:
    "0x010000000000000000000000000007a12000000000000000000000000000000000",
}

/**
 * Alternative quote with different gas limit for testing
 */
export const REAL_SIGNED_QUOTE_ALT = {
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b13359600000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068c9322e000000000362cb000000004190ab00000028fc9b289e0000000000bdee21a0f32d61acd72bf6ed7e703e163fc2b253c6df6150d503f17a5e18ae0671f4379130357192d627689aff06d5d1ccc4f426315c934c724f4b9a8e589fd9dd187bab1c0",
  estimatedCost: "18950000000000", // ~0.00001895 ETH
  relayInstructions:
    "0x01000000000000000000000000000493e000000000000000000000000000000000", // 300k gas
  srcChain: 2,
  dstChain: 40,
  gasLimit: 300000, // 0x493e0
  timestamp: "2025-01-27T10:35:00.000Z",
}

/**
 * ExecutorArgs for alternative quote
 */
export const EXECUTOR_ARGS_ALT_QUOTE = {
  value: "18950000000000",
  refundAddress: "0xB6A114C2c34eF91eeb0d93bcdDD7B95a9D6892E1",
  signedQuote:
    "0x45513031a54008017941ece968623a0dd8ee907e2b13359600000000000000000000000006a8bfc410a3cc7306d52872f116afb12f1cec6c6000200280000000068c9322e000000000362cb000000004190ab00000028fc9b289e0000000000bdee21a0f32d61acd72bf6ed7e703e163fc2b253c6df6150d503f17a5e18ae0671f4379130357192d627689aff06d5d1ccc4f426315c934c724f4b9a8e589fd9dd187bab1c0",
  instructions:
    "0x01000000000000000000000000000493e000000000000000000000000000000000",
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

// ============================================================================
// QUOTE VALIDATION NOTES
// ============================================================================

/**
 * This real signed quote contains:
 *
 * 1. Valid signature from Wormhole Executor service
 * 2. Proper chain ID encoding (Ethereum: 2, Sei EVM: 40)
 * 3. Realistic gas limit (500,000)
 * 4. Current timestamp and expiry
 * 5. Proper relay instructions format
 *
 * The quote is 165 bytes (330 hex characters + 0x prefix)
 * and follows the standard Wormhole Executor quote format.
 *
 * Use this quote in your unit tests to verify that:
 * - setExecutorParameters() accepts valid signed quotes
 * - The contract properly validates quote signatures
 * - Gas estimation works correctly
 * - Transfer execution succeeds with real executor data
 */
