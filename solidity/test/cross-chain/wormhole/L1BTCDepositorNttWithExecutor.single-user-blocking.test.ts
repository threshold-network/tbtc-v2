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

describe("L1BTCDepositorNttWithExecutor - Single User Blocking", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: TestERC20
  let owner: SignerWithAddress
  let user1: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[owner, user1] = await ethers.getSigners()

    // Deploy mock contracts following the working pattern
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

    // Use a simple ERC20 as underlying NTT manager
    underlyingNttManager = await TestERC20Factory.deploy()

    // Set up mock NTT manager to support our test chains
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)

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
    await depositor.setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)

    // Set parameter expiration time to 1 hour for testing
    await depositor.setParameterExpirationTime(3600)

    // Get owner address for platform fee recipient
    const [ownerAddr] = await ethers.getSigners()
    
    // Set default platform fee to allow owner.address as payee (fee theft fix compatibility)
    await depositor.setDefaultParameters(
      500000, // gas limit
      0, // executor fee
      ethers.constants.AddressZero, // executor fee recipient
      100, // 0.1% platform fee
      ownerAddr.address // platform fee recipient (matches test payee addresses)
    )
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Single User Workflow Blocking", () => {
    it("should allow user to set parameters initially", async () => {
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote1"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      // First call should succeed
      await expect(
        depositor.connect(user1).setExecutorParameters(executorArgs, feeArgs)
      ).to.not.be.reverted

      // Check that parameters are set
      const [isSet, nonce] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      expect(isSet).to.be.true
      expect(nonce).to.not.equal(ethers.constants.HashZero)
    })

    it("should allow user to refresh parameters when first workflow is active", async () => {
      const executorArgs1 = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote1"),
        instructions: "0x",
      }

      const executorArgs2 = {
        value: ethers.utils.parseEther("0.02"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote2"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      // First call should succeed
      const tx1 = await depositor
        .connect(user1)
        .setExecutorParameters(executorArgs1, feeArgs)
      const receipt1 = await tx1.wait()
      const event1 = receipt1.events?.find(
        (e) => e.event === "ExecutorParametersSet"
      )
      const initialNonce = event1?.args?.nonce

      // Second call should refresh parameters (not block)
      const tx2 = await depositor
        .connect(user1)
        .setExecutorParameters(executorArgs2, feeArgs)
      const receipt2 = await tx2.wait()
      const event2 = receipt2.events?.find(
        (e) => e.event === "ExecutorParametersRefreshed"
      )

      // Should emit ExecutorParametersRefreshed event
      expect(event2).to.not.be.undefined
      expect(event2?.args?.sender).to.equal(user1.address)
      expect(event2?.args?.nonce).to.equal(initialNonce) // Same nonce
      expect(event2?.args?.executorValue).to.equal(
        ethers.utils.parseEther("0.02")
      )

      // Parameters should still be set
      const [isSet] = await depositor.connect(user1).areExecutorParametersSet()
      expect(isSet).to.be.true

      // Stored value should be updated
      const storedValue = await depositor
        .connect(user1)
        .getStoredExecutorValue()
      expect(storedValue).to.equal(ethers.utils.parseEther("0.02"))
    })

    it("should allow user to start new workflow after clearing previous one", async () => {
      const executorArgs1 = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote1"),
        instructions: "0x",
      }

      const executorArgs2 = {
        value: ethers.utils.parseEther("0.02"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote2"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      // Set first parameters
      await depositor
        .connect(user1)
        .setExecutorParameters(executorArgs1, feeArgs)

      // Clear parameters
      await depositor.connect(user1).clearExecutorParameters()

      // Now should be able to set new parameters
      await expect(
        depositor.connect(user1).setExecutorParameters(executorArgs2, feeArgs)
      ).to.not.be.reverted

      // Check that new parameters are set
      const [isSet, nonce] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      expect(isSet).to.be.true
      expect(nonce).to.not.equal(ethers.constants.HashZero)
    })

    it("should allow user to start new workflow after expiration", async () => {
      const executorArgs1 = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote1"),
        instructions: "0x",
      }

      const executorArgs2 = {
        value: ethers.utils.parseEther("0.02"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote2"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      // Set first parameters
      await depositor
        .connect(user1)
        .setExecutorParameters(executorArgs1, feeArgs)

      // Fast forward time to expire parameters (1 hour + 1 second)
      await ethers.provider.send("evm_increaseTime", [3601])
      await ethers.provider.send("evm_mine", [])

      // Now should be able to set new parameters (expired workflow)
      await expect(
        depositor.connect(user1).setExecutorParameters(executorArgs2, feeArgs)
      ).to.not.be.reverted

      // Check that new parameters are set
      const [isSet, nonce] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      expect(isSet).to.be.true
      expect(nonce).to.not.equal(ethers.constants.HashZero)
    })

    it("should allow multiple users to work in parallel", async () => {
      const [, , user2, user3] = await ethers.getSigners()

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

      const executorArgs3 = {
        value: ethers.utils.parseEther("0.03"),
        refundAddress: user3.address,
        signedQuote: ethers.utils.formatBytes32String("quote3"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      // All users should be able to set parameters in parallel
      await expect(
        depositor.connect(user1).setExecutorParameters(executorArgs1, feeArgs)
      ).to.not.be.reverted

      await expect(
        depositor.connect(user2).setExecutorParameters(executorArgs2, feeArgs)
      ).to.not.be.reverted

      await expect(
        depositor.connect(user3).setExecutorParameters(executorArgs3, feeArgs)
      ).to.not.be.reverted

      // Each user should have their own workflow
      const [user1Set, user1Nonce] = await depositor
        .connect(user1)
        .areExecutorParametersSet()
      const [user2Set, user2Nonce] = await depositor
        .connect(user2)
        .areExecutorParametersSet()
      const [user3Set, user3Nonce] = await depositor
        .connect(user3)
        .areExecutorParametersSet()

      expect(user1Set).to.be.true
      expect(user2Set).to.be.true
      expect(user3Set).to.be.true

      // Nonces should be different
      expect(user1Nonce).to.not.equal(user2Nonce)
      expect(user2Nonce).to.not.equal(user3Nonce)
      expect(user1Nonce).to.not.equal(user3Nonce)
    })

    it("should emit ExecutorParametersRefreshed event when refreshing parameters", async () => {
      const executorArgs1 = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote1"),
        instructions: "0x",
      }

      const executorArgs2 = {
        value: ethers.utils.parseEther("0.02"),
        refundAddress: user1.address,
        signedQuote: ethers.utils.formatBytes32String("quote2"),
        instructions: "0x",
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      // Set first parameters
      const tx1 = await depositor
        .connect(user1)
        .setExecutorParameters(executorArgs1, feeArgs)
      const receipt1 = await tx1.wait()
      const event1 = receipt1.events?.find(
        (e) => e.event === "ExecutorParametersSet"
      )
      const initialNonce = event1?.args?.nonce

      // Try to set second parameters - should refresh with ExecutorParametersRefreshed event
      const tx2 = await depositor
        .connect(user1)
        .setExecutorParameters(executorArgs2, feeArgs)
      const receipt2 = await tx2.wait()
      const event2 = receipt2.events?.find(
        (e) => e.event === "ExecutorParametersRefreshed"
      )

      // Should emit ExecutorParametersRefreshed event with correct parameters
      expect(event2).to.not.be.undefined
      expect(event2?.args?.sender).to.equal(user1.address)
      expect(event2?.args?.nonce).to.equal(initialNonce)
      expect(event2?.args?.signedQuoteLength).to.equal(32) // formatBytes32String creates 32 bytes
      expect(event2?.args?.executorValue).to.equal(
        ethers.utils.parseEther("0.02")
      )
    })
  })
})
