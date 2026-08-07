/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, helpers, waffle } from "hardhat"
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
  ReservationVault,
  TBTCVault,
  TBTC,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { walletState } from "../fixtures"
import { DepositSweepTestData, SingleP2WSHDeposit } from "../data/deposit-sweep"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time
const { impersonateAccount } = helpers.account

const ZERO_ADDRESS = ethers.constants.AddressZero
const ZERO_BYTES32 = ethers.constants.HashZero

const RESERVATION_TERM = 31536000 // 365 days
const RESERVATION_GRACE = 2592000 // 30 days
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
const RESERVATION_MAX_TOTAL = BigNumber.from("2100000000000000")
const MAX_RESERVATIONS_PER_WALLET = 10

const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

describe("Bridge - Reservation", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress
  let deployer: SignerWithAddress

  let bank: Bank & BankStub
  let relay: FakeContract<IRelay>
  let bridge: Bridge & BridgeStub
  let tbtc: TBTC & Contract
  let tbtcVault: TBTCVault & Contract
  let reservationVault: ReservationVault
  let bridgeGovernanceSigner: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      spvMaintainer,
      thirdParty,
      treasury,
      bank,
      relay,
      bridge,
      tbtc,
      tbtcVault,
    } = await waffle.loadFixture(bridgeFixture))

    reservationVault = await helpers.contracts.getContract("ReservationVault")

    // The Bridge is governed by the BridgeGovernance contract in the
    // fixture; impersonate it to exercise onlyGovernance functions
    // directly. Production wiring through BridgeGovernance is a follow-up.
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )
  })

  // Impersonates a contract address, funding it via hardhat_setBalance
  // (the impersonateAccount helper funds with a plain transfer, which
  // reverts for contracts without a receive function).
  async function impersonateContract(
    address: string
  ): Promise<SignerWithAddress> {
    await ethers.provider.send("hardhat_impersonateAccount", [address])
    await ethers.provider.send("hardhat_setBalance", [
      address,
      "0x8AC7230489E80000", // 10 ETH
    ])
    return ethers.getSigner(address)
  }

  // Marks the reservation vault as trusted and wires it together with the
  // reservation parameters into the Bridge.
  async function wireReservations() {
    await bridge
      .connect(bridgeGovernanceSigner)
      .setVaultStatus(reservationVault.address, true)
    await bridge
      .connect(bridgeGovernanceSigner)
      .updateReservationParameters(
        reservationVault.address,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET
      )
  }

  // Builds an active reservation record owned by `owner`, custodied by the
  // wallet identified by `walletPubKeyHash`.
  async function activeReservation(
    owner: string,
    walletPubKeyHash: string,
    amountSat: BigNumber
  ) {
    return {
      owner,
      mintedAmount: amountSat,
      acceptedAt: await lastBlockTime(),
      walletPubKeyHash,
      anchorAmount: amountSat,
      expiresAt: (await lastBlockTime()) + RESERVATION_TERM,
      anchorTxHash: ethers.utils.randomBytes(32),
      anchorTxOutputIndex: 0,
      state: 1, // Active
      redemptionRequestedAt: 0,
      redemptionTxMaxFee: 0,
      redeemer: ZERO_ADDRESS,
      redeemerOutputScriptHash: ZERO_BYTES32,
    }
  }

  describe("updateReservationParameters", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .updateReservationParameters(
              reservationVault.address,
              RESERVATION_MIN_AMOUNT,
              RESERVATION_TX_MAX_FEE,
              RESERVATION_TERM,
              RESERVATION_GRACE,
              RESERVATION_MAX_TOTAL,
              MAX_RESERVATIONS_PER_WALLET
            )
        ).to.be.revertedWith("Caller is not the governance")
      })
    })

    context("when called by the governance", () => {
      it("should set the parameters and the reservation vault", async () => {
        const tx = await bridge
          .connect(bridgeGovernanceSigner)
          .updateReservationParameters(
            reservationVault.address,
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_TERM,
            RESERVATION_GRACE,
            RESERVATION_MAX_TOTAL,
            MAX_RESERVATIONS_PER_WALLET
          )

        await expect(tx)
          .to.emit(bridge, "ReservationVaultUpdated")
          .withArgs(reservationVault.address)
        await expect(tx)
          .to.emit(bridge, "ReservationParametersUpdated")
          .withArgs(
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_TERM,
            RESERVATION_GRACE,
            RESERVATION_MAX_TOTAL,
            MAX_RESERVATIONS_PER_WALLET
          )
      })

      it("should revert for a zero transaction max fee", async () => {
        await expect(
          bridge
            .connect(bridgeGovernanceSigner)
            .updateReservationParameters(
              reservationVault.address,
              RESERVATION_MIN_AMOUNT,
              0,
              RESERVATION_TERM,
              RESERVATION_GRACE,
              RESERVATION_MAX_TOTAL,
              MAX_RESERVATIONS_PER_WALLET
            )
        ).to.be.revertedWith(
          "Reservation transaction max fee must be greater than zero"
        )
      })

      it("should revert when changing the vault with active reservations", async () => {
        const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
        await bridge.setReservation(
          12345,
          await activeReservation(
            thirdParty.address,
            walletPubKeyHash,
            BigNumber.from(100000000)
          )
        )

        await expect(
          bridge
            .connect(bridgeGovernanceSigner)
            .updateReservationParameters(
              thirdParty.address,
              RESERVATION_MIN_AMOUNT,
              RESERVATION_TX_MAX_FEE,
              RESERVATION_TERM,
              RESERVATION_GRACE,
              RESERVATION_MAX_TOTAL,
              MAX_RESERVATIONS_PER_WALLET
            )
        ).to.be.revertedWith("Active reservations exist")
      })
    })
  })

  describe("deposit sweep guard", () => {
    before(async () => {
      await createSnapshot()
      await wireReservations()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should refuse to sweep deposits routed to the reservation vault", async () => {
      const data: DepositSweepTestData = JSON.parse(
        JSON.stringify(SingleP2WSHDeposit)
      )
      // Route the revealed deposit and the sweep to the reservation vault.
      data.deposits[0].reveal.vault = reservationVault.address
      data.vault = reservationVault.address

      relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
      relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

      await bridge.setDepositDustThreshold(10000)
      await bridge.setDepositTxMaxFee(2000)
      await bridge.setDepositRevealAheadPeriod(0)

      const { fundingTx, depositor, reveal } = data.deposits[0]
      await bridge.setWallet(reveal.walletPubKeyHash, {
        ecdsaWalletID: ethers.utils.randomBytes(32),
        mainUtxoHash: ZERO_BYTES32,
        pendingRedemptionsValue: 0,
        createdAt: await lastBlockTime(),
        movingFundsRequestedAt: 0,
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.Live,
        movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
      })

      const depositorSigner = await impersonateAccount(depositor, {
        from: governance,
        value: 10,
      })
      await bridge.connect(depositorSigner).revealDeposit(fundingTx, reveal)

      await expect(
        bridge
          .connect(spvMaintainer)
          .submitDepositSweepProof(
            data.sweepTx,
            data.sweepProof,
            data.mainUtxo,
            data.vault
          )
      ).to.be.revertedWith("Reserved deposits must not be swept")
    })
  })

  describe("extendReservation", () => {
    const reservationKey = 777
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"

    before(async () => {
      await createSnapshot()
      await wireReservations()
      await bridge.setReservation(
        reservationKey,
        await activeReservation(
          thirdParty.address,
          walletPubKeyHash,
          BigNumber.from(100000000)
        )
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          bridge.connect(thirdParty).extendReservation(reservationKey)
        ).to.be.revertedWith("Caller is not the reservation vault")
      })
    })

    context("when called by the reservation vault", () => {
      it("should extend the reservation term", async () => {
        const before_ = await bridge.reservations(reservationKey)

        const vaultSigner = await impersonateContract(reservationVault.address)
        const tx = await bridge
          .connect(vaultSigner)
          .extendReservation(reservationKey)

        const after_ = await bridge.reservations(reservationKey)
        expect(after_.expiresAt).to.equal(before_.expiresAt + RESERVATION_TERM)
        await expect(tx)
          .to.emit(bridge, "ReservationExtended")
          .withArgs(reservationKey, after_.expiresAt)
      })
    })
  })

  describe("requestReservedRedemption", () => {
    const reservationKey = 888
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
    const amountSat = BigNumber.from(100000000) // 1 BTC
    // A valid P2WPKH redeemer output script.
    const redeemerOutputScript =
      "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"

    before(async () => {
      await createSnapshot()
      await wireReservations()

      // A Terminated wallet lets the timeout path skip slashing and state
      // transitions, isolating the reservation bookkeeping under test.
      await bridge.setWallet(walletPubKeyHash, {
        ecdsaWalletID: ethers.utils.randomBytes(32),
        mainUtxoHash: ZERO_BYTES32,
        pendingRedemptionsValue: 0,
        createdAt: await lastBlockTime(),
        movingFundsRequestedAt: 0,
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.Terminated,
        movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
      })

      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      // Give the reservation vault the gross Bank balance it must
      // surrender with the request.
      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalance(reservationVault.address, amountSat)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a third party", async () => {
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservedRedemption(
            reservationKey,
            thirdParty.address,
            redeemerOutputScript
          )
      ).to.be.revertedWith("Caller is not the reservation vault")
    })

    it("should register the redemption, take the balance, and refund on timeout", async () => {
      const vaultSigner = await impersonateContract(reservationVault.address)

      await bank.connect(vaultSigner).approveBalance(bridge.address, amountSat)

      const tx = await bridge
        .connect(vaultSigner)
        .requestReservedRedemption(
          reservationKey,
          thirdParty.address,
          redeemerOutputScript
        )

      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionRequested")
        .withArgs(
          reservationKey,
          thirdParty.address,
          redeemerOutputScript,
          amountSat,
          RESERVATION_TX_MAX_FEE
        )

      expect((await bridge.reservations(reservationKey)).state).to.equal(2) // RedemptionRequested
      expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)

      // Re-requesting while one is pending must fail.
      await expect(
        bridge
          .connect(vaultSigner)
          .requestReservedRedemption(
            reservationKey,
            thirdParty.address,
            redeemerOutputScript
          )
      ).to.be.revertedWith("Reservation is not active")

      // Timeout: the redeemer gets the balance back and the reservation
      // survives as Active.
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)

      const timeoutTx = await bridge
        .connect(thirdParty)
        .notifyReservedRedemptionTimeout(reservationKey, [])

      await expect(timeoutTx)
        .to.emit(bridge, "ReservedRedemptionTimedOut")
        .withArgs(reservationKey, walletPubKeyHash)

      expect(await bank.balanceOf(thirdParty.address)).to.equal(amountSat)
      expect((await bridge.reservations(reservationKey)).state).to.equal(1) // Active
    })
  })

  describe("ReservationVault", () => {
    const amountSat = BigNumber.from(100000000) // 1 BTC
    const grossTbtc = amountSat.mul(SATOSHI_MULTIPLIER)

    before(async () => {
      await createSnapshot()
      await wireReservations()

      // In the base fixture the TBTC token is still owned by the
      // VendingMachine; hand it to the TBTC vault so minting works.
      const tbtcOwner = await impersonateContract(await tbtc.owner())
      await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    describe("receiveBalanceIncrease", () => {
      it("should revert when not called by the Bank", async () => {
        await expect(
          reservationVault
            .connect(thirdParty)
            .receiveBalanceIncrease([thirdParty.address], [amountSat])
        ).to.be.revertedWith("Caller is not the Bank")
      })

      it("should mint gross TBTC and split the initiation fee", async () => {
        const bridgeSigner = await impersonateContract(bridge.address)

        // Simulates the acceptance-proof credit performed by the Bridge.
        await bank
          .connect(bridgeSigner)
          .increaseBalanceAndCall(
            reservationVault.address,
            [thirdParty.address],
            [amountSat]
          )

        // 40 bps initiation fee.
        const expectedFee = grossTbtc.mul(40).div(10000)
        expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
          grossTbtc.sub(expectedFee)
        )
        expect(await tbtc.balanceOf(treasury.address)).to.equal(expectedFee)
      })
    })

    describe("redeemReservation", () => {
      const reservationKey = 999
      const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
      const redeemerOutputScript =
        "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"

      before(async () => {
        await bridge.setReservation(
          reservationKey,
          await activeReservation(
            thirdParty.address,
            walletPubKeyHash,
            amountSat
          )
        )

        // Fund the owner with enough TBTC for the gross surrender plus the
        // redemption fee by processing another acceptance-sized credit.
        const bridgeSigner = await impersonateContract(bridge.address)
        await bank
          .connect(bridgeSigner)
          .increaseBalanceAndCall(
            reservationVault.address,
            [thirdParty.address],
            [amountSat.mul(2)]
          )
      })

      it("should revert when called by a non-owner", async () => {
        await expect(
          reservationVault
            .connect(governance)
            .redeemReservation(reservationKey, redeemerOutputScript)
        ).to.be.revertedWith("Caller is not the reservation owner")
      })

      it("should surrender gross TBTC, charge the fee, and register the redemption", async () => {
        const fee = grossTbtc.mul(20).div(10000)
        const treasuryBalanceBefore = await tbtc.balanceOf(treasury.address)

        await tbtc
          .connect(thirdParty)
          .approve(reservationVault.address, grossTbtc.add(fee))

        const tx = await reservationVault
          .connect(thirdParty)
          .redeemReservation(reservationKey, redeemerOutputScript)

        await expect(tx)
          .to.emit(reservationVault, "ReservedRedemptionInitiated")
          .withArgs(reservationKey, thirdParty.address, grossTbtc, fee)
        await expect(tx).to.emit(bridge, "ReservedRedemptionRequested")

        expect(await tbtc.balanceOf(treasury.address)).to.equal(
          treasuryBalanceBefore.add(fee)
        )
        expect((await bridge.reservations(reservationKey)).state).to.equal(2)
        expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)
      })
    })
  })
})
