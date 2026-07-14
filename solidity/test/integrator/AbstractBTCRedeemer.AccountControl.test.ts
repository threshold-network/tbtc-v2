import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { expect } from "chai"
import { BigNumberish } from "ethers"

import { walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  MockAccountControlRedemptionNotifier,
  TBTC,
  TBTCVault,
  TestBTCRedeemer,
} from "../../typechain"

const { to1e18 } = helpers.number
const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

// `AbstractBTCRedeemer.test.ts` exercises `_requestRedemption` against
// `MockTBTCVault`, whose `unmint`/`unmintAndRedeem` are plain-transfer stubs
// with no Account Control reconciliation semantics. That mock cannot prove
// the guard on `TBTCVault.unmintAndRedeem` actually works through the
// integrator, so this suite drives the same `_requestRedemption` path
// against the real `TBTCVault`/`Bridge`/`Bank` stack instead.
describe("AbstractBTCRedeemer - Account Control reconciliation", () => {
  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const mainUtxo = {
    txHash:
      "0x3835ecdee2daa83c9a19b5012104ace55ecab197b5e16489c26d372e475f5d2a",
    txOutputIndex: 0,
    txOutputValue: 10000000000,
  }
  const redeemerOutputScript =
    "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"

  const initialBankBalance = to1e18(100)
  const mintedAmount = to1e18(10)
  const redeemedAmount = to1e18(4)
  const redeemedAmountSat = redeemedAmount.div(1e10)

  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let account1: SignerWithAddress

  let bridge: Bridge & BridgeStub
  let bank: Bank & BankStub
  let tbtc: TBTC
  let tbtcVault: TBTCVault
  let redeemer: TestBTCRedeemer
  let notifier: MockAccountControlRedemptionNotifier

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, bridge, bank, tbtcVault, tbtc } =
      await waffle.loadFixture(bridgeFixture))

    // TBTC token ownership transfer is not performed in deployment scripts.
    // Check TransferTBTCOwnership deployment step for more information.
    await tbtc.connect(deployer).transferOwnership(tbtcVault.address)

    const accounts = await getUnnamedAccounts()
    account1 = await ethers.getSigner(accounts[0])

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
    await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)

    const TestBTCRedeemerFactory = await ethers.getContractFactory(
      "TestBTCRedeemer"
    )
    redeemer = await TestBTCRedeemerFactory.deploy()
    await redeemer.initialize(
      bridge.address,
      tbtc.address,
      bank.address,
      tbtcVault.address
    )

    const NotifierFactory = await ethers.getContractFactory(
      "MockAccountControlRedemptionNotifier"
    )
    notifier =
      (await NotifierFactory.deploy()) as MockAccountControlRedemptionNotifier
  })

  // Funds the redeemer contract with `amount` tBTC by minting it to an EOA
  // through the vault's ordinary `mint` entry point, then transferring it
  // into the redeemer contract. A contract cannot sign the mint transaction
  // itself, so this mirrors how a real cross-chain redeemer (e.g.
  // `L1BTCRedeemerWormhole`) ends up holding tBTC via an inbound bridge
  // transfer.
  const fundRedeemer = async (amount: BigNumberish) => {
    await bank.setBalance(account1.address, initialBankBalance)
    await bank.connect(account1).approveBalance(tbtcVault.address, amount)
    await tbtcVault.connect(account1).mint(amount)
    await tbtc.connect(account1).transfer(redeemer.address, amount)
  }

  const requestRedemption = () =>
    redeemer.requestRedemptionPublic(
      walletPubKeyHash,
      mainUtxo,
      redeemerOutputScript,
      redeemedAmountSat
    )

  context("when reconciliation is never activated (legacy behaviour)", () => {
    before(async () => {
      await createSnapshot()
      await fundRedeemer(mintedAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("completes the cross-chain redemption without any reconciliation call", async () => {
      await requestRedemption()

      expect(await notifier.callCount()).to.equal(0)

      const redemptionKey = await redeemer.getRedemptionKeyPublic(
        walletPubKeyHash,
        redeemerOutputScript
      )
      const redemption = await bridge.pendingRedemptions(redemptionKey)
      expect(redemption.redeemer).to.equal(redeemer.address)
      expect(redemption.requestedAmount).to.equal(redeemedAmountSat)
      expect(await bank.balanceOf(bridge.address)).to.equal(redeemedAmountSat)
    })
  })

  context("when reconciliation is required and the notifier is healthy", () => {
    before(async () => {
      await createSnapshot()
      await fundRedeemer(mintedAmount)
      await tbtcVault
        .connect(governance)
        .activateAccountControlReconciliation(notifier.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("reconciles AC exposure and completes the cross-chain redemption", async () => {
      await requestRedemption()

      expect(await notifier.callCount()).to.equal(1)
      expect(await notifier.lastRedeemer()).to.equal(redeemer.address)
      expect(await notifier.lastAmount()).to.equal(redeemedAmount)

      const redemptionKey = await redeemer.getRedemptionKeyPublic(
        walletPubKeyHash,
        redeemerOutputScript
      )
      const redemption = await bridge.pendingRedemptions(redemptionKey)
      expect(redemption.redeemer).to.equal(redeemer.address)
      expect(redemption.requestedAmount).to.equal(redeemedAmountSat)
      expect(await bank.balanceOf(bridge.address)).to.equal(redeemedAmountSat)
    })
  })

  context(
    "when reconciliation is required but no notifier is configured",
    () => {
      before(async () => {
        await createSnapshot()
        await fundRedeemer(mintedAmount)
        await tbtcVault
          .connect(governance)
          .activateAccountControlReconciliation(notifier.address)
        await tbtcVault
          .connect(governance)
          .setAccountControlRedemptionNotifier(ethers.constants.AddressZero)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("fails closed through the integrator instead of being swallowed", async () => {
        await expect(requestRedemption()).to.be.revertedWith(
          "Account Control reconciliation required"
        )

        expect(await tbtc.balanceOf(redeemer.address)).to.equal(mintedAmount)
      })
    }
  )

  context("when reconciliation is required and the notifier reverts", () => {
    before(async () => {
      await createSnapshot()
      await fundRedeemer(mintedAmount)
      await tbtcVault
        .connect(governance)
        .activateAccountControlReconciliation(notifier.address)
      await notifier.setShouldRevert(true)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("fails closed through the integrator instead of being swallowed", async () => {
      await expect(requestRedemption()).to.be.revertedWith(
        "AC reconciliation failed"
      )

      expect(await tbtc.balanceOf(redeemer.address)).to.equal(mintedAmount)
    })
  })
})
