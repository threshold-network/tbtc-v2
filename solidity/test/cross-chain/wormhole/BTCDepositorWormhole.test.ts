import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import {
  IBridge,
  ITBTCVault,
  IWormhole,
  IWormholeRelayer,
  IWormholeTokenBridge,
  BTCDepositorWormhole,
  ReimbursementPool,
  TestERC20,
} from "../../../typechain"
import { to1ePrecision } from "../../helpers/contract-test-helpers"
import { initializeDepositFixture } from "./L1BTCDepositorWormhole.test"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time
// Just arbitrary values.
const l1ChainId = 10
const destinationChainId = 20

describe("BTCDepositorWormhole", () => {
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

    // Just an arbitrary WormholeGateway bytes32 public key.
    const destinationChainWormholeGateway =
      "0xe21c3b9e1fa7352fd19c6410a01234abcd5678fe9fa0246fc5bc389d1de57b9f"

    // Just an arbitrary destination chain depositor address.
    const destinationChainBtcDepositor =
      "0xeE6F5f69860f310114185677D017576aed0dEC83"
    const reimbursementPool = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `BTCDepositorWormhole_${randomBytes(8).toString("hex")}`,
      {
        contractName: "BTCDepositorWormhole",
        initializerArgs: [
          bridge.address,
          tbtcVault.address,
          wormhole.address,
          wormholeTokenBridge.address,
          destinationChainWormholeGateway,
          destinationChainId,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const NonEvmBtcDepositor = deployment[0] as BTCDepositorWormhole

    await NonEvmBtcDepositor.connect(deployer).transferOwnership(
      governance.address
    )

    return {
      governance,
      relayer,
      bridge,
      tbtcToken,
      tbtcVault,
      wormhole,
      wormholeRelayer,
      wormholeTokenBridge,
      destinationChainWormholeGateway,
      destinationChainBtcDepositor,
      reimbursementPool,
      NonEvmBtcDepositor,
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
  let destinationChainWormholeGateway: string
  let reimbursementPool: FakeContract<ReimbursementPool>
  let NonEvmBtcDepositor: NonEvmBtcDepositor

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
      destinationChainWormholeGateway,
      NonEvmBtcDepositor,
      reimbursementPool,
    } = await waffle.loadFixture(contractsFixture))
  })

  describe("updateReimbursementPool", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          NonEvmBtcDepositor.connect(relayer).updateReimbursementPool(
            reimbursementPool.address
          )
        ).to.be.revertedWith("'Caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await NonEvmBtcDepositor.connect(governance).updateReimbursementPool(
          reimbursementPool.address
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the reimbursementPool address properly", async () => {
        expect(await NonEvmBtcDepositor.reimbursementPool()).to.equal(
          reimbursementPool.address
        )
      })

      it("should emit ReimbursementPoolUpdated event", async () => {
        await expect(
          NonEvmBtcDepositor.connect(governance).updateReimbursementPool(
            reimbursementPool.address
          )
        )
          .to.emit(NonEvmBtcDepositor, "ReimbursementPoolUpdated")
          .withArgs(reimbursementPool.address)
      })
    })
  })

  describe("updateGasOffsetParameters", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          NonEvmBtcDepositor.connect(relayer).updateGasOffsetParameters(
            1000,
            2000
          )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await NonEvmBtcDepositor.connect(governance).updateGasOffsetParameters(
          1000,
          2000
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the gas offset params properly", async () => {
        expect(
          await NonEvmBtcDepositor.initializeDepositGasOffset()
        ).to.be.equal(1000)

        expect(await NonEvmBtcDepositor.finalizeDepositGasOffset()).to.be.equal(
          2000
        )
      })

      it("should emit GasOffsetParametersUpdated event", async () => {
        await expect(
          NonEvmBtcDepositor.connect(governance).updateGasOffsetParameters(
            1000,
            2000
          )
        )
          .to.emit(NonEvmBtcDepositor, "GasOffsetParametersUpdated")
          .withArgs(1000, 2000)
      })
    })
  })

  describe("updateReimbursementAuthorization", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          NonEvmBtcDepositor.connect(relayer).updateReimbursementAuthorization(
            relayer.address,
            true
          )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await NonEvmBtcDepositor.connect(
          governance
        ).updateReimbursementAuthorization(relayer.address, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the authorization properly", async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await NonEvmBtcDepositor.reimbursementAuthorizations(relayer.address)
        ).to.be.true
      })

      it("should emit ReimbursementAuthorizationUpdated event", async () => {
        await expect(tx)
          .to.emit(NonEvmBtcDepositor, "ReimbursementAuthorizationUpdated")
          .withArgs(relayer.address, true)
      })
    })
  })

  describe("initializeDeposit", () => {
    context("when the destination chain deposit owner is zero", () => {
      it("should revert", async () => {
        await expect(
          NonEvmBtcDepositor.connect(relayer).initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            ethers.constants.HashZero
          )
        ).to.be.revertedWith("L2 deposit owner must not be 0x0")
      })
    })

    context("when the destination chain deposit owner is non-zero", () => {
      context("when the requested vault is not TBTCVault", () => {
        it("should revert", async () => {
          const corruptedReveal = JSON.parse(
            JSON.stringify(initializeDepositFixture.reveal)
          )

          // Set another vault address deliberately. This value must be
          // different from the tbtcVaultAddress constant used in the fixture.
          corruptedReveal.vault = ethers.constants.AddressZero

          await expect(
            NonEvmBtcDepositor.connect(relayer).initializeDeposit(
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

              await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.destinationChainDepositOwner
              )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                NonEvmBtcDepositor.connect(relayer).initializeDeposit(
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

              await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.destinationChainDepositOwner
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
              wormhole.messageFee.returns(messageFee)
              wormholeTokenBridge.transferTokensWithPayload.returns(0)

              await NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
                initializeDepositFixture.depositKey,
                {
                  value: messageFee,
                }
              )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()
              bridge.deposits.reset()
              tbtcVault.optimisticMintingRequests.reset()
              wormhole.messageFee.reset()
              wormholeRelayer.quoteEVMDeliveryPrice.reset()
              wormholeTokenBridge.transferTokensWithPayload.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                NonEvmBtcDepositor.connect(relayer).initializeDeposit(
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

              bridge.revealDepositWithExtraData
                .whenCalledWith(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
                )
                .returns()

              tx = await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.destinationChainDepositOwner
              )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()

              await restoreSnapshot()
            })

            it("should reveal the deposit to the Bridge", async () => {
              // eslint-disable-next-line @typescript-eslint/no-unused-expressions
              expect(bridge.revealDepositWithExtraData).to.have.been.calledOnce

              const { fundingTx, reveal, destinationChainDepositOwner } =
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
                destinationChainDepositOwner.toLowerCase()
              )
            })

            it("should set the deposit state to Initialized", async () => {
              expect(
                await NonEvmBtcDepositor.deposits(
                  initializeDepositFixture.depositKey
                )
              ).to.equal(1)
            })

            it("should emit DepositInitialized event", async () => {
              await expect(tx)
                .to.emit(NonEvmBtcDepositor, "DepositInitialized")
                .withArgs(
                  initializeDepositFixture.depositKey,
                  initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                  relayer.address
                )
            })

            it("should not store the deferred gas reimbursement", async () => {
              const gr = await NonEvmBtcDepositor.gasReimbursements(
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

                bridge.revealDepositWithExtraData
                  .whenCalledWith(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )
                  .returns()

                await NonEvmBtcDepositor.connect(
                  governance
                ).updateReimbursementPool(reimbursementPool.address)

                await NonEvmBtcDepositor.connect(
                  governance
                ).updateReimbursementAuthorization(relayer.address, true)

                tx = await NonEvmBtcDepositor.connect(
                  relayer
                ).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
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

                const { fundingTx, reveal, destinationChainDepositOwner } =
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
                  destinationChainDepositOwner.toLowerCase()
                )
              })

              it("should set the deposit state to Initialized", async () => {
                expect(
                  await NonEvmBtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(1)
              })

              it("should emit DepositInitialized event", async () => {
                await expect(tx)
                  .to.emit(NonEvmBtcDepositor, "DepositInitialized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                    relayer.address
                  )
              })

              it("should store the deferred gas reimbursement", async () => {
                const gasReimbursement =
                  await NonEvmBtcDepositor.gasReimbursements(
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
                    initializeDepositFixture.destinationChainDepositOwner
                  )
                  .returns()

                await NonEvmBtcDepositor.connect(
                  governance
                ).updateReimbursementPool(reimbursementPool.address)

                await NonEvmBtcDepositor.connect(
                  governance
                ).updateReimbursementAuthorization(relayer.address, false)

                tx = await NonEvmBtcDepositor.connect(
                  relayer
                ).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
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

                const { fundingTx, reveal, destinationChainDepositOwner } =
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
                  destinationChainDepositOwner.toLowerCase()
                )
              })

              it("should set the deposit state to Initialized", async () => {
                expect(
                  await NonEvmBtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(1)
              })

              it("should emit DepositInitialized event", async () => {
                await expect(tx)
                  .to.emit(NonEvmBtcDepositor, "DepositInitialized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
                    relayer.address
                  )
              })

              it("should not store the deferred gas reimbursement", async () => {
                const gr = await NonEvmBtcDepositor.gasReimbursements(
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
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the deposit state is wrong", () => {
      context("when the deposit state is Unknown", () => {
        it("should revert", async () => {
          await expect(
            NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
              initializeDepositFixture.depositKey
            )
          ).to.be.revertedWith("Wrong deposit state")
        })
      })

      context("when the deposit state is Finalized", () => {
        before(async () => {
          await createSnapshot()

          await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            initializeDepositFixture.destinationChainDepositOwner
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
          wormhole.messageFee.returns(messageFee)

          wormholeTokenBridge.transferTokensWithPayload.returns(0)

          await NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
            initializeDepositFixture.depositKey,
            {
              value: messageFee,
            }
          )
        })

        after(async () => {
          bridge.revealDepositWithExtraData.reset()
          bridge.deposits.reset()
          tbtcVault.optimisticMintingRequests.reset()
          wormhole.messageFee.reset()
          wormholeRelayer.quoteEVMDeliveryPrice.reset()
          wormholeTokenBridge.transferTokensWithPayload.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
              initializeDepositFixture.depositKey
            )
          ).to.be.revertedWith("Wrong deposit state")
        })
      })
    })

    context("when the deposit state is Initialized", () => {
      context("when the deposit is not finalized by the Bridge", () => {
        before(async () => {
          await createSnapshot()

          await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            initializeDepositFixture.destinationChainDepositOwner
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
            NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
              initializeDepositFixture.depositKey
            )
          ).to.be.revertedWith("Deposit not finalized by the bridge")
        })
      })

      context("when the deposit is finalized by the Bridge", () => {
        context("when normalized amount is too low to bridge", () => {
          before(async () => {
            await createSnapshot()

            await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.destinationChainDepositOwner
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
              NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
                initializeDepositFixture.depositKey
              )
            ).to.be.revertedWith("Amount too low to bridge")
          })
        })

        context("when normalized amount is not too low to bridge", () => {
          context("when payment for Wormhole Relayer is too low", () => {
            const messageFee = 1000

            before(async () => {
              await createSnapshot()

              await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.destinationChainDepositOwner
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
              wormholeTokenBridge.transferTokensWithPayload.returns(0)
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()
              bridge.deposits.reset()
              tbtcVault.optimisticMintingRequests.reset()
              wormhole.messageFee.reset()
              wormholeTokenBridge.transferTokensWithPayload.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
                  initializeDepositFixture.depositKey,
                  {
                    // Use a value by 1 WEI less than required.
                    value: messageFee - 1,
                  }
                )
              ).to.be.revertedWith("Payment for Wormhole Relayer is too low")
            })
          })

          context("when payment for Wormhole Relayer is not too low", () => {
            const satoshiMultiplier = to1ePrecision(1, 10)
            const messageFee = 1000
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

                await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.destinationChainDepositOwner
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
                    depositor: NonEvmBtcDepositor.address,
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
                tbtcVault.optimisticMintingRequests
                  .whenCalledWith(initializeDepositFixture.depositKey)
                  .returns([revealedAt, finalizedAt])

                // Set Wormhole mocks to allow deposit finalization.
                wormhole.messageFee.returns(messageFee)
                wormholeTokenBridge.transferTokensWithPayload.returns(
                  transferSequence
                )

                tx = await NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
                  initializeDepositFixture.depositKey,
                  {
                    value: messageFee,
                  }
                )
              })

              after(async () => {
                bridge.depositParameters.reset()
                tbtcVault.optimisticMintingFeeDivisor.reset()
                bridge.revealDepositWithExtraData.reset()
                bridge.deposits.reset()
                tbtcVault.optimisticMintingRequests.reset()
                wormhole.messageFee.reset()
                wormholeTokenBridge.transferTokensWithPayload.reset()

                await restoreSnapshot()
              })

              it("should set the deposit state to Finalized", async () => {
                expect(
                  await NonEvmBtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(2)
              })

              it("should emit DepositFinalized event", async () => {
                await expect(tx)
                  .to.emit(NonEvmBtcDepositor, "DepositFinalized")
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
                    NonEvmBtcDepositor.address,
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
                  await NonEvmBtcDepositor.destinationChainId()
                )
                expect(call.args[3]).to.equal(
                  destinationChainWormholeGateway.toLowerCase()
                )
                expect(call.args[4]).to.equal(0)
                expect(call.args[5]).to.equal(
                  initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
                )
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

                  await NonEvmBtcDepositor.connect(
                    governance
                  ).updateReimbursementPool(reimbursementPool.address)

                  await NonEvmBtcDepositor.connect(
                    governance
                  ).updateReimbursementAuthorization(relayer.address, true)

                  await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )

                  // Capture the gas spent for the initializeDeposit call
                  // for post-finalization comparison.
                  initializeDepositGasSpent = (
                    await NonEvmBtcDepositor.gasReimbursements(
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
                      depositor: NonEvmBtcDepositor.address,
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
                  tbtcVault.optimisticMintingRequests
                    .whenCalledWith(initializeDepositFixture.depositKey)
                    .returns([revealedAt, finalizedAt])

                  // Set Wormhole mocks to allow deposit finalization.
                  wormhole.messageFee.returns(messageFee)
                  wormholeTokenBridge.transferTokensWithPayload.returns(
                    transferSequence
                  )
                  // Return arbitrary sent value.
                  wormholeRelayer.sendVaasToEvm.returns(100)

                  tx = await NonEvmBtcDepositor.connect(
                    relayer
                  ).finalizeDeposit(initializeDepositFixture.depositKey, {
                    value: messageFee,
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
                  wormholeTokenBridge.transferTokensWithPayload.reset()

                  await restoreSnapshot()
                })

                it("should set the deposit state to Finalized", async () => {
                  expect(
                    await NonEvmBtcDepositor.deposits(
                      initializeDepositFixture.depositKey
                    )
                  ).to.equal(2)
                })

                it("should emit DepositFinalized event", async () => {
                  await expect(tx)
                    .to.emit(NonEvmBtcDepositor, "DepositFinalized")
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
                      NonEvmBtcDepositor.address,
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
                    await NonEvmBtcDepositor.destinationChainId()
                  )
                  expect(call.args[3]).to.equal(
                    destinationChainWormholeGateway.toLowerCase()
                  )
                  expect(call.args[4]).to.equal(0)
                  expect(call.args[5]).to.equal(
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
                  )
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
                  const msgValueOffset = BigNumber.from(messageFee)
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

                  await NonEvmBtcDepositor.connect(
                    governance
                  ).updateReimbursementPool(reimbursementPool.address)

                  // Authorize just for deposit initialization.
                  await NonEvmBtcDepositor.connect(
                    governance
                  ).updateReimbursementAuthorization(relayer.address, true)

                  await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
                    initializeDepositFixture.fundingTx,
                    initializeDepositFixture.reveal,
                    initializeDepositFixture.destinationChainDepositOwner
                  )

                  // Capture the gas spent for the initializeDeposit call
                  // for post-finalization comparison.
                  initializeDepositGasSpent = (
                    await NonEvmBtcDepositor.gasReimbursements(
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
                      depositor: NonEvmBtcDepositor.address,
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
                  tbtcVault.optimisticMintingRequests
                    .whenCalledWith(initializeDepositFixture.depositKey)
                    .returns([revealedAt, finalizedAt])

                  // Set Wormhole mocks to allow deposit finalization.
                  wormhole.messageFee.returns(messageFee)
                  wormholeTokenBridge.transferTokensWithPayload.returns(
                    transferSequence
                  )

                  // De-authorize for deposit finalization.
                  await NonEvmBtcDepositor.connect(
                    governance
                  ).updateReimbursementAuthorization(relayer.address, false)

                  tx = await NonEvmBtcDepositor.connect(
                    relayer
                  ).finalizeDeposit(initializeDepositFixture.depositKey, {
                    value: messageFee,
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
                  wormholeTokenBridge.transferTokensWithPayload.reset()

                  await restoreSnapshot()
                })

                it("should set the deposit state to Finalized", async () => {
                  expect(
                    await NonEvmBtcDepositor.deposits(
                      initializeDepositFixture.depositKey
                    )
                  ).to.equal(2)
                })

                it("should emit DepositFinalized event", async () => {
                  await expect(tx)
                    .to.emit(NonEvmBtcDepositor, "DepositFinalized")
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
                      NonEvmBtcDepositor.address,
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
                    await NonEvmBtcDepositor.destinationChainId()
                  )
                  expect(call.args[3]).to.equal(
                    destinationChainWormholeGateway.toLowerCase()
                  )
                  expect(call.args[4]).to.equal(0)
                  expect(call.args[5]).to.equal(
                    initializeDepositFixture.destinationChainDepositOwner.toLowerCase()
                  )
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
    })

    after(async () => {
      wormhole.messageFee.reset()
      await restoreSnapshot()
    })

    it("should return the correct cost", async () => {
      const cost = await NonEvmBtcDepositor.quoteFinalizeDeposit()
      expect(cost).to.be.equal(1000) // message fee
    })
  })

  context("when reimburseTxMaxFee is true", () => {
    const satoshiMultiplier = to1ePrecision(1, 10)
    const messageFee = 1000
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
      await NonEvmBtcDepositor.connect(governance).setReimburseTxMaxFee(true)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should add depositTxMaxFee back to the minted TBTC amount", async () => {
      // 1) Initialize deposit
      await NonEvmBtcDepositor.connect(relayer).initializeDeposit(
        initializeDepositFixture.fundingTx,
        initializeDepositFixture.reveal,
        initializeDepositFixture.destinationChainDepositOwner
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
          depositor: NonEvmBtcDepositor.address,
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

      // 5) Setup Wormhole cost
      wormhole.messageFee.returns(messageFee)

      // 6) The bridging calls
      wormholeTokenBridge.transferTokensWithPayload.returns(555)

      // 7) Mint enough tBTC to cover the reimbursed amount.
      await tbtcToken.mint(
        NonEvmBtcDepositor.address,
        expectedTbtcAmountReimbursed
      )

      // 8) Now finalize with enough payment
      const tx = await NonEvmBtcDepositor.connect(relayer).finalizeDeposit(
        initializeDepositFixture.depositKey,
        {
          value: messageFee,
        }
      )

      // 9) The final minted TBTC should be 94525e10
      await expect(tx)
        .to.emit(NonEvmBtcDepositor, "DepositFinalized")
        .withArgs(
          initializeDepositFixture.depositKey,
          initializeDepositFixture.destinationChainDepositOwner.toLowerCase(),
          relayer.address,
          depositAmount.mul(satoshiMultiplier),
          expectedTbtcAmountReimbursed
        )
    })
  })
})

// Just an arbitrary TBTCVault address.
const tbtcVaultAddress = "0xB5679dE944A79732A75CE556191DF11F489448d5"
