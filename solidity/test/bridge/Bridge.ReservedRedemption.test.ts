/**
 * End-to-end coverage for the reserved-redemption surface ported from
 * `origin/feat/utxo-reservation-settlement` (settlement branch, whole-
 * reservation ABI) onto `reservations-upgrade`:
 *
 *   - `Reservation.requestReservedRedemption` through the router fallback,
 *     including the fee-paid escrow, the timeout path
 *     (`notifyReservationRedemptionTimedOut`), retry-credit minting and the
 *     wallet consequences
 *   - `Reservation.extendReservation` (vault-gated term extension against
 *     the LIVE `reservationTermSeconds` / `reservationDissolutionDelay`
 *     parameters - the base model has no per-position `termSeconds`
 *     snapshot, unlike the settlement branch)
 *   - `Reservation.notifyReservedRedemptionVeto` (watchtower-gated
 *     generation veto)
 *   - The `RedemptionWatchtower` reserved veto surface
 *     (`raiseReservedObjection`, `reservedVetoKey`,
 *     `getReservedRedemptionDelay(Schedule)`, `isSafeReservedRedemption`)
 *     and the request-time delay snapshots into the action record
 *   - The `ReservationVault` redemption entry points
 *     (`redeemReservation`, `retryRedeemReservation`, `extendCustody`)
 *     with fee accounting against the real Bank/TBTC plumbing
 *
 * ABI divergence (deliberate, human-approved 2026-09-04): the base vault
 * shipped M1-disabled stubs whose `amountSat` parameter reserved ABI space
 * for milestone 2's partial-redemption design
 * (`feat/utxo-reservation-partial-redemption`). This file exercises the
 * settlement-style whole-reservation script-based ABI that replaced those
 * stubs. Milestone 2 must reconcile the partial-redemption ABI with the
 * deployed whole-reservation interface.
 */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, Contract } from "ethers"
import { expect } from "chai"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  IWalletRegistry,
  IRelay,
  ReimbursementPool,
  ReservationRouter,
  ReservationVault,
  TBTC,
  TBTCVault,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import type { Mock } from "../helpers/mock"
import { walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const ZERO_BYTES32 = ethers.constants.HashZero

const RESERVATION_TERM = 31536000 // 365 days
const RESERVATION_GRACE = 2592000 // 30 days
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
const RESERVATION_MAX_TOTAL = BigNumber.from("10000000")
const MAX_RESERVATIONS_PER_WALLET = 10
const RESERVATION_ACTION_TIMEOUT = 172800 // 48 hours
const RESERVATION_RENEWAL_WINDOW = 2592000 // 30 days

const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

const ReservationState = {
  Unknown: 0,
  Active: 1,
  ActionPending: 2,
  Closed: 3,
  Stranded: 4,
}

const ActionType = {
  None: 0,
  Acceptance: 1,
  Redemption: 2,
  Reanchor: 3,
  Dissolution: 4,
}

const ActionState = {
  Unknown: 0,
  Pending: 1,
  Settled: 2,
  TimedOut: 3,
  Vetoed: 4,
  Superseded: 5,
}

const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
// A valid P2WPKH redeemer output script.
const redeemerOutputScript = "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"

describe("Bridge - Reserved redemption", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress
  let deployer: SignerWithAddress

  let bank: Bank & BankStub
  let relay: Mock<IRelay>
  let walletRegistry: Mock<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let reservationRouter: ReservationRouter
  let reservationContract: Contract
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
      walletRegistry,
      bridge,
      tbtc,
      tbtcVault,
    } = await bridgeFixture())

    // Reservation router functions are declared on `ReservationRouter`,
    // not `Bridge`, and only reachable through `Bridge.fallback()`'s
    // delegatecall. `ethers.getContractAt` with the router's ABI but
    // Bridge's address gives correctly-encoded calls that land on the
    // fallback, exactly like the production caller path.
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
    // The reservation-surface events (`ReservationRedemptionRequested`,
    // `ReservationExtended`, etc.) are declared on the `Reservation`
    // library, whose code the Bridge executes via delegatecall from the
    // router. They are not part of the Bridge's own ABI, so event
    // assertions use a `Reservation`-ABI instance bound to the Bridge
    // address where the logs actually land.
    reservationContract = await ethers.getContractAt(
      "Reservation",
      bridge.address
    )
    reservationVault = await helpers.contracts.getContract("ReservationVault")
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )

    await relay.getCurrentEpochDifficulty.returns(0)
    await relay.getPrevEpochDifficulty.returns(0)

    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(2000)
    await bridge.setDepositRevealAheadPeriod(0)

    const tbtcOwner = await impersonateContract(await tbtc.owner())
    await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.address)
  })

  /// Wires the reservation vault and parameters into the Bridge the way
  /// the acceptance path requires (`msg.sender == reservationVault`,
  /// live caps/params).
  async function wireReservations() {
    await bridge
      .connect(bridgeGovernanceSigner)
      .setVaultStatus(reservationVault.address, true)
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationCaps(RESERVATION_MAX_TOTAL, RESERVATION_MAX_TOTAL, 100)
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationParameters(
        reservationVault.address,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET,
        RESERVATION_ACTION_TIMEOUT,
        RESERVATION_RENEWAL_WINDOW
      )
  }

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

  async function liveWallet(pkh: string) {
    await bridge.setWallet(pkh, {
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
    // A main UTXO makes the redemption-timeout path route the Live wallet
    // to MovingFunds (base `Wallets.moveFunds`), keeping it eligible for
    // re-requests and retries; without one the wallet goes to Closing.
    await bridge.setWalletMainUtxo(pkh, {
      txHash: ethers.utils.randomBytes(32),
      txOutputIndex: 0,
      txOutputValue: 100000000,
    })
  }

  /// Builds an active reservation position owned by `owner`, custodied by
  /// the wallet identified by `walletPubKeyHash` (base struct shape).
  async function activeReservation(
    owner: string,
    pkh: string,
    amountSat: BigNumber
  ) {
    return {
      owner,
      mintedAmount: amountSat,
      acceptedAt: await lastBlockTime(),
      walletPubKeyHash: pkh,
      anchorAmount: amountSat,
      expiresAt: (await lastBlockTime()) + RESERVATION_TERM,
      anchorTxHash: ethers.utils.randomBytes(32),
      anchorTxOutputIndex: 0,
      state: ReservationState.Active,
      requestNonce: 0,
      retryCredit: false,
      dissolutionEligibleAt:
        (await lastBlockTime()) + RESERVATION_TERM + RESERVATION_GRACE,
      cumulativeReanchorFee: 0,
      reanchorCooldownUntil: 0,
    }
  }

  /// Requests a reserved redemption through the impersonated vault,
  /// funding and approving the gross Bank balance surrender.
  async function requestRedemptionViaVault(
    reservationKey: BigNumber | number,
    amountSat: BigNumber,
    redeemer: string,
    script: string,
    options: { feePaid?: boolean; useRetryCredit?: boolean } = {}
  ) {
    const bridgeSigner = await impersonateContract(bridge.address)
    await bank
      .connect(bridgeSigner)
      .increaseBalance(reservationVault.address, amountSat)
    const vaultSigner = await impersonateContract(reservationVault.address)
    // Bank allowances are non-atomic: a reverted request leaves a
    // non-zero allowance behind, so reset before (re)approving.
    await bank.connect(vaultSigner).approveBalance(bridge.address, 0)
    await bank.connect(vaultSigner).approveBalance(bridge.address, amountSat)
    return reservationRouter
      .connect(vaultSigner)
      .requestReservedRedemption(
        reservationKey,
        redeemer,
        script,
        options.feePaid ?? true,
        options.useRetryCredit ?? false
      )
  }

  describe("requestReservedRedemption", () => {
    const reservationKey = 888
    const amountSat = BigNumber.from(100000000) // 1 BTC

    before(async () => {
      await createSnapshot()
      await wireReservations()
      await liveWallet(walletPubKeyHash)

      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a third party", async () => {
      await expect(
        reservationRouter
          .connect(thirdParty)
          .requestReservedRedemption(
            reservationKey,
            thirdParty.address,
            redeemerOutputScript,
            true,
            false
          )
      ).to.be.revertedWith("Caller is not the reservation vault")
    })

    it("should reject a zero redeemer", async () => {
      await expect(
        requestRedemptionViaVault(
          reservationKey,
          amountSat,
          ethers.constants.AddressZero,
          redeemerOutputScript
        )
      ).to.be.revertedWith("Redeemer must not be the zero address")
    })

    it("should reject a non-standard redeemer output script", async () => {
      await expect(
        requestRedemptionViaVault(
          reservationKey,
          amountSat,
          thirdParty.address,
          "0xaa"
        )
      ).to.be.revertedWith("Redeemer output script must be a standard type")
    })

    it("should register the generation, take the balance, and refund on timeout", async () => {
      const tx = await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )

      await expect(tx)
        .to.emit(reservationContract, "ReservationRedemptionRequested")
        .withArgs(
          reservationKey,
          1,
          thirdParty.address,
          redeemerOutputScript,
          amountSat,
          RESERVATION_TX_MAX_FEE,
          true
        )

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.ActionPending)
      expect(reservation.requestNonce).to.equal(1)
      expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)

      const action = await reservationRouter.reservationActions(
        reservationKey,
        1
      )
      expect(action.actionType).to.equal(ActionType.Redemption)
      expect(action.state).to.equal(ActionState.Pending)
      expect(action.redeemer).to.equal(thirdParty.address)
      expect(action.amount).to.equal(amountSat)
      expect(action.feePaid).to.be.true

      // Re-requesting while one is pending must fail.
      const vaultSigner = await impersonateContract(reservationVault.address)
      await expect(
        reservationRouter
          .connect(vaultSigner)
          .requestReservedRedemption(
            reservationKey,
            thirdParty.address,
            redeemerOutputScript,
            true,
            false
          )
      ).to.be.revertedWith("Reservation is not active")

      // Timeout: the redeemer gets the balance back, the terminal record
      // persists, the fee-paid generation mints the retry entitlement and
      // the reservation survives as Active.
      await increaseTime(action.timeoutAt + 1 - (await lastBlockTime()))

      const timeoutTx = await reservationRouter
        .connect(thirdParty)
        .notifyReservationRedemptionTimedOut(reservationKey, [])

      await expect(timeoutTx)
        .to.emit(reservationContract, "ReservationRedemptionTimedOut")
        .withArgs(reservationKey, 1)
      await expect(timeoutTx)
        .to.emit(reservationContract, "ReservationRetryCreditMinted")
        .withArgs(reservationKey)

      expect(await bank.balanceOf(thirdParty.address)).to.equal(amountSat)

      const reservationAfter = await reservationRouter.reservations(
        reservationKey
      )
      expect(reservationAfter.state).to.equal(ReservationState.Active)
      expect(reservationAfter.retryCredit).to.be.true

      expect(
        (await reservationRouter.reservationActions(reservationKey, 1)).state
      ).to.equal(ActionState.TimedOut)

      // The wallet was pushed toward retirement (it holds a reservation
      // and no main UTXO, so it enters MovingFunds rather than Closing).
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.MovingFunds
      )
    })
  })

  describe("requestReservedRedemption gating", () => {
    const reservationKey = 889
    const amountSat = BigNumber.from(100000000)

    before(async () => {
      await createSnapshot()
      await wireReservations()
      await liveWallet(walletPubKeyHash)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should reject a non-active reservation", async () => {
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )
      await bridge.setReservation(reservationKey, {
        ...(await activeReservation(
          thirdParty.address,
          walletPubKeyHash,
          amountSat
        )),
        state: ReservationState.Unknown,
      })
      await expect(
        requestRedemptionViaVault(
          reservationKey,
          amountSat,
          thirdParty.address,
          redeemerOutputScript
        )
      ).to.be.revertedWith("Reservation is not active")
    })

    it("should reject a request past the dissolution eligibility time", async () => {
      await bridge.setReservation(reservationKey, {
        ...(await activeReservation(
          thirdParty.address,
          walletPubKeyHash,
          amountSat
        )),
        dissolutionEligibleAt: 1,
      })
      await expect(
        requestRedemptionViaVault(
          reservationKey,
          amountSat,
          thirdParty.address,
          redeemerOutputScript
        )
      ).to.be.revertedWith("Reservation past grace period")
    })

    it("should exempt a retry request from the grace-period gate", async () => {
      await bridge.setReservation(reservationKey, {
        ...(await activeReservation(
          thirdParty.address,
          walletPubKeyHash,
          amountSat
        )),
        dissolutionEligibleAt: 1,
        retryCredit: true,
      })
      await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript,
        { feePaid: false, useRetryCredit: true }
      )
      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.ActionPending)
      expect(reservation.requestNonce).to.equal(1)
      // The retry entitlement was consumed by the exempted request.
      expect(reservation.retryCredit).to.be.false
    })
  })

  describe("extendReservation", () => {
    const reservationKey = 777
    const amountSat = BigNumber.from(100000000)

    before(async () => {
      await createSnapshot()
      await wireReservations()
      await liveWallet(walletPubKeyHash)
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a third party", async () => {
      await expect(
        reservationRouter.connect(thirdParty).extendReservation(reservationKey)
      ).to.be.revertedWith("Caller is not the reservation vault")
    })

    it("should extend the term against the live term and dissolution delay parameters", async () => {
      const before = await reservationRouter.reservations(reservationKey)

      // Change the live parameters: this port extends against the live
      // `reservationTermSeconds` / `reservationDissolutionDelay`, not a
      // per-position snapshot (the base model removed `termSeconds` /
      // `gracePeriod` from the request record).
      await reservationRouter
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          reservationVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_TERM * 2,
          RESERVATION_GRACE * 2,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          RESERVATION_ACTION_TIMEOUT,
          RESERVATION_RENEWAL_WINDOW
        )

      const vaultSigner = await impersonateContract(reservationVault.address)
      const tx = await reservationRouter
        .connect(vaultSigner)
        .extendReservation(reservationKey)

      const after = await reservationRouter.reservations(reservationKey)
      expect(after.expiresAt).to.equal(before.expiresAt + RESERVATION_TERM * 2)
      expect(after.dissolutionEligibleAt).to.equal(
        after.expiresAt + RESERVATION_GRACE * 2
      )
      await expect(tx)
        .to.emit(reservationContract, "ReservationExtended")
        .withArgs(reservationKey, after.expiresAt)
    })
  })

  describe("notifyReservedRedemptionVeto", () => {
    const reservationKey = 555
    const amountSat = BigNumber.from(100000000)

    before(async () => {
      await createSnapshot()
      await wireReservations()
      await liveWallet(walletPubKeyHash)

      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )

      // Wire the watchtower only after the request so the safety gate
      // does not call an EOA.
      await bridge
        .connect(bridgeGovernanceSigner)
        .setRedemptionWatchtower(deployer.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a third party", async () => {
      await expect(
        reservationRouter
          .connect(thirdParty)
          .notifyReservedRedemptionVeto(reservationKey, 1)
      ).to.be.revertedWith("Caller is not the redemption watchtower")
    })

    it("should revert for a non-current generation", async () => {
      await expect(
        reservationRouter
          .connect(deployer)
          .notifyReservedRedemptionVeto(reservationKey, 2)
      ).to.be.revertedWith("Not the current generation")
    })

    it("should detain the balance, void the generation, and reactivate the reservation", async () => {
      const tx = await reservationRouter
        .connect(deployer)
        .notifyReservedRedemptionVeto(reservationKey, 1)

      await expect(tx)
        .to.emit(reservationContract, "ReservationRedemptionVetoed")
        .withArgs(reservationKey, 1)

      expect(await bank.balanceOf(deployer.address)).to.equal(amountSat)

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      // A veto is owner-fault: no retry entitlement is minted.
      expect(reservation.retryCredit).to.be.false

      expect(
        (await reservationRouter.reservationActions(reservationKey, 1)).state
      ).to.equal(ActionState.Vetoed)
    })
  })

  describe("RedemptionWatchtower reserved veto flow", () => {
    const reservationKey = 666
    const amountSat = BigNumber.from(100000000)
    let redemptionWatchtower: Contract
    let guardianSigners: SignerWithAddress[]

    const vetoKeyOf = (key: BigNumber | number, nonce: number): string =>
      ethers.utils.solidityKeccak256(["uint256", "uint64"], [key, nonce])

    before(async () => {
      await createSnapshot()
      await wireReservations()

      redemptionWatchtower = await helpers.contracts.getContract(
        "RedemptionWatchtower"
      )

      guardianSigners = (await ethers.getSigners()).slice(10, 13)
      if ((await redemptionWatchtower.watchtowerEnabledAt()) === 0) {
        const watchtowerOwner = await impersonateContract(
          await redemptionWatchtower.owner()
        )
        await redemptionWatchtower.connect(watchtowerOwner).enableWatchtower(
          governance.address,
          guardianSigners.map((g) => g.address)
        )
      } else {
        const manager = await impersonateContract(
          await redemptionWatchtower.manager()
        )
        // eslint-disable-next-line no-restricted-syntax
        for (const guardian of guardianSigners) {
          // eslint-disable-next-line no-await-in-loop
          const alreadyGuardian = await redemptionWatchtower.isGuardian(
            guardian.address
          )
          if (!alreadyGuardian) {
            // eslint-disable-next-line no-await-in-loop
            await redemptionWatchtower
              .connect(manager)
              .addGuardian(guardian.address)
          }
        }
      }
      await bridge
        .connect(bridgeGovernanceSigner)
        .setRedemptionWatchtower(redemptionWatchtower.address)

      await liveWallet(walletPubKeyHash)
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("vetoes a reserved redemption generation after three guardian objections", async () => {
      await redemptionWatchtower
        .connect(guardianSigners[0])
        .raiseReservedObjection(reservationKey, 1)
      await redemptionWatchtower
        .connect(guardianSigners[1])
        .raiseReservedObjection(reservationKey, 1)

      const tx = await redemptionWatchtower
        .connect(guardianSigners[2])
        .raiseReservedObjection(reservationKey, 1)

      const vetoKey = vetoKeyOf(reservationKey, 1)
      await expect(tx)
        .to.emit(redemptionWatchtower, "VetoFinalized")
        .withArgs(vetoKey)
      await expect(tx)
        .to.emit(reservationContract, "ReservationRedemptionVetoed")
        .withArgs(reservationKey, 1)
      await expect(tx)
        .to.emit(redemptionWatchtower, "Banned")
        .withArgs(thirdParty.address)

      // The reservation survives the veto as Active; the generation is
      // terminally vetoed.
      expect(
        (await reservationRouter.reservations(reservationKey)).state
      ).to.equal(ReservationState.Active)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 1)).state
      ).to.equal(ActionState.Vetoed)

      // Default penalty is 100%: the whole detained amount is burned.
      const veto = await redemptionWatchtower.vetoProposals(vetoKey)
      expect(veto.withdrawableAmount).to.equal(0)
      expect(await bank.balanceOf(redemptionWatchtower.address)).to.equal(0)

      // The banned owner cannot re-request through the vault: the
      // reservation-scoped safety gate now rejects them.
      const vaultSigner = await impersonateContract(reservationVault.address)
      await expect(
        reservationRouter
          .connect(vaultSigner)
          .requestReservedRedemption(
            reservationKey,
            thirdParty.address,
            redeemerOutputScript,
            true,
            false
          )
      ).to.be.revertedWith("Redemption request rejected by the watchtower")
    })

    it("starts every new generation with a clean objection count once unbanned", async () => {
      await redemptionWatchtower.connect(governance).unban(thirdParty.address)

      await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )

      const reservation = await reservationRouter.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.ActionPending)
      expect(reservation.requestNonce).to.equal(2)

      await redemptionWatchtower
        .connect(guardianSigners[0])
        .raiseReservedObjection(reservationKey, 2)
      const veto = await redemptionWatchtower.vetoProposals(
        vetoKeyOf(reservationKey, 2)
      )
      expect(veto.objectionsCount).to.equal(1)
      expect(
        (await reservationRouter.reservations(reservationKey)).state
      ).to.equal(ReservationState.ActionPending)
    })
  })

  describe("RedemptionWatchtower reserved delay snapshots", () => {
    const reservationKey = 667
    const amountSat = BigNumber.from(100000000)
    let redemptionWatchtower: Contract
    let guardianSigners: SignerWithAddress[]
    let watchtowerManager: SignerWithAddress

    async function updateDelayPolicy(
      defaultDelay: number,
      levelOneDelay: number,
      levelTwoDelay: number,
      waivedAmountLimit: BigNumber | number
    ) {
      return redemptionWatchtower
        .connect(watchtowerManager)
        .updateWatchtowerParameters(
          await redemptionWatchtower.watchtowerLifetime(),
          20,
          await redemptionWatchtower.vetoFreezePeriod(),
          defaultDelay,
          levelOneDelay,
          levelTwoDelay,
          waivedAmountLimit
        )
    }

    async function requestRedemption() {
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )
      await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )
    }

    const vetoKeyOf = (key: BigNumber | number, nonce: number): string =>
      ethers.utils.solidityKeccak256(["uint256", "uint64"], [key, nonce])

    before(async () => {
      await createSnapshot()
      await wireReservations()

      redemptionWatchtower = await helpers.contracts.getContract(
        "RedemptionWatchtower"
      )
      guardianSigners = (await ethers.getSigners()).slice(10, 13)
      const watchtowerOwner = await impersonateContract(
        await redemptionWatchtower.owner()
      )
      await redemptionWatchtower.connect(watchtowerOwner).enableWatchtower(
        governance.address,
        guardianSigners.map((guardian) => guardian.address)
      )
      watchtowerManager = await impersonateContract(
        await redemptionWatchtower.manager()
      )
      await bridge
        .connect(bridgeGovernanceSigner)
        .setRedemptionWatchtower(redemptionWatchtower.address)

      await liveWallet(walletPubKeyHash)
    })

    after(async () => {
      await restoreSnapshot()
    })

    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("keeps every objection-level delay on the old generation and applies updates to the next one", async () => {
      const defaultDelay = await redemptionWatchtower.defaultDelay()
      const levelOneDelay = await redemptionWatchtower.levelOneDelay()
      const levelTwoDelay = await redemptionWatchtower.levelTwoDelay()
      await requestRedemption()

      const oldAction = await reservationRouter.reservationActions(
        reservationKey,
        1
      )
      expect(oldAction.watchtowerDefaultDelay).to.equal(defaultDelay)
      expect(oldAction.watchtowerLevelOneDelay).to.equal(levelOneDelay)
      expect(oldAction.watchtowerLevelTwoDelay).to.equal(levelTwoDelay)

      expect(
        await redemptionWatchtower.getReservedRedemptionDelay(reservationKey, 1)
      ).to.equal(defaultDelay)

      const newDefaultDelay = defaultDelay + 60
      const newLevelOneDelay = levelOneDelay + 120
      const newLevelTwoDelay = levelTwoDelay + 180
      await updateDelayPolicy(
        newDefaultDelay,
        newLevelOneDelay,
        newLevelTwoDelay,
        0
      )

      // Policy changes never rewrite the authorization window of an already
      // requested generation.
      expect(
        await redemptionWatchtower.getReservedRedemptionDelay(reservationKey, 1)
      ).to.equal(defaultDelay)

      await redemptionWatchtower
        .connect(guardianSigners[0])
        .raiseReservedObjection(reservationKey, 1)
      expect(
        await redemptionWatchtower.getReservedRedemptionDelay(reservationKey, 1)
      ).to.equal(levelOneDelay)

      await redemptionWatchtower
        .connect(guardianSigners[1])
        .raiseReservedObjection(reservationKey, 1)
      expect(
        await redemptionWatchtower.getReservedRedemptionDelay(reservationKey, 1)
      ).to.equal(levelTwoDelay)

      await redemptionWatchtower
        .connect(guardianSigners[2])
        .raiseReservedObjection(reservationKey, 1)
      await redemptionWatchtower
        .connect(watchtowerManager)
        .unban(thirdParty.address)

      await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )
      expect(
        await redemptionWatchtower.getReservedRedemptionDelay(reservationKey, 2)
      ).to.equal(newDefaultDelay)
    })

    it("keeps a waived generation objection-free after the waiver policy changes", async () => {
      const defaultDelay = await redemptionWatchtower.defaultDelay()
      const levelOneDelay = await redemptionWatchtower.levelOneDelay()
      const levelTwoDelay = await redemptionWatchtower.levelTwoDelay()
      await updateDelayPolicy(
        defaultDelay,
        levelOneDelay,
        levelTwoDelay,
        amountSat.add(1)
      )
      await requestRedemption()

      const action = await reservationRouter.reservationActions(
        reservationKey,
        1
      )
      expect(action.watchtowerDefaultDelay).to.equal(0)
      expect(action.watchtowerLevelOneDelay).to.equal(0)
      expect(action.watchtowerLevelTwoDelay).to.equal(0)

      // Removing the waiver affects future generations only. This generation
      // retains the zero schedule captured when it was requested.
      await updateDelayPolicy(defaultDelay, levelOneDelay, levelTwoDelay, 0)
      expect(
        await redemptionWatchtower.getReservedRedemptionDelay(reservationKey, 1)
      ).to.equal(0)
      await expect(
        redemptionWatchtower
          .connect(guardianSigners[0])
          .raiseReservedObjection(reservationKey, 1)
      ).to.be.revertedWith("Redemption veto delay period expired")
    })

    it("captures a zero schedule after the watchtower is disabled", async () => {
      const lifetimeExpiresAt =
        (await redemptionWatchtower.watchtowerEnabledAt()) +
        (await redemptionWatchtower.watchtowerLifetime())
      // The lifetime bound is strict (`> watchtowerEnabledAt + lifetime`).
      await increaseTime(lifetimeExpiresAt - (await lastBlockTime()) + 1)
      await redemptionWatchtower.connect(thirdParty).disableWatchtower()

      await requestRedemption()

      const action = await reservationRouter.reservationActions(
        reservationKey,
        1
      )
      expect(action.watchtowerDefaultDelay).to.equal(0)
      expect(action.watchtowerLevelOneDelay).to.equal(0)
      expect(action.watchtowerLevelTwoDelay).to.equal(0)
      expect(
        await redemptionWatchtower.getReservedRedemptionDelay(reservationKey, 1)
      ).to.equal(0)
      await expect(
        redemptionWatchtower
          .connect(guardianSigners[0])
          .raiseReservedObjection(reservationKey, 1)
      ).to.be.revertedWith("Redemption veto delay period expired")
    })

    it("pays the withdrawable remainder to the redeemer after the freeze period", async () => {
      // `updateDelayPolicy` sets the penalty divisor to 20: 5% of the
      // escrowed amount is burned as the penalty, the remainder stays
      // withdrawable by the redeemer through the shared
      // `withdrawVetoedFunds` path once the freeze period elapses.
      await updateDelayPolicy(
        await redemptionWatchtower.defaultDelay(),
        await redemptionWatchtower.levelOneDelay(),
        await redemptionWatchtower.levelTwoDelay(),
        0
      )
      await requestRedemption()

      await redemptionWatchtower
        .connect(guardianSigners[0])
        .raiseReservedObjection(reservationKey, 1)
      await redemptionWatchtower
        .connect(guardianSigners[1])
        .raiseReservedObjection(reservationKey, 1)
      await redemptionWatchtower
        .connect(guardianSigners[2])
        .raiseReservedObjection(reservationKey, 1)

      const vetoKey = vetoKeyOf(reservationKey, 1)
      const veto = await redemptionWatchtower.vetoProposals(vetoKey)
      const expectedWithdrawable = amountSat.sub(amountSat.div(20))
      expect(veto.withdrawableAmount).to.equal(expectedWithdrawable)

      // The veto freeze period is strict (`> finalizedAt + vetoFreezePeriod`).
      await increaseTime((await redemptionWatchtower.vetoFreezePeriod()) + 1)

      const redeemerBalanceBefore = await bank.balanceOf(thirdParty.address)
      await redemptionWatchtower
        .connect(thirdParty)
        .withdrawVetoedFunds(vetoKey)

      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        redeemerBalanceBefore.add(expectedWithdrawable)
      )
      // The withdrawable amount is consumed by the withdrawal.
      expect(
        (await redemptionWatchtower.vetoProposals(vetoKey)).withdrawableAmount
      ).to.equal(0)
    })
  })

  describe("ReservationVault.redeemReservation", () => {
    const reservationKey = 999
    const amountSat = BigNumber.from(100000000) // 1 BTC
    const grossTbtc = amountSat.mul(SATOSHI_MULTIPLIER)

    before(async () => {
      await createSnapshot()
      await wireReservations()
      await liveWallet(walletPubKeyHash)

      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
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

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a non-owner", async () => {
      await expect(
        reservationVault
          .connect(governance)
          .redeemReservation(reservationKey, redeemerOutputScript, 0)
      ).to.be.revertedWith("Caller is not the reservation owner")
    })

    it("should surrender gross TBTC, charge the redemption fee, and register the redemption", async () => {
      const fee = grossTbtc.mul(20).div(10000)
      const treasuryBalanceBefore = await tbtc.balanceOf(treasury.address)

      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(fee))

      const tx = await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, redeemerOutputScript, fee)

      await expect(tx)
        .to.emit(reservationVault, "ReservedRedemptionInitiated")
        .withArgs(reservationKey, thirdParty.address, grossTbtc, fee)
      await expect(tx).to.emit(
        reservationContract,
        "ReservationRedemptionRequested"
      )

      expect(await tbtc.balanceOf(treasury.address)).to.equal(
        treasuryBalanceBefore.add(fee)
      )
      expect(
        (await reservationRouter.reservations(reservationKey)).state
      ).to.equal(ReservationState.ActionPending)
      expect(
        (await reservationRouter.reservationActions(reservationKey, 1)).feePaid
      ).to.be.true
      expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)
    })

    it("should reject a stale fee quote after governance update and accept the exact bound", async () => {
      const exposedReservationKey = 998
      const quotedFee = grossTbtc.mul(20).div(10000)
      const updatedFee = grossTbtc.mul(500).div(10000)

      await bridge.setReservation(
        exposedReservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalanceAndCall(
          reservationVault.address,
          [thirdParty.address],
          [amountSat.mul(2)]
        )
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, ethers.constants.MaxUint256)

      const ownerBalanceBefore = await tbtc.balanceOf(thirdParty.address)
      const treasuryBalanceBefore = await tbtc.balanceOf(treasury.address)

      const vaultOwner = await impersonateContract(
        await reservationVault.owner()
      )
      await reservationVault.connect(vaultOwner).updateFees(40, 20, 500)

      await expect(
        reservationVault
          .connect(thirdParty)
          .redeemReservation(
            exposedReservationKey,
            redeemerOutputScript,
            quotedFee
          )
      ).to.be.revertedWith("Fee exceeds the caller's bound")

      expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
        ownerBalanceBefore
      )
      expect(await tbtc.balanceOf(treasury.address)).to.equal(
        treasuryBalanceBefore
      )
      expect(
        (await reservationRouter.reservations(exposedReservationKey)).state
      ).to.equal(ReservationState.Active)

      const tx = await reservationVault
        .connect(thirdParty)
        .redeemReservation(
          exposedReservationKey,
          redeemerOutputScript,
          updatedFee
        )

      await expect(tx)
        .to.emit(reservationVault, "ReservedRedemptionInitiated")
        .withArgs(
          exposedReservationKey,
          thirdParty.address,
          grossTbtc,
          updatedFee
        )
      expect(await tbtc.balanceOf(treasury.address)).to.equal(
        treasuryBalanceBefore.add(updatedFee)
      )
      expect(
        (await reservationRouter.reservations(exposedReservationKey)).state
      ).to.equal(ReservationState.ActionPending)

      await reservationVault.connect(vaultOwner).updateFees(40, 20, 20)
    })
  })

  describe("ReservationVault.retryRedeemReservation", () => {
    const reservationKey = 444
    const amountSat = BigNumber.from(100000000)
    const grossTbtc = amountSat.mul(SATOSHI_MULTIPLIER)

    before(async () => {
      await createSnapshot()
      await wireReservations()
      await liveWallet(walletPubKeyHash)

      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      // A fee-paid request that times out mints the retry entitlement and
      // refunds the gross amount to the owner as Bank balance -- exactly
      // the state the retry path is designed for.
      await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )
      const timedOutAction = await reservationRouter.reservationActions(
        reservationKey,
        1
      )
      await increaseTime(timedOutAction.timeoutAt + 1 - (await lastBlockTime()))
      await reservationRouter
        .connect(thirdParty)
        .notifyReservationRedemptionTimedOut(reservationKey, [])
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("retries the redemption from Bank balance without re-charging the fee", async () => {
      await bank
        .connect(thirdParty)
        .approveBalance(reservationVault.address, amountSat)
      const treasuryBalanceBefore = await tbtc.balanceOf(treasury.address)

      const tx = await reservationVault
        .connect(thirdParty)
        .retryRedeemReservation(reservationKey, redeemerOutputScript)

      await expect(tx)
        .to.emit(reservationContract, "ReservationRedemptionRequested")
        .withArgs(
          reservationKey,
          2,
          thirdParty.address,
          redeemerOutputScript,
          amountSat,
          RESERVATION_TX_MAX_FEE,
          false
        )

      expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)
      // The redemption fee is not re-charged on retry.
      expect(await tbtc.balanceOf(treasury.address)).to.equal(
        treasuryBalanceBefore
      )
      // The entitlement is consumed.
      expect((await reservationRouter.reservations(reservationKey)).retryCredit)
        .to.be.false
    })

    it("rejects a retry without a retry entitlement", async () => {
      // A fresh reservation that never minted the entitlement: the retry
      // request reaches the entitlement gate (the wallet is Live, holding
      // a main UTXO) and fails on `retryCredit == false`.
      const freshReservationKey = 445
      await bridge.setReservation(
        freshReservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalance(thirdParty.address, amountSat)
      await bank
        .connect(thirdParty)
        .approveBalance(reservationVault.address, amountSat)
      await expect(
        reservationVault
          .connect(thirdParty)
          .retryRedeemReservation(freshReservationKey, redeemerOutputScript)
      ).to.be.revertedWith("No retry entitlement")
    })
  })
})
