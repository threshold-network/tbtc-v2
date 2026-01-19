import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import {
  IBridge,
  IL2WormholeGateway,
  ITBTCVault,
  IWormhole,
  IWormholeRelayer,
  IWormholeTokenBridge,
  L1BitcoinDepositor,
  ReimbursementPool,
  TestERC20,
} from "../../../typechain"
import type {
  BitcoinTxInfoStruct,
  DepositRevealInfoStruct,
} from "../../../typechain/L2BitcoinDepositor"
import { to1ePrecision } from "../../helpers/contract-test-helpers"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time
// Just arbitrary values.
const l1ChainId = 10
const l2ChainId = 20

describe("L1BitcoinDepositor", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const relayer = await ethers.getSigner(accounts[1])

    const bridge = await smock.fake<IBridge>("IBridge")
    const tbtcToken = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()
    const tbtcVault = await smock.fake<ITBTCVault>("ITBTCVault", {
      // The TBTCVault contract address must be known in advance and match
      // the one used in initializeDeposit fixture. This is necessary to
      // pass the vault address check in the initializeDeposit function.
      address: tbtcVaultAddress,
    })
    // Attach the tbtcToken mock to the tbtcVault mock.
    tbtcVault.tbtcToken.returns(tbtcToken.address)

    const wormhole = await smock.fake<IWormhole>("IWormhole")
    wormhole.chainId.returns(l1ChainId)

    const wormholeRelayer = await smock.fake<IWormholeRelayer>(
      "IWormholeRelayer"
    )
    const wormholeTokenBridge = await smock.fake<IWormholeTokenBridge>(
      "IWormholeTokenBridge"
    )
    const l2WormholeGateway = await smock.fake<IL2WormholeGateway>(
      "IL2WormholeGateway"
    )
    // Just an arbitrary L2BitcoinDepositor address.
    const l2BitcoinDepositor = "0xeE6F5f69860f310114185677D017576aed0dEC83"
    const reimbursementPool = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `L1BitcoinDepositor_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L1BitcoinDepositor",
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
    const l1BitcoinDepositor = deployment[0] as L1BitcoinDepositor

    await l1BitcoinDepositor
      .connect(deployer)
      .transferOwnership(governance.address)

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
      l1BitcoinDepositor,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress

  let bridge: FakeContract<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: FakeContract<ITBTCVault>
  let wormhole: FakeContract<IWormhole>
  let wormholeRelayer: FakeContract<IWormholeRelayer>
  let wormholeTokenBridge: FakeContract<IWormholeTokenBridge>
  let l2WormholeGateway: FakeContract<IL2WormholeGateway>
  let l2BitcoinDepositor: string
  let reimbursementPool: FakeContract<ReimbursementPool>
  let l1BitcoinDepositor: L1BitcoinDepositor

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
      l1BitcoinDepositor,
      reimbursementPool,
      l2BitcoinDepositor,
    } = await waffle.loadFixture(contractsFixture))
  })

  describe("attachL2BitcoinDepositor", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BitcoinDepositor
            .connect(relayer)
            .attachL2BitcoinDepositor(l2BitcoinDepositor)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      context("when the L2BitcoinDepositor is already attached", () => {
        before(async () => {
          await createSnapshot()

          await l1BitcoinDepositor
            .connect(governance)
            .attachL2BitcoinDepositor(l2BitcoinDepositor)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            l1BitcoinDepositor
              .connect(governance)
              .attachL2BitcoinDepositor(l2BitcoinDepositor)
          ).to.be.revertedWith("L2 Bitcoin Depositor already set")
        })
      })

      context("when the L2BitcoinDepositor is not attached", () => {
        context("when new L2BitcoinDepositor is zero", () => {
          it("should revert", async () => {
            await expect(
              l1BitcoinDepositor
                .connect(governance)
                .attachL2BitcoinDepositor(ethers.constants.AddressZero)
            ).to.be.revertedWith("L2 Bitcoin Depositor must not be 0x0")
          })
        })

        context("when new L2BitcoinDepositor is non-zero", () => {
          before(async () => {
            await createSnapshot()

            await l1BitcoinDepositor
              .connect(governance)
              .attachL2BitcoinDepositor(l2BitcoinDepositor)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should set the l2BitcoinDepositor address properly", async () => {
            expect(await l1BitcoinDepositor.l2BitcoinDepositor()).to.equal(
              l2BitcoinDepositor
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
          l1BitcoinDepositor
            .connect(relayer)
            .updateReimbursementPool(reimbursementPool.address)
        ).to.be.revertedWith("'Caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await l1BitcoinDepositor
          .connect(governance)
          .updateReimbursementPool(reimbursementPool.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the reimbursementPool address properly", async () => {
        expect(await l1BitcoinDepositor.reimbursementPool()).to.equal(
          reimbursementPool.address
        )
      })

      it("should emit ReimbursementPoolUpdated event", async () => {
        await expect(
          l1BitcoinDepositor
            .connect(governance)
            .updateReimbursementPool(reimbursementPool.address)
        )
          .to.emit(l1BitcoinDepositor, "ReimbursementPoolUpdated")
          .withArgs(reimbursementPool.address)
      })
    })
  })

  describe("updateL2FinalizeDepositGasLimit", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BitcoinDepositor
            .connect(relayer)
            .updateL2FinalizeDepositGasLimit(100)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await l1BitcoinDepositor
          .connect(governance)
          .updateL2FinalizeDepositGasLimit(100)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the gas limit properly", async () => {
        expect(await l1BitcoinDepositor.l2FinalizeDepositGasLimit()).to.equal(
          100
        )
      })

      it("should emit L2FinalizeDepositGasLimitUpdated event", async () => {
        await expect(
          l1BitcoinDepositor
            .connect(governance)
            .updateL2FinalizeDepositGasLimit(100)
        )
          .to.emit(l1BitcoinDepositor, "L2FinalizeDepositGasLimitUpdated")
          .withArgs(100)
      })
    })
  })

  describe("updateGasOffsetParameters", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BitcoinDepositor
            .connect(relayer)
            .updateGasOffsetParameters(1000, 2000)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await l1BitcoinDepositor
          .connect(governance)
          .updateGasOffsetParameters(1000, 2000)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the gas offset params properly", async () => {
        expect(
          await l1BitcoinDepositor.initializeDepositGasOffset()
        ).to.be.equal(1000)

        expect(await l1BitcoinDepositor.finalizeDepositGasOffset()).to.be.equal(
          2000
        )
      })

      it("should emit GasOffsetParametersUpdated event", async () => {
        await expect(
          l1BitcoinDepositor
            .connect(governance)
            .updateGasOffsetParameters(1000, 2000)
        )
          .to.emit(l1BitcoinDepositor, "GasOffsetParametersUpdated")
          .withArgs(1000, 2000)
      })
    })
  })

  describe("updateReimbursementAuthorization", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          l1BitcoinDepositor
            .connect(relayer)
            .updateReimbursementAuthorization(relayer.address, true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await l1BitcoinDepositor
          .connect(governance)
          .updateReimbursementAuthorization(relayer.address, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the authorization properly", async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await l1BitcoinDepositor.reimbursementAuthorizations(relayer.address)
        ).to.be.true
      })

      it("should emit ReimbursementAuthorizationUpdated event", async () => {
        await expect(tx)
          .to.emit(l1BitcoinDepositor, "ReimbursementAuthorizationUpdated")
          .withArgs(relayer.address, true)
      })
    })
  })

  describe("initializeDeposit", () => {
    context("when the L2 deposit owner is zero", () => {
      it("should revert", async () => {
        await expect(
          l1BitcoinDepositor
            .connect(relayer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              ethers.constants.AddressZero
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
            l1BitcoinDepositor
              .connect(relayer)
              .initializeDeposit(
                initializeDepositFixture.fundingTx,
                corruptedReveal,
                initializeDepositFixture.l2DepositOwner
              )
          ).to.be.revertedWith("Vault address mismatch")
        })
      })

      context("when the requested vault is TBTCVault", () => {
        context("when the deposit state is wrong", () => {
          context("when the deposit state is Initialized", () => {
            before(async () => {
              await createSnapshot()

              await l1BitcoinDepositor
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.l2DepositOwner
                )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                l1BitcoinDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.l2DepositOwner
                  )
              ).to.be.revertedWith("Wrong deposit state")
            })
          })

          context("when the deposit state is Finalized", () => {
            before(async () => {
              await createSnapshot()

              await l1BitcoinDepositor
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.l2DepositOwner
                )

              // Set the Bridge mock to return a deposit state that allows
              // to finalize the deposit. Set only relevant fields.
              const revealedAt = (await lastBlockTime()) - 7200
              const finalizedAt = await lastBlockTime()
              bridge.deposits
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
              tbtcVault.optimisticMintingRequests
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns([revealedAt, finalizedAt])

              // Set Wormhole mocks to allow deposit finalization.
              const messageFee = 1000
              const deliveryCost = 5000
              wormhole.messageFee.returns(messageFee)
              wormholeRelayer.quoteEVMDeliveryPrice.returns({
                nativePriceQuote: BigNumber.from(deliveryCost),
                targetChainRefundPerGasUnused: BigNumber.from(0),
              })
              wormholeTokenBridge.transferTokensWithPayload.returns(0)
              wormholeRelayer.sendVaasToEvm.returns(0)

              await l1BitcoinDepositor
                .connect(relayer)
                .finalizeDeposit(initializeDepositFixture.depositKey, {
                  value: messageFee + deliveryCost,
                })
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()
              bridge.deposits.reset()
              tbtcVault.optimisticMintingRequests.reset()
              wormhole.messageFee.reset()
              wormholeRelayer.quoteEVMDeliveryPrice.reset()
              wormholeTokenBridge.transferTokensWithPayload.reset()
              wormholeRelayer.sendVaasToEvm.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                l1BitcoinDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.l2DepositOwner
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

              bridge.revealDepositWithExtraData
                .whenCalledWith(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  toWormholeAddress(initializeDepositFixture.l2DepositOwner)
                )
                .returns()

              tx = await l1BitcoinDepositor
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.l2DepositOwner
                )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()

              await restoreSnapshot()
            })

            it("should reveal the deposit to the Bridge", async () => {
              // eslint-disable-next-line @typescript-eslint/no-unused-expressions
              expect(bridge.revealDepositWithExtraData).to.have.been.calledOnce

              const { fundingTx, reveal, l2DepositOwner } =
                initializeDepositFixture

              // The `calledOnceWith` assertion is not used here because
              // it doesn't use deep equality comparison and returns false
              // despite comparing equal objects. We use a workaround
              // to compare the arguments manually.
              const call = bridge.revealDepositWithExtraData.getCall(0)
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
                toWormholeAddress(l2DepositOwner.toLowerCase())
              )
            })

            it("should set the deposit state to Initialized", async () => {
              expect(
                await l1BitcoinDepositor.deposits(
                  initializeDepositFixture.depositKey
                )
              ).to.equal(1)
            })

            it("should emit DepositInitialized event", async () => {
              await expect(tx)
                .to.emit(l1BitcoinDepositor, "DepositInitialized")
                .withArgs(
                  initializeDepositFixture.depositKey,
                  initializeDepositFixture.l2DepositOwner,
                  relayer.address
                )
            })

            it("should not store the deferred gas reimbursement", async () => {
              expect(
                await l1BitcoinDepositor.gasReimbursements(
                  initializeDepositFixture.depositKey
                )
              ).to.eql([ethers.constants.AddressZero, BigNumber.from(0)])
            })
          })

          context(
            "when the reimbursement pool is set and caller is authorized",
            () => {
              let tx: ContractTransaction

              before(async () => {
                await createSnapshot()

                bridge.revealDepositWithExtraData
                  .whenCalledWith(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    toWormholeAddress(initializeDepositFixture.l2DepositOwner)
                  )
                  .returns()

                await l1BitcoinDepositor
                  .connect(governance)
                  .updateReimbursementPool(reimbursementPool.address)

                await l1BitcoinDepositor
                  .connect(governance)
                  .updateReimbursementAuthorization(relayer.address, true)

                tx = await l1BitcoinDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.l2DepositOwner
                  )
              })

              after(async () => {
                bridge.revealDepositWithExtraData.reset()

                await restoreSnapshot()
              })

              it("should reveal the deposit to the Bridge", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                expect(bridge.revealDepositWithExtraData).to.have.been
                  .calledOnce

                const { fundingTx, reveal, l2DepositOwner } =
                  initializeDepositFixture

                // The `calledOnceWith` assertion is not used here because
                // it doesn't use deep equality comparison and returns false
                // despite comparing equal objects. We use a workaround
                // to compare the arguments manually.
                const call = bridge.revealDepositWithExtraData.getCall(0)
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
                  toWormholeAddress(l2DepositOwner.toLowerCase())
                )
              })

              it("should set the deposit state to Initialized", async () => {
                expect(
                  await l1BitcoinDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(1)
              })

              it("should emit DepositInitialized event", async () => {
                await expect(tx)
                  .to.emit(l1BitcoinDepositor, "DepositInitialized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.l2DepositOwner,
                    relayer.address
                  )
              })

              it("should store the deferred gas reimbursement", async () => {
                const gasReimbursement =
                  await l1BitcoinDepositor.gasReimbursements(
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

                bridge.revealDepositWithExtraData
                  .whenCalledWith(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    toWormholeAddress(initializeDepositFixture.l2DepositOwner)
                  )
                  .returns()

                await l1BitcoinDepositor
                  .connect(governance)
                  .updateReimbursementPool(reimbursementPool.address)

                await l1BitcoinDepositor
                  .connect(governance)
                  .updateReimbursementAuthorization(relayer.address, false)

                tx = await l1BitcoinDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.l2DepositOwner
                  )
              })

              after(async () => {
                bridge.revealDepositWithExtraData.reset()

                await restoreSnapshot()
              })

              it("should reveal the deposit to the Bridge", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                expect(bridge.revealDepositWithExtraData).to.have.been
                  .calledOnce

                const { fundingTx, reveal, l2DepositOwner } =
                  initializeDepositFixture

                // The `calledOnceWith` assertion is not used here because
                // it doesn't use deep equality comparison and returns false
                // despite comparing equal objects. We use a workaround
                // to compare the arguments manually.
                const call = bridge.revealDepositWithExtraData.getCall(0)
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
                  toWormholeAddress(l2DepositOwner.toLowerCase())
                )
              })

              it("should set the deposit state to Initialized", async () => {
                expect(
                  await l1BitcoinDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(1)
              })

              it("should emit DepositInitialized event", async () => {
                await expect(tx)
                  .to.emit(l1BitcoinDepositor, "DepositInitialized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.l2DepositOwner,
                    relayer.address
                  )
              })

              it("should not store the deferred gas reimbursement", async () => {
                expect(
                  await l1BitcoinDepositor.gasReimbursements(
                    initializeDepositFixture.depositKey
                  )
                ).to.eql([ethers.constants.AddressZero, BigNumber.from(0)])
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

      // The L2BitcoinDepositor contract must be attached to the L1BitcoinDepositor
      // contract before the finalizeDeposit function is called.
      await l1BitcoinDepositor
        .connect(governance)
        .attachL2BitcoinDepositor(l2BitcoinDepositor)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the deposit state is wrong", () => {
      context("when the deposit state is Unknown", () => {
        it("should revert", async () => {
          await expect(
            l1BitcoinDepositor
              .connect(relayer)
              .finalizeDeposit(initializeDepositFixture.depositKey)
          ).to.be.revertedWith("Wrong deposit state")
        })
      })

      context("when the deposit state is Finalized", () => {
        before(async () => {
          await createSnapshot()

          await l1BitcoinDepositor
            .connect(relayer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.l2DepositOwner
            )

          // Set the Bridge mock to return a deposit state that allows
          // to finalize the deposit. Set only relevant fields.
          const revealedAt = (await lastBlockTime()) - 7200
          const finalizedAt = await lastBlockTime()
          bridge.deposits
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
          tbtcVault.optimisticMintingRequests
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns([revealedAt, finalizedAt])

          // Set Wormhole mocks to allow deposit finalization.
          const messageFee = 1000
          const deliveryCost = 5000
          wormhole.messageFee.returns(messageFee)
          wormholeRelayer.quoteEVMDeliveryPrice.returns({
            nativePriceQuote: BigNumber.from(deliveryCost),
            targetChainRefundPerGasUnused: BigNumber.from(0),
          })
          wormholeTokenBridge.transferTokensWithPayload.returns(0)
          wormholeRelayer.sendVaasToEvm.returns(0)

          await l1BitcoinDepositor
            .connect(relayer)
            .finalizeDeposit(initializeDepositFixture.depositKey, {
              value: messageFee + deliveryCost,
            })
        })

        after(async () => {
          bridge.revealDepositWithExtraData.reset()
          bridge.deposits.reset()
          tbtcVault.optimisticMintingRequests.reset()
          wormhole.messageFee.reset()
          wormholeRelayer.quoteEVMDeliveryPrice.reset()
          wormholeTokenBridge.transferTokensWithPayload.reset()
          wormholeRelayer.sendVaasToEvm.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            l1BitcoinDepositor
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

          await l1BitcoinDepositor
            .connect(relayer)
            .initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.l2DepositOwner
            )

          // Set the Bridge mock to return a deposit state that does not allow
          // to finalize the deposit. Set only relevant fields.
          const revealedAt = (await lastBlockTime()) - 7200
          bridge.deposits
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
          tbtcVault.optimisticMintingRequests
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns([revealedAt, 0])
        })

        after(async () => {
          bridge.revealDepositWithExtraData.reset()
          bridge.deposits.reset()
          tbtcVault.optimisticMintingRequests.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            l1BitcoinDepositor
              .connect(relayer)
              .finalizeDeposit(initializeDepositFixture.depositKey)
          ).to.be.revertedWith("Deposit not finalized by the bridge")
        })
      })

      context("when the deposit is finalized by the Bridge", () => {
        context("when normalized amount is too low to bridge", () => {
          before(async () => {
            await createSnapshot()

            await l1BitcoinDepositor
              .connect(relayer)
              .initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.l2DepositOwner
              )

            // Set the Bridge mock to return a deposit state that pass the
            // finalization check but fails the normalized amount check.
            // Set only relevant fields.
            const revealedAt = (await lastBlockTime()) - 7200
            const finalizedAt = await lastBlockTime()
            bridge.deposits
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
            tbtcVault.optimisticMintingRequests
              .whenCalledWith(initializeDepositFixture.depositKey)
              .returns([revealedAt, finalizedAt])
          })

          after(async () => {
            bridge.revealDepositWithExtraData.reset()
            bridge.deposits.reset()
            tbtcVault.optimisticMintingRequests.reset()

            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              l1BitcoinDepositor
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

              await l1BitcoinDepositor
                .connect(relayer)
                .initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.l2DepositOwner
                )

              // Set the Bridge mock to return a deposit state that allows
              // to finalize the deposit. Set only relevant fields.
              const revealedAt = (await lastBlockTime()) - 7200
              const finalizedAt = await lastBlockTime()
              bridge.deposits
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
              tbtcVault.optimisticMintingRequests
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns([revealedAt, finalizedAt])

              // Set Wormhole mocks to allow deposit finalization.
              wormhole.messageFee.returns(messageFee)
              wormholeRelayer.quoteEVMDeliveryPrice.returns({
                nativePriceQuote: BigNumber.from(deliveryCost),
                targetChainRefundPerGasUnused: BigNumber.from(0),
              })
              wormholeTokenBridge.transferTokensWithPayload.returns(0)
              wormholeRelayer.sendVaasToEvm.returns(0)
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()
              bridge.deposits.reset()
              tbtcVault.optimisticMintingRequests.reset()
              wormhole.messageFee.reset()
              wormholeRelayer.quoteEVMDeliveryPrice.reset()
              wormholeTokenBridge.transferTokensWithPayload.reset()
              wormholeRelayer.sendVaasToEvm.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                l1BitcoinDepositor
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

                await l1BitcoinDepositor
                  .connect(relayer)
                  .initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.l2DepositOwner
                  )

                // Set Bridge fees. Set only relevant fields.
                bridge.depositParameters.returns({
                  depositDustThreshold: 0,
                  depositTreasuryFeeDivisor: 0,
                  depositTxMaxFee,
                  depositRevealAheadPeriod: 0,
                })
                tbtcVault.optimisticMintingFeeDivisor.returns(
                  optimisticMintingFeeDivisor
                )

                // Set the Bridge mock to return a deposit state that allows
                // to finalize the deposit.
                const revealedAt = (await lastBlockTime()) - 7200
                const finalizedAt = await lastBlockTime()
                bridge.deposits
                  .whenCalledWith(initializeDepositFixture.depositKey)
                  .returns({
                    depositor: l1BitcoinDepositor.address,
                    amount: depositAmount,
                    revealedAt,
                    vault: initializeDepositFixture.reveal.vault,
                    treasuryFee,
                    sweptAt: finalizedAt,
                    extraData: toWormholeAddress(
                      initializeDepositFixture.l2DepositOwner
                    ),
                  })

                // Set the TBTCVault mock to return a deposit state
                // that allows to finalize the deposit.
                tbtcVault.optimisticMintingRequests
                  .whenCalledWith(initializeDepositFixture.depositKey)
                  .returns([revealedAt, finalizedAt])

                // Set Wormhole mocks to allow deposit finalization.
                wormhole.messageFee.returns(messageFee)
                wormholeRelayer.quoteEVMDeliveryPrice.returns({
                  nativePriceQuote: BigNumber.from(deliveryCost),
                  targetChainRefundPerGasUnused: BigNumber.from(0),
                })
                wormholeTokenBridge.transferTokensWithPayload.returns(
                  transferSequence
                )
                // Return arbitrary sent value.
                wormholeRelayer.sendVaasToEvm.returns(100)

                tx = await l1BitcoinDepositor
                  .connect(relayer)
                  .finalizeDeposit(initializeDepositFixture.depositKey, {
                    value: messageFee + deliveryCost,
                  })
              })

              after(async () => {
                bridge.depositParameters.reset()
                tbtcVault.optimisticMintingFeeDivisor.reset()
                bridge.revealDepositWithExtraData.reset()
                bridge.deposits.reset()
                tbtcVault.optimisticMintingRequests.reset()
                wormhole.messageFee.reset()
                wormholeRelayer.quoteEVMDeliveryPrice.reset()
                wormholeTokenBridge.transferTokensWithPayload.reset()
                wormholeRelayer.sendVaasToEvm.reset()

                await restoreSnapshot()
              })

              it("should set the deposit state to Finalized", async () => {
                expect(
                  await l1BitcoinDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(2)
              })

              it("should emit DepositFinalized event", async () => {
                await expect(tx)
                  .to.emit(l1BitcoinDepositor, "DepositFinalized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.l2DepositOwner,
                    relayer.address,
                    depositAmount.mul(satoshiMultiplier),
                    expectedTbtcAmount
                  )
              })

              it("should increase TBTC allowance for Wormhole Token Bridge", async () => {
                expect(
                  await tbtcToken.allowance(
                    l1BitcoinDepositor.address,
                    wormholeTokenBridge.address
                  )
                ).to.equal(expectedTbtcAmount)
              })

              it("should create a proper Wormhole token transfer", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                expect(wormholeTokenBridge.transferTokensWithPayload).to.have
                  .been.calledOnce

                // The `calledOnceWith` assertion is not used here because
                // it doesn't use deep equality comparison and returns false
                // despite comparing equal objects. We use a workaround
                // to compare the arguments manually.
                const call =
                  wormholeTokenBridge.transferTokensWithPayload.getCall(0)
                expect(call.value).to.equal(messageFee)
                expect(call.args[0]).to.equal(tbtcToken.address)
                expect(call.args[1]).to.equal(expectedTbtcAmount)
                expect(call.args[2]).to.equal(
                  await l1BitcoinDepositor.l2ChainId()
                )
                expect(call.args[3]).to.equal(
                  toWormholeAddress(l2WormholeGateway.address.toLowerCase())
                )
                expect(call.args[4]).to.equal(0)
                expect(call.args[5]).to.equal(
                  ethers.utils.defaultAbiCoder.encode(
                    ["address"],
                    [initializeDepositFixture.l2DepositOwner]
                  )
                )
              })

              it("should send transfer VAA to L2", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                expect(wormholeRelayer.sendVaasToEvm).to.have.been.calledOnce

                // The `calledOnceWith` assertion is not used here because
                // it doesn't use deep equality comparison and returns false
                // despite comparing equal objects. We use a workaround
                // to compare the arguments manually.
                const call = wormholeRelayer.sendVaasToEvm.getCall(0)
                expect(call.value).to.equal(deliveryCost)
                expect(call.args[0]).to.equal(
                  await l1BitcoinDepositor.l2ChainId()
                )
                expect(call.args[1]).to.equal(l2BitcoinDepositor)
                expect(call.args[2]).to.equal("0x")
                expect(call.args[3]).to.equal(0)
                expect(call.args[4]).to.equal(
                  await l1BitcoinDepositor.l2FinalizeDepositGasLimit()
                )
                expect(call.args[5]).to.eql([
                  [
                    l1ChainId,
                    toWormholeAddress(
                      wormholeTokenBridge.address.toLowerCase()
                    ),
                    BigNumber.from(transferSequence),
                  ],
                ])
                expect(call.args[6]).to.equal(
                  await l1BitcoinDepositor.l2ChainId()
                )
                expect(call.args[7]).to.equal(relayer.address)
              })

              it("should not call the reimbursement pool", async () => {
                // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                expect(reimbursementPool.refund).to.not.have.been.called
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

                  reimbursementPool.maxGasPrice.returns(
                    reimbursementPoolMaxGasPrice
                  )
                  reimbursementPool.staticGas.returns(
                    reimbursementPoolStaticGas
                  )

                  await l1BitcoinDepositor
                    .connect(governance)
                    .updateReimbursementPool(reimbursementPool.address)

                  await l1BitcoinDepositor
                    .connect(governance)
                    .updateReimbursementAuthorization(relayer.address, true)

                  await l1BitcoinDepositor
                    .connect(relayer)
                    .initializeDeposit(
                      initializeDepositFixture.fundingTx,
                      initializeDepositFixture.reveal,
                      initializeDepositFixture.l2DepositOwner
                    )

                  // Capture the gas spent for the initializeDeposit call
                  // for post-finalization comparison.
                  initializeDepositGasSpent = (
                    await l1BitcoinDepositor.gasReimbursements(
                      initializeDepositFixture.depositKey
                    )
                  ).gasSpent

                  // Set Bridge fees. Set only relevant fields.
                  bridge.depositParameters.returns({
                    depositDustThreshold: 0,
                    depositTreasuryFeeDivisor: 0,
                    depositTxMaxFee,
                    depositRevealAheadPeriod: 0,
                  })
                  tbtcVault.optimisticMintingFeeDivisor.returns(
                    optimisticMintingFeeDivisor
                  )

                  // Set the Bridge mock to return a deposit state that allows
                  // to finalize the deposit.
                  const revealedAt = (await lastBlockTime()) - 7200
                  const finalizedAt = await lastBlockTime()
                  bridge.deposits
                    .whenCalledWith(initializeDepositFixture.depositKey)
                    .returns({
                      depositor: l1BitcoinDepositor.address,
                      amount: depositAmount,
                      revealedAt,
                      vault: initializeDepositFixture.reveal.vault,
                      treasuryFee,
                      sweptAt: finalizedAt,
                      extraData: toWormholeAddress(
                        initializeDepositFixture.l2DepositOwner
                      ),
                    })

                  // Set the TBTCVault mock to return a deposit state
                  // that allows to finalize the deposit.
                  tbtcVault.optimisticMintingRequests
                    .whenCalledWith(initializeDepositFixture.depositKey)
                    .returns([revealedAt, finalizedAt])

                  // Set Wormhole mocks to allow deposit finalization.
                  wormhole.messageFee.returns(messageFee)
                  wormholeRelayer.quoteEVMDeliveryPrice.returns({
                    nativePriceQuote: BigNumber.from(deliveryCost),
                    targetChainRefundPerGasUnused: BigNumber.from(0),
                  })
                  wormholeTokenBridge.transferTokensWithPayload.returns(
                    transferSequence
                  )
                  // Return arbitrary sent value.
                  wormholeRelayer.sendVaasToEvm.returns(100)

                  tx = await l1BitcoinDepositor
                    .connect(relayer)
                    .finalizeDeposit(initializeDepositFixture.depositKey, {
                      value: messageFee + deliveryCost,
                    })
                })

                after(async () => {
                  reimbursementPool.maxGasPrice.reset()
                  reimbursementPool.staticGas.reset()
                  reimbursementPool.refund.reset()
                  bridge.depositParameters.reset()
                  tbtcVault.optimisticMintingFeeDivisor.reset()
                  bridge.revealDepositWithExtraData.reset()
                  bridge.deposits.reset()
                  tbtcVault.optimisticMintingRequests.reset()
                  wormhole.messageFee.reset()
                  wormholeRelayer.quoteEVMDeliveryPrice.reset()
                  wormholeTokenBridge.transferTokensWithPayload.reset()
                  wormholeRelayer.sendVaasToEvm.reset()

                  await restoreSnapshot()
                })

                it("should set the deposit state to Finalized", async () => {
                  expect(
                    await l1BitcoinDepositor.deposits(
                      initializeDepositFixture.depositKey
                    )
                  ).to.equal(2)
                })

                it("should emit DepositFinalized event", async () => {
                  await expect(tx)
                    .to.emit(l1BitcoinDepositor, "DepositFinalized")
                    .withArgs(
                      initializeDepositFixture.depositKey,
                      initializeDepositFixture.l2DepositOwner,
                      relayer.address,
                      depositAmount.mul(satoshiMultiplier),
                      expectedTbtcAmount
                    )
                })

                it("should increase TBTC allowance for Wormhole Token Bridge", async () => {
                  expect(
                    await tbtcToken.allowance(
                      l1BitcoinDepositor.address,
                      wormholeTokenBridge.address
                    )
                  ).to.equal(expectedTbtcAmount)
                })

                it("should create a proper Wormhole token transfer", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(wormholeTokenBridge.transferTokensWithPayload).to.have
                    .been.calledOnce

                  // The `calledOnceWith` assertion is not used here because
                  // it doesn't use deep equality comparison and returns false
                  // despite comparing equal objects. We use a workaround
                  // to compare the arguments manually.
                  const call =
                    wormholeTokenBridge.transferTokensWithPayload.getCall(0)
                  expect(call.value).to.equal(messageFee)
                  expect(call.args[0]).to.equal(tbtcToken.address)
                  expect(call.args[1]).to.equal(expectedTbtcAmount)
                  expect(call.args[2]).to.equal(
                    await l1BitcoinDepositor.l2ChainId()
                  )
                  expect(call.args[3]).to.equal(
                    toWormholeAddress(l2WormholeGateway.address.toLowerCase())
                  )
                  expect(call.args[4]).to.equal(0)
                  expect(call.args[5]).to.equal(
                    ethers.utils.defaultAbiCoder.encode(
                      ["address"],
                      [initializeDepositFixture.l2DepositOwner]
                    )
                  )
                })

                it("should send transfer VAA to L2", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(wormholeRelayer.sendVaasToEvm).to.have.been.calledOnce

                  // The `calledOnceWith` assertion is not used here because
                  // it doesn't use deep equality comparison and returns false
                  // despite comparing equal objects. We use a workaround
                  // to compare the arguments manually.
                  const call = wormholeRelayer.sendVaasToEvm.getCall(0)
                  expect(call.value).to.equal(deliveryCost)
                  expect(call.args[0]).to.equal(
                    await l1BitcoinDepositor.l2ChainId()
                  )
                  expect(call.args[1]).to.equal(l2BitcoinDepositor)
                  expect(call.args[2]).to.equal("0x")
                  expect(call.args[3]).to.equal(0)
                  expect(call.args[4]).to.equal(
                    await l1BitcoinDepositor.l2FinalizeDepositGasLimit()
                  )
                  expect(call.args[5]).to.eql([
                    [
                      l1ChainId,
                      toWormholeAddress(
                        wormholeTokenBridge.address.toLowerCase()
                      ),
                      BigNumber.from(transferSequence),
                    ],
                  ])
                  expect(call.args[6]).to.equal(
                    await l1BitcoinDepositor.l2ChainId()
                  )
                  expect(call.args[7]).to.equal(relayer.address)
                })

                it("should pay out proper reimbursements", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(reimbursementPool.refund).to.have.been.calledTwice

                  // First call is the deferred gas reimbursement for deposit
                  // initialization.
                  const call1 = reimbursementPool.refund.getCall(0)
                  // Should reimburse the exact value stored upon deposit initialization.
                  expect(call1.args[0]).to.equal(initializeDepositGasSpent)
                  expect(call1.args[1]).to.equal(relayer.address)

                  // Second call is the refund for deposit finalization.
                  const call2 = reimbursementPool.refund.getCall(1)
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
                    BigNumber.from(call2.args[0]).toNumber()
                  ).to.be.greaterThan(msgValueOffset.toNumber())
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

                  reimbursementPool.maxGasPrice.returns(
                    reimbursementPoolMaxGasPrice
                  )
                  reimbursementPool.staticGas.returns(
                    reimbursementPoolStaticGas
                  )

                  await l1BitcoinDepositor
                    .connect(governance)
                    .updateReimbursementPool(reimbursementPool.address)

                  // Authorize just for deposit initialization.
                  await l1BitcoinDepositor
                    .connect(governance)
                    .updateReimbursementAuthorization(relayer.address, true)

                  await l1BitcoinDepositor
                    .connect(relayer)
                    .initializeDeposit(
                      initializeDepositFixture.fundingTx,
                      initializeDepositFixture.reveal,
                      initializeDepositFixture.l2DepositOwner
                    )

                  // Capture the gas spent for the initializeDeposit call
                  // for post-finalization comparison.
                  initializeDepositGasSpent = (
                    await l1BitcoinDepositor.gasReimbursements(
                      initializeDepositFixture.depositKey
                    )
                  ).gasSpent

                  // Set Bridge fees. Set only relevant fields.
                  bridge.depositParameters.returns({
                    depositDustThreshold: 0,
                    depositTreasuryFeeDivisor: 0,
                    depositTxMaxFee,
                    depositRevealAheadPeriod: 0,
                  })
                  tbtcVault.optimisticMintingFeeDivisor.returns(
                    optimisticMintingFeeDivisor
                  )

                  // Set the Bridge mock to return a deposit state that allows
                  // to finalize the deposit.
                  const revealedAt = (await lastBlockTime()) - 7200
                  const finalizedAt = await lastBlockTime()
                  bridge.deposits
                    .whenCalledWith(initializeDepositFixture.depositKey)
                    .returns({
                      depositor: l1BitcoinDepositor.address,
                      amount: depositAmount,
                      revealedAt,
                      vault: initializeDepositFixture.reveal.vault,
                      treasuryFee,
                      sweptAt: finalizedAt,
                      extraData: toWormholeAddress(
                        initializeDepositFixture.l2DepositOwner
                      ),
                    })

                  // Set the TBTCVault mock to return a deposit state
                  // that allows to finalize the deposit.
                  tbtcVault.optimisticMintingRequests
                    .whenCalledWith(initializeDepositFixture.depositKey)
                    .returns([revealedAt, finalizedAt])

                  // Set Wormhole mocks to allow deposit finalization.
                  wormhole.messageFee.returns(messageFee)
                  wormholeRelayer.quoteEVMDeliveryPrice.returns({
                    nativePriceQuote: BigNumber.from(deliveryCost),
                    targetChainRefundPerGasUnused: BigNumber.from(0),
                  })
                  wormholeTokenBridge.transferTokensWithPayload.returns(
                    transferSequence
                  )
                  // Return arbitrary sent value.
                  wormholeRelayer.sendVaasToEvm.returns(100)

                  // De-authorize for deposit finalization.
                  await l1BitcoinDepositor
                    .connect(governance)
                    .updateReimbursementAuthorization(relayer.address, false)

                  tx = await l1BitcoinDepositor
                    .connect(relayer)
                    .finalizeDeposit(initializeDepositFixture.depositKey, {
                      value: messageFee + deliveryCost,
                    })
                })

                after(async () => {
                  reimbursementPool.maxGasPrice.reset()
                  reimbursementPool.staticGas.reset()
                  reimbursementPool.refund.reset()
                  bridge.depositParameters.reset()
                  tbtcVault.optimisticMintingFeeDivisor.reset()
                  bridge.revealDepositWithExtraData.reset()
                  bridge.deposits.reset()
                  tbtcVault.optimisticMintingRequests.reset()
                  wormhole.messageFee.reset()
                  wormholeRelayer.quoteEVMDeliveryPrice.reset()
                  wormholeTokenBridge.transferTokensWithPayload.reset()
                  wormholeRelayer.sendVaasToEvm.reset()

                  await restoreSnapshot()
                })

                it("should set the deposit state to Finalized", async () => {
                  expect(
                    await l1BitcoinDepositor.deposits(
                      initializeDepositFixture.depositKey
                    )
                  ).to.equal(2)
                })

                it("should emit DepositFinalized event", async () => {
                  await expect(tx)
                    .to.emit(l1BitcoinDepositor, "DepositFinalized")
                    .withArgs(
                      initializeDepositFixture.depositKey,
                      initializeDepositFixture.l2DepositOwner,
                      relayer.address,
                      depositAmount.mul(satoshiMultiplier),
                      expectedTbtcAmount
                    )
                })

                it("should increase TBTC allowance for Wormhole Token Bridge", async () => {
                  expect(
                    await tbtcToken.allowance(
                      l1BitcoinDepositor.address,
                      wormholeTokenBridge.address
                    )
                  ).to.equal(expectedTbtcAmount)
                })

                it("should create a proper Wormhole token transfer", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(wormholeTokenBridge.transferTokensWithPayload).to.have
                    .been.calledOnce

                  // The `calledOnceWith` assertion is not used here because
                  // it doesn't use deep equality comparison and returns false
                  // despite comparing equal objects. We use a workaround
                  // to compare the arguments manually.
                  const call =
                    wormholeTokenBridge.transferTokensWithPayload.getCall(0)
                  expect(call.value).to.equal(messageFee)
                  expect(call.args[0]).to.equal(tbtcToken.address)
                  expect(call.args[1]).to.equal(expectedTbtcAmount)
                  expect(call.args[2]).to.equal(
                    await l1BitcoinDepositor.l2ChainId()
                  )
                  expect(call.args[3]).to.equal(
                    toWormholeAddress(l2WormholeGateway.address.toLowerCase())
                  )
                  expect(call.args[4]).to.equal(0)
                  expect(call.args[5]).to.equal(
                    ethers.utils.defaultAbiCoder.encode(
                      ["address"],
                      [initializeDepositFixture.l2DepositOwner]
                    )
                  )
                })

                it("should send transfer VAA to L2", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(wormholeRelayer.sendVaasToEvm).to.have.been.calledOnce

                  // The `calledOnceWith` assertion is not used here because
                  // it doesn't use deep equality comparison and returns false
                  // despite comparing equal objects. We use a workaround
                  // to compare the arguments manually.
                  const call = wormholeRelayer.sendVaasToEvm.getCall(0)
                  expect(call.value).to.equal(deliveryCost)
                  expect(call.args[0]).to.equal(
                    await l1BitcoinDepositor.l2ChainId()
                  )
                  expect(call.args[1]).to.equal(l2BitcoinDepositor)
                  expect(call.args[2]).to.equal("0x")
                  expect(call.args[3]).to.equal(0)
                  expect(call.args[4]).to.equal(
                    await l1BitcoinDepositor.l2FinalizeDepositGasLimit()
                  )
                  expect(call.args[5]).to.eql([
                    [
                      l1ChainId,
                      toWormholeAddress(
                        wormholeTokenBridge.address.toLowerCase()
                      ),
                      BigNumber.from(transferSequence),
                    ],
                  ])
                  expect(call.args[6]).to.equal(
                    await l1BitcoinDepositor.l2ChainId()
                  )
                  expect(call.args[7]).to.equal(relayer.address)
                })

                it("should pay out proper reimbursements", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(reimbursementPool.refund).to.have.been.calledOnce

                  // The only call is the deferred gas reimbursement for deposit
                  // initialization. The call for finalization should not
                  // occur as the caller was de-authorized.
                  const call = reimbursementPool.refund.getCall(0)
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

      wormhole.messageFee.returns(1000)

      wormholeRelayer.quoteEVMDeliveryPrice
        .whenCalledWith(
          await l1BitcoinDepositor.l2ChainId(),
          0,
          await l1BitcoinDepositor.l2FinalizeDepositGasLimit()
        )
        .returns({
          nativePriceQuote: BigNumber.from(5000),
          targetChainRefundPerGasUnused: BigNumber.from(0),
        })
    })

    after(async () => {
      wormhole.messageFee.reset()
      wormholeRelayer.quoteEVMDeliveryPrice.reset()

      await restoreSnapshot()
    })

    it("should return the correct cost", async () => {
      const cost = await l1BitcoinDepositor.quoteFinalizeDeposit()
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
    const expectedTbtcAmountReimbursed = to1ePrecision(94525, 10)

    before(async () => {
      await createSnapshot()

      // Turn the feature flag on
      await l1BitcoinDepositor.connect(governance).setReimburseTxMaxFee(true)

      // The L2BitcoinDepositor contract must be attached
      if (
        (await l1BitcoinDepositor.l2BitcoinDepositor()) ===
        ethers.constants.AddressZero
      ) {
        await l1BitcoinDepositor
          .connect(governance)
          .attachL2BitcoinDepositor(l2BitcoinDepositor)
      }
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should add depositTxMaxFee back to the minted TBTC amount", async () => {
      // 1) Initialize deposit
      await l1BitcoinDepositor
        .connect(relayer)
        .initializeDeposit(
          initializeDepositFixture.fundingTx,
          initializeDepositFixture.reveal,
          initializeDepositFixture.l2DepositOwner
        )

      // 2) Setup Bridge deposit parameters
      bridge.depositParameters.returns({
        depositDustThreshold: 0,
        depositTreasuryFeeDivisor: 0,
        depositTxMaxFee,
        depositRevealAheadPeriod: 0,
      })
      // 3) Setup vault fees
      tbtcVault.optimisticMintingFeeDivisor.returns(optimisticMintingFeeDivisor)

      // 4) Prepare deposit finalization
      const revealedAt = (await lastBlockTime()) - 7200
      const finalizedAt = await lastBlockTime()
      bridge.deposits
        .whenCalledWith(initializeDepositFixture.depositKey)
        .returns({
          depositor: l1BitcoinDepositor.address,
          amount: depositAmount,
          revealedAt,
          vault: initializeDepositFixture.reveal.vault,
          treasuryFee,
          sweptAt: finalizedAt,
          extraData: toWormholeAddress(initializeDepositFixture.l2DepositOwner),
        })
      tbtcVault.optimisticMintingRequests
        .whenCalledWith(initializeDepositFixture.depositKey)
        .returns([revealedAt, finalizedAt])

      // 5) Setup Wormhole cost
      wormhole.messageFee.returns(messageFee)
      wormholeRelayer.quoteEVMDeliveryPrice.returns({
        nativePriceQuote: BigNumber.from(deliveryCost),
        targetChainRefundPerGasUnused: BigNumber.from(0),
      })

      // 6) The bridging calls
      wormholeTokenBridge.transferTokensWithPayload.returns(555)
      wormholeRelayer.sendVaasToEvm.returns(999)

      // 7) Now finalize with enough payment
      const tx = await l1BitcoinDepositor
        .connect(relayer)
        .finalizeDeposit(initializeDepositFixture.depositKey, {
          value: messageFee + deliveryCost,
        })

      // 8) The final minted TBTC should be 94525e10
      await expect(tx)
        .to.emit(l1BitcoinDepositor, "DepositFinalized")
        .withArgs(
          initializeDepositFixture.depositKey,
          initializeDepositFixture.l2DepositOwner,
          relayer.address,
          depositAmount.mul(satoshiMultiplier),
          expectedTbtcAmountReimbursed
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
  l2DepositOwner: string
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
  l2DepositOwner: "0x23b82a7108F9CEb34C3CDC44268be21D151d4124",
}

// eslint-disable-next-line import/prefer-default-export
export function toWormholeAddress(address: string): string {
  return `0x000000000000000000000000${address.slice(2)}`
}
