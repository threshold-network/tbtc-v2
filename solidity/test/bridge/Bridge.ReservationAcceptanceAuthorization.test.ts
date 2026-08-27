/**
 * Extracted from tbtc-v2 PR #1104 (refs/pull/1104/head @ 1a636939),
 * itself based on PR #1094 (origin/feat/utxo-reservation-guards @ bcfed23f).
 * Ported onto m1 (PR G, m1/bridge-integration-seams) per human decision
 * 2026-08-26. Pruned of m2-only paths (dissolution, redemption, renewal,
 * watchtower veto, retry credit) per roadmap.md §0.7.
 *
 * Kept describes:
 *   - capacity reserved before signing (fill-then-prove)
 *   - acceptance authorization timeout
 *
 * Pruned describes:
 *   - late proof against a position with a newer pending generation
 *   - action source-anchor binding
 *   - wallet lifecycle integration
 *   - cumulative re-anchor fee exposure (accepted regression)
 *   - claim double-spend regression (full block - redemption-racing only)
 *   - retry-credit restoration after a late re-anchor
 *   - watchtower authorization enforcement in the proof path
 *   - per-wallet dissolution lock (concurrent dissolutions)
 *   - reserved redemption gating
 *   - production MaintainerProxy reservation proof route (depends on
 *     `MaintainerProxyV2`, which does not exist anywhere in m1 - no
 *     contract, no deploy script, not compiled. Porting it is new scope
 *     beyond a test port; dropped rather than faked. Found 2026-08-26.)
 */
/* eslint-disable @typescript-eslint/no-unused-expressions */

// Adversarial settlement tests for the two-phase reservation state machine:
// the capacity-reserved-before-signing guarantee and the acceptance
// authorization timeout.

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
  IWalletRegistry,
  IRelay,
  ReimbursementPool,
  ReservationRouter,
  ReservationVault,
  TBTCVault,
  TBTC,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { walletState } from "../fixtures"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const ZERO_BYTES32 = ethers.constants.HashZero

const RESERVATION_TERM = 31536000 // 365 days
const RESERVATION_GRACE = 2592000 // 30 days
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
// `deploy/97_set_reservation_parameters.ts` already runs as part of
// `deployments.fixture()` and sets real caps (reservationMaxSingleAmount
// 100,000, maxActiveReservations 100 - see agent-docs/inventory/
// reservation-parameters.md), unlike the source test's assumption of a
// pristine, caps-never-set bridge. `updateReservationParameters`'s
// relational check (`reservationMaxTotalAmount <= maxActiveReservations *
// reservationMaxSingleAmount`) is live from that deploy step onward, so
// this must fit under 100 * 100,000 = 10,000,000 - found 2026-08-26.
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

const ProofType = {
  Acceptance: 0,
  Redemption: 1,
  Reanchor: 2,
  Dissolution: 3,
}

// Shared test fixtures
let governance: SignerWithAddress
let spvMaintainer: SignerWithAddress
let thirdParty: SignerWithAddress
let deployer: SignerWithAddress

let bank: Bank & BankStub
let relay: FakeContract<IRelay>
let walletRegistry: FakeContract<IWalletRegistry>
let bridge: Bridge & BridgeStub
let reservationRouter: ReservationRouter
let reimbursementPool: ReimbursementPool
let tbtc: TBTC & Contract
let tbtcVault: TBTCVault & Contract
let reservationVault: ReservationVault
let bridgeGovernanceSigner: SignerWithAddress

const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
const secondWalletPubKeyHash = "0xafcdf88d15a0e0c2134dbbc9f6da24d0e26c8f21"
const blindingFactor = "0xf9f0c90d00039523"
const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
let refundLocktime: string
const NO_MAIN_UTXO_PARAM = {
  txHash: ZERO_BYTES32,
  txOutputIndex: 0,
  txOutputValue: 0,
}

const depositAmount = BigNumber.from(3000000)
const anchorFee = 1500
const anchorAmount = depositAmount.sub(anchorFee)
const grossTbtc = anchorAmount.mul(SATOSHI_MULTIPLIER)

