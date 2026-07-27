/* eslint-disable no-await-in-loop */
/* eslint-disable @typescript-eslint/no-extra-semi */
import hre, { ethers, helpers, waffle } from "hardhat"
import { expect } from "chai"

import type {
  ContractTransaction,
  Contract,
  BigNumberish,
  BytesLike,
} from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type { Mock } from "../helpers/mock"

import type {
  TBTC,
  Bridge,
  TBTCVault,
  IRelay,
  IRandomBeacon,
  WalletRegistry,
  BridgeGovernance,
} from "../../typechain"

import {
  Operators,
  performEcdsaDkg,
  produceOperatorInactivityClaim,
  updateWalletRegistryDkgResultChallengePeriodLength,
} from "./utils/ecdsa-wallet-registry"
import { produceRelayEntry } from "./utils/fake-random-beacon"

import { assertGasUsed } from "./utils/gas"
import { fixture } from "./utils/fixture"

import {
  wallet as fraudulentWallet,
  nonWitnessSignSingleInputTx,
} from "../data/fraud"
import { walletState, constants } from "../fixtures"
import { SingleP2SHDeposit, NO_MAIN_UTXO } from "../data/deposit-sweep"
import { UTXOStruct } from "../../typechain/Bridge"

const { increaseTime } = helpers.time
const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { impersonateAccount } = helpers.account

const describeFn =
  process.env.NODE_ENV === "integration-test" ? describe : describe.skip

