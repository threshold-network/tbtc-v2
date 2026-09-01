import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
  MockNttManagerWithExecutor,
  MockNttManager,
} from "../../../typechain"
import {
  REAL_SIGNED_QUOTE,
  EXECUTOR_ARGS_REAL_QUOTE,
  FEE_ARGS_ZERO,
} from "./realSignedQuote"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_DESTINATION = 32
const WORMHOLE_CHAIN_BASE = 30

describe("L1BTCDepositorNttWithExecutor - Real-World Scenarios", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: MockNttManager

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

    // Deploy proper mock NTT managers
    const MockNttManagerWithExecutorFactory = await ethers.getContractFactory(
      "MockNttManagerWithExecutor"
    )
    nttManagerWithExecutor = await MockNttManagerWithExecutorFactory.deploy()

    const MockNttManagerFactory = await ethers.getContractFactory(
      "MockNttManager"
    )
    underlyingNttManager = await MockNttManagerFactory.deploy()

    await nttManagerWithExecutor.setSupportedChain(
      WORMHOLE_CHAIN_DESTINATION,
      true
    )
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)

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
    await depositor.setSupportedChain(WORMHOLE_CHAIN_DESTINATION, true)
    await depositor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
    await depositor.setDefaultSupportedChain(WORMHOLE_CHAIN_DESTINATION)
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
        .setExecutorParameters(
          { ...EXECUTOR_ARGS_REAL_QUOTE, refundAddress: user.address },
          FEE_ARGS_ZERO,
          WORMHOLE_CHAIN_DESTINATION
        )

      // Test quotes for different supported chains
      const quoteDest = await depositor
        .connect(user)
        ["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_DESTINATION)
      expect(quoteDest).to.be.gt(0)

      const quoteBase = await depositor
        .connect(user)
        ["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_BASE)
      expect(quoteBase).to.be.gt(0)

      // Test quote for unsupported chain
      await expect(
        depositor.connect(user)["quoteFinalizeDeposit(uint16)"](999)
      ).to.be.revertedWith("Destination chain not supported")
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
        .setExecutorParameters(
          executorArgs,
          zeroFeeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )
      const [isSet1] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet1).to.be.true

      // Test high fee (update default parameters first)
      await depositor.setDefaultParameters(
        600000,
        1000,
        user.address,
        0,
        ethers.constants.AddressZero
      )

      const highFeeArgs = {
        dbps: 1000, // 1% (1000/100000)
        payee: user.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          highFeeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )
      const [isSet2] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet2).to.be.true

      // Test maximum fee (update default parameters first)
      await depositor.setDefaultParameters(
        600000,
        10000,
        user.address,
        0,
        ethers.constants.AddressZero
      )

      const maxFeeArgs = {
        dbps: 10000, // 10% (10000/100000)
        payee: user.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          maxFeeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )
      const [isSet3] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet3).to.be.true
    })

    it("should handle fee recipient changes", async () => {
      const [, , user, feeRecipient] = await ethers.getSigners()

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      // Configure default for fee recipient 1
      await depositor.setDefaultParameters(
        600000,
        100,
        user.address,
        0,
        ethers.constants.AddressZero
      )

      const feeArgs1 = {
        dbps: 100, // 0.1% (100/100000)
        payee: user.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          feeArgs1,
          WORMHOLE_CHAIN_DESTINATION
        )

      // Update default for fee recipient 2
      await depositor.setDefaultParameters(
        600000,
        100,
        feeRecipient.address,
        0,
        ethers.constants.AddressZero
      )

      const feeArgs2 = {
        dbps: 100, // 0.1% (100/100000)
        payee: feeRecipient.address,
      }

      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          feeArgs2,
          WORMHOLE_CHAIN_DESTINATION
        )
      const [isSet] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet).to.be.true
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

        // eslint-disable-next-line no-await-in-loop
        await depositor
          .connect(user)
          .setExecutorParameters(
            executorArgs,
            FEE_ARGS_ZERO,
            WORMHOLE_CHAIN_DESTINATION
          )

        // eslint-disable-next-line no-await-in-loop
        const [isSet] = await depositor.connect(user).areExecutorParametersSet()
        expect(isSet).to.be.true
        // eslint-disable-next-line no-await-in-loop
        expect(await depositor.connect(user).getStoredExecutorValue()).to.equal(
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

      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          FEE_ARGS_ZERO,
          WORMHOLE_CHAIN_DESTINATION
        )
      const [isSet1] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet1).to.be.true

      // Clear parameters
      await depositor.connect(user).clearExecutorParameters()
      const [isSet2] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet2).to.be.false

      // Reset parameters
      await depositor
        .connect(user)
        .setExecutorParameters(
          executorArgs,
          FEE_ARGS_ZERO,
          WORMHOLE_CHAIN_DESTINATION
        )
      const [isSet3] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet3).to.be.true
    })
  })

  describe("Error Recovery Scenarios", () => {
    it("should recover from invalid operations", async () => {
      const [, , user] = await ethers.getSigners()

      // Try to quote without parameters (should fail)
      await expect(
        depositor.connect(user)["quoteFinalizeDeposit()"]()
      ).to.be.revertedWith("Executor parameters not set")

      // Set valid parameters using real signed quote
      await depositor
        .connect(user)
        .setExecutorParameters(
          { ...EXECUTOR_ARGS_REAL_QUOTE, refundAddress: user.address },
          FEE_ARGS_ZERO,
          WORMHOLE_CHAIN_DESTINATION
        )

      // Verify that executor parameters are now set
      const [isSet2] = await depositor.connect(user).areExecutorParametersSet()
      expect(isSet2).to.be.true
    })

    it("should handle chain-specific errors", async () => {
      const [, , user] = await ethers.getSigners()

      // Use real signed quote
      await depositor
        .connect(user)
        .setExecutorParameters(
          { ...EXECUTOR_ARGS_REAL_QUOTE, refundAddress: user.address },
          FEE_ARGS_ZERO,
          WORMHOLE_CHAIN_DESTINATION
        )

      // Try to quote for unsupported chain (should fail)
      await expect(
        depositor.connect(user)["quoteFinalizeDeposit(uint16)"](999)
      ).to.be.revertedWith("Destination chain not supported")

      // Quote for supported chain should succeed
      const quote = await depositor
        .connect(user)
        ["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_DESTINATION)
      expect(quote).to.be.gt(0)
    })
  })
})
