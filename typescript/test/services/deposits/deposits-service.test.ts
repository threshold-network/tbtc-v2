import { expect } from "chai"
import * as sinon from "sinon"
import { DepositsService } from "../../../src/services/deposits/deposits-service"
import { TBTCContracts, DepositReceipt } from "../../../src/lib/contracts"
import { BitcoinClient, BitcoinTxHash } from "../../../src/lib/bitcoin"
import { Hex } from "../../../src/lib/utils"

describe("DepositsService - Chain Type Classification", () => {
  describe("isEVML2Chain", () => {
    let depositsService: DepositsService

    beforeEach(() => {
      // Create minimal DepositsService instance with mock dependencies
      // Note: We only need the service instance to test the private method
      const mockTBTCContracts = {} as TBTCContracts
      const mockBitcoinClient = {} as BitcoinClient
      const mockCrossChainContracts = () => undefined

      depositsService = new DepositsService(
        mockTBTCContracts,
        mockBitcoinClient,
        mockCrossChainContracts
      )
    })

    it("should return true for Arbitrum (EVM L2)", () => {
      // Access private method using bracket notation
      const result = (depositsService as any)["isEVML2Chain"]("Arbitrum")
      expect(result).to.be.true
    })

    it("should return true for Base (EVM L2)", () => {
      const result = (depositsService as any)["isEVML2Chain"]("Base")
      expect(result).to.be.true
    })

    it("should return false for Sui (non-EVM L2)", () => {
      const result = (depositsService as any)["isEVML2Chain"]("Sui")
      expect(result).to.be.false
    })

    it("should return false for StarkNet (non-EVM L2)", () => {
      const result = (depositsService as any)["isEVML2Chain"]("StarkNet")
      expect(result).to.be.false
    })

    it("should handle case-insensitive matching (arbitrum lowercase)", () => {
      const result = (depositsService as any)["isEVML2Chain"]("arbitrum")
      expect(result).to.be.true
    })
  })
})

