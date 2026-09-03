/**
 * Extracted from tbtc-v2 PR #1104 (refs/pull/1104/head @ 1a636939),
 * itself based on PR #1094 (origin/feat/utxo-reservation-guards @ bcfed23f).
 * Ported onto m1 (PR G, m1/bridge-integration-seams) per human decision
 * 2026-08-26. Pruned of m2-only paths (dissolution, redemption, renewal,
 * watchtower veto, retry credit) per roadmap.md §0.7.
 *
 * This file keeps only the cumulative re-anchor fee exposure block (the
 * PR #1104 characterization suite, 2 tests). The other 5 "kept" describes
 * from the original port were split into independent self-contained files,
 * each with its own fixture bootstrap, for clarity and parallel authoring:
 *
 *   - `Bridge.ReservationAcceptanceAuthorization.test.ts` (2/2 passing):
 *     'capacity reserved before signing (fill-then-prove)' +
 *     'acceptance authorization timeout'
 *   - `Bridge.ReservationSourceAnchorBinding.test.ts` (1/1 passing):
 *     'action source-anchor binding' (second original case was m2-only)
 *   - `Bridge.ReservationStranding.test.ts` (10/10 passing, new from
 *     scratch): `notifyReservationStranded` + `notifyStaleReservedDeposit`
 *     coverage. Zero prior coverage anywhere, including original PR #1104.
 *   - 'late proof against a position with a newer pending generation':
 *     carried as an empty scaffold then deleted 2026-08-26; both original
 *     cases depended on m2-only `requestRedemption`/`retryRedemption`.
 *   - 'wallet lifecycle integration': same; carried as an empty scaffold
 *     then deleted 2026-08-26; all 6 original cases depended on m2-only
 *     `requestReservationDissolution`/`completeMovingFundsWhileReservationsRemain`.
 *
 * Pruned describes:
 *   - claim double-spend regression (full block - redemption-racing only)
 *   - retry-credit restoration after a late re-anchor
 *   - watchtower authorization enforcement in the proof path
 *   - per-wallet dissolution lock (concurrent dissolutions)
 *   - reserved redemption gating
 *   - production MaintainerProxy reservation proof route (depends on
 *     `MaintainerProxyV2`, which does not exist anywhere in m1 - no
 *     contract, no deploy script, not compiled. Porting it is new scope
 *     beyond a test port; dropped rather than faked. Found 2026-08-26.)
 *
 * The characterization block above is the PR D obligation tracked in
 * agent-docs/m1/pr-D-description.md (the "Carry-forward obligation" note).
 * Source PR #1104 originally understood this as an unbounded accepted
 * regression (`gt PR1102_CAP`, `gte 86%`). During m1 merge reconciliation
 * (2026-09-02), `d600a8bf` (fix(bridge): close confirmed review findings in
 * reservation core, P3 "added a request-time amount floor for re-anchor")
 * was found to already bound it via `anchorAmount > reservationTxMaxFee +
 * reservationMinAmount`, checked at request time rather than the
 * settlement-time dust floor #1104/#1102 characterized. Updated the test
 * to assert the new (still substantial, ~80%+ in this fixture, but no
 * longer unbounded) terminal behavior. For m1 specifically: see
 * docs/spec/reservations/pr-strategy.md §4.1 (justification section) and
 * pr-review-followups.md item 7 - this P3 fix does not implement any of
 * the four levers that item enumerated, so item 7 still needs revisiting
 * against this new floor, not closed by it.
 */
/* eslint-disable @typescript-eslint/no-unused-expressions */

// Adversarial settlement tests for the two-phase reservation state machine:
// the late-proof settlement matrix, the action source-anchor binding, the
// capacity-reserved-before-signing guarantee, the acceptance authorization
// timeout, the wallet lifecycle integration, and the cumulative re-anchor
// fee exposure characterization (substantial but bounded, see file header).

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
  TBTCVault,
  TBTC,
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

