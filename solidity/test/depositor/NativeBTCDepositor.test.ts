import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import {
  IBridge,
  ITBTCVault,
  NativeBTCDepositor,
  ReimbursementPool,
  TestERC20,
} from "../../typechain"
import type {
  BitcoinTxInfoStruct,
  DepositRevealInfoStruct,
} from "../../typechain/Bridge"
import { to1ePrecision } from "../helpers/contract-test-helpers"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

describe("NativeBTCDepositor", () => {
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

    const reimbursementPool = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `NativeBTCDepositor_${randomBytes(8).toString("hex")}`,
      {
        contractName: "NativeBTCDepositor",
        initializerArgs: [
          bridge.address,
          tbtcVault.address,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    const nativeBtcDepositor = deployment[0] as NativeBTCDepositor

    await nativeBtcDepositor.connect(deployer).transferOwnership(
      governance.address
    )

    return {
      governance,
      relayer,
      bridge,
      tbtcToken,
      tbtcVault,
      reimbursementPool,
      nativeBtcDepositor,
    }
  }

  let governance: SignerWithAddress
  let relayer: SignerWithAddress

  let bridge: FakeContract<IBridge>
  let tbtcToken: TestERC20
  let tbtcVault: FakeContract<ITBTCVault>
  let reimbursementPool: FakeContract<ReimbursementPool>
  let nativeBtcDepositor: NativeBTCDepositor

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      relayer,
      bridge,
      tbtcToken,
      tbtcVault,
      reimbursementPool,
      nativeBtcDepositor,
    } = await waffle.loadFixture(contractsFixture))
  })

  describe("updateReimbursementPool", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          nativeBtcDepositor.connect(relayer).updateReimbursementPool(
            reimbursementPool.address
          )
        ).to.be.revertedWith("Caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await nativeBtcDepositor.connect(governance).updateReimbursementPool(
          reimbursementPool.address
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the reimbursementPool address properly", async () => {
        expect(await nativeBtcDepositor.reimbursementPool()).to.equal(
          reimbursementPool.address
        )
      })

      it("should emit ReimbursementPoolUpdated event", async () => {
        await expect(
          nativeBtcDepositor.connect(governance).updateReimbursementPool(
            reimbursementPool.address
          )
        )
          .to.emit(nativeBtcDepositor, "ReimbursementPoolUpdated")
          .withArgs(reimbursementPool.address)
      })
    })
  })

  describe("updateGasOffsetParameters", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          nativeBtcDepositor.connect(relayer).updateGasOffsetParameters(
            1000,
            2000
          )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      before(async () => {
        await createSnapshot()

        await nativeBtcDepositor.connect(governance).updateGasOffsetParameters(
          1000,
          2000
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the gas offset params properly", async () => {
        expect(
          await nativeBtcDepositor.initializeDepositGasOffset()
        ).to.be.equal(1000)

        expect(await nativeBtcDepositor.finalizeDepositGasOffset()).to.be.equal(
          2000
        )
      })

      it("should emit GasOffsetParametersUpdated event", async () => {
        await expect(
          nativeBtcDepositor.connect(governance).updateGasOffsetParameters(
            1000,
            2000
          )
        )
          .to.emit(nativeBtcDepositor, "GasOffsetParametersUpdated")
          .withArgs(1000, 2000)
      })
    })
  })

  describe("updateReimbursementAuthorization", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          nativeBtcDepositor.connect(relayer).updateReimbursementAuthorization(
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

        tx = await nativeBtcDepositor.connect(
          governance
        ).updateReimbursementAuthorization(relayer.address, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the authorization properly", async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await nativeBtcDepositor.reimbursementAuthorizations(relayer.address)
        ).to.be.true
      })

      it("should emit ReimbursementAuthorizationUpdated event", async () => {
        await expect(tx)
          .to.emit(nativeBtcDepositor, "ReimbursementAuthorizationUpdated")
          .withArgs(relayer.address, true)
      })
    })
  })

  describe("initializeDeposit", () => {
    context("when the ethereum receiver address is zero", () => {
      it("should revert", async () => {
        await expect(
          nativeBtcDepositor.connect(relayer).initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            ethers.constants.HashZero
          )
        ).to.be.revertedWith("L2 deposit owner must not be 0x0")
      })
    })

    context("when the ethereum receiver address is non-zero", () => {
      context("when the requested vault is not TBTCVault", () => {
        it("should revert", async () => {
          const corruptedReveal = JSON.parse(
            JSON.stringify(initializeDepositFixture.reveal)
          )

          // Set another vault address deliberately. This value must be
          // different from the tbtcVaultAddress constant used in the fixture.
          corruptedReveal.vault = ethers.constants.AddressZero

          await expect(
            nativeBtcDepositor.connect(relayer).initializeDeposit(
              initializeDepositFixture.fundingTx,
              corruptedReveal,
              initializeDepositFixture.ethereumReceiverBytes32
            )
          ).to.be.revertedWith("Vault address mismatch")
        })
      })

      context("when the requested vault is TBTCVault", () => {
        context("when the deposit state is wrong", () => {
          context("when the deposit state is Initialized", () => {
            before(async () => {
              await createSnapshot()

              await nativeBtcDepositor.connect(relayer).initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.ethereumReceiverBytes32
              )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                nativeBtcDepositor.connect(relayer).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.ethereumReceiverBytes32
                )
              ).to.be.revertedWith("Wrong deposit state")
            })
          })

          context("when the deposit state is Finalized", () => {
            before(async () => {
              await createSnapshot()

              await nativeBtcDepositor.connect(relayer).initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.ethereumReceiverBytes32
              )

              // Set the Bridge mock to return a deposit state that allows
              // to finalize the deposit. Set only relevant fields.
              const revealedAt = (await lastBlockTime()) - 7200
              const finalizedAt = await lastBlockTime()
              bridge.deposits
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns({
                  depositor: nativeBtcDepositor.address,
                  amount: BigNumber.from(100000),
                  revealedAt,
                  vault: initializeDepositFixture.reveal.vault,
                  treasuryFee: BigNumber.from(0),
                  sweptAt: finalizedAt,
                  extraData: initializeDepositFixture.ethereumReceiverBytes32,
                })

              // Set the TBTCVault mock to return a deposit state
              // that allows to finalize the deposit.
              tbtcVault.optimisticMintingRequests
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns([revealedAt, finalizedAt])

              // Mint tBTC to the depositor contract to allow finalization
              await tbtcToken.mint(nativeBtcDepositor.address, to1ePrecision(10, 18))

              await nativeBtcDepositor.connect(relayer).finalizeDeposit(
                initializeDepositFixture.depositKey,
                {
                  value: 0, // No payment needed for native
                }
              )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()
              bridge.deposits.reset()
              tbtcVault.optimisticMintingRequests.reset()

              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                nativeBtcDepositor.connect(relayer).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.ethereumReceiverBytes32
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
                  initializeDepositFixture.ethereumReceiverBytes32
                )
                .returns()

              tx = await nativeBtcDepositor.connect(relayer).initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.ethereumReceiverBytes32
              )
            })

            after(async () => {
              bridge.revealDepositWithExtraData.reset()

              await restoreSnapshot()
            })

            it("should reveal the deposit to the Bridge", async () => {
              // eslint-disable-next-line @typescript-eslint/no-unused-expressions
              expect(bridge.revealDepositWithExtraData).to.have.been.calledOnce

              const { fundingTx, reveal, ethereumReceiverBytes32 } =
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
                ethereumReceiverBytes32.toLowerCase()
              )
            })

            it("should set the deposit state to Initialized", async () => {
              expect(
                await nativeBtcDepositor.deposits(
                  initializeDepositFixture.depositKey
                )
              ).to.equal(1)
            })

            it("should emit DepositInitialized event", async () => {
              await expect(tx)
                .to.emit(nativeBtcDepositor, "DepositInitialized")
                .withArgs(
                  initializeDepositFixture.depositKey,
                  initializeDepositFixture.ethereumReceiverBytes32.toLowerCase(),
                  relayer.address
                )
            })

            it("should not store the deferred gas reimbursement", async () => {
              expect(
                await nativeBtcDepositor.gasReimbursements(
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
                    initializeDepositFixture.ethereumReceiverBytes32
                  )
                  .returns()

                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementPool(reimbursementPool.address)

                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementAuthorization(relayer.address, true)

                tx = await nativeBtcDepositor.connect(
                  relayer
                ).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.ethereumReceiverBytes32
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

                const { fundingTx, reveal, ethereumReceiverBytes32 } =
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
                  ethereumReceiverBytes32.toLowerCase()
                )
              })

              it("should set the deposit state to Initialized", async () => {
                expect(
                  await nativeBtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(1)
              })

              it("should emit DepositInitialized event", async () => {
                await expect(tx)
                  .to.emit(nativeBtcDepositor, "DepositInitialized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.ethereumReceiverBytes32.toLowerCase(),
                    relayer.address
                  )
              })

              it("should store the deferred gas reimbursement", async () => {
                const gasReimbursement =
                  await nativeBtcDepositor.gasReimbursements(
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
                    initializeDepositFixture.ethereumReceiverBytes32
                  )
                  .returns()

                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementPool(reimbursementPool.address)

                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementAuthorization(relayer.address, false)

                tx = await nativeBtcDepositor.connect(
                  relayer
                ).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.ethereumReceiverBytes32
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

                const { fundingTx, reveal, ethereumReceiverBytes32 } =
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
                  ethereumReceiverBytes32.toLowerCase()
                )
              })

              it("should set the deposit state to Initialized", async () => {
                expect(
                  await nativeBtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(1)
              })

              it("should emit DepositInitialized event", async () => {
                await expect(tx)
                  .to.emit(nativeBtcDepositor, "DepositInitialized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.ethereumReceiverBytes32.toLowerCase(),
                    relayer.address
                  )
              })

              it("should not store the deferred gas reimbursement", async () => {
                expect(
                  await nativeBtcDepositor.gasReimbursements(
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
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the deposit state is wrong", () => {
      context("when the deposit state is Unknown", () => {
        it("should revert", async () => {
          await expect(
            nativeBtcDepositor.connect(relayer).finalizeDeposit(
              initializeDepositFixture.depositKey
            )
          ).to.be.revertedWith("Wrong deposit state")
        })
      })

      context("when the deposit state is Finalized", () => {
        before(async () => {
          await createSnapshot()

          await nativeBtcDepositor.connect(relayer).initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            initializeDepositFixture.ethereumReceiverBytes32
          )

          // Set the Bridge mock to return a deposit state that allows
          // to finalize the deposit. Set only relevant fields.
          const revealedAt = (await lastBlockTime()) - 7200
          const finalizedAt = await lastBlockTime()
          bridge.deposits
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns({
              depositor: nativeBtcDepositor.address,
              amount: BigNumber.from(100000),
              revealedAt,
              vault: initializeDepositFixture.reveal.vault,
              treasuryFee: BigNumber.from(0),
              sweptAt: finalizedAt,
              extraData: initializeDepositFixture.ethereumReceiverBytes32,
            })

          // Set the TBTCVault mock to return a deposit state
          // that allows to finalize the deposit.
          tbtcVault.optimisticMintingRequests
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns([revealedAt, finalizedAt])

          // Mint tBTC to the depositor contract to allow finalization
          await tbtcToken.mint(nativeBtcDepositor.address, to1ePrecision(10, 18))

          await nativeBtcDepositor.connect(relayer).finalizeDeposit(
            initializeDepositFixture.depositKey,
            {
              value: 0,
            }
          )
        })

        after(async () => {
          bridge.revealDepositWithExtraData.reset()
          bridge.deposits.reset()
          tbtcVault.optimisticMintingRequests.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            nativeBtcDepositor.connect(relayer).finalizeDeposit(
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

          await nativeBtcDepositor.connect(relayer).initializeDeposit(
            initializeDepositFixture.fundingTx,
            initializeDepositFixture.reveal,
            initializeDepositFixture.ethereumReceiverBytes32
          )

          // Set the Bridge mock to return a deposit state that does not allow
          // to finalize the deposit. Set only relevant fields.
          const revealedAt = (await lastBlockTime()) - 7200
          bridge.deposits
            .whenCalledWith(initializeDepositFixture.depositKey)
            .returns({
              depositor: nativeBtcDepositor.address,
              amount: BigNumber.from(100000),
              revealedAt,
              vault: initializeDepositFixture.reveal.vault,
              treasuryFee: BigNumber.from(0),
              sweptAt: 0,
              extraData: initializeDepositFixture.ethereumReceiverBytes32,
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
            nativeBtcDepositor.connect(relayer).finalizeDeposit(
              initializeDepositFixture.depositKey
            )
          ).to.be.revertedWith("Deposit not finalized by the bridge")
        })
      })

      context("when the deposit is finalized by the Bridge", () => {
        context("when normalized amount is too low to transfer", () => {
          before(async () => {
            await createSnapshot()

            await nativeBtcDepositor.connect(relayer).initializeDeposit(
              initializeDepositFixture.fundingTx,
              initializeDepositFixture.reveal,
              initializeDepositFixture.ethereumReceiverBytes32
            )

            // Set the Bridge mock to return a deposit state that pass the
            // finalization check but fails the normalized amount check.
            // Set only relevant fields.
            const revealedAt = (await lastBlockTime()) - 7200
            const finalizedAt = await lastBlockTime()
            bridge.deposits
              .whenCalledWith(initializeDepositFixture.depositKey)
              .returns({
              depositor: nativeBtcDepositor.address,
              amount: BigNumber.from(0),
              revealedAt,
              vault: initializeDepositFixture.reveal.vault,
                treasuryFee: BigNumber.from(0),
                sweptAt: finalizedAt,
                extraData: initializeDepositFixture.ethereumReceiverBytes32,
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
              nativeBtcDepositor.connect(relayer).finalizeDeposit(
                initializeDepositFixture.depositKey
              )
            ).to.be.revertedWith("Amount too low to transfer")
          })
        })

        context("when normalized amount is not too low to transfer", () => {
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

          let tx: ContractTransaction

          context("when the reimbursement pool is not set", () => {
            before(async () => {
              await createSnapshot()

              await nativeBtcDepositor.connect(relayer).initializeDeposit(
                initializeDepositFixture.fundingTx,
                initializeDepositFixture.reveal,
                initializeDepositFixture.ethereumReceiverBytes32
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
                  depositor: nativeBtcDepositor.address,
                  amount: depositAmount,
                  revealedAt,
                  vault: initializeDepositFixture.reveal.vault,
                  treasuryFee,
                  sweptAt: finalizedAt,
                  extraData:
                    initializeDepositFixture.ethereumReceiverBytes32,
                })

              // Set the TBTCVault mock to return a deposit state
              // that allows to finalize the deposit.
              tbtcVault.optimisticMintingRequests
                .whenCalledWith(initializeDepositFixture.depositKey)
                .returns([revealedAt, finalizedAt])

              // Mint tBTC to the depositor contract
              await tbtcToken.mint(nativeBtcDepositor.address, expectedTbtcAmount)

              tx = await nativeBtcDepositor.connect(relayer).finalizeDeposit(
                initializeDepositFixture.depositKey,
                {
                  value: 0,
                }
              )
            })

            after(async () => {
              bridge.depositParameters.reset()
              tbtcVault.optimisticMintingFeeDivisor.reset()
              bridge.revealDepositWithExtraData.reset()
              bridge.deposits.reset()
              tbtcVault.optimisticMintingRequests.reset()

              await restoreSnapshot()
            })

            it("should set the deposit state to Finalized", async () => {
              expect(
                await nativeBtcDepositor.deposits(
                  initializeDepositFixture.depositKey
                )
              ).to.equal(2)
            })

            it("should emit DepositFinalized event", async () => {
              await expect(tx)
                .to.emit(nativeBtcDepositor, "DepositFinalized")
                .withArgs(
                  initializeDepositFixture.depositKey,
                  initializeDepositFixture.ethereumReceiverBytes32.toLowerCase(),
                  relayer.address,
                  depositAmount.mul(satoshiMultiplier),
                  expectedTbtcAmount
                )
            })

            it("should transfer tBTC to the ethereum receiver", async () => {
              const receiverAddress = ethers.utils.getAddress(
                "0x" + initializeDepositFixture.ethereumReceiverBytes32.slice(-40)
              )
              expect(
                await tbtcToken.balanceOf(receiverAddress)
              ).to.equal(expectedTbtcAmount)
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

                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementPool(reimbursementPool.address)

                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementAuthorization(relayer.address, true)

                await nativeBtcDepositor.connect(relayer).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.ethereumReceiverBytes32
                )

                // Capture the gas spent for the initializeDeposit call
                // for post-finalization comparison.
                initializeDepositGasSpent = (
                  await nativeBtcDepositor.gasReimbursements(
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
                    depositor: nativeBtcDepositor.address,
                    amount: depositAmount,
                    revealedAt,
                    vault: initializeDepositFixture.reveal.vault,
                    treasuryFee,
                    sweptAt: finalizedAt,
                    extraData:
                      initializeDepositFixture.ethereumReceiverBytes32,
                  })

                // Set the TBTCVault mock to return a deposit state
                // that allows to finalize the deposit.
                tbtcVault.optimisticMintingRequests
                  .whenCalledWith(initializeDepositFixture.depositKey)
                  .returns([revealedAt, finalizedAt])

                // Mint tBTC to the depositor contract
                await tbtcToken.mint(nativeBtcDepositor.address, expectedTbtcAmount)

                tx = await nativeBtcDepositor.connect(
                  relayer
                ).finalizeDeposit(initializeDepositFixture.depositKey, {
                  value: 0,
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

                await restoreSnapshot()
              })

              it("should set the deposit state to Finalized", async () => {
                expect(
                  await nativeBtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(2)
              })

              it("should emit DepositFinalized event", async () => {
                await expect(tx)
                  .to.emit(nativeBtcDepositor, "DepositFinalized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.ethereumReceiverBytes32.toLowerCase(),
                    relayer.address,
                    depositAmount.mul(satoshiMultiplier),
                    expectedTbtcAmount
                  )
              })

              it("should transfer tBTC to the ethereum receiver", async () => {
                const receiverAddress = ethers.utils.getAddress(
                  "0x" + initializeDepositFixture.ethereumReceiverBytes32.slice(-40)
                )
                expect(
                  await tbtcToken.balanceOf(receiverAddress)
                ).to.equal(expectedTbtcAmount)
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
                // value here because mocks are used for testing and
                // the resulting value won't be realistic. We only check
                // that the reimbursement is greater than zero which means
                // the reimbursement has been recorded properly.
                expect(
                  BigNumber.from(call2.args[0]).toNumber()
                ).to.be.greaterThan(0)
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

                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementPool(reimbursementPool.address)

                // Authorize just for deposit initialization.
                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementAuthorization(relayer.address, true)

                await nativeBtcDepositor.connect(relayer).initializeDeposit(
                  initializeDepositFixture.fundingTx,
                  initializeDepositFixture.reveal,
                  initializeDepositFixture.ethereumReceiverBytes32
                )

                // Capture the gas spent for the initializeDeposit call
                // for post-finalization comparison.
                initializeDepositGasSpent = (
                  await nativeBtcDepositor.gasReimbursements(
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
                    depositor: nativeBtcDepositor.address,
                    amount: depositAmount,
                    revealedAt,
                    vault: initializeDepositFixture.reveal.vault,
                    treasuryFee,
                    sweptAt: finalizedAt,
                    extraData:
                      initializeDepositFixture.ethereumReceiverBytes32,
                  })

                // Set the TBTCVault mock to return a deposit state
                // that allows to finalize the deposit.
                tbtcVault.optimisticMintingRequests
                  .whenCalledWith(initializeDepositFixture.depositKey)
                  .returns([revealedAt, finalizedAt])

                // Mint tBTC to the depositor contract
                await tbtcToken.mint(nativeBtcDepositor.address, expectedTbtcAmount)

                // De-authorize for deposit finalization.
                await nativeBtcDepositor.connect(
                  governance
                ).updateReimbursementAuthorization(relayer.address, false)

                tx = await nativeBtcDepositor.connect(
                  relayer
                ).finalizeDeposit(initializeDepositFixture.depositKey, {
                  value: 0,
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

                await restoreSnapshot()
              })

              it("should set the deposit state to Finalized", async () => {
                expect(
                  await nativeBtcDepositor.deposits(
                    initializeDepositFixture.depositKey
                  )
                ).to.equal(2)
              })

              it("should emit DepositFinalized event", async () => {
                await expect(tx)
                  .to.emit(nativeBtcDepositor, "DepositFinalized")
                  .withArgs(
                    initializeDepositFixture.depositKey,
                    initializeDepositFixture.ethereumReceiverBytes32.toLowerCase(),
                    relayer.address,
                    depositAmount.mul(satoshiMultiplier),
                    expectedTbtcAmount
                  )
              })

              it("should transfer tBTC to the ethereum receiver", async () => {
                const receiverAddress = ethers.utils.getAddress(
                  "0x" + initializeDepositFixture.ethereumReceiverBytes32.slice(-40)
                )
                expect(
                  await tbtcToken.balanceOf(receiverAddress)
                ).to.equal(expectedTbtcAmount)
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

  describe("quoteFinalizeDeposit", () => {
    it("should return zero cost", async () => {
      const cost = await nativeBtcDepositor.quoteFinalizeDeposit()
      expect(cost).to.be.equal(0)
    })
  })

  context("when reimburseTxMaxFee is true", () => {
    const satoshiMultiplier = to1ePrecision(1, 10)
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
      await nativeBtcDepositor.connect(governance).setReimburseTxMaxFee(true)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should add depositTxMaxFee back to the minted TBTC amount", async () => {
      // 1) Initialize deposit
      await nativeBtcDepositor.connect(relayer).initializeDeposit(
        initializeDepositFixture.fundingTx,
        initializeDepositFixture.reveal,
        initializeDepositFixture.ethereumReceiverBytes32
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
          depositor: nativeBtcDepositor.address,
          amount: depositAmount,
          revealedAt,
          vault: initializeDepositFixture.reveal.vault,
          treasuryFee,
          sweptAt: finalizedAt,
          extraData: initializeDepositFixture.ethereumReceiverBytes32,
        })
      tbtcVault.optimisticMintingRequests
        .whenCalledWith(initializeDepositFixture.depositKey)
        .returns([revealedAt, finalizedAt])

      // 5) Mint tBTC to the depositor contract with reimbursed amount
      await tbtcToken.mint(nativeBtcDepositor.address, expectedTbtcAmountReimbursed)

      // 6) Now finalize
      const tx = await nativeBtcDepositor.connect(relayer).finalizeDeposit(
        initializeDepositFixture.depositKey,
        {
          value: 0,
        }
      )

      // 7) The final minted TBTC should be 94525e10
      await expect(tx)
        .to.emit(nativeBtcDepositor, "DepositFinalized")
        .withArgs(
          initializeDepositFixture.depositKey,
          initializeDepositFixture.ethereumReceiverBytes32.toLowerCase(),
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
  ethereumReceiverBytes32: string
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
  // This is actually the ethereum receiver address in bytes32 format
  ethereumReceiverBytes32: "0x00000000000000000000000023b82a7108F9CEb34C3CDC44268be21D151d4124",
}
