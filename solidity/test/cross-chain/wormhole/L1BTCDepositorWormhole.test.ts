import { ethers, getUnnamedAccounts, helpers } from "hardhat"
import { randomBytes } from "crypto"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, BigNumberish, ContractTransaction } from "ethers"
import { loadFixture } from "../../helpers/fixture"
import {
  IBridge,
  IWormholeGateway,
  ITBTCVault,
  IWormhole,
  IWormholeRelayer,
  IWormholeTokenBridge,
  L1BTCDepositorWormhole,
  ReimbursementPool,
  TestERC20,
} from "../../../typechain"
import type {
  BitcoinTxInfoStruct,
  DepositRevealInfoStruct,
} from "../../../typechain/L2BTCDepositorWormhole"
import { to1ePrecision } from "../../helpers/contract-test-helpers"
import {
  createMock,
  expectCalledOnce,
  expectCalledTwice,
  expectNotCalled,
} from "../../helpers/mock"
import type { Mock } from "../../helpers/mock"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time
// Just arbitrary values.
const l1ChainId = 10
const l2ChainId = 20

/** `sendVaasToEvm` passes `VaaTransfer[]`; deep `eql` fails on mixed BigNumber impls. */
function assertVaaTransferBatchArg(
  arg: unknown,
  expected: {
    emitterChainId: number
    emitterAddress: string
    sequence: BigNumberish
  }
) {
  const batch = arg as unknown[]
  expect(batch.length).to.equal(1)
  const v = batch[0] as [unknown, unknown, unknown]
  expect(Number(v[0])).to.equal(expected.emitterChainId)
  expect(v[1]).to.equal(expected.emitterAddress)
  expect(BigNumber.from(v[2]).eq(expected.sequence)).to.be.true
}

