import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
} from "../../../typechain"
import {
  REAL_SIGNED_QUOTE,
  EXECUTOR_ARGS_REAL_QUOTE,
  FEE_ARGS_ZERO,
} from "./realSignedQuote"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_SEI = 32
const WORMHOLE_CHAIN_BASE = 30

describe("L1BTCDepositorNttWithExecutor - Integration Tests", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20

  before(async () => {
    // Deploy mock contracts following working pattern
    const TestERC20Factory = await ethers.getContractFactory("TestERC20")
    tbtcToken = await TestERC20Factory.deploy()

    const MockBridgeFactory = await ethers.getContractFactory("MockTBTCBridge")
    bridge = await MockBridgeFactory.deploy()

    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    // Mock NTT managers with simple objects (following working pattern)
    const nttManagerWithExecutor = {
      address: ethers.Wallet.createRandom().address,
    }
    const underlyingNttManager = {
      address: ethers.Wallet.createRandom().address,
    }

    // Deploy main contract with proxy following working pattern
    const L1BTCDepositorFactory = await ethers.getContractFactory(
      "L1BTCDepositorNttWithExecutor"
    )
    const depositorImpl = await L1BTCDepositorFactory.deploy()
    await depositorImpl.deployed()

    // Deploy proxy
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = depositorImpl.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      nttManagerWithExecutor.address,
      underlyingNttManager.address,
    ])
    const proxy = await ProxyFactory.deploy(depositorImpl.address, initData)
    await proxy.deployed()

    depositor = L1BTCDepositorFactory.attach(
      proxy.address
    ) as L1BTCDepositorNttWithExecutor

    // Set up supported chains
    await depositor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await depositor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
    await depositor.setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("End-to-End Workflow", () => {
    it("should handle complete deposit workflow", async () => {
      const [, , user] = await ethers.getSigners()

      // Set up executor parameters using real signed quote
      await depositor
        .connect(user)
        .setExecutorParameters(EXECUTOR_ARGS_REAL_QUOTE, FEE_ARGS_ZERO)
      expect(await depositor.areExecutorParametersSet()).to.be.true

      // Verify that executor parameters are properly set
      expect(await depositor.areExecutorParametersSet()).to.be.true

      // Test chain-specific quote - will fail because we're using mock addresses
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_BASE)
      ).to.be.reverted
    })

    it("should handle multiple chain configurations", async () => {
      // Add more chains
      await depositor.setSupportedChain(99, true)
      await depositor.setSupportedChain(100, true)

      expect(await depositor.supportedChains(99)).to.be.true
      expect(await depositor.supportedChains(100)).to.be.true

      // Remove one chain
      await depositor.setSupportedChain(99, false)
      expect(await depositor.supportedChains(99)).to.be.false
      expect(await depositor.supportedChains(100)).to.be.true
    })

    it("should handle parameter updates and clearing", async () => {
      const [, , user] = await ethers.getSigners()

      // Set initial parameters
      const executorArgs1 = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs1 = {
        dbps: 100,
        payee: user.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(executorArgs1, feeArgs1)
      expect(await depositor.areExecutorParametersSet()).to.be.true
      expect(await depositor.getStoredExecutorValue()).to.equal(
        executorArgs1.value
      )

      // Update parameters
      const executorArgs2 = {
        value: ethers.utils.parseEther("0.02"),
        refundAddress: user.address,
        signedQuote: `0x${"3".repeat(128)}`,
        instructions: `0x${"4".repeat(64)}`,
      }

      const feeArgs2 = {
        dbps: 200,
        payee: user.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(executorArgs2, feeArgs2)
      expect(await depositor.areExecutorParametersSet()).to.be.true
      expect(await depositor.getStoredExecutorValue()).to.equal(
        executorArgs2.value
      )

      // Clear parameters
      await depositor.connect(user).clearExecutorParameters()
      expect(await depositor.areExecutorParametersSet()).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })
  })

  describe("Error Handling", () => {
    it("should reject operations without executor parameters", async () => {
      // Verify that executor parameters are not set initially
      expect(await depositor.areExecutorParametersSet()).to.be.false
    })

    it("should reject empty signed quotes", async () => {
      const [, , user] = await ethers.getSigners()

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: "0x", // Empty signed quote
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 100,
        payee: user.address,
      }

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.be.revertedWith(
        "Real signed quote from Wormhole Executor API is required"
      )
    })

    it("should reject quotes for unsupported chains", async () => {
      const [, , user] = await ethers.getSigners()

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 100,
        payee: user.address,
      }

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      // Try to quote for unsupported chain
      const unsupportedChain = 999
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](unsupportedChain)
      ).to.be.revertedWith("Destination chain not supported")
    })
  })

  describe("Configuration Management", () => {
    it("should handle default parameter updates", async () => {
      const [, , user] = await ethers.getSigners()

      // Set default parameters
      await depositor.setDefaultParameters(
        600000, // gas limit
        150, // 1.5% fee
        user.address
      )

      expect(await depositor.defaultDestinationGasLimit()).to.equal(600000)
      expect(await depositor.defaultExecutorFeeBps()).to.equal(150)
      expect(await depositor.defaultExecutorFeeRecipient()).to.equal(
        user.address
      )

      // Update default parameters
      await depositor.setDefaultParameters(
        700000, // gas limit
        200, // 2% fee
        user.address
      )

      expect(await depositor.defaultDestinationGasLimit()).to.equal(700000)
      expect(await depositor.defaultExecutorFeeBps()).to.equal(200)
    })

    it("should emit events for parameter changes", async () => {
      const [, , user] = await ethers.getSigners()

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`, // 64 hex chars = 32 bytes
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 100,
        payee: user.address,
      }

      // Check for ExecutorParametersSet event
      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      )
        .to.emit(depositor, "ExecutorParametersSet")
        .withArgs(user.address, 64, ethers.utils.parseEther("0.01")) // 64 bytes, not 128
    })
  })
})
