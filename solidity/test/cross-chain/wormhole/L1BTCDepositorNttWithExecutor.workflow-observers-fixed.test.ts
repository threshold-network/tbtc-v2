import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
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

describe("L1BTCDepositorNttWithExecutor - Workflow Observers", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: TestERC20

  before(async () => {
    // Deploy mock contracts following the working pattern from executor.test.ts
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

    // Use a simple ERC20 as underlying NTT manager (just need an address)
    underlyingNttManager = await TestERC20Factory.deploy()

    // Set up mock NTT manager to support our test chains
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)

    // Deploy main contract with proxy following the working pattern
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

  describe("Workflow Observer Functions", () => {
    it("should provide initial workflow status", async () => {
      const [hasWorkflow, nonce, timestamp] =
        await depositor.getUserWorkflowStatus(ethers.constants.AddressZero)
      expect(hasWorkflow).to.be.false
      expect(nonce).to.equal(ethers.constants.HashZero)
      expect(timestamp).to.equal(0)
    })

    it("should allow user to start new workflow initially", async () => {
      const [canStart, reason] = await depositor.canUserStartNewWorkflow(
        ethers.constants.AddressZero
      )
      expect(canStart).to.be.true
      expect(reason).to.equal("")
    })

    it("should track nonce sequences per user", async () => {
      const user1 = ethers.Wallet.createRandom().address
      const user2 = ethers.Wallet.createRandom().address

      // Initially sequence should be 0
      const sequence1 = await depositor.getUserNonceSequence(user1)
      const sequence2 = await depositor.getUserNonceSequence(user2)
      expect(sequence1).to.equal(0)
      expect(sequence2).to.equal(0)

      // Test that different users have independent sequences
      // We can't test nonce generation directly since it's internal,
      // but we can test the sequence tracking
      expect(sequence1).to.equal(sequence2) // Both start at 0
    })

    it("should provide comprehensive workflow information", async () => {
      const user = ethers.Wallet.createRandom().address

      const workflowInfo = await depositor.getUserWorkflowInfo(user)
      expect(workflowInfo.hasActiveWorkflow).to.be.false
      expect(workflowInfo.nonce).to.equal(ethers.constants.HashZero)
      expect(workflowInfo.timestamp).to.equal(0)
      expect(workflowInfo.timeRemaining).to.equal(0)
      expect(workflowInfo.canStartNew).to.be.true
      expect(workflowInfo.reason).to.equal("")
    })

    it("should handle nonce status queries", async () => {
      const nonExistentNonce = ethers.constants.HashZero

      const [exists, expired, user] = await depositor.getNonceStatus(
        nonExistentNonce
      )
      expect(exists).to.be.false
      expect(expired).to.be.false
      expect(user).to.equal(ethers.constants.AddressZero)
    })
  })

  describe("Parameter Expiration", () => {
    it("should have configurable expiration time", async () => {
      const currentExpiration = await depositor.parameterExpirationTime()
      // The initial value is 0 (not initialized)
      expect(currentExpiration).to.equal(0)

      // Test setting new expiration time (only owner can do this)
      const newExpirationTime = 7200 // 2 hours
      await depositor.setParameterExpirationTime(newExpirationTime)

      const updatedExpiration = await depositor.parameterExpirationTime()
      expect(updatedExpiration).to.equal(newExpirationTime)
    })

    it("should reject invalid expiration times", async () => {
      await expect(depositor.setParameterExpirationTime(0)).to.be.revertedWith(
        "Expiration time must be greater than 0"
      )
    })
  })

  describe("Multi-User Support", () => {
    it("should track independent sequences for different users", async () => {
      const user1 = ethers.Wallet.createRandom().address
      const user2 = ethers.Wallet.createRandom().address

      // Both users should start with sequence 0
      const sequence1 = await depositor.getUserNonceSequence(user1)
      const sequence2 = await depositor.getUserNonceSequence(user2)

      expect(sequence1).to.equal(0)
      expect(sequence2).to.equal(0)
      expect(sequence1).to.equal(sequence2) // Both start at 0
    })

    it("should provide workflow status for different users", async () => {
      const user1 = ethers.Wallet.createRandom().address
      const user2 = ethers.Wallet.createRandom().address

      // Both users should have no active workflow initially
      const [canStart1, reason1] = await depositor.canUserStartNewWorkflow(
        user1
      )
      const [canStart2, reason2] = await depositor.canUserStartNewWorkflow(
        user2
      )

      expect(canStart1).to.be.true
      expect(canStart2).to.be.true
      expect(reason1).to.equal("")
      expect(reason2).to.equal("")
    })
  })

  describe("Backward Compatibility", () => {
    it("should maintain existing areExecutorParametersSet behavior", async () => {
      // Test the new signature that returns (bool, bytes32)
      const [isSet, nonce] = await depositor.areExecutorParametersSet()
      expect(isSet).to.be.false
      expect(nonce).to.equal(ethers.constants.HashZero)
    })

    it("should maintain existing getStoredExecutorValue behavior", async () => {
      const value = await depositor.getStoredExecutorValue()
      expect(value).to.equal(0)
    })
  })
})
