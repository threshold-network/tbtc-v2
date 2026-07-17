import { expect } from "chai"
import { RpcProvider, Account } from "starknet"
import { StarkNetProvider } from "../../src/lib/starknet/types"

describe("TBTC StarkNet Provider Types Integration", () => {
  describe("initializeCrossChain parameter types", () => {
    it("should compile with StarkNetProvider type", () => {
      // This test verifies that TypeScript allows StarkNetProvider as a parameter
      type InitializeCrossChainSignature = (
        l2ChainName: "StarkNet",
        l2Signer: StarkNetProvider
      ) => Promise<void>

      // If this compiles, the types are compatible
      const testFunction: InitializeCrossChainSignature = async (
        l2ChainName,
        l2Signer
      ) => {
        // Implementation would go here
      }

      expect(testFunction).to.be.a("function")
    })

    it("should accept RpcProvider instance", () => {
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      const starknetProvider: StarkNetProvider = provider
      expect(starknetProvider).to.be.instanceOf(RpcProvider)
    })

    it("should accept Account instance", () => {
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(
        provider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      const starknetProvider: StarkNetProvider = account
      expect(starknetProvider).to.be.instanceOf(Account)
    })
  })
})
