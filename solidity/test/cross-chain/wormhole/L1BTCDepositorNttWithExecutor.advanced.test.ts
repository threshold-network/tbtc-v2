import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
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

  before(async () => {
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
      expect(await depositor.areExecutorParametersSet()).to.be.false
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
      expect(await depositor.areExecutorParametersSet()).to.be.false

      // Should not revert even when clearing non-existent parameters
      await expect(depositor.clearExecutorParameters()).to.not.be.reverted

      expect(await depositor.areExecutorParametersSet()).to.be.false
    })

    it("should maintain consistent state", async () => {
      // Initial state should be consistent
      expect(await depositor.areExecutorParametersSet()).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)

      // After clearing, state should remain consistent
      await depositor.clearExecutorParameters()
      expect(await depositor.areExecutorParametersSet()).to.be.false
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
        "Must call setExecutorParameters() first with real signed quote"
      )
    })

    it("should revert on quote with chain parameter without executor parameters", async () => {
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_SEI)
      ).to.be.revertedWith(
        "Must call setExecutorParameters() first with real signed quote"
      )
    })
  })

  describe("Complex Scenarios", () => {
    it.skip("should handle complete deposit flow - SKIPPED: Requires complex bridge setup", async () => {
      // Skip complex integration test that requires extensive mocking
    })

    it.skip("should handle NTT transfer execution - SKIPPED: Requires real NTT manager", async () => {
      // Skip test that requires real NTT manager implementation
    })

    it.skip("should handle fee calculation - SKIPPED: Requires executor parameters", async () => {
      // Skip test that requires real Wormhole executor signed quotes
    })
  })
})
