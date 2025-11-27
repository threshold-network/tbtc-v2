import { expect } from "chai"
import {
  SeiAddress,
  SeiExtraDataEncoder,
  SeiBitcoinDepositor,
  SeiTBTCToken,
  SeiProvider,
  SeiSigner,
} from "../../../src/lib/sei"
import { Chains } from "../../../src/lib/contracts"
import { MockProvider } from "@ethereum-waffle/provider"

describe("Sei Module", () => {
  describe("module exports", () => {
    it("should export SeiAddress", () => {
      expect(SeiAddress).to.exist
      expect(SeiAddress).to.be.a("function")
    })

    it("should export SeiExtraDataEncoder", () => {
      expect(SeiExtraDataEncoder).to.exist
      expect(SeiExtraDataEncoder).to.be.a("function")
    })

    it("should export SeiBitcoinDepositor", () => {
      expect(SeiBitcoinDepositor).to.exist
      expect(SeiBitcoinDepositor).to.be.a("function")
    })

    it("should export SeiTBTCToken", () => {
      expect(SeiTBTCToken).to.exist
      expect(SeiTBTCToken).to.be.a("function")
    })

    it("should export SeiProvider type", () => {
      // Type check - if this compiles, the type is exported
      const provider: SeiProvider = new MockProvider().getWallets()[0]
        .provider as any
      expect(provider).to.exist
    })

    it("should export SeiSigner type", () => {
      // Type check - if this compiles, the type is exported
      const signer: SeiSigner = new MockProvider().getWallets()[0] as any
      expect(signer).to.exist
    })
  })

  describe("SeiAddress usage", () => {
    it("should create SeiAddress from valid address", () => {
      const address = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      expect(address).to.be.instanceOf(SeiAddress)
      expect(address.toString()).to.equal(
        "0x1234567890123456789012345678901234567890"
      )
    })
  })

  describe("SeiExtraDataEncoder usage", () => {
    it("should encode and decode Sei address", () => {
      const encoder = new SeiExtraDataEncoder()
      const address = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )

      const encoded = encoder.encodeDepositOwner(address)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded.equals(address)).to.be.true
    })
  })

  describe("SeiBitcoinDepositor usage", () => {
    it("should create SeiBitcoinDepositor instance", () => {
      const mockProvider = new MockProvider().getWallets()[0].provider
      const config = { chainId: "1328" }
      const depositor = new SeiBitcoinDepositor(
        config,
        "Sei",
        mockProvider as any
      )

      expect(depositor).to.exist
      expect(depositor.getChainName()).to.equal("Sei")
    })
  })

  describe("SeiTBTCToken usage", () => {
    it("should create SeiTBTCToken instance", () => {
      const mockProvider = new MockProvider().getWallets()[0]
      const token = new SeiTBTCToken(
        {
          address: "0x1234567890123456789012345678901234567890",
          signerOrProvider: mockProvider,
        },
        Chains.Sei.Testnet
      )

      expect(token).to.exist
    })
  })
})
