/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { SigningKey } from "ethers/lib/utils"
import chai, { expect } from "chai"
import { BigNumber, Contract, ContractTransaction } from "ethers"
import { BytesLike } from "@ethersproject/bytes"
import { FakeContract, smock } from "@defi-wonderland/smock"
import type {
  IWalletRegistry,
  Bridge,
  BridgeStub,
  BridgeGovernance,
} from "../../typechain"
import {
  wallet as fraudWallet,
  nonWitnessSignSingleInputTx,
  nonWitnessSignMultipleInputsTx,
  witnessSignSingleInputTx,
  witnessSignMultipleInputTx,
  wrongSighashType,
} from "../data/fraud"
import { walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"
import { ecdsaWalletTestData } from "../data/ecdsa"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time
const { keccak256, sha256 } = ethers.utils

const { publicKey: walletPublicKey, pubKeyHash160: walletPublicKeyHash } =
  fraudWallet

describe("Bridge - Fraud", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress

  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  let fraudChallengeDepositAmount: BigNumber
  let fraudChallengeDefeatTimeout: number
  let fraudSlashingAmount: BigNumber
  let fraudNotifierRewardMultiplier: number

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      thirdParty,
      treasury,
      walletRegistry,
      bridge,
      bridgeGovernance,
    } = await waffle.loadFixture(bridgeFixture))
    ;({
      fraudChallengeDepositAmount,
      fraudChallengeDefeatTimeout,
      fraudSlashingAmount,
      fraudNotifierRewardMultiplier,
    } = await bridge.fraudParameters())
  })

  describe("submitFraudChallenge", () => {
    const data = witnessSignSingleInputTx

    context("when the wallet is in Live state", () => {
      context("when the amount of ETH deposited is enough", () => {
        context(
          "when the data needed for signature verification is correct",
          () => {
            context("when the fraud challenge does not exist yet", () => {
              let tx: ContractTransaction

              before(async () => {
                await createSnapshot()

                await bridge.setWallet(walletPublicKeyHash, {
                  ecdsaWalletID: ethers.constants.HashZero,
                  mainUtxoHash: ethers.constants.HashZero,
                  pendingRedemptionsValue: 0,
                  createdAt: await lastBlockTime(),
                  movingFundsRequestedAt: 0,
                  closingStartedAt: 0,
                  pendingMovedFundsSweepRequestsCount: 0,
                  state: walletState.Live,
                  movingFundsTargetWalletsCommitmentHash:
                    ethers.constants.HashZero,
                })

                tx = await bridge
                  .connect(thirdParty)
                  .submitFraudChallenge(
                    walletPublicKey,
                    data.preimageSha256,
                    data.signature,
                    {
                      value: fraudChallengeDepositAmount,
                    }
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should transfer ether from the caller to the bridge", async () => {
                await expect(tx).to.changeEtherBalance(
                  thirdParty,
                  fraudChallengeDepositAmount.mul(-1)
                )
                await expect(tx).to.changeEtherBalance(
                  bridge,
                  fraudChallengeDepositAmount
                )
              })

              it("should store the fraud challenge data", async () => {
                const challengeKey = buildChallengeKey(
                  walletPublicKey,
                  data.sighash
                )

                const fraudChallenge = await bridge.fraudChallenges(
                  challengeKey
                )

                expect(fraudChallenge.challenger).to.equal(
                  await thirdParty.getAddress()
                )
                expect(fraudChallenge.depositAmount).to.equal(
                  fraudChallengeDepositAmount
                )
                expect(fraudChallenge.reportedAt).to.equal(
                  await lastBlockTime()
                )
                expect(fraudChallenge.resolved).to.equal(false)
              })

              it("should emit FraudChallengeSubmitted event", async () => {
                await expect(tx)
                  .to.emit(bridge, "FraudChallengeSubmitted")
                  .withArgs(
                    walletPublicKeyHash,
                    data.sighash,
                    data.signature.v,
                    data.signature.r,
                    data.signature.s
                  )
              })
            })

            context("when the fraud challenge already exists", () => {
              before(async () => {
                await createSnapshot()

                await bridge.setWallet(walletPublicKeyHash, {
                  ecdsaWalletID: ethers.constants.HashZero,
                  mainUtxoHash: ethers.constants.HashZero,
                  pendingRedemptionsValue: 0,
                  createdAt: await lastBlockTime(),
                  movingFundsRequestedAt: 0,
                  closingStartedAt: 0,
                  pendingMovedFundsSweepRequestsCount: 0,
                  state: walletState.Live,
                  movingFundsTargetWalletsCommitmentHash:
                    ethers.constants.HashZero,
                })

                await bridge
                  .connect(thirdParty)
                  .submitFraudChallenge(
                    walletPublicKey,
                    data.preimageSha256,
                    data.signature,
                    {
                      value: fraudChallengeDepositAmount,
                    }
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  bridge
                    .connect(thirdParty)
                    .submitFraudChallenge(
                      walletPublicKey,
                      data.preimageSha256,
                      data.signature,
                      {
                        value: fraudChallengeDepositAmount,
                      }
                    )
                ).to.be.revertedWith("Fraud challenge already exists")
              })
            })
          }
        )

        context("when incorrect wallet public key is used", () => {
          // Unrelated Bitcoin public key
          const incorrectWalletPublicKey =
            "0xffc045ade19f8a5d464299146ce069049cdcc2390a9b44d9abcd83f11d8cce4" +
            "01ea6800e307b87aadebdcd2f7293cc60f0526afaff1a7b1abddfd787e6c5871e"

          const incorrectWalletPublicKeyHash =
            "0xb5222794425b9b8cd8c3358e73a50dea73480927"

          before(async () => {
            await createSnapshot()
            await bridge.setWallet(incorrectWalletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  incorrectWalletPublicKey,
                  data.preimageSha256,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )
            ).to.be.revertedWith("Signature verification failure")
          })
        })

        context("when incorrect sighash is used", () => {
          // Random hex-string
          const incorrectSighash =
            "0x9e8e249791a5636e5e007fc15487b5a5bd6e60f73f7e236a7025cd63b904650b"

          before(async () => {
            await createSnapshot()
            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  incorrectSighash,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )
            ).to.be.revertedWith("Signature verification failure")
          })
        })

        context("when incorrect recovery ID is used", () => {
          // Increase the value of v by 1
          const incorrectV = data.signature.v + 1

          before(async () => {
            await createSnapshot()
            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.connect(thirdParty).submitFraudChallenge(
                walletPublicKey,
                data.preimageSha256,
                {
                  r: data.signature.r,
                  s: data.signature.s,
                  v: incorrectV,
                },
                {
                  value: fraudChallengeDepositAmount,
                }
              )
            ).to.be.revertedWith("Signature verification failure")
          })
        })

        context("when incorrect signature data is used", () => {
          // Swap r and s
          const incorrectS = data.signature.r
          const incorrectR = data.signature.s

          before(async () => {
            await createSnapshot()
            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.connect(thirdParty).submitFraudChallenge(
                walletPublicKey,
                data.preimageSha256,
                {
                  r: incorrectR,
                  s: incorrectS,
                  v: data.signature.v,
                },
                {
                  value: fraudChallengeDepositAmount,
                }
              )
            ).to.be.revertedWith("Signature verification failure")
          })
        })
      })

      context("when the amount of ETH deposited is too low", () => {
        before(async () => {
          await createSnapshot()
          await bridge.setWallet(walletPublicKeyHash, {
            ecdsaWalletID: ethers.constants.HashZero,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.preimageSha256,
                data.signature,
                {
                  value: fraudChallengeDepositAmount.sub(1),
                }
              )
          ).to.be.revertedWith("The amount of ETH deposited is too low")
        })
      })
    })

    context("when the wallet is in MovingFunds state", () => {
      before(async () => {
        await createSnapshot()
        await bridge.setWallet(walletPublicKeyHash, {
          ecdsaWalletID: ethers.constants.HashZero,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.MovingFunds,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              data.preimageSha256,
              data.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )
        ).to.not.be.reverted
      })
    })

    context("when the wallet is in Closing state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(walletPublicKeyHash, {
          ecdsaWalletID: ethers.constants.HashZero,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.Closing,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              data.preimageSha256,
              data.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )
        ).to.not.be.reverted
      })
    })

    context(
      "when the wallet is in neither Live nor MovingFunds nor Closing state",
      () => {
        const testData = [
          {
            testName: "when wallet state is Unknown",
            walletState: walletState.Unknown,
          },
          {
            testName: "when wallet state is Closed",
            walletState: walletState.Closed,
          },
          {
            testName: "when wallet state is Terminated",
            walletState: walletState.Terminated,
          },
        ]

        testData.forEach((test) => {
          context(test.testName, () => {
            before(async () => {
              await createSnapshot()
              await bridge.setWallet(walletPublicKeyHash, {
                ecdsaWalletID: ethers.constants.HashZero,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: await lastBlockTime(),
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: test.walletState,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge
                  .connect(thirdParty)
                  .submitFraudChallenge(
                    walletPublicKey,
                    data.preimageSha256,
                    data.signature,
                    {
                      value: fraudChallengeDepositAmount,
                    }
                  )
              ).to.be.revertedWith(
                "Wallet must be in Live or MovingFunds or Closing state"
              )
            })
          })
        })
      }
    )
  })

  describe("defeatFraudChallengeWithHeartbeat", () => {
    let heartbeatWalletPublicKey: string
    let heartbeatWalletPublicKeyHash: string
    let heartbeatWalletSigningKey: SigningKey

    before(async () => {
      await createSnapshot()

      // For `defeatFraudChallengeWithHeartbeat` unit tests we do not use test
      // data from `fraud.ts`. Instead, we create random wallet and use its
      // SigningKey.
      //
      // This approach is better long-term. In case the format of the heartbeat
      // message changes or in case we want to add more unit tests, we can simply
      // call appropriate function to compute another signature. Also, we do not
      // use any BTC-specific data for this set of unit tests.
      const wallet = ethers.Wallet.createRandom()
      // We use `ethers.utils.SigningKey` for a `Wallet` instead of
      // `Signer.signMessage` to do not add '\x19Ethereum Signed Message:\n'
      // prefix to the signed message. The format of the heartbeat message is
      // the same no matter on which host chain TBTC is deployed.
      heartbeatWalletSigningKey = new ethers.utils.SigningKey(wallet.privateKey)
      // Public key obtained as `wallet.publicKey` is an uncompressed key,
      // prefixed with `0x04`. To compute raw ECDSA key, we need to drop `0x04`.
      heartbeatWalletPublicKey = `0x${wallet.publicKey.substring(4)}`

      const walletID = keccak256(heartbeatWalletPublicKey)
      const walletPublicKeyX = `0x${heartbeatWalletPublicKey.substring(2, 66)}`
      const walletPublicKeyY = `0x${heartbeatWalletPublicKey.substring(66)}`
      await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          walletID,
          walletPublicKeyX,
          walletPublicKeyY
        )
      heartbeatWalletPublicKeyHash = await bridge.activeWalletPubKeyHash()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the challenge exists", () => {
      context("when the challenge is open", () => {
        context("when the heartbeat message has correct format", () => {
          const heartbeatMessage = "0xFFFFFFFFFFFFFFFF0000000000E0EED7"
          const heartbeatMessageSha256 = sha256(heartbeatMessage)
          const sighash = sha256(heartbeatMessageSha256)

          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            const signature = ethers.utils.splitSignature(
              heartbeatWalletSigningKey.signDigest(sighash)
            )

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                heartbeatWalletPublicKey,
                heartbeatMessageSha256,
                signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )

            tx = await bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithHeartbeat(
                heartbeatWalletPublicKey,
                heartbeatMessage
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should mark the challenge as resolved", async () => {
            const challengeKey = buildChallengeKey(
              heartbeatWalletPublicKey,
              sighash
            )
            const fraudChallenge = await bridge.fraudChallenges(challengeKey)
            expect(fraudChallenge.resolved).to.equal(true)
          })

          it("should send the ether deposited by the challenger to the treasury", async () => {
            await expect(tx).to.changeEtherBalance(
              bridge,
              fraudChallengeDepositAmount.mul(-1)
            )
            await expect(tx).to.changeEtherBalance(
              treasury,
              fraudChallengeDepositAmount
            )
          })

          it("should emit FraudChallengeDefeated event", async () => {
            await expect(tx)
              .to.emit(bridge, "FraudChallengeDefeated")
              .withArgs(heartbeatWalletPublicKeyHash, sighash)
          })
        })

        context("when the heartbeat message has no correct format", () => {
          const notHeartbeatMessage = "0xAAFFFFFFFFFFFFFF0000000000E0EED7"
          const heartbeatMessageSha256 = sha256(notHeartbeatMessage)
          const sighash = sha256(heartbeatMessageSha256)

          before(async () => {
            await createSnapshot()

            const signature = ethers.utils.splitSignature(
              heartbeatWalletSigningKey.signDigest(sighash)
            )

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                heartbeatWalletPublicKey,
                heartbeatMessageSha256,
                signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .defeatFraudChallengeWithHeartbeat(
                  heartbeatWalletPublicKey,
                  notHeartbeatMessage
                )
            ).to.be.revertedWith("Not a valid heartbeat message")
          })
        })
      })

      context("when the challenge is resolved by defeat", () => {
        const heartbeatMessage = "0xFFFFFFFFFFFFFFFF0000000000E0EED7"
        const heartbeatMessageSha256 = sha256(heartbeatMessage)
        const sighash = sha256(heartbeatMessageSha256)

        before(async () => {
          await createSnapshot()

          const signature = ethers.utils.splitSignature(
            heartbeatWalletSigningKey.signDigest(sighash)
          )

          await bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              heartbeatWalletPublicKey,
              heartbeatMessageSha256,
              signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )

          await bridge
            .connect(thirdParty)
            .defeatFraudChallengeWithHeartbeat(
              heartbeatWalletPublicKey,
              heartbeatMessage
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithHeartbeat(
                heartbeatWalletPublicKey,
                heartbeatMessage
              )
          ).to.be.revertedWith("Fraud challenge has already been resolved")
        })
      })

      context("when the challenge is resolved by timeout", () => {
        const heartbeatMessage = "0xFFFFFFFFFFFFFFFF0000000000E0EED7"
        const heartbeatMessageSha256 = sha256(heartbeatMessage)
        const sighash = sha256(heartbeatMessageSha256)

        before(async () => {
          await createSnapshot()

          const signature = ethers.utils.splitSignature(
            heartbeatWalletSigningKey.signDigest(sighash)
          )

          await bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              heartbeatWalletPublicKey,
              heartbeatMessageSha256,
              signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )

          await increaseTime(fraudChallengeDefeatTimeout)

          await bridge
            .connect(thirdParty)
            .notifyFraudChallengeDefeatTimeout(
              heartbeatWalletPublicKey,
              [],
              heartbeatMessageSha256
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithHeartbeat(
                heartbeatWalletPublicKey,
                heartbeatMessage
              )
          ).to.be.revertedWith("Fraud challenge has already been resolved")
        })
      })
    })

    context("when the challenge does not exist", () => {
      const heartbeatMessage = "0xFFFFFFFFFFFFFFFF0000000000E0EED7"
      const heartbeatMessageSha256 = sha256(heartbeatMessage)
      const sighash = sha256(heartbeatMessageSha256)

      before(async () => {
        await createSnapshot()

        const signature = ethers.utils.splitSignature(
          heartbeatWalletSigningKey.signDigest(sighash)
        )

        await bridge
          .connect(thirdParty)
          .submitFraudChallenge(
            heartbeatWalletPublicKey,
            heartbeatMessageSha256,
            signature,
            {
              value: fraudChallengeDepositAmount,
            }
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridge.connect(thirdParty).defeatFraudChallengeWithHeartbeat(
            heartbeatWalletPublicKey,
            "0xFFFFFFFFFFFFFFFF0000000000E0EED8" // ...D7 -> ...D8
          )
        ).to.be.revertedWith("Fraud challenge does not exist")
      })
    })
  })

  describe("defeatFraudChallenge", () => {
    context("when the challenge exists", () => {
      context("when the challenge is open", () => {
        context("when the sighash type is correct", () => {
          context("when the input is non-witness", () => {
            context("when the transaction has single input", () => {
              context(
                "when the input is marked as correctly spent in the Bridge",
                () => {
                  const data = nonWitnessSignSingleInputTx
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      pendingMovedFundsSweepRequestsCount: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })
                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)
                    await bridge.setProcessedMovedFundsSweepRequests(
                      data.movedFundsSweepRequests
                    )

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    tx = await bridge
                      .connect(thirdParty)
                      .defeatFraudChallenge(
                        walletPublicKey,
                        data.preimage,
                        data.witness
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark the challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.equal(true)
                  })

                  it("should send the ether deposited by the challenger to the treasury", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      treasury,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeated")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })
                }
              )

              context(
                "when the input is not marked as correctly spent in the Bridge",
                () => {
                  const data = nonWitnessSignSingleInputTx

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      pendingMovedFundsSweepRequestsCount: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    ).to.be.revertedWith(
                      "Spent UTXO not found among correctly spent UTXOs"
                    )
                  })
                }
              )
            })

            context("when the transaction has multiple inputs", () => {
              context(
                "when the input is marked as correctly spent in the Bridge",
                () => {
                  const data = nonWitnessSignMultipleInputsTx
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      pendingMovedFundsSweepRequestsCount: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })
                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)
                    await bridge.setProcessedMovedFundsSweepRequests(
                      data.movedFundsSweepRequests
                    )

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    tx = await bridge
                      .connect(thirdParty)
                      .defeatFraudChallenge(
                        walletPublicKey,
                        data.preimage,
                        data.witness
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark the challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.equal(true)
                  })

                  it("should send the ether deposited by the challenger to the treasury", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      treasury,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeated")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })
                }
              )

              context(
                "when the input is not marked as correctly spent in the Bridge",
                () => {
                  const data = nonWitnessSignMultipleInputsTx

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      pendingMovedFundsSweepRequestsCount: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    ).to.be.revertedWith(
                      "Spent UTXO not found among correctly spent UTXOs"
                    )
                  })
                }
              )
            })
          })

          context("when the input is witness", () => {
            context("when the transaction has single input", () => {
              context(
                "when the input is marked as correctly spent in the Bridge",
                () => {
                  const data = witnessSignSingleInputTx
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      pendingMovedFundsSweepRequestsCount: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })
                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)
                    await bridge.setProcessedMovedFundsSweepRequests(
                      data.movedFundsSweepRequests
                    )

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    tx = await bridge
                      .connect(thirdParty)
                      .defeatFraudChallenge(
                        walletPublicKey,
                        data.preimage,
                        data.witness
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark the challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.equal(true)
                  })

                  it("should send the ether deposited by the challenger to the treasury", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      treasury,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeated")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })
                }
              )

              context(
                "when the input is not marked as correctly spent in the Bridge",
                () => {
                  const data = witnessSignSingleInputTx

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      pendingMovedFundsSweepRequestsCount: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    ).to.be.revertedWith(
                      "Spent UTXO not found among correctly spent UTXOs"
                    )
                  })
                }
              )
            })

            context("when the transaction has multiple inputs", () => {
              context(
                "when the input is marked as correctly spent in the Bridge",
                () => {
                  const data = witnessSignMultipleInputTx
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      pendingMovedFundsSweepRequestsCount: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })
                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)
                    await bridge.setProcessedMovedFundsSweepRequests(
                      data.movedFundsSweepRequests
                    )

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    tx = await bridge
                      .connect(thirdParty)
                      .defeatFraudChallenge(
                        walletPublicKey,
                        data.preimage,
                        data.witness
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark the challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.equal(true)
                  })

                  it("should send the ether deposited by the challenger to the treasury", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      treasury,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeated")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })
                }
              )

              context(
                "when the input is not marked as correctly spent in the Bridge",
                () => {
                  const data = witnessSignMultipleInputTx

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ecdsaWalletID: ethers.constants.HashZero,
                      mainUtxoHash: ethers.constants.HashZero,
                      pendingRedemptionsValue: 0,
                      createdAt: await lastBlockTime(),
                      movingFundsRequestedAt: 0,
                      closingStartedAt: 0,
                      pendingMovedFundsSweepRequestsCount: 0,
                      state: walletState.Live,
                      movingFundsTargetWalletsCommitmentHash:
                        ethers.constants.HashZero,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    ).to.be.revertedWith(
                      "Spent UTXO not found among correctly spent UTXOs"
                    )
                  })
                }
              )
            })
          })
        })

        context("when the sighash type is incorrect", () => {
          // Wrong sighash was used (SIGHASH_NONE | SIGHASH_ANYONECANPAY) during
          // input signing
          const data = wrongSighashType

          before(async () => {
            await createSnapshot()

            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
            await bridge.setSweptDeposits(data.deposits)
            await bridge.setSpentMainUtxos(data.spentMainUtxos)
            await bridge.setProcessedMovedFundsSweepRequests(
              data.movedFundsSweepRequests
            )

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.preimageSha256,
                data.signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .defeatFraudChallenge(
                  walletPublicKey,
                  data.preimage,
                  data.witness
                )
            ).to.be.revertedWith("Wrong sighash type")
          })
        })
      })

      context("when the challenge is resolved by defeat", () => {
        const data = nonWitnessSignSingleInputTx

        before(async () => {
          await createSnapshot()

          await bridge.setWallet(walletPublicKeyHash, {
            ecdsaWalletID: ethers.constants.HashZero,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
          await bridge.setSweptDeposits(data.deposits)
          await bridge.setSpentMainUtxos(data.spentMainUtxos)
          await bridge.setProcessedMovedFundsSweepRequests(
            data.movedFundsSweepRequests
          )

          await bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              data.preimageSha256,
              data.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )

          await bridge
            .connect(thirdParty)
            .defeatFraudChallenge(walletPublicKey, data.preimage, false)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallenge(walletPublicKey, data.preimage, false)
          ).to.be.revertedWith("Fraud challenge has already been resolved")
        })
      })

      context("when the challenge is resolved by timeout", () => {
        const data = nonWitnessSignSingleInputTx

        before(async () => {
          await createSnapshot()

          await bridge.setWallet(walletPublicKeyHash, {
            ecdsaWalletID: ethers.constants.HashZero,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
          await bridge.setSweptDeposits(data.deposits)
          await bridge.setSpentMainUtxos(data.spentMainUtxos)
          await bridge.setProcessedMovedFundsSweepRequests(
            data.movedFundsSweepRequests
          )

          await bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              walletPublicKey,
              data.preimageSha256,
              data.signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )

          await increaseTime(fraudChallengeDefeatTimeout)

          await bridge
            .connect(thirdParty)
            .notifyFraudChallengeDefeatTimeout(
              walletPublicKey,
              [],
              data.preimageSha256
            )
        })

        after(async () => {
          walletRegistry.closeWallet.reset()
          walletRegistry.seize.reset()

          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallenge(walletPublicKey, data.preimage, false)
          ).to.be.revertedWith("Fraud challenge has already been resolved")
        })
      })
    })

    context("when the challenge does not exist", () => {
      const data = nonWitnessSignMultipleInputsTx

      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .defeatFraudChallenge(walletPublicKey, data.preimage, false)
        ).to.be.revertedWith("Fraud challenge does not exist")
      })
    })
  })

  describe("defeatFraudChallengeWithCovenantSpend", () => {
    let covenantAuthorization: Contract
    let covenantWalletPublicKey: string
    let covenantWalletPublicKeyHash: string
    let covenantWalletSigningKey: SigningKey

    const strip = (hex: string): string =>
      hex.startsWith("0x") ? hex.slice(2) : hex

    // Encodes a value as an 8-byte little-endian hex string (no 0x prefix).
    const leUint64 = (value: number): string => {
      const bigEndian = BigNumber.from(value)
        .toHexString()
        .slice(2)
        .padStart(16, "0")
      return bigEndian.match(/../g)!.reverse().join("")
    }

    interface CovenantSpendScenario {
      outpointTxHash: string
      value: number
      outputsHash: string
      sighashType?: string
    }

    // Fabricates a BIP-143 witness preimage for a single covenant input. The
    // outpoint is `outpointTxHash:0`, the input value is `value`, and the
    // trailing hash of all outputs is `outputsHash`. The `hashPrevouts` and
    // `hashSequence` fields are arbitrary as the covenant spend defense reads
    // only the outpoint, the input value, and the hash of all outputs.
    const buildCovenantPreimage = (scenario: CovenantSpendScenario): string => {
      const fields = [
        "01000000", // transaction version
        strip(sha256("0xa1")), // hashPrevouts (arbitrary)
        strip(sha256("0xa2")), // hashSequence (arbitrary)
        strip(scenario.outpointTxHash), // outpoint transaction id (little-endian)
        "00000000", // outpoint index 0 (little-endian)
        "03aabbcc", // scriptCode: varint length 3 followed by 3 bytes
        leUint64(scenario.value), // input value (8 bytes little-endian)
        "ffffffff", // input sequence
        strip(scenario.outputsHash), // hash of all outputs (32 bytes)
        "00000000", // transaction locktime
        scenario.sighashType ?? "01000000", // sighash type (SIGHASH_ALL, little-endian)
      ]
      return `0x${fields.join("")}`
    }

    const submitCovenantChallenge = async (preimage: string) => {
      const sighash = sha256(sha256(preimage))
      const signature = ethers.utils.splitSignature(
        covenantWalletSigningKey.signDigest(sighash)
      )
      await bridge
        .connect(thirdParty)
        .submitFraudChallenge(
          covenantWalletPublicKey,
          sha256(preimage),
          signature,
          {
            value: fraudChallengeDepositAmount,
          }
        )
      return sighash
    }

    const authorize = async (scenario: CovenantSpendScenario) =>
      covenantAuthorization.authorizeCovenantSpend(
        scenario.outpointTxHash,
        0,
        covenantWalletPublicKeyHash,
        scenario.value,
        scenario.outputsHash
      )

    before(async () => {
      await createSnapshot()

      const CovenantSpendAuthorization = await ethers.getContractFactory(
        "CovenantSpendAuthorization"
      )
      covenantAuthorization = await CovenantSpendAuthorization.deploy()
      await bridgeGovernance
        .connect(governance)
        .setCovenantSpendAuthorization(covenantAuthorization.address)

      // As in the `defeatFraudChallengeWithHeartbeat` unit tests, we create a
      // random wallet so any fabricated covenant preimage can be signed with
      // its SigningKey.
      const randomWallet = ethers.Wallet.createRandom()
      covenantWalletSigningKey = new ethers.utils.SigningKey(
        randomWallet.privateKey
      )
      covenantWalletPublicKey = `0x${randomWallet.publicKey.substring(4)}`

      const walletID = keccak256(covenantWalletPublicKey)
      const walletPublicKeyX = `0x${covenantWalletPublicKey.substring(2, 66)}`
      const walletPublicKeyY = `0x${covenantWalletPublicKey.substring(66)}`
      await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          walletID,
          walletPublicKeyX,
          walletPublicKeyY
        )
      covenantWalletPublicKeyHash = await bridge.activeWalletPubKeyHash()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the fraud challenge exists and is open", () => {
      context("when the covenant spend is authorized", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"11".repeat(31)}01`,
          value: 1000000,
          outputsHash: sha256("0xc0ffee01"),
        }

        let tx: ContractTransaction
        let sighash: string

        before(async () => {
          await createSnapshot()

          sighash = await submitCovenantChallenge(
            buildCovenantPreimage(scenario)
          )
          await authorize(scenario)

          tx = await bridge
            .connect(thirdParty)
            .defeatFraudChallengeWithCovenantSpend(
              covenantWalletPublicKey,
              buildCovenantPreimage(scenario)
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should mark the challenge as resolved", async () => {
          const challengeKey = buildChallengeKey(
            covenantWalletPublicKey,
            sighash
          )
          const fraudChallenge = await bridge.fraudChallenges(challengeKey)
          expect(fraudChallenge.resolved).to.equal(true)
        })

        it("should send the ether deposited by the challenger to the treasury", async () => {
          await expect(tx).to.changeEtherBalance(
            bridge,
            fraudChallengeDepositAmount.mul(-1)
          )
          await expect(tx).to.changeEtherBalance(
            treasury,
            fraudChallengeDepositAmount
          )
        })

        it("should emit FraudChallengeDefeated event", async () => {
          await expect(tx)
            .to.emit(bridge, "FraudChallengeDefeated")
            .withArgs(covenantWalletPublicKeyHash, sighash)
        })
      })

      context("when the registry is not configured", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"22".repeat(31)}02`,
          value: 1000000,
          outputsHash: sha256("0xc0ffee02"),
        }

        before(async () => {
          await createSnapshot()

          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          await authorize(scenario)
          await bridgeGovernance
            .connect(governance)
            .setCovenantSpendAuthorization(ethers.constants.AddressZero)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Covenant spend authorization not configured")
        })
      })

      context("when the covenant spend is not authorized", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"33".repeat(31)}03`,
          value: 1000000,
          outputsHash: sha256("0xc0ffee03"),
        }

        before(async () => {
          await createSnapshot()
          await submitCovenantChallenge(buildCovenantPreimage(scenario))
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Covenant spend not authorized")
        })
      })

      context("when the authorized wallet does not match", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"44".repeat(31)}04`,
          value: 1000000,
          outputsHash: sha256("0xc0ffee04"),
        }

        before(async () => {
          await createSnapshot()

          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          // Authorize the same outpoint/value/outputs for a different wallet.
          await covenantAuthorization.authorizeCovenantSpend(
            scenario.outpointTxHash,
            0,
            `0x${"ab".repeat(20)}`,
            scenario.value,
            scenario.outputsHash
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Covenant spend not authorized")
        })
      })

      context("when the authorized value does not match", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"55".repeat(31)}05`,
          value: 1000000,
          outputsHash: sha256("0xc0ffee05"),
        }

        before(async () => {
          await createSnapshot()

          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          await authorize({ ...scenario, value: scenario.value + 1 })
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Covenant spend not authorized")
        })
      })

      context("when the authorized outputs hash does not match", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"66".repeat(31)}06`,
          value: 1000000,
          outputsHash: sha256("0xc0ffee06"),
        }

        before(async () => {
          await createSnapshot()

          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          // Authorize the same outpoint/wallet/value but bind a different
          // migration destination, so a covenant UTXO cannot be diverted to
          // other outputs and still defeat the challenge.
          await authorize({ ...scenario, outputsHash: sha256("0xd1ff") })
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Covenant spend not authorized")
        })
      })

      context("when the authorization is immutable once set", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"77".repeat(31)}07`,
          value: 1000000,
          outputsHash: sha256("0xc0ffee07"),
        }

        before(async () => {
          await createSnapshot()

          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          await authorize(scenario)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should reject an attempt to overwrite the authorization", async () => {
          await expect(
            covenantAuthorization.authorizeCovenantSpend(
              scenario.outpointTxHash,
              0,
              `0x${"ab".repeat(20)}`,
              scenario.value,
              sha256("0xdecafbad")
            )
          ).to.be.revertedWith("Covenant spend already authorized")
        })

        it("should still defeat the challenge after an overwrite attempt", async () => {
          // The registry owner cannot strip a legitimate, still-challengeable
          // covenant signature of its defense, so the defeat still succeeds.
          const tx = await bridge
            .connect(thirdParty)
            .defeatFraudChallengeWithCovenantSpend(
              covenantWalletPublicKey,
              buildCovenantPreimage(scenario)
            )
          await expect(tx).to.emit(bridge, "FraudChallengeDefeated")
        })
      })

      // The covenant path must reject any outpoint the Bridge already tracks —
      // a genuine external covenant active UTXO is never one — so a
      // wallet-controlled backing UTXO cannot be laundered through it even when
      // the registry attests the spend. Each case authorizes the spend first,
      // so the revert proves the known-Bridge-UTXO guard fires ahead of the
      // registry check.
      context("when the outpoint is a revealed deposit", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"d1".repeat(31)}01`,
          value: 1000000,
          outputsHash: sha256("0xda01"),
        }

        before(async () => {
          await createSnapshot()
          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          await authorize(scenario)
          await bridge.setRevealedDeposits([
            {
              txHash: scenario.outpointTxHash,
              txOutputIndex: 0,
              txOutputValue: scenario.value,
            },
          ])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Covenant outpoint is a revealed deposit")
        })
      })

      context("when the outpoint is a spent main UTXO", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"d2".repeat(31)}02`,
          value: 1000000,
          outputsHash: sha256("0xda02"),
        }

        before(async () => {
          await createSnapshot()
          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          await authorize(scenario)
          await bridge.setSpentMainUtxos([
            {
              txHash: scenario.outpointTxHash,
              txOutputIndex: 0,
              txOutputValue: scenario.value,
            },
          ])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Covenant outpoint is a spent main UTXO")
        })
      })

      context("when the outpoint is a moved-funds sweep request", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"d3".repeat(31)}03`,
          value: 1000000,
          outputsHash: sha256("0xda03"),
        }

        before(async () => {
          await createSnapshot()
          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          await authorize(scenario)
          await bridge.setProcessedMovedFundsSweepRequests([
            {
              txHash: scenario.outpointTxHash,
              txOutputIndex: 0,
              txOutputValue: scenario.value,
            },
          ])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith(
            "Covenant outpoint is a moved-funds sweep request"
          )
        })
      })

      context("when the outpoint is the wallet's current main UTXO", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"d4".repeat(31)}04`,
          value: 1000000,
          outputsHash: sha256("0xda04"),
        }

        before(async () => {
          await createSnapshot()
          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          await authorize(scenario)
          // Point the challenged wallet's main UTXO at the challenged outpoint,
          // reproducing a wallet trying to launder its own backing UTXO.
          await bridge.setWalletMainUtxo(covenantWalletPublicKeyHash, {
            txHash: scenario.outpointTxHash,
            txOutputIndex: 0,
            txOutputValue: scenario.value,
          })
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Covenant outpoint is the wallet main UTXO")
        })
      })

      context("when the sighash type is not SIGHASH_ALL", () => {
        const scenario: CovenantSpendScenario = {
          outpointTxHash: `0x${"88".repeat(31)}08`,
          value: 1000000,
          outputsHash: sha256("0xc0ffee08"),
          sighashType: "03000000",
        }

        before(async () => {
          await createSnapshot()

          await submitCovenantChallenge(buildCovenantPreimage(scenario))
          await authorize(scenario)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                buildCovenantPreimage(scenario)
              )
          ).to.be.revertedWith("Wrong sighash type")
        })
      })

      context("when the preimage is too short", () => {
        // A 100-byte blob is shorter than the 157-byte minimum length of a
        // BIP-143 witness preimage.
        const shortPreimage = `0x${"ab".repeat(100)}`

        before(async () => {
          await createSnapshot()

          const sighash = sha256(sha256(shortPreimage))
          const signature = ethers.utils.splitSignature(
            covenantWalletSigningKey.signDigest(sighash)
          )
          await bridge
            .connect(thirdParty)
            .submitFraudChallenge(
              covenantWalletPublicKey,
              sha256(shortPreimage),
              signature,
              {
                value: fraudChallengeDepositAmount,
              }
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            bridge
              .connect(thirdParty)
              .defeatFraudChallengeWithCovenantSpend(
                covenantWalletPublicKey,
                shortPreimage
              )
          ).to.be.revertedWith("Invalid witness preimage length")
        })
      })
    })

    context("when the fraud challenge is already resolved", () => {
      const scenario: CovenantSpendScenario = {
        outpointTxHash: `0x${"99".repeat(31)}09`,
        value: 1000000,
        outputsHash: sha256("0xc0ffee09"),
      }

      before(async () => {
        await createSnapshot()

        await submitCovenantChallenge(buildCovenantPreimage(scenario))
        await authorize(scenario)
        await bridge
          .connect(thirdParty)
          .defeatFraudChallengeWithCovenantSpend(
            covenantWalletPublicKey,
            buildCovenantPreimage(scenario)
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .defeatFraudChallengeWithCovenantSpend(
              covenantWalletPublicKey,
              buildCovenantPreimage(scenario)
            )
        ).to.be.revertedWith("Fraud challenge has already been resolved")
      })
    })

    context("when the fraud challenge does not exist", () => {
      const scenario: CovenantSpendScenario = {
        outpointTxHash: `0x${"aa".repeat(31)}0a`,
        value: 1000000,
        outputsHash: sha256("0xc0ffee0a"),
      }

      before(async () => {
        await createSnapshot()
        await authorize(scenario)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .defeatFraudChallengeWithCovenantSpend(
              covenantWalletPublicKey,
              buildCovenantPreimage(scenario)
            )
        ).to.be.revertedWith("Fraud challenge does not exist")
      })
    })
  })

  describe("notifyFraudChallengeDefeatTimeout", () => {
    const data = nonWitnessSignSingleInputTx

    context("when the fraud challenge exists", () => {
      context("when the fraud challenge is open", () => {
        context("when the fraud challenge has timed out", () => {
          const walletDraft = {
            ecdsaWalletID: ecdsaWalletTestData.walletID,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: 0,
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState.Unknown,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          }
          const walletMembersIDs = [1, 2, 3, 4, 5]

          context(
            "when the wallet is in the Live or MovingFunds or Closing state",
            () => {
              const testData: {
                testName: string
                walletState: number
                additionalSetup?: () => Promise<void>
                additionalAssertions?: () => Promise<void>
              }[] = [
                {
                  testName:
                    "when wallet state is Live but the wallet is not the active one",
                  walletState: walletState.Live,
                  additionalSetup: async () => {
                    // The active wallet is a different wallet than the active one
                    await bridge.setActiveWallet(
                      "0x0b9f85c224b0e018a5865392927b3f9e16cf5e79"
                    )
                  },
                  additionalAssertions: async () => {
                    it("should decrease the live wallets count", async () => {
                      expect(await bridge.liveWalletsCount()).to.be.equal(0)
                    })

                    it("should not unset the active wallet", async () => {
                      expect(
                        await bridge.activeWalletPubKeyHash()
                      ).to.be.not.equal(
                        "0x0000000000000000000000000000000000000000"
                      )
                    })
                  },
                },
                {
                  testName:
                    "when wallet state is Live and the wallet is the active one",
                  walletState: walletState.Live,
                  additionalSetup: async () => {
                    await bridge.setActiveWallet(walletPublicKeyHash)
                  },
                  additionalAssertions: async () => {
                    it("should decrease the live wallets count", async () => {
                      expect(await bridge.liveWalletsCount()).to.be.equal(0)
                    })

                    it("should unset the active wallet", async () => {
                      expect(await bridge.activeWalletPubKeyHash()).to.be.equal(
                        "0x0000000000000000000000000000000000000000"
                      )
                    })
                  },
                },
                {
                  testName: "when wallet state is MovingFunds",
                  walletState: walletState.MovingFunds,
                  additionalSetup: async () => {},
                  additionalAssertions: async () => {},
                },
                {
                  testName: "when wallet state is Closing",
                  walletState: walletState.Closing,
                  additionalSetup: async () => {},
                  additionalAssertions: async () => {},
                },
              ]

              testData.forEach((test) => {
                context(test.testName, async () => {
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridge.setWallet(walletPublicKeyHash, {
                      ...walletDraft,
                      state: test.walletState,
                    })

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    await increaseTime(fraudChallengeDefeatTimeout)

                    await test.additionalSetup()

                    tx = await bridge
                      .connect(thirdParty)
                      .notifyFraudChallengeDefeatTimeout(
                        walletPublicKey,
                        walletMembersIDs,
                        data.preimageSha256
                      )
                  })

                  after(async () => {
                    walletRegistry.closeWallet.reset()
                    walletRegistry.seize.reset()

                    await restoreSnapshot()
                  })

                  it("should mark the fraud challenge as resolved", async () => {
                    const challengeKey = buildChallengeKey(
                      walletPublicKey,
                      data.sighash
                    )

                    const fraudChallenge = await bridge.fraudChallenges(
                      challengeKey
                    )

                    expect(fraudChallenge.resolved).to.be.true
                  })

                  it("should return the deposited ether to the challenger", async () => {
                    await expect(tx).to.changeEtherBalance(
                      bridge,
                      fraudChallengeDepositAmount.mul(-1)
                    )
                    await expect(tx).to.changeEtherBalance(
                      thirdParty,
                      fraudChallengeDepositAmount
                    )
                  })

                  it("should emit FraudChallengeDefeatTimedOut event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "FraudChallengeDefeatTimedOut")
                      .withArgs(walletPublicKeyHash, data.sighash)
                  })

                  it("should change the wallet state to Terminated", async () => {
                    expect(
                      (await bridge.wallets(walletPublicKeyHash)).state
                    ).to.be.equal(walletState.Terminated)
                  })

                  it("should emit WalletTerminated event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "WalletTerminated")
                      .withArgs(walletDraft.ecdsaWalletID, walletPublicKeyHash)
                  })

                  it("should call the ECDSA wallet registry's closeWallet function", async () => {
                    expect(
                      walletRegistry.closeWallet
                    ).to.have.been.calledOnceWith(walletDraft.ecdsaWalletID)
                  })

                  it("should call the ECDSA wallet registry's seize function", async () => {
                    expect(walletRegistry.seize).to.have.been.calledOnceWith(
                      fraudSlashingAmount,
                      fraudNotifierRewardMultiplier,
                      await thirdParty.getAddress(),
                      ecdsaWalletTestData.walletID,
                      walletMembersIDs
                    )
                  })

                  // TODO: Check if the gas consumption of functions calling `seize`
                  //       is not too high (use a real `staking` and `walletRegistry`).
                  //       Perhaps add a separate deployment with the non-mocked contracts
                  //       or test it in a system test?
                  await test.additionalAssertions()
                })
              })
            }
          )

          context("when the wallet is in the Terminated state", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // First, the wallet must be Live to make fraud challenge
              // submission possible.
              await bridge.setWallet(walletPublicKeyHash, {
                ...walletDraft,
                state: walletState.Live,
              })

              await bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  data.preimageSha256,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )

              await increaseTime(fraudChallengeDefeatTimeout)

              // Then, the state of the wallet changes to the Terminated
              // state.
              await bridge.setWallet(walletPublicKeyHash, {
                ...walletDraft,
                state: walletState.Terminated,
              })

              tx = await bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  walletMembersIDs,
                  data.preimageSha256
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should mark the fraud challenge as resolved", async () => {
              const challengeKey = buildChallengeKey(
                walletPublicKey,
                data.sighash
              )

              const fraudChallenge = await bridge.fraudChallenges(challengeKey)

              expect(fraudChallenge.resolved).to.be.true
            })

            it("should return the deposited ether to the challenger", async () => {
              await expect(tx).to.changeEtherBalance(
                bridge,
                fraudChallengeDepositAmount.mul(-1)
              )
              await expect(tx).to.changeEtherBalance(
                thirdParty,
                fraudChallengeDepositAmount
              )
            })

            it("should emit FraudChallengeDefeatTimedOut event", async () => {
              await expect(tx)
                .to.emit(bridge, "FraudChallengeDefeatTimedOut")
                .withArgs(walletPublicKeyHash, data.sighash)
            })

            it("should not change the wallet state", async () => {
              expect(
                (await bridge.wallets(walletPublicKeyHash)).state
              ).to.be.equal(walletState.Terminated)
            })

            it("should not call the ECDSA wallet registry's seize function", async () => {
              expect(walletRegistry.seize).not.to.have.been.called
            })
          })

          context("when the wallet is in the Closed state", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // First, the wallet must be Live to make fraud challenge
              // submission possible.
              await bridge.setWallet(walletPublicKeyHash, {
                ...walletDraft,
                state: walletState.Live,
              })

              await bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  data.preimageSha256,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )

              await increaseTime(fraudChallengeDefeatTimeout)

              // Then, the state of the wallet changes to the Closed state. This
              // stands in for a fraud challenge opened before the per-wallet
              // counter existed: such a challenge cannot keep the wallet in
              // Closing, so the wallet can reach Closed while the challenge is
              // still open. The timeout path must remain reachable so the
              // challenger can recover their deposit.
              await bridge.setWallet(walletPublicKeyHash, {
                ...walletDraft,
                state: walletState.Closed,
              })

              tx = await bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  walletMembersIDs,
                  data.preimageSha256
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should mark the fraud challenge as resolved", async () => {
              const challengeKey = buildChallengeKey(
                walletPublicKey,
                data.sighash
              )

              const fraudChallenge = await bridge.fraudChallenges(challengeKey)

              expect(fraudChallenge.resolved).to.be.true
            })

            it("should return the deposited ether to the challenger", async () => {
              await expect(tx).to.changeEtherBalance(
                bridge,
                fraudChallengeDepositAmount.mul(-1)
              )
              await expect(tx).to.changeEtherBalance(
                thirdParty,
                fraudChallengeDepositAmount
              )
            })

            it("should emit FraudChallengeDefeatTimedOut event", async () => {
              await expect(tx)
                .to.emit(bridge, "FraudChallengeDefeatTimedOut")
                .withArgs(walletPublicKeyHash, data.sighash)
            })

            it("should not change the wallet state", async () => {
              expect(
                (await bridge.wallets(walletPublicKeyHash)).state
              ).to.be.equal(walletState.Closed)
            })

            it("should not call the ECDSA wallet registry's seize function", async () => {
              expect(walletRegistry.seize).not.to.have.been.called
            })
          })

          context(
            "when the wallet is neither in the Live nor MovingFunds nor Closing nor Closed nor Terminated state",
            () => {
              const testData = [
                {
                  testName: "when the wallet is in the Unknown state",
                  walletState: walletState.Unknown,
                },
              ]

              testData.forEach((test) => {
                context(test.testName, () => {
                  before(async () => {
                    await createSnapshot()

                    // First, the wallet must be Live to make fraud challenge
                    // submission possible.
                    await bridge.setWallet(walletPublicKeyHash, {
                      ...walletDraft,
                      state: walletState.Live,
                    })

                    await bridge.setSweptDeposits(data.deposits)
                    await bridge.setSpentMainUtxos(data.spentMainUtxos)
                    await bridge.setProcessedMovedFundsSweepRequests(
                      data.movedFundsSweepRequests
                    )

                    await bridge
                      .connect(thirdParty)
                      .submitFraudChallenge(
                        walletPublicKey,
                        data.preimageSha256,
                        data.signature,
                        {
                          value: fraudChallengeDepositAmount,
                        }
                      )

                    await increaseTime(fraudChallengeDefeatTimeout)

                    // Then, the state of the wallet changes to the tested
                    // state.
                    await bridge.setWallet(walletPublicKeyHash, {
                      ...walletDraft,
                      state: test.walletState,
                    })
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(thirdParty)
                        .notifyFraudChallengeDefeatTimeout(
                          walletPublicKey,
                          [],
                          data.preimageSha256
                        )
                    ).to.be.revertedWith(
                      "Wallet must be in Live or MovingFunds or Closing or Closed or Terminated state"
                    )
                  })
                })
              })
            }
          )
        })

        context("when the fraud challenge has not timed out yet", () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
            await bridge.setSweptDeposits(data.deposits)
            await bridge.setSpentMainUtxos(data.spentMainUtxos)
            await bridge.setProcessedMovedFundsSweepRequests(
              data.movedFundsSweepRequests
            )

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.preimageSha256,
                data.signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )

            await increaseTime(fraudChallengeDefeatTimeout - 2)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  [],
                  data.preimageSha256
                )
            ).to.be.revertedWith(
              "Fraud challenge defeat period did not time out yet"
            )
          })
        })
      })

      context(
        "when the fraud challenge is resolved by challenge defeat",
        () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
            await bridge.setSweptDeposits(data.deposits)
            await bridge.setSpentMainUtxos(data.spentMainUtxos)
            await bridge.setProcessedMovedFundsSweepRequests(
              data.movedFundsSweepRequests
            )

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.preimageSha256,
                data.signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )

            await bridge
              .connect(thirdParty)
              .defeatFraudChallenge(walletPublicKey, data.preimage, false)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  [],
                  data.preimageSha256
                )
            ).to.be.revertedWith("Fraud challenge has already been resolved")
          })
        }
      )

      context(
        "when the fraud challenge is resolved by previous timeout notification",
        () => {
          before(async () => {
            await createSnapshot()

            await bridge.setWallet(walletPublicKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
            await bridge.setSweptDeposits(data.deposits)
            await bridge.setSpentMainUtxos(data.spentMainUtxos)
            await bridge.setProcessedMovedFundsSweepRequests(
              data.movedFundsSweepRequests
            )

            await bridge
              .connect(thirdParty)
              .submitFraudChallenge(
                walletPublicKey,
                data.preimageSha256,
                data.signature,
                {
                  value: fraudChallengeDepositAmount,
                }
              )

            await increaseTime(fraudChallengeDefeatTimeout)

            await bridge
              .connect(thirdParty)
              .notifyFraudChallengeDefeatTimeout(
                walletPublicKey,
                [],
                data.preimageSha256
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(thirdParty)
                .notifyFraudChallengeDefeatTimeout(
                  walletPublicKey,
                  [],
                  data.preimageSha256
                )
            ).to.be.revertedWith("Fraud challenge has already been resolved")
          })
        }
      )
    })

    context("when the fraud challenge does not exist", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridge
            .connect(thirdParty)
            .notifyFraudChallengeDefeatTimeout(
              walletPublicKey,
              [],
              data.preimageSha256
            )
        ).to.be.revertedWith("Fraud challenge does not exist")
      })
    })
  })

  describe("finalizeWalletClosing with a pending fraud challenge", () => {
    // Heartbeat message and derived sighash used for a self-contained fraud
    // challenge that can be defeated without any BTC-specific UTXO setup.
    const heartbeatMessage = "0xFFFFFFFFFFFFFFFF0000000000E0EED7"
    const heartbeatMessageSha256 = sha256(heartbeatMessage)
    const heartbeatSighash = sha256(heartbeatMessageSha256)

    let closingWalletPublicKey: string
    let closingWalletPublicKeyHash: string
    let closingWalletID: string
    let closingSigningKey: SigningKey
    let walletClosingPeriod: number

    before(async () => {
      await createSnapshot()

      // Register a wallet whose signing key we control, so we can both submit
      // and later defeat a heartbeat fraud challenge against it.
      const randomWallet = ethers.Wallet.createRandom()
      closingSigningKey = new ethers.utils.SigningKey(randomWallet.privateKey)
      closingWalletPublicKey = `0x${randomWallet.publicKey.substring(4)}`
      closingWalletID = keccak256(closingWalletPublicKey)

      const walletPublicKeyX = `0x${closingWalletPublicKey.substring(2, 66)}`
      const walletPublicKeyY = `0x${closingWalletPublicKey.substring(66)}`
      await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          closingWalletID,
          walletPublicKeyX,
          walletPublicKeyY
        )
      closingWalletPublicKeyHash = await bridge.activeWalletPubKeyHash()
      ;({ walletClosingPeriod } = await bridge.walletParameters())
    })

    after(async () => {
      await restoreSnapshot()
    })

    beforeEach(async () => {
      await createSnapshot()

      // Move the wallet into the Closing state with the period just started.
      await bridge.setWallet(closingWalletPublicKeyHash, {
        ecdsaWalletID: closingWalletID,
        mainUtxoHash: ethers.constants.HashZero,
        pendingRedemptionsValue: 0,
        createdAt: await lastBlockTime(),
        movingFundsRequestedAt: 0,
        closingStartedAt: await lastBlockTime(),
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.Closing,
        movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
      })

      // Submit a fraud challenge while the wallet is Closing.
      const signature = ethers.utils.splitSignature(
        closingSigningKey.signDigest(heartbeatSighash)
      )
      await bridge
        .connect(thirdParty)
        .submitFraudChallenge(
          closingWalletPublicKey,
          heartbeatMessageSha256,
          signature,
          { value: fraudChallengeDepositAmount }
        )

      // Advance past the closing period so only the fraud guard blocks closing.
      await increaseTime(walletClosingPeriod + 1)
    })

    afterEach(async () => {
      // `closeWallet` is a smock fake whose call history lives in JS memory and
      // survives `restoreSnapshot`. Reset it so a `closeWallet` call recorded
      // here (via `notifyWalletClosingPeriodElapsed`) cannot leak into other
      // suites that share the same fixture and assert `calledOnceWith`.
      walletRegistry.closeWallet.reset()

      await restoreSnapshot()
    })

    it("reverts finalizing the closing while the fraud challenge is unresolved", async () => {
      await expect(
        bridge.notifyWalletClosingPeriodElapsed(closingWalletPublicKeyHash)
      ).to.be.revertedWith("Wallet has unresolved fraud challenges")
    })

    it("allows finalizing the closing once the fraud challenge is defeated", async () => {
      await bridge
        .connect(thirdParty)
        .defeatFraudChallengeWithHeartbeat(
          closingWalletPublicKey,
          heartbeatMessage
        )

      await expect(
        bridge.notifyWalletClosingPeriodElapsed(closingWalletPublicKeyHash)
      ).to.not.be.reverted

      expect((await bridge.wallets(closingWalletPublicKeyHash)).state).to.equal(
        walletState.Closed
      )
    })

    it("still resolves an uncounted challenge after the wallet closes", async () => {
      // Simulate a fraud challenge opened before the per-wallet counter
      // existed. Such a challenge is open but leaves the counter at zero, so it
      // cannot keep the wallet in the Closing state.
      await bridge.setWalletPendingFraudChallenges(
        closingWalletPublicKeyHash,
        0
      )

      // With the counter at zero, closing finalizes and the wallet becomes
      // Closed even though the challenge is still unresolved.
      await expect(
        bridge.notifyWalletClosingPeriodElapsed(closingWalletPublicKeyHash)
      ).to.not.be.reverted
      expect((await bridge.wallets(closingWalletPublicKeyHash)).state).to.equal(
        walletState.Closed
      )

      // The closing period (40 days) already elapsed past the fraud challenge
      // defeat timeout (1 week) in the shared beforeEach, so the challenge can
      // be timed out. The timeout must still resolve and refund the challenger
      // even though the wallet is now Closed, instead of reverting and
      // stranding the deposit.
      const tx = await bridge
        .connect(thirdParty)
        .notifyFraudChallengeDefeatTimeout(
          closingWalletPublicKey,
          [],
          heartbeatMessageSha256
        )

      await expect(tx).to.changeEtherBalance(
        bridge,
        fraudChallengeDepositAmount.mul(-1)
      )
      await expect(tx).to.changeEtherBalance(
        thirdParty,
        fraudChallengeDepositAmount
      )

      const challengeKey = buildChallengeKey(
        closingWalletPublicKey,
        heartbeatSighash
      )
      expect((await bridge.fraudChallenges(challengeKey)).resolved).to.be.true

      expect((await bridge.wallets(closingWalletPublicKeyHash)).state).to.equal(
        walletState.Closed
      )
    })

    it("does not let an uncounted challenge steal a counted challenge's slot", async () => {
      // The wallet counter is 1 from the fixture challenge. Treat that count as
      // belonging to a coexisting counted (post-upgrade) challenge, and mark the
      // fixture challenge itself as uncounted (pre-upgrade). Resolving the
      // uncounted challenge must not decrement the counted challenge's slot,
      // otherwise closing could finalize while the counted challenge can still
      // mature — the exact slashing-evasion this guard prevents.
      const challengeKey = buildChallengeKey(
        closingWalletPublicKey,
        heartbeatSighash
      )
      await bridge.setFraudChallengePendingCounted(challengeKey, false)

      // Defeat the uncounted challenge.
      await bridge
        .connect(thirdParty)
        .defeatFraudChallengeWithHeartbeat(
          closingWalletPublicKey,
          heartbeatMessage
        )

      // The counted challenge's slot survives: closing stays blocked.
      await expect(
        bridge.notifyWalletClosingPeriodElapsed(closingWalletPublicKeyHash)
      ).to.be.revertedWith("Wallet has unresolved fraud challenges")
    })
  })

  function buildChallengeKey(publicKey: BytesLike, sighash: BytesLike): string {
    return ethers.utils.solidityKeccak256(
      ["bytes", "bytes32"],
      [publicKey, sighash]
    )
  }
})
