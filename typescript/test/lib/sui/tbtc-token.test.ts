import { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import chai from "chai"
import sinon from "sinon"

chai.use(chaiAsPromised)
import { SuiTBTCToken, SuiAddress, SuiError } from "../../../src/lib/sui"
import { Chains } from "../../../src/lib/contracts"
import { BigNumber } from "ethers"

describe("SUI tBTC Token", () => {
  let token: SuiTBTCToken
  let mockClient: any

  const coinType = "0x123::tbtc::TBTC"
  const contractAddress = "0x" + "a".repeat(64)
  const chainId = Chains.Sui.Testnet

  beforeEach(() => {
    mockClient = {
      getBalance: sinon.stub(),
    }

    token = new SuiTBTCToken(mockClient, coinType, contractAddress, chainId)
  })

  describe("getChainIdentifier", () => {
    it("should return the contract address as chain identifier", () => {
      const identifier = token.getChainIdentifier()
      expect(identifier).to.be.instanceOf(SuiAddress)
      expect(identifier.identifierHex).to.equal(contractAddress.substring(2))
    })
  })

  describe("balanceOf", () => {
    it("should return scaled balance for valid address", async () => {
      const userAddress = SuiAddress.from("0x" + "b".repeat(64))
      const suiBalance = "12345678" // 0.12345678 tBTC in 8 decimals

      mockClient.getBalance.resolves({
        coinType,
        coinObjectCount: 1,
        totalBalance: suiBalance,
        lockedBalance: {},
      })

      const balance = await token.balanceOf(userAddress)

      // Should scale from 8 to 18 decimals (multiply by 10^10)
      const expectedBalance = BigNumber.from(suiBalance).mul(
        BigNumber.from(10).pow(10)
      )
      expect(balance.toString()).to.equal(expectedBalance.toString())
      expect(balance.toString()).to.equal("123456780000000000") // 0.12345678 * 10^18

      // Verify client was called correctly
      expect(mockClient.getBalance.calledOnce).to.be.true
      expect(mockClient.getBalance.firstCall.args[0]).to.deep.equal({
        owner: `0x${userAddress.identifierHex}`,
        coinType,
      })
    })

    it("should handle zero balance", async () => {
      const userAddress = SuiAddress.from("0x" + "c".repeat(64))

      mockClient.getBalance.resolves({
        coinType,
        coinObjectCount: 0,
        totalBalance: "0",
        lockedBalance: {},
      })

      const balance = await token.balanceOf(userAddress)

      expect(balance.toString()).to.equal("0")
    })

    it("should handle large balances", async () => {
      const userAddress = SuiAddress.from("0x" + "d".repeat(64))
      const largeBalance = "9999999999999999" // Large amount in 8 decimals

      mockClient.getBalance.resolves({
        coinType,
        coinObjectCount: 100,
        totalBalance: largeBalance,
        lockedBalance: {},
      })

      const balance = await token.balanceOf(userAddress)

      const expectedBalance = BigNumber.from(largeBalance).mul(
        BigNumber.from(10).pow(10)
      )
      expect(balance.toString()).to.equal(expectedBalance.toString())
    })

    it("should throw SuiError on client failure", async () => {
      const userAddress = SuiAddress.from("0x" + "e".repeat(64))

      mockClient.getBalance.rejects(new Error("Network error"))

      await expect(token.balanceOf(userAddress)).to.be.rejectedWith(
        SuiError,
        `Failed to fetch tBTC balance for ${userAddress.identifierHex}`
      )
    })

    it("should handle unexpected response format gracefully", async () => {
      const userAddress = SuiAddress.from("0x" + "f".repeat(64))

      mockClient.getBalance.resolves({
        // Missing totalBalance field
        coinType,
        coinObjectCount: 1,
      })

      await expect(token.balanceOf(userAddress)).to.be.rejectedWith(Error)
    })
  })

  describe("decimal conversion", () => {
    it("should correctly convert 1 tBTC from 8 to 18 decimals", async () => {
      const userAddress = SuiAddress.from("0x" + "1".repeat(64))
      const oneTbtcIn8Decimals = "100000000" // 1 tBTC = 10^8 in 8 decimals

      mockClient.getBalance.resolves({
        coinType,
        coinObjectCount: 1,
        totalBalance: oneTbtcIn8Decimals,
        lockedBalance: {},
      })

      const balance = await token.balanceOf(userAddress)

      // 1 tBTC should equal 10^18 in 18 decimals
      expect(balance.toString()).to.equal("1000000000000000000")
    })

    it("should correctly convert fractional amounts", async () => {
      const userAddress = SuiAddress.from("0x" + "2".repeat(64))
      const halfTbtcIn8Decimals = "50000000" // 0.5 tBTC = 5 * 10^7 in 8 decimals

      mockClient.getBalance.resolves({
        coinType,
        coinObjectCount: 1,
        totalBalance: halfTbtcIn8Decimals,
        lockedBalance: {},
      })

      const balance = await token.balanceOf(userAddress)

      // 0.5 tBTC should equal 5 * 10^17 in 18 decimals
      expect(balance.toString()).to.equal("500000000000000000")
    })

    it("should correctly convert very small amounts", async () => {
      const userAddress = SuiAddress.from("0x" + "3".repeat(64))
      const smallAmount = "1" // 0.00000001 tBTC (1 satoshi) in 8 decimals

      mockClient.getBalance.resolves({
        coinType,
        coinObjectCount: 1,
        totalBalance: smallAmount,
        lockedBalance: {},
      })

      const balance = await token.balanceOf(userAddress)

      // Should equal 10^10 in 18 decimals
      expect(balance.toString()).to.equal("10000000000")
    })
  })
})