describeFn("Integration Test - Slashing", async () => {
  let tbtc: TBTC
  let bridge: Bridge
  let bridgeGovernance: BridgeGovernance
  let tbtcVault: TBTCVault
  let staking: Contract
  let walletRegistry: WalletRegistry
  let randomBeacon: Mock<IRandomBeacon>
  let relay: Mock<IRelay>
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress

  const dkgResultChallengePeriodLength = 10

  before(async () => {
    ;({
      deployer,
      governance,
      spvMaintainer,
      tbtc,
      bridge,
      tbtcVault,
      staking,
      walletRegistry,
      relay,
      randomBeacon,
      bridgeGovernance,
    } = await waffle.loadFixture(fixture))
    ;[thirdParty] = await helpers.signers.getUnnamedSigners()

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

  describe("notifyFraudChallengeDefeatTimeout", async () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    describe("when wallet is created", async () => {
      const {
        publicKey: walletPublicKey,
        ecdsaWalletID,
        pubKeyHash160: walletPubKeyHash160,
      } = fraudulentWallet

      let walletMembers: Operators

      before("create a wallet", async () => {
        expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
          ethers.constants.AddressZero
        )

        const requestNewWalletTx = await bridge.requestNewWallet(NO_MAIN_UTXO)

        await produceRelayEntry(walletRegistry, randomBeacon)
        ;({ walletMembers } = await performEcdsaDkg(
          hre,
          walletRegistry,
          walletPublicKey,
          requestNewWalletTx.blockNumber
        ))
      })

      describe("when a fraud is reported", async () => {
        const fraudulentBtcTx = nonWitnessSignSingleInputTx
        let notifyFraudChallengeDefeatTimeoutTx: ContractTransaction

        before(async () => {
          const { fraudChallengeDepositAmount, fraudChallengeDefeatTimeout } =
            await bridge.fraudParameters()

          await bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              fraudulentBtcTx.preimageSha256,
              fraudulentBtcTx.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )

          await increaseTime(fraudChallengeDefeatTimeout)

          notifyFraudChallengeDefeatTimeoutTx = await bridge
            .connect(thirdParty)
            .notifyFraudChallengeDefeatTimeout(
              walletPublicKey,
              walletMembers.getIds(),
              fraudulentBtcTx.preimageSha256
            )
        })

        it("should slash wallet members", async () => {
          const { fraudSlashingAmount: amountToSlash } =
            await bridge.fraudParameters()

          expect(await staking.getSlashingQueueLength()).to.equal(
            walletMembers.length
          )

          for (let i = 0; i < walletMembers.length; i++) {
            const slashing = await staking.slashingQueue(i)

            expect(slashing.amount).to.equal(
              amountToSlash,
              `unexpected slashing amount for ${i}`
            )

            expect(slashing.stakingProvider).to.equal(
              walletMembers[i].stakingProvider,
              `unexpected staking provider for ${i}`
            )
          }
        })

        it("should close the wallet in the wallet registry", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await walletRegistry.isWalletRegistered(ecdsaWalletID)).to.be
            .false
        })

        it("should terminate the wallet in the bridge", async () => {
          const storedWallet = await bridge.wallets(walletPubKeyHash160)

          expect(storedWallet.state).to.be.equal(walletState.Terminated)
        })

        it("should consume around 3 100 000 gas for Bridge.notifyMovingFundsTimeoutTx transaction", async () => {
          await assertGasUsed(
            notifyFraudChallengeDefeatTimeoutTx,
            3_150_000,
            100_000
          )
        })
      })
    })
  })

  describe("notifyRedemptionTimeout", async () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    describe("when wallet is created", async () => {
      const deposit = SingleP2SHDeposit.deposits[0]

      const { walletPubKeyHash: walletPubKeyHash160 } = deposit.reveal
      const { walletPublicKey, walletID: ecdsaWalletID } = deposit.ecdsaWallet

      let walletMembers: Operators
      let redeemerOutputScript: BytesLike

      before(async () => {
        const requestNewWalletTx = await bridge.requestNewWallet(NO_MAIN_UTXO)

        await produceRelayEntry(walletRegistry, randomBeacon)
        ;({ walletMembers } = await performEcdsaDkg(
          hre,
          walletRegistry,
          walletPublicKey,
          requestNewWalletTx.blockNumber
        ))

        const { fundingTx, depositor, reveal } = SingleP2SHDeposit.deposits[0]
        reveal.vault = tbtcVault.address

        // We use a deposit funding bitcoin transaction with a very low amount,
        // so we need to update the dust and redemption thresholds to be below it.
        // TX max fees need to be adjusted as well given that they need to
        // be lower than dust thresholds.
        await updateDepositDustThresholdAndTxMaxFee(10_000, 2_000) // 0.0001 BTC, 0.00002 BTC
        await updateRedemptionDustThresholdAndTxMaxFeeAndMovingFundsDustThreshold(
          2_000,
          200,
          100
        ) // 0.00002 BTC, 0.000002 BTC

        const depositorSigner = await impersonateAccount(depositor, {
          from: governance,
          value: 10,
        })

        // Reveal and sweep the deposit to set up a positive Bank balance for
        // the redeemer, to be able to request a redemption.
        await bridge.connect(depositorSigner).revealDeposit(fundingTx, reveal)

        await relay.getCurrentEpochDifficulty.returns(
          SingleP2SHDeposit.chainDifficulty
        )
        await relay.getPrevEpochDifficulty.returns(
          SingleP2SHDeposit.chainDifficulty
        )

        await bridge
          .connect(spvMaintainer)
          .submitDepositSweepProof(
            SingleP2SHDeposit.sweepTx,
            SingleP2SHDeposit.sweepProof,
            SingleP2SHDeposit.mainUtxo,
            tbtcVault.address
          )

        const newMainUtxo: UTXOStruct = {
          txHash: SingleP2SHDeposit.sweepTx.hash,
          txOutputIndex: 0,
          txOutputValue: 18_500, // Value obtained from SingleP2SHDeposit.sweepTx.outputVector
        }

        // Request redemption
        const redeemer = await helpers.account.impersonateAccount(
          deposit.depositor,
          { from: deployer, value: 10 }
        )
        const redemptionAmount = 3_000 * constants.satoshiMultiplier
        redeemerOutputScript =
          "0x17a91486884e6be1525dab5ae0b451bd2c72cee67dcf4187"
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
                walletPubKeyHash160,
                newMainUtxo.txHash,
                newMainUtxo.txOutputIndex,
                newMainUtxo.txOutputValue,
                redeemerOutputScript,
              ]
            )
          )

        // Confirm the wallet is still in Live state.
        expect((await bridge.wallets(walletPubKeyHash160)).state).to.be.equal(
          walletState.Live
        )
      })

      describe("when a redemption timeout is reported", async () => {
        let notifyRedemptionTimeoutTx: ContractTransaction

        before(async () => {
          const { redemptionTimeout } = await bridge.redemptionParameters()

          await helpers.time.increaseTime(redemptionTimeout + 1)

          notifyRedemptionTimeoutTx = await bridge
            .connect(thirdParty)
            .notifyRedemptionTimeout(
              walletPubKeyHash160,
              walletMembers.getIds(),
              redeemerOutputScript
            )
        })

        it("should slash wallet members", async () => {
          const { redemptionTimeoutSlashingAmount: amountToSlash } =
            await bridge.redemptionParameters()

          expect(await staking.getSlashingQueueLength()).to.equal(
            walletMembers.length
          )

          for (let i = 0; i < walletMembers.length; i++) {
            const slashing = await staking.slashingQueue(i)

            expect(slashing.amount).to.equal(
              amountToSlash,
              `unexpected slashing amount for ${i}`
            )

            expect(slashing.stakingProvider).to.equal(
              walletMembers[i].stakingProvider,
              `unexpected staking provider for ${i}`
            )
          }
        })

        it("should not close the wallet in the wallet registry", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await walletRegistry.isWalletRegistered(ecdsaWalletID)).to.be
            .true
        })

        // Since the wallet's balance was above 0, it switched to MovingFunds state.
        it("should transition the wallet in the bridge to the MovingFunds state", async () => {
          const storedWallet = await bridge.wallets(walletPubKeyHash160)

          expect(storedWallet.state).to.be.equal(walletState.MovingFunds)
        })

        it("should consume around 3 150 000 gas for Bridge.notifyRedemptionTimeout transaction", async () => {
          await assertGasUsed(notifyRedemptionTimeoutTx, 3_150_000, 100_000)
        })
      })
    })
  })

  describe("notifyMovingFundsTimeout", async () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    describe("when wallet is created", async () => {
      const deposit = SingleP2SHDeposit.deposits[0]

      const walletPubKeyHash160 = deposit.reveal.walletPubKeyHash
      const { walletPublicKey, walletID: ecdsaWalletID } = deposit.ecdsaWallet

      let walletMembers: Operators

      before(async () => {
        const requestNewWalletTx = await bridge.requestNewWallet(NO_MAIN_UTXO)

        await produceRelayEntry(walletRegistry, randomBeacon)
        ;({ walletMembers } = await performEcdsaDkg(
          hre,
          walletRegistry,
          walletPublicKey,
          requestNewWalletTx.blockNumber
        ))

        const { fundingTx, depositor, reveal } = SingleP2SHDeposit.deposits[0]
        reveal.vault = tbtcVault.address

        // We use a deposit funding bitcoin transaction with a very low amount,
        // so we need to update the dust threshold to be below it.
        // TX max fee needs to be updated as well given it has to be lower
        // than the dust threshold.
        await updateDepositDustThresholdAndTxMaxFee(10_000, 2_000) // 0.0001 BTC, 0.00002 BTC

        const depositorSigner = await impersonateAccount(depositor, {
          from: governance,
          value: 10,
        })

        // Reveal and sweep the deposit to set up a main UTXO for the wallet,
        // so when operator inactivity is reported the wallet is transferred to
        // the MovingFunds instead of the Closing state.
        await bridge.connect(depositorSigner).revealDeposit(fundingTx, reveal)

        await relay.getCurrentEpochDifficulty.returns(
          SingleP2SHDeposit.chainDifficulty
        )
        await relay.getPrevEpochDifficulty.returns(
          SingleP2SHDeposit.chainDifficulty
        )

        await bridge
          .connect(spvMaintainer)
          .submitDepositSweepProof(
            SingleP2SHDeposit.sweepTx,
            SingleP2SHDeposit.sweepProof,
            SingleP2SHDeposit.mainUtxo,
            tbtcVault.address
          )

        // Switch the wallet to moving funds state by reporting wallet members
        // inactivity.
        const nonce = 0
        const walletMembersIDs = walletMembers.getIds()

        const inactiveMembersIndices = [26, 40, 63, 78, 89]
        const claim = await produceOperatorInactivityClaim(
          hre,
          ecdsaWalletID,
          walletMembers,
          nonce,
          walletPublicKey,
          true,
          inactiveMembersIndices,
          walletMembers.length / 2 + 1
        )

        await walletRegistry
          .connect(walletMembers[0].signer)
          .notifyOperatorInactivity(claim, nonce, walletMembersIDs)
      })

      describe("when moving funds timeout is reported", async () => {
        let notifyMovingFundsTimeoutTx: ContractTransaction

        before(async () => {
          expect(
            await (
              await bridge.wallets(walletPubKeyHash160)
            ).state
          ).to.be.equal(walletState.MovingFunds)

          const { movingFundsTimeout } = await bridge.movingFundsParameters()

          await helpers.time.increaseTime(movingFundsTimeout + 1)

          notifyMovingFundsTimeoutTx = await bridge
            .connect(thirdParty)
            .notifyMovingFundsTimeout(
              walletPubKeyHash160,
              walletMembers.getIds()
            )
        })

        it("should slash wallet members", async () => {
          const { movingFundsTimeoutSlashingAmount: amountToSlash } =
            await bridge.movingFundsParameters()

          expect(await staking.getSlashingQueueLength()).to.equal(
            walletMembers.length
          )

          for (let i = 0; i < walletMembers.length; i++) {
            const slashing = await staking.slashingQueue(i)

            expect(slashing.amount).to.equal(
              amountToSlash,
              `unexpected slashing amount for ${i}`
            )

            expect(slashing.stakingProvider).to.equal(
              walletMembers[i].stakingProvider,
              `unexpected staking provider for ${i}`
            )
          }
        })

        it("should close the wallet in the wallet registry", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await walletRegistry.isWalletRegistered(ecdsaWalletID)).to.be
            .false
        })

        it("should terminate the wallet in the bridge", async () => {
          const storedWallet = await bridge.wallets(walletPubKeyHash160)

          expect(storedWallet.state).to.be.equal(walletState.Terminated)
        })

        it("should consume around 3 100 000 gas for Bridge.notifyMovingFundsTimeoutTx transaction", async () => {
          await assertGasUsed(notifyMovingFundsTimeoutTx, 3_100_000, 100_000)
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

  async function updateRedemptionDustThresholdAndTxMaxFeeAndMovingFundsDustThreshold(
    newRedemptionDustThreshold: number,
    newRedemptionTxMaxFee: number,
    newMovingFundsDustThreshold: number
  ) {
    await bridgeGovernance
      .connect(governance)
      .beginRedemptionDustThresholdUpdate(newRedemptionDustThreshold)

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
