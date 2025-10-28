/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, Contract } from "ethers"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  IRelay,
  BridgeGovernance,
} from "../../typechain"
import type {
  DepositRevealInfoStruct,
  InfoStruct as BitcoinTxInfoStruct,
} from "../../typechain/Bridge"
import bridgeFixture from "../fixtures/bridge"
import { walletState } from "../fixtures"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time
const { impersonateAccount } = helpers.account
const crypto = require("crypto")

const computeUtxoHash = (
  fundingTx: BitcoinTxInfoStruct,
  reveal: DepositRevealInfoStruct
) => {
  const fundingTxBytes = ethers.utils.solidityPack(
    ["bytes4", "bytes", "bytes", "bytes4"],
    [fundingTx.version, fundingTx.inputVector, fundingTx.outputVector, fundingTx.locktime]
  )

  const firstHash = crypto
    .createHash("sha256")
    .update(Buffer.from(fundingTxBytes.slice(2), "hex"))
    .digest()
  const fundingTxHash = `0x${crypto
    .createHash("sha256")
    .update(firstHash)
    .digest("hex")}`

  return ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ["bytes32", "uint32"],
      [fundingTxHash, reveal.fundingOutputIndex]
    )
  )
}

describe("Bridge - Reserved Deposit", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let treasury: SignerWithAddress
  let depositor: SignerWithAddress
  let liquidator: SignerWithAddress
  let thirdParty: SignerWithAddress

  let bank: Bank & BankStub
  let relay: FakeContract<IRelay>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      spvMaintainer,
      treasury,
      bank,
      relay,
      bridge,
      bridgeGovernance,
    } = await waffle.loadFixture(bridgeFixture))

    const accounts = await getUnnamedAccounts()
    // Impersonate the correct depositor address that matches the valid transaction data
    depositor = await impersonateAccount("0x934B98637cA318a4D6E7CA6ffd1690b8e77df637", {
      from: governance,
      value: 10,
    })
    liquidator = await ethers.getSigner(accounts[1])
    thirdParty = await ethers.getSigner(accounts[2])

    // Set the deposit dust threshold to match the default (1000 satoshis)
    // The valid P2SH transaction has 10000 satoshi which is above this threshold
    await bridge.setDepositDustThreshold(1000)
    await bridge.setDepositTxMaxFee(2000)
    // Disable the reveal ahead period for testing
    await bridge.setDepositRevealAheadPeriod(0)
  })

  // Storage fee calculation tests removed - function no longer exposed in Bridge

  describe("revealReservedDeposit", () => {
    let fundingTx: BitcoinTxInfoStruct
    let reveal: DepositRevealInfoStruct
    let btcRedemptionAddress: string

    beforeEach(async () => {
      await createSnapshot()

      // Set up a live wallet - use a sample wallet public key hash
      const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
      await bridge.setWallet(walletPubKeyHash, {
        ecdsaWalletID: ethers.constants.HashZero,
        mainUtxoHash: ethers.constants.HashZero,
        pendingRedemptionsValue: 0,
        createdAt: await lastBlockTime(),
        movingFundsRequestedAt: 0,
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.Live,
        movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
      })

      // Using the exact same valid P2SH funding transaction from Bridge.Deposit.test.ts
      // This transaction has a properly computed script hash that matches the expected deposit script
      fundingTx = {
        version: "0x01000000",
        inputVector:
          "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
          "c2b952f0100000000ffffffff",
        outputVector:
          "0x0200e1f5050000000017a9142c1444d23936c57bdd8b3e67e5938a5440c" +
          "da455877ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2" +
          "140d2726", // This P2SH output has 1 BTC with correct script hash
        locktime: "0x00000000",
      }

      reveal = {
        fundingOutputIndex: 0,
        blindingFactor: "0xf9f0c90d00039523",
        walletPubKeyHash: walletPubKeyHash,
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x60bcea61",
        vault: ethers.constants.AddressZero,
      }

      // Bitcoin redemption address (20 bytes for P2PKH)
      btcRedemptionAddress = "0x1234567890123456789012345678901234567890"
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should successfully reveal a reserved deposit", async () => {
      const reservationDays = 365

      await bridge
        .connect(depositor)
        .revealReservedDeposit(
          fundingTx,
          reveal,
          reservationDays,
          btcRedemptionAddress
        )

      // No minting should occur before the deposit is swept
      expect(await bank.balanceOf(depositor.address)).to.equal(0)

      const utxoHash = computeUtxoHash(fundingTx, reveal)

      // Simulate the sweep in the stub to finalize the reservation
      await bridge.finalizeReservedDepositForTest(utxoHash, 0)

      const depositorBalance = ethers.utils.parseUnits("0.99", 8)
      const treasuryBalance = ethers.utils.parseUnits("0.009", 8)
      const bridgeBonus = ethers.utils.parseUnits("0.001", 8)

      expect(await bank.balanceOf(depositor.address)).to.equal(
        depositorBalance
      )
      expect(await bank.balanceOf(treasury.address)).to.equal(treasuryBalance)
      expect(await bank.balanceOf(bridge.address)).to.equal(bridgeBonus)
    })

    it("should revert if reservation period is invalid", async () => {
      await expect(
        bridge
          .connect(depositor)
          .revealReservedDeposit(fundingTx, reveal, 0, btcRedemptionAddress)
      ).to.be.revertedWith("Bad period")

      await expect(
        bridge
          .connect(depositor)
          .revealReservedDeposit(fundingTx, reveal, 1461, btcRedemptionAddress)
      ).to.be.revertedWith("Bad period")
    })

    it("should revert if BTC address length is invalid", async () => {
      const invalidAddress = "0x12345678" // Too short

      await expect(
        bridge
          .connect(depositor)
          .revealReservedDeposit(fundingTx, reveal, 365, invalidAddress)
      ).to.be.revertedWith("Bad addr")
    })

    it("should revert if UTXO is already reserved", async () => {
      const reservationDays = 365

      // First reservation should succeed
      await bridge
        .connect(depositor)
        .revealReservedDeposit(
          fundingTx,
          reveal,
          reservationDays,
          btcRedemptionAddress
        )

      // Second reservation of same UTXO should fail
      await expect(
        bridge
          .connect(depositor)
          .revealReservedDeposit(
            fundingTx,
            reveal,
            reservationDays,
            btcRedemptionAddress
          )
      ).to.be.revertedWith("Reserved")
    })
  })

  describe("redeemReservedDeposit", () => {
    let utxoHash: string
    let fundingTx: BitcoinTxInfoStruct
    let reveal: DepositRevealInfoStruct
    let btcRedemptionAddress: string
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"

    beforeEach(async () => {
      await createSnapshot()

      // Set up a live wallet
      await bridge.setWallet(walletPubKeyHash, {
        ecdsaWalletID: ethers.constants.HashZero,
        mainUtxoHash: ethers.constants.HashZero,
        pendingRedemptionsValue: 0,
        createdAt: await lastBlockTime(),
        movingFundsRequestedAt: 0,
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.Live,
        movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
      })

      // Set up funding transaction and reveal
      fundingTx = {
        version: "0x01000000",
        inputVector:
          "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20dc2b952f0100000000ffffffff",
        outputVector:
          "0x0200e1f50500000000" + // 1 BTC
          "17a9142c1444d23936c57bdd8b3e67e5938a5440cda45587" +
          "7ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      }

      reveal = {
        fundingOutputIndex: 0,
        blindingFactor: "0xf9f0c90d00039523",
        walletPubKeyHash: walletPubKeyHash,
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x60bcea61",
        vault: ethers.constants.AddressZero,
      }

      btcRedemptionAddress = "0x1234567890123456789012345678901234567890"

      // Create a reserved deposit
      await bridge
        .connect(depositor)
        .revealReservedDeposit(fundingTx, reveal, 365, btcRedemptionAddress)

      utxoHash = computeUtxoHash(fundingTx, reveal)

      // Simulate sweep finalization to activate the reservation for tests
      await bridge.finalizeReservedDepositForTest(utxoHash, 0)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should successfully redeem a reserved deposit", async () => {
      // Check initial balance (0.99 BTC after fee)
      const initialBalance = await bank.balanceOf(depositor.address)
      expect(initialBalance).to.equal(ethers.utils.parseUnits("0.99", 8))

      // Approve bridge to transfer the tBTC
      await bank.connect(depositor).approveBalance(bridge.address, initialBalance)

      // Redeem the reserved deposit
      await bridge.connect(depositor).redeemReservedDeposit(utxoHash)

      // Check that balance was decreased
      const finalBalance = await bank.balanceOf(depositor.address)
      expect(finalBalance).to.equal(0)

      // Liquidation bonus should have been forwarded to the treasury
      expect(await bank.balanceOf(treasury.address)).to.equal(
        ethers.utils.parseUnits("0.01", 8)
      )
      expect(await bank.balanceOf(bridge.address)).to.equal(0)

      // Cannot check reservation anymore - getReservedDeposit was removed
    })

    it("should revert if not the original depositor", async () => {
      await expect(
        bridge.connect(thirdParty).redeemReservedDeposit(utxoHash)
      ).to.be.revertedWith("Not depositor")
    })

    it("should revert if reservation has expired", async () => {
      // Fast forward time by more than 365 days
      await increaseTime(366 * 86400)

      await expect(
        bridge.connect(depositor).redeemReservedDeposit(utxoHash)
      ).to.be.revertedWith("Expired")
    })

    it("should revert if reservation is not active", async () => {
      // Approve bridge to transfer the tBTC
      const balance = await bank.balanceOf(depositor.address)
      await bank.connect(depositor).approveBalance(bridge.address, balance)

      // Redeem once
      await bridge.connect(depositor).redeemReservedDeposit(utxoHash)

      // Try to redeem again
      await expect(
        bridge.connect(depositor).redeemReservedDeposit(utxoHash)
      ).to.be.revertedWith("Not active")
    })
  })

  describe("liquidateExpiredReservation", () => {
    let utxoHash: string
    let fundingTx: BitcoinTxInfoStruct
    let reveal: DepositRevealInfoStruct
    let btcRedemptionAddress: string
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"

    beforeEach(async () => {
      await createSnapshot()

      // Set up a live wallet
      await bridge.setWallet(walletPubKeyHash, {
        ecdsaWalletID: ethers.constants.HashZero,
        mainUtxoHash: ethers.constants.HashZero,
        pendingRedemptionsValue: 0,
        createdAt: await lastBlockTime(),
        movingFundsRequestedAt: 0,
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.Live,
        movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
      })

      // Set up funding transaction and reveal
      fundingTx = {
        version: "0x01000000",
        inputVector:
          "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20dc2b952f0100000000ffffffff",
        outputVector:
          "0x0200e1f50500000000" + // 1 BTC
          "17a9142c1444d23936c57bdd8b3e67e5938a5440cda45587" +
          "7ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      }

      reveal = {
        fundingOutputIndex: 0,
        blindingFactor: "0xf9f0c90d00039523",
        walletPubKeyHash: walletPubKeyHash,
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x60bcea61",
        vault: ethers.constants.AddressZero,
      }

      btcRedemptionAddress = "0x1234567890123456789012345678901234567890"

      // Create a reserved deposit
      await bridge
        .connect(depositor)
        .revealReservedDeposit(fundingTx, reveal, 365, btcRedemptionAddress)

      utxoHash = computeUtxoHash(fundingTx, reveal)

      await bridge.finalizeReservedDepositForTest(utxoHash, 0)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should successfully liquidate an expired reservation", async () => {
      // Fast forward time to make reservation expire
      await increaseTime(366 * 86400)

      // Liquidate the reservation
      await bridge
        .connect(liquidator)
        .liquidateExpiredReservation(utxoHash)

      // Storage fee was 0.01 BTC, liquidator gets 10% = 0.001 BTC
      const expectedBonus = ethers.utils.parseUnits("0.001", 8)

      // Check liquidator received the bonus
      const liquidatorBalance = await bank.balanceOf(liquidator.address)
      expect(liquidatorBalance).to.equal(expectedBonus)

      // Bridge should no longer hold the liquidation bonus reserve
      expect(await bank.balanceOf(bridge.address)).to.equal(0)

      // Cannot check reservation anymore - getReservedDeposit was removed
    })

    it("should revert if reservation has not expired", async () => {
      await expect(
        bridge.connect(liquidator).liquidateExpiredReservation(utxoHash)
      ).to.be.revertedWith("Not expired")
    })

    it("should revert if reservation is not active", async () => {
      // Fast forward time to expire
      await increaseTime(366 * 86400)

      // Liquidate once
      await bridge.connect(liquidator).liquidateExpiredReservation(utxoHash)

      // Try to liquidate again
      await expect(
        bridge.connect(liquidator).liquidateExpiredReservation(utxoHash)
      ).to.be.revertedWith("Not active")
    })

    it("should distribute 90% of storage fee to treasury and 10% to liquidator on expiry", async () => {
      // Initial state: depositor has 0.99 tBTC, treasury has 0.009 tBTC
      const depositorBalance = await bank.balanceOf(depositor.address)
      const treasuryBalance = await bank.balanceOf(treasury.address)

      expect(depositorBalance).to.equal(ethers.utils.parseUnits("0.99", 8))
      expect(treasuryBalance).to.equal(ethers.utils.parseUnits("0.009", 8))

      // Fast forward time to make reservation expire
      await increaseTime(366 * 86400) // 366 days

      // Liquidate the expired reservation
      // This transfers (not mints) 0.001 tBTC to liquidator
      await bridge.connect(liquidator).liquidateExpiredReservation(utxoHash)

      // Check final balances
      const liquidatorBalanceFinal = await bank.balanceOf(liquidator.address)
      const treasuryFinalBalance = await bank.balanceOf(treasury.address)

      expect(liquidatorBalanceFinal).to.equal(ethers.utils.parseUnits("0.001", 8))
      expect(treasuryFinalBalance).to.equal(ethers.utils.parseUnits("0.009", 8))

      // Verify total minted maintains 1:1 backing
      // Total: 0.99 (depositor) + 0.009 (treasury) + 0.001 (liquidator) = 1.0 tBTC = 1.0 BTC backing
      const totalMinted = depositorBalance.add(treasuryFinalBalance).add(liquidatorBalanceFinal)
      expect(totalMinted).to.equal(ethers.utils.parseUnits("1.0", 8))

      expect(await bank.balanceOf(bridge.address)).to.equal(0)
    })
  })

  // sweepReservationFees and isReservationExpired tests removed - functions no longer exposed in Bridge
})
