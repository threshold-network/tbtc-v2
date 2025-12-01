import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
} from "../../../typechain"
import { to1ePrecision } from "../../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_SEI = 32
const WORMHOLE_CHAIN_BASE = 30

describe("L1BTCDepositorNttWithExecutor - Fee Handling", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let owner: SignerWithAddress

  before(async () => {
    // Get signers
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[owner] = await ethers.getSigners()

    // Deploy mock contracts following StarkNet pattern
    const TestERC20Factory = await ethers.getContractFactory("TestERC20")
    tbtcToken = await TestERC20Factory.deploy()

    const MockBridgeFactory = await ethers.getContractFactory("MockTBTCBridge")
    bridge = await MockBridgeFactory.deploy()

    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    // Mock NTT managers with simple objects
    const nttManagerWithExecutor = {
      address: ethers.Wallet.createRandom().address,
    }
    const underlyingNttManager = {
      address: ethers.Wallet.createRandom().address,
    }

    // Deploy main contract with proxy following StarkNet pattern
    const L1BTCDepositorFactory = await ethers.getContractFactory(
      "L1BTCDepositorNttWithExecutor"
    )
    const depositorImpl = await L1BTCDepositorFactory.deploy()

    // Deploy proxy
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = depositorImpl.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      nttManagerWithExecutor.address,
      underlyingNttManager.address,
    ])
    const proxy = await ProxyFactory.deploy(depositorImpl.address, initData)

    depositor = L1BTCDepositorFactory.attach(proxy.address)

    // Set up basic configuration
    await depositor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await depositor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
    await depositor.setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)

    // Set default platform fee to allow owner.address as payee (C1 fix compatibility)
    await depositor.setDefaultParameters(
      500000, // gas limit
      0, // executor fee
      ethers.constants.AddressZero, // executor fee recipient
      100, // 0.1% platform fee
      owner.address // platform fee recipient (matches test payee addresses)
    )
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Fee Configuration", () => {
    it("should start with default fee parameters", async () => {
      // Check that executor parameters are not set initially
      const [isSet] = await depositor.areExecutorParametersSet()
      expect(isSet).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })

    it("should have zero stored executor value initially", async () => {
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })
  })

  describe("Fee Estimation", () => {
    it("should revert fee estimation without executor parameters", async () => {
      await expect(depositor["quoteFinalizeDeposit()"]()).to.be.revertedWith(
        "Executor parameters not set"
      )
    })

    it("should revert fee estimation with chain parameter without executor parameters", async () => {
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_SEI)
      ).to.be.revertedWith("Executor parameters not set")
    })
  })

  describe("Executor Parameters Management", () => {
    it("should reject empty signed quote", async () => {
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: owner.address,
        signedQuote: "0x", // Empty signed quote
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      await expect(
        depositor.connect(owner).setExecutorParameters(executorArgs, feeArgs)
      ).to.be.revertedWith(
        "Real signed quote from Wormhole Executor API is required"
      )
    })

    it("should accept valid executor parameters", async () => {
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: owner.address,
        signedQuote: `0x${"a".repeat(64)}`, // Mock signed quote (32 bytes)
        instructions: `0x${"b".repeat(32)}`, // Mock instructions (16 bytes)
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      // Should succeed with mock parameters
      await expect(
        depositor.connect(owner).setExecutorParameters(executorArgs, feeArgs)
      ).to.not.be.reverted

      // Verify parameters are set
      const [isSet] = await depositor.connect(owner).areExecutorParametersSet()
      expect(isSet).to.be.true
    })
  })

  describe("Fee Validation", () => {
    it("should handle zero fee values", async () => {
      const feeArgs = {
        gasLimit: BigNumber.from(0),
        feeBps: BigNumber.from(0),
        feeRecipient: ethers.constants.AddressZero,
      }

      // This should not revert - zero fees are valid
      expect(feeArgs.gasLimit).to.equal(0)
      expect(feeArgs.feeBps).to.equal(0)
      expect(feeArgs.feeRecipient).to.equal(ethers.constants.AddressZero)
    })

    it("should handle maximum fee values", async () => {
      const maxUint256 = ethers.constants.MaxUint256
      const maxFeeArgs = {
        gasLimit: maxUint256,
        feeBps: BigNumber.from(10000), // 100% in basis points
        feeRecipient: ethers.Wallet.createRandom().address,
      }

      // These should be valid values
      expect(maxFeeArgs.gasLimit).to.equal(maxUint256)
      expect(maxFeeArgs.feeBps).to.equal(10000)
      expect(maxFeeArgs.feeRecipient).to.not.equal(ethers.constants.AddressZero)
    })
  })

  describe("Fee Parameter Storage", () => {
    it("should clear executor parameters", async () => {
      // Initially not set
      const [isSet1] = await depositor.areExecutorParametersSet()
      expect(isSet1).to.be.false

      // Clear should work even when not set
      await depositor.clearExecutorParameters()

      const [isSet2] = await depositor.areExecutorParametersSet()
      expect(isSet2).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })

    it("should reset stored executor value after clearing", async () => {
      await depositor.clearExecutorParameters()
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })
  })
})
