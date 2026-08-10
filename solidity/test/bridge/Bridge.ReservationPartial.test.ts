/* eslint-disable @typescript-eslint/no-unused-expressions */

// Tests for partial reserved redemption: the two-output settlement that pays
// the requested redeemer script and re-anchors the surviving remainder to the
// custodying wallet, the request-time and proof-time bounds, sequential
// partials, partial-then-whole, the partial timeout (which returns the full
// anchor), and the late-partial settlement matrix against a newer generation.

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
const REDEMPTION_FEE_BPS = 20

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

describe("Bridge - Reservation partial redemption", () => {
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress

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
  const anchorAmount = depositAmount.sub(anchorFee) // 2998500

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ spvMaintainer, thirdParty, bank, relay, bridge, tbtc, tbtcVault } =
      await waffle.loadFixture(bridgeFixture))

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

  // Reveals a fresh reserved deposit, requests acceptance (generation 1) and
  // proves the anchor. Each acceptance mints `anchorAmount` worth of TBTC to
  // the depositor, funding the redemption surrenders below.
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

  // ---- Partial-redemption helpers ----

  const grossFor = (satoshi: BigNumber | number): BigNumber =>
    BigNumber.from(satoshi).mul(SATOSHI_MULTIPLIER)

  const feeFor = (gross: BigNumber): BigNumber =>
    gross.mul(REDEMPTION_FEE_BPS).div(10000)

  // Requests a partial in-kind redemption via the real vault flow (fee paid
  // in TBTC). The owner must already hold enough TBTC for the surrender.
  async function requestPartial(
    reservationKey: BigNumber,
    redeemerScript: string,
    redeemAmount: number
  ) {
    const gross = grossFor(redeemAmount)
    await tbtc
      .connect(thirdParty)
      .approve(reservationVault.address, gross.add(feeFor(gross)))
    await reservationVault
      .connect(thirdParty)
      .redeemReservationPartial(reservationKey, redeemerScript, redeemAmount)
  }

  // Retries a partial redemption via the Bank-balance path after a timeout
  // refund (consumes the retry entitlement instead of paying a fee).
  async function retryPartial(
    reservationKey: BigNumber,
    redeemerScript: string,
    redeemAmount: number
  ) {
    await bank
      .connect(thirdParty)
      .approveBalance(reservationVault.address, redeemAmount)
    await reservationVault
      .connect(thirdParty)
      .retryRedeemReservationPartial(
        reservationKey,
        redeemerScript,
        redeemAmount
      )
  }

  // Requests a whole redemption of the position's current claim.
  async function requestWholeRedemption(
    reservationKey: BigNumber,
    redeemerScript: string
  ) {
    const minted = (await bridge.reservations(reservationKey)).mintedAmount
    const gross = grossFor(minted)
    await tbtc
      .connect(thirdParty)
      .approve(reservationVault.address, gross.add(feeFor(gross)))
    await reservationVault
      .connect(thirdParty)
      .redeemReservation(reservationKey, redeemerScript)
  }

  // Builds a two-output partial-redemption transaction: output 0 pays the
  // redeemer script (bearing the miner fee), output 1 re-anchors the
  // remainder to the custodying wallet.
  function buildPartialTx(
    anchorTxHash: string,
    anchorIndex: number,
    redeemerScript: string,
    redeemerValue: BigNumber | number,
    remainderValue: BigNumber | number,
    remainderPkh: string = walletPubKeyHash
  ) {
    return buildTx(
      [{ txHash: anchorTxHash, index: anchorIndex }],
      [
        { valueSat: redeemerValue, script: redeemerScript.slice(4) },
        { valueSat: remainderValue, script: p2wpkhScript(remainderPkh) },
      ]
    )
  }

  function proveRedemption(
    tx: { info: unknown; txHash: string },
    reservationKey: BigNumber,
    requestNonce: number
  ) {
    return bridge
      .connect(spvMaintainer)
      .submitReservationProof(
        ProofType.Redemption,
        tx.info as never,
        proofFor(tx.txHash),
        NO_MAIN_UTXO_PARAM,
        reservationKey,
        requestNonce
      )
  }

  describe("request-time validation", () => {
    let reservationKey: BigNumber

    before(async () => {
      await createSnapshot()
      // Two acceptances so the owner can afford a surrender up to the full
      // claim (the "use the whole path" bound is reached with funds to spare).
      ;({ reservationKey } = await makeAcceptedReservation())
      await makeAcceptedReservation()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("rejects a redeemed amount at or below the dust floor", async () => {
      await expect(
        requestPartial(
          reservationKey,
          randomRedeemerScript(),
          RESERVATION_TX_MAX_FEE
        )
      ).to.be.revertedWith("Redeemed amount below the dust floor")
    })

    it("rejects a redeemed amount equal to the whole claim", async () => {
      await expect(
        requestPartial(
          reservationKey,
          randomRedeemerScript(),
          anchorAmount.toNumber()
        )
      ).to.be.revertedWith("Use the whole redemption path for a full claim")
    })

    it("rejects a remainder at or below the dust floor", async () => {
      // Remainder = mintedAmount - redeemAmount must exceed the fee floor.
      const redeemAmount = anchorAmount.toNumber() - RESERVATION_TX_MAX_FEE
      await expect(
        requestPartial(reservationKey, randomRedeemerScript(), redeemAmount)
      ).to.be.revertedWith("Remainder below the dust floor")
    })
  })

  describe("happy-path settlement", () => {
    const redeemAmount = 1000000
    const minerFee = 800
    const redeemerValue = redeemAmount - minerFee // 999200
    const remainderValue = anchorAmount.sub(redeemAmount) // 1998500

    let reservationKey: BigNumber
    let anchorTx: { txHash: string }
    let redeemerScript: string

    before(async () => {
      await createSnapshot()
      ;({ anchorTx, reservationKey } = await makeAcceptedReservation())
      redeemerScript = randomRedeemerScript()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("escrows the redeemed portion and opens a partial generation", async () => {
      await requestPartial(reservationKey, redeemerScript, redeemAmount)

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.ActionPending)

      const action = await bridge.reservationActions(reservationKey, 2)
      expect(action.actionType).to.equal(ActionType.Redemption)
      expect(action.state).to.equal(ActionState.Pending)
      expect(action.isPartial).to.be.true
      expect(action.amount).to.equal(redeemAmount)

      // The Bridge holds exactly the redeemed portion in escrow.
      expect(await bank.balanceOf(bridge.address)).to.equal(redeemAmount)
    })

    it("settles the two outputs, re-anchoring the remainder", async () => {
      const partialTx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        redeemerValue,
        remainderValue
      )

      const tx = await proveRedemption(partialTx, reservationKey, 2)

      await expect(tx)
        .to.emit(bridge, "ReservationPartiallyRedeemed")
        .withArgs(
          reservationKey,
          2,
          partialTx.txHash,
          redeemAmount,
          remainderValue
        )

      // The position stays Active and shrinks to the remainder anchor; the
      // claim still equals the anchor to the satoshi.
      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.mintedAmount).to.equal(remainderValue)
      expect(reservation.anchorAmount).to.equal(remainderValue)
      expect(reservation.anchorTxHash).to.equal(partialTx.txHash)
      expect(reservation.anchorTxOutputIndex).to.equal(1)

      // The settled generation is terminal and the escrow was burned.
      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Settled)
      expect(await bank.balanceOf(bridge.address)).to.equal(0)

      // The consumed anchor is registered as honestly spent.
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

      // Reserved capacity dropped by the redeemed portion.
      const params = await bridge.reservationParameters()
      expect(params.reservationTotalAmount).to.equal(remainderValue)
    })

    it("rejects a second settlement of the same generation", async () => {
      const partialTx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        redeemerValue,
        remainderValue
      )
      await expect(
        proveRedemption(partialTx, reservationKey, 2)
      ).to.be.revertedWith("Action is not settleable")
    })
  })

  describe("proof-time output validation", () => {
    const redeemAmount = 1000000
    const redeemerValue = redeemAmount - 800 // 999200
    const remainderValue = anchorAmount.sub(redeemAmount) // 1998500

    let reservationKey: BigNumber
    let anchorTx: { txHash: string }
    let redeemerScript: string

    before(async () => {
      await createSnapshot()
      ;({ anchorTx, reservationKey } = await makeAcceptedReservation())
      redeemerScript = randomRedeemerScript()
      await requestPartial(reservationKey, redeemerScript, redeemAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("rejects a single-output transaction", async () => {
      const tx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [{ valueSat: redeemerValue, script: redeemerScript.slice(4) }]
      )
      await expect(proveRedemption(tx, reservationKey, 2)).to.be.revertedWith(
        "Partial redemption must have exactly two outputs"
      )
    })

    it("rejects a first output paying the wrong script", async () => {
      const tx = buildPartialTx(
        anchorTx.txHash,
        0,
        randomRedeemerScript(),
        redeemerValue,
        remainderValue
      )
      await expect(proveRedemption(tx, reservationKey, 2)).to.be.revertedWith(
        "First output does not pay the requested redeemer script"
      )
    })

    it("rejects a first output below the fee-bounded range", async () => {
      // amount - value must not exceed txMaxFee.
      const tooLow = redeemAmount - (RESERVATION_TX_MAX_FEE + 1)
      const tx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        tooLow,
        remainderValue
      )
      await expect(proveRedemption(tx, reservationKey, 2)).to.be.revertedWith(
        "Redeemer output value is not within the acceptable range"
      )
    })

    it("rejects a remainder that does not re-anchor to the wallet", async () => {
      const tx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        redeemerValue,
        remainderValue,
        "0x1111111111111111111111111111111111111111"
      )
      await expect(proveRedemption(tx, reservationKey, 2)).to.be.revertedWith(
        "Second output must re-anchor to the custodying wallet"
      )
    })

    it("rejects a remainder value that breaks the claim-equals-anchor rule", async () => {
      const tx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        redeemerValue,
        remainderValue.add(1)
      )
      await expect(proveRedemption(tx, reservationKey, 2)).to.be.revertedWith(
        "Remainder value must equal the anchor minus the redeemed amount"
      )
    })
  })

  describe("sequential partials and partial-then-whole", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("chains a second partial onto the remainder anchor", async () => {
      // Two acceptances fund two surrenders.
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      // First partial: redeem 1,000,000 of 2,998,500.
      const script1 = randomRedeemerScript()
      await requestPartial(reservationKey, script1, 1000000)
      const remainder1 = anchorAmount.sub(1000000) // 1998500
      const partialTx1 = buildPartialTx(
        anchorTx.txHash,
        0,
        script1,
        1000000 - 800,
        remainder1
      )
      await proveRedemption(partialTx1, reservationKey, 2)

      // Second partial spends the remainder anchor (tx1, index 1).
      const script2 = randomRedeemerScript()
      await requestPartial(reservationKey, script2, 500000)
      const remainder2 = remainder1.sub(500000) // 1498500
      const partialTx2 = buildPartialTx(
        partialTx1.txHash,
        1,
        script2,
        500000 - 600,
        remainder2
      )
      const tx = await proveRedemption(partialTx2, reservationKey, 3)

      await expect(tx)
        .to.emit(bridge, "ReservationPartiallyRedeemed")
        .withArgs(reservationKey, 3, partialTx2.txHash, 500000, remainder2)

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.mintedAmount).to.equal(remainder2)
      expect(reservation.anchorAmount).to.equal(remainder2)
      expect(reservation.anchorTxHash).to.equal(partialTx2.txHash)
      expect(reservation.anchorTxOutputIndex).to.equal(1)
    })

    it("closes the position when a whole redemption follows a partial", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const script1 = randomRedeemerScript()
      await requestPartial(reservationKey, script1, 1000000)
      const remainder1 = anchorAmount.sub(1000000) // 1998500
      const partialTx1 = buildPartialTx(
        anchorTx.txHash,
        0,
        script1,
        1000000 - 800,
        remainder1
      )
      await proveRedemption(partialTx1, reservationKey, 2)

      // Whole redemption of the surviving claim spends the remainder anchor.
      const script2 = randomRedeemerScript()
      await requestWholeRedemption(reservationKey, script2)
      const wholeTx = buildTx(
        [{ txHash: partialTx1.txHash, index: 1 }],
        [{ valueSat: remainder1.sub(800), script: script2.slice(4) }]
      )
      const tx = await proveRedemption(wholeTx, reservationKey, 3)

      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, 3, wholeTx.txHash)

      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Closed
      )
      // Both escrows were burned; the Bridge holds nothing.
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
    })
  })

  describe("partial redemption timeout", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("returns the full anchor and refunds the escrowed portion", async () => {
      const { reservationKey } = await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestPartial(reservationKey, redeemerScript, 1000000)

      const redeemerBefore = await bank.balanceOf(thirdParty.address)

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The escrowed portion is refunded to the redeemer as Bank balance.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        redeemerBefore.add(1000000)
      )
      expect(await bank.balanceOf(bridge.address)).to.equal(0)

      // The position returns to Active with the FULL anchor intact; nothing
      // was redeemed on-chain.
      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.mintedAmount).to.equal(anchorAmount)
      expect(reservation.anchorAmount).to.equal(anchorAmount)
      expect(reservation.retryCredit).to.be.true

      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.TimedOut)
    })
  })

  describe("partial redemption retry credit", () => {
    const failedAmount = 100000
    const largerAmount = 200000

    let anchorTx: { txHash: string }
    let reservationKey: BigNumber
    let redeemerScript: string

    beforeEach(async () => {
      await createSnapshot()
      ;({ anchorTx, reservationKey } = await makeAcceptedReservation())
      redeemerScript = randomRedeemerScript()

      await requestPartial(reservationKey, redeemerScript, failedAmount)

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("allows one fee-free retry of the timed-out partial amount", async () => {
      await retryPartial(reservationKey, redeemerScript, failedAmount)

      const action = await bridge.reservationActions(reservationKey, 3)
      expect(action.state).to.equal(ActionState.Pending)
      expect(action.isPartial).to.be.true
      expect(action.amount).to.equal(failedAmount)
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be
        .false
    })

    it("rejects using a small partial timeout credit for a larger partial", async () => {
      // Combine the timeout refund with TBTC from the remaining claim, which
      // is the funding shape that made the unbound boolean exploitable.
      const additionalAmount = largerAmount - failedAmount
      const additionalGross = grossFor(additionalAmount)
      await tbtc.connect(thirdParty).approve(tbtcVault.address, additionalGross)
      await tbtcVault.connect(thirdParty).unmint(additionalGross)
      await bank
        .connect(thirdParty)
        .approveBalance(reservationVault.address, largerAmount)

      await expect(
        reservationVault
          .connect(thirdParty)
          .retryRedeemReservationPartial(
            reservationKey,
            redeemerScript,
            largerAmount
          )
      ).to.be.revertedWith("Retry entitlement does not match redemption")

      // The failed attempt is atomic and leaves the valid credit available.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(largerAmount)
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be.true
    })

    it("rejects using a partial timeout credit for a whole redemption", async () => {
      // BankStub supplies the balance independently of the authorization
      // check, modeling an owner who acquired enough TBTC/Bank balance to
      // fund the larger request.
      await bank.setBalance(thirdParty.address, anchorAmount)
      await bank
        .connect(thirdParty)
        .approveBalance(reservationVault.address, anchorAmount)

      await expect(
        reservationVault
          .connect(thirdParty)
          .retryRedeemReservation(reservationKey, redeemerScript)
      ).to.be.revertedWith("Retry entitlement does not match redemption")

      expect((await bridge.reservations(reservationKey)).retryCredit).to.be.true
    })

    it("retires the credit when its original partial settles late", async () => {
      const partialTx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        failedAmount - 800,
        anchorAmount.sub(failedAmount)
      )

      await proveRedemption(partialTx, reservationKey, 2)

      expect((await bridge.reservations(reservationKey)).retryCredit).to.be
        .false

      await bank
        .connect(thirdParty)
        .approveBalance(reservationVault.address, failedAmount)
      await expect(
        reservationVault
          .connect(thirdParty)
          .retryRedeemReservationPartial(
            reservationKey,
            redeemerScript,
            failedAmount
          )
      ).to.be.revertedWith("No retry entitlement")
    })

    it("preserves a newer generation's credit when an older partial settles late", async () => {
      const oldPartialTx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        failedAmount - 800,
        anchorAmount.sub(failedAmount)
      )

      // Pay for another request of the same amount and shape without using
      // the older credit. Its timeout replaces the outstanding entitlement
      // with one sourced from generation 3.
      const newerScript = randomRedeemerScript()
      await requestPartial(reservationKey, newerScript, failedAmount)
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      await proveRedemption(oldPartialTx, reservationKey, 2)

      expect((await bridge.reservations(reservationKey)).retryCredit).to.be.true

      // Late settlement of generation 2 must not erase generation 3's
      // independently fee-paid retry entitlement.
      await retryPartial(reservationKey, newerScript, failedAmount)
      const retryAction = await bridge.reservationActions(reservationKey, 4)
      expect(retryAction.state).to.equal(ActionState.Pending)
      expect(retryAction.amount).to.equal(failedAmount)
    })
  })

  describe("whole redemption retry credit", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("preserves the fee-free whole retry after a re-anchor write-down", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      // Fund the owner with enough TBTC to cover the whole redemption fee.
      await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestWholeRedemption(reservationKey, redeemerScript)

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      expect((await bridge.reservations(reservationKey)).retryCredit).to.be.true
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.MovingFunds
      )

      // MovingFunds re-anchors are permissionless. Settle one with a miner
      // fee so both the anchor and the full minted claim are written down.
      await liveWallet(secondWalletPubKeyHash)
      await bridge
        .connect(thirdParty)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)

      const minerFee = 800
      const writtenDownAmount = anchorAmount.sub(minerFee)
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: writtenDownAmount,
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
          3
        )

      const writtenDown = await bridge.reservations(reservationKey)
      expect(writtenDown.mintedAmount).to.equal(writtenDownAmount)
      expect(writtenDown.retryCredit).to.be.true

      await bank
        .connect(thirdParty)
        .approveBalance(reservationVault.address, writtenDownAmount)
      const retryTx = await reservationVault
        .connect(thirdParty)
        .retryRedeemReservation(reservationKey, redeemerScript)

      await expect(retryTx)
        .to.emit(bridge, "ReservedRedemptionRequested")
        .withArgs(
          reservationKey,
          4,
          thirdParty.address,
          redeemerScript,
          writtenDownAmount,
          RESERVATION_TX_MAX_FEE,
          false
        )

      const retryAction = await bridge.reservationActions(reservationKey, 4)
      expect(retryAction.amount).to.equal(writtenDownAmount)
      expect(retryAction.isPartial).to.be.false
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be
        .false
      // The timeout refunded the old full claim. Only the current, smaller
      // claim is escrowed by the retry.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(minerFee)
    })
  })

  describe("late partial settlement matrix", () => {
    const redeemAmount = 1000000
    const redeemerValue = redeemAmount - 800 // 999200
    const remainderValue = anchorAmount.sub(redeemAmount) // 1998500

    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("settles a late partial with no newer generation and no second refund", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestPartial(reservationKey, redeemerScript, redeemAmount)

      // The wallet's transaction confirms on Bitcoin but the proof is late.
      const partialTx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        redeemerValue,
        remainderValue
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      const redeemerAfterTimeout = await bank.balanceOf(thirdParty.address)
      const bridgeAfterTimeout = await bank.balanceOf(bridge.address)

      const tx = await proveRedemption(partialTx, reservationKey, 2)

      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 2, ActionType.Redemption)
      await expect(tx)
        .to.emit(bridge, "ReservationPartiallyRedeemed")
        .withArgs(
          reservationKey,
          2,
          partialTx.txHash,
          redeemAmount,
          remainderValue
        )

      // No Bank movement during the late settlement: the timeout already
      // refunded the escrow and slashed the wallet.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        redeemerAfterTimeout
      )
      expect(await bank.balanceOf(bridge.address)).to.equal(bridgeAfterTimeout)

      // The position reduces to the remainder anchor and stays Active.
      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.mintedAmount).to.equal(remainderValue)
      expect(reservation.anchorTxHash).to.equal(partialTx.txHash)
      expect(reservation.anchorTxOutputIndex).to.equal(1)
    })

    it("forces settlement against a matching pending partial generation", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestPartial(reservationKey, redeemerScript, redeemAmount)

      const partialTx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        redeemerValue,
        remainderValue
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The owner retries the SAME partial (same script, same amount):
      // generation 3, funded by the timeout refund.
      await retryPartial(reservationKey, redeemerScript, redeemAmount)

      // The confirmed transaction satisfies both the timed-out generation 2
      // and the pending generation 3. The late path must refuse to settle
      // generation 2 (that would lose the burn).
      await expect(
        proveRedemption(partialTx, reservationKey, 2)
      ).to.be.revertedWith("Must settle the pending generation")

      const tx = await proveRedemption(partialTx, reservationKey, 3)
      await expect(tx)
        .to.emit(bridge, "ReservationPartiallyRedeemed")
        .withArgs(
          reservationKey,
          3,
          partialTx.txHash,
          redeemAmount,
          remainderValue
        )

      // Settling the pending generation burned the escrow.
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
      expect((await bridge.reservations(reservationKey)).mintedAmount).to.equal(
        remainderValue
      )
    })

    it("unwinds a non-matching pending generation and refunds its escrow", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      const redeemerScript = randomRedeemerScript()
      await requestPartial(reservationKey, redeemerScript, redeemAmount)

      const partialTx = buildPartialTx(
        anchorTx.txHash,
        0,
        redeemerScript,
        redeemerValue,
        remainderValue
      )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      // The owner retries toward a DIFFERENT redeemer script (generation 3),
      // unaware the old transaction confirmed.
      const otherScript = randomRedeemerScript()
      await retryPartial(reservationKey, otherScript, redeemAmount)
      expect(await bank.balanceOf(bridge.address)).to.equal(redeemAmount)

      // The late proof of generation 2 settles; generation 3 can never
      // settle (its anchor is gone), so it is unwound and its escrow
      // refunded.
      const tx = await proveRedemption(partialTx, reservationKey, 2)

      await expect(tx)
        .to.emit(bridge, "ReservationActionSuperseded")
        .withArgs(reservationKey, 3)
      await expect(tx)
        .to.emit(bridge, "ReservationLateSettled")
        .withArgs(reservationKey, 2, ActionType.Redemption)

      expect(
        (await bridge.reservationActions(reservationKey, 3)).state
      ).to.equal(ActionState.Superseded)

      // Generation 3's escrow returned to its redeemer; the Bridge holds
      // nothing and the position survives as the remainder anchor.
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
      expect(await bank.balanceOf(thirdParty.address)).to.equal(redeemAmount)
      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.mintedAmount).to.equal(remainderValue)
    })
  })
})
