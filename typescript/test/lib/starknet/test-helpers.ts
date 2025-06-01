import { expect } from "chai"

/**
 * Common error messages used in StarkNet tests
 */
export const STARKNET_ERROR_MESSAGES = {
  NO_CHAIN_IDENTIFIER:
    "StarkNet depositor interface has no chain identifier. " +
    "Deposits are handled via L1 StarkNet Bitcoin Depositor.",
  CANNOT_INITIALIZE:
    "Cannot initialize deposit via StarkNet interface. " +
    "Use L1 StarkNet Bitcoin Depositor instead.",
  MUST_BE_STARKNET_ADDRESS: "Deposit owner must be a StarkNet address",
  TOKEN_NO_CHAIN:
    "StarkNet TBTC token interface has no chain identifier. " +
    "Token operations are not supported on StarkNet yet.",
  CANNOT_GET_BALANCE:
    "Cannot get balance via StarkNet interface. " +
    "Token operations are not supported on StarkNet yet.",
  ADDRESS_MUST_BE_STARKNET: "Address must be a StarkNet address",
  INVALID_ADDRESS_FORMAT: "Invalid StarkNet address format",
  ADDRESS_EXCEEDS_FIELD_SIZE:
    "StarkNet address exceeds maximum field element size",
}

/**
 * Test addresses for StarkNet tests
 */
export const TEST_ADDRESSES = {
  valid: [
    "0x0",
    "0x1",
    "0xabcdef",
    "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  ],
  maxFieldElement: "0x" + "f".repeat(63),
  tooLong: "0x" + "f".repeat(65),
  invalid: [
    "xyz123", // Invalid hex
    "0xG123", // Invalid hex char
    "", // Empty string
  ],
  ethereum: "0x1234567890123456789012345678901234567890",
}

/**
 * Creates a mock Bitcoin deposit transaction for testing
 * @returns Mock deposit transaction object
 */
export function createMockDepositTx(): any {
  return {
    version: "0x" as any,
    inputs: "0x" as any,
    outputs: "0x" as any,
    locktime: "0x" as any,
  }
}

/**
 * Creates a mock deposit receipt for testing
 * @returns Mock deposit object
 */
export function createMockDeposit(): any {
  return {
    depositor: {
      identifierHex: "0x742d35Cc6634C0532925a3b844Bc9e7595f7FACE",
    } as any,
    walletPublicKeyHash: "0x1234567890abcdef1234567890abcdef12345678" as any,
    refundPublicKeyHash: "0xabcdef1234567890abcdef1234567890abcdef12" as any,
    blindingFactor: "0x0123456789abcdef" as any,
    refundLocktime: "0x60000000" as any,
    extraData: ("0x" + "00".repeat(32)) as any,
  }
}

/**
 * Helper to test that all promises reject with the expected error
 * @param promises Array of promises to test
 * @param expectedError Expected error message
 * @returns Promise that resolves when all assertions are complete
 */
export async function expectAllToRejectWith<T>(
  promises: Promise<T>[],
  expectedError: string
): Promise<void> {
  await expect(Promise.all(promises)).to.be.rejected

  for (const promise of promises) {
    await expect(promise).to.be.rejectedWith(expectedError)
  }
}

/**
 * Helper to test multiple invalid addresses
 * @param invalidAddresses Array of invalid addresses to test
 * @param operation Function to test with each invalid address
 * @returns Promise that resolves when all tests are complete
 */
export async function testInvalidAddresses(
  invalidAddresses: string[],
  operation: (addr: string) => Promise<any> | any
): Promise<void> {
  for (const invalid of invalidAddresses) {
    if (operation.constructor.name === "AsyncFunction") {
      await expect(operation(invalid)).to.be.rejected
    } else {
      expect(() => operation(invalid)).to.throw()
    }
  }
}
