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
        expect((await bridge.reservations(reservationKey)).state).to.equal(2)
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
        state: walletState.Terminated,
        movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
      })
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalance(reservationVault.address, amountSat)
      const vaultSigner = await impersonateContract(reservationVault.address)
      await bank.connect(vaultSigner).approveBalance(bridge.address, amountSat)
      await bridge
        .connect(vaultSigner)
        .requestReservedRedemption(
          reservationKey,
          thirdParty.address,
          redeemerOutputScript
        )

      // Wire the watchtower only after the request so the
      // isSafeRedemption gate does not call an EOA.
      await bridge
        .connect(bridgeGovernanceSigner)
        .setRedemptionWatchtower(deployer.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert when called by a third party", async () => {
      await expect(
        bridge.connect(thirdParty).notifyReservedRedemptionVeto(reservationKey)
      ).to.be.revertedWith("Caller is not the redemption watchtower")
    })

    it("should detain the balance and reactivate the reservation", async () => {
      const tx = await bridge
        .connect(deployer)
        .notifyReservedRedemptionVeto(reservationKey)

      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionVetoed")
        .withArgs(reservationKey)

      expect(await bank.balanceOf(deployer.address)).to.equal(amountSat)
      expect((await bridge.reservations(reservationKey)).state).to.equal(1) // Active
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
        state: walletState.Terminated,
        movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
      })
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      // Simulate the state a redemption timeout leaves the owner in: the
      // gross amount refunded as Bank balance. The fee is paid in TBTC,
      // funded here through an ordinary reservation credit.
      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalance(thirdParty.address, amountSat)
      await bank
        .connect(bridgeSigner)
        .increaseBalanceAndCall(
          reservationVault.address,
          [thirdParty.address],
          [amountSat]
        )
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

      await expect(tx).to.emit(bridge, "ReservedRedemptionRequested")
      expect((await bridge.reservations(reservationKey)).state).to.equal(2) // RedemptionRequested
      expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)
      // The redemption fee is not re-charged on retry.
      expect(await tbtc.balanceOf(treasury.address)).to.equal(
        treasuryBalanceBefore
      )
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
          MAX_RESERVATIONS_PER_WALLET
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
          MAX_RESERVATIONS_PER_WALLET
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
        state: walletState.Terminated,
        movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
      })
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalance(reservationVault.address, amountSat)
      const vaultSigner = await impersonateContract(reservationVault.address)
      await bank.connect(vaultSigner).approveBalance(bridge.address, amountSat)
      await bridge
        .connect(vaultSigner)
        .requestReservedRedemption(
          reservationKey,
          thirdParty.address,
          redeemerOutputScript
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("vetoes a reserved redemption after three guardian objections", async () => {
      await redemptionWatchtower
        .connect(guardianSigners[0])
        .raiseReservedObjection(reservationKey)
      await redemptionWatchtower
        .connect(guardianSigners[1])
        .raiseReservedObjection(reservationKey)

      const tx = await redemptionWatchtower
        .connect(guardianSigners[2])
        .raiseReservedObjection(reservationKey)

      await expect(tx)
        .to.emit(redemptionWatchtower, "VetoFinalized")
        .withArgs(reservationKey)
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionVetoed")
        .withArgs(reservationKey)
      await expect(tx)
        .to.emit(redemptionWatchtower, "Banned")
        .withArgs(thirdParty.address)

      // The reservation survives the veto as Active.
      expect((await bridge.reservations(reservationKey)).state).to.equal(1)

      // Default penalty is 100%: the whole detained amount is burned.
      const veto = await redemptionWatchtower.vetoProposals(reservationKey)
      expect(veto.withdrawableAmount).to.equal(0)
      expect(await bank.balanceOf(redemptionWatchtower.address)).to.equal(0)

      // The banned owner cannot re-request through the vault: the
      // isSafeRedemption gate now rejects them.
      const vaultSigner = await impersonateContract(reservationVault.address)
      await expect(
        bridge
          .connect(vaultSigner)
          .requestReservedRedemption(
            reservationKey,
            thirdParty.address,
            redeemerOutputScript
          )
      ).to.be.revertedWith("Redemption request rejected by the watchtower")
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

    it("validates a reservation anchor proposal", async () => {
      expect(
        await validator.validateReservationAnchorProposal(
          { walletPubKeyHash, depositKey, anchorTxFee: 1500 },
          depositExtraInfo
        )
      ).to.be.true

      await expect(
        validator.validateReservationAnchorProposal(
          { walletPubKeyHash, depositKey, anchorTxFee: 0 },
          depositExtraInfo
        )
      ).to.be.revertedWith("Proposed transaction fee cannot be zero")

      await expect(
        validator.validateReservationAnchorProposal(
          { walletPubKeyHash, depositKey, anchorTxFee: 2001 },
          depositExtraInfo
        )
      ).to.be.revertedWith("Proposed transaction fee is too high")
    })

    it("validates reserved redemption, re-anchor and dissolution proposals", async () => {
      const reservationKey = 12321
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      // Re-anchor: valid toward a Live target wallet.
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
      expect(
        await validator.validateReservationReanchorProposal({
          sourceWalletPubKeyHash: walletPubKeyHash,
          reservationKey,
          targetWalletPubKeyHash: secondWalletPubKeyHash,
          reanchorTxFee: 1500,
        })
      ).to.be.true

      // Dissolution: rejected before term + grace elapse.
      await expect(
        validator.validateReservationDissolutionProposal({
          walletPubKeyHash,
          reservationKey,
          dissolutionTxFee: 1500,
        })
      ).to.be.revertedWith("Reservation term or grace period not elapsed")

      // Reserved redemption: request through the vault, wait past min age.
      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalance(reservationVault.address, amountSat)
      const vaultSigner = await impersonateContract(reservationVault.address)
      await bank.connect(vaultSigner).approveBalance(bridge.address, amountSat)
      await bridge
        .connect(vaultSigner)
        .requestReservedRedemption(
          reservationKey,
          thirdParty.address,
          "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
        )

      await increaseTime(601)

      expect(
        await validator.validateReservedRedemptionProposal({
          walletPubKeyHash,
          reservationKey,
          redemptionTxFee: 1500,
        })
      ).to.be.true

      await expect(
        validator.validateReservedRedemptionProposal({
          walletPubKeyHash: secondWalletPubKeyHash,
          reservationKey,
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

    // Reveals a fresh reserved deposit and proves its anchor transaction.
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
          0
        )

      const reservationKey = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [fundingTx.txHash, 0]
        )
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

    it("accepts a proven anchor and credits the gross amount", async () => {
      const { anchorTx, acceptTx, reservationKey } =
        await makeAcceptedReservation()

      await expect(acceptTx)
        .to.emit(bridge, "ReservationAccepted")
        .withArgs(
          reservationKey,
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
      expect(reservation.state).to.equal(1) // Active

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
            0
          )
      ).to.be.revertedWith("Deposit already swept")
    })

    it("rejects an anchor paying an excessive miner fee", async () => {
      await expect(
        makeAcceptedReservation(depositAmount.sub(RESERVATION_TX_MAX_FEE + 1))
      ).to.be.revertedWith("Transaction fee is too high")
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
          reservationKey
        )

      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, redemptionTx.txHash)

      expect((await bridge.reservations(reservationKey)).state).to.equal(3) // Closed
      // The gross surrendered balance was burned.
      expect(await bank.balanceOf(bridge.address)).to.equal(0)
      expect(await tbtc.totalSupply()).to.equal(supplyBefore.sub(grossTbtc))
    })

    it("keeps redemption provable when txMaxFee exceeds the anchor (underflow guard)", async () => {
      // Regression: redemptionTxMaxFee is a governable parameter, not a
      // tx-derived value, so a governance increase can push it above an
      // existing anchorAmount. The redemption range check must not underflow
      // in that case. Fund the owner with two acceptances, then raise the
      // fee/min parameters above the anchor and prove an in-kind redemption.
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation() // funds the owner with extra TBTC

      // Raise the reservation tx max fee above the anchor amount (and the
      // minimum above the fee, preserving the invariant).
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          reservationVault.address,
          anchorAmount.add(2),
          anchorAmount.add(1),
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET
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
          reservationKey
        )
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionCompleted")
        .withArgs(reservationKey, redemptionTx.txHash)
    })

    it("allows a minimum-sized reservation to migrate (H-08 regression)", async () => {
      // A reservation whose anchor sits at the reservation minimum must
      // still be migratable with a positive fee. The earlier
      // `>= reservationMinAmount` re-anchor floor, combined with the
      // proposal validator's positive-fee requirement, left no compliant
      // re-anchor for an exactly-minimum anchor and would have pinned a
      // retiring wallet. The dust floor (`> reservationTxMaxFee`) fixes it.
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
          0
        )
      const reservationKey = BigNumber.from(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [fundingTx.txHash, 0]
        )
      )

      await liveWallet(secondWalletPubKeyHash)

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
          reservationKey
        )
      await expect(tx)
        .to.emit(bridge, "ReservationReanchored")
        .withArgs(
          reservationKey,
          secondWalletPubKeyHash,
          reanchorTx.txHash,
          migrated
        )
    })

    it("dissolves an expired reservation into the wallet main UTXO", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

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

      // Not dissolvable before term + grace.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Dissolution,
            dissolutionTx.info,
            proofFor(dissolutionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey
          )
      ).to.be.revertedWith("Reservation term or grace period not elapsed")

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      const tx = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Dissolution,
          dissolutionTx.info,
          proofFor(dissolutionTx.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey
        )

      await expect(tx).to.emit(bridge, "ReservationDissolved")

      expect((await bridge.reservations(reservationKey)).state).to.equal(3) // Closed

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
