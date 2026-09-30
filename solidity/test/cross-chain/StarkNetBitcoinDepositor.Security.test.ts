import { ethers } from "hardhat"
import { expect } from "chai"
import type { StarkNetBitcoinDepositor } from "../../typechain"

describe("StarkNetBitcoinDepositor - Security & Edge Cases", () => {
  it("should deploy and initialize correctly", async () => {
    const [owner] = await ethers.getSigners()

    // Deploy mock contracts
    const MockTBTCToken = await ethers.getContractFactory("MockTBTCToken")
    const tbtcToken = await MockTBTCToken.deploy()

    const MockBridgeForStarkNet = await ethers.getContractFactory(
      "MockBridgeForStarkNet"
    )
    const bridge = await MockBridgeForStarkNet.deploy()

    const MockTBTCVault = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    const tbtcVault = await MockTBTCVault.deploy()
    await tbtcVault.getFunction("setTbtcToken")(tbtcToken.target)

    const MockStarkGateBridge = await ethers.getContractFactory(
      "MockStarkGateBridge"
    )
    const starkGateBridge = await MockStarkGateBridge.deploy()

    // Deploy main contract with proxy
    const StarkNetBitcoinDepositor = await ethers.getContractFactory(
      "StarkNetBitcoinDepositor"
    )
    const depositorImpl = await StarkNetBitcoinDepositor.deploy()

    // Deploy proxy
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = depositorImpl.interface.encodeFunctionData("initialize", [
      bridge.target,
      tbtcVault.target,
      starkGateBridge.target,
    ])
    const proxy = await ProxyFactory.deploy(depositorImpl.target, initData)

    const depositor = StarkNetBitcoinDepositor.attach(
      proxy.target
    ) as StarkNetBitcoinDepositor

    // Check that it's initialized
    expect(await depositor.owner()).to.equal(owner.address)
    expect(await depositor.starkGateBridge()).to.equal(starkGateBridge.target)
  })
})
