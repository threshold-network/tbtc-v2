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
  IWalletRegistry,
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
const RESERVATION_DISSOLUTION_TX_MAX_FEE = 1500
const MAX_CUMULATIVE_REANCHOR_FEE = 100000

const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

describe("Bridge - Reservation", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress
  let deployer: SignerWithAddress

  let bank: Bank & BankStub
  let relay: FakeContract<IRelay>
  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let tbtc: TBTC & Contract
  let tbtcVault: TBTCVault & Contract
  let bridgeGovernance: BridgeGovernance
  let reservationVault: ReservationVault
  let bridgeGovernanceSigner: SignerWithAddress
  let redemptionTimeoutSlashingAmount: BigNumber
  let redemptionTimeoutNotifierRewardMultiplier: number

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
      bridgeGovernance,
      tbtc,
      tbtcVault,
    } = await waffle.loadFixture(bridgeFixture))
    ;({
      redemptionTimeoutSlashingAmount,
      redemptionTimeoutNotifierRewardMultiplier,
    } = await bridge.redemptionParameters())

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
        RESERVATION_DISSOLUTION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET,
        MAX_CUMULATIVE_REANCHOR_FEE
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
      cumulativeReanchorFee: 0,
      lastTimeoutWasWalletFault: false,
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
              RESERVATION_DISSOLUTION_TX_MAX_FEE,
              RESERVATION_TERM,
              RESERVATION_GRACE,
              RESERVATION_MAX_TOTAL,
              MAX_RESERVATIONS_PER_WALLET,
              MAX_CUMULATIVE_REANCHOR_FEE
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
            RESERVATION_DISSOLUTION_TX_MAX_FEE,
            RESERVATION_TERM,
            RESERVATION_GRACE,
            RESERVATION_MAX_TOTAL,
            MAX_RESERVATIONS_PER_WALLET,
            MAX_CUMULATIVE_REANCHOR_FEE
          )

        await expect(tx)
          .to.emit(bridge, "ReservationVaultUpdated")
          .withArgs(reservationVault.address)
        await expect(tx)
          .to.emit(bridge, "ReservationParametersUpdated")
          .withArgs(
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_DISSOLUTION_TX_MAX_FEE,
            RESERVATION_TERM,
            RESERVATION_GRACE,
            RESERVATION_MAX_TOTAL,
            MAX_RESERVATIONS_PER_WALLET,
            MAX_CUMULATIVE_REANCHOR_FEE
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
              RESERVATION_DISSOLUTION_TX_MAX_FEE,
              RESERVATION_TERM,
              RESERVATION_GRACE,
              RESERVATION_MAX_TOTAL,
              MAX_RESERVATIONS_PER_WALLET,
              MAX_CUMULATIVE_REANCHOR_FEE
            )
        ).to.be.revertedWith(
          "Reservation transaction max fee must be greater than zero"
        )
      })

      it("should revert when the minimum amount is not greater than the tx max fee", async () => {
        await expect(
          bridge.connect(bridgeGovernanceSigner).updateReservationParameters(
            reservationVault.address,
            RESERVATION_TX_MAX_FEE, // equal, not greater
            RESERVATION_TX_MAX_FEE,
            RESERVATION_DISSOLUTION_TX_MAX_FEE,
            RESERVATION_TERM,
            RESERVATION_GRACE,
            RESERVATION_MAX_TOTAL,
            MAX_RESERVATIONS_PER_WALLET,
            MAX_CUMULATIVE_REANCHOR_FEE
          )
        ).to.be.revertedWith(
          "Reservation minimum amount must be greater than the reservation TX max fee"
        )
      })

      it("should revert for a zero reservation term", async () => {
        await expect(
          bridge
            .connect(bridgeGovernanceSigner)
            .updateReservationParameters(
              reservationVault.address,
              RESERVATION_MIN_AMOUNT,
              RESERVATION_TX_MAX_FEE,
              RESERVATION_DISSOLUTION_TX_MAX_FEE,
              0,
              RESERVATION_GRACE,
              RESERVATION_MAX_TOTAL,
              MAX_RESERVATIONS_PER_WALLET,
              MAX_CUMULATIVE_REANCHOR_FEE
            )
        ).to.be.revertedWith("Reservation term must be greater than zero")
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
              RESERVATION_DISSOLUTION_TX_MAX_FEE,
              RESERVATION_TERM,
              RESERVATION_GRACE,
              RESERVATION_MAX_TOTAL,
              MAX_RESERVATIONS_PER_WALLET,
              MAX_CUMULATIVE_REANCHOR_FEE
            )
        ).to.be.revertedWith("Active reservations exist")
      })
    })
  })

  describe("deposit sweep guard", () => {
    beforeEach(async () => {
      await createSnapshot()
      await wireReservations()
    })

    afterEach(async () => {
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

      const depositKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.hash, reveal.fundingOutputIndex]
      )
      expect(await bridge.isReservedDeposit(depositKey)).to.be.true

      // Moving the configured reservation vault away must not make this
      // reveal-time reserved deposit eligible for an ordinary sweep.
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          tbtcVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
        )
      expect(await bridge.isReservedDeposit(depositKey)).to.be.true

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

    it("should sweep an ordinary deposit after its vault becomes the reservation vault", async () => {
      const data: DepositSweepTestData = JSON.parse(
        JSON.stringify(SingleP2WSHDeposit)
      )
      // The deposit is ordinary at reveal time because the reservation vault
      // is still `reservationVault`. Governance then repurposes its trusted
      // vault as the reservation vault before the sweep is proven.
      data.deposits[0].reveal.vault = tbtcVault.address
      data.vault = tbtcVault.address

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

      const depositKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.hash, reveal.fundingOutputIndex]
      )
      expect(await bridge.isReservedDeposit(depositKey)).to.be.false

      // Build a fresh ordinary deposit with a future refund deadline so the
      // wallet proposal validator can exercise the same migration path.
      const validatorBlindingFactor = "0xf9f0c90d00039523"
      const validatorRefundPubKeyHash =
        "0x28e081f285138ccbe389c1eb8985716230129f89"
      const validatorRefundLocktime = `0x${toLE(
        (await lastBlockTime()) + 400 * 24 * 3600,
        4
      )}`
      const validatorFundingTx = buildTx(
        [
          {
            txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
            index: 0,
          },
        ],
        [
          {
            valueSat: BigNumber.from(3000000),
            script: p2wshScript(
              buildDepositScript(
                thirdParty.address,
                validatorBlindingFactor,
                reveal.walletPubKeyHash as string,
                validatorRefundPubKeyHash,
                validatorRefundLocktime
              )
            ),
          },
        ]
      )
      await bridge.connect(thirdParty).revealDeposit(validatorFundingTx.info, {
        fundingOutputIndex: 0,
        blindingFactor: validatorBlindingFactor,
        walletPubKeyHash: reveal.walletPubKeyHash,
        refundPubKeyHash: validatorRefundPubKeyHash,
        refundLocktime: validatorRefundLocktime,
        vault: tbtcVault.address,
      })
      const validatorDepositKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [validatorFundingTx.txHash, 0]
      )
      expect(await bridge.isReservedDeposit(validatorDepositKey)).to.be.false

      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          tbtcVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
        )

      // Classification is a reveal-time fact, not a live vault-address
      // comparison.
      expect(await bridge.isReservedDeposit(depositKey)).to.be.false
      expect(await bridge.isReservedDeposit(validatorDepositKey)).to.be.false

      await increaseTime(7300)
      const ValidatorFactory = await ethers.getContractFactory(
        "WalletProposalValidator"
      )
      const validator = await ValidatorFactory.deploy(bridge.address)
      expect(
        await validator.validateDepositSweepProposal(
          {
            walletPubKeyHash: reveal.walletPubKeyHash,
            depositsKeys: [
              {
                fundingTxHash: validatorFundingTx.txHash,
                fundingOutputIndex: 0,
              },
            ],
            sweepTxFee: 1500,
            depositsRevealBlocks: [0],
          },
          [
            {
              fundingTx: validatorFundingTx.info,
              blindingFactor: validatorBlindingFactor,
              walletPubKeyHash: reveal.walletPubKeyHash,
              refundPubKeyHash: validatorRefundPubKeyHash,
              refundLocktime: validatorRefundLocktime,
            },
          ]
        )
      ).to.be.true

      // Let the ordinary TBTC vault mint the swept deposit balance.
      const tbtcOwner = await impersonateContract(await tbtc.owner())
      await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.address)

      await bridge
        .connect(spvMaintainer)
        .submitDepositSweepProof(
          data.sweepTx,
          data.sweepProof,
          data.mainUtxo,
          data.vault
        )
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

    context("when the reservation is not active", () => {
      it("should revert", async () => {
        const pendingKey = 778
        await bridge.setReservation(pendingKey, {
          ...(await activeReservation(
            thirdParty.address,
            walletPubKeyHash,
            BigNumber.from(100000000)
          )),
          state: 2, // RedemptionRequested
        })

        const vaultSigner = await impersonateContract(reservationVault.address)
        await expect(
          bridge.connect(vaultSigner).extendReservation(pendingKey)
        ).to.be.revertedWith("Reservation is not active")
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
      await expect(timeoutTx)
        .to.emit(bridge, "ReservedRedemptionTimeoutSlashingSkipped")
        .withArgs(reservationKey, walletPubKeyHash)
      expect(
        (await bridge.reservations(reservationKey)).lastTimeoutWasWalletFault
      ).to.be.false
      expect(walletRegistry.seize).to.not.have.been.called

      expect(await bank.balanceOf(thirdParty.address)).to.equal(amountSat)
      expect((await bridge.reservations(reservationKey)).state).to.equal(1) // Active
    })

    it("slashes the wallet operators on timeout when the wallet is Live", async () => {
      const liveReservationKey = 889
      const liveWalletPubKeyHash = "0xafcdf88d15a0e0c2134dbbc9f6da24d0e26c8f21"
      const walletMembersIDs = [1, 2, 3, 4, 5]

      await bridge.setWallet(liveWalletPubKeyHash, {
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
      await bridge.setActiveWallet(liveWalletPubKeyHash)
      await bridge.setReservation(
        liveReservationKey,
        await activeReservation(
          thirdParty.address,
          liveWalletPubKeyHash,
          amountSat
        )
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
          liveReservationKey,
          thirdParty.address,
          redeemerOutputScript
        )

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)

      const wallet = await bridge.wallets(liveWalletPubKeyHash)
      const tx = await bridge
        .connect(thirdParty)
        .notifyReservedRedemptionTimeout(liveReservationKey, walletMembersIDs)

      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionTimedOut")
        .withArgs(liveReservationKey, liveWalletPubKeyHash)
      expect(walletRegistry.seize).to.have.been.calledOnceWith(
        redemptionTimeoutSlashingAmount,
        redemptionTimeoutNotifierRewardMultiplier,
        await thirdParty.getAddress(),
        wallet.ecdsaWalletID,
        walletMembersIDs
      )

      walletRegistry.seize.reset()
    })

    it("should revert when the redeemer output script points to the wallet public key hash", async () => {
      const vaultSigner = await impersonateContract(reservationVault.address)
      const bridgeSigner = await impersonateContract(bridge.address)

      const guardKey = 890
      await bridge.setReservation(
        guardKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )
      await bank
        .connect(bridgeSigner)
        .increaseBalance(reservationVault.address, amountSat)

      // Wallet public key hash hidden under P2WPKH.
      await expect(
        bridge
          .connect(vaultSigner)
          .requestReservedRedemption(
            guardKey,
            thirdParty.address,
            `0x160014${walletPubKeyHash.substring(2)}`
          )
      ).to.be.revertedWith(
        "Redeemer output script must not point to the wallet PKH"
      )

      // Wallet public key hash hidden under P2PKH.
      await expect(
        bridge
          .connect(vaultSigner)
          .requestReservedRedemption(
            guardKey,
            thirdParty.address,
            `0x1976a914${walletPubKeyHash.substring(2)}88ac`
          )
      ).to.be.revertedWith(
        "Redeemer output script must not point to the wallet PKH"
      )
    })

    it("should revert when the redeemer output script is not a standard type", async () => {
      const vaultSigner = await impersonateContract(reservationVault.address)
      const bridgeSigner = await impersonateContract(bridge.address)

      const guardKey = 891
      await bridge.setReservation(
        guardKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )
      await bank
        .connect(bridgeSigner)
        .increaseBalance(reservationVault.address, amountSat)

      await expect(
        bridge
          .connect(vaultSigner)
          .requestReservedRedemption(
            guardKey,
            thirdParty.address,
            "0x1988a914f4eedc8f40d4b8e30771f792b065ebec0abaddef88ac"
          )
      ).to.be.revertedWith("Redeemer output script must be a standard type")
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

      it("should revert when no depositors are specified", async () => {
        const bridgeSigner = await impersonateContract(bridge.address)
        await expect(
          bank
            .connect(bridgeSigner)
            .increaseBalanceAndCall(reservationVault.address, [], [])
        ).to.be.revertedWith("No depositors specified")
      })

      it("should mint gross TBTC and split the initiation fee across multiple depositors", async () => {
        const bridgeSigner = await impersonateContract(bridge.address)
        const secondDepositor = governance.address
        const firstAmount = amountSat
        const secondAmount = amountSat.mul(3)

        const treasuryBalanceBefore = await tbtc.balanceOf(treasury.address)
        const firstBalanceBefore = await tbtc.balanceOf(thirdParty.address)
        const secondBalanceBefore = await tbtc.balanceOf(secondDepositor)

        await bank
          .connect(bridgeSigner)
          .increaseBalanceAndCall(
            reservationVault.address,
            [thirdParty.address, secondDepositor],
            [firstAmount, secondAmount]
          )

        const firstFee = firstAmount.mul(SATOSHI_MULTIPLIER).mul(40).div(10000)
        const secondFee = secondAmount
          .mul(SATOSHI_MULTIPLIER)
          .mul(40)
          .div(10000)

        expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
          firstBalanceBefore.add(
            firstAmount.mul(SATOSHI_MULTIPLIER).sub(firstFee)
          )
        )
        expect(await tbtc.balanceOf(secondDepositor)).to.equal(
          secondBalanceBefore.add(
            secondAmount.mul(SATOSHI_MULTIPLIER).sub(secondFee)
          )
        )
        expect(await tbtc.balanceOf(treasury.address)).to.equal(
          treasuryBalanceBefore.add(firstFee).add(secondFee)
        )
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
        await expect(tx).to.emit(bridge, "ReservedRedemptionRequested")

        expect(await tbtc.balanceOf(treasury.address)).to.equal(
          treasuryBalanceBefore.add(fee)
        )
        expect((await bridge.reservations(reservationKey)).state).to.equal(2)
        expect(await bank.balanceOf(bridge.address)).to.equal(amountSat)
      })

      it("should reject a stale fee quote after governance update and accept the exact bound", async () => {
        const exposedReservationKey = 998
        const quotedFee = grossTbtc.mul(20).div(10000)
        const updatedFee = grossTbtc.mul(500).div(10000)

        await bridge.setReservation(
          exposedReservationKey,
          await activeReservation(
            thirdParty.address,
            walletPubKeyHash,
            amountSat
          )
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

        await reservationVault.connect(deployer).updateFees(40, 20, 500)

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
          (await bridge.reservations(exposedReservationKey)).state
        ).to.equal(1)

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
          (await bridge.reservations(exposedReservationKey)).state
        ).to.equal(2)

        await reservationVault.connect(deployer).updateFees(40, 20, 20)
      })
    })

    describe("extendCustody", () => {
      const reservationKey = 997
      const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"

      before(async () => {
        await bridge.setReservation(
          reservationKey,
          await activeReservation(
            thirdParty.address,
            walletPubKeyHash,
            amountSat
          )
        )

        // Fund the owner with TBTC for the extension fee via an
        // acceptance-sized credit.
        const bridgeSigner = await impersonateContract(bridge.address)
        await bank
          .connect(bridgeSigner)
          .increaseBalanceAndCall(
            reservationVault.address,
            [thirdParty.address],
            [amountSat]
          )
        await tbtc
          .connect(thirdParty)
          .approve(reservationVault.address, ethers.constants.MaxUint256)
      })

      it("should revert when the fee exceeds the caller's bound", async () => {
        const fee = grossTbtc.mul(20).div(10000)
        await expect(
          reservationVault
            .connect(thirdParty)
            .extendCustody(reservationKey, fee.sub(1))
        ).to.be.revertedWith("Fee exceeds the caller's bound")
      })

      it("should transfer the extension fee to the treasury and advance expiresAt through the real vault path", async () => {
        const fee = grossTbtc.mul(20).div(10000) // 20 bps extensionFeeBps
        const treasuryBalanceBefore = await tbtc.balanceOf(treasury.address)
        const ownerBalanceBefore = await tbtc.balanceOf(thirdParty.address)
        const expiresAtBefore = (await bridge.reservations(reservationKey))
          .expiresAt

        const tx = await reservationVault
          .connect(thirdParty)
          .extendCustody(reservationKey, fee)

        await expect(tx)
          .to.emit(reservationVault, "CustodyExtended")
          .withArgs(reservationKey, thirdParty.address, fee)

        expect(await tbtc.balanceOf(treasury.address)).to.equal(
          treasuryBalanceBefore.add(fee)
        )
        expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
          ownerBalanceBefore.sub(fee)
        )
        expect((await bridge.reservations(reservationKey)).expiresAt).to.equal(
          expiresAtBefore + RESERVATION_TERM
        )
      })
    })

    describe("updateFees", () => {
      it("should revert when a fee parameter exceeds the maximum", async () => {
        await expect(
          reservationVault.connect(deployer).updateFees(501, 20, 20)
        ).to.be.revertedWith("Fee exceeds the maximum")
        await expect(
          reservationVault.connect(deployer).updateFees(40, 501, 20)
        ).to.be.revertedWith("Fee exceeds the maximum")
        await expect(
          reservationVault.connect(deployer).updateFees(40, 20, 501)
        ).to.be.revertedWith("Fee exceeds the maximum")
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
      await bridge.setReservation(reservationKey, {
        ...(await activeReservation(
          thirdParty.address,
          walletPubKeyHash,
          amountSat
        )),
        lastTimeoutWasWalletFault: true,
      })

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

    it("reverts when the previous request did not time out through wallet fault", async () => {
      const otherReservationKey = 445
      await bridge.setReservation(otherReservationKey, {
        ...(await activeReservation(
          thirdParty.address,
          walletPubKeyHash,
          amountSat
        )),
        lastTimeoutWasWalletFault: false,
      })

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
          .retryRedeemReservation(otherReservationKey, redeemerOutputScript)
      ).to.be.revertedWith(
        "Previous request did not time out through wallet fault"
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
      const beginTx = await bridgeGovernance
        .connect(governance)
        .beginReservationParametersUpdate(
          reservationVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
        )

      const beginReceipt = await beginTx.wait()
      const beginBlock = await ethers.provider.getBlock(
        beginReceipt.blockNumber
      )

      await expect(beginTx)
        .to.emit(bridgeGovernance, "ReservationParametersUpdateStarted")
        .withArgs(
          reservationVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE,
          beginBlock.timestamp
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
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
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
      const { redemptionRequestedAt } = await bridge.reservations(
        reservationKey
      )
      const vetoKey = ethers.utils.solidityKeccak256(
        ["uint256", "uint32"],
        [reservationKey, redemptionRequestedAt]
      )

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
        .withArgs(vetoKey)
      await expect(tx)
        .to.emit(bridge, "ReservedRedemptionVetoed")
        .withArgs(reservationKey)
      await expect(tx)
        .to.emit(redemptionWatchtower, "Banned")
        .withArgs(thirdParty.address)

      // The reservation survives the veto as Active.
      expect((await bridge.reservations(reservationKey)).state).to.equal(1)

      // Default penalty is 100%: the whole detained amount is burned.
      const veto = await redemptionWatchtower.vetoProposals(vetoKey)
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

    it("should revert when the reserved redemption does not exist", async () => {
      const freshKey = 667
      await bridge.setReservation(
        freshKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      await expect(
        redemptionWatchtower
          .connect(guardianSigners[0])
          .raiseReservedObjection(freshKey)
      ).to.be.revertedWith("Reserved redemption does not exist")
    })

    it("should revert when a guardian already objected", async () => {
      const freshKey = 668
      // thirdParty was banned by the earlier veto test above; use a
      // different, unbanned owner/redeemer for this reservation.
      await bridge.setReservation(
        freshKey,
        await activeReservation(governance.address, walletPubKeyHash, amountSat)
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
          freshKey,
          governance.address,
          redeemerOutputScript
        )

      await redemptionWatchtower
        .connect(guardianSigners[0])
        .raiseReservedObjection(freshKey)

      await expect(
        redemptionWatchtower
          .connect(guardianSigners[0])
          .raiseReservedObjection(freshKey)
      ).to.be.revertedWith("Guardian already objected")
    })

    it("should emit VetoPeriodCheckOmitted for a redemption requested before the watchtower was enabled", async () => {
      const freshKey = 669
      const grandfatheredRequestedAt = 1 // long before watchtowerEnabledAt

      await bridge.setReservation(freshKey, {
        ...(await activeReservation(
          thirdParty.address,
          walletPubKeyHash,
          amountSat
        )),
        state: 2, // RedemptionRequested
        redeemer: thirdParty.address,
        redeemerOutputScriptHash: ethers.utils.keccak256(redeemerOutputScript),
        redemptionRequestedAt: grandfatheredRequestedAt,
        redemptionTxMaxFee: RESERVATION_TX_MAX_FEE,
      })

      const vetoKey = ethers.utils.solidityKeccak256(
        ["uint256", "uint32"],
        [freshKey, grandfatheredRequestedAt]
      )

      await expect(
        redemptionWatchtower
          .connect(guardianSigners[0])
          .raiseReservedObjection(freshKey)
      )
        .to.emit(redemptionWatchtower, "VetoPeriodCheckOmitted")
        .withArgs(vetoKey)
    })

    it("lets a new request generation start clean after an earlier generation is resolved", async () => {
      const freshKey = 670
      const owner = governance.address

      await bridge.setReservation(
        freshKey,
        await activeReservation(owner, walletPubKeyHash, amountSat)
      )

      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalance(reservationVault.address, amountSat)
      const vaultSigner = await impersonateContract(reservationVault.address)
      await bank.connect(vaultSigner).approveBalance(bridge.address, amountSat)
      await bridge
        .connect(vaultSigner)
        .requestReservedRedemption(freshKey, owner, redeemerOutputScript)

      // First generation: one guardian objects, below the 3-objection
      // veto threshold, then the request times out without being
      // vetoed.
      await redemptionWatchtower
        .connect(guardianSigners[0])
        .raiseReservedObjection(freshKey)

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservedRedemptionTimeout(freshKey, [])

      expect((await bridge.reservations(freshKey)).state).to.equal(1) // Active

      // Second generation: re-request. The guardian who objected against
      // generation 1 must be able to object again, and the new
      // generation must start with zero objections -- a stale
      // `objectionsCount` from the resolved generation 1 must not carry
      // over and bias or block generation 2.
      await bank
        .connect(bridgeSigner)
        .increaseBalance(reservationVault.address, amountSat)
      await bank.connect(vaultSigner).approveBalance(bridge.address, amountSat)
      await bridge
        .connect(vaultSigner)
        .requestReservedRedemption(freshKey, owner, redeemerOutputScript)

      const { redemptionRequestedAt } = await bridge.reservations(freshKey)
      const secondGenVetoKey = ethers.utils.solidityKeccak256(
        ["uint256", "uint32"],
        [freshKey, redemptionRequestedAt]
      )
      expect(
        (await redemptionWatchtower.vetoProposals(secondGenVetoKey))
          .objectionsCount
      ).to.equal(0)

      await expect(
        redemptionWatchtower
          .connect(guardianSigners[0])
          .raiseReservedObjection(freshKey)
      )
        .to.emit(redemptionWatchtower, "ObjectionRaised")
        .withArgs(secondGenVetoKey, guardianSigners[0].address)
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

    it("enforces the dissolution-specific fee cap, not the reservation tx max fee", async () => {
      // Regression test: validateReservationDissolutionProposal must check
      // proposal.dissolutionTxFee against reservationDissolutionTxMaxFee,
      // not reservationTxMaxFee. Configure the two caps to differ so a fee
      // that would pass the wrong cap is caught by the right one.
      const reservationKey = 54321
      await bridge.setReservation(
        reservationKey,
        await activeReservation(thirdParty.address, walletPubKeyHash, amountSat)
      )

      await bridge.connect(bridgeGovernanceSigner).updateReservationParameters(
        reservationVault.address,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        500, // reservationDissolutionTxMaxFee, deliberately below RESERVATION_TX_MAX_FEE
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET,
        MAX_CUMULATIVE_REANCHOR_FEE
      )

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      // Within RESERVATION_TX_MAX_FEE (2000) but above the dissolution cap
      // (500): must revert if the fee is checked against the right cap.
      await expect(
        validator.validateReservationDissolutionProposal({
          walletPubKeyHash,
          reservationKey,
          dissolutionTxFee: 1000,
        })
      ).to.be.revertedWith("Proposed transaction fee is too high")

      // Exactly at the dissolution cap: must be accepted.
      expect(
        await validator.validateReservationDissolutionProposal({
          walletPubKeyHash,
          reservationKey,
          dissolutionTxFee: 500,
        })
      ).to.be.true
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

      expect(await bridge.isReservedDeposit(reservationKey)).to.be.true

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

    it("does not accept an ordinary deposit after its vault becomes the reservation vault", async () => {
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
        vault: tbtcVault.address,
      })

      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          tbtcVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
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
            0
          )
      ).to.be.revertedWith("Deposit was not revealed as reserved")
    })

    it("accepts a pre-swap reserved deposit after the vault changes, crediting the current vault", async () => {
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

      // Revealed while `reservationVault` is still the reservation vault:
      // classified as reserved at reveal time.
      await bridge.connect(thirdParty).revealDeposit(fundingTx.info, {
        fundingOutputIndex: 0,
        blindingFactor,
        walletPubKeyHash,
        refundPubKeyHash,
        refundLocktime,
        vault: reservationVault.address,
      })

      const reservationKey = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
      expect(await bridge.isReservedDeposit(reservationKey)).to.be.true

      // Governance repurposes the reservation vault before the anchor is
      // proven. The reveal-time classification survives unchanged.
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          tbtcVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
        )
      expect(await bridge.isReservedDeposit(reservationKey)).to.be.true

      const anchorTx = buildTx(
        [{ txHash: fundingTx.txHash, index: 0 }],
        [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
      )

      const supplyBefore = await tbtc.totalSupply()
      await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Acceptance,
          anchorTx.info,
          proofFor(anchorTx.txHash),
          NO_MAIN_UTXO_PARAM,
          0
        )

      // Accepted despite the vault swap: the reservation record exists,
      // which only the reservation path (not an ordinary sweep) creates.
      expect((await bridge.reservations(reservationKey)).state).to.equal(1) // Active

      // The credit routed through the *current* vault (`tbtcVault`, a
      // 1:1 ordinary mint with no reservation-vault initiation fee
      // split), not the vault configured at reveal time.
      expect(await tbtc.totalSupply()).to.equal(
        supplyBefore.add(anchorAmount.mul(SATOSHI_MULTIPLIER))
      )
      expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
        anchorAmount.mul(SATOSHI_MULTIPLIER)
      )
    })

    it("rejects an anchor paying an excessive miner fee", async () => {
      await expect(
        makeAcceptedReservation(depositAmount.sub(RESERVATION_TX_MAX_FEE + 1))
      ).to.be.revertedWith("Transaction fee is too high")
    })

    it("rejects an acceptance proof when reservations are disabled", async () => {
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          ZERO_ADDRESS,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
        )

      await expect(makeAcceptedReservation()).to.be.revertedWith(
        "Reservations are disabled"
      )
    })

    it("rejects an anchor below the reservation minimum amount", async () => {
      await expect(
        makeAcceptedReservation(BigNumber.from(RESERVATION_MIN_AMOUNT - 1))
      ).to.be.revertedWith("Reservation amount too small")
    })

    it("rejects an acceptance that would exceed the total reserved amount cap", async () => {
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          reservationVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          anchorAmount.sub(1),
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
        )

      await expect(makeAcceptedReservation()).to.be.revertedWith(
        "Total reserved amount cap exceeded"
      )
    })

    it("rejects an acceptance that would exceed the per-wallet reservations cap", async () => {
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          reservationVault.address,
          RESERVATION_MIN_AMOUNT,
          RESERVATION_TX_MAX_FEE,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          1,
          MAX_CUMULATIVE_REANCHOR_FEE
        )

      await makeAcceptedReservation()
      await expect(makeAcceptedReservation()).to.be.revertedWith(
        "Wallet reservations cap exceeded"
      )
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
        .redeemReservation(reservationKey, redeemerScript, redemptionFee)
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

    it("acknowledges a late redemption proof for a reservation that already timed out", async () => {
      // The wallet may have already broadcast the redemption transaction
      // before the redeemer noticed the timeout. Once
      // `notifyReservedRedemptionTimeout` records the terminal settlement
      // and refunds the redeemer, the SPV proof for that exact anchor
      // spend must still be acknowledgeable -- and must not move any
      // further balance or allow the outpoint to be reused.
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation() // funds the owner with extra TBTC

      const redeemerScript = `0x16${p2wpkhScript(
        ethers.utils.hexlify(ethers.utils.randomBytes(20))
      )}`
      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, redeemerScript, redemptionFee)

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)

      const redeemerBalanceBeforeTimeout = await bank.balanceOf(
        thirdParty.address
      )
      await bridge
        .connect(thirdParty)
        .notifyReservedRedemptionTimeout(reservationKey, [1, 2, 3, 4, 5])
      walletRegistry.seize.reset()

      // The gross amount was refunded as Bank balance on timeout.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        redeemerBalanceBeforeTimeout.add(anchorAmount)
      )
      expect((await bridge.reservations(reservationKey)).state).to.equal(1) // Active

      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const bankBalanceBeforeProof = await bank.balanceOf(thirdParty.address)
      const supplyBeforeProof = await tbtc.totalSupply()

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
        .to.emit(bridge, "ReservedRedemptionSettled")
        .withArgs(reservationKey, redemptionTx.txHash)

      // No further balance movement: the redeemer was already made whole
      // by the timeout refund above, and the reservation stays Active.
      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        bankBalanceBeforeProof
      )
      expect(await tbtc.totalSupply()).to.equal(supplyBeforeProof)
      expect((await bridge.reservations(reservationKey)).state).to.equal(3) // Closed

      // The settlement record is consumed and the reservation is now
      // Closed: a repeat submission of the same proof cannot reuse the
      // anchor outpoint.
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Redemption,
            redemptionTx.info,
            proofFor(redemptionTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey
          )
      ).to.be.revertedWith("No settled reserved redemption")
    })

    it("rejects a late redemption proof pointing at the wrong settled outpoint", async () => {
      const { reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation() // funds the owner with extra TBTC

      const redeemerScript = `0x16${p2wpkhScript(
        ethers.utils.hexlify(ethers.utils.randomBytes(20))
      )}`
      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, redeemerScript, redemptionFee)

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservedRedemptionTimeout(reservationKey, [1, 2, 3, 4, 5])
      walletRegistry.seize.reset()

      // A proof whose input spends a different outpoint than the one
      // recorded in the settlement must not be acknowledged.
      const wrongOutpointTx = buildTx(
        [
          {
            txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
            index: 0,
          },
        ],
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
            wrongOutpointTx.info,
            proofFor(wrongOutpointTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey
          )
      ).to.be.revertedWith("Wrong settled anchor outpoint")
    })

    it("rejects a late redemption proof once the reservation has been re-anchored since settlement", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation() // funds the owner with extra TBTC
      await liveWallet(secondWalletPubKeyHash)

      const redeemerScript = `0x16${p2wpkhScript(
        ethers.utils.hexlify(ethers.utils.randomBytes(20))
      )}`
      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, redeemerScript, redemptionFee)

      const { redemptionTimeout } = await bridge.redemptionParameters()
      await increaseTime(redemptionTimeout + 1)
      await bridge
        .connect(thirdParty)
        .notifyReservedRedemptionTimeout(reservationKey, [1, 2, 3, 4, 5])
      walletRegistry.seize.reset()

      // The reservation returns to Active on timeout and is legitimately
      // re-anchored to a fresh outpoint before the settled anchor's late
      // proof ever arrives.
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(anchorFee),
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
          reservationKey
        )

      // A late proof against the now-superseded settled anchor must not
      // be able to force-close a reservation that has since moved on to
      // a live, unsettled anchor.
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
            reservationKey
          )
      ).to.be.revertedWith(
        "Reservation anchor no longer matches the settlement"
      )

      expect((await bridge.reservations(reservationKey)).state).to.equal(1) // Active
      expect((await bridge.reservations(reservationKey)).anchorTxHash).to.equal(
        reanchorTx.txHash
      )
    })

    it("acknowledges a late redemption proof for a reservation that was vetoed", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await makeAcceptedReservation() // funds the owner with extra TBTC

      const redeemerScript = `0x16${p2wpkhScript(
        ethers.utils.hexlify(ethers.utils.randomBytes(20))
      )}`
      const redemptionFee = grossTbtc.mul(20).div(10000)
      await tbtc
        .connect(thirdParty)
        .approve(reservationVault.address, grossTbtc.add(redemptionFee))
      await reservationVault
        .connect(thirdParty)
        .redeemReservation(reservationKey, redeemerScript, redemptionFee)

      // Treat `deployer` as the redemption watchtower, mirroring the
      // dedicated `notifyReservedRedemptionVeto` unit tests.
      await bridge
        .connect(bridgeGovernanceSigner)
        .setRedemptionWatchtower(deployer.address)
      await bridge
        .connect(deployer)
        .notifyReservedRedemptionVeto(reservationKey)

      expect((await bridge.reservations(reservationKey)).state).to.equal(1) // Active

      const redemptionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(1000),
            script: redeemerScript.slice(4),
          },
        ]
      )

      const supplyBeforeProof = await tbtc.totalSupply()

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
        .to.emit(bridge, "ReservedRedemptionSettled")
        .withArgs(reservationKey, redemptionTx.txHash)

      expect(await tbtc.totalSupply()).to.equal(supplyBeforeProof)
      expect((await bridge.reservations(reservationKey)).state).to.equal(3) // Closed
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
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
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
        .redeemReservation(reservationKey, redeemerScript, redemptionFee)

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

    it("rejects a re-anchor paying an excessive fee", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await liveWallet(secondWalletPubKeyHash)

      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(RESERVATION_TX_MAX_FEE + 1),
            script: p2wpkhScript(secondWalletPubKeyHash),
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
            reservationKey
          )
      ).to.be.revertedWith("Transaction fee is too high")
    })

    it("rejects a re-anchor landing at or below the dust floor", async () => {
      // Lower the governance parameters so a single hop can carry an
      // above-minimum anchor down to at-or-below the dust floor while
      // staying within the per-transaction fee bound (minAmount must
      // stay above txMaxFee by construction, so minAmount <= 2*txMaxFee
      // is required to reach the floor in one hop). Build a small custom
      // deposit/anchor pair instead of `makeAcceptedReservation`, whose
      // fixed deposit size would blow the lowered fee bound.
      await bridge
        .connect(bridgeGovernanceSigner)
        .updateReservationParameters(
          reservationVault.address,
          150,
          100,
          RESERVATION_DISSOLUTION_TX_MAX_FEE,
          RESERVATION_TERM,
          RESERVATION_GRACE,
          RESERVATION_MAX_TOTAL,
          MAX_RESERVATIONS_PER_WALLET,
          MAX_CUMULATIVE_REANCHOR_FEE
        )
      await bridge.setDepositDustThreshold(50)

      const fundingTx = buildTx(
        [
          {
            txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
            index: 0,
          },
        ],
        [
          {
            valueSat: 200, // 150 anchor + 50 acceptance-time fee
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
        [{ valueSat: 150, script: p2wpkhScript(walletPubKeyHash) }]
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

      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [{ valueSat: 100, script: p2wpkhScript(secondWalletPubKeyHash) }]
      )

      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Reanchor,
            reanchorTx.info,
            proofFor(reanchorTx.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey
          )
      ).to.be.revertedWith("Re-anchor amount below the dust floor")
    })

    it("rejects a re-anchor once the cumulative fee budget is exceeded", async () => {
      // Lower the cumulative budget so two ordinary-fee re-anchor hops
      // exceed it on the second hop.
      await bridge.connect(bridgeGovernanceSigner).updateReservationParameters(
        reservationVault.address,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_DISSOLUTION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET,
        anchorFee // budget == exactly one hop's fee
      )

      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await liveWallet(secondWalletPubKeyHash)

      const firstHop = anchorAmount.sub(anchorFee)
      const reanchorTx1 = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: firstHop,
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )
      const tx1 = await bridge
        .connect(spvMaintainer)
        .submitReservationProof(
          ProofType.Reanchor,
          reanchorTx1.info,
          proofFor(reanchorTx1.txHash),
          NO_MAIN_UTXO_PARAM,
          reservationKey
        )
      await expect(tx1).to.emit(bridge, "ReservationReanchored")
      expect(
        (await bridge.reservations(reservationKey)).cumulativeReanchorFee
      ).to.equal(anchorFee)

      // Second hop: any positive fee now exceeds the exhausted budget.
      const reanchorTx2 = buildTx(
        [{ txHash: reanchorTx1.txHash, index: 0 }],
        [
          {
            valueSat: firstHop.sub(1),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )
      await expect(
        bridge
          .connect(spvMaintainer)
          .submitReservationProof(
            ProofType.Reanchor,
            reanchorTx2.info,
            proofFor(reanchorTx2.txHash),
            NO_MAIN_UTXO_PARAM,
            reservationKey
          )
      ).to.be.revertedWith("Cumulative re-anchor fee budget exceeded")
    })

    it("rejects a dissolution output that does not pay the custodying wallet", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      const dissolutionFee = 500
      const dissolutionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(dissolutionFee),
            // Pays a different wallet than the custodying one.
            script: p2wpkhScript(secondWalletPubKeyHash),
          },
        ]
      )

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
      ).to.be.revertedWith(
        "Dissolution output must pay to the custodying wallet"
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

    it("dissolves a re-anchored reservation without burning unrelated Bank balance", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()
      await liveWallet(secondWalletPubKeyHash)

      // Re-anchor once, incurring a miner fee: `anchorAmount` shrinks
      // below `mintedAmount`.
      const reanchoredAmount = anchorAmount.sub(anchorFee)
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: reanchoredAmount,
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
          reservationKey
        )

      const reservationBefore = await bridge.reservations(reservationKey)
      expect(reservationBefore.mintedAmount).to.equal(anchorAmount)
      expect(reservationBefore.anchorAmount).to.equal(reanchoredAmount)

      // A second, unrelated reservation's escrow, held by the Bridge as
      // an ordinary Bank balance, must survive dissolution untouched --
      // mirroring the balance shape the Bridge actually holds while a
      // pooled or reserved redemption is in flight.
      const unrelatedBalance = BigNumber.from(500000)
      const bridgeSigner = await impersonateContract(bridge.address)
      await bank
        .connect(bridgeSigner)
        .increaseBalance(bridge.address, unrelatedBalance)

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      const dissolutionFee = 200
      const dissolutionTx = buildTx(
        [{ txHash: reanchorTx.txHash, index: 0 }],
        [
          {
            valueSat: reanchoredAmount.sub(dissolutionFee),
            script: p2wpkhScript(secondWalletPubKeyHash),
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
          reservationKey
        )

      await expect(tx).to.emit(bridge, "ReservationDissolved")

      expect((await bridge.reservations(reservationKey)).state).to.equal(3) // Closed

      // No Bank balance was burned: the unrelated escrow survives
      // untouched.
      expect(await bank.balanceOf(bridge.address)).to.equal(unrelatedBalance)

      // The dissolution output carries forward exactly the shrunk
      // `anchorAmount`, not the original gross `mintedAmount`.
      const wallet = await bridge.wallets(secondWalletPubKeyHash)
      expect(wallet.mainUtxoHash).to.equal(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32", "uint64"],
          [dissolutionTx.txHash, 0, reanchoredAmount.sub(dissolutionFee)]
        )
      )
    })

    it("dissolves into an existing main UTXO and reports the fee-loss decomposition", async () => {
      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      // Re-anchor once so `anchorAmount` falls below `mintedAmount`: that
      // gap is the in-kind loss the event has to report.
      const reanchorFee = 800
      const reanchoredAmount = anchorAmount.sub(reanchorFee)
      const reanchorTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: reanchoredAmount,
            script: p2wpkhScript(walletPubKeyHash),
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
          reservationKey
        )

      // Give the custodying wallet a main UTXO so the dissolution takes
      // the dominant 2-in-1-out shape. Every other test in this suite
      // dissolves 1-in-1-out, where the anchor value and the combined
      // input total coincide and cannot be told apart.
      const mainUtxoTxHash = ethers.utils.hexlify(ethers.utils.randomBytes(32))
      const mainUtxoValue = BigNumber.from(1000000)
      await bridge.setWallet(walletPubKeyHash, {
        ecdsaWalletID: ethers.utils.randomBytes(32),
        mainUtxoHash: ethers.utils.solidityKeccak256(
          ["bytes32", "uint32", "uint64"],
          [mainUtxoTxHash, 0, mainUtxoValue]
        ),
        pendingRedemptionsValue: 0,
        createdAt: await lastBlockTime(),
        movingFundsRequestedAt: 0,
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.Live,
        movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
      })

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      const dissolutionFee = 600
      const dissolutionTx = buildTx(
        [
          { txHash: reanchorTx.txHash, index: 0 },
          { txHash: mainUtxoTxHash, index: 0 },
        ],
        [
          {
            valueSat: reanchoredAmount.add(mainUtxoValue).sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )

      const tx = await bridge.connect(spvMaintainer).submitReservationProof(
        ProofType.Dissolution,
        dissolutionTx.info,
        proofFor(dissolutionTx.txHash),
        {
          txHash: mainUtxoTxHash,
          txOutputIndex: 0,
          txOutputValue: mainUtxoValue,
        },
        reservationKey
      )

      // The event must report the anchor's own value, not the combined
      // input total: the unreconciled shortfall is
      // `mintedAmount - anchorAmount + dissolutionFee`, here
      // `reanchorFee + dissolutionFee`.
      await expect(tx)
        .to.emit(bridge, "ReservationDissolved")
        .withArgs(
          reservationKey,
          walletPubKeyHash,
          dissolutionTx.txHash,
          anchorAmount,
          reanchoredAmount,
          dissolutionFee
        )

      expect((await bridge.reservations(reservationKey)).state).to.equal(3) // Closed

      // The single output became the wallet's new main UTXO.
      const wallet = await bridge.wallets(walletPubKeyHash)
      expect(wallet.mainUtxoHash).to.equal(
        ethers.utils.solidityKeccak256(
          ["bytes32", "uint32", "uint64"],
          [
            dissolutionTx.txHash,
            0,
            reanchoredAmount.add(mainUtxoValue).sub(dissolutionFee),
          ]
        )
      )
    })

    it("enforces the dissolution-specific fee cap on the proven transaction", async () => {
      // Sanity: the two caps must differ or this test cannot discriminate
      // which one the proof path checks against.
      expect(RESERVATION_DISSOLUTION_TX_MAX_FEE).to.be.lessThan(
        RESERVATION_TX_MAX_FEE
      )

      const { anchorTx, reservationKey } = await makeAcceptedReservation()

      await increaseTime(RESERVATION_TERM + RESERVATION_GRACE + 60)

      // Above `reservationDissolutionTxMaxFee` but still within the shared
      // `reservationTxMaxFee`: this reverts only if the proven fee is
      // checked against the dissolution-specific cap.
      const dissolutionFee = RESERVATION_DISSOLUTION_TX_MAX_FEE + 1
      const dissolutionTx = buildTx(
        [{ txHash: anchorTx.txHash, index: 0 }],
        [
          {
            valueSat: anchorAmount.sub(dissolutionFee),
            script: p2wpkhScript(walletPubKeyHash),
          },
        ]
      )

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
      ).to.be.revertedWith("Transaction fee is too high")
    })
  })
})
