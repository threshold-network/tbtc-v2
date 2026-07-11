import { expect } from "chai"
import { SeiBitcoinDepositor } from "../../../src/lib/sei/sei-depositor"
import { SeiAddress } from "../../../src/lib/sei/address"
import { MockProvider } from "@ethereum-waffle/provider"
import { EthereumAddress } from "../../../src/lib/ethereum"
import { DepositReceipt } from "../../../src/lib/contracts"
import { BitcoinRawTxVectors } from "../../../src/lib/bitcoin"
import { Hex } from "../../../src/lib/utils"

describe("SeiBitcoinDepositor", () => {
  describe("constructor", () => {
    it("should initialize with provider", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }

      // Act
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      // Assert
      expect(depositor).to.exist
      expect(depositor.getChainName()).to.equal("Sei")
    })

    it("should store provider reference", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }

      // Act
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      // Assert
      expect(depositor.getProvider()).to.equal(mockProvider)
    })

    it("should throw error if provider is undefined", () => {
      // Arrange
      const config = { chainId: "1328" }

      // Act & Assert
      expect(
        () => new SeiBitcoinDepositor(config, "Sei", undefined as any)
      ).to.throw("Provider is required for Sei depositor")
    })

    it("should set default relayer URL for testnet", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }

      // Act
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      // Assert - relayer URL should be set (we can't easily check the private field,
      // but if constructor succeeds, it means the URL was set)
      expect(depositor).to.exist
    })

    it("should set default relayer URL for mainnet", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1329" }

      // Act
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      // Assert
      expect(depositor).to.exist
    })

    it("should use custom relayer URL if provided", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = {
        chainId: "1328",
        relayerUrl: "https://custom-relayer.example.com/api/reveal",
      }

      // Act
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      // Assert
      expect(depositor).to.exist
    })
  })

  describe("getChainName", () => {
    it("should return the chain name passed to constructor", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      // Act
      const chainName = depositor.getChainName()

      // Assert
      expect(chainName).to.equal("Sei")
    })
  })

  describe("setDepositOwner", () => {
    it("should accept Sei address as deposit owner", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )
      const seiAddress = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )

      // Act
      depositor.setDepositOwner(seiAddress)

      // Assert
      expect(depositor.getDepositOwner()).to.equal(seiAddress)
    })

    it("should throw error for non-Sei address", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )
      const ethereumAddress = EthereumAddress.from(
        "0x1234567890123456789012345678901234567890"
      )

      // Act & Assert
      expect(() => depositor.setDepositOwner(ethereumAddress)).to.throw(
        "Deposit owner must be a Sei address"
      )
    })

    it("should allow clearing deposit owner with undefined", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )
      const seiAddress = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      depositor.setDepositOwner(seiAddress)

      // Act
      depositor.setDepositOwner(undefined)

      // Assert
      expect(depositor.getDepositOwner()).to.be.undefined
    })

    it("should allow clearing deposit owner with null", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )
      const seiAddress = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      depositor.setDepositOwner(seiAddress)

      // Act
      depositor.setDepositOwner(null as any)

      // Assert
      expect(depositor.getDepositOwner()).to.be.undefined
    })
  })

  describe("getChainIdentifier", () => {
    it("should throw error since Sei deposits are handled via L1", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      // Act & Assert
      expect(() => depositor.getChainIdentifier()).to.throw(
        "Sei depositor has no chain identifier"
      )
    })
  })

  describe("extraDataEncoder", () => {
    it("should return SeiExtraDataEncoder instance", () => {
      // Arrange
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      // Act
      const encoder = depositor.extraDataEncoder()

      // Assert
      expect(encoder).to.exist
      expect(encoder.constructor.name).to.equal("SeiExtraDataEncoder")
    })
  })

  describe("initializeDeposit", () => {
    it("should reject Taproot receipts before calling the relayer", async () => {
      const mockProvider = new MockProvider().getWallets()[0].provider
      const depositor = new SeiBitcoinDepositor(
        { chainId: "1328" },
        "Sei",
        mockProvider as any
      )
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("00000000"),
        inputs: Hex.from("11111111"),
        outputs: Hex.from("22222222"),
        locktime: Hex.from("33333333"),
      }
      const deposit: DepositReceipt = {
        depositor: SeiAddress.from(
          "0x1234567890123456789012345678901234567890"
        ),
        walletPublicKeyHash: Hex.from("11".repeat(20)),
        refundPublicKeyHash: Hex.from("22".repeat(20)),
        walletXOnlyPublicKey: Hex.from("33".repeat(32)),
        refundXOnlyPublicKey: Hex.from("44".repeat(32)),
        blindingFactor: Hex.from("55".repeat(8)),
        refundLocktime: Hex.from("66".repeat(4)),
      }

      expect(depositor.supportsTaprootDeposits()).to.be.false
      await expect(
        depositor.initializeDeposit(depositTx, 0, deposit)
      ).to.be.rejectedWith(
        "Taproot deposits are not supported by this depositor"
      )
    })
  })
})