before(async () => {
  // eslint-disable-next-line @typescript-eslint/no-extra-semi
  ;({
    deployer,
    governance,
    spvMaintainer,
    thirdParty,
    bank,
    relay,
    walletRegistry,
    bridge,
    reimbursementPool,
    tbtc,
    tbtcVault,
  } = await waffle.loadFixture(bridgeFixture))

  // Reservation router functions (`updateReservationParameters`,
  // `requestReservation*`, `submitReservationProof`, etc.) are declared
  // on `ReservationRouter`, not `Bridge`. Per `ReservationRouter.sol`
  // invariant 3 ("no standalone authority"), every one of them is only
  // reachable through `Bridge.fallback()`'s delegatecall - calling the
  // router's own deployed address directly executes against its own
  // empty storage. `ethers.getContractAt` with the router's ABI but
  // Bridge's address gives correctly-encoded calls that land on
  // `Bridge.fallback()`, exactly like the production caller path.
  reservationRouter = await ethers.getContractAt(
    "ReservationRouter",
    bridge.address
  )
  reservationVault = await helpers.contracts.getContract("ReservationVault")
  bridgeGovernanceSigner = await impersonateContract(await bridge.governance())
  refundLocktime = `0x${toLE((await lastBlockTime()) + 4000 * 24 * 60 * 60, 4)}`

  await bridge
    .connect(bridgeGovernanceSigner)
    .setVaultStatus(reservationVault.address, true)
  // `deploy/97_set_reservation_parameters.ts` already set
  // `reservationMaxSingleAmount` to 100,000 as part of the fixture, but
  // this fixture's anchor is 2,998,500 sat - well over that single-
  // reservation cap (Reservation.sol:540-544, "Reservation exceeds the
  // single-reservation cap"). Raise it with headroom before creating any
  // reservation - found 2026-08-26.
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

  relay.getCurrentEpochDifficulty.returns(0)
  relay.getPrevEpochDifficulty.returns(0)

  await bridge.setDepositDustThreshold(10000)
  await bridge.setDepositTxMaxFee(2000)
  await bridge.setDepositRevealAheadPeriod(0)
  await liveWallet(walletPubKeyHash)

  const tbtcOwner = await impersonateContract(await tbtc.owner())
  await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.address)
})

async function impersonateContract(
  address: string
): Promise<SignerWithAddress> {
  await ethers.provider.send("hardhat_impersonateAccount", [address])
  await ethers.provider.send("hardhat_setBalance", [
    address,
    "0x8AC7230489E80000",
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
}

// Re-establishes this file's reservation preconditions (wallet Live state,
// vault activation, and reservation caps/total-amount headroom) at the
// start of each describe below, rather than relying on the file's root
// `before()` running exactly once at process start. Other test files'
// suites run between this file's root `before()` and its own describes in
// Mocha's combined root-suite execution order, and can leave the shared
// `bridgeFixture`-deployed Bridge/ReservationVault state - the wallet's
// Live-ness, and the reservation total-amount usage counter, in
// particular - mutated by the time these describes actually run. Reading
// the current `reservationTotalAmount` and raising the ceiling by a full
// `RESERVATION_MAX_TOTAL` above it (rather than resetting to a fixed
// value) guarantees headroom regardless of what any intervening file's
// tests already reserved. Found 2026-08-27.
async function establishReservationPreconditions() {
  // The impersonated governance signer's ETH balance, set once by
  // `impersonateContract()` in the root `before()`, is zeroed out by
  // `waffle.loadFixture` reverts in intervening test files (like
  // RedemptionVaultRebate). Top it back up before spending it here.
  await ethers.provider.send("hardhat_setBalance", [
    bridgeGovernanceSigner.address,
    "0x8AC7230489E80000",
  ])
  await liveWallet(walletPubKeyHash)
  await bridge
    .connect(bridgeGovernanceSigner)
    .setVaultStatus(reservationVault.address, true)
  await reservationRouter
    .connect(bridgeGovernanceSigner)
    .updateReservationCaps(RESERVATION_MAX_TOTAL, RESERVATION_MAX_TOTAL, 100)
  const currentTotal = (await reservationRouter.reservationParameters())
    .reservationTotalAmount
  await reservationRouter
    .connect(bridgeGovernanceSigner)
    .updateReservationParameters(
      reservationVault.address,
      RESERVATION_MIN_AMOUNT,
      RESERVATION_TX_MAX_FEE,
      RESERVATION_TERM,
      RESERVATION_GRACE,
      currentTotal.add(RESERVATION_MAX_TOTAL),
      MAX_RESERVATIONS_PER_WALLET,
      RESERVATION_ACTION_TIMEOUT,
      RESERVATION_RENEWAL_WINDOW
    )
  // Re-assert TBTC token ownership by tbtcVault: required for
  // `TBTCVault.mint` (called via `ReservationVault.receiveBalanceIncrease`
  // on acceptance settlement) to succeed, and subject to the same
  // intervening-file drift as everything else established in the root
  // `before()`.
  if ((await tbtc.owner()) !== tbtcVault.address) {
    const currentTbtcOwner = await impersonateContract(await tbtc.owner())
    await tbtc.connect(currentTbtcOwner).transferOwnership(tbtcVault.address)
  }
  // Re-assert the relay's mocked difficulty return values: this file's
  // Bitcoin proof fixtures are crafted at REGTEST difficulty (see below)
  // and require the relay to report 0 for both epochs so
  // `BitcoinTx.evaluateProofDifficulty` accepts them. `smock`'s
  // `.returns()` configuration lives in the shared relay mock's own
  // storage, so it is subject to `evm_snapshot`/`evm_revert` boundaries

[Showing lines 1-300 of 708. Use :301 to continue]