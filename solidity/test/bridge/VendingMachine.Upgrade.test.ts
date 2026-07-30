import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { FakeContract } from "@defi-wonderland/smock"

import { constants, walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

import {
  DepositSweepTestData,
  SingleP2SHDeposit,
  SingleP2SHDepositWalletID,
} from "../data/deposit-sweep"

import type {
  Bank,
  Bridge,
  BridgeStub,
  TBTC,
  TBTCVault,
  TestERC20,
  VendingMachine,
  IRelay,
} from "../../typechain"
import { loadFixture } from "../helpers/fixture"

const { impersonateAccount } = helpers.account

const { to1e18 } = helpers.number
const { increaseTime, lastBlockTime } = helpers.time
const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Test covering `VendingMachine` -> `TBTCVault` upgrade process.
describe("VendingMachine - Upgrade", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let keepTechnicalWalletTeam: SignerWithAddress
  let keepCommunityMultiSig: SignerWithAddress

  let account1: SignerWithAddress
  let account2: SignerWithAddress

  let tbtcV1: TestERC20
  let tbtc: TBTC
  let tbtcVault: TBTCVault
  let bridge: Bridge & BridgeStub
  let bank: Bank
  let vendingMachine: VendingMachine
  let relay: FakeContract<IRelay>

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      spvMaintainer,
      keepTechnicalWalletTeam,
      keepCommunityMultiSig,
    } = await helpers.signers.getNamedSigners())

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[account1, account2] = await helpers.signers.getUnnamedSigners()

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ tbtcVault, tbtc, vendingMachine, bank, bridge, relay } =
      await loadFixture(bridgeFixture))

    // TBTC token ownership transfer is not performed in deployment scripts.
    // Check TransferTBTCOwnership deployment step for more information.
    await tbtc.connect(deployer).transferOwnership(vendingMachine.address)

    // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
    // the initial value in the Bridge in order to save test Bitcoins.
    await bridge.setDepositDustThreshold(10000)
    // Disable the reveal ahead period since refund locktimes are fixed
    // within transactions used in this test suite.
    await bridge.setDepositRevealAheadPeriod(0)

    tbtcV1 = await helpers.contracts.getContract("TBTCToken")
    // Two accounts with 10 TBTC v1 each wrap their holdings to TBTC v2.
    const initialTbtcBalance = to1e18(10)
    await tbtcV1.connect(deployer).mint(account1.address, initialTbtcBalance)
    await tbtcV1.connect(deployer).mint(account2.address, initialTbtcBalance)
    await tbtcV1
      .connect(account1)
      .approveAndCall(vendingMachine.address, initialTbtcBalance, [])
    await tbtcV1
      .connect(account2)
      .approveAndCall(vendingMachine.address, initialTbtcBalance, [])

    await vendingMachine
      .connect(keepTechnicalWalletTeam)
      .initiateVendingMachineUpgrade(tbtcVault.address)
    await increaseTime(await vendingMachine.GOVERNANCE_DELAY())
    await vendingMachine
      .connect(keepCommunityMultiSig)
      .finalizeVendingMachineUpgrade()
  })

  // This is an Option #1 scenario allowing the Governance to withdraw
  // TBTC v1, unmint TBTC v1 to BTC manually and then deposit BTC back to v2.
  // This scenario creates and imbalance in the system for a moment and implies
  // there is a trusted redeemer.
  //
  // Step #1 - TBTC v1 transfer, TBTC v2 ownership transfer
  //   TBTC v1 is transferred from `VendingMachine` to `TBTCVault` along with
  //   TBTC v2 token ownership.
  //
  // Step #2 - TBTC v1 withdrawal
  //   Governance withdraws TBTC v1 from `VendingMachine` *somewhere*.
  //   Governance unmints TBTC v1 to BTC *somehow*.
  //
  // Step #3 - BTC deposits
  //   Governance deposits BTC to `TBTCVault`.
  //
  // Step #4 - functioning system
  //   The system works. Users can mint and unmint TBTC v2.
  describe("upgrade process - option #1", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    // Two accounts with 10 TBTC v1 each wrap their holdings to TBTC v2.
    // See the main `before`.
    const totalTbtcV1Balance = to1e18(20)

    describe("step#1 - TBTC v1 transfer", () => {
      it("should transfer all TBTC v1 to TBTCVault", async () => {
        expect(await tbtcV1.balanceOf(vendingMachine.address)).to.equal(
          to1e18(0)
        )
        expect(await tbtcV1.balanceOf(tbtcVault.address)).to.equal(
          totalTbtcV1Balance
        )
      })
    })

    describe("step#2 - TBTC v1 withdrawal", () => {
      it("should let the governance withdraw TBTC v1 from TBTCVault", async () => {
        await tbtcVault
          .connect(governance)
          .recoverERC20(tbtcV1.address, governance.address, totalTbtcV1Balance)
        expect(await tbtcV1.balanceOf(tbtcVault.address)).to.equal(0)
        expect(await tbtcV1.balanceOf(governance.address)).to.equal(
          totalTbtcV1Balance
        )
      })
    })

    describe("step#3 - BTC deposit", () => {
      before(async () => {
        const data: DepositSweepTestData = JSON.parse(
          JSON.stringify(SingleP2SHDeposit)
        )
        const { fundingTx, depositor, reveal } = data.deposits[0] // it's a single deposit
        reveal.vault = tbtcVault.address

        // Simulate the wallet is a Live ECDSA one and is known in the system.
        await bridge.setWallet(reveal.walletPubKeyHash, {
          ecdsaWalletID: SingleP2SHDepositWalletID,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.Live,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })

        const depositorSigner = await impersonateAccount(depositor, {
          from: governance,
          value: 10,
        })
        await bridge.connect(depositorSigner).revealDeposit(fundingTx, reveal)

        relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
        relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

        await bridge
          .connect(spvMaintainer)
          .submitDepositSweepProof(
            data.sweepTx,
            data.sweepProof,
            data.mainUtxo,
            tbtcVault.address
          )
      })

      it("should let the governance donate TBTCVault", async () => {
        // The sum of sweep tx inputs is 20000 satoshi. The output
        // value is 18500 so the transaction fee is 1500. There is
        // only one deposit so it incurs the entire transaction fee.
        // The deposit should also incur the treasury fee whose
        // initial value is 0.05% of the deposited amount so the
        // final depositor balance should be cut by 10 satoshi.
        const totalWalletBtcBalance = 18490

        expect(await bank.balanceOf(tbtcVault.address)).to.equal(
          totalWalletBtcBalance
        )

        // Governance should burn the minted TBTC v2 so not checking the
        // amount.
      })
    })

    describe("step#4 - functioning system", () => {
      it("should let TBTC v2 holders unmint their tokens", async () => {
        const initialWalletBtcBalance = 18490 // [sat]
        // Bank balances are denominated in satoshi
        const unmintedBankBalance1 = 7000 // [sat]
        const unmintedBankBalance2 = 1000 // [sat]
        // Values in satoshi need to be multiplied by 1e10 (satoshi multiplier)
        // to be represented in 1e18 (Ethereum) precision.
        const unmintedAmount1 =
          unmintedBankBalance1 * constants.satoshiMultiplier
        const unmintedAmount2 =
          unmintedBankBalance2 * constants.satoshiMultiplier

        await tbtc.connect(account1).approve(tbtcVault.address, unmintedAmount1)
        await tbtcVault.connect(account1).unmint(unmintedAmount1)

        await tbtc.connect(account2).approve(tbtcVault.address, unmintedAmount2)
        await tbtcVault.connect(account2).unmint(unmintedAmount2)

        expect(await bank.balanceOf(account1.address)).to.equal(
          unmintedBankBalance1
        )
        expect(await bank.balanceOf(account2.address)).to.equal(
          unmintedBankBalance2
        )
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(
          initialWalletBtcBalance - unmintedBankBalance1 - unmintedBankBalance2
        )
      })

      it("should let Bank balance holders mint TBTC v2", async () => {
        const initialWalletBtcBalance = 10490 // 18490 - 7000 - 1000 [sat]
        // Bank balances are denominated in satoshi
        const mintedBankBalance1 = 600 // [sat]
        const mintedBankBalance2 = 100 // [sat]
        // Values in satoshi need to be multiplied by 1e10 (satoshi multiplier)
        // to be represented in 1e18 (Ethereum) precision.
        const mintedAmount1 = mintedBankBalance1 * constants.satoshiMultiplier
        const mintedAmount2 = mintedBankBalance2 * constants.satoshiMultiplier

        const initialTbtcBalance1 = await tbtc.balanceOf(account1.address)
        const initialTbtcBalance2 = await tbtc.balanceOf(account2.address)

        await bank
          .connect(account1)
          .approveBalance(tbtcVault.address, mintedAmount1)
        await tbtcVault.connect(account1).mint(mintedAmount1)

        await bank
          .connect(account2)
          .approveBalance(tbtcVault.address, mintedAmount2)
        await tbtcVault.connect(account2).mint(mintedAmount2)

        expect(await tbtc.balanceOf(account1.address)).to.equal(
          initialTbtcBalance1.add(mintedAmount1)
        )
        expect(await tbtc.balanceOf(account2.address)).to.equal(
          initialTbtcBalance2.add(mintedAmount2)
        )
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(
          initialWalletBtcBalance + mintedBankBalance1 + mintedBankBalance2
        )
      })
    })
  })

  // This is an Option #2 scenario based on the Agoristen's proposal from
  // https://forum.threshold.network/t/tip-027b-tbtc-v1-the-sunsettening/357/20
  //
  // In this scenario, Redeemer mints TBTC v2 with their own BTC. Then, they
  // unwrap back to TBTC v1 and redeem BTC from the v1 system.
  //
  // Step #1 - TBTC v1 transfer, TBTC v2 ownership transfer
  //   TBTC v1 is transferred from `VendingMachine` to `TBTCVault` along with
  //   TBTC v2 token ownership.
  //
  // Step #2 - TBTC v1 transfer back
  //   TBTC v1 is transferred back to `VendingMachine` from the `TBTCVault`.
  //
  // Step #3 - BTC deposits
  //   The v2 depositor (v1 redeemer) deposits BTC to the v2 system to mint
  //   TBTC v2.
  //
  // Step #4 - TBTC v1 redemption
  //   The v2 depositor (v1 redeemer) unwraps TBTC v1 from TBTC v2 via
  //   `VendingMachine` and use TBTC v1 for the v1 system redemption.
  describe("upgrade process - option #2", () => {
    // Two accounts with 10 TBTC v1 each wrap their holdings to TBTC v2.
    // See the main `before`.
    const totalTbtcV1Balance = to1e18(20)

    let depositData: DepositSweepTestData
    let redeemer: SignerWithAddress

    before(async () => {
      await createSnapshot()

      depositData = JSON.parse(JSON.stringify(SingleP2SHDeposit))

      // In this scenario, depositor of BTC into the v2 Bridge is the v1
      // redeemer responsible for unwrapping TBTC v2 back to TBTC v1 and then
      // using the TBTC v1 to perform BTC redemption.
      //
      // This account:
      // - from the perspective of v2 Bridge is a BTC depositor,
      // - from the perspective of v1 Bridge is a BTC redeemer.
      const { depositor } = depositData.deposits[0] // it's a single deposit
      redeemer = await impersonateAccount(depositor, {
        from: governance,
        value: 10,
      })
    })

    after(async () => {
      await restoreSnapshot()
    })

    describe("step#1 - TBTC v1 transfer", () => {
      it("should transfer all TBTC v1 to TBTCVault", async () => {
        expect(await tbtcV1.balanceOf(vendingMachine.address)).to.equal(
          to1e18(0)
        )
        expect(await tbtcV1.balanceOf(tbtcVault.address)).to.equal(
          totalTbtcV1Balance
        )
      })
    })

    describe("step#2 - TBTC v1 transfer back to VendingMachine", () => {
      it("should let the governance transfer TBTC v1 back to VendingMachine", async () => {
        await tbtcVault
          .connect(governance)
          .recoverERC20(
            tbtcV1.address,
            vendingMachine.address,
            totalTbtcV1Balance
          )

        expect(await tbtcV1.balanceOf(vendingMachine.address)).to.equal(
          totalTbtcV1Balance
        )
        expect(await tbtcV1.balanceOf(tbtcVault.address)).to.equal(0)
      })
    })

    describe("step #3 - BTC deposit", () => {
      before(async () => {
        const { fundingTx, reveal } = depositData.deposits[0] // it's a single deposit
        reveal.vault = tbtcVault.address

        // Simulate the wallet is a Live ECDSA one and is known in the system.
        await bridge.setWallet(reveal.walletPubKeyHash, {
          ecdsaWalletID: SingleP2SHDepositWalletID,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.Live,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })

        await bridge.connect(redeemer).revealDeposit(fundingTx, reveal)

        relay.getCurrentEpochDifficulty.returns(depositData.chainDifficulty)
        relay.getPrevEpochDifficulty.returns(depositData.chainDifficulty)

        await bridge
          .connect(spvMaintainer)
          .submitDepositSweepProof(
            depositData.sweepTx,
            depositData.sweepProof,
            depositData.mainUtxo,
            tbtcVault.address
          )
      })

      // The sum of sweep tx inputs is 20000 satoshi. The output
      // value is 18500 so the transaction fee is 1500. There is
      // only one deposit so it incurs the entire transaction fee.
      // The deposit should also incur the treasury fee whose
      // initial value is 0.05% of the deposited amount so the
      // final depositor balance should be cut by 10 satoshi.
      const totalWalletBtcBalance = 18490
      const totalTbtcMinted =
        totalWalletBtcBalance * constants.satoshiMultiplier

      it("should let to deposit BTC into v2 Bridge", async () => {
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(
          totalWalletBtcBalance
        )
        expect(await tbtc.balanceOf(redeemer.address)).to.equal(totalTbtcMinted)
      })

      describe("step #4 - TBTC v2 -> v2 unminting", () => {
        it("should let the redeemer to unmint TBTC v2 back to TBTC v1", async () => {
          expect(await tbtcV1.balanceOf(redeemer.address)).to.equal(0)
          expect(await tbtc.balanceOf(redeemer.address)).to.equal(
            totalTbtcMinted
          )

          await tbtc
            .connect(redeemer)
            .approve(vendingMachine.address, totalTbtcMinted)
          await vendingMachine.connect(redeemer).unmint(totalTbtcMinted)

          expect(await tbtcV1.balanceOf(redeemer.address)).to.equal(
            totalTbtcMinted
          )
          expect(await tbtc.balanceOf(redeemer.address)).to.equal(0)
        })
      })
    })
  })
})
