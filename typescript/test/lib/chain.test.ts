import { expect } from "chai"
import {
  Chains,
  L2Chain,
  ChainMapping,
  ChainMappings,
} from "../../src/lib/contracts/chain"

describe("Chain definitions", () => {
  describe("StarkNet chain enum", () => {
    it("should define StarkNet enum with Mainnet value", () => {
      expect(Chains.StarkNet).to.exist
      expect(Chains.StarkNet.Mainnet).to.equal("0x534e5f4d41494e")
    })

    it("should define StarkNet enum with Sepolia value", () => {
      expect(Chains.StarkNet).to.exist
      expect(Chains.StarkNet.Sepolia).to.equal("0x534e5f5345504f4c4941")
    })

    it("should have correct hex values for StarkNet chain identifiers", () => {
      // SN_MAIN in hex
      expect(Chains.StarkNet.Mainnet).to.equal("0x534e5f4d41494e")
      // SN_SEPOLIA in hex
      expect(Chains.StarkNet.Sepolia).to.equal("0x534e5f5345504f4c4941")
    })
  })

  describe("L2Chain type", () => {
    it("should include StarkNet as a valid L2Chain", () => {
      const validL2Chain: L2Chain = "StarkNet"
      expect(validL2Chain).to.equal("StarkNet")
    })

    it("should allow Base, Arbitrum, and StarkNet as L2Chain values", () => {
      const baseChain: L2Chain = "Base"
      const arbitrumChain: L2Chain = "Arbitrum"
      const starkNetChain: L2Chain = "StarkNet"

      expect(baseChain).to.equal("Base")
      expect(arbitrumChain).to.equal("Arbitrum")
      expect(starkNetChain).to.equal("StarkNet")
    })
  })

  describe("ChainMapping type", () => {
    it("should include starknet property in ChainMapping", () => {
      const mapping: ChainMapping = {
        ethereum: Chains.Ethereum.Mainnet,
        base: Chains.Base.Base,
        arbitrum: Chains.Arbitrum.Arbitrum,
        starknet: Chains.StarkNet.Mainnet,
      }

      expect(mapping.starknet).to.equal(Chains.StarkNet.Mainnet)
    })

    it("should allow optional starknet property", () => {
      const mapping: ChainMapping = {
        ethereum: Chains.Ethereum.Mainnet,
        base: Chains.Base.Base,
      }

      expect(mapping.starknet).to.be.undefined
    })
  })

  describe("ChainMappings array", () => {
    it("should include StarkNet Mainnet mapping", () => {
      const mainnetMapping = ChainMappings.find(
        (mapping) => mapping.ethereum === Chains.Ethereum.Mainnet
      )

      expect(mainnetMapping).to.exist
      expect(mainnetMapping?.starknet).to.equal(Chains.StarkNet.Mainnet)
    })

    it("should include StarkNet Sepolia mapping", () => {
      const sepoliaMapping = ChainMappings.find(
        (mapping) => mapping.ethereum === Chains.Ethereum.Sepolia
      )

      expect(sepoliaMapping).to.exist
      expect(sepoliaMapping?.starknet).to.equal(Chains.StarkNet.Sepolia)
    })

    it("should maintain existing chain mappings", () => {
      const mainnetMapping = ChainMappings.find(
        (mapping) => mapping.ethereum === Chains.Ethereum.Mainnet
      )

      expect(mainnetMapping?.ethereum).to.equal(Chains.Ethereum.Mainnet)
      expect(mainnetMapping?.base).to.equal(Chains.Base.Base)
      expect(mainnetMapping?.arbitrum).to.equal(Chains.Arbitrum.Arbitrum)

      const sepoliaMapping = ChainMappings.find(
        (mapping) => mapping.ethereum === Chains.Ethereum.Sepolia
      )

      expect(sepoliaMapping?.ethereum).to.equal(Chains.Ethereum.Sepolia)
      expect(sepoliaMapping?.base).to.equal(Chains.Base.BaseSepolia)
      expect(sepoliaMapping?.arbitrum).to.equal(Chains.Arbitrum.ArbitrumSepolia)
    })
  })

  describe("Existing chain functionality", () => {
    it("should maintain all existing Ethereum chain values", () => {
      expect(Chains.Ethereum.Mainnet).to.equal("1")
      expect(Chains.Ethereum.Sepolia).to.equal("11155111")
      expect(Chains.Ethereum.Local).to.equal("1101")
    })

    it("should maintain all existing Base chain values", () => {
      expect(Chains.Base.Base).to.equal("8453")
      expect(Chains.Base.BaseSepolia).to.equal("84532")
    })

    it("should maintain all existing Arbitrum chain values", () => {
      expect(Chains.Arbitrum.Arbitrum).to.equal("42161")
      expect(Chains.Arbitrum.ArbitrumSepolia).to.equal("421614")
    })
  })
})
