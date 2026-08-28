import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import {
  IBridge,
  ITBTCVault,
  ReimbursementPool,
  TestERC20,
  TestL1BTCDepositor,
} from "../../typechain"
import type {
  BitcoinTxInfoStruct,
  DepositRevealInfoStruct,
} from "../../typechain/L2BTCDepositorWormhole"
import { to1ePrecision } from "../helpers/contract-test-helpers"
import { createMock, expectCalledTwice, expectNotCalled } from "../helpers/mock"
import type { Mock } from "../helpers/mock"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

// Just an arbitrary TBTCVault address.
const tbtcVaultAddress = "0xB5679dE944A79732A75CE556191DF11F489448d5"

type InitializeDepositFixture = {
  // Deposit key built as keccak256(fundingTxHash, reveal.fundingOutputIndex)
  depositKey: string
  fundingTx: BitcoinTxInfoStruct
  reveal: DepositRevealInfoStruct
  destinationChainDepositOwner: string
}

// Fixture used for the initializeDeposit test scenario.
const initializeDepositFixture: InitializeDepositFixture = {
  depositKey:
    "0x97a4104f4114ba56dde79d02c4e8296596c3259da60d0e53fa97170f7cf7258d",
  fundingTx: {
    version: "0x01000000",
    inputVector:
      "0x01dfe39760a5edabdab013114053d789ada21e356b59fea41d980396" +
      "c1a4474fad0100000023220020e57edf10136b0434e46bc08c5ac5a1e4" +
      "5f64f778a96f984d0051873c7a8240f2ffffffff",
    outputVector:
      "0x02804f1200000000002200202f601522e7bb1f7de5c56bdbd45590b3" +
      "499bad09190581dcaa17e152d8f0c2a9b7e837000000000017a9148688" +
      "4e6be1525dab5ae0b451bd2c72cee67dcf4187",
    locktime: "0x00000000",
  },
  reveal: {
    fundingOutputIndex: 0,
    blindingFactor: "0xba863847d2d0fee3",
    walletPubKeyHash: "0xf997563fee8610ca28f99ac05bd8a29506800d4d",
    refundPubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    refundLocktime: "0xde2b4c67",
    vault: tbtcVaultAddress,
  },
  destinationChainDepositOwner:
    "0x00000000000000000000000023b82a7108f9ceb34c3cdc44268be21d151d4124",
}

