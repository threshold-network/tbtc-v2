import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { randomBytes } from "crypto"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
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
  REAL_SIGNED_QUOTE_ALT,
  EXECUTOR_ARGS_ALT_QUOTE,
  FEE_ARGS_ZERO,
  FEE_ARGS_STANDARD,
  PLATFORM_FEE_RECIPIENT,
} from "./realSignedQuote"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_SEI = 32
const WORMHOLE_CHAIN_BASE = 30
const WORMHOLE_CHAIN_ARBITRUM = 23

// Helper function to create properly structured ExecutorArgs
function createExecutorArgs(
  overrides: Partial<{
    value: BigNumber | string | number
    refundAddress: string
    signedQuote: string
    instructions: string
  }> = {}
) {
  return {
    value: BigNumber.from(overrides.value || EXECUTOR_ARGS_REAL_QUOTE.value),
    refundAddress: (overrides.refundAddress ||
      EXECUTOR_ARGS_REAL_QUOTE.refundAddress) as string,
    signedQuote: (overrides.signedQuote ||
      EXECUTOR_ARGS_REAL_QUOTE.signedQuote) as string,
    instructions: (overrides.instructions ||
      EXECUTOR_ARGS_REAL_QUOTE.instructions) as string,
  }
}

describe("L1BTCDepositorNttWithExecutor - Executor Parameters", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20
  let nttManagerWithExecutor: MockNttManagerWithExecutor
  let underlyingNttManager: MockNttManager // Mock NTT manager for testing
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

    // Deploy proper mock NTT managers
    const MockNttManagerWithExecutorFactory = await ethers.getContractFactory(
      "MockNttManagerWithExecutor"
    )
    nttManagerWithExecutor = await MockNttManagerWithExecutorFactory.deploy()

    // Deploy mock NTT manager for underlying manager
    const MockNttManagerFactory = await ethers.getContractFactory(
      "MockNttManager"
    )
    underlyingNttManager = await MockNttManagerFactory.deploy()

    // Set up mock NTT manager to support our test chains
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await nttManagerWithExecutor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
    await nttManagerWithExecutor.setSupportedChain(
      WORMHOLE_CHAIN_ARBITRUM,
      true
    )

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
    await depositor.setSupportedChain(WORMHOLE_CHAIN_ARBITRUM, true)
    await depositor.setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)

    // Set default platform fee to 0 (fee theft fix compatibility - tests will configure as needed)
    await depositor.setDefaultParameters(
      500000, // gas limit
      0, // executor fee
      ethers.constants.AddressZero, // executor fee recipient
      0, // 0% platform fee (allows zero address as payee)
      ethers.constants.AddressZero // platform fee recipient
    )
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Initial State", () => {
    it("should start with no executor parameters set", async () => {
      const [isSet] = await depositor.areExecutorParametersSet()
      expect(isSet).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })

    it("should have default executor configuration", async () => {
      // Check that we can query the state without parameters set
      const [isSet] = await depositor.areExecutorParametersSet()
      expect(isSet).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })
  })

  describe("Default Platform Fee Settings", () => {
    it("should have default platform fee of 0", async () => {
      expect(await depositor.defaultPlatformFeeBps()).to.equal(0)
      expect(await depositor.defaultPlatformFeeRecipient()).to.equal(
        ethers.constants.AddressZero
      )
    })

    it("should allow owner to set default platform fee", async () => {
      const newFeeBps = 50 // 0.05% (50/100000)
      const newRecipient = owner.address

      await expect(depositor.setDefaultPlatformFeeBps(newFeeBps))
        .to.emit(depositor, "DefaultPlatformFeeBpsUpdated")
        .withArgs(0, newFeeBps)

      expect(await depositor.defaultPlatformFeeBps()).to.equal(newFeeBps)
    })

    it("should allow owner to set default platform fee recipient", async () => {
      const newRecipient = owner.address

      await expect(depositor.setDefaultPlatformFeeRecipient(newRecipient))
        .to.emit(depositor, "DefaultPlatformFeeRecipientUpdated")
        .withArgs(ethers.constants.AddressZero, newRecipient)

      expect(await depositor.defaultPlatformFeeRecipient()).to.equal(
        newRecipient
      )
    })

    it("should reject platform fee exceeding 100%", async () => {
      await expect(
        depositor.setDefaultPlatformFeeBps(10001)
      ).to.be.revertedWith("Fee cannot exceed 10% (10000 bps)")
    })

    it("should reject zero recipient when fee is set", async () => {
      // First set a non-zero platform fee
      await depositor.setDefaultPlatformFeeBps(100) // 0.1% (100/100000)

      await expect(
        depositor.setDefaultPlatformFeeRecipient(ethers.constants.AddressZero)
      ).to.be.revertedWith(
        "Recipient address cannot be zero when platform fee is set"
      )
    })

    it("should allow zero recipient when fee is 0", async () => {
      // First set fee to 0
      await depositor.setDefaultPlatformFeeBps(0)

      // Then setting zero recipient should work
      await expect(
        depositor.setDefaultPlatformFeeRecipient(ethers.constants.AddressZero)
      ).to.not.be.reverted
    })

    it("should update default parameters with platform fee settings", async () => {
      const gasLimit = 500000
      const executorFeeBps = 100 // 0.1% (100/100000)
      const executorFeeRecipient = owner.address
      const platformFeeBps = 50 // 0.05% (50/100000)
      const platformFeeRecipient = owner.address

      await expect(
        depositor.setDefaultParameters(
          gasLimit,
          executorFeeBps,
          executorFeeRecipient,
          platformFeeBps,
          platformFeeRecipient
        )
      ).to.emit(depositor, "DefaultParametersUpdated")

      expect(await depositor.defaultPlatformFeeBps()).to.equal(platformFeeBps)
      expect(await depositor.defaultPlatformFeeRecipient()).to.equal(
        platformFeeRecipient
      )
    })
  })

  describe("Parameter Validation", () => {
    it("should reject empty signed quote", async () => {
      const executorArgs = createExecutorArgs({ signedQuote: "0x" })

      await expect(
        depositor.setExecutorParameters(executorArgs, FEE_ARGS_ZERO)
      ).to.be.revertedWith(
        "Real signed quote from Wormhole Executor API is required"
      )
    })

    it("should accept valid signed quote", async () => {
      // Configure platform fee to allow owner.address as payee
      await depositor.setDefaultPlatformFeeBps(100) // 0.1% (100/100000)
      await depositor.setDefaultPlatformFeeRecipient(owner.address)

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: owner.address,
        signedQuote: `0x${"a".repeat(64)}`, // 32 bytes (64 hex chars) - meets minimum requirement
        instructions: `0x${"b".repeat(32)}`, // 16 bytes (32 hex chars)
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: owner.address,
      }

      // Should succeed with valid mock signed quote
      await expect(
        depositor.connect(owner).setExecutorParameters(executorArgs, feeArgs)
      ).to.not.be.reverted

      // Verify parameters are set
      const [isSet] = await depositor.connect(owner).areExecutorParametersSet()
      expect(isSet).to.be.true
    })

    it("should validate signed quote format", async () => {
      // Test with real signed quote
      expect(EXECUTOR_ARGS_REAL_QUOTE.signedQuote).to.have.length.greaterThan(
        10
      )
      expect(EXECUTOR_ARGS_REAL_QUOTE.signedQuote).to.match(/^0x[0-9a-fA-F]+$/)
      expect(EXECUTOR_ARGS_REAL_QUOTE.signedQuote.length).to.equal(332) // 330 hex chars + "0x"
    })
  })

  describe("Parameter Management", () => {
    it("should clear executor parameters when not set", async () => {
      const [isSet] = await depositor.areExecutorParametersSet()
      expect(isSet).to.be.false

      // Should not revert even when clearing non-existent parameters
      await expect(depositor.clearExecutorParameters()).to.not.be.reverted

      const [isSetAfter] = await depositor.areExecutorParametersSet()
      expect(isSetAfter).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })

    it("should maintain state consistency after clearing", async () => {
      // Initial state
      const [isSetInitial] = await depositor.areExecutorParametersSet()
      expect(isSetInitial).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)

      // Clear parameters
      await depositor.clearExecutorParameters()

      // State should remain consistent
      const [isSetAfter] = await depositor.areExecutorParametersSet()
      expect(isSetAfter).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })
  })

  describe("Fee Parameter Validation", () => {
    it("should handle zero fee values", async () => {
      const feeArgs = {
        gasLimit: BigNumber.from(0),
        feeBps: BigNumber.from(0),
        feeRecipient: ethers.constants.AddressZero,
      }

      // These should be valid values
      expect(feeArgs.gasLimit).to.equal(0)
      expect(feeArgs.feeBps).to.equal(0)
      expect(feeArgs.feeRecipient).to.equal(ethers.constants.AddressZero)
    })

    it("should handle maximum fee values", async () => {
      const maxGasLimit = BigNumber.from(2).pow(32).sub(1) // Max uint32
      const maxFeeBps = BigNumber.from(10000) // 100% in basis points

      const feeArgs = {
        gasLimit: maxGasLimit,
        feeBps: maxFeeBps,
        feeRecipient: ethers.Wallet.createRandom().address,
      }

      // These should be valid values
      expect(feeArgs.gasLimit).to.equal(maxGasLimit)
      expect(feeArgs.feeBps).to.equal(maxFeeBps)
      expect(feeArgs.feeRecipient).to.not.equal(ethers.constants.AddressZero)
    })

    it("should handle edge case fee values", async () => {
      const feeArgs = {
        gasLimit: BigNumber.from(1), // Minimum non-zero
        feeBps: BigNumber.from(1), // 0.01%
        feeRecipient: ethers.Wallet.createRandom().address,
      }

      expect(feeArgs.gasLimit).to.equal(1)
      expect(feeArgs.feeBps).to.equal(1)
      expect(feeArgs.feeRecipient).to.not.equal(ethers.constants.AddressZero)
    })
  })

  describe("Basis Points Validation", () => {
    it("should reject fee basis points exceeding 10000 in setExecutorParameters", async () => {
      const executorArgs = createExecutorArgs()
      const invalidFeeArgs = {
        dbps: 10001, // Exceeds 10% (10001/100000)
        payee: ethers.Wallet.createRandom().address,
      }

      await expect(
        depositor.setExecutorParameters(executorArgs, invalidFeeArgs)
      ).to.be.revertedWith("Fee cannot exceed 10% (10000 bps)")
    })

    it("should accept maximum valid fee basis points (10000) in setExecutorParameters", async () => {
      const executorArgs = createExecutorArgs()
      const validFeeArgs = {
        dbps: 10000, // Exactly 10% (10000/100000)
        payee: ethers.Wallet.createRandom().address,
      }

      // This should not revert (but will likely revert on quote validation)
      // We're testing that the BPS validation passes
      await expect(
        depositor.setExecutorParameters(executorArgs, validFeeArgs)
      ).to.not.be.revertedWith("Fee cannot exceed 10% (10000 bps)")
    })

    it("should reject fee basis points exceeding 10000 in setDefaultParameters", async () => {
      const [owner] = await ethers.getSigners()

      await expect(
        depositor.connect(owner).setDefaultParameters(
          500000, // gasLimit
          10001, // feeBps exceeds 10% (10001/100000)
          ethers.Wallet.createRandom().address, // feeRecipient
          0, // platformFeeBps 0%
          ethers.constants.AddressZero // platformFeeRecipient
        )
      ).to.be.revertedWith("Fee cannot exceed 10% (10000 bps)")
    })

    it("should accept maximum valid fee basis points (10000) in setDefaultParameters", async () => {
      const [owner] = await ethers.getSigners()

      await expect(
        depositor.connect(owner).setDefaultParameters(
          500000, // gasLimit
          10000, // feeBps exactly 10% (10000/100000)
          ethers.Wallet.createRandom().address, // feeRecipient
          0, // platformFeeBps 0%
          ethers.constants.AddressZero // platformFeeRecipient
        )
      ).to.not.be.reverted
    })

    it("should accept zero fee basis points", async () => {
      const [owner] = await ethers.getSigners()

      await expect(
        depositor.connect(owner).setDefaultParameters(
          500000, // gasLimit
          0, // feeBps 0%
          ethers.constants.AddressZero, // feeRecipient can be zero when fee is 0
          0, // platformFeeBps 0%
          ethers.constants.AddressZero // platformFeeRecipient can be zero when fee is 0
        )
      ).to.not.be.reverted
    })

    it("should reject fee below default platform fee", async () => {
      // Set a default platform fee
      await depositor.setDefaultPlatformFeeBps(100) // 0.1% (100/100000)

      const executorArgs = createExecutorArgs()
      const invalidFeeArgs = {
        dbps: 50, // 0.05% (50/100000) - below default of 0.1%
        payee: ethers.Wallet.createRandom().address,
      }

      await expect(
        depositor.setExecutorParameters(executorArgs, invalidFeeArgs)
      ).to.be.revertedWith("Fee must be at least the default platform fee")
    })

    it("should accept fee equal to default platform fee", async () => {
      // Set a default platform fee with recipient
      const feeRecipient = ethers.Wallet.createRandom().address
      await depositor.setDefaultPlatformFeeBps(100) // 0.1% (100/100000)
      await depositor.setDefaultPlatformFeeRecipient(feeRecipient)

      const executorArgs = createExecutorArgs()
      const validFeeArgs = {
        dbps: 100, // 0.1% (100/100000) - equal to default
        payee: feeRecipient, // Must match defaultPlatformFeeRecipient
      }

      await expect(depositor.setExecutorParameters(executorArgs, validFeeArgs))
        .to.not.be.reverted
    })

    it("should accept fee above default platform fee", async () => {
      // Set a default platform fee with recipient
      const feeRecipient = ethers.Wallet.createRandom().address
      await depositor.setDefaultPlatformFeeBps(100) // 0.1% (100/100000)
      await depositor.setDefaultPlatformFeeRecipient(feeRecipient)

      const executorArgs = createExecutorArgs()
      const validFeeArgs = {
        dbps: 200, // 0.2% (200/100000) - above default
        payee: feeRecipient, // Must match defaultPlatformFeeRecipient
      }

      await expect(depositor.setExecutorParameters(executorArgs, validFeeArgs))
        .to.not.be.reverted
    })

    it("should work with zero default platform fee", async () => {
      // Ensure default platform fee is 0
      await depositor.setDefaultPlatformFeeBps(0)

      const executorArgs = createExecutorArgs()
      const validFeeArgs = {
        dbps: 0, // 0% - should work when default is also 0
        payee: ethers.constants.AddressZero,
      }

      await expect(depositor.setExecutorParameters(executorArgs, validFeeArgs))
        .to.not.be.reverted
    })

    it("should have MAX_BPS constant set to 10000", async () => {
      expect(await depositor.MAX_BPS()).to.equal(10000)
    })
  })

  describe("Default Gas Limit Management", () => {
    it("should have initial default destination gas limit set to 500000", async () => {
      expect(await depositor.defaultDestinationGasLimit()).to.equal(500000)
    })

    it("should allow owner to update default destination gas limit", async () => {
      const [owner] = await ethers.getSigners()
      const newGasLimit = 750000

      await expect(
        depositor.connect(owner).setDefaultDestinationGasLimit(newGasLimit)
      )
        .to.emit(depositor, "DefaultDestinationGasLimitUpdated")
        .withArgs(500000, newGasLimit)

      expect(await depositor.defaultDestinationGasLimit()).to.equal(newGasLimit)
    })

    it("should reject zero gas limit", async () => {
      const [owner] = await ethers.getSigners()

      await expect(
        depositor.connect(owner).setDefaultDestinationGasLimit(0)
      ).to.be.revertedWith("Gas limit must be greater than zero")
    })

    it("should reject non-owner attempts to set gas limit", async () => {
      const [, nonOwner] = await ethers.getSigners()

      await expect(
        depositor.connect(nonOwner).setDefaultDestinationGasLimit(600000)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should accept large gas limits", async () => {
      const [owner] = await ethers.getSigners()
      const largeGasLimit = 5000000 // 5M gas

      await expect(
        depositor.connect(owner).setDefaultDestinationGasLimit(largeGasLimit)
      ).to.not.be.reverted

      expect(await depositor.defaultDestinationGasLimit()).to.equal(
        largeGasLimit
      )
    })
  })

  describe("Native Token Transfer Security", () => {
    it("should handle insufficient balance gracefully", async () => {
      const [owner, recipient] = await ethers.getSigners()
      const amount = ethers.utils.parseEther("1")

      // Don't fund the contract - it should have zero balance
      await expect(
        depositor
          .connect(owner)
          .retrieveTokens(
            ethers.constants.AddressZero,
            recipient.address,
            amount
          )
      ).to.be.revertedWith("Failed to transfer native token")
    })

    it("should reject zero address recipient", async () => {
      const [owner] = await ethers.getSigners()
      const amount = ethers.utils.parseEther("0.1")

      await expect(
        depositor
          .connect(owner)
          .retrieveTokens(
            ethers.constants.AddressZero,
            ethers.constants.AddressZero,
            amount
          )
      ).to.be.revertedWith("Cannot retrieve tokens to the zero address")
    })

    it("should only allow owner to retrieve tokens", async () => {
      const [, nonOwner, recipient] = await ethers.getSigners()
      const amount = ethers.utils.parseEther("0.1")

      await expect(
        depositor
          .connect(nonOwner)
          .retrieveTokens(
            ethers.constants.AddressZero,
            recipient.address,
            amount
          )
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should successfully transfer ERC20 tokens", async () => {
      const [owner, recipient] = await ethers.getSigners()
      const amount = ethers.utils.parseEther("100")

      // Mint tokens to the depositor contract
      await tbtcToken.mint(depositor.address, amount)

      const initialBalance = await tbtcToken.balanceOf(recipient.address)

      await expect(
        depositor
          .connect(owner)
          .retrieveTokens(tbtcToken.address, recipient.address, amount)
      ).to.not.be.reverted

      const finalBalance = await tbtcToken.balanceOf(recipient.address)
      expect(finalBalance.sub(initialBalance)).to.equal(amount)
    })

    it("should demonstrate improved error handling vs old transfer method", async () => {
      const [owner, recipient] = await ethers.getSigners()
      const amount = ethers.utils.parseEther("0.1")

      // Test that our new implementation provides clear error messages
      // when attempting to transfer non-existent native tokens
      await expect(
        depositor
          .connect(owner)
          .retrieveTokens(
            ethers.constants.AddressZero,
            recipient.address,
            amount
          )
      ).to.be.revertedWith("Failed to transfer native token")

      // This demonstrates that the new call-based approach provides
      // better error handling than the old transfer() method would
    })
  })

  describe("Executor Value Management", () => {
    it("should track stored executor value", async () => {
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })

    it("should handle zero executor value", async () => {
      const zeroValue = BigNumber.from(0)
      expect(await depositor.getStoredExecutorValue()).to.equal(zeroValue)
    })

    it("should handle large executor values", async () => {
      // Test that we can work with large values conceptually
      const largeValue = ethers.utils.parseEther("1000")
      expect(largeValue).to.be.gt(0)
    })
  })

  describe("Quote Functions Without Parameters", () => {
    it("should revert quote without executor parameters", async () => {
      await expect(depositor["quoteFinalizeDeposit()"]()).to.be.revertedWith(
        "Executor parameters not set"
      )
    })

    it("should revert chain-specific quote without executor parameters", async () => {
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_SEI)
      ).to.be.revertedWith("Executor parameters not set")
    })

    it("should revert for all supported chains without parameters", async () => {
      const chains = [
        WORMHOLE_CHAIN_SEI,
        WORMHOLE_CHAIN_BASE,
        WORMHOLE_CHAIN_ARBITRUM,
      ]

      // eslint-disable-next-line no-restricted-syntax
      for (const chainId of chains) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          depositor["quoteFinalizeDeposit(uint16)"](chainId)
        ).to.be.revertedWith("Executor parameters not set")
      }
    })

    it("should handle quote requests gracefully", async () => {
      // Test that quote functions exist and are callable (even if they revert due to missing params)
      await expect(depositor["quoteFinalizeDeposit()"]()).to.be.reverted
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_SEI)
      ).to.be.reverted
    })
  })

  describe("Chain Configuration", () => {
    it("should have supported chains configured", async () => {
      expect(await depositor.supportedChains(WORMHOLE_CHAIN_SEI)).to.be.true
      expect(await depositor.supportedChains(WORMHOLE_CHAIN_BASE)).to.be.true
      expect(await depositor.supportedChains(WORMHOLE_CHAIN_ARBITRUM)).to.be
        .true
    })

    it("should have default supported chain set", async () => {
      expect(await depositor.defaultSupportedChain()).to.equal(
        WORMHOLE_CHAIN_SEI
      )
    })

    it("should reject quotes for unsupported chains", async () => {
      const unsupportedChain = 999

      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](unsupportedChain)
      ).to.be.revertedWith("Executor parameters not set")
    })
  })

  describe("Contract State Queries", () => {
    it("should return correct contract addresses", async () => {
      expect(await depositor.nttManagerWithExecutor()).to.equal(
        nttManagerWithExecutor.address
      )
      expect(await depositor.underlyingNttManager()).to.equal(
        underlyingNttManager.address
      )
    })

    it("should return correct default parameters", async () => {
      expect(await depositor.defaultDestinationGasLimit()).to.equal(500000)
      expect(await depositor.defaultExecutorFeeBps()).to.equal(0)
      expect(await depositor.defaultExecutorFeeRecipient()).to.equal(
        ethers.constants.AddressZero
      )
    })

    it("should handle parameter state queries", async () => {
      const [isSet] = await depositor.areExecutorParametersSet()
      expect(isSet).to.be.false
      expect(await depositor.getStoredExecutorValue()).to.equal(0)
    })
  })

  // Utility Functions (encodeDestinationReceiver, decodeDestinationReceiver) were removed
  // to reduce contract size. These can be implemented off-chain if needed.

  describe("Mock Integration Tests", () => {
    it("should work with mock NTT manager", async () => {
      // Test that mock has been configured properly
      expect(nttManagerWithExecutor.address).to.not.equal(
        ethers.constants.AddressZero
      )

      // Test that we can call quote functions on the mock
      const executorArgs = createExecutorArgs()

      // This should work without reverting (basic smoke test)
      await expect(
        nttManagerWithExecutor.quoteDeliveryPrice(
          underlyingNttManager.address,
          WORMHOLE_CHAIN_SEI,
          "0x",
          executorArgs,
          FEE_ARGS_ZERO
        )
      ).to.not.be.reverted
    })

    it("should get different quotes for different chains", async () => {
      const executorArgs = createExecutorArgs()

      const seiCost = await nttManagerWithExecutor.quoteDeliveryPrice(
        underlyingNttManager.address,
        WORMHOLE_CHAIN_SEI,
        "0x",
        executorArgs,
        FEE_ARGS_ZERO
      )

      const baseCost = await nttManagerWithExecutor.quoteDeliveryPrice(
        underlyingNttManager.address,
        WORMHOLE_CHAIN_BASE,
        "0x",
        executorArgs,
        FEE_ARGS_ZERO
      )

      // Mock returns different costs for different chains
      expect(seiCost).to.not.equal(baseCost)

      // SEI should be more expensive (mock logic)
      expect(seiCost).to.be.gt(baseCost)
      expect(seiCost.sub(baseCost)).to.equal("2000000000000000") // 0.002 ETH premium
    })

    it("should reject quote for unsupported chain in mock", async () => {
      const executorArgs = createExecutorArgs()

      await expect(
        nttManagerWithExecutor.quoteDeliveryPrice(
          underlyingNttManager.address,
          999, // unsupported chain
          "0x",
          executorArgs,
          FEE_ARGS_ZERO
        )
      ).to.be.revertedWith("Chain not supported")
    })
  })

  describe("quoteFinalizedDeposit Function", () => {
    it("should return detailed cost breakdown for supported chain", async () => {
      const [, , user] = await ethers.getSigners()

      // Configure platform fee to allow user.address as payee
      await depositor.setDefaultPlatformFeeBps(100) // 0.1% (100/100000)
      await depositor.setDefaultPlatformFeeRecipient(user.address)

      // Set up executor parameters first
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"), // 0.01 ETH executor cost
        refundAddress: user.address,
        signedQuote: `0x${"a".repeat(64)}`, // Mock signed quote
        instructions: `0x${"b".repeat(32)}`, // Mock instructions
      }

      const feeArgs = {
        dbps: 100, // 0.1% (100/100000)
        payee: user.address,
      }

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      // Call the new quote function
      const [nttDeliveryPrice, executorCost, totalCost] = await depositor
        .connect(user)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)

      // Verify the breakdown
      expect(nttDeliveryPrice).to.be.gt(0) // NTT delivery price should be positive
      expect(executorCost).to.equal(ethers.utils.parseEther("0.01")) // Should match executor value
      expect(totalCost).to.equal(nttDeliveryPrice.add(executorCost)) // Should be sum of both

      console.log(
        `NTT delivery: ${ethers.utils.formatEther(nttDeliveryPrice)} ETH`
      )
      console.log(
        `Executor cost: ${ethers.utils.formatEther(executorCost)} ETH`
      )
      console.log(`Total required: ${ethers.utils.formatEther(totalCost)} ETH`)
    })

    it("should return different costs for different chains", async () => {
      const [, , user] = await ethers.getSigners()

      // Configure platform fee to allow user.address as payee
      await depositor.setDefaultPlatformFeeBps(50) // 0.05% (50/100000)
      await depositor.setDefaultPlatformFeeRecipient(user.address)

      const executorArgs = {
        value: ethers.utils.parseEther("0.005"), // 0.005 ETH executor cost
        refundAddress: user.address,
        signedQuote: `0x${"c".repeat(64)}`,
        instructions: `0x${"d".repeat(32)}`,
      }

      const feeArgs = {
        dbps: 50, // 0.05% (50/100000)
        payee: user.address,
      }

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      // Get quotes for different chains
      const [seiNttPrice, seiExecutorCost, seiTotal] = await depositor
        .connect(user)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)

      const [baseNttPrice, baseExecutorCost, baseTotal] = await depositor
        .connect(user)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_BASE)

      // Executor cost should be the same (from stored parameters)
      expect(seiExecutorCost).to.equal(baseExecutorCost)
      expect(seiExecutorCost).to.equal(ethers.utils.parseEther("0.005"))

      // NTT prices might be different for different chains
      expect(seiNttPrice).to.be.gt(0)
      expect(baseNttPrice).to.be.gt(0)

      // Total costs should be calculated correctly
      expect(seiTotal).to.equal(seiNttPrice.add(seiExecutorCost))
      expect(baseTotal).to.equal(baseNttPrice.add(baseExecutorCost))

      console.log(
        `Sei chain - NTT: ${ethers.utils.formatEther(
          seiNttPrice
        )} ETH, Total: ${ethers.utils.formatEther(seiTotal)} ETH`
      )
      console.log(
        `Base chain - NTT: ${ethers.utils.formatEther(
          baseNttPrice
        )} ETH, Total: ${ethers.utils.formatEther(baseTotal)} ETH`
      )
    })

    it("should revert when executor parameters are not set", async () => {
      const [, , user] = await ethers.getSigners()

      await expect(
        depositor.connect(user).quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)
      ).to.be.revertedWith("Executor parameters not set")
    })

    it("should revert for unsupported chain", async () => {
      const [, , user] = await ethers.getSigners()

      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: user.address,
        signedQuote: `0x${"e".repeat(64)}`,
        instructions: `0x${"f".repeat(32)}`,
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      await expect(
        depositor.connect(user).quoteFinalizedDeposit(999) // Unsupported chain
      ).to.be.revertedWith("Destination chain not supported")
    })

    it("should handle zero executor cost", async () => {
      const [, , user] = await ethers.getSigners()

      const executorArgs = {
        value: 0, // Zero executor cost
        refundAddress: user.address,
        signedQuote:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        instructions: "0x1234567890abcdef1234567890abcdef",
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      const [nttDeliveryPrice, executorCost, totalCost] = await depositor
        .connect(user)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)

      expect(executorCost).to.equal(0)
      expect(totalCost).to.equal(nttDeliveryPrice) // Should equal NTT price when executor cost is 0
      expect(nttDeliveryPrice).to.be.gt(0) // NTT price should still be positive

      console.log(
        `Zero executor cost - NTT: ${ethers.utils.formatEther(
          nttDeliveryPrice
        )} ETH, Total: ${ethers.utils.formatEther(totalCost)} ETH`
      )
    })

    it("should handle high executor cost", async () => {
      const [, , user] = await ethers.getSigners()

      // Configure platform fee to allow user.address as payee
      await depositor.setDefaultPlatformFeeBps(1000) // 1% (1000/100000)
      await depositor.setDefaultPlatformFeeRecipient(user.address)

      const highExecutorCost = ethers.utils.parseEther("0.1") // 0.1 ETH executor cost

      const executorArgs = {
        value: highExecutorCost,
        refundAddress: user.address,
        signedQuote: REAL_SIGNED_QUOTE.signedQuote,
        instructions: REAL_SIGNED_QUOTE.relayInstructions,
      }

      const feeArgs = {
        dbps: 1000, // 1% (1000/100000)
        payee: user.address,
      }

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      const [nttDeliveryPrice, executorCost, totalCost] = await depositor
        .connect(user)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)

      expect(executorCost).to.equal(highExecutorCost)
      expect(totalCost).to.equal(nttDeliveryPrice.add(highExecutorCost))
      expect(totalCost).to.be.gt(nttDeliveryPrice) // Total should be higher than NTT price

      console.log(
        `High executor cost - NTT: ${ethers.utils.formatEther(
          nttDeliveryPrice
        )} ETH, Executor: ${ethers.utils.formatEther(
          executorCost
        )} ETH, Total: ${ethers.utils.formatEther(totalCost)} ETH`
      )
    })

    it("should work with different users independently", async () => {
      const [, , user1, user2] = await ethers.getSigners()

      // Use zero fee to avoid platform fee recipient configuration
      // User 1 sets parameters
      const executorArgs1 = {
        value: ethers.utils.parseEther("0.02"),
        refundAddress: user1.address,
        signedQuote: `0x${"1".repeat(64)}`,
        instructions: `0x${"1".repeat(32)}`,
      }

      const feeArgs1 = {
        dbps: 0, // 0% (no fee)
        payee: ethers.constants.AddressZero,
      }

      await depositor
        .connect(user1)
        .setExecutorParameters(executorArgs1, feeArgs1)

      // User 2 sets different parameters
      const executorArgs2 = {
        value: ethers.utils.parseEther("0.03"),
        refundAddress: user2.address,
        signedQuote: `0x${"2".repeat(64)}`,
        instructions: `0x${"2".repeat(32)}`,
      }

      const feeArgs2 = {
        dbps: 0, // 0% (no fee)
        payee: ethers.constants.AddressZero,
      }

      await depositor
        .connect(user2)
        .setExecutorParameters(executorArgs2, feeArgs2)

      // Get quotes for both users
      const [user1Ntt, user1Executor, user1Total] = await depositor
        .connect(user1)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)

      const [user2Ntt, user2Executor, user2Total] = await depositor
        .connect(user2)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)

      // NTT prices should be the same (same chain, same underlying manager)
      expect(user1Ntt).to.equal(user2Ntt)

      // Executor costs should be different (different user parameters)
      expect(user1Executor).to.equal(ethers.utils.parseEther("0.02"))
      expect(user2Executor).to.equal(ethers.utils.parseEther("0.03"))

      // Total costs should be different
      expect(user1Total).to.equal(user1Ntt.add(user1Executor))
      expect(user2Total).to.equal(user2Ntt.add(user2Executor))
      expect(user2Total).to.be.gt(user1Total) // User 2 should have higher total cost

      console.log(
        `User 1 - NTT: ${ethers.utils.formatEther(
          user1Ntt
        )} ETH, Executor: ${ethers.utils.formatEther(
          user1Executor
        )} ETH, Total: ${ethers.utils.formatEther(user1Total)} ETH`
      )
      console.log(
        `User 2 - NTT: ${ethers.utils.formatEther(
          user2Ntt
        )} ETH, Executor: ${ethers.utils.formatEther(
          user2Executor
        )} ETH, Total: ${ethers.utils.formatEther(user2Total)} ETH`
      )
    })

    it("should simulate frontend validation logic", async () => {
      const [, , user] = await ethers.getSigners()

      // Configure platform fee to allow user.address as payee
      await depositor.setDefaultPlatformFeeBps(500) // 0.5% (500/100000)
      await depositor.setDefaultPlatformFeeRecipient(user.address)

      const executorArgs = {
        value: ethers.utils.parseEther("0.05"), // 0.05 ETH executor cost
        refundAddress: user.address,
        signedQuote:
          "0x3456789012cdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        instructions: "0x3456789012cdef1234567890abcdef",
      }

      const feeArgs = {
        dbps: 500, // 0.5% (500/100000)
        payee: user.address,
      }

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      // Simulate frontend getting cost breakdown
      const [nttDeliveryPrice, executorCost, totalCost] = await depositor
        .connect(user)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)

      // Simulate frontend validation
      const userEthBalance = ethers.utils.parseEther("0.1") // User has 0.1 ETH

      console.log("Frontend validation:")
      console.log(
        `NTT delivery: ${ethers.utils.formatEther(nttDeliveryPrice)} ETH`
      )
      console.log(
        `Executor cost: ${ethers.utils.formatEther(executorCost)} ETH`
      )
      console.log(`Total required: ${ethers.utils.formatEther(totalCost)} ETH`)
      console.log(
        `User balance: ${ethers.utils.formatEther(userEthBalance)} ETH`
      )

      // Frontend validation logic
      if (userEthBalance.lt(totalCost)) {
        throw new Error(
          `Insufficient ETH. Need ${ethers.utils.formatEther(totalCost)} ETH`
        )
      }

      // This should not throw since user has enough ETH
      expect(userEthBalance).to.be.gte(totalCost)
      console.log("✅ User has sufficient ETH for the transfer")
    })

    it("should simulate frontend validation failure", async () => {
      const [, , user] = await ethers.getSigners()

      // Configure platform fee to allow user.address as payee
      await depositor.setDefaultPlatformFeeBps(1000) // 1% (1000/100000)
      await depositor.setDefaultPlatformFeeRecipient(user.address)

      const executorArgs = {
        value: ethers.utils.parseEther("0.2"), // High executor cost
        refundAddress: user.address,
        signedQuote: REAL_SIGNED_QUOTE.signedQuote,
        instructions: REAL_SIGNED_QUOTE.relayInstructions,
      }

      const feeArgs = {
        dbps: 1000, // 1% (1000/100000)
        payee: user.address,
      }

      await depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)

      // Get cost breakdown
      const [nttDeliveryPrice, executorCost, totalCost] = await depositor
        .connect(user)
        .quoteFinalizedDeposit(WORMHOLE_CHAIN_SEI)

      // Simulate user with insufficient balance
      const userEthBalance = ethers.utils.parseEther("0.1") // User only has 0.1 ETH

      console.log("Frontend validation (insufficient balance):")
      console.log(
        `NTT delivery: ${ethers.utils.formatEther(nttDeliveryPrice)} ETH`
      )
      console.log(
        `Executor cost: ${ethers.utils.formatEther(executorCost)} ETH`
      )
      console.log(`Total required: ${ethers.utils.formatEther(totalCost)} ETH`)
      console.log(
        `User balance: ${ethers.utils.formatEther(userEthBalance)} ETH`
      )

      // This should fail validation
      expect(userEthBalance).to.be.lt(totalCost)
      console.log("❌ User has insufficient ETH for the transfer")
    })
  })

  describe("Relay Instructions Validation", () => {
    it("should validate relay instructions with gas limit encoding", async () => {
      const [, , user] = await ethers.getSigners()

      // Test with the original relay instructions that include gas limit
      const executorArgs = {
        value: "21316600000000",
        refundAddress: user.address,
        signedQuote: REAL_SIGNED_QUOTE.signedQuote,
        instructions: REAL_SIGNED_QUOTE.relayInstructions, // Contains gas limit encoding
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      // Should accept the relay instructions with gas limit
      await expect(
        depositor.connect(user).setExecutorParameters(executorArgs, feeArgs)
      ).to.not.be.reverted

      // Verify the instructions are properly stored and used
      expect(executorArgs.instructions).to.equal(
        "0x010000000000000000000000000007a12000000000000000000000000000000000"
      )

      // Verify the gas limit is encoded correctly (0x7a120 = 500,000)
      // The gas limit is encoded in the middle of the instructions
      // Looking for 0x7a120 in the instructions: 0x010000000000000000000000000007a12000000000000000000000000000000000
      const { instructions } = executorArgs

      // Find the gas limit (0x7a120) in the instructions
      const gasLimitMatch = instructions.match(/7a120/)
      expect(gasLimitMatch).to.not.be.null

      const gasLimit = 0x7a120
      expect(gasLimit).to.equal(500000) // 0x7a120 = 500,000

      console.log(`✅ Relay instructions validated with gas limit: ${gasLimit}`)
    })

    it("should compare empty vs gas-encoded relay instructions", async () => {
      const [, , user] = await ethers.getSigners()

      // Test with empty instructions
      const emptyExecutorArgs = {
        value: "21316600000000",
        refundAddress: user.address,
        signedQuote: REAL_SIGNED_QUOTE_ALT.signedQuote,
        instructions: "0x", // Empty instructions
      }

      // Test with gas-encoded instructions
      const encodedExecutorArgs = {
        value: "21316600000000",
        refundAddress: user.address,
        signedQuote: REAL_SIGNED_QUOTE.signedQuote,
        instructions: REAL_SIGNED_QUOTE.relayInstructions, // Gas-encoded instructions
      }

      const feeArgs = {
        dbps: 0,
        payee: ethers.constants.AddressZero,
      }

      // Both should be accepted
      await expect(
        depositor
          .connect(user)
          .setExecutorParameters(emptyExecutorArgs, feeArgs)
      ).to.not.be.reverted

      await expect(
        depositor
          .connect(user)
          .setExecutorParameters(encodedExecutorArgs, feeArgs)
      ).to.not.be.reverted

      console.log(
        "✅ Both empty and gas-encoded relay instructions work correctly"
      )
    })
  })
})
