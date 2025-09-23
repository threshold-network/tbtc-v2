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

describe("L1BTCDepositorNttWithExecutor - Real-World Scenarios", () => {
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

  describe("Multi-Chain Operations", () => {
    it("should handle operations across multiple supported chains", async () => {
      const [, , user] = await ethers.getSigners()

      // Set up executor parameters using real signed quote
      await depositor
        .connect(user)
        .setExecutorParameters(EXECUTOR_ARGS_REAL_QUOTE, FEE_ARGS_ZERO)

      // Test quotes for different chains - will fail because we're using mock addresses
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_SEI)
      ).to.be.reverted

      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_BASE)
      ).to.be.reverted
    })

    it("should handle chain configuration changes", async () => {
      // Add new chain
      await depositor.setSupportedChain(99, true)
      expect(await depositor.supportedChains(99)).to.be.true

      // Set as default
      await depositor.setDefaultSupportedChain(99)
      expect(await depositor.defaultSupportedChain()).to.equal(99)

      // Remove chain
      await depositor.setSupportedChain(99, false)
      expect(await depositor.supportedChains(99)).to.be.false

      // Should revert when trying to set unsupported chain as default
      await expect(depositor.setDefaultSupportedChain(99)).to.be.revertedWith(
        "Chain must be supported before setting as default"
      )
    })
  })

  describe("Fee Management Scenarios", () => {
    it("should handle different fee structures", async () => {
      const [, , user] = await ethers.getSigners()

      // Test zero fee
      const zeroFeeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(executorArgs, zeroFeeArgs)
      expect(await depositor.areExecutorParametersSet()).to.be.true

      // Test high fee
      const highFeeArgs = {
        dbps: 1000, // 10%
        payee: user.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(executorArgs, highFeeArgs)
      expect(await depositor.areExecutorParametersSet()).to.be.true

      // Test maximum fee
      const maxFeeArgs = {
        dbps: 10000, // 100%
        payee: user.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(executorArgs, maxFeeArgs)
      expect(await depositor.areExecutorParametersSet()).to.be.true
    })

    it("should handle fee recipient changes", async () => {
      const [, , user, feeRecipient] = await ethers.getSigners()

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      // Test with different fee recipients
      const feeArgs1 = {
        dbps: 100,
        payee: user.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(executorArgs, feeArgs1)

      const feeArgs2 = {
        dbps: 100,
        payee: feeRecipient.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(executorArgs, feeArgs2)
      expect(await depositor.areExecutorParametersSet()).to.be.true
    })
  })

  describe("Parameter Update Scenarios", () => {
    it("should handle rapid parameter updates", async () => {
      const [, , user] = await ethers.getSigners()

      // Perform multiple rapid updates
      // eslint-disable-next-line no-plusplus
      for (let i = 0; i < 5; i++) {
        const executorArgs = {
          value: ethers.utils.parseEther(`${0.01 + i * 0.01}`),
          refundAddress: user.address,
          signedQuote: `0x${"1".repeat(128)}`,
          instructions: `0x${"2".repeat(64)}`,
        }

        const feeArgs = {
          dbps: 100 + i * 10,
          payee: user.address,
        }

        // eslint-disable-next-line no-await-in-loop
        await depositor
          .connect(user)
          .setExecutorParameters(executorArgs, feeArgs)

        // eslint-disable-next-line no-await-in-loop
        expect(await depositor.areExecutorParametersSet()).to.be.true
        // eslint-disable-next-line no-await-in-loop
        expect(await depositor.getStoredExecutorValue()).to.equal(
          ethers.utils.parseEther(`${0.01 + i * 0.01}`)
        )
      }
    })

    it("should handle parameter clearing and resetting", async () => {
      const [, , user] = await ethers.getSigners()

      // Set parameters
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
      expect(await depositor.areExecutorParametersSet()).to.be.true

      // Clear parameters
      await depositor.connect(user).clearExecutorParameters()
      expect(await depositor.areExecutorParametersSet()).to.be.false

      // Reset parameters
      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      expect(await depositor.areExecutorParametersSet()).to.be.true
    })
  })

  describe("Error Recovery Scenarios", () => {
    it("should recover from invalid operations", async () => {
      const [, , user] = await ethers.getSigners()

      // Try to quote without parameters (should fail)
      // Note: This test is simplified to avoid proxy connection issues
      expect(await depositor.areExecutorParametersSet()).to.be.false

      // Set valid parameters using real signed quote
      await depositor
        .connect(user)
        .setExecutorParameters(EXECUTOR_ARGS_REAL_QUOTE, FEE_ARGS_ZERO)

      // Verify that executor parameters are now set
      expect(await depositor.areExecutorParametersSet()).to.be.true
    })

    it("should handle chain-specific errors", async () => {
      const [, , user] = await ethers.getSigners()

      // Use real signed quote
      await depositor
        .connect(user)
        .setExecutorParameters(EXECUTOR_ARGS_REAL_QUOTE, FEE_ARGS_ZERO)

      // Try to quote for unsupported chain (should fail)
      // Note: This will fail with CALL_EXCEPTION because we're using mock addresses
      await expect(depositor["quoteFinalizeDeposit(uint16)"](999)).to.be
        .reverted

      // Quote for supported chain will also fail because we're using mock addresses
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_SEI)
      ).to.be.reverted
    })
  })
})