describe("AbstractL1BTCDepositor", () => {
  const satoshiMultiplier = to1ePrecision(1, 10)
  const depositAmount = BigNumber.from(100000)
  const treasuryFee = BigNumber.from(500)
  const optimisticMintingFeeDivisor = 20 // 5%
  const depositTxMaxFee = BigNumber.from(1000)

  // amountSubTreasury = (depositAmount - treasuryFee) * satoshiMultiplier = 99500 * 1e10
  // omFee = amountSubTreasury / optimisticMintingFeeDivisor = 4975 * 1e10
  // txMaxFee = depositTxMaxFee * satoshiMultiplier = 1000 * 1e10
  // tbtcAmount = amountSubTreasury - omFee - txMaxFee = 93525 * 1e10
  const expectedTbtcAmount = to1ePrecision(93525, 10)

  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])
    const initializer = await ethers.getSigner(accounts[2])

    const bridge = await createMock<IBridge>("IBridge")
    const tbtcToken = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()
    const tbtcVault = await createMock<ITBTCVault>("ITBTCVault", {
      // The TBTCVault contract address must be known in advance and match
      // the one used in initializeDeposit fixture. This is necessary to
      // pass the vault address check in the initializeDeposit function.
      address: tbtcVaultAddress,
    })
    // Attach the tbtcToken mock to the tbtcVault mock.
    await tbtcVault.tbtcToken.returns(tbtcToken.address)

    const reimbursementPool = await createMock<ReimbursementPool>(
      "ReimbursementPool"
    )

    const depositor = (await (
      await ethers.getContractFactory("TestL1BTCDepositor", deployer)
    ).deploy()) as TestL1BTCDepositor
    await depositor
      .connect(deployer)
      .initialize(bridge.address, tbtcVault.address)
    await depositor.connect(deployer).transferOwnership(governance.address)

    return {
      governance,
      relayer,
      initializer,
      bridge,
      tbtcVault,
      reimbursementPool,
      depositor,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress
  let initializer: SignerWithAddress

  let bridge: Mock<IBridge>
  let tbtcVault: Mock<ITBTCVault>
  let reimbursementPool: Mock<ReimbursementPool>
  let depositor: TestL1BTCDepositor

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      relayer,
      initializer,
      bridge,
      tbtcVault,
      reimbursementPool,
      depositor,
    } = await waffle.loadFixture(contractsFixture))
  })

  // Sets the Bridge and TBTCVault mocks to a state that allows finalizing
  // the deposit from the fixture.
  const allowFinalization = async () => {
    // Set Bridge fees. Set only relevant fields.
    await bridge.depositParameters.returns({
      depositDustThreshold: 0,
      depositTreasuryFeeDivisor: 0,
      depositTxMaxFee,
      depositRevealAheadPeriod: 0,
    })
    await tbtcVault.optimisticMintingFeeDivisor.returns(
      optimisticMintingFeeDivisor
    )

    const revealedAt = (await lastBlockTime()) - 7200
    const finalizedAt = await lastBlockTime()
    await bridge.deposits
      .whenCalledWith(initializeDepositFixture.depositKey)
      .returns({
        depositor: depositor.address,
        amount: depositAmount,
        revealedAt,
        vault: initializeDepositFixture.reveal.vault,
        treasuryFee,
        sweptAt: finalizedAt,
        extraData: initializeDepositFixture.destinationChainDepositOwner,
      })
    await tbtcVault.optimisticMintingRequests
      .whenCalledWith(initializeDepositFixture.depositKey)
      .returns([revealedAt, finalizedAt])
  }

  const resetFakes = async () => {
    await reimbursementPool.maxGasPrice.reset()
    await reimbursementPool.staticGas.reset()
    await reimbursementPool.refund.reset()
    await bridge.depositParameters.reset()
    await tbtcVault.optimisticMintingFeeDivisor.reset()
    await bridge.revealDepositWithExtraData.reset()
    await bridge.deposits.reset()
    await tbtcVault.optimisticMintingRequests.reset()
  }

  describe("finalizeDeposit", () => {
    context(
      "when the reimbursement pool is set and a deferred gas reimbursement exists",
      () => {
        let initializeDepositGasSpent: BigNumber
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          // Use 1Gwei to make sure it's smaller than default gas price
          // used by Hardhat (200 Gwei) and this value will be used
          // for msgValueOffset calculation.
          await reimbursementPool.maxGasPrice.returns(
            BigNumber.from(1000000000)
          )
          await reimbursementPool.staticGas.returns(10000) // Just an arbitrary value.

          await depositor
            .connect(governance)
            .updateReimbursementPool(reimbursementPool.address)
          await depositor
            .connect(governance)
            .updateReimbursementAuthorization(relayer.address, true)
          await depositor
            .connect(governance)
            .updateReimbursementAuthorization(initializer.address, true)

          await depositor
            .connect(initializer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.destinationChainDepositOwner
            )

          // Capture the gas spent for the initializeDeposit call
          // for post-finalization comparison.
          initializeDepositGasSpent = (
            await depositor.gasReimbursements(
              initializeDepositFixture.depositKey
            )
          ).gasSpent

          // The deferred reimbursement entry must exist before finalization,
          // otherwise the ordering assertions would pass vacuously.
          expect(initializeDepositGasSpent).to.be.gt(0)

          // Make the `_transferTbtc` override observe the deferred gas
          // reimbursement entry of the finalized deposit.
          await depositor.setTrackedDepositKey(
            initializeDepositFixture.depositKey
          )

          await allowFinalization()

          tx = await depositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey)
        })

        after(async () => {
          await resetFakes()

          await restoreSnapshot()
        })

        it("should transfer tBTC to the destination chain deposit owner", async () => {
          await expect(tx)
            .to.emit(depositor, "TbtcTransferred")
            .withArgs(
              expectedTbtcAmount,
              initializeDepositFixture.destinationChainDepositOwner
            )
        })

        it("should emit DepositFinalized event", async () => {
          await expect(tx)
            .to.emit(depositor, "DepositFinalized")
            .withArgs(
              initializeDepositFixture.depositKey,
              initializeDepositFixture.destinationChainDepositOwner,
              relayer.address,
              depositAmount.mul(satoshiMultiplier),
              expectedTbtcAmount
            )
        })

        it("should clear the deferred gas reimbursement before the tBTC transfer", async () => {
          // Checks-effects-interactions: the deferred gas reimbursement
          // must be deleted from storage before the external
          // `_transferTbtc` call is made.
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await depositor.reimbursementClearedBeforeTransfer()).to.be
            .true
        })

        it("should delete the deferred gas reimbursement from storage", async () => {
          const gasReimbursement = await depositor.gasReimbursements(
            initializeDepositFixture.depositKey
          )

          expect(gasReimbursement.receiver).to.equal(
            ethers.constants.AddressZero
          )
          expect(gasReimbursement.gasSpent).to.equal(0)
        })

        it("should reimburse finalization before deferred initialization", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          await expectCalledTwice(reimbursementPool.refund)

          // The finalization reimbursement must be calculated and paid before
          // the deferred initialization reimbursement. The latter calls an
          // untrusted receiver, so doing it first would let that receiver burn
          // gas that is then counted again in the finalization reimbursement.
          const firstCall = await reimbursementPool.refund.getCall(0)
          expect(firstCall.args[1]).to.equal(relayer.address)

          const secondCall = await reimbursementPool.refund.getCall(1)
          expect(secondCall.args[0]).to.equal(initializeDepositGasSpent)
          expect(secondCall.args[1]).to.equal(initializer.address)
        })
      }
    )

    context("when the reimbursement pool is not set", () => {
      before(async () => {
        await createSnapshot()

        // Record a deferred gas reimbursement upon initialization...
        await depositor
          .connect(governance)
          .updateReimbursementPool(reimbursementPool.address)
        await depositor
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)

        await depositor
          .connect(relayer)
          .initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            initializeDepositFixture.destinationChainDepositOwner
          )

        // ...but detach the reimbursement pool before finalization.
        await depositor
          .connect(governance)
          .updateReimbursementPool(ethers.constants.AddressZero)

        await allowFinalization()

        await depositor
          .connect(relayer)
          .finalizeDeposit(initializeDepositFixture.depositKey)
      })

      after(async () => {
        await resetFakes()

        await restoreSnapshot()
      })

      it("should leave the deferred gas reimbursement in storage", async () => {
        const gasReimbursement = await depositor.gasReimbursements(
          initializeDepositFixture.depositKey
        )

        expect(gasReimbursement.receiver).to.equal(relayer.address)
        expect(gasReimbursement.gasSpent.toNumber()).to.be.greaterThan(0)
      })

      it("should not call the reimbursement pool", async () => {
        await expectNotCalled(reimbursementPool.refund)
      })
    })
  })
})