describe("L1BTCDepositorWormhole", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])

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
    // Just an arbitrary L2BTCDepositorWormhole address.
    const l2BtcDepositor = "0xeE6F5f69860f310114185677D017576aed0dEC83"
    const reimbursementPool = await createMock<ReimbursementPool>(
      "ReimbursementPool"
    )

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `L1BTCDepositorWormhole_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L1BTCDepositorWormhole",
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
    const l1BtcDepositor = deployment[0] as L1BTCDepositorWormhole

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
      l2BtcDepositor,
      reimbursementPool,
      l1BtcDepositor,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress

  let bridge: Mock<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: Mock<ITBTCVault>
  let wormhole: Mock<IWormhole>
  let wormholeRelayer: Mock<IWormholeRelayer>
  let wormholeTokenBridge: Mock<IWormholeTokenBridge>
  let l2WormholeGateway: Mock<IWormholeGateway>
  let l2BtcDepositor: string
  let reimbursementPool: Mock<ReimbursementPool>
  let l1BtcDepositor: L1BTCDepositorWormhole

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      relayer,
      bridge,
      tbtcToken,
      tbtcVault,
      wormhole,
      wormholeRelayer,
      wormholeTokenBridge,
      l2WormholeGateway,
      l1BtcDepositor,
      reimbursementPool,
      l2BtcDepositor,
    } = await loadFixture(contractsFixture))
  })

  describe("attachL2BtcDepositor", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcDepositor.connect(relayer).attachL2BtcDepositor(l2BtcDepositor)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      context("when the L2BTCDepositorWormhole is already attached", () => {
        before(async () => {
          await createSnapshot()

          await l1BtcDepositor
            .connect(governance)
            .attachL2BtcDepositor(l2BtcDepositor)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            l1BtcDepositor
              .connect(governance)
              .attachL2BtcDepositor(l2BtcDepositor)
          ).to.be.revertedWith("L2 Bitcoin Depositor already set")
        })
      })

      context("when the L2BTCDepositorWormhole is not attached", () => {
        context("when new L2BTCDepositorWormhole is zero", () => {
          it("should revert", async () => {
            await expect(
              l1BtcDepositor
                .connect(governance)
                .attachL2BtcDepositor(ethers.constants.AddressZero)
            ).to.be.revertedWith("L2 Bitcoin Depositor must not be 0x0")
          })
        })

        context("when new L2BTCDepositorWormhole is non-zero", () => {
          before(async () => {
            await createSnapshot()

            await l1BtcDepositor
              .connect(governance)
              .attachL2BtcDepositor(l2BtcDepositor)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should set the l2BtcDepositor address properly", async () => {
            expect(await l1BtcDepositor.l2BtcDepositor()).to.equal(
              l2BtcDepositor
            )
          })
        })
      })
    })
  })

  describe("updateReimbursementPool", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcDepositor
            .connect(relayer)
            .updateReimbursementPool(reimbursementPool.address)
        ).to.be.revertedWith("'Caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await l1BtcDepositor
          .connect(governance)
          .updateReimbursementPool(reimbursementPool.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the reimbursementPool address properly", async () => {
        expect(await l1BtcDepositor.reimbursementPool()).to.equal(
          reimbursementPool.address
        )
      })

      it("should emit ReimbursementPoolUpdated event", async () => {
        await expect(
          l1BtcDepositor
            .connect(governance)
            .updateReimbursementPool(reimbursementPool.address)
        )
          .to.emit(l1BtcDepositor, "ReimbursementPoolUpdated")
          .withArgs(reimbursementPool.address)
      })
    })
  })

  describe("updateL2FinalizeDepositGasLimit", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcDepositor.connect(relayer).updateL2FinalizeDepositGasLimit(100)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await l1BtcDepositor
          .connect(governance)
          .updateL2FinalizeDepositGasLimit(100)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the gas limit properly", async () => {
        expect(await l1BtcDepositor.l2FinalizeDepositGasLimit()).to.equal(100)
      })

      it("should emit L2FinalizeDepositGasLimitUpdated event", async () => {
        await expect(
          l1BtcDepositor
            .connect(governance)
            .updateL2FinalizeDepositGasLimit(100)
        )
          .to.emit(l1BtcDepositor, "L2FinalizeDepositGasLimitUpdated")
          .withArgs(100)
      })
    })
  })

  describe("updateGasOffsetParameters", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcDepositor.connect(relayer).updateGasOffsetParameters(1000, 2000)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await l1BtcDepositor
          .connect(governance)
          .updateGasOffsetParameters(1000, 2000)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the gas offset params properly", async () => {
        expect(await l1BtcDepositor.initializeDepositGasOffset()).to.be.equal(
          1000
        )

        expect(await l1BtcDepositor.finalizeDepositGasOffset()).to.be.equal(
          2000
        )
      })

      it("should emit GasOffsetParametersUpdated event", async () => {
        await expect(
          l1BtcDepositor
            .connect(governance)
            .updateGasOffsetParameters(1000, 2000)
        )
          .to.emit(l1BtcDepositor, "GasOffsetParametersUpdated")
          .withArgs(1000, 2000)
      })
    })
  })

  describe("updateReimbursementAuthorization", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BtcDepositor
            .connect(relayer)
            .updateReimbursementAuthorization(relayer.address, true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await l1BtcDepositor
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the authorization properly", async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await l1BtcDepositor.reimbursementAuthorizations(relayer.address)
        ).to.be.true
      })

      it("should emit ReimbursementAuthorizationUpdated event", async () => {
        await expect(tx)
          .to.emit(l1BtcDepositor, "ReimbursementAuthorizationUpdated")
          .withArgs(relayer.address, true)
      })
    })
  })

  describe("initializeDeposit", () => {
    context("when the L2 deposit owner is zero", () => {
      it("should revert", async () => {
        await expect(
          l1BtcDepositor
            .connect(relayer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              ethers.constants.HashZero
            )
        ).to.be.revertedWith("L2 deposit owner must not be 0x0")
      })
    })

    context("when the L2 deposit owner is non-zero", () => {
      context("when the requested vault is not TBTCVault", () => {
        it("should revert", async () => {
          const corruptedReveal = JSON.parse(
            JSON.stringify(initializeDepositFixture.reveal)
          )

          // Set another vault address deliberately. This value must be
          // different from the tbtcVaultAddress constant used in the fixture.
          corruptedReveal.vault = ethers.constants.AddressZero

          await expect(
            l1BtcDepositor
              .connect(relayer)
              .initializeDeposit(
                initializeDepositFixture.fundingTx,
                corruptedReveal,
                initializeDepositFixture.destinationChainDepositOwner
              )
          ).to.be.revertedWith("Vault address mismatch")
        })
      })

      context("when the requested vault is TBTCVault", () => {
        context("when the deposit state is wrong", () => {
          context("when the deposit state is Initialized", () => {
            before(async () => {
              await createSnapshot()

              await l1BtcDepositor
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
                )
            })

            after(async () => {
              await bridge.revealDepositWithExtraData.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                l1BtcDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )
              ).to.be.revertedWith("Wrong deposit state")
            })
          })

          context("when the deposit state is Finalized", () => {
            before(async () => {
              await createSnapshot()

              await l1BtcDepositor
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
                )

              // Set the Bridge mock to return a deposit state that allows
              // to finalize the deposit. Set only relevant fields.
              const revealedAt = (await lastBlockTime()) - 7200
              const finalizedAt = await lastBlockTime()
              await bridge.deposits
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns({
                  depositor: ethers.constants.AddressZero,
                  amount: BigNumber.from(100000),
                  revealedAt,
                  vault: ethers.constants.AddressZero,
                  treasuryFee: BigNumber.from(0),
                  sweptAt: finalizedAt,
                  extraData: ethers.constants.HashZero,
                })

              // Set the TBTCVault mock to return a deposit state
              // that allows to finalize the deposit.
              await tbtcVault.optimisticMintingRequests
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns([revealedAt, finalizedAt])

              // Set Wormhole mocks to allow deposit finalization.
              const messageFee = 1000
              const deliveryCost = 5000
              await wormhole.messageFee.returns(messageFee)
              await wormholeRelayer.quoteEVMDeliveryPrice.returns({
                nativePriceQuote: BigNumber.from(deliveryCost),
                targetChainRefundPerGasUnused: BigNumber.from(0),
              })
              await wormholeTokenBridge.transferTokensWithPayload.returns(0)
              await wormholeRelayer.sendVaasToEvm.returns(0)

              await l1BtcDepositor
                .connect(relayer)
                .finalizeDeposit(initializeDepositFixture.depositKey, {
                  value: messageFee + deliveryCost,
                })
            })

            after(async () => {
              await bridge.revealDepositWithExtraData.reset()
              await bridge.deposits.reset()
              await tbtcVault.optimisticMintingRequests.reset()
              await wormhole.messageFee.reset()
              await wormholeRelayer.quoteEVMDeliveryPrice.reset()
              await wormholeTokenBridge.transferTokensWithPayload.reset()
              await wormholeRelayer.sendVaasToEvm.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                l1BtcDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )
              ).to.be.revertedWith("Wrong deposit state")
            })
          })
        })

        context("when the deposit state is Unknown", () => {
          context("when the reimbursement pool is not set", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              await bridge.revealDepositWithExtraData
                .whenCalledWith(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
                )
                .returns()

              tx = await l1BtcDepositor
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
                )
            })

            after(async () => {
              await bridge.revealDepositWithExtraData.reset()

              await restoreSnapshot()
            })

            it("should reveal the deposit to the Bridge", async () => {
              // eslint-disable-next-line @typescript-eslint/no-unused-expressions
              await expectCalledOnce(bridge.revealDepositWithExtraData)

              const { fundingTx, reveal, destinationChainDepositOwner } =
                initializeDepositFixture

              // The `calledOnceWith` assertion is not used here because
              // it doesn't use deep equality comparison and returns false
              // despite comparing equal objects. We use a workaround
              // to compare the arguments manually.
              const call = await bridge.revealDepositWithExtraData.getCall(0)
              expect(call.args[0]).to.eql([
                fundingTx.version,
                fundingTx.inputVector,
                fundingTx.outputVector,
                fundingTx.locktime,
              ])
              expect(call.args[1]).to.eql([
                reveal.fundingOutputIndex,
                reveal.blindingFactor,
                reveal.walletPubKeyHash,
                reveal.refundPubKeyHash,
                reveal.refundLocktime,
                reveal.vault,
              ])
              expect(call.args[2]).to.eql(
                destinationChainDepositOwner.toLowerCase()
              )
            })

            it("should set the deposit state to Initialized", async () => {
              expect(
                await l1BtcDepositor.deposits(
                  initializeDepositFixture.depositKey
                )
              ).to.equal(1)
            })

            it("should emit DepositInitialized event", async () => {
              await expect(tx)
                .to.emit(l1BtcDepositor, "DepositInitialized")
                .withArgs(
                  initializeDepositFixture.depositKey,
                  initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                  relayer.address
                )
            })

            it("should not store the deferred gas reimbursement", async () => {
              const gr = await l1BtcDepositor.gasReimbursements(
                initializeDepositFixture.depositKey
              )
              expect(gr.receiver).to.equal(ethers.constants.AddressZero)
              expect(BigNumber.from(gr.gasSpent).eq(0)).to.be.true
            })
          })

          context(
            "when the reimbursement pool is set and caller is authorized",
            () => {
              let tx: ContractTransaction

              before(async () => {
                await createSnapshot()

                await bridge.revealDepositWithExtraData
                  .whenCalledWith(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )
                  .returns()

                await l1BtcDepositor
                  .connect(governance)
                  .updateReimbursementPool(reimbursementPool.address)

                await l1BtcDepositor
                  .connect(governance)
                  .updateReimbursementAuthorization(relayer.address, true)

                tx = await l1BtcDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )
              })

              after(async () => {
                await bridge.revealDepositWithExtraData.reset()

                await restoreSnapshot()
              })

              it("should reveal the deposit to the Bridge", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                await expectCalledOnce(bridge.revealDepositWithExtraData)

                const { fundingTx, reveal, destinationChainDepositOwner } =
                  initializeDepositFixture

                // The `calledOnceWith` assertion is not used here because
                // it doesn't use deep equality comparison and returns false
                // despite comparing equal objects. We use a workaround
                // to compare the arguments manually.
                const call = await bridge.revealDepositWithExtraData.getCall(0)
                expect(call.args[0]).to.eql([
                  fundingTx.version,
                  fundingTx.inputVector,
                  fundingTx.outputVector,
                  fundingTx.locktime,
                ])
                expect(call.args[1]).to.eql([
                  reveal.fundingOutputIndex,
                  reveal.blindingFactor,
                  reveal.walletPubKeyHash,
                  reveal.refundPubKeyHash,
                  reveal.refundLocktime,
                  reveal.vault,
                ])
                expect(call.args[2]).to.eql(
                  destinationChainDepositOwner.toLowerCase()
                )
              })

              it("should set the deposit state to Initialized", async () => {
                expect(
                  await l1BtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(1)
              })

              it("should emit DepositInitialized event", async () => {
                await expect(tx)
                  .to.emit(l1BtcDepositor, "DepositInitialized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                    relayer.address
                  )
              })

              it("should store the deferred gas reimbursement", async () => {
                const gasReimbursement = await l1BtcDepositor.gasReimbursements(
                  initializeDepositFixture.depositKey
                )

                expect(gasReimbursement.receiver).to.equal(relayer.address)
                // It doesn't make much sense to check the exact gas spent value
                // here because a Bridge mock is used in for testing and
                // the resulting value won't be realistic. We only check that
                // the gas spent is greater than zero which means the deferred
                // reimbursement has been recorded properly.
                expect(gasReimbursement.gasSpent.toNumber()).to.be.greaterThan(
                  0
                )
              })
            }
          )

          context(
            "when the reimbursement pool is set and caller is not authorized",
            () => {
              let tx: ContractTransaction

              before(async () => {
                await createSnapshot()

                await bridge.revealDepositWithExtraData
                  .whenCalledWith(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )
                  .returns()

                await l1BtcDepositor
                  .connect(governance)
                  .updateReimbursementPool(reimbursementPool.address)

                await l1BtcDepositor
                  .connect(governance)
                  .updateReimbursementAuthorization(relayer.address, false)

                tx = await l1BtcDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )
              })

              after(async () => {
                await bridge.revealDepositWithExtraData.reset()

                await restoreSnapshot()
              })

              it("should reveal the deposit to the Bridge", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                await expectCalledOnce(bridge.revealDepositWithExtraData)

                const { fundingTx, reveal, destinationChainDepositOwner } =
                  initializeDepositFixture

                // The `calledOnceWith` assertion is not used here because
                // it doesn't use deep equality comparison and returns false
                // despite comparing equal objects. We use a workaround
                // to compare the arguments manually.
                const call = await bridge.revealDepositWithExtraData.getCall(0)
                expect(call.args[0]).to.eql([
                  fundingTx.version,
                  fundingTx.inputVector,
                  fundingTx.outputVector,
                  fundingTx.locktime,
                ])
                expect(call.args[1]).to.eql([
                  reveal.fundingOutputIndex,
                  reveal.blindingFactor,
                  reveal.walletPubKeyHash,
                  reveal.refundPubKeyHash,
                  reveal.refundLocktime,
                  reveal.vault,
                ])
                expect(call.args[2]).to.eql(
                  destinationChainDepositOwner.toLowerCase()
                )
              })

              it("should set the deposit state to Initialized", async () => {
                expect(
                  await l1BtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(1)
              })

              it("should emit DepositInitialized event", async () => {
                await expect(tx)
                  .to.emit(l1BtcDepositor, "DepositInitialized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                    relayer.address
                  )
              })

              it("should not store the deferred gas reimbursement", async () => {
                const gr = await l1BtcDepositor.gasReimbursements(
                  initializeDepositFixture.depositKey
                )
                expect(gr.receiver).to.equal(ethers.constants.AddressZero)
                expect(BigNumber.from(gr.gasSpent).eq(0)).to.be.true
              })
            }
          )
        })
      })
    })
  })

  describe("finalizeDeposit", () => {
    before(async () => {
      await createSnapshot()

      // The L2BTCDepositorWormhole contract must be attached to the L1BTCDepositorWormhole
      // contract before the finalizeDeposit function is called.
      await l1BtcDepositor
        .connect(governance)
        .attachL2BtcDepositor(l2BtcDepositor)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the deposit state is wrong", () => {
      context("when the deposit state is Unknown", () => {
        it("should revert", async () => {
          await expect(
            l1BtcDepositor
              .connect(relayer)
              .finalizeDeposit(initializeDepositFixture.depositKey)
          ).to.be.revertedWith("Wrong deposit state")
        })
      })

      context("when the deposit state is Finalized", () => {
        before(async () => {
          await createSnapshot()

          await l1BtcDepositor
            .connect(relayer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.destinationChainDepositOwner
            )

          // Set the Bridge mock to return a deposit state that allows
          // to finalize the deposit. Set only relevant fields.
          const revealedAt = (await lastBlockTime()) - 7200
          const finalizedAt = await lastBlockTime()
          await bridge.deposits
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns({
              depositor: ethers.constants.AddressZero,
              amount: BigNumber.from(100000),
              revealedAt,
              vault: ethers.constants.AddressZero,
              treasuryFee: BigNumber.from(0),
              sweptAt: finalizedAt,
              extraData: ethers.constants.HashZero,
            })

          // Set the TBTCVault mock to return a deposit state
          // that allows to finalize the deposit.
          await tbtcVault.optimisticMintingRequests
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns([revealedAt, finalizedAt])

          // Set Wormhole mocks to allow deposit finalization.
          const messageFee = 1000
          const deliveryCost = 5000
          await wormhole.messageFee.returns(messageFee)
          await wormholeRelayer.quoteEVMDeliveryPrice.returns({
            nativePriceQuote: BigNumber.from(deliveryCost),
            targetChainRefundPerGasUnused: BigNumber.from(0),
          })
          await wormholeTokenBridge.transferTokensWithPayload.returns(0)
          await wormholeRelayer.sendVaasToEvm.returns(0)

          await l1BtcDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee + deliveryCost,
            })
        })

        after(async () => {
          await bridge.revealDepositWithExtraData.reset()
          await bridge.deposits.reset()
          await tbtcVault.optimisticMintingRequests.reset()
          await wormhole.messageFee.reset()
          await wormholeRelayer.quoteEVMDeliveryPrice.reset()
          await wormholeTokenBridge.transferTokensWithPayload.reset()
          await wormholeRelayer.sendVaasToEvm.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            l1BtcDepositor
              .connect(relayer)
              .finalizeDeposit(initializeDepositFixture.depositKey)
          ).to.be.revertedWith("Wrong deposit state")
        })
      })
    })

    context("when the deposit state is Initialized", () => {
      context("when the deposit is not finalized by the Bridge", () => {
        before(async () => {
          await createSnapshot()

          await l1BtcDepositor
            .connect(relayer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.destinationChainDepositOwner
            )

          // Set the Bridge mock to return a deposit state that does not allow
          // to finalize the deposit. Set only relevant fields.
          const revealedAt = (await lastBlockTime()) - 7200
          await bridge.deposits
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns({
              depositor: ethers.constants.AddressZero,
              amount: BigNumber.from(100000),
              revealedAt,
              vault: ethers.constants.AddressZero,
              treasuryFee: BigNumber.from(0),
              sweptAt: 0,
              extraData: ethers.constants.HashZero,
            })

          // Set the TBTCVault mock to return a deposit state
          // that does not allow to finalize the deposit.
          await tbtcVault.optimisticMintingRequests
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns([revealedAt, 0])
        })

        after(async () => {
          await bridge.revealDepositWithExtraData.reset()
          await bridge.deposits.reset()
          await tbtcVault.optimisticMintingRequests.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            l1BtcDepositor
              .connect(relayer)
              .finalizeDeposit(initializeDepositFixture.depositKey)
          ).to.be.revertedWith("Deposit not finalized by the bridge")
        })
      })

      context("when the deposit is finalized by the Bridge", () => {
        context("when normalized amount is too low to bridge", () => {
          before(async () => {
            await createSnapshot()

            await l1BtcDepositor
              .connect(relayer)
              .initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.destinationChainDepositOwner
              )

            // Set the Bridge mock to return a deposit state that pass the
            // finalization check but fails the normalized amount check.
            // Set only relevant fields.
            const revealedAt = (await lastBlockTime()) - 7200
            const finalizedAt = await lastBlockTime()
            await bridge.deposits
              .whenCalledWith(initializeDepositFixture.depositKey)
              .returns({
                depositor: ethers.constants.AddressZero,
                amount: BigNumber.from(0),
                revealedAt,
                vault: ethers.constants.AddressZero,
                treasuryFee: BigNumber.from(0),
                sweptAt: finalizedAt,
                extraData: ethers.constants.HashZero,
              })

            // Set the TBTCVault mock to return a deposit state that pass the
            // finalization check and move to the normalized amount check.
            await tbtcVault.optimisticMintingRequests
              .whenCalledWith(initializeDepositFixture.depositKey)
              .returns([revealedAt, finalizedAt])
          })

          after(async () => {
            await bridge.revealDepositWithExtraData.reset()
            await bridge.deposits.reset()
            await tbtcVault.optimisticMintingRequests.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              l1BtcDepositor
                .connect(relayer)
                .finalizeDeposit(initializeDepositFixture.depositKey)
            ).to.be.revertedWith("Amount too low to bridge")
          })
        })

        context("when normalized amount is not too low to bridge", () => {
          context("when payment for Wormhole Relayer is too low", () => {
            const messageFee = 1000
            const deliveryCost = 5000

            before(async () => {
              await createSnapshot()

              await l1BtcDepositor
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
                )

              // Set the Bridge mock to return a deposit state that allows
              // to finalize the deposit. Set only relevant fields.
              const revealedAt = (await lastBlockTime()) - 7200
              const finalizedAt = await lastBlockTime()
              await bridge.deposits
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns({
                  depositor: ethers.constants.AddressZero,
                  amount: BigNumber.from(100000),
                  revealedAt,
                  vault: ethers.constants.AddressZero,
                  treasuryFee: BigNumber.from(0),
                  sweptAt: finalizedAt,
                  extraData: ethers.constants.HashZero,
                })

              // Set the TBTCVault mock to return a deposit state
              // that allows to finalize the deposit.
              await tbtcVault.optimisticMintingRequests
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns([revealedAt, finalizedAt])

              // Set Wormhole mocks to allow deposit finalization.
              await wormhole.messageFee.returns(messageFee)
              await wormholeRelayer.quoteEVMDeliveryPrice.returns({
                nativePriceQuote: BigNumber.from(deliveryCost),
                targetChainRefundPerGasUnused: BigNumber.from(0),
              })
              await wormholeTokenBridge.transferTokensWithPayload.returns(0)
              await wormholeRelayer.sendVaasToEvm.returns(0)
            })

            after(async () => {
              await bridge.revealDepositWithExtraData.reset()
              await bridge.deposits.reset()
              await tbtcVault.optimisticMintingRequests.reset()
              await wormhole.messageFee.reset()
              await wormholeRelayer.quoteEVMDeliveryPrice.reset()
              await wormholeTokenBridge.transferTokensWithPayload.reset()
              await wormholeRelayer.sendVaasToEvm.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                l1BtcDepositor
                  .connect(relayer)
                  .finalizeDeposit(initializeDepositFixture.depositKey, {
                    // Use a value by 1 WEI less than required.
                    value: messageFee + deliveryCost - 1,
                  })
              ).to.be.revertedWith("Payment for Wormhole Relayer is too low")
            })
          })

          context("when payment for Wormhole Relayer is not too low", () => {
            const satoshiMultiplier = to1ePrecision(1, 10)
            const messageFee = 1000
            const deliveryCost = 5000
            const transferSequence = 10 // Just an arbitrary value.
            const depositAmount = BigNumber.from(100000)
            const treasuryFee = BigNumber.from(500)
            const optimisticMintingFeeDivisor = 20 // 5%
            const depositTxMaxFee = BigNumber.from(1000)

            // amountSubTreasury = (depositAmount - treasuryFee) * satoshiMultiplier = 99500 * 1e10
            // omFee = amountSubTreasury / optimisticMintingFeeDivisor = 4975 * 1e10
            // txMaxFee = depositTxMaxFee * satoshiMultiplier = 1000 * 1e10
            // tbtcAmount = amountSubTreasury - omFee - txMaxFee = 93525 * 1e10
            const expectedTbtcAmount = to1ePrecision(93525, 10)

            let tx: ContractTransaction

            context("when the reimbursement pool is not set", () => {
              before(async () => {
                await createSnapshot()

                await l1BtcDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )

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

                // Set the Bridge mock to return a deposit state that allows
                // to finalize the deposit.
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
                    extraData:
                      initializeDepositFixture.destinationChainDepositOwner,
                  })

                // Set the TBTCVault mock to return a deposit state
                // that allows to finalize the deposit.
                await tbtcVault.optimisticMintingRequests
                  .whenCalledWith(initializeDepositFixture.depositKey)
                  .returns([revealedAt, finalizedAt])

                // Set Wormhole mocks to allow deposit finalization.
                await wormhole.messageFee.returns(messageFee)
                await wormholeRelayer.quoteEVMDeliveryPrice.returns({
                  nativePriceQuote: BigNumber.from(deliveryCost),
                  targetChainRefundPerGasUnused: BigNumber.from(0),
                })
                await wormholeTokenBridge.transferTokensWithPayload.returns(
                  transferSequence
                )
                // Return arbitrary sent value.
                await wormholeRelayer.sendVaasToEvm.returns(100)

                tx = await l1BtcDepositor
                  .connect(relayer)
                  .finalizeDeposit(initializeDepositFixture.depositKey, {
                    value: messageFee + deliveryCost,
                  })
              })

              after(async () => {
                await bridge.depositParameters.reset()
                await tbtcVault.optimisticMintingFeeDivisor.reset()
                await bridge.revealDepositWithExtraData.reset()
                await bridge.deposits.reset()
                await tbtcVault.optimisticMintingRequests.reset()
                await wormhole.messageFee.reset()
                await wormholeRelayer.quoteEVMDeliveryPrice.reset()
                await wormholeTokenBridge.transferTokensWithPayload.reset()
                await wormholeRelayer.sendVaasToEvm.reset()

                await restoreSnapshot()
              })

              it("should set the deposit state to Finalized", async () => {
                expect(
                  await l1BtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(2)
              })

              it("should emit DepositFinalized event", async () => {
                await expect(tx)
                  .to.emit(l1BtcDepositor, "DepositFinalized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                    relayer.address,
                    depositAmount.mul(satoshiMultiplier),
                    expectedTbtcAmount
                  )
              })

              it("should increase TBTC allowance for Wormhole Token Bridge", async () => {
                expect(
                  await tbtcToken.allowance(
                    l1BtcDepositor.address,
                    wormholeTokenBridge.address
                  )
                ).to.equal(expectedTbtcAmount)
              })

              it("should create a proper Wormhole token transfer", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                await expectCalledOnce(
                  wormholeTokenBridge.transferTokensWithPayload
                )

                // The `calledOnceWith` assertion is not used here because
                // it doesn't use deep equality comparison and returns false
                // despite comparing equal objects. We use a workaround
                // to compare the arguments manually.
                const call =
                  await wormholeTokenBridge.transferTokensWithPayload.getCall(0)
                expect(call.value).to.equal(messageFee)
                expect(call.args[0]).to.equal(tbtcToken.address)
                expect(call.args[1]).to.equal(expectedTbtcAmount)
                expect(call.args[2]).to.equal(await l1BtcDepositor.l2ChainId())
                expect(call.args[3]).to.equal(
                  toWormholeAddress(l2WormholeGateway.address.toLowerCase())
                )
                expect(call.args[4]).to.equal(0)
                expect(call.args[5]).to.equal(
                  initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
                )
              })

              it("should send transfer VAA to L2", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                await expectCalledOnce(wormholeRelayer.sendVaasToEvm)

                // The `calledOnceWith` assertion is not used here because
                // it doesn't use deep equality comparison and returns false
                // despite comparing equal objects. We use a workaround
                // to compare the arguments manually.
                const call = await wormholeRelayer.sendVaasToEvm.getCall(0)
                expect(call.value).to.equal(deliveryCost)
                expect(call.args[0]).to.equal(await l1BtcDepositor.l2ChainId())
                expect(call.args[1]).to.equal(l2BtcDepositor)
                expect(call.args[2]).to.equal("0x")
                expect(call.args[3]).to.equal(0)
                expect(call.args[4]).to.equal(
                  await l1BtcDepositor.l2FinalizeDepositGasLimit()
                )
                assertVaaTransferBatchArg(call.args[5], {
                  emitterChainId: l1ChainId,
                  emitterAddress: toWormholeAddress(
                    wormholeTokenBridge.address.toLowerCase()
                  ),
                  sequence: transferSequence,
                })
                expect(call.args[6]).to.equal(await l1BtcDepositor.l2ChainId())
                expect(call.args[7]).to.equal(relayer.address)
              })

              it("should not call the reimbursement pool", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                await expectNotCalled(reimbursementPool.refund)
              })
            })

            context(
              "when the reimbursement pool is set and caller is authorized",
              () => {
                // Use 1Gwei to make sure it's smaller than default gas price
                // used by Hardhat (200 Gwei) and this value will be used
                // for msgValueOffset calculation.
                const reimbursementPoolMaxGasPrice = BigNumber.from(1000000000)
                const reimbursementPoolStaticGas = 10000 // Just an arbitrary value.

                let initializeDepositGasSpent: BigNumber

                before(async () => {
                  await createSnapshot()

                  await reimbursementPool.maxGasPrice.returns(
                    reimbursementPoolMaxGasPrice
                  )
                  await reimbursementPool.staticGas.returns(
                    reimbursementPoolStaticGas
                  )

                  await l1BtcDepositor
                    .connect(governance)
                    .updateReimbursementPool(reimbursementPool.address)

                  await l1BtcDepositor
                    .connect(governance)
                    .updateReimbursementAuthorization(relayer.address, true)

                  await l1BtcDepositor
                    .connect(relayer)
                    .initializeDeposit(
                      initializeDepositFixture.fundingTx,
                      initializeDepositFixture.reveal,
                      initializeDepositFixture.destinationChainDepositOwner
                    )

                  // Capture the gas spent for the initializeDeposit call
                  // for post-finalization comparison.
                  initializeDepositGasSpent = (
                    await l1BtcDepositor.gasReimbursements(
                      initializeDepositFixture.depositKey
                    )
                  ).gasSpent

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

                  // Set the Bridge mock to return a deposit state that allows
                  // to finalize the deposit.
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
                      extraData:
                        initializeDepositFixture.destinationChainDepositOwner,
                    })

                  // Set the TBTCVault mock to return a deposit state
                  // that allows to finalize the deposit.
                  await tbtcVault.optimisticMintingRequests
                    .whenCalledWith(initializeDepositFixture.depositKey)
                    .returns([revealedAt, finalizedAt])

                  // Set Wormhole mocks to allow deposit finalization.
                  await wormhole.messageFee.returns(messageFee)
                  await wormholeRelayer.quoteEVMDeliveryPrice.returns({
                    nativePriceQuote: BigNumber.from(deliveryCost),
                    targetChainRefundPerGasUnused: BigNumber.from(0),
                  })
                  await wormholeTokenBridge.transferTokensWithPayload.returns(
                    transferSequence
                  )
                  // Return arbitrary sent value.
                  await wormholeRelayer.sendVaasToEvm.returns(100)

                  tx = await l1BtcDepositor
                    .connect(relayer)
                    .finalizeDeposit(initializeDepositFixture.depositKey, {
                      value: messageFee + deliveryCost,
                    })
                })

                after(async () => {
                  await reimbursementPool.maxGasPrice.reset()
                  await reimbursementPool.staticGas.reset()
                  await reimbursementPool.refund.reset()
                  await bridge.depositParameters.reset()
                  await tbtcVault.optimisticMintingFeeDivisor.reset()
                  await bridge.revealDepositWithExtraData.reset()
                  await bridge.deposits.reset()
                  await tbtcVault.optimisticMintingRequests.reset()
                  await wormhole.messageFee.reset()
                  await wormholeRelayer.quoteEVMDeliveryPrice.reset()
                  await wormholeTokenBridge.transferTokensWithPayload.reset()
                  await wormholeRelayer.sendVaasToEvm.reset()

                  await restoreSnapshot()
                })

                it("should set the deposit state to Finalized", async () => {
                  expect(
                    await l1BtcDepositor.deposits(
                      initializeDepositFixture.depositKey
                    )
                  ).to.equal(2)
                })

                it("should emit DepositFinalized event", async () => {
                  await expect(tx)
                    .to.emit(l1BtcDepositor, "DepositFinalized")
                    .withArgs(
                      initializeDepositFixture.depositKey,
                      initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                      relayer.address,
                      depositAmount.mul(satoshiMultiplier),
                      expectedTbtcAmount
                    )
                })

                it("should increase TBTC allowance for Wormhole Token Bridge", async () => {
                  expect(
                    await tbtcToken.allowance(
                      l1BtcDepositor.address,
                      wormholeTokenBridge.address
                    )
                  ).to.equal(expectedTbtcAmount)
                })

                it("should create a proper Wormhole token transfer", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  await expectCalledOnce(
                    wormholeTokenBridge.transferTokensWithPayload
                  )

                  // The `calledOnceWith` assertion is not used here because
                  // it doesn't use deep equality comparison and returns false
                  // despite comparing equal objects. We use a workaround
                  // to compare the arguments manually.
                  const call =
                    await wormholeTokenBridge.transferTokensWithPayload.getCall(
                      0
                    )
                  expect(call.value).to.equal(messageFee)
                  expect(call.args[0]).to.equal(tbtcToken.address)
                  expect(call.args[1]).to.equal(expectedTbtcAmount)
                  expect(call.args[2]).to.equal(
                    await l1BtcDepositor.l2ChainId()
                  )
                  expect(call.args[3]).to.equal(
                    toWormholeAddress(l2WormholeGateway.address.toLowerCase())
                  )
                  expect(call.args[4]).to.equal(0)
                  expect(call.args[5]).to.equal(
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
                  )
                })

                it("should send transfer VAA to L2", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  await expectCalledOnce(wormholeRelayer.sendVaasToEvm)

                  // The `calledOnceWith` assertion is not used here because
                  // it doesn't use deep equality comparison and returns false
                  // despite comparing equal objects. We use a workaround
                  // to compare the arguments manually.
                  const call = await wormholeRelayer.sendVaasToEvm.getCall(0)
                  expect(call.value).to.equal(deliveryCost)
                  expect(call.args[0]).to.equal(
                    await l1BtcDepositor.l2ChainId()
                  )
                  expect(call.args[1]).to.equal(l2BtcDepositor)
                  expect(call.args[2]).to.equal("0x")
                  expect(call.args[3]).to.equal(0)
                  expect(call.args[4]).to.equal(
                    await l1BtcDepositor.l2FinalizeDepositGasLimit()
                  )
                  assertVaaTransferBatchArg(call.args[5], {
                    emitterChainId: l1ChainId,
                    emitterAddress: toWormholeAddress(
                      wormholeTokenBridge.address.toLowerCase()
                    ),
                    sequence: transferSequence,
                  })
                  expect(call.args[6]).to.equal(
                    await l1BtcDepositor.l2ChainId()
                  )
                  expect(call.args[7]).to.equal(relayer.address)
                })

                it("should reimburse finalization before initialization", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  await expectCalledTwice(reimbursementPool.refund)

                  // Pay the finalization reimbursement first so gas consumed
                  // by the deferred reimbursement's untrusted receiver cannot
                  // be counted again in this calculation.
                  const call1 = await reimbursementPool.refund.getCall(0)
                  // It doesn't make much sense to check the exact gas spent
                  // value here because Wormhole contracts mocks are used for
                  // testing and the resulting value won't be realistic.
                  // We only check that the reimbursement is greater than the
                  // message value attached to the finalizeDeposit call which
                  // is a good indicator that the reimbursement has been
                  // calculated properly.
                  const msgValueOffset = BigNumber.from(
                    messageFee + deliveryCost
                  )
                    .div(reimbursementPoolMaxGasPrice)
                    .sub(reimbursementPoolStaticGas)
                  expect(
                    BigNumber.from(call1.args[0]).toNumber()
                  ).to.be.greaterThan(msgValueOffset.toNumber())
                  expect(call1.args[1]).to.equal(relayer.address)

                  // Second call is the deferred gas reimbursement for deposit
                  // initialization and must use the exact stored value.
                  const call2 = await reimbursementPool.refund.getCall(1)
                  expect(call2.args[0]).to.equal(initializeDepositGasSpent)
                  expect(call2.args[1]).to.equal(relayer.address)
                })
              }
            )

            context(
              "when the reimbursement pool is set and caller is not authorized",
              () => {
                // Use 1Gwei to make sure it's smaller than default gas price
                // used by Hardhat (200 Gwei) and this value will be used
                // for msgValueOffset calculation.
                const reimbursementPoolMaxGasPrice = BigNumber.from(1000000000)
                const reimbursementPoolStaticGas = 10000 // Just an arbitrary value.

                let initializeDepositGasSpent: BigNumber

                before(async () => {
                  await createSnapshot()

                  await reimbursementPool.maxGasPrice.returns(
                    reimbursementPoolMaxGasPrice
                  )
                  await reimbursementPool.staticGas.returns(
                    reimbursementPoolStaticGas
                  )

                  await l1BtcDepositor
                    .connect(governance)
                    .updateReimbursementPool(reimbursementPool.address)

                  // Authorize just for deposit initialization.
                  await l1BtcDepositor
                    .connect(governance)
                    .updateReimbursementAuthorization(relayer.address, true)

                  await l1BtcDepositor
                    .connect(relayer)
                    .initializeDeposit(
                      initializeDepositFixture.fundingTx,
                      initializeDepositFixture.reveal,
                      initializeDepositFixture.destinationChainDepositOwner
                    )

                  // Capture the gas spent for the initializeDeposit call
                  // for post-finalization comparison.
                  initializeDepositGasSpent = (
                    await l1BtcDepositor.gasReimbursements(
                      initializeDepositFixture.depositKey
                    )
                  ).gasSpent

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

                  // Set the Bridge mock to return a deposit state that allows
                  // to finalize the deposit.
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
                      extraData:
                        initializeDepositFixture.destinationChainDepositOwner,
                    })

                  // Set the TBTCVault mock to return a deposit state
                  // that allows to finalize the deposit.
                  await tbtcVault.optimisticMintingRequests
                    .whenCalledWith(initializeDepositFixture.depositKey)
                    .returns([revealedAt, finalizedAt])

                  // Set Wormhole mocks to allow deposit finalization.
                  await wormhole.messageFee.returns(messageFee)
                  await wormholeRelayer.quoteEVMDeliveryPrice.returns({
                    nativePriceQuote: BigNumber.from(deliveryCost),
                    targetChainRefundPerGasUnused: BigNumber.from(0),
                  })
                  await wormholeTokenBridge.transferTokensWithPayload.returns(
                    transferSequence
                  )
                  // Return arbitrary sent value.
                  await wormholeRelayer.sendVaasToEvm.returns(100)

                  // De-authorize for deposit finalization.
                  await l1BtcDepositor
                    .connect(governance)
                    .updateReimbursementAuthorization(relayer.address, false)

                  tx = await l1BtcDepositor
                    .connect(relayer)
                    .finalizeDeposit(initializeDepositFixture.depositKey, {
                      value: messageFee + deliveryCost,
                    })
                })

                after(async () => {
                  await reimbursementPool.maxGasPrice.reset()
                  await reimbursementPool.staticGas.reset()
                  await reimbursementPool.refund.reset()
                  await bridge.depositParameters.reset()
                  await tbtcVault.optimisticMintingFeeDivisor.reset()
                  await bridge.revealDepositWithExtraData.reset()
                  await bridge.deposits.reset()
                  await tbtcVault.optimisticMintingRequests.reset()
                  await wormhole.messageFee.reset()
                  await wormholeRelayer.quoteEVMDeliveryPrice.reset()
                  await wormholeTokenBridge.transferTokensWithPayload.reset()
                  await wormholeRelayer.sendVaasToEvm.reset()

                  await restoreSnapshot()
                })

                it("should set the deposit state to Finalized", async () => {
                  expect(
                    await l1BtcDepositor.deposits(
                      initializeDepositFixture.depositKey
                    )
                  ).to.equal(2)
                })

                it("should emit DepositFinalized event", async () => {
                  await expect(tx)
                    .to.emit(l1BtcDepositor, "DepositFinalized")
                    .withArgs(
                      initializeDepositFixture.depositKey,
                      initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                      relayer.address,
                      depositAmount.mul(satoshiMultiplier),
                      expectedTbtcAmount
                    )
                })

                it("should increase TBTC allowance for Wormhole Token Bridge", async () => {
                  expect(
                    await tbtcToken.allowance(
                      l1BtcDepositor.address,
                      wormholeTokenBridge.address
                    )
                  ).to.equal(expectedTbtcAmount)
                })

                it("should create a proper Wormhole token transfer", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  await expectCalledOnce(
                    wormholeTokenBridge.transferTokensWithPayload
                  )

                  // The `calledOnceWith` assertion is not used here because
                  // it doesn't use deep equality comparison and returns false
                  // despite comparing equal objects. We use a workaround
                  // to compare the arguments manually.
                  const call =
                    await wormholeTokenBridge.transferTokensWithPayload.getCall(
                      0
                    )
                  expect(call.value).to.equal(messageFee)
                  expect(call.args[0]).to.equal(tbtcToken.address)
                  expect(call.args[1]).to.equal(expectedTbtcAmount)
                  expect(call.args[2]).to.equal(
                    await l1BtcDepositor.l2ChainId()
                  )
                  expect(call.args[3]).to.equal(
                    toWormholeAddress(l2WormholeGateway.address.toLowerCase())
                  )
                  expect(call.args[4]).to.equal(0)
                  expect(call.args[5]).to.equal(
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
                  )
                })

                it("should send transfer VAA to L2", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  await expectCalledOnce(wormholeRelayer.sendVaasToEvm)

                  // The `calledOnceWith` assertion is not used here because
                  // it doesn't use deep equality comparison and returns false
                  // despite comparing equal objects. We use a workaround
                  // to compare the arguments manually.
                  const call = await wormholeRelayer.sendVaasToEvm.getCall(0)
                  expect(call.value).to.equal(deliveryCost)
                  expect(call.args[0]).to.equal(
                    await l1BtcDepositor.l2ChainId()
                  )
                  expect(call.args[1]).to.equal(l2BtcDepositor)
                  expect(call.args[2]).to.equal("0x")
                  expect(call.args[3]).to.equal(0)
                  expect(call.args[4]).to.equal(
                    await l1BtcDepositor.l2FinalizeDepositGasLimit()
                  )
                  assertVaaTransferBatchArg(call.args[5], {
                    emitterChainId: l1ChainId,
                    emitterAddress: toWormholeAddress(
                      wormholeTokenBridge.address.toLowerCase()
                    ),
                    sequence: transferSequence,
                  })
                  expect(call.args[6]).to.equal(
                    await l1BtcDepositor.l2ChainId()
                  )
                  expect(call.args[7]).to.equal(relayer.address)
                })

                it("should pay out proper reimbursements", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  await expectCalledOnce(reimbursementPool.refund)

                  // The only call is the deferred gas reimbursement for deposit
                  // initialization. The call for finalization should not
                  // occur as the caller was de-authorized.
                  const call = await reimbursementPool.refund.getCall(0)
                  // Should reimburse the exact value stored upon deposit initialization.
                  expect(call.args[0]).to.equal(initializeDepositGasSpent)
                  expect(call.args[1]).to.equal(relayer.address)
                })
              }
            )
          })
        })
      })
    })
  })

  describe("quoteFinalizeDeposit", () => {
    before(async () => {
      await createSnapshot()

      await wormhole.messageFee.returns(1000)

      await wormholeRelayer.quoteEVMDeliveryPrice
        .whenCalledWith(
          await l1BtcDepositor.l2ChainId(),
          0,
          await l1BtcDepositor.l2FinalizeDepositGasLimit()
        )
        .returns({
          nativePriceQuote: BigNumber.from(5000),
          targetChainRefundPerGasUnused: BigNumber.from(0),
        })
    })

    after(async () => {
      await wormhole.messageFee.reset()
      await wormholeRelayer.quoteEVMDeliveryPrice.reset()

      await restoreSnapshot()
    })

    it("should return the correct cost", async () => {
      const cost = await l1BtcDepositor.quoteFinalizeDeposit()
      expect(cost).to.be.equal(6000) // delivery cost + message fee
    })
  })

  context("when reimburseTxMaxFee is true", () => {
    const satoshiMultiplier = to1ePrecision(1, 10)
    const messageFee = 1000
    const deliveryCost = 5000
    const depositTxMaxFee = BigNumber.from(1000)
    const depositAmount = BigNumber.from(100000)
    const treasuryFee = BigNumber.from(500)
    const optimisticMintingFeeDivisor = 20

    // For depositAmount=100000 & treasuryFee=500:
    // (depositAmount - treasuryFee)=99500
    // => *1e10 => 99500e10
    // => omFee= (99500e10 /20)=4975e10
    // => depositTxMaxFee => 1000e10
    //
    // The standard _calculateTbtcAmount would do: 99500e10 -4975e10 -1000e10=93525e10
    // Because we reimburse depositTxMaxFee, we add 1000e10 back => 94525e10
    const expectedTbtcAmountBase = to1ePrecision(93525, 10)
    const expectedTbtcAmountReimbursed = to1ePrecision(94525, 10)

    beforeEach(async () => {
      await createSnapshot()

      // Turn the feature flag on
      await l1BtcDepositor.connect(governance).setReimburseTxMaxFee(true)

      // The L2BTCDepositorWormhole contract must be attached
      if (
        (await l1BtcDepositor.l2BtcDepositor()) === ethers.constants.AddressZero
      ) {
        await l1BtcDepositor
          .connect(governance)
          .attachL2BtcDepositor(l2BtcDepositor)
      }
    })

    afterEach(async () => {
      await bridge.depositParameters.reset()
      await tbtcVault.optimisticMintingFeeDivisor.reset()
      await bridge.revealDepositWithExtraData.reset()
      await bridge.deposits.reset()
      await tbtcVault.optimisticMintingRequests.reset()
      await wormhole.messageFee.reset()
      await wormholeRelayer.quoteEVMDeliveryPrice.reset()
      await wormholeTokenBridge.transferTokensWithPayload.reset()
      await wormholeRelayer.sendVaasToEvm.reset()

      await restoreSnapshot()
    })

    it("should add depositTxMaxFee back to the minted TBTC amount", async () => {
      // 1) Initialize deposit
      await l1BtcDepositor
        .connect(relayer)
        .initializeDeposit(
          initializeDepositFixture.fundingTx,
          initializeDepositFixture.reveal,
          initializeDepositFixture.destinationChainDepositOwner
        )

      // 2) Setup Bridge deposit parameters
      await bridge.depositParameters.returns({
        depositDustThreshold: 0,
        depositTreasuryFeeDivisor: 0,
        depositTxMaxFee,
        depositRevealAheadPeriod: 0,
      })
      // 3) Setup vault fees
      await tbtcVault.optimisticMintingFeeDivisor.returns(
        optimisticMintingFeeDivisor
      )

      // 4) Prepare deposit finalization
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

      // 5) Setup Wormhole cost
      await wormhole.messageFee.returns(messageFee)
      await wormholeRelayer.quoteEVMDeliveryPrice.returns({
        nativePriceQuote: BigNumber.from(deliveryCost),
        targetChainRefundPerGasUnused: BigNumber.from(0),
      })

      // 6) The bridging calls
      await wormholeTokenBridge.transferTokensWithPayload.returns(555)
      await wormholeRelayer.sendVaasToEvm.returns(999)

      // 7) Mint enough tBTC to cover the reimbursed amount.
      await tbtcToken.mint(l1BtcDepositor.address, expectedTbtcAmountReimbursed)

      // 8) Now finalize with enough payment
      const tx = await l1BtcDepositor
        .connect(relayer)
        .finalizeDeposit(initializeDepositFixture.depositKey, {
          value: messageFee + deliveryCost,
        })

      // 9) The final minted TBTC should be 94525e10
      await expect(tx)
        .to.emit(l1BtcDepositor, "DepositFinalized")
        .withArgs(
          initializeDepositFixture.depositKey,
          initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
          relayer.address,
          depositAmount.mul(satoshiMultiplier),
          expectedTbtcAmountReimbursed
        )
    })

    it("should skip depositTxMaxFee reimbursement when contract balance cannot cover it", async () => {
      // 1) Initialize deposit
      await l1BtcDepositor
        .connect(relayer)
        .initializeDeposit(
          initializeDepositFixture.fundingTx,
          initializeDepositFixture.reveal,
          initializeDepositFixture.destinationChainDepositOwner
        )

      // 2) Setup Bridge deposit parameters
      await bridge.depositParameters.returns({
        depositDustThreshold: 0,
        depositTreasuryFeeDivisor: 0,
        depositTxMaxFee,
        depositRevealAheadPeriod: 0,
      })
      // 3) Setup vault fees
      await tbtcVault.optimisticMintingFeeDivisor.returns(
        optimisticMintingFeeDivisor
      )

      // 4) Prepare deposit finalization
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

      // 5) Setup Wormhole cost
      await wormhole.messageFee.returns(messageFee)
      await wormholeRelayer.quoteEVMDeliveryPrice.returns({
        nativePriceQuote: BigNumber.from(deliveryCost),
        targetChainRefundPerGasUnused: BigNumber.from(0),
      })

      // 6) The bridging calls
      await wormholeTokenBridge.transferTokensWithPayload.returns(555)
      await wormholeRelayer.sendVaasToEvm.returns(999)

      // 7) Mint only the base tBTC amount, simulating a contract balance that
      // cannot cover the extra depositTxMaxFee reimbursement.
      await tbtcToken.mint(l1BtcDepositor.address, expectedTbtcAmountBase)

      // 8) Now finalize with enough payment
      const tx = await l1BtcDepositor
        .connect(relayer)
        .finalizeDeposit(initializeDepositFixture.depositKey, {
          value: messageFee + deliveryCost,
        })

      const txMaxFee = depositTxMaxFee.mul(satoshiMultiplier)
      await expect(tx)
        .to.emit(l1BtcDepositor, "DepositTxMaxFeeReimbursementSkipped")
        .withArgs(
          initializeDepositFixture.depositKey,
          txMaxFee,
          expectedTbtcAmountBase
        )

      await expect(tx)
        .to.emit(l1BtcDepositor, "DepositFinalized")
        .withArgs(
          initializeDepositFixture.depositKey,
          initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
          relayer.address,
          depositAmount.mul(satoshiMultiplier),
          expectedTbtcAmountBase
        )
    })
  })
})

// Just an arbitrary TBTCVault address.
const tbtcVaultAddress = "0xB5679dE944A79732A75CE556191DF11F489448d5"

export type InitializeDepositFixture = {
  // Deposit key built as keccak256(fundingTxHash, reveal.fundingOutputIndex)
  depositKey: string
  fundingTx: BitcoinTxInfoStruct
  reveal: DepositRevealInfoStruct
  destinationChainDepositOwner: string
}

// Fixture used for initializeDeposit test scenario.
export const initializeDepositFixture: InitializeDepositFixture = {
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
  destinationChainDepositOwner: toWormholeAddress(
    "0x23b82a7108F9CEb34C3CDC44268be21D151d4124"
  ),
}

// eslint-disable-next-line import/prefer-default-export
export function toWormholeAddress(address: string): string {
  return `0x000000000000000000000000${address.slice(2)}`
}
