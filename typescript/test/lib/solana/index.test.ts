import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"

import { Chains } from "../../../src/lib/contracts"
import { loadSolanaCrossChainInterfaces } from "../../../src/lib/solana"

chai.use(chaiAsPromised)

describe("Solana Module", () => {
  describe("loadSolanaCrossChainInterfaces", () => {
    it("should reject a provider connected to a different genesis hash", async () => {
      const provider = {
        wallet: {
          publicKey: {
            toBase58: () => "11111111111111111111111111111111",
          },
        },
        connection: {
          getGenesisHash: async () => Chains.Solana.Devnet,
        },
      }

      await expect(
        loadSolanaCrossChainInterfaces(provider as any, Chains.Solana.Solana)
      ).to.be.rejectedWith(
        `Solana provider genesis hash mismatch: expected ${Chains.Solana.Solana}, got ${Chains.Solana.Devnet}`
      )
    })
  })
})
