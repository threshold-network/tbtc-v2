import { ethers } from "hardhat"
import { expect } from "chai"
import type {
  L2BTCRedeemerWormhole,
  MockL2WormholeGateway,
  TestERC20,
} from "../../../typechain"

const toWormholeFormat = (address: string): string =>
  ethers.utils.hexlify(ethers.utils.zeroPad(address, 32))

describe("L2BTCRedeemerWormhole - hardening", () => {
  const l1ChainId = 2
  const l1RedeemerAddress = "0x0000000000000000000000000000000000000001"
  const amount = ethers.utils.parseUnits("1", 18)
  const redeemerOutputScript =
    "0x1976a9140102030405060708090a0b0c0d0e0f101112131488ac"

  let redeemer: L2BTCRedeemerWormhole
  let tbtc: TestERC20
  let gateway: MockL2WormholeGateway

  beforeEach(async () => {
    const [deployer, user] = await ethers.getSigners()

    const TestERC20Factory = await ethers.getContractFactory("TestERC20")
    tbtc = await TestERC20Factory.deploy()

    const MockGatewayFactory = await ethers.getContractFactory(
      "MockL2WormholeGateway"
    )
    gateway = await MockGatewayFactory.deploy()

    const RedeemerFactory = await ethers.getContractFactory(
      "L2BTCRedeemerWormhole"
    )
    redeemer = await RedeemerFactory.deploy()
    await redeemer.initialize(
      tbtc.address,
      gateway.address,
      toWormholeFormat(l1RedeemerAddress),
      l1ChainId
    )

    await tbtc.connect(deployer).mint(user.address, amount)
    await tbtc.connect(user).approve(redeemer.address, amount)
  })

  it("should reject redemptions to any chain except the configured L1 chain", async () => {
    const [, user] = await ethers.getSigners()

    await expect(
      redeemer
        .connect(user)
        .requestRedemption(amount, l1ChainId + 1, redeemerOutputScript, 123)
    ).to.be.revertedWith("InvalidRecipientChain")
  })

  it("should forward redemptions to the configured L1 chain", async () => {
    const [, user] = await ethers.getSigners()

    await expect(
      redeemer
        .connect(user)
        .requestRedemption(amount, l1ChainId, redeemerOutputScript, 123)
    ).to.emit(redeemer, "RedemptionRequestedOnL2")

    expect(await gateway.lastRecipientChain()).to.equal(l1ChainId)
    expect(await gateway.lastRecipient()).to.equal(
      toWormholeFormat(l1RedeemerAddress)
    )
  })
})
