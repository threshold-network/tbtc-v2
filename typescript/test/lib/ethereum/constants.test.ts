import { expect } from "chai"
import { NATIVE_BTC_DEPOSITOR_ADDRESSES } from "../../../src/lib/ethereum/constants"
import { BitcoinNetwork } from "../../../src/lib/bitcoin/network"

describe("NATIVE_BTC_DEPOSITOR_ADDRESSES", () => {
  describe("constant structure validation", () => {
    it("should be an object", () => {
      expect(NATIVE_BTC_DEPOSITOR_ADDRESSES).to.be.an("object")
    })

    it("should not be undefined", () => {
      expect(NATIVE_BTC_DEPOSITOR_ADDRESSES).to.not.be.undefined
    })

    it("should have Mainnet property", () => {
      expect(NATIVE_BTC_DEPOSITOR_ADDRESSES).to.have.property(
        BitcoinNetwork.Mainnet
      )
    })

    it("should have Testnet property", () => {
      expect(NATIVE_BTC_DEPOSITOR_ADDRESSES).to.have.property(
        BitcoinNetwork.Testnet
      )
    })

    it("should not have Unknown network property", () => {
      expect(NATIVE_BTC_DEPOSITOR_ADDRESSES).to.not.have.property(
        BitcoinNetwork.Unknown
      )
    })
  })

  describe("address value validation", () => {
    it("should have string value for Mainnet", () => {
      expect(NATIVE_BTC_DEPOSITOR_ADDRESSES[BitcoinNetwork.Mainnet]).to.be.a(
        "string"
      )
    })

    it("should have valid Ethereum address format for Mainnet", () => {
      const mainnetAddr = NATIVE_BTC_DEPOSITOR_ADDRESSES[BitcoinNetwork.Mainnet]
      expect(mainnetAddr).to.match(/^0x[a-fA-F0-9]{40}$/)
    })

    it("should have exact Mainnet address from specification", () => {
      expect(NATIVE_BTC_DEPOSITOR_ADDRESSES[BitcoinNetwork.Mainnet]).to.equal(
        "0xad7c6d46F4a4bc2D3A227067d03218d6D7c9aaa5"
      )
    })

    it("should have string value for Testnet", () => {
      expect(NATIVE_BTC_DEPOSITOR_ADDRESSES[BitcoinNetwork.Testnet]).to.be.a(
        "string"
      )
    })

    it("should have valid Ethereum address format or placeholder for Testnet", () => {
      const testnetAddr = NATIVE_BTC_DEPOSITOR_ADDRESSES[BitcoinNetwork.Testnet]
      // Allow either placeholder "0x..." or valid Ethereum address
      const isPlaceholder = testnetAddr === "0x..."
      const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(testnetAddr)
      expect(isPlaceholder || isValidAddress).to.be.true
    })
  })

  describe("module integration", () => {
    it("should be exportable from ethereum index", async () => {
      // Import from barrel export
      const { NATIVE_BTC_DEPOSITOR_ADDRESSES: fromIndex } = await import(
        "../../../src/lib/ethereum"
      )
      expect(fromIndex).to.exist
      expect(fromIndex).to.deep.equal(NATIVE_BTC_DEPOSITOR_ADDRESSES)
    })

    it("should work correctly with BitcoinNetwork enum", () => {
      // Test enum usage as object keys
      const mainnetAddr = NATIVE_BTC_DEPOSITOR_ADDRESSES[BitcoinNetwork.Mainnet]
      expect(mainnetAddr).to.be.a("string")

      const testnetAddr = NATIVE_BTC_DEPOSITOR_ADDRESSES[BitcoinNetwork.Testnet]
      expect(testnetAddr).to.be.a("string")
    })
  })
})
