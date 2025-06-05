import { expect } from "chai"

/**
 * Common error messages used in StarkNet tests
 */
export const STARKNET_ERROR_MESSAGES = {
  NO_CHAIN_IDENTIFIER:
    "StarkNet depositor has no chain identifier. " +
    "Deposits are handled via L1 StarkNet Bitcoin Depositor.",
  CANNOT_INITIALIZE:
    "Cannot initialize deposit via StarkNet depositor. " +
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
  const { Hex } = require("../../../src/lib/utils")
  return {
    version: Hex.from("0x02000000"),
    inputs: Hex.from("0x0101234567890abcdef01234567890abcdef"),
    outputs: Hex.from("0x01fedcba098765432101fedcba0987654321"),
    locktime: Hex.from("0x00000000"),
  }
}

/**
 * Creates a mock deposit receipt for testing
 * @returns Mock deposit object
 */
export function createMockDeposit(): any {
  const { Hex } = require("../../../src/lib/utils")
  const { EthereumAddress } = require("../../../src/lib/ethereum/address")
  return {
    depositor: EthereumAddress.from(
      "0x82883a4c7a8dd73ef165deb402d432613615ced4"
    ),
    walletPublicKeyHash: Hex.from("0x1234567890abcdef1234567890abcdef12345678"),
    refundPublicKeyHash: Hex.from("0xabcdef1234567890abcdef1234567890abcdef12"),
    blindingFactor: Hex.from("0x0123456789abcdef"),
    refundLocktime: Hex.from("0x60000000"),
    extraData: Hex.from("0x" + "00".repeat(32)),
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

/**
 * Creates a mock StarkNet provider for testing
 * @returns Mock provider object
 */
export function createMockProvider(): any {
  return {
    // Mock Provider methods
    getChainId: () => Promise.resolve("SN_MAIN"),
    callContract: () => Promise.resolve({ result: ["0x123"] }),
    getBalance: () => Promise.resolve({ balance: 1000n }),

    // Mock Account methods (some providers are Accounts)
    address: "0x123456789abcdef",
    signer: {},

    // Provider identification
    provider: "mock-provider",
    nodeUrl: "https://mock-starknet-node.com",
  }
}

/**
 * Creates a mock StarkNet provider with sinon stubs for testing
 * @returns Mock provider object with stubbed methods
 */
export function createMockStarkNetProvider(): any {
  const sinon = require("sinon")
  return {
    // Mock Provider methods as stubs
    getChainId: sinon.stub().resolves("SN_MAIN"),
    callContract: sinon.stub().resolves({ result: ["0x123"] }),
    getBalance: sinon.stub().resolves({ balance: 1000n }),
    getTransactionReceipt: sinon.stub().resolves({ status: "ACCEPTED" }),
    waitForTransaction: sinon.stub().resolves({ status: "ACCEPTED" }),

    // Mock Account methods (some providers are Accounts)
    address: "0x123456789abcdef",
    signer: {},

    // Provider identification
    provider: "mock-provider",
    nodeUrl: "https://mock-starknet-node.com",
  }
}
