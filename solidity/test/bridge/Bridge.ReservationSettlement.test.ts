/* eslint-disable @typescript-eslint/no-unused-expressions */

// Adversarial settlement tests for the two-phase reservation state machine:
// the claim double-spend regression (timeout racing a confirmed redemption),
// the late-proof settlement matrix, the on-chain watchtower-delay
// enforcement, the per-wallet dissolution lock, and the
// capacity-reserved-before-signing guarantee.

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
const RESERVATION_MAX_TOTAL = BigNumber.from("2100000000000000")
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
  let relay: FakeContract<IRelay>
  let bridge: Bridge & BridgeStub & ReservationRouter
  let tbtc: TBTC & Contract
  let tbtcVault: TBTCVault & Contract
  let reservationVault: ReservationVault
  let bridgeGovernanceSigner: SignerWithAddress

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const secondWalletPubKeyHash = "0xafcdf88d15a0e0c2134dbbc9f6da24d0e26c8f21"
  const blindingFactor = "0xf9f0c90d00039523"
  const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
  const refundLocktime = "0x60bcea61"
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
      bridge,
      tbtc,
      tbtcVault,
    } = await waffle.loadFixture(bridgeFixture))

    reservationVault = await helpers.contracts.getContract("ReservationVault")
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )

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
    await bridge.setLiveWalletsCount(10)

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

  // Reveals a fresh reserved deposit, requests acceptance (generation 1)
  // and proves the anchor.
  async function makeAcceptedReservation(custodian = walletPubKeyHash) {
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

    await bridge
      .connect(thirdParty)
      .requestReservationAcceptance(reservationKey, custodian)

    const anchorTx = buildTx(
      [{ txHash: fundingTx.txHash, index: 0 }],
      [{ valueSat: anchorAmount, script: p2wpkhScript(custodian) }]
    )

    await bridge
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

  // Requests an in-kind redemption of the given accepted reservation via
  // the real vault flow (fee paid in TBTC).
  async function requestRedemption(
    reservationKey: BigNumber,
    redeemerScript: string
  ) {
    const redemptionFee = grossTbtc.mul(20).div(10000)
    await tbtc
      .connect(thirdParty)
      .approve(reservationVault.address, grossTbtc.add(redemptionFee))
    await reservationVault
      .connect(thirdParty)
      .redeemReservation(reservationKey, redeemerScript)
  }

  // Retries via the Bank-balance path after a timeout refund.
  async function retryRedemption(
    reservationKey: BigNumber,
    redeemerScript: string
  ) {
    await bank
      .connect(thirdParty)
      .approveBalance(reservationVault.address, anchorAmount)
    await reservationVault
      .connect(thirdParty)
      .retryRedeemReservation(reservationKey, redeemerScript)
  }

  describe("claim double-spend regression (timeout racing a confirmed redemption)", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("settles the late proof without a second refund and defeats fraud exposure", async () => {
      // Two acceptances: the second funds the owner with the TBTC needed
      // for the gross surrender plus fee on the first.
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      // The wallet signs and broadcasts; the transaction confirms on
      // Bitcoin (crafted below) but its proof does not reach the Bridge
      // before the timeout.
      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The timeout refunded the escrowed claim to the redeemer.
      const redeemerBankBalance = await bank.balanceOf(thirdParty.address)
      expect(redeemerBankBalance).to.equal(anchorAmount)
      const bridgeBankBalance = await bank.balanceOf(bridge.address)

      // The late proof settles against the terminal TimedOut record.
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )

      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 2, ActionType.Redemption)
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, 2, redemptionTx.txHash)

      // No second refund and no burn: the Bank moved nothing during the
      // late settlement.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        redeemerBankBalance
      )
      expect(await bank.balanceOf(bridge.address)).to.equal(bridgeBankBalance)

      // The lineage is closed and the consumed anchor is registered as
      // honestly spent, so the wallet's signature defeats any fraud
      // challenge.
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Closed
      )
      expect(
        await bridge.spentMainUTXOs(
          BigNumber.from(
            ethers.utils.solidityKeccak256(
              ["bytes32", "uint32"],
              [anchorTx.txHash, 0]
            )
          )
        )
      ).to.be.true

      // The settled generation cannot be settled twice.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Action is not settleable")
    })
  })

  describe("late proof against a position with a newer pending generation", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("forces settlement against a matching pending generation", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The owner retries with the SAME redeemer script (generation 3).
      await retryRedemption(reservationKey, redeemerScript)

      // The transaction satisfies both generation 2 (timed out) and
      // generation 3 (pending). The late-settlement path must refuse it:
      // settling the pending generation burns the escrow, which is the
      // correct accounting.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Must settle the pending generation")

      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          3
        )
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, 3, redemptionTx.txHash)

      // The pending settlement burned the escrow.
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
    })

    it("unwinds a non-matching pending generation and refunds its escrow", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      // Generation 2's transaction confirms on Bitcoin.
      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The owner retries toward a DIFFERENT redeemer script
      // (generation 3) -- unaware the old transaction confirmed.
      const otherScript = randomRedeemerScript()
      await retryRedemption(reservationKey, otherScript)
      expect(await bank.balanceOf(bridge.address)).to.equal(anchorAmount)

      // The late proof of generation 2 settles; generation 3 can never
      // settle (its anchor is gone), so it is unwound and its escrow
      // refunded.
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )

      await expect(tx)
        .to.emit(bridge, "ReservationActionSuperseded")
        .withArgs(reservationKey, 3)
      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 2, ActionType.Redemption)

      expect(
        (await bridge.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.Superseded)
      // Generation 3's escrow returned to its redeemer. (The generation 2
      // timeout refund was re-spent on the retry, so the redeemer's net
      // Bank balance is exactly the unwound escrow.)
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
      expect(await bank.balanceOf(thirdParty.address)).to.equal(anchorAmount)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Closed
      )
    })
  })

  describe("watchtower authorization enforcement in the proof path", () => {
    let redemptionWatchtower: Contract

    before(async () => {
      await createSnapshot()

      redemptionWatchtower = await helpers.contracts.getContract(
        "RedemptionWatchtower"
      )
      const watchtowerOwner = await impersonateContract(
        await redemptionWatchtower.owner()
      )
      const guardians = (await ethers.getSigners()).slice(10, 13)
      await redemptionWatchtower.connect(watchtowerOwner).enableWatchtower(
        governance.address,
        guardians.map((g) => g.address)
      )
      await bridge
        .connect(bridgeGovernanceSigner)
        .setRedemptionWatchtower(redemptionWatchtower.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("rejects a proof before the delay elapses and accepts it afterwards", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      // A Byzantine wallet signs and broadcasts immediately; the
      // transaction confirms on Bitcoin. The Bridge must not let it
      // finalize before the guardians' window closes.
      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Watchtower delay has not elapsed")

      // Default delay is 2 hours.
      await increaseTime(7300)

      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, 2, redemptionTx.txHash)
    })

    it("never settles a vetoed generation", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestRedemption(reservationKey, redeemerScript)

      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const guardians = (await ethers.getSigners()).slice(10, 13)
      await redemptionWatchtower
        .connect(guardians[0])
        .raiseReservedObjection(reservationKey, 2)
      await redemptionWatchtower
        .connect(guardians[1])
        .raiseReservedObjection(reservationKey, 2)
      await redemptionWatchtower
        .connect(guardians[2])
        .raiseReservedObjection(reservationKey, 2)

      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Vetoed)

      // The early-signed transaction is unprovable forever: the signature
      // stays exposed to the fraud machinery, which is the intended
      // consequence of signing before authorization.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Action is not settleable")
    })
  })

  describe("per-wallet dissolution lock (concurrent dissolutions)", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("serializes no-main-UTXO dissolutions of the same wallet", async () => {
      const first = await makeAcceptedReservation()
      const second = await makeAcceptedReservation()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(first.reservationKey)

      // The second dissolution of the same wallet is locked out while the
      // first is in flight.
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationDissolution(second.reservationKey)
      ).to.be.revertedWith("Another dissolution is pending for the wallet")

      // Settle the first dissolution; its output becomes the main UTXO.
      const dissolutionFee = 500
      const firstTx = buildTx(
        [{ txHash: first.anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          firstTx.info,
          proofFor(firstTx.txHash),
          NO_MAIN_UTXO_PARAM,
          first.reservationKey,
          2
        )

      // The lock released; the second dissolution can now be requested,
      // and its snapshot records the new main UTXO -- the second
      // transaction must spend it (2-in-1-out).
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(second.reservationKey)

      const mainUtxo = {
        txHash: firstTx.txHash,
        txOutputIndex: 0,
        txOutputValue: anchorAmount.sub(dissolutionFee),
      }
      const secondTx = buildTx(
        [
          { txHash: second.anchorTx.txHash, index: 0 },
          { txHash: firstTx.txHash, index: 0 },
        ],
        [
          {
            valueSat: anchorAmount
              .sub(dissolutionFee)
              .add(anchorAmount)
              .sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          secondTx.info,
          proofFor(secondTx.txHash),
          mainUtxo,
          second.reservationKey,
          2
        )
      await expect(tx)
        .to.emit(bridge, "ReservationDissolved")
        .withArgs(second.reservationKey, 2, walletPubKeyHash, secondTx.txHash)
    })

    it("re-registers a drifted dissolution output for the sweep machinery", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)

      // The authorized 1-input dissolution confirms on Bitcoin, but before
      // its proof lands a deposit sweep registers a new main UTXO.
      const dissolutionFee = 500
      const dissolutionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )

      const sweepUtxo = {
        txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
        txOutputIndex: 0,
        txOutputValue: 7777777,
      }
      await bridge.setWalletMainUtxo(walletPubKeyHash, sweepUtxo)
      const driftedMainUtxoHash = (await bridge.wallets(walletPubKeyHash))
        .mainUtxoHash

      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          dissolutionTx.info,
          proofFor(dissolutionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )
      await expect(tx).to.emit(bridge, "ReservationDissolved")

      // The wallet's main UTXO is untouched; the dissolution output is
      // registered as a moved-funds sweep request instead.
      expect((await bridge.wallets(walletPubKeyHash)).mainUtxoHash).to.equal(
        driftedMainUtxoHash
      )
      const sweepRequest = await bridge.movedFundsSweepRequests(
        BigNumber.from(
          ethers.utils.solidityKeccak256(
            ["bytes32", "uint32"],
            [dissolutionTx.txHash, 0]
          )
        )
      )
      expect(sweepRequest.walletPubKeyHash).to.equal(walletPubKeyHash)
      expect(sweepRequest.value).to.equal(anchorAmount.sub(dissolutionFee))
    })
  })

  describe("capacity reserved before signing (fill-then-prove)", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("settles an authorized acceptance even after the caps fill up", async () => {
      // Authorize an acceptance while capacity is available.
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
                walletPubKeyHash,
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
        walletPubKeyHash,
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
      await bridge
        .connect(thirdParty)
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)

      // The caps fill up after the authorization (a governance tightening
      // to the current usage level models any competing fill).
      const params = await bridge.reservationParameters()
      await bridge.connect(bridgeGovernanceSigner).updateReservationParameters(
        reservationVault.address,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        params.reservationTotalAmount, // no room beyond what is reserved
        MAX_RESERVATIONS_PER_WALLET,
        RESERVATION_ACTION_TIMEOUT,
        RESERVATION_RENEWAL_WINDOW
      )

      // A new authorization cannot be created any more...
      const otherFundingTx = buildTx(
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
                walletPubKeyHash,
                refundPubKeyHash,
                refundLocktime
              )
            ),
          },
        ]
      )
      await bridge.connect(thirdParty).revealDeposit(otherFundingTx.info, {
        fundingOutputIndex: 0,
        blindingFactor,
        walletPubKeyHash,
        refundPubKeyHash,
        refundLocktime,
        vault: reservationVault.address,
      })
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationAcceptance(
            BigNumber.from(
              ethers.utils.solidityKeccak256(
                ["bytes32", "uint32"],
                [otherFundingTx.txHash, 0]
              )
            ),
            walletPubKeyHash
          )
      ).to.be.revertedWith("Total reserved amount cap exceeded")

      // ...but the already-authorized (and, on Bitcoin, already signed)
      // anchor still settles: capacity was reserved before signing.
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Acceptance,
          anchorTx.info,
          proofFor(anchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          1
        )
      await expect(tx).to.emit(bridge, "ReservationAccepted")
    })
  })

  describe("acceptance authorization timeout", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("releases capacity, allows re-authorization, and still settles the late anchor", async () => {
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
                walletPubKeyHash,
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
        walletPubKeyHash,
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
      await bridge
        .connect(thirdParty)
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)

      const totalBefore = (await bridge.reservationParameters())
        .reservationTotalAmount

      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      const timeoutTx = await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])
      await expect(timeoutTx)
        .to.emit(bridge, "ReservationActionTimedOut")
        .withArgs(reservationKey, 1, ActionType.Acceptance)

      // The reserved capacity was released.
      expect(
        (await bridge.reservationParameters()).reservationTotalAmount
      ).to.equal(totalBefore.sub(depositAmount))

      // The anchor -- signed while generation 1 was pending -- confirmed
      // on Bitcoin anyway. Its late proof still settles and re-takes the
      // capacity.
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Acceptance,
          anchorTx.info,
          proofFor(anchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          1
        )
      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 1, ActionType.Acceptance)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Active
      )
    })

    it("unwinds a re-authorized acceptance when the first anchor settles late (no capacity leak)", async () => {
      // Re-review regression: acceptance gen 1 times out, gen 2 is
      // re-authorized (re-reserving capacity), then gen 1's anchor confirms
      // and settles late. Gen 2's reserved capacity must be released, not
      // leaked — a leak would permanently inflate the wallet caps and the
      // reserved total (which blocks vault migration).
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
                walletPubKeyHash,
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
        walletPubKeyHash,
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

      const totalBaseline = (await bridge.reservationParameters())
        .reservationTotalAmount
      const walletAmountBaseline = await bridge.walletReservationsAmount(
        walletPubKeyHash
      )

      // Generation 1: request, time out (releases capacity).
      await bridge
        .connect(thirdParty)
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)
      await increaseTime(RESERVATION_ACTION_TIMEOUT + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // Generation 2: re-authorize (re-reserves capacity) and leave pending.
      await bridge
        .connect(thirdParty)
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)
      expect(
        (await bridge.reservationParameters()).reservationTotalAmount
      ).to.equal(totalBaseline.add(depositAmount))

      // Generation 1's anchor confirms and settles late.
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
      )
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Acceptance,
          anchorTx.info,
          proofFor(anchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          1
        )
      await expect(tx)
        .to.emit(bridge, "ReservationActionSuperseded")
        .withArgs(reservationKey, 2)

      // Generation 2 is terminally Superseded; its capacity was released and
      // only generation 1's actual anchor value remains reserved. No leak.
      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Superseded)
      expect(
        (await bridge.reservationParameters()).reservationTotalAmount
      ).to.equal(totalBaseline.add(anchorAmount))
      expect(await bridge.walletReservationsAmount(walletPubKeyHash)).to.equal(
        walletAmountBaseline.add(anchorAmount)
      )
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Active
      )
    })
  })

  describe("reserved redemption gating", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("rejects requests at and after expiry (stranding bound)", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      // Strictly pre-expiry: at/after expiry no new redemption generation
      // can be created; the dissolution delay is not an owner window.
      await increaseTime(RESERVATION_TERM + 1)

      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await expect(
        reservationVault
          .connect(thirdParty)
          .redeemReservation(reservationKey, randomRedeemerScript())
      ).to.be.revertedWith("Reservation expired")
    })

    it("rejects requests while the wallet is not Live or MovingFunds", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

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

      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await expect(
        reservationVault
          .connect(thirdParty)
          .redeemReservation(reservationKey, randomRedeemerScript())
      ).to.be.revertedWith("Wallet must be in Live or MovingFunds state")
    })
  })

  describe("wallet lifecycle integration", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("keeps a reservation-holding wallet out of the Closing state", async () => {
      await makeAcceptedReservation()

      // A redemption-timeout-style transition of the (main-UTXO-less)
      // wallet must land in MovingFunds, not Closing: the wallet still
      // custodies an anchor.
      const secondReservation = await makeAcceptedReservation()
      const redeemerScript = randomRedeemerScript()
      await requestRedemption(secondReservation.reservationKey, redeemerScript)
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(secondReservation.reservationKey, [])

      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.MovingFunds
      )
    })
  })
})
