import {
  deployMockContract,
  MockContract,
} from "@ethereum-waffle/mock-contract"
import {
  SeiTBTCToken,
  ChainIdentifier,
  Chains,
  EthereumAddress,
} from "../../../src"
import { MockProvider } from "@ethereum-waffle/provider"
import { assertContractCalledWith } from "../../utils/helpers"
import { expect } from "chai"
import { BigNumber } from "ethers"

// ABI imports - using L2TBTC ABI since Sei uses the same contract
import { abi as L2TBTCABI } from "../../../src/lib/sei/artifacts/seiTestnet/SeiTBTC.json"

describe("SeiTBTCToken", () => {
  let tokenContract: MockContract
  let tokenHandle: SeiTBTCToken

  beforeEach(async () => {
    const [signer] = new MockProvider().getWallets()

    tokenContract = await deployMockContract(
      signer,
      `${JSON.stringify(L2TBTCABI)}`
    )

    tokenHandle = new SeiTBTCToken(
      {
        address: tokenContract.address,
        signerOrProvider: signer,
      },
      Chains.Sei.Testnet
    )
  })

  describe("constructor", () => {
    it("should create instance with Testnet chain ID", () => {
      const token = new SeiTBTCToken(
        {
          address: tokenContract.address,
          signerOrProvider: new MockProvider().getWallets()[0],
        },
        Chains.Sei.Testnet
      )
      expect(token).to.exist
    })

    it("should create instance with Mainnet chain ID", () => {
      const token = new SeiTBTCToken(
        {
          address: tokenContract.address,
          signerOrProvider: new MockProvider().getWallets()[0],
        },
        Chains.Sei.Mainnet
      )
      expect(token).to.exist
    })

    it("should throw error for unsupported chain ID", () => {
      expect(() => {
        new SeiTBTCToken(
          {
            address: tokenContract.address,
            signerOrProvider: new MockProvider().getWallets()[0],
          },
          "9999" as any
        )
      }).to.throw("Unsupported deployment type")
    })
  })

  describe("getChainIdentifier", () => {
    it("should return EthereumAddress instance", () => {
      const identifier = tokenHandle.getChainIdentifier()
      expect(identifier).to.be.instanceOf(EthereumAddress)
      const contractAddress = String(tokenContract.address)
      // Check that the identifier has the correct address
      expect(identifier.identifierHex.toLowerCase()).to.equal(
        contractAddress.replace("0x", "").toLowerCase()
      )
    })
  })

  describe("balanceOf", () => {
    let balance: BigNumber

    const identifier: ChainIdentifier = EthereumAddress.from(
      "934b98637ca318a4d6e7ca6ffd1690b8e77df637"
    )

    beforeEach(async () => {
      await tokenContract.mock.balanceOf.returns(10)

      balance = await tokenHandle.balanceOf(identifier)
    })

    it("should call the contract with the right parameter", async () => {
      assertContractCalledWith(tokenContract, "balanceOf", [
        "0x934b98637ca318a4d6e7ca6ffd1690b8e77df637",
      ])
    })

    it("should return the balance", async () => {
      expect(balance).to.equal(10)
    })

    it("should handle zero balance", async () => {
      await tokenContract.mock.balanceOf.returns(0)
      const zeroBalance = await tokenHandle.balanceOf(identifier)
      expect(zeroBalance).to.equal(0)
    })

    it("should handle large balance", async () => {
      const largeBalance = BigNumber.from("1000000000000000000000") // 1000 tokens
      await tokenContract.mock.balanceOf.returns(largeBalance)
      const result = await tokenHandle.balanceOf(identifier)
      expect(result).to.equal(largeBalance)
    })
  })
})
