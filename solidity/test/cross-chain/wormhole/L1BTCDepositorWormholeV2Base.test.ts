import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
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

chai.use(smock.matchers)

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

    const bridge = await smock.fake<IBridge>("IBridge")
    const tbtcToken = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()
    const tbtcVault = await smock.fake<ITBTCVault>("ITBTCVault", {
      address: tbtcVaultAddress,
    })
    tbtcVault.tbtcToken.returns(tbtcToken.address)

    const wormhole = await smock.fake<IWormhole>("IWormhole")
    wormhole.chainId.returns(l1ChainId)

    const wormholeRelayer = await smock.fake<IWormholeRelayer>(
      "IWormholeRelayer"
    )
    const wormholeTokenBridge = await smock.fake<IWormholeTokenBridge>(
      "IWormholeTokenBridge"
    )
    const l2WormholeGateway = await smock.fake<IWormholeGateway>(
      "IWormholeGateway"
    )
    const l2BitcoinDepositor = "0xeE6F5f69860f310114185677D017576aed0dEC83"
    const reimbursementPool = await smock.fake<ReimbursementPool>(
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

  let bridge: FakeContract<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: FakeContract<ITBTCVault>
  let wormhole: FakeContract<IWormhole>
  let wormholeTokenBridge: FakeContract<IWormholeTokenBridge>
  let l2WormholeGateway: FakeContract<IWormholeGateway>
  let l2BitcoinDepositor: string
  let l1BtcDepositor: L1BTCDepositorWormholeV2Base

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
    const messageFee = 1000
    const transferSequence = 555
    const depositAmount = BigNumber.from(100000)
    const treasuryFee = BigNumber.from(500)
    const optimisticMintingFeeDivisor = 20
    const depositTxMaxFee = BigNumber.from(1000)
    const baseTbtcAmount = to1ePrecision(93525, 10)
    const txMaxFeeScaled = to1ePrecision(1000, 10)
    const reimbursedAmount = baseTbtcAmount.add(txMaxFeeScaled)

    const stageDeposit = async () => {
      await l1BtcDepositor
        .connect(relayer)
        .initializeDeposit(
          initializeDepositFixture.fundingTx,
          initializeDepositFixture.reveal,
          initializeDepositFixture.destinationChainDepositOwner
        )

      bridge.depositParameters.returns({
        depositDustThreshold: 0,
        depositTreasuryFeeDivisor: 0,
        depositTxMaxFee,
        depositRevealAheadPeriod: 0,
      })
      tbtcVault.optimisticMintingFeeDivisor.returns(optimisticMintingFeeDivisor)

      const revealedAt = (await lastBlockTime()) - 7200
      const finalizedAt = await lastBlockTime()
      bridge.deposits
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

      tbtcVault.optimisticMintingRequests
        .whenCalledWith(initializeDepositFixture.depositKey)
        .returns([revealedAt, finalizedAt])

      wormhole.messageFee.returns(messageFee)
      wormholeTokenBridge.transferTokensWithPayload.returns(transferSequence)
    }

    const resetMocks = () => {
      bridge.depositParameters.reset()
      tbtcVault.optimisticMintingFeeDivisor.reset()
      bridge.revealDepositWithExtraData.reset()
      bridge.deposits.reset()
      tbtcVault.optimisticMintingRequests.reset()
      wormhole.messageFee.reset()
      wormholeTokenBridge.transferTokensWithPayload.reset()
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
      }
    )

    context("when reimburseTxMaxFee is true and proxy holds zero tBTC", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await l1BtcDepositor.connect(governance).setReimburseTxMaxFee(true)

        await stageDeposit()

        // No pre-funding. availableBalance == 0 < reimbursedAmount.

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

      it("should emit DepositTxMaxFeeReimbursementSkipped with zero available balance", async () => {
        await expect(tx)
          .to.emit(l1BtcDepositor, "DepositTxMaxFeeReimbursementSkipped")
          .withArgs(initializeDepositFixture.depositKey, txMaxFeeScaled, 0)
      })

      it("should encode the L2 receiver in the payload", async () => {
        // Sanity check that the skip path does not corrupt the L2 routing.
        const call = wormholeTokenBridge.transferTokensWithPayload.getCall(0)
        const [l2Receiver] = ethers.utils.defaultAbiCoder.decode(
          ["bytes32"],
          call.args[5]
        )
        expect(l2Receiver.toLowerCase()).to.equal(
          initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
        )
        // The Wormhole gateway is passed as the recipient field; the L2
        // owner travels inside the payload (V2 design).
        expect(call.args[3]).to.equal(
          toWormholeAddress(l2WormholeGateway.address.toLowerCase())
        )
      })
    })
  })
})
