import { helpers, ethers } from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import { randomBytes } from "crypto"

import type {
  StarkNetBitcoinDepositor,
  MockBridgeForStarkNet,
  MockTBTCToken,
  MockTBTCVault,
  MockStarkGateBridge,
} from "../../typechain"

describe("StarkNetBitcoinDepositor - Dynamic Fee Estimation", () => {
  let deployer: HardhatEthersSigner
  let depositorAccount: HardhatEthersSigner
  let starkNetDepositor: StarkNetBitcoinDepositor
  let bridge: MockBridgeForStarkNet
  let tbtcVault: MockTBTCVault
  let tbtcToken: MockTBTCToken
  let starkGateBridge: MockStarkGateBridge

  const l2TokenAddress =
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  const INITIAL_MESSAGE_FEE = ethers.parseEther("0.002")

  beforeEach(async () => {
    ;[deployer, depositorAccount] = await ethers.getSigners()

    // Deploy mock contracts
    const MockTBTCToken = await ethers.getContractFactory("MockTBTCToken")
    tbtcToken = await MockTBTCToken.deploy()

    const MockBridgeForStarkNet = await ethers.getContractFactory(
      "MockBridgeForStarkNet"
    )
    bridge = await MockBridgeForStarkNet.deploy()

    const MockTBTCVault = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVault.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.target)

    const MockStarkGateBridge = await ethers.getContractFactory(
      "MockStarkGateBridge"
    )
    starkGateBridge = await MockStarkGateBridge.deploy()

    // Deploy StarkNet depositor using proxy pattern
    const deployment = await helpers.upgrades.deployProxy(
      `StarkNetBitcoinDepositor_${randomBytes(8).toString("hex")}`,
      {
        contractName: "StarkNetBitcoinDepositor",
        initializerArgs: [
          bridge.target,
          tbtcVault.target,
          starkGateBridge.target,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    starkNetDepositor = deployment[0] as unknown as StarkNetBitcoinDepositor
  })

  describe("Dynamic Fee Implementation", () => {
    describe("quoteFinalizeDepositDynamic function", () => {
      it("should exist and be callable", async () => {
        // The function was removed, so we test estimateFee instead
        expect(starkNetDepositor.estimateFee).to.be.a("function")
      })

      it("should return dynamic fee from StarkGate", async () => {
        const dynamicFee = await starkNetDepositor.estimateFee()

        // MockStarkGateBridge returns 0.01 ether
        const expectedFee = ethers.parseEther("0.01")
        expect(dynamicFee).to.equal(expectedFee)
      })
    })

    describe("Fee Buffer Mechanism", () => {
      // These tests are no longer valid as fee buffer was removed
      it("should get fee from StarkGate", async () => {
        const fee = await starkNetDepositor.estimateFee()
        expect(fee).to.be.gt(0)
      })
    })
  })
})
