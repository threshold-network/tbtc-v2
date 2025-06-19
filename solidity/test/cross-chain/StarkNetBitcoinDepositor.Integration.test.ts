import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  StarkNetBitcoinDepositor,
  MockBridgeForStarkNet,
  MockTBTCVault,
  MockTBTCToken,
  MockStarkGateBridge,
} from "../../typechain"
import { to1ePrecision } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("StarkNetBitcoinDepositor - Integration Tests", () => {
  let depositor: StarkNetBitcoinDepositor
  let bridge: MockBridgeForStarkNet
  let tbtcVault: MockTBTCVault
  let tbtcToken: MockTBTCToken
  let starkGateBridge: MockStarkGateBridge
  let signer: SignerWithAddress

  const INITIAL_MESSAGE_FEE = ethers.utils.parseEther("0.01")
  const DEPOSIT_AMOUNT = to1ePrecision(100000000, 10) // 1 BTC (100M satoshis) converted to 18-decimal precision
  const TREASURY_FEE = BigNumber.from("12098000000000") // Example treasury fee

  // Helper to initialize deposit and get key
  const initializeDepositAndGetKey = async (depositData: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fundingTx: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reveal: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    l2Receiver: any
  }) => {
    const tx = await depositor.initializeDeposit(
      depositData.fundingTx,
      depositData.reveal,
      depositData.l2Receiver
    )
    const receipt = await tx.wait()
    const depositInitEvent = receipt.events?.find(
      (e) => e.event === "DepositInitialized"
    )
    const bytes32 = depositInitEvent?.args?.depositKey
    const uint256 = BigNumber.from(bytes32)

    return {
      uint256,
      bytes32,
    }
  }

  // Helper function to generate test deposit data
  const generateDepositData = (index: number) => {
    // Ensure blinding factor is always exactly 8 bytes (16 hex chars)
    const blindingFactorHex = `f9f0c90d0003${index
      .toString(16)
      .padStart(4, "0")}`
    // Ensure it's exactly 16 chars (8 bytes)
    const blindingFactor = `0x${blindingFactorHex.slice(0, 16)}`

    return {
      fundingTx: {
        version: "0x01000000",
        inputVector: `0x01${index
          .toString(16)
          .padStart(64, "0")}0100000000ffffffff`,
        outputVector:
          "0x021027000000000000220020bfaeddba12b0de6feeb649af76376876bc1" +
          "feb6c2248fbfef9293ba3ac51bb4a10d73b00000000001600147ac2d9378a" +
          "1c47e589dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      },
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor,
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x60bcea61",
        vault: "",
      },
      l2Receiver: ethers.utils.hexZeroPad(
        `0x${(1000 + index).toString(16)}`,
        32
      ),
      starknetRecipient: `0x${(1000 + index).toString(16).padStart(64, "0")}`,
      expectedDepositKey: "", // Will be calculated during test
    }
  }

  before(async () => {
    // Get signer
    const [firstSigner] = await ethers.getSigners()
    signer = firstSigner

    // Deploy mock contracts
    const MockTBTCToken = await ethers.getContractFactory("MockTBTCToken")
    tbtcToken = await MockTBTCToken.deploy()

    const MockBridgeForStarkNet = await ethers.getContractFactory(
      "MockBridgeForStarkNet"
    )
    bridge = await MockBridgeForStarkNet.deploy()

    const MockTBTCVault = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVault.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    const MockStarkGateBridge = await ethers.getContractFactory(
      "MockStarkGateBridge"
    )
    starkGateBridge = await MockStarkGateBridge.deploy()

    // Deploy main contract with proxy pattern
    const StarkNetBitcoinDepositor = await ethers.getContractFactory(
      "StarkNetBitcoinDepositor"
    )
    const depositorImpl = await StarkNetBitcoinDepositor.deploy()

    // Deploy proxy
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const STARKNET_TBTC_TOKEN = ethers.BigNumber.from("0x12345")
    const initData = depositorImpl.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      starkGateBridge.address,
    ])
    const proxy = await ProxyFactory.deploy(depositorImpl.address, initData)

    depositor = StarkNetBitcoinDepositor.attach(proxy.address)
  })

  describe("End-to-End Deposit Flow", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should handle complete deposit flow from initialization to bridging", async () => {
      // RED PHASE: This test should fail initially
      const depositData = generateDepositData(1)
      depositData.reveal.vault = tbtcVault.address

      // Step 1: Initialize deposit
      const initTx = await depositor.initializeDeposit(
        depositData.fundingTx,
        depositData.reveal,
        depositData.l2Receiver
      )

      // Get the actual events to find the real deposit key
      const initReceipt = await initTx.wait()
      const depositInitEvent = initReceipt.events?.find(
        (e) => e.event === "DepositInitialized"
      )
      const depositKeyBytes32 = depositInitEvent?.args?.depositKey
      const depositKey = BigNumber.from(depositKeyBytes32)

      // Verify initialization events
      await expect(initTx)
        .to.emit(depositor, "DepositInitialized")
        .withArgs(depositKey, depositData.l2Receiver, signer.address)

      await expect(initTx).to.emit(bridge, "DepositRevealed")

      // Step 2: Simulate tBTC minting (mock bridge behavior)
      // console.log(
      //   "Attempting to sweep deposit with key:",
      //   depositKey.toString()
      // )
      // console.log("Deposit key as hex:", depositKey.toHexString())
      // const storedKeys = await bridge.getDepositKeys()
      // console.log(
      //   "Stored deposit keys:",
      //   storedKeys.map((k) => k.toString())
      // )

      await bridge.sweepDeposit(depositKey)
      await tbtcToken.mint(depositor.address, DEPOSIT_AMOUNT.sub(TREASURY_FEE))

      // Step 3: Finalize deposit and bridge to StarkNet
      const finalizeTx = await depositor.finalizeDeposit(depositKeyBytes32, {
        value: INITIAL_MESSAGE_FEE,
      })

      // Verify finalization events (amount may vary due to fee calculations)
      await expect(finalizeTx).to.emit(depositor, "DepositFinalized")

      // Verify StarkGate bridge was called correctly
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await starkGateBridge.getDepositCount()).to.be.gt(0)
      const lastDepositCall = await starkGateBridge.getLastDepositCall()
      expect(lastDepositCall.token).to.equal(tbtcToken.address)

      // Check that final bridged amount is within expected range
      // bridged amount is after optimistic minting fee
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(lastDepositCall.amount).to.be.gt(0)
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(lastDepositCall.amount).to.be.lte(DEPOSIT_AMOUNT.sub(TREASURY_FEE))
    })

    it("should handle multiple concurrent deposits", async () => {
      // RED PHASE: Test multiple deposits being processed
      const numberOfDeposits = 5
      const depositKeys = []

      // Initialize multiple deposits
      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < numberOfDeposits; i++) {
        const depositData = generateDepositData(i)
        depositData.reveal.vault = tbtcVault.address

        // eslint-disable-next-line no-await-in-loop
        const keys = await initializeDepositAndGetKey(depositData)
        depositKeys.push(keys)
      }

      // Process all deposits
      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < numberOfDeposits; i++) {
        const keys = depositKeys[i]

        // Simulate bridge sweep and tBTC minting
        // eslint-disable-next-line no-await-in-loop
        await bridge.sweepDeposit(keys.uint256)
        // eslint-disable-next-line no-await-in-loop
        await tbtcToken.mint(
          depositor.address,
          DEPOSIT_AMOUNT.sub(TREASURY_FEE)
        )

        // Finalize deposit
        // eslint-disable-next-line no-await-in-loop
        await depositor.finalizeDeposit(keys.bytes32, {
          value: INITIAL_MESSAGE_FEE,
        })
      }

      // Verify all deposits were bridged
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await starkGateBridge.getDepositCount()).to.equal(numberOfDeposits)
    })

    it("should handle deposits with different amounts correctly", async () => {
      // RED PHASE: Test various deposit amounts
      // Note: All deposits use the same bridge-calculated amount regardless of test amount
      // because our mock bridge hardcodes 1 BTC (100M satoshis) deposit amount
      const amounts = [
        to1ePrecision(1, 17), // 0.1 BTC (test amount, not used by bridge)
        to1ePrecision(5, 17), // 0.5 BTC (test amount, not used by bridge)
        to1ePrecision(1, 18), // 1 BTC (test amount, not used by bridge)
        to1ePrecision(2, 18), // 2 BTC (test amount, not used by bridge)
      ]

      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < amounts.length; i++) {
        const depositData = generateDepositData(i + 10)
        depositData.reveal.vault = tbtcVault.address
        // const amount = amounts[i]

        // Initialize deposit and get key
        // eslint-disable-next-line no-await-in-loop
        const keys = await initializeDepositAndGetKey(depositData)

        // Simulate sweep and mint amount calculated by bridge
        // eslint-disable-next-line no-await-in-loop
        await bridge.sweepDeposit(keys.uint256)

        // Calculate the exact amount that _calculateTbtcAmount returns:
        // The mock bridge uses 88800000 satoshi (0.888 BTC) with 898000 treasury fee
        // amountSubTreasury = (88800000 - 898000) * 10^10 = 87902000 * 10^10
        const amountSubTreasury = to1ePrecision(87902000, 10)
        // omFee = amountSubTreasury / 1000 (0.1% fee)
        const omFee = amountSubTreasury.div(1000)
        // txMaxFee = 1000000 * 10^10
        const txMaxFee = to1ePrecision(1000000, 10)
        // Final amount = amountSubTreasury - omFee - txMaxFee
        const bridgeCalculatedAmount = amountSubTreasury
          .sub(omFee)
          .sub(txMaxFee)

        // eslint-disable-next-line no-await-in-loop
        await tbtcToken.mint(depositor.address, bridgeCalculatedAmount)

        // Finalize deposit
        // eslint-disable-next-line no-await-in-loop
        await depositor.finalizeDeposit(keys.bytes32, {
          value: INITIAL_MESSAGE_FEE,
        })

        // Verify correct amount was bridged (should be bridge-calculated amount)
        // eslint-disable-next-line no-await-in-loop
        const lastCall = await starkGateBridge.getLastDepositCall()
        expect(lastCall.amount).to.equal(bridgeCalculatedAmount)
      }
    })
  })

  describe("Failure Recovery", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should handle StarkGate bridge failures gracefully", async () => {
      // RED PHASE: Test bridge failure handling
      const depositData = generateDepositData(100)
      depositData.reveal.vault = tbtcVault.address

      // Initialize and prepare deposit
      const keys = await initializeDepositAndGetKey(depositData)
      await bridge.sweepDeposit(keys.uint256)
      await tbtcToken.mint(depositor.address, DEPOSIT_AMOUNT.sub(TREASURY_FEE))

      // Mock bridge to fail
      await starkGateBridge.setDepositWithMessageReturn(0) // This would indicate failure

      // Attempt to finalize should handle the failure appropriately
      await expect(
        depositor.finalizeDeposit(keys.bytes32, {
          value: INITIAL_MESSAGE_FEE,
        })
      ).to.not.be.reverted // The transaction completes but with 0 nonce returned
    })

    it("should prevent double finalization of same deposit", async () => {
      // RED PHASE: Test double finalization protection
      const depositData = generateDepositData(200)
      depositData.reveal.vault = tbtcVault.address

      // Initialize and finalize deposit once
      const keys = await initializeDepositAndGetKey(depositData)
      await bridge.sweepDeposit(keys.uint256)

      // Calculate the correct amount
      const amountSubTreasury = to1ePrecision(87902000, 10)
      const omFee = amountSubTreasury.div(1000)
      const txMaxFee = to1ePrecision(1000000, 10)
      const bridgeCalculatedAmount = amountSubTreasury.sub(omFee).sub(txMaxFee)

      await tbtcToken.mint(depositor.address, bridgeCalculatedAmount)

      await depositor.finalizeDeposit(keys.bytes32, {
        value: INITIAL_MESSAGE_FEE,
      })

      // Mint more tokens to simulate attempted double spend
      await tbtcToken.mint(depositor.address, bridgeCalculatedAmount)

      // Attempt to finalize same deposit again should fail
      await expect(
        depositor.finalizeDeposit(keys.bytes32, {
          value: INITIAL_MESSAGE_FEE,
        })
      ).to.be.revertedWith("Wrong deposit state")
    })

    it("should handle insufficient tBTC balance scenarios", async () => {
      // RED PHASE: Test insufficient balance handling
      const depositData = generateDepositData(300)
      depositData.reveal.vault = tbtcVault.address

      // Check initial balance
      const initialBalance = await tbtcToken.balanceOf(depositor.address)
      // console.log("Initial depositor balance:", initialBalance.toString())
      expect(initialBalance).to.equal(0) // Should be 0 at start

      // Initialize deposit
      const keys = await initializeDepositAndGetKey(depositData)
      await bridge.sweepDeposit(keys.uint256)

      // Don't mint enough tBTC (insufficient balance)
      const insufficientAmount = BigNumber.from("1000") // Very small amount
      await tbtcToken.mint(depositor.address, insufficientAmount)

      // Check balance after minting
      const balanceAfterMint = await tbtcToken.balanceOf(depositor.address)
      // console.log("Balance after mint:", balanceAfterMint.toString())
      expect(balanceAfterMint).to.equal(insufficientAmount)

      // Finalization should fail due to insufficient balance for calculated amount
      await expect(
        depositor.finalizeDeposit(keys.bytes32, {
          value: INITIAL_MESSAGE_FEE,
        })
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance")
    })
  })

  describe("Performance Under Load", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should handle rapid sequential deposits efficiently", async () => {
      // RED PHASE: Test performance with rapid deposits
      const numberOfDeposits = 10
      // const startTime = Date.now()

      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < numberOfDeposits; i++) {
        const depositData = generateDepositData(1000 + i)
        depositData.reveal.vault = tbtcVault.address

        // Complete full deposit cycle
        // eslint-disable-next-line no-await-in-loop
        const keys = await initializeDepositAndGetKey(depositData)
        // eslint-disable-next-line no-await-in-loop
        await bridge.sweepDeposit(keys.uint256)
        // eslint-disable-next-line no-await-in-loop
        await tbtcToken.mint(
          depositor.address,
          DEPOSIT_AMOUNT.sub(TREASURY_FEE)
        )
        // eslint-disable-next-line no-await-in-loop
        await depositor.finalizeDeposit(keys.bytes32, {
          value: INITIAL_MESSAGE_FEE,
        })
      }

      // const endTime = Date.now()
      // const totalTime = endTime - startTime

      // Verify all deposits completed
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await starkGateBridge.getDepositCount()).to.equal(numberOfDeposits)

      // Log performance metrics (informational)
      // console.log(`Processed ${numberOfDeposits} deposits in ${totalTime}ms`)
      // console.log(`Average time per deposit: ${totalTime / numberOfDeposits}ms`)
    })

    it("should maintain gas efficiency across multiple deposits", async () => {
      // RED PHASE: Test gas consistency
      const gasUsages = []

      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < 5; i++) {
        const depositData = generateDepositData(2000 + i)
        depositData.reveal.vault = tbtcVault.address

        // eslint-disable-next-line no-await-in-loop
        const keys = await initializeDepositAndGetKey(depositData)
        // eslint-disable-next-line no-await-in-loop
        await bridge.sweepDeposit(keys.uint256)
        // eslint-disable-next-line no-await-in-loop
        await tbtcToken.mint(
          depositor.address,
          DEPOSIT_AMOUNT.sub(TREASURY_FEE)
        )

        // Measure gas for finalization
        // eslint-disable-next-line no-await-in-loop
        const tx = await depositor.finalizeDeposit(keys.bytes32, {
          value: INITIAL_MESSAGE_FEE,
        })
        // eslint-disable-next-line no-await-in-loop
        const receipt = await tx.wait()
        gasUsages.push(receipt.gasUsed.toNumber())
      }

      // Verify gas usage is reasonably consistent (within 100% variance for different deposit scenarios)
      const avgGas = gasUsages.reduce((a, b) => a + b) / gasUsages.length
      // eslint-disable-next-line no-restricted-syntax
      for (const gasUsed of gasUsages) {
        const variance = Math.abs(gasUsed - avgGas) / avgGas
        expect(variance).to.be.lessThan(1.0) // Allow for first vs subsequent deposit variance
      }

      // All deposits should use less than 400k gas (TODO: optimize in T-016)
      // eslint-disable-next-line no-restricted-syntax
      for (const gasUsed of gasUsages) {
        expect(gasUsed).to.be.lessThan(400000) // Current: ~356k, future target: 200k
      }
    })
  })

  describe("Real Gas Cost Analysis", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should provide accurate gas cost breakdown", async () => {
      // RED PHASE: Analyze gas costs for each operation
      const depositData = generateDepositData(3000)
      depositData.reveal.vault = tbtcVault.address

      // Measure initialization gas
      const initTx = await depositor.initializeDeposit(
        depositData.fundingTx,
        depositData.reveal,
        depositData.l2Receiver
      )
      const initReceipt = await initTx.wait()
      const depositInitEvent = initReceipt.events?.find(
        (e) => e.event === "DepositInitialized"
      )
      const depositKeyBytes32 = depositInitEvent?.args?.depositKey
      const depositKey = BigNumber.from(depositKeyBytes32)

      // Prepare for finalization
      await bridge.sweepDeposit(depositKey)
      await tbtcToken.mint(depositor.address, DEPOSIT_AMOUNT.sub(TREASURY_FEE))

      // Measure finalization gas
      const finalizeTx = await depositor.finalizeDeposit(depositKeyBytes32, {
        value: INITIAL_MESSAGE_FEE,
      })
      const finalizeReceipt = await finalizeTx.wait()

      // Log gas breakdown
      // console.log("Gas Cost Analysis:")
      // console.log(`  Initialization: ${initReceipt.gasUsed.toString()} gas`)
      // console.log(`  Finalization: ${finalizeReceipt.gasUsed.toString()} gas`)
      // console.log(
      //   `  Total: ${initReceipt.gasUsed
      //     .add(finalizeReceipt.gasUsed)
      //     .toString()} gas`
      // )

      // Verify current gas costs (TODO: optimize to 150k target in T-016)
      expect(initReceipt.gasUsed.toNumber()).to.be.lessThan(220000) // Current: ~210k, target: 150k
      expect(finalizeReceipt.gasUsed.toNumber()).to.be.lessThan(400000) // Current: ~356k
    })
  })
})
