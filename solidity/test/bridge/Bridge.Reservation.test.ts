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
  BridgeGovernance,
  BridgeStub,
  IRelay,
  ReservationRouter,
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
const RESERVATION_ACTION_TIMEOUT = 172800 // 48 hours

const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

// Reservation.ReservationState
const ReservationState = {
  Unknown: 0,
  Active: 1,
  ActionPending: 2,
  Closed: 3,
  Stranded: 4,
}

// Reservation.ActionType
const ActionType = {
  None: 0,
  Acceptance: 1,
  Redemption: 2,
  Reanchor: 3,
  Dissolution: 4,
}

// Reservation.ActionState
const ActionState = {
  Unknown: 0,
  Pending: 1,
  Settled: 2,
  TimedOut: 3,
  Vetoed: 4,
  Superseded: 5,
}

describe("Bridge - Reservation", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress
  let deployer: SignerWithAddress

  let bank: Bank & BankStub
  let relay: FakeContract<IRelay>
  let bridge: Bridge & BridgeStub & ReservationRouter
  let tbtc: TBTC & Contract
  let tbtcVault: TBTCVault & Contract
  let bridgeGovernance: BridgeGovernance
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
      bridgeGovernance,
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
        MAX_RESERVATIONS_PER_WALLET,
        RESERVATION_ACTION_TIMEOUT
      )
  }

  // Builds an active reservation position owned by `owner`, custodied by
  // the wallet identified by `walletPubKeyHash`.
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
      state: ReservationState.Active,
      requestNonce: 0,
      retryCredit: false,
      termSeconds: RESERVATION_TERM,
      gracePeriod: RESERVATION_GRACE,
    }
  }

  // Requests a reserved redemption through the impersonated vault, funding
  // and approving the gross Bank balance surrender.
  async function requestRedemptionViaVault(
    reservationKey: BigNumber | number,
    amountSat: BigNumber,
    redeemer: string,
    redeemerOutputScript: string,
    options: { feePaid?: boolean; useRetryCredit?: boolean } = {}
  ) {
    const bridgeSigner = await impersonateContract(bridge.address)
    await bank
      .connect(bridgeSigner)
      .increaseBalance(reservationVault.address, amountSat)
    const vaultSigner = await impersonateContract(reservationVault.address)
    await bank.connect(vaultSigner).approveBalance(bridge.address, amountSat)
    return bridge
      .connect(vaultSigner)
      .requestReservedRedemption(
        reservationKey,
        redeemer,
        redeemerOutputScript,
        options.feePaid ?? true,
        options.useRetryCredit ?? false
      )
  }

  // ---- Bitcoin fixture crafting (regtest-style difficulty) ----
  // SPV proof validation checks transaction structure, merkle inclusion,
  // and header work against the relay difficulty -- it does not execute
  // Bitcoin scripts. Fixtures below use regtest-style compact bits
  // (0x207fffff), whose integer difficulty is 0, with the relay mocked to
  // report difficulty 0, so headers are minable in a couple of tries.

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

  interface FixtureTxIn {
    txHash: string
    index: number
  }

  interface FixtureTxOut {
    valueSat: BigNumber | number
    script: string // raw script hex, no 0x, no length prefix
  }

  function buildTx(inputs: FixtureTxIn[], outputs: FixtureTxOut[]) {
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

  // Builds an SPV proof for a transaction assumed to share a two-leaf
  // block with a synthetic coinbase.
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
              MAX_RESERVATIONS_PER_WALLET,
              RESERVATION_ACTION_TIMEOUT
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
            MAX_RESERVATIONS_PER_WALLET,
            RESERVATION_ACTION_TIMEOUT
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
            MAX_RESERVATIONS_PER_WALLET,
            RESERVATION_ACTION_TIMEOUT
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
              MAX_RESERVATIONS_PER_WALLET,
              RESERVATION_ACTION_TIMEOUT
            )
        ).to.be.revertedWith(
          "Reservation transaction max fee must be greater than zero"
        )
      })

      it("should revert for a zero action timeout", async () => {
        await expect(
          bridge
            .connect(bridgeGovernanceSigner)
            .updateReservationParameters(
              reservationVault.address,
              RESERVATION_MIN_AMOUNT,
              RESERVATION_TX_MAX_FEE,
              RESERVATION_TERM,
              RESERVATION_GRACE,
              RESERVATION_MAX_TOTAL,
              MAX_RESERVATIONS_PER_WALLET,
              0
            )
        ).to.be.revertedWith(
          "Reservation action timeout must be greater than zero"
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
              MAX_RESERVATIONS_PER_WALLET,
              RESERVATION_ACTION_TIMEOUT
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
      it("should extend the reservation term by the snapshotted length", async () => {
        const before_ = await bridge.reservations(reservationKey)

        // Change the live term parameter: the extension must use the
        // position's snapshot, not the live value.
        await bridge
          .connect(bridgeGovernanceSigner)
          .updateReservationParameters(
            reservationVault.address,
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_TERM * 2,
            RESERVATION_GRACE,
            RESERVATION_MAX_TOTAL,
            MAX_RESERVATIONS_PER_WALLET,
            RESERVATION_ACTION_TIMEOUT
          )

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

      await bridge.setWallet(walletPubKeyHash, {
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
      // The redemption timeout path slashes the wallet and moves it toward
      // retirement, decrementing the live wallets counter.
      await bridge.setLiveWalletsCount(1)

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
        bridge
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

    it("should register the generation, take the balance, and refund on timeout", async () => {
      const tx = await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )

      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionRequested")
        .withArgs(
          reservationKey,
          1,
          thirdParty.address,
          redeemerOutputScript,
          amountSat,
          RESERVATION_TX_MAX_FEE,
          true
        )

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.ActionPending)
      expect(reservation.requestNonce).to.equal(1)
      expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)

      const action = await bridge.reservationActions(reservationKey, 1)
      expect(action.actionType).to.equal(ActionType.Redemption)
      expect(action.state).to.equal(ActionState.Pending)
      expect(action.redeemer).to.equal(thirdParty.address)
      expect(action.amount).to.equal(amountSat)
      expect(action.feePaid).to.be.true

      // Re-requesting while one is pending must fail.
      const vaultSigner = await impersonateContract(reservationVault.address)
      await expect(
        bridge
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
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)

      const timeoutTx = await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])

      await expect(timeoutTx)
        .to.emit(bridge, "ReservationActionTimedOut")
        .withArgs(reservationKey, 1, ActionType.Redemption)
      await expect(timeoutTx)
        .to.emit(bridge, "ReservationRetryCreditMinted")
        .withArgs(reservationKey)

      expect(await bank.balanceOf(thirdParty.address)).to.equal(amountSat)

      const reservationAfter = await bridge.reservations(reservationKey)
      expect(reservationAfter.state).to.equal(ReservationState.Active)
      expect(reservationAfter.retryCredit).to.be.true

      expect(
        (await bridge.reservationActions(reservationKey, 1)).state
      ).to.equal(ActionState.TimedOut)

      // The wallet was pushed toward retirement (it holds a reservation
      // and no main UTXO, so it enters MovingFunds rather than Closing).
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        walletState.MovingFunds
      )
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
        await bridge.setWallet(walletPubKeyHash, {
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

      it("should surrender gross TBTC, charge the redemption fee, and register the redemption", async () => {
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
        expect((await bridge.reservations(reservationKey)).state).to.equal(
          ReservationState.ActionPending
        )
        expect((await bridge.reservationActions(reservationKey, 1)).feePaid).to
          .be.true
        expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)
      })
    })
  })

  describe("notifyReservedRedemptionVeto", () => {
    const reservationKey = 555
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
    const amountSat = BigNumber.from(100000000)
    const redeemerOutputScript =
      "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"

    before(async () => {
      await createSnapshot()
      await wireReservations()

      await bridge.setWallet(walletPubKeyHash, {
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
        bridge
          .connect(thirdParty)
          .notifyReservedRedemptionVeto(reservationKey, 1)
      ).to.be.revertedWith("Caller is not the redemption watchtower")
    })

    it("should revert for a non-current generation", async () => {
      await expect(
        bridge.connect(deployer).notifyReservedRedemptionVeto(reservationKey, 2)
      ).to.be.revertedWith("Not the current generation")
    })

    it("should detain the balance, void the generation, and reactivate the reservation", async () => {
      const tx = await bridge
        .connect(deployer)
        .notifyReservedRedemptionVeto(reservationKey, 1)

      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionVetoed")
        .withArgs(reservationKey, 1)

      expect(await bank.balanceOf(deployer.address)).to.equal(amountSat)

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.Active)
      // A veto is owner-fault: no retry entitlement is minted.
      expect(reservation.retryCredit).to.be.false

      expect(
        (await bridge.reservationActions(reservationKey, 1)).state
      ).to.equal(ActionState.Vetoed)
    })
  })

  describe("ReservationVault.retryRedeemReservation", () => {
    const reservationKey = 444
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
    const amountSat = BigNumber.from(100000000)
    const grossTbtc = amountSat.mul(SATOSHI_MULTIPLIER)
    const redeemerOutputScript =
      "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"

    before(async () => {
      await createSnapshot()
      await wireReservations()

      const tbtcOwner = await impersonateContract(await tbtc.owner())
      await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.address)

      await bridge.setWallet(walletPubKeyHash, {
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
      await bridge.setLiveWalletsCount(1)
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
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])
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
        .to.emit(bridge, "ReservedRedemptionRequested")
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
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be
        .false
    })

    it("rejects a second retry without a fresh entitlement", async () => {
      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      // The retry generation was not fee-paid, so its timeout mints no
      // new entitlement.
      await bridge
        .connect(thirdParty)
        .notifyReservationActionTimeout(reservationKey, [])
      expect((await bridge.reservations(reservationKey)).retryCredit).to.be
        .false

      await bank
        .connect(thirdParty)
        .approveBalance(reservationVault.address, amountSat)
      await expect(
        reservationVault
          .connect(thirdParty)
          .retryRedeemReservation(reservationKey, redeemerOutputScript)
      ).to.be.revertedWith("No retry entitlement")
    })
  })

  describe("governance-delayed reservation parameters update", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("stages the parameters and applies them after the governance delay", async () => {
      await bridgeGovernance
        .connect(governance)
        .beginReservationParametersUpdate(
          reservationVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          RESERVATION_ACTION_TIMEOUT
        )

      await expect(
        bridgeGovernance
          .connect(governance)
          .finalizeReservationParametersUpdate()
      ).to.be.revertedWith("Governance delay has not elapsed")

      await increaseTime(
        (await bridgeGovernance.governanceDelays(0)).toNumber()
      )

      const tx = await bridgeGovernance
        .connect(governance)
        .finalizeReservationParametersUpdate()

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
          MAX_RESERVATIONS_PER_WALLET,
          RESERVATION_ACTION_TIMEOUT
        )
    })
  })

  describe("RedemptionWatchtower reserved veto flow", () => {
    const reservationKey = 666
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
    const amountSat = BigNumber.from(100000000)
    const redeemerOutputScript =
      "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
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

      // Enable the watchtower with three guardians and wire it into the
      // Bridge.
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
        for (let i = 0; i < guardianSigners.length; i++) {
          // eslint-disable-next-line no-await-in-loop
          const alreadyGuardian = await redemptionWatchtower.isGuardian(
            guardianSigners[i].address
          )
          if (!alreadyGuardian) {
            // eslint-disable-next-line no-await-in-loop
            await redemptionWatchtower
              .connect(manager)
              .addGuardian(guardianSigners[i].address)
          }
        }
      }
      await bridge
        .connect(bridgeGovernanceSigner)
        .setRedemptionWatchtower(redemptionWatchtower.address)

      await bridge.setWallet(walletPubKeyHash, {
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
        .to.emit(bridge, "ReservedRedemptionVetoed")
        .withArgs(reservationKey, 1)
      await expect(tx)
        .to.emit(redemptionWatchtower, "Banned")
        .withArgs(thirdParty.address)

      // The reservation survives the veto as Active; the generation is
      // terminally vetoed.
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Active
      )
      expect(
        (await bridge.reservationActions(reservationKey, 1)).state
      ).to.equal(ActionState.Vetoed)

      // Default penalty is 100%: the whole detained amount is burned.
      const veto = await redemptionWatchtower.vetoProposals(vetoKey)
      expect(veto.withdrawableAmount).to.equal(0)
      expect(await bank.balanceOf(redemptionWatchtower.address)).to.equal(0)

      // The banned owner cannot re-request through the vault: the
      // reservation-scoped safety gate now rejects them.
      const vaultSigner = await impersonateContract(reservationVault.address)
      await expect(
        bridge
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
      // Unban the owner: the position must become processable again --
      // objection state never accumulates across generations.
      await redemptionWatchtower.connect(governance).unban(thirdParty.address)

      await requestRedemptionViaVault(
        reservationKey,
        amountSat,
        thirdParty.address,
        redeemerOutputScript
      )

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.state).to.equal(ReservationState.ActionPending)
      expect(reservation.requestNonce).to.equal(2)

      // A single objection against the fresh generation works and does
      // not immediately veto (count starts at zero).
      await redemptionWatchtower
        .connect(guardianSigners[0])
        .raiseReservedObjection(reservationKey, 2)
      const veto = await redemptionWatchtower.vetoProposals(
        vetoKeyOf(reservationKey, 2)
      )
      expect(veto.objectionsCount).to.equal(1)
      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.ActionPending
      )
    })
  })

  describe("WalletProposalValidator", () => {
    const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
    const secondWalletPubKeyHash = "0xafcdf88d15a0e0c2134dbbc9f6da24d0e26c8f21"
    const blindingFactor = "0xf9f0c90d00039523"
    const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
    const amountSat = BigNumber.from(100000000)

    let validator: Contract
    let futureRefundLocktime: string
    let fundingTx: { info: any; txHash: string }
    let depositKey: { fundingTxHash: string; fundingOutputIndex: number }
    let depositKeyUint: BigNumber
    let depositExtraInfo: any

    before(async () => {
      await createSnapshot()
      await wireReservations()

      const ValidatorFactory = await ethers.getContractFactory(
        "WalletProposalValidator"
      )
      validator = await ValidatorFactory.deploy(bridge.address)

      await bridge.setDepositDustThreshold(10000)
      await bridge.setDepositTxMaxFee(2000)
      await bridge.setDepositRevealAheadPeriod(0)

      await bridge.setWallet(walletPubKeyHash, {
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
      await bridge.setWallet(secondWalletPubKeyHash, {
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

      // A refund locktime comfortably in the future (400 days), as 4-byte LE.
      futureRefundLocktime = `0x${toLE(
        (await lastBlockTime()) + 400 * 24 * 3600,
        4
      )}`

      const depositScript = buildDepositScript(
        thirdParty.address,
        blindingFactor,
        walletPubKeyHash,
        refundPubKeyHash,
        futureRefundLocktime
      )
      fundingTx = buildTx(
        [
          {
            txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
            index: 0,
          },
        ],
        [
          {
            valueSat: BigNumber.from(3000000),
            script: p2wshScript(depositScript),
          },
        ]
      )

      await bridge.connect(thirdParty).revealDeposit(fundingTx.info, {
        fundingOutputIndex: 0,
        blindingFactor,
        walletPubKeyHash,
        refundPubKeyHash,
        refundLocktime: futureRefundLocktime,
        vault: reservationVault.address,
      })

      depositKey = { fundingTxHash: fundingTx.txHash, fundingOutputIndex: 0 }
      depositKeyUint = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [fundingTx.txHash, 0]
        )
      )
      depositExtraInfo = {
        fundingTx: fundingTx.info,
        blindingFactor,
        walletPubKeyHash,
        refundPubKeyHash,
        refundLocktime: futureRefundLocktime,
      }

      // Let the deposit exceed DEPOSIT_MIN_AGE (2 hours).
      await increaseTime(7300)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("rejects sweep proposals containing reserved deposits", async () => {
      await expect(
        validator.validateDepositSweepProposal(
          {
            walletPubKeyHash,
            depositsKeys: [depositKey],
            sweepTxFee: 1500,
            depositsRevealBlocks: [0],
          },
          [depositExtraInfo]
        )
      ).to.be.revertedWith("Reserved deposits must not be swept")
    })

    it("validates a reservation anchor proposal against the authorization", async () => {
      // No authorization yet: the proposal is invalid.
      await expect(
        validator.validateReservationAnchorProposal(
          { walletPubKeyHash, depositKey, requestNonce: 1, anchorTxFee: 1500 },
          depositExtraInfo
        )
      ).to.be.revertedWith("No pending action of the expected type")

      await bridge
        .connect(thirdParty)
        .requestReservationAcceptance(depositKeyUint, walletPubKeyHash)

      expect(
        await validator.validateReservationAnchorProposal(
          { walletPubKeyHash, depositKey, requestNonce: 1, anchorTxFee: 1500 },
          depositExtraInfo
        )
      ).to.be.true

      await expect(
        validator.validateReservationAnchorProposal(
          { walletPubKeyHash, depositKey, requestNonce: 1, anchorTxFee: 0 },
          depositExtraInfo
        )
      ).to.be.revertedWith("Proposed transaction fee cannot be zero")

      await expect(
        validator.validateReservationAnchorProposal(
          { walletPubKeyHash, depositKey, requestNonce: 1, anchorTxFee: 2001 },
          depositExtraInfo
        )
      ).to.be.revertedWith("Proposed transaction fee is too high")

      await expect(
        validator.validateReservationAnchorProposal(
          {
            walletPubKeyHash: secondWalletPubKeyHash,
            depositKey,
            requestNonce: 1,
            anchorTxFee: 1500,
          },
          depositExtraInfo
        )
      ).to.be.revertedWith("Acceptance authorized for different wallet")
    })

    it("validates reserved redemption and re-anchor proposals against their generations", async () => {
      const reservationKey = 12321
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      // Re-anchor: requires an authorization. The source wallet is Live,
      // so only the governance can authorize a rotation.
      await expect(
        validator.validateReservationReanchorProposal({
          sourceWalletPubKeyHash: walletPubKeyHash,
          reservationKey,
          requestNonce: 1,
          targetWalletPubKeyHash: secondWalletPubKeyHash,
          reanchorTxFee: 1500,
        })
      ).to.be.revertedWith("No pending action of the expected type")

      await bridge
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)

      expect(
        await validator.validateReservationReanchorProposal({
          sourceWalletPubKeyHash: walletPubKeyHash,
          reservationKey,
          requestNonce: 1,
          targetWalletPubKeyHash: secondWalletPubKeyHash,
          reanchorTxFee: 1500,
        })
      ).to.be.true

      await expect(
        validator.validateReservationReanchorProposal({
          sourceWalletPubKeyHash: walletPubKeyHash,
          reservationKey,
          requestNonce: 1,
          targetWalletPubKeyHash: walletPubKeyHash,
          reanchorTxFee: 1500,
        })
      ).to.be.revertedWith("Re-anchor authorized for different target wallet")

      // Dissolution: no pending authorization (term has not elapsed, so
      // none can be requested).
      await expect(
        validator.validateReservationDissolutionProposal({
          walletPubKeyHash,
          reservationKey,
          requestNonce: 1,
          dissolutionTxFee: 1500,
        })
      ).to.be.revertedWith("No pending action of the expected type")

      // Reserved redemption on a second reservation: request through the
      // vault, wait past min age.
      const redemptionReservationKey = 12322
      await bridge.setReservation(
        redemptionReservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )
      await requestRedemptionViaVault(
        redemptionReservationKey,
        amountSat,
        thirdParty.address,
        "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
      )

      await increaseTime(601)

      expect(
        await validator.validateReservedRedemptionProposal({
          walletPubKeyHash,
          reservationKey: redemptionReservationKey,
          requestNonce: 1,
          redemptionTxFee: 1500,
        })
      ).to.be.true

      await expect(
        validator.validateReservedRedemptionProposal({
          walletPubKeyHash: secondWalletPubKeyHash,
          reservationKey: redemptionReservationKey,
          requestNonce: 1,
          redemptionTxFee: 1500,
        })
      ).to.be.revertedWith("Reservation custodied by different wallet")
    })
  })

  describe("reservation SPV proofs", () => {
    // ---- Scenario constants ----

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

    const ProofType = {
      Acceptance: 0,
      Redemption: 1,
      Reanchor: 2,
      Dissolution: 3,
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

    // Reveals a fresh reserved deposit, requests its acceptance and proves
    // its anchor transaction (settling acceptance generation 1).
    async function makeAcceptedReservation(anchorValue?: BigNumber) {
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

      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorValue ?? anchorAmount,
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )

      const acceptTx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Acceptance,
          anchorTx.info,
          proofFor(anchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey,
          1
        )

      return { fundingTx, anchorTx, acceptTx, reservationKey }
    }

    before(async () => {
      await createSnapshot()
      await wireReservations()

      relay.getCurrentEpochDifficulty.returns(0)
      relay.getPrevEpochDifficulty.returns(0)

      await bridge.setDepositDustThreshold(10000)
      await bridge.setDepositTxMaxFee(2000)
      await bridge.setDepositRevealAheadPeriod(0)
      await liveWallet(walletPubKeyHash)

      const tbtcOwner = await impersonateContract(await tbtc.owner())
      await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.address)
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

    it("requires an acceptance authorization before the anchor proof", async () => {
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
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
      )

      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Acceptance,
            anchorTx.info,
            proofFor(anchorTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            1
          )
      ).to.be.revertedWith("Action type mismatch")
    })

    it("accepts a proven anchor and credits the gross amount", async () => {
      const { anchorTx, acceptTx, reservationKey } =
        await makeAcceptedReservation()

      await expect(acceptTx)
        .to.emit(bridge, "ReservationAccepted")
        .withArgs(
          reservationKey,
          1,
          walletPubKeyHash,
          thirdParty.address,
          anchorTx.txHash,
          anchorAmount,
          (
            await bridge.reservations(reservationKey)
          ).expiresAt
        )

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.owner).to.equal(thirdParty.address)
      expect(reservation.mintedAmount).to.equal(anchorAmount)
      expect(reservation.anchorAmount).to.equal(anchorAmount)
      expect(reservation.anchorTxHash).to.equal(anchorTx.txHash)
      expect(reservation.state).to.equal(ReservationState.Active)
      expect(reservation.termSeconds).to.equal(RESERVATION_TERM)
      expect(reservation.gracePeriod).to.equal(RESERVATION_GRACE)

      // The capacity reserved at authorization released the miner-fee
      // delta at settlement: the total tracks the anchor value.
      const params = await bridge.reservationParameters()
      expect(params.reservationTotalAmount).to.equal(anchorAmount)

      // Gross mint minus the 40 bps initiation fee.
      const fee = grossTbtc.mul(40).div(10000)
      expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
        grossTbtc.sub(fee)
      )

      // The anchor consumed the deposit: no double acceptance.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Acceptance,
            anchorTx.info,
            proofFor(anchorTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            1
          )
      ).to.be.revertedWith("Action is not settleable")
    })

    it("rejects an anchor paying an excessive miner fee", async () => {
      await expect(
        makeAcceptedReservation(depositAmount.sub(RESERVATION_TX_MAX_FEE + 1))
      ).to.be.revertedWith("Transaction fee is too high")
    })

    it("rejects an anchor paying a wallet other than the authorized one", async () => {
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

      await liveWallet(secondWalletPubKeyHash)
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )

      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Acceptance,
            anchorTx.info,
            proofFor(anchorTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            1
          )
      ).to.be.revertedWith("Anchor output must pay the authorized wallet")
    })

    it("completes an in-kind reserved redemption", async () => {
      // Two acceptances fund the owner with enough TBTC for the gross
      // surrender plus the redemption fee on the first reservation.
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation()

      const redeemerScript = `0x16${p2wpkhScript(
        ethers.utils.hexlify(ethers.utils.randomBytes(20))
      )}`

      // Captured before the vault unmints the gross surrender: the ERC-20
      // burn happens at request time, while the SPV proof burns the Bank
      // balance held by the Bridge.
      const supplyBefore = await tbtc.totalSupply()

      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, redeemerScript)

      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4), // strip 0x16 length prefix
          },
        ]
      )

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

      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Closed
      )
      expect(
        (await bridge.reservationActions(reservationKey, 2)).state
      ).to.equal(ActionState.Settled)
      // The gross surrendered balance was burned.
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
      expect(await tbtc.totalSupply()).to.equal(supplyBefore.sub(grossTbtc))
    })

    it("keeps redemption provable when txMaxFee exceeds the anchor (underflow guard)", async () => {
      // Regression: the redemption fee bound is snapshotted at request
      // time, but a snapshot can still exceed the anchor value. The
      // redemption range check must not underflow in that case. Raise the
      // fee/min parameters above the anchor BEFORE requesting so the
      // snapshot captures them, then prove an in-kind redemption paying
      // the full anchor value.
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation() // funds the owner with extra TBTC

      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          reservationVault.address,
          anchorAmount.add(2),
          anchorAmount.add(1),
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          RESERVATION_ACTION_TIMEOUT
        )

      const redeemerScript = `0x16${p2wpkhScript(
        ethers.utils.hexlify(ethers.utils.randomBytes(20))
      )}`
      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, redeemerScript)

      // Pay the full anchor value out (zero miner fee). The old lower bound
      // `anchorAmount - redemptionTxMaxFee` would revert on underflow here.
      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: redeemerScript.slice(4) }]
      )
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

    it("re-anchors via a governance-authorized rotation (H-08 regression)", async () => {
      // A reservation whose anchor sits at the reservation minimum must
      // still be migratable with a positive fee. The earlier
      // `>= reservationMinAmount` re-anchor floor, combined with the
      // proposal validator's positive-fee requirement, left no compliant
      // re-anchor for an exactly-minimum anchor and would have pinned a
      // retiring wallet. The dust floor (`> txMaxFee` snapshot) fixes it.
      const minAmount = BigNumber.from(RESERVATION_MIN_AMOUNT)
      const depositAmt = minAmount.add(RESERVATION_TX_MAX_FEE)
      const fundingTx = buildTx(
        [
          {
            txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
            index: 0,
          },
        ],
        [
          {
            valueSat: depositAmt,
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
      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: minAmount, script: p2wpkhScript(walletPubKeyHash) }]
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

      await liveWallet(secondWalletPubKeyHash)

      // A third party cannot authorize a rotation away from a Live wallet.
      await expect(
        bridge
          .connect(thirdParty)
          .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)
      ).to.be.revertedWith("Only governance can rotate a Live wallet's anchor")

      await bridge
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)

      // Migrate with a 1-sat fee: the anchor stays above the dust floor.
      const migrated = minAmount.sub(1)
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [{ valueSat: migrated, script: p2wpkhScript(secondWalletPubKeyHash) }]
      )
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
        .to.emit(bridge, "ReservationReanchored")
        .withArgs(
          reservationKey,
          2,
          secondWalletPubKeyHash,
          reanchorTx.txHash,
          migrated
        )

      const reservation = await bridge.reservations(reservationKey)
      expect(reservation.walletPubKeyHash).to.equal(secondWalletPubKeyHash)
      expect(reservation.state).to.equal(ReservationState.Active)
    })

    it("rejects a re-anchor paying a wallet other than the authorized target", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      await liveWallet(secondWalletPubKeyHash)
      await bridge
        .connect(bridgeGovernanceSigner)
        .requestReservationReanchor(reservationKey, secondWalletPubKeyHash)

      // The transaction pays the source wallet instead of the target.
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Reanchor,
            reanchorTx.info,
            proofFor(reanchorTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey,
            2
          )
      ).to.be.revertedWith("Output must pay the authorized target wallet")
    })

    it("dissolves an expired reservation into the wallet main UTXO", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      // Not requestable before term + grace.
      await expect(
        bridge.connect(thirdParty).requestReservationDissolution(reservationKey)
      ).to.be.revertedWith("Reservation term or grace period not elapsed")

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      await bridge
        .connect(thirdParty)
        .requestReservationDissolution(reservationKey)

      expect(await bridge.walletPendingDissolution(walletPubKeyHash)).to.equal(
        reservationKey
      )

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

      await expect(tx)
        .to.emit(bridge, "ReservationDissolved")
        .withArgs(reservationKey, 2, walletPubKeyHash, dissolutionTx.txHash)

      expect((await bridge.reservations(reservationKey)).state).to.equal(
        ReservationState.Closed
      )
      // The lock is released.
      expect(await bridge.walletPendingDissolution(walletPubKeyHash)).to.equal(
        0
      )

      // The dissolution output became the wallet's new main UTXO.
      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.mainUtxoHash).to.equal(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32", "uint64"],
          [dissolutionTx.txHash, 0, anchorAmount.sub(dissolutionFee)]
        )
      )
    })
  })
})
