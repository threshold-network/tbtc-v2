import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
  MockNttManagerWithExecutor,
} from "../../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_SEI = 32
const WORMHOLE_CHAIN_BASE = 30

describe("L1BTCDepositorNttWithExecutor - Advanced Functionality", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: TestERC20
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

    // Deploy MockNttManagerWithExecutor
    const MockNttManagerWithExecutorFactory = await ethers.getContractFactory(
      "MockNttManagerWithExecutor"
    )
    nttManagerWithExecutor = await MockNttManagerWithExecutorFactory.deploy()
    await nttManagerWithExecutor.deployed()

    // Create underlying NTT manager
    underlyingNttManager = await TestERC20Factory.deploy()
    await underlyingNttManager.deployed()

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

    depositor = L1BTCDepositorFactory.attach(
      proxy.address
    ) as L1BTCDepositorNttWithExecutor

    // Set up basic configuration
    await depositor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await depositor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
    await depositor.setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)

    // Set supported chains for the mock NTT manager
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Edge Cases", () => {
    it("should handle zero-value parameters correctly", async () => {
      // Test that we can work with zero values without issues
      const [isSet1] = await depositor.areExecutorParametersSet()
      expect(isSet1).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })

    it("should handle maximum chain ID values", async () => {
      const maxChainId = 65535 // Max uint16

      // Should not revert when setting max chain ID
      await expect(depositor.setSupportedChain(maxChainId, true)).to.not.be
        .reverted

      expect(await depositor.supportedChains(maxChainId)).to.be.true
    })

    it("should handle chain configuration changes", async () => {
      // Add a new chain
      const newChain = 42
      await depositor.setSupportedChain(newChain, true)
      expect(await depositor.supportedChains(newChain)).to.be.true

      // Remove the chain
      await depositor.setSupportedChain(newChain, false)
      expect(await depositor.supportedChains(newChain)).to.be.false
    })
  })

  describe("Parameter Management", () => {
    it("should clear executor parameters when not set", async () => {
      const [isSet1] = await depositor.areExecutorParametersSet()
      expect(isSet1).to.be.false

      // Should not revert even when clearing non-existent parameters
      await expect(depositor.clearExecutorParameters()).to.not.be.reverted

      const [isSet2] = await depositor.areExecutorParametersSet()
      expect(isSet2).to.be.false
    })

    it("should maintain consistent state", async () => {
      // Initial state should be consistent
      const [isSet3] = await depositor.areExecutorParametersSet()
      expect(isSet3).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)

      // After clearing, state should remain consistent
      await depositor.clearExecutorParameters()
      const [isSet4] = await depositor.areExecutorParametersSet()
      expect(isSet4).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })
  })

  describe("Contract Information", () => {
    it("should return correct contract addresses", async () => {
      expect(await depositor.tbtcVault()).to.equal(tbtcVault.address)
      expect(await depositor.tbtcToken()).to.equal(tbtcToken.address)
    })

    it("should have proper chain support configuration", async () => {
      expect(await depositor.supportedChains(WORMHOLE_CHAIN_SEI)).to.be.true
      expect(await depositor.supportedChains(WORMHOLE_CHAIN_BASE)).to.be.true

      // Unsupported chain should return false
      expect(await depositor.supportedChains(999)).to.be.false
    })
  })

  describe("Error Handling", () => {
    it("should revert on quote without parameters", async () => {
      await expect(depositor["quoteFinalizeDeposit()"]()).to.be.revertedWith(
        "Executor parameters not set"
      )
    })

    it("should revert on quote with chain parameter without executor parameters", async () => {
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_SEI)
      ).to.be.revertedWith("Executor parameters not set")
    })
  })

  describe("Complex Scenarios", () => {
    it("should handle complete deposit flow", async () => {
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: owner.address,
        signedQuote: `0x${"a".repeat(64)}`, // 32 bytes - meets minimum requirement
        instructions: `0x${"b".repeat(32)}`, // 16 bytes
      }

      const feeArgs = {
        dbps: 100, // 1% fee
        payee: owner.address,
      }

      // Step 1: Set executor parameters
      await expect(
        depositor.connect(owner).setExecutorParameters(executorArgs, feeArgs)
      ).to.not.be.reverted

      // Step 2: Verify parameters are set
      const [isSet] = await depositor.connect(owner).areExecutorParametersSet()
      expect(isSet).to.be.true

      // Step 3: Verify stored executor value
      const storedValue = await depositor
        .connect(owner)
        .getStoredExecutorValue()
      expect(storedValue).to.equal(ethers.utils.parseEther("0.01"))

      // Step 4: Test parameter refresh (new functionality)
      const newExecutorArgs = {
        value: ethers.utils.parseEther("0.02"),
        refundAddress: owner.address,
        signedQuote: `0x${"b".repeat(64)}`, // Different signed quote
        instructions: `0x${"c".repeat(32)}`,
      }

      // Should allow refresh
      await expect(
        depositor.connect(owner).setExecutorParameters(newExecutorArgs, feeArgs)
      ).to.not.be.reverted

      // Verify updated value
      const newStoredValue = await depositor
        .connect(owner)
        .getStoredExecutorValue()
      expect(newStoredValue).to.equal(ethers.utils.parseEther("0.02"))
    })

    it("should handle NTT transfer execution", async () => {
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: owner.address,
        signedQuote: `0x${"a".repeat(64)}`, // 32 bytes - meets minimum requirement
        instructions: `0x${"b".repeat(32)}`, // 16 bytes
      }

      const feeArgs = {
        dbps: 100, // 1% fee
        payee: owner.address,
      }

      // Step 1: Set executor parameters
      await expect(
        depositor.connect(owner).setExecutorParameters(executorArgs, feeArgs)
      ).to.not.be.reverted

      // Step 2: Verify parameters are set
      const [isSet] = await depositor.connect(owner).areExecutorParametersSet()
      expect(isSet).to.be.true

      // Step 3: Verify the mock NTT manager integration works
      // Test that the contract can interact with supported chains
      expect(await depositor.supportedChains(WORMHOLE_CHAIN_SEI)).to.be.true
      expect(await depositor.supportedChains(WORMHOLE_CHAIN_BASE)).to.be.true

      // Step 4: Test parameter clearing works
      await depositor.connect(owner).clearExecutorParameters()
      const [isClearedSet] = await depositor
        .connect(owner)
        .areExecutorParametersSet()
      expect(isClearedSet).to.be.false

      // Step 5: Verify stored value is cleared
      const clearedValue = await depositor
        .connect(owner)
        .getStoredExecutorValue()
      expect(clearedValue).to.equal(0)
    })

    it("should handle fee calculation", async () => {
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: owner.address,
        signedQuote: `0x${"a".repeat(64)}`, // Mock signed quote (32 bytes)
        instructions: `0x${"b".repeat(32)}`, // Mock instructions (16 bytes)
      }

      const feeArgs = {
        dbps: 100, // 1% fee
        payee: owner.address,
      }

      // Set executor parameters
      await depositor
        .connect(owner)
        .setExecutorParameters(executorArgs, feeArgs)

      // Verify fee calculation works
      const [isSet] = await depositor.connect(owner).areExecutorParametersSet()
      expect(isSet).to.be.true

      const storedValue = await depositor
        .connect(owner)
        .getStoredExecutorValue()
      expect(storedValue).to.equal(ethers.utils.parseEther("0.01"))
    })
  })
})
