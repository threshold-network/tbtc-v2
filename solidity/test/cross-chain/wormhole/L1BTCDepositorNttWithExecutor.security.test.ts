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

describe("L1BTCDepositorNttWithExecutor - Security Tests", () => {
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

  describe("Access Control", () => {
    it("should prevent non-owners from updating configuration", async () => {
      const [, , user] = await ethers.getSigners()

      // Non-owner cannot update default parameters
      await expect(
        depositor.connect(user).setDefaultParameters(600000, 50, user.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      // Non-owner cannot update NTT managers
      await expect(
        depositor.connect(user).updateUnderlyingNttManager(user.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      // Non-owner cannot update supported chains
      await expect(
        depositor.connect(user).setSupportedChain(99, true)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      // Non-owner cannot update default supported chain
      await expect(
        depositor.connect(user).setDefaultSupportedChain(WORMHOLE_CHAIN_BASE)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should prevent non-owners from retrieving tokens", async () => {
      const [, , user] = await ethers.getSigners()

      // Send some tokens to the contract
      const amount = ethers.utils.parseEther("1")
      await tbtcToken.mint(depositor.address, amount)

      // Non-owner cannot retrieve tokens
      await expect(
        depositor
          .connect(user)
          .retrieveTokens(tbtcToken.address, user.address, amount)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    // Note: updateReimbursementPool and updateReimbursementAuthorization functions
    // are not available in L1BTCDepositorNttWithExecutor contract
  })

  describe("Input Validation", () => {
    it("should reject invalid chain configurations", async () => {
      // Cannot set unsupported chain as default
      await expect(depositor.setDefaultSupportedChain(999)).to.be.revertedWith(
        "Chain must be supported before setting as default"
      )
    })

    it("should reject invalid executor parameters", async () => {
      const [, , user] = await ethers.getSigners()

      // Empty signed quote should be rejected
      const invalidExecutorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: "0x", // Empty quote
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 100,
        payee: user.address,
      }

      await expect(
        depositor
          .connect(user)
          .setExecutorParameters(invalidExecutorArgs, feeArgs)
      ).to.be.revertedWith(
        "Real signed quote from Wormhole Executor API is required"
      )
    })

    it("should reject operations on unsupported chains", async () => {
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
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](999)
      ).to.be.revertedWith("Destination chain not supported")
    })
  })

  describe("State Consistency", () => {
    it("should maintain consistent state during parameter updates", async () => {
      const [, , user] = await ethers.getSigners()

      // Initial state
      expect(await depositor.areExecutorParametersSet()).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)

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

      // Check state
      expect(await depositor.areExecutorParametersSet()).to.be.true
      expect(await depositor.getStoredExecutorValue()).to.equal(
        executorArgs.value
      )

      // Clear parameters
      await depositor.connect(user).clearExecutorParameters()

      // State should be reset
      expect(await depositor.areExecutorParametersSet()).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })

    it("should handle rapid parameter updates correctly", async () => {
      const [, , user] = await ethers.getSigners()

      // Perform multiple rapid updates
      // eslint-disable-next-line no-plusplus
      for (let i = 0; i < 3; i++) {
        const executorArgs = {
          value: ethers.utils.parseEther(`${i + 1}`),
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
          ethers.utils.parseEther(`${i + 1}`)
        )
      }
    })
  })

  describe("Edge Cases", () => {
    it("should handle maximum values correctly", async () => {
      const [, , user] = await ethers.getSigners()

      // Test with maximum possible amount
      const maxAmount = BigNumber.from(2).pow(256).sub(1)
      const executorArgs = {
        value: maxAmount,
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 10000, // 100% fee
        payee: user.address,
      }

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.not.be.reverted

      expect(await depositor.getStoredExecutorValue()).to.equal(maxAmount)
    })

    it("should handle zero values correctly", async () => {
      const [, , user] = await ethers.getSigners()

      const executorArgs = {
        value: BigNumber.from(0),
        refundAddress: user.address,
        signedQuote: `0x${"1".repeat(128)}`,
        instructions: `0x${"2".repeat(64)}`,
      }

      const feeArgs = {
        dbps: 0, // 0% fee
        payee: ethers.constants.AddressZero,
      }

      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.not.be.reverted

      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })
  })
})
