/* eslint-disable @typescript-eslint/no-unused-expressions */

// Backing-integrity tests for the reservation claim/anchor model: the claim
// always equals the current anchor, in-kind Bitcoin miner fees of
// re-anchor and dissolution transactions are financed from the vault's
// custody-fee reserve (burning supply in lockstep with the backing loss),
// reserve poverty degrades to public, repayable debt instead of blocking
// settlement, and the amount-denominated caps bind at request time.

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

const ProofType = {
  Acceptance: 0,
  Redemption: 1,
  Reanchor: 2,
  Dissolution: 3,
}

const ReservationState = {
  Unknown: 0,
  Active: 1,
  ActionPending: 2,
  Closed: 3,
  Stranded: 4,
}

describe("Bridge - Reservation backing", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress

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
  const initiationFeeTbtc = grossTbtc.mul(40).div(10000)

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
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

    // Keep the deposit refund comfortably beyond every reservation action
    // exercised by this suite, including term-plus-grace dissolution. The
    // acceptance path validates the exact reveal-time deadline even when the
    // global reveal-ahead check is disabled.
    refundLocktime = `0x${toLE(
      (await lastBlockTime()) + 400 * 24 * 60 * 60,
      4
    )}`

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
    await liveWallet(secondWalletPubKeyHash)

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

  describe("claim tracks the anchor across re-anchors", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    const reanchorFee = 1000

    it("finances the re-anchor miner fee and writes the claim down", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      const supplyBefore = await tbtc.totalSupply()
      const reserveBefore = await tbtc.balanceOf(reservationVault.address)
      expect(reserveBefore).to.equal(initiationFeeTbtc)

      await bridge
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)

      const newAnchorAmount = anchorAmount.sub(reanchorFee)
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: newAnchorAmount,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Reanchor,
          reanchorTx.info,
          proofFor(reanchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )

      // Claim == anchor at all times.
      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.mintedAmount).to.equal(newAnchorAmount)
      expect(reservation.anchorAmount).to.equal(newAnchorAmount)

      // The miner fee was financed from the vault reserve: total supply
      // shrank in lockstep with the Bitcoin backing.
      const financedTbtc = BigNumber.from(reanchorFee).mul(SATOSHI_MULTIPLIER)
      expect(await tbtc.totalSupply()).to.equal(supplyBefore.sub(financedTbtc))
      expect(await tbtc.balanceOf(reservationVault.address)).to.equal(
        reserveBefore.sub(financedTbtc)
      )
      expect(await reservationVault.inKindFeeDebtSat()).to.equal(0)

      // The per-wallet amount accounting moved with the anchor.
      expect(await bridge.walletReservationsAmount(walletPubKeyHash)).to.equal(
        0
      )
      expect(
        await bridge.walletReservationsAmount(secondWalletPubKeyHash)
      ).to.equal(newAnchorAmount)

      // Redemption after the hop surrenders exactly the written-down
      // claim; supply and backing reconcile with no residue.
      await makeAcceptedReservation() // funds the owner with extra TBTC

      const redeemerScript = randomRedeemerScript()
      const redemptionFee = newAnchorAmount
        .mul(SATOSHI_MULTIPLIER)
        .mul(20)
        .div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(
          reservationVault.address,
          newAnchorAmount.mul(SATOSHI_MULTIPLIER).add(redemptionFee)
        )
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, redeemerScript, redemptionFee)

      const redemptionTx = buildTx(
        [{ txHash: reanchorTx.txHash, index: 0 }],
        [
          {
            valueSat: newAnchorAmount.sub(500),
            script: redeemerScript.slice(4),
          },
        ]
      )
      const supplyBeforeSettle = await tbtc.totalSupply()
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          3
        )

      // The escrowed written-down claim was burned at settlement (the
      // ERC-20 leg burned at request time via unmint).
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
      expect(await tbtc.totalSupply()).to.equal(supplyBeforeSettle)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Closed
      )
    })
  })

  describe("dissolution reconciles supply with net backing", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("finances the dissolution miner fee atomically with settlement", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)
      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)

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

      const supplyBefore = await tbtc.totalSupply()
      const ownerBalanceBefore = await tbtc.balanceOf(thirdParty.address)

      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          dissolutionTx.info,
          proofFor(dissolutionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )

      // The pool gained anchor - fee while the owner's full minted claim
      // remains outstanding; the fee is financed by burning reserve
      // supply, so supply == backing again.
      expect(await tbtc.totalSupply()).to.equal(
        supplyBefore.sub(BigNumber.from(dissolutionFee).mul(SATOSHI_MULTIPLIER))
      )
      // The owner's balance is untouched: their claim simply became an
      // ordinary pooled claim.
      expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
        ownerBalanceBefore
      )
      expect(await reservationVault.inKindFeeDebtSat()).to.equal(0)
    })
  })

  describe("reserve poverty degrades to public repayable debt", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("records debt instead of blocking settlement, then repays", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      // Governance sweeps the whole reserve away (target defaults to 0).
      await reservationVault.connect(governance).sweepFees(treasury.address)
      expect(await tbtc.balanceOf(reservationVault.address)).to.equal(0)

      await bridge
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)

      const reanchorFee = 1000
      const newAnchorAmount = anchorAmount.sub(reanchorFee)
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: newAnchorAmount,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )

      // Settlement must proceed despite the empty reserve.
      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Reanchor,
          reanchorTx.info,
          proofFor(reanchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          2
        )
      await expect(tx)
        .to.emit(reservationVault, "InKindFeeFinanced")
        .withArgs(reanchorFee, reanchorFee)

      expect(await reservationVault.inKindFeeDebtSat()).to.equal(reanchorFee)
      expect((await bridge.reservations(reservationKey)).mintedAmount).to.equal(
        newAnchorAmount
      )

      // Anyone can repay the debt, burning the over-supply.
      const repayTbtc = BigNumber.from(reanchorFee).mul(SATOSHI_MULTIPLIER)
      const supplyBefore = await tbtc.totalSupply()
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, repayTbtc)
      await expect(
        reservationVault.connect(thirdParty).repayInKindFeeDebt(reanchorFee)
      )
        .to.emit(reservationVault, "InKindFeeDebtRepaid")
        .withArgs(thirdParty.address, reanchorFee)

      expect(await reservationVault.inKindFeeDebtSat()).to.equal(0)
      expect(await tbtc.totalSupply()).to.equal(supplyBefore.sub(repayTbtc))
    })
  })

  describe("amount-denominated caps", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("binds the single-reservation cap at acceptance request", async () => {
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationCaps(0, depositAmount.sub(1))

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

      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationAcceptance(reservationKey, walletPubKeyHash)
      ).to.be.revertedWith("Reservation exceeds the single-reservation cap")
    })

    it("binds the per-wallet amount cap at acceptance and re-anchor requests", async () => {
      // Set up the positions before tightening the cap: one reservation on
      // each wallet, plus a fee-funding one on the second wallet.
      const first = await makeAcceptedReservation()
      const second = await makeAcceptedReservation(secondWalletPubKeyHash)
      await makeAcceptedReservation(secondWalletPubKeyHash) // fee funding

      // Now allow roughly one reservation per wallet by amount.
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationCaps(depositAmount.add(1000), 0)

      // A second acceptance for the same wallet exceeds the amount cap
      // (even though the count cap would allow it).
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
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationAcceptance(
            BigNumber.from(
              ethers.utils.solidityKeccak256(
                ["bytes32", "uint32"],
                [fundingTx.txHash, 0]
              )
            ),
            walletPubKeyHash
          )
      ).to.be.revertedWith("Wallet reserved amount cap exceeded")

      // A re-anchor into a wallet already at its amount cap is rejected
      // at request time.
      await expect(
        bridge
          .connect(bridgeGovernanceSigner)
          .requestReservationReanchor(second.reservationKey, walletPubKeyHash)
      ).to.be.revertedWith("Wallet reserved amount cap exceeded")

      // Releasing the first wallet's capacity (via redemption) makes the
      // re-anchor request possible again.
      const redeemerScript = randomRedeemerScript()
      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(first.reservationKey, redeemerScript, redemptionFee)
      const redemptionTx = buildTx(
        [{ txHash: first.anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(500),
            script: redeemerScript.slice(4),
          },
        ]
      )
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Redemption,
          redemptionTx.info,
          proofFor(redemptionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          first.reservationKey,
          2
        )

      await bridge
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(second.reservationKey, walletPubKeyHash)
      expect((await bridge.reservations(second.reservationKey)).state).to.equal(
        ReservationState.ActionPending
      )
    })
  })
})
