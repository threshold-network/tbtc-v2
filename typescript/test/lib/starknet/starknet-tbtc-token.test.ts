import { expect } from "chai"
import { StarkNetTBTCToken, StarkNetAddress } from "../../../src/lib/starknet"
import { EthereumAddress } from "../../../src/lib/ethereum"

describe("StarkNetTBTCToken", () => {
  let token: StarkNetTBTCToken

  beforeEach(() => {
    token = new StarkNetTBTCToken()
  })

  describe("getChainIdentifier", () => {
    it("should throw an error indicating no chain identifier", () => {
      expect(() => token.getChainIdentifier()).to.throw(
        "StarkNet TBTC token interface has no chain identifier. " +
        "Token operations are not supported on StarkNet yet."
      )
    })
  })

  describe("balanceOf", () => {
    context("when called with a valid StarkNet address", () => {
      it("should throw an error indicating balance queries are not supported", async () => {
        const starkNetAddress = StarkNetAddress.from("0x1234")
        
        await expect(token.balanceOf(starkNetAddress)).to.be.rejectedWith(
          "Cannot get balance via StarkNet interface. " +
          "Token operations are not supported on StarkNet yet."
        )
      })
    })

    context("when called with a non-StarkNet address", () => {
      it("should throw an error indicating identifier must be a StarkNet address", async () => {
        const ethereumAddress = EthereumAddress.from("0x1234567890123456789012345678901234567890")
        
        await expect(token.balanceOf(ethereumAddress)).to.be.rejectedWith(
          "Address must be a StarkNet address"
        )
      })
    })

    context("when called with different StarkNet address formats", () => {
      it("should validate address type before throwing balance query error", async () => {
        const validAddresses = [
          "0x0",
          "0x1",
          "0xabcdef",
          "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
        ]

        for (const address of validAddresses) {
          const starkNetAddress = StarkNetAddress.from(address)
          await expect(token.balanceOf(starkNetAddress)).to.be.rejectedWith(
            "Cannot get balance via StarkNet interface. " +
            "Token operations are not supported on StarkNet yet."
          )
        }
      })
    })

    context("when called with zero address", () => {
      it("should handle zero address (0x0) correctly", async () => {
        const zeroAddress = StarkNetAddress.from("0x0")
        
        await expect(token.balanceOf(zeroAddress)).to.be.rejectedWith(
          "Cannot get balance via StarkNet interface. " +
          "Token operations are not supported on StarkNet yet."
        )
      })
    })

    context("when called with maximum field element address", () => {
      it("should handle addresses close to field element limit", async () => {
        // Max felt252 value is close to 2^252 - 1
        const largeAddress = StarkNetAddress.from("0x" + "f".repeat(63))
        
        await expect(token.balanceOf(largeAddress)).to.be.rejectedWith(
          "Cannot get balance via StarkNet interface. " +
          "Token operations are not supported on StarkNet yet."
        )
      })
    })

    context("when called concurrently", () => {
      it("should handle concurrent balance queries", async () => {
        const addresses = [
          StarkNetAddress.from("0x1"),
          StarkNetAddress.from("0x2"),
          StarkNetAddress.from("0x3")
        ]
        
        const promises = addresses.map(addr => token.balanceOf(addr))
        
        await expect(Promise.all(promises)).to.be.rejected
        
        // Verify each promise rejects with the correct error
        for (const promise of promises) {
          await expect(promise).to.be.rejectedWith(
            "Cannot get balance via StarkNet interface. " +
            "Token operations are not supported on StarkNet yet."
          )
        }
      })
    })

    context("when called with null or undefined", () => {
      it("should throw error for null address", async () => {
        await expect(token.balanceOf(null as any)).to.be.rejectedWith(
          "Address must be a StarkNet address"
        )
      })

      it("should throw error for undefined address", async () => {
        await expect(token.balanceOf(undefined as any)).to.be.rejectedWith(
          "Address must be a StarkNet address"
        )
      })
    })
  })

  describe("interface implementation", () => {
    it("should implement the L2TBTCToken interface", () => {
      // Check that required methods exist
      expect(token.getChainIdentifier).to.be.a("function")
      expect(token.balanceOf).to.be.a("function")
    })
  })
})