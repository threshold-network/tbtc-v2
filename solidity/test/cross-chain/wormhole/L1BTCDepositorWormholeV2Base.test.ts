import type { BytesLike } from "@ethersproject/bytes"
import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import {
  IBridge,
  IWormholeGateway,
  ITBTCVault,
  IWormhole,
  IWormholeRelayer,
  IWormholeTokenBridge,
  L1BTCDepositorWormholeV2Base,
  ReimbursementPool,
  TestERC20,
} from "../../../typechain"
import { to1ePrecision } from "../../helpers/contract-test-helpers"
import {
  initializeDepositFixture,
  toWormholeAddress,
} from "./L1BTCDepositorWormhole.test"
import { createMock, expectCalledTwice } from "../../helpers/mock"
import type { Mock } from "../../helpers/mock"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

const l1ChainId = 10
const l2ChainId = 20
const tbtcVaultAddress = "0xB5679dE944A79732A75CE556191DF11F489448d5"

describe("L1BTCDepositorWormholeV2Base", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()
    // The TestERC20 mint owner is set indirectly below via the default
    // factory signer; expose deployer only for proxy deployment.

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])

    const bridge = await createMock<IBridge>("IBridge")
    const tbtcToken = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()
    const tbtcVault = await createMock<ITBTCVault>("ITBTCVault", {
      address: tbtcVaultAddress,
    })
    await tbtcVault.tbtcToken.returns(tbtcToken.address)

    const wormhole = await createMock<IWormhole>("IWormhole")
    await wormhole.chainId.returns(l1ChainId)

    const wormholeRelayer = await createMock<IWormholeRelayer>(
      "IWormholeRelayer"
    )
    const wormholeTokenBridge = await createMock<IWormholeTokenBridge>(
      "IWormholeTokenBridge"
    )
    const l2WormholeGateway = await createMock<IWormholeGateway>(
      "IWormholeGateway"
    )
    const l2BitcoinDepositor = "0xeE6F5f69860f310114185677D017576aed0dEC83"
    const reimbursementPool = await createMock<ReimbursementPool>(
      "ReimbursementPool"
    )

    const deployment = await helpers.upgrades.deployProxy(
      `L1BTCDepositorWormholeV2Base_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L1BTCDepositorWormholeV2Base",
        initializerArgs: [
          bridge.address,
          tbtcVault.address,
          wormhole.address,
          wormholeRelayer.address,
          wormholeTokenBridge.address,
          l2WormholeGateway.address,
          l2ChainId,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const l1BtcDepositor = deployment[0] as L1BTCDepositorWormholeV2Base

    await l1BtcDepositor.connect(deployer).transferOwnership(governance.address)

    return {
      governance,
      relayer,
      bridge,
      tbtcToken,
      tbtcVault,
      wormhole,
      wormholeRelayer,
      wormholeTokenBridge,
      l2WormholeGateway,
      l2BitcoinDepositor,
      reimbursementPool,
      l1BtcDepositor,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress
  // The TestERC20 token is deployed via the factory's default signer
  // (the first hardhat account). That account owns the token and can mint.
  let tokenOwner: SignerWithAddress

  let bridge: Mock<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: Mock<ITBTCVault>
  let wormhole: Mock<IWormhole>
  let wormholeTokenBridge: Mock<IWormholeTokenBridge>
  let l2WormholeGateway: Mock<IWormholeGateway>
  let l2BitcoinDepositor: string
  let l1BtcDepositor: L1BTCDepositorWormholeV2Base
  let reimbursementPool: Mock<ReimbursementPool>

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      relayer,
      bridge,
      tbtcToken,
      tbtcVault,
      wormhole,
      wormholeTokenBridge,
      l2WormholeGateway,
      l2BitcoinDepositor,
      l1BtcDepositor,
      reimbursementPool,
    } = await waffle.loadFixture(contractsFixture))
    ;[tokenOwner] = await ethers.getSigners()
  })

  describe("finalizeDeposit", () => {
    before(async () => {
      await createSnapshot()

      await l1BtcDepositor
        .connect(governance)
        .attachL2BitcoinDepositor(l2BitcoinDepositor)
    })

    after(async () => {
      await restoreSnapshot()
    })

    // Shared deposit math used by every reimbursement-flag context below.
    //
    // amountSubTreasury = (depositAmount - treasuryFee) * satoshiMultiplier
    //                   = (100000 - 500) * 1e10 = 99500 * 1e10
    // omFee             = amountSubTreasury / optimisticMintingFeeDivisor
    //                   = 99500e10 / 20 = 4975 * 1e10
    // txMaxFeeScaled    = depositTxMaxFee * satoshiMultiplier
    //                   = 1000 * 1e10
    // baseTbtcAmount    = amountSubTreasury - omFee - txMaxFeeScaled
    //                   = (99500 - 4975 - 1000) * 1e10 = 93525 * 1e10
    // reimbursedAmount  = baseTbtcAmount + txMaxFeeScaled = 94525 * 1e10
    // initialAmountWei  = depositAmount * satoshiMultiplier
    //                   = 100000 * 1e10 = 1e15
    const messageFee = 1000
    const transferSequence = 555
    const depositAmount = BigNumber.from(100000)
    const treasuryFee = BigNumber.from(500)
    const optimisticMintingFeeDivisor = 20
    const depositTxMaxFee = BigNumber.from(1000)
    const baseTbtcAmount = to1ePrecision(93525, 10)
    const txMaxFeeScaled = to1ePrecision(1000, 10)
    const reimbursedAmount = baseTbtcAmount.add(txMaxFeeScaled)
    const initialAmountWei = to1ePrecision(100000, 10)

    const stageDeposit = async () => {
      await l1BtcDepositor
        .connect(relayer)
        .initializeDeposit(
          initializeDepositFixture.fundingTx,
          initializeDepositFixture.reveal,
          initializeDepositFixture.destinationChainDepositOwner
        )

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
          depositor: l1BtcDepositor.address,
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

      await wormhole.messageFee.returns(messageFee)
      await wormholeTokenBridge.transferTokensWithPayload.returns(
        transferSequence
      )
    }

    const resetMocks = async () => {
      await bridge.depositParameters.reset()
      await tbtcVault.optimisticMintingFeeDivisor.reset()
      await bridge.revealDepositWithExtraData.reset()
      await bridge.deposits.reset()
      await tbtcVault.optimisticMintingRequests.reset()
      await wormhole.messageFee.reset()
      await wormholeTokenBridge.transferTokensWithPayload.reset()
    }

    context("when reimburseTxMaxFee is false", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        await stageDeposit()
        tx = await l1BtcDepositor
          .connect(relayer)
          .finalizeDeposit(initializeDepositFixture.depositKey, {
            value: messageFee,
          })
      })

      after(async () => {
        resetMocks()
        await restoreSnapshot()
      })

      it("should transfer the base tbtcAmount (no reimbursement added)", async () => {
        expect(
          await tbtcToken.allowance(
            l1BtcDepositor.address,
            wormholeTokenBridge.address
          )
        ).to.equal(baseTbtcAmount)
      })

      it("should NOT emit DepositTxMaxFeeReimbursementSkipped", async () => {
        await expect(tx).to.not.emit(
          l1BtcDepositor,
          "DepositTxMaxFeeReimbursementSkipped"
        )
      })
    })

    context(
      "when reimburseTxMaxFee is true and balance covers reimbursedAmount",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await l1BtcDepositor.connect(governance).setReimburseTxMaxFee(true)

          await stageDeposit()

          // Pre-fund the proxy with exactly reimbursedAmount so the
          // best-effort check passes and the reimbursement is paid.
          await tbtcToken
            .connect(tokenOwner)
            .mint(l1BtcDepositor.address, reimbursedAmount)

          tx = await l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee,
            })
        })

        after(async () => {
          resetMocks()
          await restoreSnapshot()
        })

        it("should transfer the full reimbursedAmount (base + txMaxFee)", async () => {
          expect(
            await tbtcToken.allowance(
              l1BtcDepositor.address,
              wormholeTokenBridge.address
            )
          ).to.equal(reimbursedAmount)
        })

        it("should NOT emit DepositTxMaxFeeReimbursementSkipped", async () => {
          await expect(tx).to.not.emit(
            l1BtcDepositor,
            "DepositTxMaxFeeReimbursementSkipped"
          )
        })

        it("should emit DepositFinalized carrying the reimbursed tbtcAmount", async () => {
          await expect(tx)
            .to.emit(l1BtcDepositor, "DepositFinalized")
            .withArgs(
              initializeDepositFixture.depositKey,
              initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
              relayer.address,
              initialAmountWei,
              reimbursedAmount
            )
        })
      }
    )

    context(
      "when reimburseTxMaxFee is true and balance is below reimbursedAmount",
      () => {
        let tx: ContractTransaction
        // Available balance is exactly one wei short of reimbursedAmount,
        // which is sufficient to pay the base tbtcAmount but not the full
        // reimbursement.
        const availableBalance = reimbursedAmount.sub(1)

        before(async () => {
          await createSnapshot()

          await l1BtcDepositor.connect(governance).setReimburseTxMaxFee(true)

          await stageDeposit()

          await tbtcToken
            .connect(tokenOwner)
            .mint(l1BtcDepositor.address, availableBalance)

          tx = await l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee,
            })
        })

        after(async () => {
          resetMocks()
          await restoreSnapshot()
        })

        it("should still finalize the deposit", async () => {
          expect(
            await l1BtcDepositor.deposits(initializeDepositFixture.depositKey)
          ).to.equal(2)
        })

        it("should transfer only the base tbtcAmount, not the reimbursed amount", async () => {
          expect(
            await tbtcToken.allowance(
              l1BtcDepositor.address,
              wormholeTokenBridge.address
            )
          ).to.equal(baseTbtcAmount)
        })

        it("should emit DepositTxMaxFeeReimbursementSkipped with the available balance", async () => {
          await expect(tx)
            .to.emit(l1BtcDepositor, "DepositTxMaxFeeReimbursementSkipped")
            .withArgs(
              initializeDepositFixture.depositKey,
              txMaxFeeScaled,
              availableBalance
            )
        })

        it("should emit DepositFinalized carrying only the base tbtcAmount", async () => {
          await expect(tx)
            .to.emit(l1BtcDepositor, "DepositFinalized")
            .withArgs(
              initializeDepositFixture.depositKey,
              initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
              relayer.address,
              initialAmountWei,
              baseTbtcAmount
            )
        })
      }
    )

    // This is the production-relevant skip-path scenario: the Bridge sweep
    // delivers (depositAmount - treasuryFee - actualBTCfee) * 1e10 to the
    // proxy. Whenever actualBTCfee > 0, the proxy ends up holding the
    // base amount but cannot cover the full `base + txMaxFee` reimbursement.
    // We model that here by pre-funding with exactly baseTbtcAmount.
    context(
      "when reimburseTxMaxFee is true and balance equals baseTbtcAmount",
      () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await l1BtcDepositor.connect(governance).setReimburseTxMaxFee(true)

          await stageDeposit()

          await tbtcToken
            .connect(tokenOwner)
            .mint(l1BtcDepositor.address, baseTbtcAmount)

          tx = await l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee,
            })
        })

        after(async () => {
          resetMocks()
          await restoreSnapshot()
        })

        it("should transfer only the base tbtcAmount", async () => {
          expect(
            await tbtcToken.allowance(
              l1BtcDepositor.address,
              wormholeTokenBridge.address
            )
          ).to.equal(baseTbtcAmount)
        })

        it("should emit DepositTxMaxFeeReimbursementSkipped with availableBalance equal to baseTbtcAmount", async () => {
          await expect(tx)
            .to.emit(l1BtcDepositor, "DepositTxMaxFeeReimbursementSkipped")
            .withArgs(
              initializeDepositFixture.depositKey,
              txMaxFeeScaled,
              baseTbtcAmount
            )
        })

        it("should emit DepositFinalized carrying only the base tbtcAmount", async () => {
          await expect(tx)
            .to.emit(l1BtcDepositor, "DepositFinalized")
            .withArgs(
              initializeDepositFixture.depositKey,
              initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
              relayer.address,
              initialAmountWei,
              baseTbtcAmount
            )
        })

        it("should preserve the L2 receiver payload through the skip branch", async () => {
          const call =
            await wormholeTokenBridge.transferTokensWithPayload.getCall(0)
          const [l2Receiver] = ethers.utils.defaultAbiCoder.decode(
            ["bytes32"],
            call.args[5] as BytesLike
          )
          expect(l2Receiver.toLowerCase()).to.equal(
            initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
          )
          expect(call.args[3]).to.equal(
            toWormholeAddress(l2WormholeGateway.address.toLowerCase())
          )
        })
      }
    )
    context(
      "when the reimbursement pool is set and a deferred gas reimbursement exists",
      () => {
        let initializer: SignerWithAddress
        let initializeDepositGasSpent: BigNumber

        before(async () => {
          await createSnapshot()

          const accounts = await getUnnamedAccounts()
          initializer = await ethers.getSigner(accounts[2])

          // Use 1Gwei to make sure it's smaller than default gas price
          // used by Hardhat (200 Gwei) and this value will be used
          // for msgValueOffset calculation.
          await reimbursementPool.maxGasPrice.returns(
            BigNumber.from(1000000000)
          )
          await reimbursementPool.staticGas.returns(10000) // Just an arbitrary value.

          await l1BtcDepositor
            .connect(governance)
            .updateReimbursementPool(reimbursementPool.address)
          await l1BtcDepositor
            .connect(governance)
            .updateReimbursementAuthorization(relayer.address, true)
          await l1BtcDepositor
            .connect(governance)
            .updateReimbursementAuthorization(initializer.address, true)

          await l1BtcDepositor
            .connect(initializer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.destinationChainDepositOwner
            )

          initializeDepositGasSpent = (
            await l1BtcDepositor.gasReimbursements(
              initializeDepositFixture.depositKey
            )
          ).gasSpent

          // The deferred reimbursement entry must exist before finalization,
          // otherwise the ordering assertions would pass vacuously.
          expect(initializeDepositGasSpent).to.be.gt(0)

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
              depositor: l1BtcDepositor.address,
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

          await wormhole.messageFee.returns(messageFee)
          await wormholeTokenBridge.transferTokensWithPayload.returns(
            transferSequence
          )

          await l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee,
            })
        })

        after(async () => {
          await reimbursementPool.maxGasPrice.reset()
          await reimbursementPool.staticGas.reset()
          resetMocks()
          await restoreSnapshot()
        })

        it("should reimburse finalization before deferred initialization", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          await expectCalledTwice(reimbursementPool.refund)

          // The finalization reimbursement must be calculated and paid
          // before the deferred initialization reimbursement. The latter
          // calls an untrusted receiver, so doing it first would let that
          // receiver burn gas that is then counted again in the
          // finalization reimbursement.
          const firstCall = await reimbursementPool.refund.getCall(0)
          expect(firstCall.args[1]).to.equal(relayer.address)

          const secondCall = await reimbursementPool.refund.getCall(1)
          expect(secondCall.args[0]).to.equal(initializeDepositGasSpent)
          expect(secondCall.args[1]).to.equal(initializer.address)
        })
      }
    )
  })
})
