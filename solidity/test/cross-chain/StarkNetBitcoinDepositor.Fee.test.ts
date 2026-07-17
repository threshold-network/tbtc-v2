import { ethers, helpers, upgrades } from "hardhat"
import { expect } from "chai"
import type {
  StarkNetBitcoinDepositor,
  MockBridgeForStarkNet,
  MockTBTCVault,
  MockStarkGateBridge,
  MockTBTCToken,
} from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("StarkNetBitcoinDepositor - Dynamic Fee Estimation", () => {
  let depositor: StarkNetBitcoinDepositor
  let starkGateBridge: MockStarkGateBridge

  beforeEach(async () => {
    await createSnapshot()

    const MockTBTCToken = await ethers.getContractFactory("MockTBTCToken")
    const tbtcToken = (await MockTBTCToken.deploy()) as MockTBTCToken

    const MockBridgeForStarkNet = await ethers.getContractFactory(
      "MockBridgeForStarkNet"
    )
    const bridge =
      (await MockBridgeForStarkNet.deploy()) as MockBridgeForStarkNet

    const MockTBTCVault = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    const tbtcVault = (await MockTBTCVault.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    const MockStarkGateBridge = await ethers.getContractFactory(
      "MockStarkGateBridge"
    )
    starkGateBridge =
      (await MockStarkGateBridge.deploy()) as MockStarkGateBridge

    const StarkNetBitcoinDepositor = await ethers.getContractFactory(
      "StarkNetBitcoinDepositor"
    )
    depositor = (await upgrades.deployProxy(StarkNetBitcoinDepositor, [
      bridge.address,
      tbtcVault.address,
      starkGateBridge.address,
    ])) as StarkNetBitcoinDepositor
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  it("should exist and be callable", async () => {
    const fee = await depositor.estimateFee()
    expect(fee).to.be.gt(0)
  })
})
