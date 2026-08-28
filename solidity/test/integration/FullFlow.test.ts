/* eslint-disable no-await-in-loop */
/* eslint-disable @typescript-eslint/no-extra-semi */
import hre, { ethers, helpers, waffle } from "hardhat"
import type { BigNumberish } from "ethers"
import { utils } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import type { Mock } from "../helpers/mock"
import type {
  TBTC,
  Bridge,
  Bank,
  TBTCVault,
  IRelay,
  IRandomBeacon,
  WalletRegistry,
  BridgeGovernance,
} from "../../typechain"
import {
  performEcdsaDkg,
  updateWalletRegistryDkgResultChallengePeriodLength,
} from "./utils/ecdsa-wallet-registry"
import { produceRelayEntry } from "./utils/fake-random-beacon"
import { UTXOStruct } from "../../typechain/Bridge"
import {
  walletPublicKey,
  walletPubKeyHash,
  revealDepositData,
  depositSweepData,
  redemptionData,
} from "./data/integration"
import { fixture } from "./utils/fixture"
import { constants } from "../fixtures"
import { loadFixture } from "../helpers/fixture"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime } = helpers.time
const { impersonateAccount } = helpers.account

const describeFn =
  process.env.NODE_ENV === "integration-test" ? describe : describe.skip