describe("Bridge - Reservation settlement", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let deployer: SignerWithAddress

  let bank: Bank & BankStub
  let relay: Mock<IRelay>
  let walletRegistry: Mock<IWalletRegistry>
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
    } = await bridgeFixture())

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
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )
    refundLocktime = `0x${toLE((await lastBlockTime()) + 89 * 24 * 60 * 60, 4)}`

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

    await relay.getCurrentEpochDifficulty.returns(0)
    await relay.getPrevEpochDifficulty.returns(0)

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

  // ---- Bitcoin fixture crafting (regtest-style difficulty) ----

  const REGTEST_BITS_LE = "ffff7f20"
  const REGTEST_TARGET = BigNumber.from("0x7fffff").mul(
    BigNumber.from(2).pow(8 * (0x20 - 3))
  )

  const reverseHex = (hex: string): string =>
    hex.replace(/^0x/, "").match(/../g)!.reverse().join("")

  const hash256 = (hexData: string): string =>
    ethers.utils.sha256(ethers.utils.sha256(hexData))

  const toLE = (value: number | BigNumber, byteLength: number): string =>
    reverseHex(
      BigNumber.from(value)
        .toHexString()
        .slice(2)
        .padStart(byteLength * 2, "0")
    )

  const compactSize = (n: number): string => {
    if (n >= 0xfd) {
      throw new Error("compactSize > 252 not supported in fixtures")
    }
    return n.toString(16).padStart(2, "0")
  }

  function buildTx(
    inputs: { txHash: string; index: number }[],
    outputs: { valueSat: BigNumber | number; script: string }[]
  ) {
    const inputVector = `0x${compactSize(inputs.length)}${inputs
      .map((i) => `${i.txHash.slice(2)}${toLE(i.index, 4)}00ffffffff`)
      .join("")}`
    const outputVector = `0x${compactSize(outputs.length)}${outputs
      .map(
        (o) =>
          `${toLE(BigNumber.from(o.valueSat), 8)}${compactSize(
            o.script.length / 2
          )}${o.script}`
      )
      .join("")}`
    const info = {
      version: "0x01000000",
      inputVector,
      outputVector,
      locktime: "0x00000000",
    }
    const txHash = hash256(
      `0x01000000${inputVector.slice(2)}${outputVector.slice(2)}00000000`
    )
    return { info, txHash }
  }

  function mineHeader(merkleRoot: string): string {
    const prevBlock = ethers.utils
      .hexlify(ethers.utils.randomBytes(32))
      .slice(2)
    const base = `20000000${prevBlock}${merkleRoot.slice(
      2
    )}662a2c68${REGTEST_BITS_LE}`
    for (let nonce = 0; ; nonce++) {
      const header = `0x${base}${toLE(nonce, 4)}`
      if (
        BigNumber.from(`0x${reverseHex(hash256(header))}`).lte(REGTEST_TARGET)
      ) {
        return header
      }
    }
  }

  function proofFor(txHash: string) {
    const coinbasePreimage = ethers.utils.sha256(ethers.utils.randomBytes(32))
    const coinbaseTxId = ethers.utils.sha256(coinbasePreimage)
    const merkleRoot = hash256(`0x${coinbaseTxId.slice(2)}${txHash.slice(2)}`)
    return {
      merkleProof: coinbaseTxId,
      txIndexInBlock: 1,
      bitcoinHeaders: mineHeader(merkleRoot),
      coinbasePreimage,
      coinbaseProof: txHash,
    }
  }

  const buildDepositScript = (
    depositor: string,
    blinding: string,
    walletPkh: string,
    refundPkh: string,
    locktime: string
  ): string =>
    `14${depositor.slice(2)}7508${blinding.slice(2)}7576a914${walletPkh
      .slice(2)
      .toLowerCase()}8763ac6776a914${refundPkh.slice(2)}8804${locktime.slice(
      2
    )}b175ac68`

  const p2wshScript = (script: string): string =>
    `0020${ethers.utils.sha256(`0x${script}`).slice(2)}`

  const p2wpkhScript = (pkh: string): string => `0014${pkh.slice(2)}`

  const randomRedeemerScript = (): string =>
    `0x16${p2wpkhScript(ethers.utils.hexlify(ethers.utils.randomBytes(20)))}`

  // Reveals a fresh reserved deposit and requests acceptance (generation 1).
  async function makeRequestedReservation(custodian = walletPubKeyHash) {
    const fundingTx = buildTx(
      [
        {
          txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
          index: 0,
        },
      ],
      [
        {
          valueSat: depositAmount,
          script: p2wshScript(
            buildDepositScript(
              thirdParty.address,
              blindingFactor,
              custodian,
              refundPubKeyHash,
              refundLocktime
            )
          ),
        },
      ]
    )

    await bridge.connect(thirdParty).revealDeposit(fundingTx.info, {
      fundingOutputIndex: 0,
      blindingFactor,
      walletPubKeyHash: custodian,
      refundPubKeyHash,
      refundLocktime,
      vault: reservationVault.address,
    })

    const reservationKey = BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
    )

    await reservationRouter
      .connect(thirdParty)
      .requestReservationAcceptance(reservationKey, custodian)

    const anchorTx = buildTx(
      [{ txHash: fundingTx.txHash, index: 0 }],
      [{ valueSat: anchorAmount, script: p2wpkhScript(custodian) }]
    )

    return { fundingTx, anchorTx, reservationKey }
  }

  // Reveals a fresh reserved deposit, requests acceptance (generation 1)
  // and proves the anchor.
  async function makeAcceptedReservation(custodian = walletPubKeyHash) {
    const { fundingTx, anchorTx, reservationKey } =
      await makeRequestedReservation(custodian)

    await reservationRouter
      .connect(spvMaintainer)
      .submitReservationProof(
        ProofType.Acceptance,
        anchorTx.info,
        proofFor(anchorTx.txHash),
        NO_MAIN_UTXO_PARAM,
        reservationKey,
        1
      )

    return { fundingTx, anchorTx, reservationKey }
  }

  describe("cumulative re-anchor fee exposure (accepted regression)", () => {
    // A scaled parameter regime, the same technique `#1102`'s own
    // characterization test used: at the default 2,000 sat `txMaxFee` a
    // full grind of this fixture's 2,998,500 sat anchor would take ~1,498
    // hops. Raising the fee bound compresses it to 7 without changing the
    // mechanism under test. `reservationMinAmount` has to move with it to
    // satisfy `reservationMinAmount > reservationTxMaxFee`.
    const GRIND_TX_MAX_FEE = 400000
    const GRIND_MIN_AMOUNT = 500000

    // `#1102`'s fixture ceiling, for the comparison assertion below.
    const PR1102_CAP = 100000

    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    async function raiseFeeBound() {
      await reservationRouter
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          reservationVault.address,
          GRIND_MIN_AMOUNT,
          GRIND_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          RESERVATION_ACTION_TIMEOUT,
          RESERVATION_RENEWAL_WINDOW
        )
    }

    // One governance-authorized hop, ping-ponging between two Live
    // wallets. Returns the settled transaction so the next hop can spend
    // its output.
    async function grindOneHop(
      reservationKey: BigNumber,
      sourceTx: { txHash: string },
      target: string,
      newAnchorValue: BigNumber,
      nonce: number
    ) {
      await reservationRouter
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(reservationKey, target)

      const hopTx = buildTx(
        [{ txHash: sourceTx.txHash, index: 0 }],
        [{ valueSat: newAnchorValue, script: p2wpkhScript(target) }]
      )

      await reservationRouter
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Reanchor,
          hopTx.info,
          proofFor(hopTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          nonce
        )

      return hopTx
    }

    it("bounds the grind at a request-time amount floor, not the settlement-time dust floor", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await liveWallet(secondWalletPubKeyHash)
      await raiseFeeBound()

      const reserveBefore = await tbtc.balanceOf(reservationVault.address)
      const debtBefore = await reservationVault.inKindFeeDebtSat()

      // Grind at the maximum permitted fee per hop. Termination is no
      // longer the settlement-time dust floor `#1104`/`#1102` characterized
      // (`GRIND_TX_MAX_FEE + 1`): `d600a8bf` (fix(bridge): close confirmed
      // review findings in reservation core, P3 "added a request-time
      // amount floor for re-anchor") added a REQUEST-time floor requiring
      // `anchorAmount > reservationTxMaxFee + reservationMinAmount` before
      // the next hop can even be authorized, which is much higher than the
      // dust floor and fires first. This supersedes the "no absolute
      // ceiling" premise `pr-review-followups.md` item 7 documented as an
      // accepted regression deferred to post-m1: a P3 review fix already
      // bounds it, just not via the four levers that item enumerated. The
      // hop count is derived, never hardcoded: it scales with the claim.
      let currentTx = anchorTx
      let currentAnchor = anchorAmount
      let target = secondWalletPubKeyHash
      let nonce = 2
      let hops = 0
      const requestFloor = BigNumber.from(GRIND_TX_MAX_FEE + GRIND_MIN_AMOUNT)

      while (currentAnchor.gt(requestFloor)) {
        const nextAnchor = currentAnchor.sub(GRIND_TX_MAX_FEE)
        // Sequential on purpose: each hop spends the previous hop's output,
        // so these cannot be batched or parallelised.
        // eslint-disable-next-line no-await-in-loop
        currentTx = await grindOneHop(
          reservationKey,
          currentTx,
          target,
          nextAnchor,
          nonce
        )
        currentAnchor = nextAnchor
        target =
          target === secondWalletPubKeyHash
            ? walletPubKeyHash
            : secondWalletPubKeyHash
        nonce += 1
        hops += 1
      }

      const reservation = await reservationRouter.reservations(reservationKey)
      const cumulativeFee = anchorAmount.sub(currentAnchor)

      // The claim is written down to the surviving anchor: the owner's
      // redemption right shrinks by the full grind.
      expect(reservation.anchorAmount).to.equal(currentAnchor)
      expect(reservation.mintedAmount).to.equal(currentAnchor)

      // Every satoshi of the grind is financed in kind: burned from the
      // vault's reserve where it could cover, recorded as global debt
      // where it could not. Nothing is left unaccounted.
      const reserveAfter = await tbtc.balanceOf(reservationVault.address)
      const debtAfter = await reservationVault.inKindFeeDebtSat()
      const burnedSat = reserveBefore.sub(reserveAfter).div(SATOSHI_MULTIPLIER)
      expect(burnedSat.add(debtAfter.sub(debtBefore))).to.equal(cumulativeFee)

      // Still a real, substantial exposure - well above #1102's original
      // fixture cap - just no longer unbounded. The exact percentage is a
      // function of `reservationMinAmount` relative to the claim in this
      // regime, not a protocol constant.
      expect(cumulativeFee).to.be.gt(PR1102_CAP)
      expect(cumulativeFee.mul(100).div(anchorAmount)).to.be.gte(80)

      // And the grind is genuinely terminal: the next hop cannot even be
      // requested, because the request-time floor is the first thing that
      // stops it now (never reaches the settlement-time dust floor check).
      await expect(
        reservationRouter
          .connect(bridgeGovernanceSigner)
          .requestReservationReanchor(reservationKey, target)
      ).to.be.revertedWith(
        "Reanchor would fall below the minimum reservation amount"
      )

      // Recorded for the deferral note: the hop count scales with the
      // claim, so this figure is regime-specific, not a constant bound.
      expect(hops).to.be.gte(6)
    })

    it("depends on the governance gate: a Live wallet's anchor cannot be rotated permissionlessly", async () => {
      // The grind above is only tolerable because reaching it requires
      // governance to authorize every hop. If this gate is ever relaxed,
      // this substantial (bounded but still large) exposure becomes
      // reachable by the custodying wallet operator alone, which is the
      // threat model `pr-review-followups.md` item 7 scored as the
      // severity-driving case. This test is the tripwire for that change.
      //
      // Scope, per limit 2 in this block's header: this catches the gate
      // being removed, not `privileged` being widened to admit a second
      // caller. A green run here is not evidence the assumption still
      // holds; it is only evidence this particular gate still exists.
      const { reservationKey } = await makeAcceptedReservation()
      await liveWallet(secondWalletPubKeyHash)

      await expect(
        reservationRouter
          .connect(thirdParty)
          .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)
      ).to.be.revertedWith("Only governance can rotate a Live wallet's anchor")
    })
  })
})
