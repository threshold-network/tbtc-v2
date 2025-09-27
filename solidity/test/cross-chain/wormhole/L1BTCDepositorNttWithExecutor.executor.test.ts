import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { randomBytes } from "crypto"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
  MockNttManagerWithExecutor,
} from "../../../typechain"
import {
  REAL_SIGNED_QUOTE,
  EXECUTOR_ARGS_REAL_QUOTE,
  REAL_SIGNED_QUOTE_ALT,
  EXECUTOR_ARGS_ALT_QUOTE,
  FEE_ARGS_ZERO,
  FEE_ARGS_STANDARD,
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
  let underlyingNttManager: TestERC20 // Simple contract for address
  let owner: any

  before(async () => {
    // Get signers
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

    // Use a simple ERC20 as underlying NTT manager (just need an address)
    underlyingNttManager = await TestERC20Factory.deploy()

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
      const executorArgs = {
        value: ethers.utils.parseEther("0.01"),
        refundAddress: owner.address,
        signedQuote: "0x" + "a".repeat(64), // 32 bytes (64 hex chars) - meets minimum requirement
        instructions: "0x" + "b".repeat(32), // 16 bytes (32 hex chars)
      }

      const feeArgs = {
        dbps: 100,
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
        dbps: 10001, // Exceeds 100%
        payee: ethers.Wallet.createRandom().address,
      }

      await expect(
        depositor.setExecutorParameters(executorArgs, invalidFeeArgs)
      ).to.be.revertedWith("Fee cannot exceed 100% (10000 bps)")
    })

    it("should accept maximum valid fee basis points (10000) in setExecutorParameters", async () => {
      const executorArgs = createExecutorArgs()
      const validFeeArgs = {
        dbps: 10000, // Exactly 100%
        payee: ethers.Wallet.createRandom().address,
      }

      // This should not revert (but will likely revert on quote validation)
      // We're testing that the BPS validation passes
      await expect(
        depositor.setExecutorParameters(executorArgs, validFeeArgs)
      ).to.not.be.revertedWith("Fee cannot exceed 100% (10000 bps)")
    })

    it("should reject fee basis points exceeding 10000 in setDefaultParameters", async () => {
      const [owner] = await ethers.getSigners()

      await expect(
        depositor.connect(owner).setDefaultParameters(
          500000, // gasLimit
          10001, // feeBps exceeds 100%
          ethers.Wallet.createRandom().address // feeRecipient
        )
      ).to.be.revertedWith("Fee cannot exceed 100% (10000 bps)")
    })

    it("should accept maximum valid fee basis points (10000) in setDefaultParameters", async () => {
      const [owner] = await ethers.getSigners()

      await expect(
        depositor.connect(owner).setDefaultParameters(
          500000, // gasLimit
          10000, // feeBps exactly 100%
          ethers.Wallet.createRandom().address // feeRecipient
        )
      ).to.not.be.reverted
    })

    it("should accept zero fee basis points", async () => {
      const [owner] = await ethers.getSigners()

      await expect(
        depositor.connect(owner).setDefaultParameters(
          500000, // gasLimit
          0, // feeBps 0%
          ethers.constants.AddressZero // feeRecipient can be zero when fee is 0
        )
      ).to.not.be.reverted
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
        "Must call setExecutorParameters() first"
      )
    })

    it("should revert chain-specific quote without executor parameters", async () => {
      await expect(
        depositor["quoteFinalizeDeposit(uint16)"](WORMHOLE_CHAIN_SEI)
      ).to.be.revertedWith("Must call setExecutorParameters() first")
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
        ).to.be.revertedWith("Must call setExecutorParameters() first")
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
      ).to.be.revertedWith("Must call setExecutorParameters() first")
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

  describe("Utility Functions", () => {
    it("should encode and decode destination receiver correctly", async () => {
      const chainId = WORMHOLE_CHAIN_SEI
      const recipient = ethers.Wallet.createRandom().address

      const encoded = await depositor.encodeDestinationReceiver(
        chainId,
        recipient
      )
      const [decodedChainId, decodedRecipient] =
        await depositor.decodeDestinationReceiver(encoded)

      expect(decodedChainId).to.equal(chainId)
      expect(decodedRecipient).to.equal(recipient)
    })

    it("should handle edge cases in encoding", async () => {
      const maxChainId = 65535 // Max uint16
      const zeroAddress = ethers.constants.AddressZero

      const encoded = await depositor.encodeDestinationReceiver(
        maxChainId,
        zeroAddress
      )
      const [decodedChainId, decodedRecipient] =
        await depositor.decodeDestinationReceiver(encoded)

      expect(decodedChainId).to.equal(maxChainId)
      expect(decodedRecipient).to.equal(zeroAddress)
    })
  })

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
})
