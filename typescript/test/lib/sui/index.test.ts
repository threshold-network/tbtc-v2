import { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import chai from "chai"
import sinon from "sinon"

chai.use(chaiAsPromised)
import {
  loadSuiCrossChainInterfaces,
  SuiError,
  SuiBitcoinDepositor,
  SuiTBTCToken,
} from "../../../src/lib/sui"
import { Chains } from "../../../src/lib/contracts"

describe("SUI Module Index", () => {
  describe("loadSuiCrossChainInterfaces", () => {
    let mockSigner: any
    let consoleWarnStub: sinon.SinonStub

    beforeEach(() => {
      // Stub console.warn
      consoleWarnStub = sinon.stub(console, "warn")

      // Mock signer
      mockSigner = {
        signAndExecuteTransaction: sinon.stub(),
        address: "0x" + "1".repeat(64),
      }
    })

    afterEach(() => {
      sinon.restore()
    })

    it.skip("should load interfaces for testnet", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      const result = await loadSuiCrossChainInterfaces(
        mockSigner,
        Chains.Sui.Testnet
      )

      expect(result).to.have.property("destinationChainBitcoinDepositor")
      expect(result).to.have.property("destinationChainTbtcToken")

      expect(result.destinationChainBitcoinDepositor).to.be.instanceOf(
        SuiBitcoinDepositor
      )
      expect(result.destinationChainTbtcToken).to.be.instanceOf(SuiTBTCToken)
    })

    it.skip("should use correct network URL for testnet", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      await loadSuiCrossChainInterfaces(mockSigner, Chains.Sui.Testnet)

      // Verify rate limit warning was shown
      expect(consoleWarnStub.calledOnce).to.be.true
      expect(consoleWarnStub.getCall(0).args[0]).to.include("rate-limited")
    })

    it.skip("should use correct network URL for devnet", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      await loadSuiCrossChainInterfaces(mockSigner, Chains.Sui.Devnet)

      // Verify rate limit warning was shown
      expect(consoleWarnStub.calledOnce).to.be.true
      expect(consoleWarnStub.getCall(0).args[0]).to.include("rate-limited")
    })

    it("should load mainnet configuration successfully", async () => {
      const result = await loadSuiCrossChainInterfaces(
        mockSigner,
        Chains.Sui.Mainnet
      )

      expect(result).to.have.property("destinationChainBitcoinDepositor")
      expect(result).to.have.property("destinationChainTbtcToken")
    })

    it.skip("should handle keypair signer", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      const keypairSigner = {
        getPublicKey: () => ({
          toSuiAddress: () => "0x" + "4".repeat(64),
        }),
        address: "0x" + "4".repeat(64),
      }

      const result = await loadSuiCrossChainInterfaces(
        keypairSigner,
        Chains.Sui.Testnet
      )

      expect(result.destinationChainBitcoinDepositor).to.exist
    })

    it.skip("should handle signer with getAddress method", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      const signerWithGetAddress = {
        signAndExecuteTransaction: sinon.stub(),
        getAddress: sinon.stub().resolves("0x" + "3".repeat(64)),
      }

      const result = await loadSuiCrossChainInterfaces(
        signerWithGetAddress,
        Chains.Sui.Testnet
      )

      expect(signerWithGetAddress.getAddress.calledOnce).to.be.true
      expect(result.destinationChainBitcoinDepositor).to.exist
    })

    it.skip("should handle SDK import failure", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      // importStub.rejects(new Error("Module not found"))

      await expect(
        loadSuiCrossChainInterfaces(mockSigner, Chains.Sui.Testnet)
      ).to.be.rejectedWith(
        SuiError,
        "Failed to load SUI SDK. Please ensure @mysten/sui is installed."
      )
    })

    it.skip("should throw if signer address cannot be determined", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      const invalidSigner = {
        signAndExecuteTransaction: sinon.stub(),
        // No address, no getAddress method
      }

      await expect(
        loadSuiCrossChainInterfaces(invalidSigner as any, Chains.Sui.Testnet)
      ).to.be.rejectedWith(SuiError, "Failed to get signer address")
    })

    it.skip("should handle short addresses by padding", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      const signerWithShortAddress = {
        signAndExecuteTransaction: sinon.stub(),
        address: "0x123", // Short address
      }

      const result = await loadSuiCrossChainInterfaces(
        signerWithShortAddress,
        Chains.Sui.Testnet
      )

      // Should pad the address to 64 characters
      const depositor = result.destinationChainBitcoinDepositor
      const owner = depositor.getDepositOwner()
      expect(owner?.identifierHex).to.have.length(64)
      expect(owner?.identifierHex).to.match(/^0+123$/)
    })

    it.skip("should handle addresses without 0x prefix", async () => {
      // Skipping: Dynamic import mocking not supported in test environment
      const signerWithUnprefixedAddress = {
        signAndExecuteTransaction: sinon.stub(),
        address: "a".repeat(64),
      }

      const result = await loadSuiCrossChainInterfaces(
        signerWithUnprefixedAddress,
        Chains.Sui.Testnet
      )

      const depositor = result.destinationChainBitcoinDepositor
      const owner = depositor.getDepositOwner()
      expect(owner?.identifierHex).to.equal("a".repeat(64))
    })
  })

  describe("loadSuiCrossChainContracts (deprecated alias)", () => {
    it("should be available for backward compatibility", () => {
      // Import is synchronous here since we're not using dynamic import
      const sui = require("../../../src/lib/sui")
      expect(sui.loadSuiCrossChainContracts).to.equal(
        loadSuiCrossChainInterfaces
      )
    })
  })
})
