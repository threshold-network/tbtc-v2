import { expect } from "chai"
import { EthereumL1BitcoinDepositor } from "../../../src/lib/ethereum/l1-bitcoin-depositor"
import { Chains } from "../../../src/lib/contracts"
import { StarkNetAddress } from "../../../src/lib/starknet"
import { StarkNetCrossChainExtraDataEncoder } from "../../../src/lib/starknet"
import { Hex } from "../../../src/lib/utils"
import { MockProvider } from "@ethereum-waffle/provider"
import { Wallet } from "ethers"

describe("EthereumL1BitcoinDepositor - StarkNet Support", () => {
  let provider: MockProvider
  let signer: Wallet

  beforeEach(async () => {
    provider = new MockProvider()
    ;[signer] = provider.getWallets()
  })

  describe("artifact loader", () => {
    it("should support StarkNet for mainnet", () => {
      const depositor = new EthereumL1BitcoinDepositor(
        { signerOrProvider: signer },
        Chains.Ethereum.Mainnet,
        "StarkNet"
      )
      expect(depositor).to.exist
    })

    it("should support StarkNet for sepolia", () => {
      const depositor = new EthereumL1BitcoinDepositor(
        { signerOrProvider: signer },
        Chains.Ethereum.Sepolia,
        "StarkNet"
      )
      expect(depositor).to.exist
    })

    it("should throw error for unsupported L2 chain on mainnet", () => {
      expect(
        () =>
          new EthereumL1BitcoinDepositor(
            { signerOrProvider: signer },
            Chains.Ethereum.Mainnet,
            "UnsupportedChain" as any
          )
      ).to.throw("Unsupported L2 chain")
    })

    it("should throw error for unsupported L2 chain on sepolia", () => {
      expect(
        () =>
          new EthereumL1BitcoinDepositor(
            { signerOrProvider: signer },
            Chains.Ethereum.Sepolia,
            "UnsupportedChain" as any
          )
      ).to.throw("Unsupported L2 chain")
    })
  })

  describe("StarkNet extra data encoder", () => {
    let depositor: EthereumL1BitcoinDepositor

    beforeEach(() => {
      depositor = new EthereumL1BitcoinDepositor(
        { signerOrProvider: signer },
        Chains.Ethereum.Sepolia,
        "StarkNet"
      )
    })

    it("should use StarkNetCrossChainExtraDataEncoder for StarkNet", () => {
      const encoder = depositor.extraDataEncoder()
      expect(encoder).to.be.instanceOf(StarkNetCrossChainExtraDataEncoder)
    })

    it("should properly encode StarkNet addresses", () => {
      const encoder = depositor.extraDataEncoder()
      const starknetAddress = StarkNetAddress.from("0x123abc")
      const encoded = encoder.encodeDepositOwner(starknetAddress)

      expect(encoded.toPrefixedString()).to.equal(
        "0x0000000000000000000000000000000000000000000000000000000000123abc"
      )
    })

    it("should properly decode StarkNet addresses", () => {
      const encoder = depositor.extraDataEncoder()
      const extraData = Hex.from(
        "0x0000000000000000000000000000000000000000000000000000000000123abc"
      )
      const decoded = encoder.decodeDepositOwner(extraData)

      expect(decoded).to.be.instanceOf(StarkNetAddress)
      expect(decoded.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000000000000000123abc"
      )
    })
  })

  describe("initializeDeposit with StarkNet", () => {
    it("should verify StarkNet encoder is used when L2 chain is StarkNet", () => {
      const depositor = new EthereumL1BitcoinDepositor(
        { signerOrProvider: signer },
        Chains.Ethereum.Sepolia,
        "StarkNet"
      )

      const encoder = depositor.extraDataEncoder()
      expect(encoder).to.be.instanceOf(StarkNetCrossChainExtraDataEncoder)

      // Test that it can encode/decode StarkNet addresses
      const starknetAddress = StarkNetAddress.from("0xabcdef")
      const encoded = encoder.encodeDepositOwner(starknetAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded).to.be.instanceOf(StarkNetAddress)
      expect(decoded.equals(starknetAddress)).to.be.true
    })
  })
})