describe("DepositsService - buildGaslessRelayPayload Owner Extraction", () => {
  let depositsService: DepositsService
  let mockBitcoinClient: any
  let mockTBTCContracts: any

  // Test data constants
  const MOCK_32_BYTE_EXTRA_DATA = Hex.from(
    "0x000000000000000000000000742d35Cc6634C0532925a3b844Bc9e7eb1bfFFFF"
  )
  const MOCK_32_BYTE_EXTRA_DATA_2 = Hex.from(
    "0x000000000000000000000000A1B2C3D4E5F67890A1B2C3D4E5F67890A1B2C3D4"
  )
  const MOCK_20_BYTE_EXTRA_DATA = Hex.from(
    "0x742d35Cc6634C0532925a3b844Bc9e7eb1bfFFFF"
  )
  const MOCK_INVALID_EXTRA_DATA = Hex.from(
    "0x742d35Cc6634C0532925a3b844Bc9e7eb1bfFFFF1234"
  ) // 44 hex chars = 22 bytes (invalid length for testing)

  const MOCK_BITCOIN_TX_HASH = BitcoinTxHash.from(
    "3ca4ae3f8ee3b48949192bc7a146c8d9862267816258c85e02a44678364551e1"
  )

  const MOCK_VAULT_ADDRESS = "1234567890abcdef1234567890abcdef12345678"

  beforeEach(() => {
    // Mock Bitcoin client
    // Valid Bitcoin transaction hex (taken from test data)
    const mockBitcoinTxHex =
      "0100000001" +
      "26847a3c22a8a87a16195b0c45f7a14dd309afb3804edc1b68cd33719d89dd4c" +
      "00000000c9483045022100d0e9c2e38db714c29c6b48eaf6369adb4b33fbc73fe63fbc03d28bebf3a41122022051bdfd31829571b69b788f84defcb256a7de7db3b7bdb2356100ccfd1c16378f012103989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d94c5c14934b98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576a9148db50eb52063ea9d98b3eac91489a90f738986f68763ac6776a914e257eccafbc07c381642ce6e7e55120fb077fbed880448f2b262b175ac68ffffffff01" +
      "58340000000000001976a9148db50eb52063ea9d98b3eac91489a90f738986f688ac00000000"

    mockBitcoinClient = {
      getRawTransaction: sinon.stub().resolves({
        transactionHex: mockBitcoinTxHex,
      }),
    }

    // Mock TBTC contracts
    mockTBTCContracts = {
      tbtcVault: {
        getChainIdentifier: () => ({
          identifierHex: MOCK_VAULT_ADDRESS,
        }),
      },
    }

    // Create service instance
    depositsService = new DepositsService(
      mockTBTCContracts as TBTCContracts,
      mockBitcoinClient as BitcoinClient,
      () => undefined
    )
  })

  afterEach(() => {
    sinon.restore()
  })

  describe("EVM L2 Chains (Arbitrum, Base)", () => {
    it("should extract 20-byte address from 32-byte extraData for Arbitrum", async () => {
      const receipt: DepositReceipt = {
        depositor: {
          identifierHex: "1234567890abcdef1234567890abcdef12345678",
          equals: () => false,
        },
        blindingFactor: Hex.from("f9f0c90d00039523"),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        refundLocktime: Hex.from("60bcea61"),
        extraData: MOCK_32_BYTE_EXTRA_DATA,
      }

      const result = await depositsService.buildGaslessRelayPayload(
        receipt,
        MOCK_BITCOIN_TX_HASH,
        0,
        "Arbitrum"
      )

      // Expected: Extract last 20 bytes from 32-byte extraData
      expect(result.destinationChainDepositOwner.toLowerCase()).to.equal(
        "0x742d35Cc6634C0532925a3b844Bc9e7eb1bfFFFF".toLowerCase()
      )
    })

    it("should extract 20-byte address from 32-byte extraData for Base", async () => {
      const receipt: DepositReceipt = {
        depositor: {
          identifierHex: "1234567890abcdef1234567890abcdef12345678",
          equals: () => false,
        },
        blindingFactor: Hex.from("f9f0c90d00039523"),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        refundLocktime: Hex.from("60bcea61"),
        extraData: MOCK_32_BYTE_EXTRA_DATA_2,
      }

      const result = await depositsService.buildGaslessRelayPayload(
        receipt,
        MOCK_BITCOIN_TX_HASH,
        0,
        "Base"
      )

      // Expected: Extract last 20 bytes from 32-byte extraData
      expect(result.destinationChainDepositOwner.toLowerCase()).to.equal(
        "0xA1B2C3D4E5F67890A1B2C3D4E5F67890A1B2C3D4".toLowerCase()
      )
    })

    it("should use 20-byte extraData directly without extraction for EVM L2", async () => {
      const receipt: DepositReceipt = {
        depositor: {
          identifierHex: "1234567890abcdef1234567890abcdef12345678",
          equals: () => false,
        },
        blindingFactor: Hex.from("f9f0c90d00039523"),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        refundLocktime: Hex.from("60bcea61"),
        extraData: MOCK_20_BYTE_EXTRA_DATA,
      }

      const result = await depositsService.buildGaslessRelayPayload(
        receipt,
        MOCK_BITCOIN_TX_HASH,
        0,
        "Arbitrum"
      )

      // Expected: Use 20-byte extraData as-is
      expect(result.destinationChainDepositOwner.toLowerCase()).to.equal(
        "0x742d35Cc6634C0532925a3b844Bc9e7eb1bfFFFF".toLowerCase()
      )
    })

    it("should throw error for invalid extraData length (not 20 or 32 bytes)", async () => {
      const receipt: DepositReceipt = {
        depositor: {
          identifierHex: "1234567890abcdef1234567890abcdef12345678",
          equals: () => false,
        },
        blindingFactor: Hex.from("f9f0c90d00039523"),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        refundLocktime: Hex.from("60bcea61"),
        extraData: MOCK_INVALID_EXTRA_DATA,
      }

      await expect(
        depositsService.buildGaslessRelayPayload(
          receipt,
          MOCK_BITCOIN_TX_HASH,
          0,
          "Base"
        )
      ).to.be.rejectedWith(
        "Invalid extraData length for EVM L2 deposit owner: received 22 bytes, expected 20 or 32 bytes."
      )
    })
  })

  describe("Non-EVM L2 Chains (Sui, StarkNet)", () => {
    it("should use full 32-byte extraData for Sui without extraction", async () => {
      const receipt: DepositReceipt = {
        depositor: {
          identifierHex: "1234567890abcdef1234567890abcdef12345678",
          equals: () => false,
        },
        blindingFactor: Hex.from("f9f0c90d00039523"),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        refundLocktime: Hex.from("60bcea61"),
        extraData: MOCK_32_BYTE_EXTRA_DATA,
      }

      const result = await depositsService.buildGaslessRelayPayload(
        receipt,
        MOCK_BITCOIN_TX_HASH,
        0,
        "Sui"
      )

      // Expected: Use full 32-byte extraData without extraction
      expect(result.destinationChainDepositOwner).to.equal(
        MOCK_32_BYTE_EXTRA_DATA.toPrefixedString()
      )
    })

    it("should use full 32-byte extraData for StarkNet without extraction", async () => {
      const receipt: DepositReceipt = {
        depositor: {
          identifierHex: "1234567890abcdef1234567890abcdef12345678",
          equals: () => false,
        },
        blindingFactor: Hex.from("f9f0c90d00039523"),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        refundLocktime: Hex.from("60bcea61"),
        extraData: MOCK_32_BYTE_EXTRA_DATA_2,
      }

      const result = await depositsService.buildGaslessRelayPayload(
        receipt,
        MOCK_BITCOIN_TX_HASH,
        0,
        "StarkNet"
      )

      // Expected: Use full 32-byte extraData without extraction
      expect(result.destinationChainDepositOwner).to.equal(
        MOCK_32_BYTE_EXTRA_DATA_2.toPrefixedString()
      )
    })

    it("should throw error if extraData is not exactly 32 bytes for Sui", async () => {
      const receipt: DepositReceipt = {
        depositor: {
          identifierHex: "1234567890abcdef1234567890abcdef12345678",
          equals: () => false,
        },
        blindingFactor: Hex.from("f9f0c90d00039523"),
        walletPublicKeyHash: Hex.from(
          "8db50eb52063ea9d98b3eac91489a90f738986f6"
        ),
        refundPublicKeyHash: Hex.from(
          "28e081f285138ccbe389c1eb8985716230129f89"
        ),
        refundLocktime: Hex.from("60bcea61"),
        extraData: MOCK_20_BYTE_EXTRA_DATA,
      }

      await expect(
        depositsService.buildGaslessRelayPayload(
          receipt,
          MOCK_BITCOIN_TX_HASH,
          0,
          "Sui"
        )
      ).to.be.rejectedWith(
        "Sui requires 32-byte extraData for deposit owner, got 20 bytes."
      )
    })
  })
})
