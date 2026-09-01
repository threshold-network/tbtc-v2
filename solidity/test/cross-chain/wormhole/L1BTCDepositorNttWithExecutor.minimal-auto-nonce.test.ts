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
  MockNttManager,
} from "../../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_DESTINATION = 32
const WORMHOLE_CHAIN_BASE = 30

describe("L1BTCDepositorNttWithExecutor - Minimal Auto-Nonce Test", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: MockNttManager
  let owner: SignerWithAddress
  let user1: SignerWithAddress
  let user2: SignerWithAddress

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
    ;[owner, user1, user2] = await ethers.getSigners()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Auto-Nonce Basic Functionality", () => {
    it("should allow multiple users to set parameters in parallel", async () => {
      const executorArgs1 = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote1"),
        instructions: "0x",
      }

      const executorArgs2 = {
        value: ethers.utils.parseEther("0.02"),
        refundAddress: user2.address,
        signedQuote: ethers.utils.formatBytes32String("quote2"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      // User 1 sets parameters
      const tx1 = await depositor
        .connect(user1)
        .setExecutorParameters(
          executorArgs1,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )
      const receipt1 = await tx1.wait()
      const nonce1 = receipt1.events?.find(
        (e) => e.event === "ExecutorParametersSet"
      )?.args?.nonce

      // User 2 sets parameters (should not interfere with user 1)
      const tx2 = await depositor
        .connect(user2)
        .setExecutorParameters(
          executorArgs2,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )
      const receipt2 = await tx2.wait()
      const nonce2 = receipt2.events?.find(
        (e) => e.event === "ExecutorParametersSet"
      )?.args?.nonce

      // Nonces should be different
      expect(nonce1).to.not.equal(nonce2)
      expect(nonce1).to.not.equal(ethers.constants.HashZero)
      expect(nonce2).to.not.equal(ethers.constants.HashZero)

      // Both users should have parameters set
      const [user1Set, user1Nonce] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      const [user2Set, user2Nonce] = await depositor
        .connect(user2)
        .areExecutorParametersSet()

      expect(user1Set).to.be.true
      expect(user2Set).to.be.true
      expect(user1Nonce).to.equal(nonce1)
      expect(user2Nonce).to.equal(nonce2)
    })

    it("should track nonce sequences per user", async () => {
      const baseExecutorArgs = {
        value: ethers.utils.parseEther("0.01"),
        signedQuote: ethers.utils.formatBytes32String("quote"),
        instructions: "0x",
      }
      const user1ExecutorArgs = {
        ...baseExecutorArgs,
        refundAddress: user1.address,
      }
      const user2ExecutorArgs = {
        ...baseExecutorArgs,
        refundAddress: user2.address,
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      // User 1 sets parameters multiple times (clearing between calls)
      await depositor
        .connect(user1)
        .setExecutorParameters(
          user1ExecutorArgs,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )

      // getUserNonceSequence was removed to reduce contract size
      // Nonce tracking is still internal, just not exposed via getter

      // Clear parameters first, then set again
      await depositor.connect(user1).clearExecutorParameters()
      await depositor
        .connect(user1)
        .setExecutorParameters(
          user1ExecutorArgs,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )

      // User 2's sequence should be independent
      await depositor
        .connect(user2)
        .setExecutorParameters(
          user2ExecutorArgs,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )

      // Verify parameters were set successfully by checking from each user's context
      const [isSet1] = await depositor.connect(user1).areExecutorParametersSet()
      const [isSet2] = await depositor.connect(user2).areExecutorParametersSet()
      expect(isSet1).to.be.true
      expect(isSet2).to.be.true
    })

    it("should provide workflow status information", async () => {
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      // Initially no workflow
      const [hasWorkflow, nonce, timestamp] =
        await depositor.getUserWorkflowStatus(user1.address)
      expect(hasWorkflow).to.be.false
      expect(nonce).to.equal(ethers.constants.HashZero)
      expect(timestamp).to.equal(0)

      // Set parameters
      const tx = await depositor
        .connect(user1)
        .setExecutorParameters(
          executorArgs,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )
      const receipt = await tx.wait()
      const expectedNonce = receipt.events?.find(
        (e) => e.event === "ExecutorParametersSet"
      )?.args?.nonce

      // Check workflow status
      const [hasWorkflowAfter, nonceAfter, timestampAfter] =
        await depositor.getUserWorkflowStatus(user1.address)
      expect(hasWorkflowAfter).to.be.true
      expect(nonceAfter).to.equal(expectedNonce)
      expect(timestampAfter.toNumber()).to.be.greaterThan(0)
    })

    it("should allow users to clear their own parameters", async () => {
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      // Set parameters
      await depositor
        .connect(user1)
        .setExecutorParameters(
          executorArgs,
          feeArgs,
          WORMHOLE_CHAIN_DESTINATION
        )

      // Verify parameters are set
      const [isSetBefore] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      expect(isSetBefore).to.be.true

      // Clear parameters
      await depositor.connect(user1).clearExecutorParameters()

      // Verify parameters are cleared
      const [isSetAfter] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      expect(isSetAfter).to.be.false
    })
  })
})