describeFn("Integration Test - Full flow", async () => {
  let tbtc: TBTC
  let bridge: Bridge
  let bridgeGovernance: BridgeGovernance
  let bank: Bank
  let tbtcVault: TBTCVault
  let walletRegistry: WalletRegistry
  let randomBeacon: Mock<IRandomBeacon>
  let relay: Mock<IRelay>
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress

  const dkgResultChallengePeriodLength = 10

  before(async () => {
    ;({
      deployer,
      governance,
      spvMaintainer,
      tbtc,
      bridge,
      bank,
      tbtcVault,
      walletRegistry,
      relay,
      randomBeacon,
      bridgeGovernance,
    } = await loadFixture(fixture))
    // Update only the parameters that are crucial for this test.
    await updateWalletRegistryDkgResultChallengePeriodLength(
      hre,
      walletRegistry,
      governance,
      dkgResultChallengePeriodLength
    )

    // Disable the reveal ahead period since refund locktimes are fixed
    // within transactions used in this test suite.
    await bridgeGovernance
      .connect(governance)
      .beginDepositRevealAheadPeriodUpdate(0)
    await increaseTime(constants.governanceDelay)
    await bridgeGovernance
      .connect(governance)
      .finalizeDepositRevealAheadPeriodUpdate()
  })

  describe("Check deposit and redemption flow", async () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    describe("when wallet is created", async () => {
      before(async () => {
        // Use `NO_MAIN_UTXO` when requesting the new wallet since it's the
        //  very first wallet
        const NO_MAIN_UTXO: UTXOStruct = {
          txHash:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          txOutputIndex: 0,
          txOutputValue: 0,
        }
        const requestNewWalletTx = await bridge.requestNewWallet(NO_MAIN_UTXO)

        await produceRelayEntry(walletRegistry, randomBeacon)
        await performEcdsaDkg(
          hre,
          walletRegistry,
          walletPublicKey,
          requestNewWalletTx.blockNumber
        )
      })

      describe("when a deposit is revealed", async () => {
        before(async () => {
          revealDepositData.reveal.vault = tbtcVault.address

          // We use a deposit funding bitcoin transaction with a very low amount,
          // so we need to update the dust and redemption thresholds to be below it.
          // TX max fees need to be adjusted as well given that they need to
          // be lower than dust thresholds.

          // 0.001 BTC, 0.0001 BTC
          await updateDepositDustThresholdAndTxMaxFee(100_000, 10_000)
          // 0.0005 BTC, 0.0001 BTC
          await updateRedemptionParameters(50_000, 10_000, 5_000)

          const depositor = await impersonateAccount(
            revealDepositData.depositor,
            {
              from: governance,
              value: 10,
            }
          )

          await bridge
            .connect(depositor)
            .revealDeposit(
              revealDepositData.fundingTx,
              revealDepositData.reveal
            )
        })

        it("should create a deposit", async () => {
          // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
          // Use the deposit transaction hash as little endian and the transaction
          // output index.
          const depositKey = ethers.utils.solidityKeccak256(
            ["bytes32", "uint32"],
            [
              "0x6fc25b8ebd5fcfdf6de60c39dbaa46cfb0d0e792c671edac4112cabb11fb72c8",
              0,
            ]
          )
          const deposit = await bridge.deposits(depositKey)

          expect(deposit.revealedAt).to.be.greaterThan(0)
          expect(deposit.depositor).to.be.equal(revealDepositData.depositor)
          expect(deposit.amount).to.be.equal(100000)
        })
      })

      describe("when the deposit sweep proof is submitted", async () => {
        before(async () => {
          await relay.getCurrentEpochDifficulty.returns(
            depositSweepData.chainDifficulty
          )
          await relay.getPrevEpochDifficulty.returns(
            depositSweepData.chainDifficulty
          )

          await bridge
            .connect(spvMaintainer)
            .submitDepositSweepProof(
              depositSweepData.sweepTx,
              depositSweepData.sweepProof,
              depositSweepData.mainUtxo,
              tbtcVault.address
            )
        })

        it("should mint TBTC tokens for the depositor", async () => {
          // Expect the depositor TBTC balance to be:
          // deposited amount - tx fee - treasury fee = 100000 - 1600 - 50
          expect(await tbtc.balanceOf(revealDepositData.depositor)).to.be.equal(
            98350 * constants.satoshiMultiplier
          )
        })

        it("should increase the balance of vault in the bank", async () => {
          // Expect the vault balance in the bank to be:
          // deposited amount - tx fee - treasury fee = 100000 - 1600 - 50
          expect(await bank.balanceOf(tbtcVault.address)).to.be.equal(98350)
        })

        it("should update the main UTXO of the wallet", async () => {
          const expectedMainUtxo = ethers.utils.solidityKeccak256(
            ["bytes32", "uint32", "uint64"],
            [depositSweepData.sweepTx.hash, 0, 98400]
          )
          const { mainUtxoHash } = await bridge.wallets(walletPubKeyHash)
          expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
        })
      })

      describe("when a redemption is requested", async () => {
        const redeemerOutputScript =
          "0x17a91486884e6be1525dab5ae0b451bd2c72cee67dcf4187"

        const redemptionBalance = 50000 // [sat] as represented in the Bank
        const redemptionAmount = redemptionBalance * constants.satoshiMultiplier // [1e18]

        before(async () => {
          // Request redemption
          const redeemer = await helpers.account.impersonateAccount(
            revealDepositData.depositor,
            { from: deployer, value: 10 }
          )

          const newMainUtxo: UTXOStruct = {
            txHash: depositSweepData.sweepTx.hash,
            txOutputIndex: 0,
            txOutputValue: 98400,
          }

          // Request redemption via TBTC Vault.
          await tbtc
            .connect(redeemer)
            .approveAndCall(
              tbtcVault.address,
              redemptionAmount,
              ethers.utils.defaultAbiCoder.encode(
                ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
                [
                  redeemer.address,
                  walletPubKeyHash,
                  newMainUtxo.txHash,
                  newMainUtxo.txOutputIndex,
                  newMainUtxo.txOutputValue,
                  redeemerOutputScript,
                ]
              )
            )
        })

        it("should create a pending redemption request", async () => {
          const redemptionKey = utils.solidityKeccak256(
            ["bytes32", "bytes20"],
            [
              utils.solidityKeccak256(["bytes"], [redeemerOutputScript]),
              walletPubKeyHash,
            ]
          )
          const pendingRedemption = await bridge.pendingRedemptions(
            redemptionKey
          )

          expect(pendingRedemption.requestedAt).to.be.greaterThan(0)
          expect(pendingRedemption.redeemer).to.be.equal(
            revealDepositData.depositor
          )
          expect(pendingRedemption.requestedAmount).to.be.equal(
            redemptionBalance
          )
        })

        it("should increase the pending redemptions value of the wallet", async () => {
          const { pendingRedemptionsValue } = await bridge.wallets(
            walletPubKeyHash
          )
          // The expected wallet's pending redemptions value is equal to
          // the redemption amount - treasury fee = 50000 - 25 = 49975
          expect(pendingRedemptionsValue).to.be.equal(49975)
        })

        it("should increase the balance of bridge in the bank", async () => {
          const bridgeBalance = await bank.balanceOf(bridge.address)
          // The expected value should be equal to the redemption's requested
          // amount
          expect(bridgeBalance).to.be.equal(50000)
        })
      })

      describe("when the redemption proof is submitted", async () => {
        before(async () => {
          // The current main UTXO of the wallet
          const mainUtxo: UTXOStruct = {
            txHash: depositSweepData.sweepTx.hash,
            txOutputIndex: 0,
            txOutputValue: 98400,
          }

          await bridge
            .connect(spvMaintainer)
            .submitRedemptionProof(
              redemptionData.redemptionTx,
              redemptionData.redemptionProof,
              mainUtxo,
              walletPubKeyHash
            )
        })

        it("should zero the pending redemptions value of the wallet", async () => {
          const { pendingRedemptionsValue } = await bridge.wallets(
            walletPubKeyHash
          )
          expect(pendingRedemptionsValue).to.be.equal(0)
        })

        it("should zero the balance of bridge in the bank", async () => {
          const bridgeBalance = await bank.balanceOf(bridge.address)
          expect(bridgeBalance).to.be.equal(0)
        })

        it("should update the main UTXO of the wallet", async () => {
          const expectedMainUtxo = ethers.utils.solidityKeccak256(
            ["bytes32", "uint32", "uint64"],
            [redemptionData.redemptionTx.hash, 1, 48425]
          )
          const { mainUtxoHash } = await bridge.wallets(walletPubKeyHash)
          expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
        })
      })
    })
  })

  async function updateDepositDustThresholdAndTxMaxFee(
    newDepositDustThreshold: BigNumberish,
    newDepositTxMaxFee: BigNumberish
  ) {
    await bridgeGovernance
      .connect(governance)
      .beginDepositDustThresholdUpdate(newDepositDustThreshold)

    await bridgeGovernance
      .connect(governance)
      .beginDepositTxMaxFeeUpdate(newDepositTxMaxFee)

    await helpers.time.increaseTime(constants.governanceDelay)

    await bridgeGovernance.connect(governance).finalizeDepositTxMaxFeeUpdate()

    await bridgeGovernance
      .connect(governance)
      .finalizeDepositDustThresholdUpdate()
  }

  async function updateRedemptionParameters(
    newRedemptionDustThreshold: number,
    newRedemptionTxMaxFee: number,
    newMovingFundsDustThreshold: number
  ) {
    await bridgeGovernance
      .connect(governance)
      .beginRedemptionDustThresholdUpdate(newRedemptionDustThreshold)

    // Redemption dust threshold has to be greater than moving funds dust threshold,
    // so first we need to align the moving funds dust threshold.
    await bridgeGovernance
      .connect(governance)
      .beginMovingFundsDustThresholdUpdate(newMovingFundsDustThreshold)

    await bridgeGovernance
      .connect(governance)
      .beginRedemptionTxMaxFeeUpdate(newRedemptionTxMaxFee)

    await helpers.time.increaseTime(constants.governanceDelay)

    await bridgeGovernance
      .connect(governance)
      .finalizeRedemptionTxMaxFeeUpdate()

    await bridgeGovernance
      .connect(governance)
      .finalizeMovingFundsDustThresholdUpdate()

    await bridgeGovernance
      .connect(governance)
      .finalizeRedemptionDustThresholdUpdate()
  }
})
