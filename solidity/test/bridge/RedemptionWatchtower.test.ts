import { helpers, waffle, ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { BigNumber, BigNumberish, BytesLike, ContractTransaction } from "ethers"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeGovernance,
  BridgeStub,
  RedemptionWatchtower,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import {
  RedemptionTestData,
  SinglePendingRequestedRedemption,
} from "../data/redemption"

const { impersonateAccount } = helpers.account
const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

/** Deep `eql` on full tuples fails when RPC returns a different `BigNumber` implementation. */
function assertVetoProposalTuple(
  actual: Awaited<ReturnType<RedemptionWatchtower["vetoProposals"]>>,
  expected: {
    redeemer: string
    withdrawableAmount: BigNumberish
    finalizedAt: BigNumberish
    objectionsCount: number
  }
) {
  expect(ethers.utils.getAddress(actual.redeemer)).to.equal(
    ethers.utils.getAddress(expected.redeemer)
  )
  expect(
    BigNumber.from(actual.withdrawableAmount).eq(expected.withdrawableAmount)
  ).to.be.true
  expect(BigNumber.from(actual.finalizedAt).eq(expected.finalizedAt)).to.be.true
  expect(Number(actual.objectionsCount)).to.equal(expected.objectionsCount)
}

describe("RedemptionWatchtower", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let redemptionWatchtowerManager: SignerWithAddress
  let guardians: SignerWithAddress[]

  let bridgeGovernance: BridgeGovernance
  let bridge: Bridge & BridgeStub
  let bank: Bank & BankStub

  let redemptionWatchtower: RedemptionWatchtower

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      thirdParty,
      redemptionWatchtowerManager,
      guardians,
      bridgeGovernance,
      bridge,
      bank,
      redemptionWatchtower,
    } = await waffle.loadFixture(bridgeFixture))

    await bridgeGovernance
      .connect(governance)
      .setRedemptionWatchtower(redemptionWatchtower.address)

    // Make sure test actors are correctly set up.
    const actors = [
      governance,
      thirdParty,
      redemptionWatchtowerManager,
      ...guardians,
    ].map((actor) => actor.address)

    if (actors.length !== new Set(actors).size) {
      throw new Error("Duplicate actors; please double check the fixture")
    }
  })

  describe("enableWatchtower", () => {
    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          redemptionWatchtower.connect(thirdParty).enableWatchtower(
            redemptionWatchtowerManager.address,
            guardians.map((g) => g.address)
          )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when already enabled", () => {
        before(async () => {
          await createSnapshot()

          await redemptionWatchtower.connect(governance).enableWatchtower(
            redemptionWatchtowerManager.address,
            guardians.map((g) => g.address)
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            redemptionWatchtower.connect(governance).enableWatchtower(
              redemptionWatchtowerManager.address,
              guardians.map((g) => g.address)
            )
          ).to.be.revertedWith("Already enabled")
        })
      })

      context("when not enabled yet", () => {
        context("when manager address is zero", () => {
          it("should revert", async () => {
            await expect(
              redemptionWatchtower.connect(governance).enableWatchtower(
                ethers.constants.AddressZero,
                guardians.map((g) => g.address)
              )
            ).to.be.revertedWith("Manager address must not be 0x0")
          })
        })

        context("when manager address is non-zero", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            tx = await redemptionWatchtower
              .connect(governance)
              .enableWatchtower(
                redemptionWatchtowerManager.address,
                guardians.map((g) => g.address)
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should set the enabledAt timeout properly", async () => {
            expect(await redemptionWatchtower.watchtowerEnabledAt()).to.equal(
              await lastBlockTime()
            )
          })

          it("should set the watchtower manager properly", async () => {
            expect(await redemptionWatchtower.manager()).to.equal(
              redemptionWatchtowerManager.address
            )
          })

          it("should set initial guardians properly", async () => {
            // eslint-disable-next-line no-restricted-syntax
            for (const guardian of guardians) {
              // eslint-disable-next-line no-await-in-loop,@typescript-eslint/no-unused-expressions
              expect(await redemptionWatchtower.isGuardian(guardian.address)).to
                .be.true
            }
          })

          it("should emit WatchtowerEnabled event", async () => {
            await expect(tx)
              .to.emit(redemptionWatchtower, "WatchtowerEnabled")
              .withArgs(
                await lastBlockTime(),
                redemptionWatchtowerManager.address
              )
          })

          it("should emit GuardianAdded events", async () => {
            await expect(tx)
              .to.emit(redemptionWatchtower, "GuardianAdded")
              .withArgs(guardians[0].address)

            await expect(tx)
              .to.emit(redemptionWatchtower, "GuardianAdded")
              .withArgs(guardians[1].address)

            await expect(tx)
              .to.emit(redemptionWatchtower, "GuardianAdded")
              .withArgs(guardians[2].address)
          })
        })
      })
    })
  })

  describe("disableWatchtower", () => {
    context("when the watchtower is not enabled", () => {
      it("should revert", async () => {
        await expect(
          redemptionWatchtower.connect(thirdParty).disableWatchtower()
        ).to.be.revertedWith("Not enabled")
      })
    })

    context("when the watchtower is enabled", () => {
      before(async () => {
        await createSnapshot()

        await redemptionWatchtower.connect(governance).enableWatchtower(
          redemptionWatchtowerManager.address,
          guardians.map((g) => g.address)
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the watchtower is disabled already", () => {
        before(async () => {
          await createSnapshot()

          const lifetimeExpiresAt =
            (await redemptionWatchtower.watchtowerEnabledAt()) +
            (await redemptionWatchtower.watchtowerLifetime())

          // Increase time to the moment the watchtower lifetime expires.
          // The `disableWatchtower` transaction should be mined exactly one
          // second after the lifetime expires.
          await increaseTime(lifetimeExpiresAt - (await lastBlockTime()))

          // Disable the watchtower for the first time.
          await redemptionWatchtower.connect(thirdParty).disableWatchtower()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            redemptionWatchtower.connect(thirdParty).disableWatchtower()
          ).to.be.revertedWith("Already disabled")
        })
      })

      context("when the watchtower is not disabled yet", () => {
        context("when the watchtower lifetime is not expired", () => {
          before(async () => {
            await createSnapshot()

            const lifetimeExpiresAt =
              (await redemptionWatchtower.watchtowerEnabledAt()) +
              (await redemptionWatchtower.watchtowerLifetime())

            // Increase time to one second before the watchtower lifetime expires.
            // The `disableWatchtower` will be mined exactly at the moment
            // of the lifetime expiration which is one second too early
            // to disable the watchtower.
            await increaseTime(lifetimeExpiresAt - (await lastBlockTime()) - 1)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              redemptionWatchtower.connect(thirdParty).disableWatchtower()
            ).to.be.revertedWith("Watchtower lifetime not expired")
          })
        })

        context("when the watchtower lifetime is expired", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            const lifetimeExpiresAt =
              (await redemptionWatchtower.watchtowerEnabledAt()) +
              (await redemptionWatchtower.watchtowerLifetime())

            // Increase time to the moment the watchtower lifetime expires.
            // The `disableWatchtower` transaction should be mined exactly one
            // second after the lifetime expires.
            await increaseTime(lifetimeExpiresAt - (await lastBlockTime()))

            tx = await redemptionWatchtower
              .connect(thirdParty)
              .disableWatchtower()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should set the disabledAt timeout properly", async () => {
            expect(await redemptionWatchtower.watchtowerDisabledAt()).to.equal(
              await lastBlockTime()
            )
          })

          it("should emit WatchtowerDisabled event", async () => {
            await expect(tx)
              .to.emit(redemptionWatchtower, "WatchtowerDisabled")
              .withArgs(await lastBlockTime(), thirdParty.address)
          })
        })
      })
    })
  })

  describe("addGuardian", () => {
    context("when watchtower manager is not set", () => {
      // At this point, the watchtower manager is not set as `enableWatchtower`
      // has not been called yet.
      it("should revert", async () => {
        await expect(
          redemptionWatchtower
            .connect(thirdParty)
            .addGuardian(thirdParty.address)
        ).to.be.revertedWith("Caller is not watchtower manager")
      })
    })

    context("when watchtower manager is set", () => {
      before(async () => {
        await createSnapshot()

        await redemptionWatchtower.connect(governance).enableWatchtower(
          redemptionWatchtowerManager.address,
          guardians.map((g) => g.address)
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when called not by the watchtower manager", () => {
        it("should revert", async () => {
          await expect(
            redemptionWatchtower
              .connect(governance) // governance has not such a power
              .addGuardian(thirdParty.address)
          ).to.be.revertedWith("Caller is not watchtower manager")
        })
      })

      context("when called by the watchtower manager", () => {
        context("when guardian already exists", () => {
          it("should revert", async () => {
            await expect(
              redemptionWatchtower
                .connect(redemptionWatchtowerManager)
                .addGuardian(guardians[0].address)
            ).to.be.revertedWith("Guardian already exists")
          })
        })

        context("when guardian does not exist", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            tx = await redemptionWatchtower
              .connect(redemptionWatchtowerManager)
              .addGuardian(thirdParty.address)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should add the guardian properly", async () => {
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            expect(await redemptionWatchtower.isGuardian(thirdParty.address)).to
              .be.true
          })

          it("should emit GuardianAdded event", async () => {
            await expect(tx)
              .to.emit(redemptionWatchtower, "GuardianAdded")
              .withArgs(thirdParty.address)
          })
        })
      })
    })
  })

  describe("removeGuardian", () => {
    before(async () => {
      await createSnapshot()

      await redemptionWatchtower.connect(governance).enableWatchtower(
        redemptionWatchtowerManager.address,
        guardians.map((g) => g.address)
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          redemptionWatchtower
            .connect(redemptionWatchtowerManager) // manager has not such a power
            .removeGuardian(guardians[0].address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      context("when guardian does not exist", () => {
        it("should revert", async () => {
          await expect(
            redemptionWatchtower
              .connect(governance)
              .removeGuardian(thirdParty.address)
          ).to.be.revertedWith("Guardian does not exist")
        })
      })

      context("when guardian exists", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await redemptionWatchtower
            .connect(governance)
            .removeGuardian(guardians[0].address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should remove the guardian properly", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await redemptionWatchtower.isGuardian(guardians[0].address)).to
            .be.false
        })

        it("should emit GuardianRemoved event", async () => {
          await expect(tx)
            .to.emit(redemptionWatchtower, "GuardianRemoved")
            .withArgs(guardians[0].address)
        })
      })
    })
  })

  describe("raiseObjection", () => {
    let legacyRedemption: RedemptionData

    // Create a redemption request before enabling the watchtower.
    // Such a request is needed for the scenario that checks if pre-watchtower
    // requests can be vetoed indefinitely. As SinglePendingRequestedRedemption
    // is used for post-watchtower requests as well, we need to modify the
    // redeemerOutputScript to avoid a collision and obtain different redemption
    // keys.
    const createLegacyRedemption = async () => {
      const data: RedemptionTestData = JSON.parse(
        JSON.stringify(SinglePendingRequestedRedemption)
      )
      data.redemptionRequests[0].redeemerOutputScript =
        "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac"
      const redemptions = await createRedemptionRequests(data)
      // eslint-disable-next-line prefer-destructuring
      return redemptions[0]
    }

    before(async () => {
      await createSnapshot()

      legacyRedemption = await createLegacyRedemption()

      await redemptionWatchtower.connect(governance).enableWatchtower(
        redemptionWatchtowerManager.address,
        guardians.map((g) => g.address)
      )

      // Update the default penalty fee from 100% to 5% to test the penalty fee
      // calculation.
      await redemptionWatchtower
        .connect(redemptionWatchtowerManager)
        .updateWatchtowerParameters(
          await redemptionWatchtower.watchtowerLifetime(),
          20,
          await redemptionWatchtower.vetoFreezePeriod(),
          await redemptionWatchtower.defaultDelay(),
          await redemptionWatchtower.levelOneDelay(),
          await redemptionWatchtower.levelTwoDelay(),
          await redemptionWatchtower.waivedAmountLimit()
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by a guardian", () => {
      it("should revert", async () => {
        // No need to create the redemption request. The caller check is
        // performed before the redemption request existence check.
        const { pubKeyHash } = SinglePendingRequestedRedemption.wallet
        const { redeemerOutputScript } =
          SinglePendingRequestedRedemption.redemptionRequests[0]

        await expect(
          redemptionWatchtower
            .connect(thirdParty)
            .raiseObjection(pubKeyHash, redeemerOutputScript)
        ).to.be.revertedWith("Caller is not guardian")
      })
    })

    context("when called by a guardian", () => {
      context("when redemption request is already vetoed", () => {
        let redemption: RedemptionData

        before(async () => {
          await createSnapshot()

          const redemptions = await createRedemptionRequests(
            SinglePendingRequestedRedemption
          )
          // eslint-disable-next-line prefer-destructuring
          redemption = redemptions[0]

          // Raise the first objection.
          await redemptionWatchtower
            .connect(guardians[0])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )

          // Raise the second objection.
          await redemptionWatchtower
            .connect(guardians[1])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )

          // Raise the third objection.
          await redemptionWatchtower
            .connect(guardians[2])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )

          // Add the 4th guardian that will attempt to raise a redundant
          // objection.
          await redemptionWatchtower
            .connect(redemptionWatchtowerManager)
            .addGuardian(thirdParty.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            redemptionWatchtower
              .connect(thirdParty)
              .raiseObjection(
                redemption.walletPublicKeyHash,
                redemption.redeemerOutputScript
              )
          ).to.be.revertedWith("Redemption request already vetoed")
        })
      })

      context("when redemption request is not vetoed yet", () => {
        context("when guardian already objected", () => {
          let redemption: RedemptionData

          before(async () => {
            await createSnapshot()

            const redemptions = await createRedemptionRequests(
              SinglePendingRequestedRedemption
            )
            // eslint-disable-next-line prefer-destructuring
            redemption = redemptions[0]

            // Raise the objection.
            await redemptionWatchtower
              .connect(guardians[0])
              .raiseObjection(
                redemption.walletPublicKeyHash,
                redemption.redeemerOutputScript
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              redemptionWatchtower
                .connect(guardians[0])
                .raiseObjection(
                  redemption.walletPublicKeyHash,
                  redemption.redeemerOutputScript
                )
            ).to.be.revertedWith("Guardian already objected")
          })
        })

        context("when guardian did not object yet", () => {
          context("when redemption request does not exist", () => {
            it("should revert", async () => {
              const { pubKeyHash } = SinglePendingRequestedRedemption.wallet
              const { redeemerOutputScript } =
                SinglePendingRequestedRedemption.redemptionRequests[0]

              await expect(
                redemptionWatchtower
                  .connect(guardians[0])
                  .raiseObjection(pubKeyHash, redeemerOutputScript)
              ).to.be.revertedWith("Redemption request does not exist")
            })
          })

          context("when redemption request exists", () => {
            context(
              "when the requested amount is below the waived amount limit",
              () => {
                let redemption: RedemptionData

                before(async () => {
                  await createSnapshot()

                  const redemptions = await createRedemptionRequests(
                    SinglePendingRequestedRedemption
                  )
                  // eslint-disable-next-line prefer-destructuring
                  redemption = redemptions[0]

                  // Set the waived amount limit just above the redemption amount.
                  // This way the requested amount is 1 sat lesser than it.
                  await redemptionWatchtower
                    .connect(redemptionWatchtowerManager)
                    .updateWatchtowerParameters(
                      await redemptionWatchtower.watchtowerLifetime(),
                      20,
                      await redemptionWatchtower.vetoFreezePeriod(),
                      await redemptionWatchtower.defaultDelay(),
                      await redemptionWatchtower.levelOneDelay(),
                      await redemptionWatchtower.levelTwoDelay(),
                      redemption.amount.add(1)
                    )
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    redemptionWatchtower
                      .connect(guardians[0])
                      .raiseObjection(
                        redemption.walletPublicKeyHash,
                        redemption.redeemerOutputScript
                      )
                  ).to.be.revertedWith("Redemption veto delay period expired")
                })
              }
            )

            context("when watchtower has been disabled", () => {
              let redemption: RedemptionData

              before(async () => {
                await createSnapshot()

                const redemptions = await createRedemptionRequests(
                  SinglePendingRequestedRedemption
                )
                // eslint-disable-next-line prefer-destructuring
                redemption = redemptions[0]

                const lifetimeExpiresAt =
                  (await redemptionWatchtower.watchtowerEnabledAt()) +
                  (await redemptionWatchtower.watchtowerLifetime())

                // Increase time to the moment the watchtower lifetime expires.
                // The `disableWatchtower` transaction should be mined exactly one
                // second after the lifetime expires.
                await increaseTime(lifetimeExpiresAt - (await lastBlockTime()))

                // Disable the watchtower.
                await redemptionWatchtower
                  .connect(thirdParty)
                  .disableWatchtower()
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  redemptionWatchtower
                    .connect(guardians[0])
                    .raiseObjection(
                      redemption.walletPublicKeyHash,
                      redemption.redeemerOutputScript
                    )
                ).to.be.revertedWith("Redemption veto delay period expired")
              })
            })

            context(
              "when delay period expired and request was created after mechanism initialization",
              () => {
                let redemption: RedemptionData
                let defaultDelay: number
                let levelOneDelay: number
                let levelTwoDelay: number

                before(async () => {
                  await createSnapshot()

                  defaultDelay = await redemptionWatchtower.defaultDelay()
                  levelOneDelay = await redemptionWatchtower.levelOneDelay()
                  levelTwoDelay = await redemptionWatchtower.levelTwoDelay()

                  const redemptions = await createRedemptionRequests(
                    SinglePendingRequestedRedemption
                  )
                  // eslint-disable-next-line prefer-destructuring
                  redemption = redemptions[0]
                })

                after(async () => {
                  await restoreSnapshot()
                })

                context("when the raised objection is the first one", () => {
                  before(async () => {
                    await createSnapshot()

                    // Set time to the first possible moment the first objection
                    // can no longer be raised. We need to subtract 1 seconds
                    // to make sure the `raiseObjection` transaction
                    // is mined exactly at the timestamp the delay expires.
                    const delayExpiresAt = redemption.requestedAt + defaultDelay
                    await increaseTime(
                      delayExpiresAt - (await lastBlockTime()) - 1
                    )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      redemptionWatchtower
                        .connect(guardians[0])
                        .raiseObjection(
                          redemption.walletPublicKeyHash,
                          redemption.redeemerOutputScript
                        )
                    ).to.be.revertedWith("Redemption veto delay period expired")
                  })
                })

                context("when the raised objection is the second one", () => {
                  before(async () => {
                    await createSnapshot()

                    // Raise the first objection.
                    await redemptionWatchtower
                      .connect(guardians[0])
                      .raiseObjection(
                        redemption.walletPublicKeyHash,
                        redemption.redeemerOutputScript
                      )

                    // Set time to the first possible moment the second objection
                    // can no longer be raised. We need to subtract 1 seconds
                    // to make sure the `raiseObjection` transaction
                    // is mined exactly at the timestamp the delay expires.
                    const delayExpiresAt =
                      redemption.requestedAt + levelOneDelay
                    await increaseTime(
                      delayExpiresAt - (await lastBlockTime()) - 1
                    )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      redemptionWatchtower
                        .connect(guardians[1])
                        .raiseObjection(
                          redemption.walletPublicKeyHash,
                          redemption.redeemerOutputScript
                        )
                    ).to.be.revertedWith("Redemption veto delay period expired")
                  })
                })

                context("when the raised objection is the third one", () => {
                  before(async () => {
                    await createSnapshot()

                    // Raise the first objection.
                    await redemptionWatchtower
                      .connect(guardians[0])
                      .raiseObjection(
                        redemption.walletPublicKeyHash,
                        redemption.redeemerOutputScript
                      )

                    // Raise the second objection.
                    await redemptionWatchtower
                      .connect(guardians[1])
                      .raiseObjection(
                        redemption.walletPublicKeyHash,
                        redemption.redeemerOutputScript
                      )

                    // Set time to the first possible moment the third objection
                    // can no longer be raised. We need to subtract 1 seconds
                    // to make sure the `raiseObjection` transaction
                    // is mined exactly at the timestamp the delay expires.
                    const delayExpiresAt =
                      redemption.requestedAt + levelTwoDelay
                    await increaseTime(
                      delayExpiresAt - (await lastBlockTime()) - 1
                    )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      redemptionWatchtower
                        .connect(guardians[2])
                        .raiseObjection(
                          redemption.walletPublicKeyHash,
                          redemption.redeemerOutputScript
                        )
                    ).to.be.revertedWith("Redemption veto delay period expired")
                  })
                })
              }
            )

            context(
              "when delay period expired but request was created before mechanism initialization",
              () => {
                before(async () => {
                  await createSnapshot()

                  // Use the legacy redemption created before the watchtower was enabled.
                  // Jump to a moment when the delay period expired for sure
                  // (use the maximum level-two delay).
                  const levelTwoDelay =
                    await redemptionWatchtower.levelTwoDelay()
                  const delayExpiresAt =
                    legacyRedemption.requestedAt + levelTwoDelay
                  await increaseTime(delayExpiresAt - (await lastBlockTime()))
                })

                after(async () => {
                  await restoreSnapshot()
                })

                context("when the raised objection is the first one", () => {
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    // Raise the first objection.
                    tx = await redemptionWatchtower
                      .connect(guardians[0])
                      .raiseObjection(
                        legacyRedemption.walletPublicKeyHash,
                        legacyRedemption.redeemerOutputScript
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should emit VetoPeriodCheckOmitted event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "VetoPeriodCheckOmitted")
                      .withArgs(legacyRedemption.redemptionKey)
                  })

                  it("should store the objection key", async () => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                    expect(
                      await redemptionWatchtower.objections(
                        buildObjectionKey(
                          legacyRedemption.redemptionKey,
                          guardians[0].address
                        )
                      )
                    ).to.be.true
                  })

                  it("should update veto state properly", async () => {
                    assertVetoProposalTuple(
                      await redemptionWatchtower.vetoProposals(
                        legacyRedemption.redemptionKey
                      ),
                      {
                        redeemer: legacyRedemption.redeemer,
                        withdrawableAmount: 0,
                        finalizedAt: 0,
                        objectionsCount: 1,
                      }
                    )
                  })

                  it("should emit ObjectionRaised event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "ObjectionRaised")
                      .withArgs(
                        legacyRedemption.redemptionKey,
                        guardians[0].address
                      )
                  })
                })

                context("when the raised objection is the second one", () => {
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    // Raise the first objection.
                    await redemptionWatchtower
                      .connect(guardians[0])
                      .raiseObjection(
                        legacyRedemption.walletPublicKeyHash,
                        legacyRedemption.redeemerOutputScript
                      )

                    // Raise the second objection.
                    tx = await redemptionWatchtower
                      .connect(guardians[1])
                      .raiseObjection(
                        legacyRedemption.walletPublicKeyHash,
                        legacyRedemption.redeemerOutputScript
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should emit VetoPeriodCheckOmitted event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "VetoPeriodCheckOmitted")
                      .withArgs(legacyRedemption.redemptionKey)
                  })

                  it("should store the objection key", async () => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                    expect(
                      await redemptionWatchtower.objections(
                        buildObjectionKey(
                          legacyRedemption.redemptionKey,
                          guardians[1].address
                        )
                      )
                    ).to.be.true
                  })

                  it("should update veto state properly", async () => {
                    assertVetoProposalTuple(
                      await redemptionWatchtower.vetoProposals(
                        legacyRedemption.redemptionKey
                      ),
                      {
                        redeemer: legacyRedemption.redeemer,
                        withdrawableAmount: 0,
                        finalizedAt: 0,
                        objectionsCount: 2,
                      }
                    )
                  })

                  it("should emit ObjectionRaised event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "ObjectionRaised")
                      .withArgs(
                        legacyRedemption.redemptionKey,
                        guardians[1].address
                      )
                  })
                })

                context("when the raised objection is the third one", () => {
                  let tx: ContractTransaction
                  let initialWalletPendingRedemptionsValue: BigNumber
                  let initialBridgeBalance: BigNumber
                  let initialWatchtowerBalance: BigNumber

                  before(async () => {
                    await createSnapshot()

                    initialWalletPendingRedemptionsValue = (
                      await bridge.wallets(legacyRedemption.walletPublicKeyHash)
                    ).pendingRedemptionsValue

                    initialBridgeBalance = await bank.balanceOf(bridge.address)

                    initialWatchtowerBalance = await bank.balanceOf(
                      redemptionWatchtower.address
                    )

                    // Raise the first objection.
                    await redemptionWatchtower
                      .connect(guardians[0])
                      .raiseObjection(
                        legacyRedemption.walletPublicKeyHash,
                        legacyRedemption.redeemerOutputScript
                      )
                    // Raise the second objection.
                    await redemptionWatchtower
                      .connect(guardians[1])
                      .raiseObjection(
                        legacyRedemption.walletPublicKeyHash,
                        legacyRedemption.redeemerOutputScript
                      )

                    // Raise the third objection.
                    tx = await redemptionWatchtower
                      .connect(guardians[2])
                      .raiseObjection(
                        legacyRedemption.walletPublicKeyHash,
                        legacyRedemption.redeemerOutputScript
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should emit VetoPeriodCheckOmitted event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "VetoPeriodCheckOmitted")
                      .withArgs(legacyRedemption.redemptionKey)
                  })

                  it("should store the objection key", async () => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                    expect(
                      await redemptionWatchtower.objections(
                        buildObjectionKey(
                          legacyRedemption.redemptionKey,
                          guardians[2].address
                        )
                      )
                    ).to.be.true
                  })

                  it("should update veto state properly", async () => {
                    // Penalty fee is 5% of the redemption amount.
                    const penaltyFee = legacyRedemption.amount.mul(5).div(100)
                    // The withdrawable amount left on the watchtower should
                    // be equal to the redemption amount minus the penalty fee.
                    const withdrawableAmount =
                      legacyRedemption.amount.sub(penaltyFee)

                    assertVetoProposalTuple(
                      await redemptionWatchtower.vetoProposals(
                        legacyRedemption.redemptionKey
                      ),
                      {
                        redeemer: legacyRedemption.redeemer,
                        withdrawableAmount,
                        finalizedAt: await lastBlockTime(),
                        objectionsCount: 3,
                      }
                    )
                  })

                  it("should emit ObjectionRaised event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "ObjectionRaised")
                      .withArgs(
                        legacyRedemption.redemptionKey,
                        guardians[2].address
                      )
                  })

                  it("should mark the redeemer as banned", async () => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                    expect(
                      await redemptionWatchtower.isBanned(
                        legacyRedemption.redeemer
                      )
                    ).to.be.true
                  })

                  it("should emit Banned event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "Banned")
                      .withArgs(legacyRedemption.redeemer)
                  })

                  it("should emit VetoFinalized event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "VetoFinalized")
                      .withArgs(legacyRedemption.redemptionKey)
                  })

                  it("should decrease wallet's pending redemptions value in the Bridge", async () => {
                    const currentWalletPendingRedemptionsValue = (
                      await bridge.wallets(legacyRedemption.walletPublicKeyHash)
                    ).pendingRedemptionsValue

                    const difference = initialWalletPendingRedemptionsValue.sub(
                      currentWalletPendingRedemptionsValue
                    )

                    expect(difference).to.be.equal(
                      legacyRedemption.amount.sub(legacyRedemption.treasuryFee)
                    )
                  })

                  it("should remove pending redemption in the Bridge", async () => {
                    const { requestedAt } = await bridge.pendingRedemptions(
                      legacyRedemption.redemptionKey
                    )

                    expect(requestedAt).to.be.equal(0)
                  })

                  it("should transfer the redemption amount from the Bridge", async () => {
                    const currentBridgeBalance = await bank.balanceOf(
                      bridge.address
                    )

                    const difference =
                      initialBridgeBalance.sub(currentBridgeBalance)

                    // The entire amount should be transferred to the watchtower.
                    expect(difference).to.be.equal(legacyRedemption.amount)

                    // Double-check the right event was emitted.
                    await expect(tx)
                      .to.emit(bank, "BalanceTransferred")
                      .withArgs(
                        bridge.address,
                        redemptionWatchtower.address,
                        legacyRedemption.amount
                      )
                  })

                  it("should leave a proper withdrawable amount and burn the penalty fee", async () => {
                    const currentWatchtowerBalance = await bank.balanceOf(
                      redemptionWatchtower.address
                    )

                    const difference = currentWatchtowerBalance.sub(
                      initialWatchtowerBalance
                    )

                    // Penalty fee is 5% of the redemption amount.
                    const penaltyFee = legacyRedemption.amount.mul(5).div(100)

                    // The withdrawable amount left on the watchtower should
                    // be equal to the redemption amount minus the penalty fee.
                    expect(difference).to.be.equal(
                      legacyRedemption.amount.sub(penaltyFee)
                    )

                    // Make sure the penalty fee was burned.
                    await expect(tx)
                      .to.emit(bank, "BalanceDecreased")
                      .withArgs(redemptionWatchtower.address, penaltyFee)
                  })
                })
              }
            )

            context("when delay period did not expire yet", () => {
              let redemption: RedemptionData
              let defaultDelay: number
              let levelOneDelay: number
              let levelTwoDelay: number

              before(async () => {
                await createSnapshot()

                defaultDelay = await redemptionWatchtower.defaultDelay()
                levelOneDelay = await redemptionWatchtower.levelOneDelay()
                levelTwoDelay = await redemptionWatchtower.levelTwoDelay()

                const redemptions = await createRedemptionRequests(
                  SinglePendingRequestedRedemption
                )
                // eslint-disable-next-line prefer-destructuring
                redemption = redemptions[0]
              })

              after(async () => {
                await restoreSnapshot()
              })

              context(
                "when the raised objection is the first one",
                async () => {
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    // Set time to the latest possible moment the first
                    // objection can be raised. We need to subtract 2 seconds
                    // to make sure the `raiseObjection` transaction
                    // is mined 1 second before the delay expires.
                    const delayExpiresAt = redemption.requestedAt + defaultDelay
                    await increaseTime(
                      delayExpiresAt - (await lastBlockTime()) - 2
                    )

                    // Raise the first objection.
                    tx = await redemptionWatchtower
                      .connect(guardians[0])
                      .raiseObjection(
                        redemption.walletPublicKeyHash,
                        redemption.redeemerOutputScript
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should not emit VetoPeriodCheckOmitted event", async () => {
                    await expect(tx).to.not.emit(
                      redemptionWatchtower,
                      "VetoPeriodCheckOmitted"
                    )
                  })

                  it("should store the objection key", async () => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                    expect(
                      await redemptionWatchtower.objections(
                        buildObjectionKey(
                          redemption.redemptionKey,
                          guardians[0].address
                        )
                      )
                    ).to.be.true
                  })

                  it("should update veto state properly", async () => {
                    assertVetoProposalTuple(
                      await redemptionWatchtower.vetoProposals(
                        redemption.redemptionKey
                      ),
                      {
                        redeemer: redemption.redeemer,
                        withdrawableAmount: 0,
                        finalizedAt: 0,
                        objectionsCount: 1,
                      }
                    )
                  })

                  it("should emit ObjectionRaised event", async () => {
                    await expect(tx)
                      .to.emit(redemptionWatchtower, "ObjectionRaised")
                      .withArgs(redemption.redemptionKey, guardians[0].address)
                  })
                }
              )

              context("when the raised objection is the second one", () => {
                let tx: ContractTransaction

                before(async () => {
                  await createSnapshot()

                  // Raise the first objection.
                  await redemptionWatchtower
                    .connect(guardians[0])
                    .raiseObjection(
                      redemption.walletPublicKeyHash,
                      redemption.redeemerOutputScript
                    )

                  // Set time to the latest possible moment the second
                  // objection can be raised. We need to subtract 2 seconds
                  // to make sure the `raiseObjection` transaction
                  // is mined 1 second before the delay expires.
                  const delayExpiresAt = redemption.requestedAt + levelOneDelay
                  await increaseTime(
                    delayExpiresAt - (await lastBlockTime()) - 2
                  )

                  // Raise the second objection.
                  tx = await redemptionWatchtower
                    .connect(guardians[1])
                    .raiseObjection(
                      redemption.walletPublicKeyHash,
                      redemption.redeemerOutputScript
                    )
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should not emit VetoPeriodCheckOmitted event", async () => {
                  await expect(tx).to.not.emit(
                    redemptionWatchtower,
                    "VetoPeriodCheckOmitted"
                  )
                })

                it("should store the objection key", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(
                    await redemptionWatchtower.objections(
                      buildObjectionKey(
                        redemption.redemptionKey,
                        guardians[1].address
                      )
                    )
                  ).to.be.true
                })

                it("should update veto state properly", async () => {
                  assertVetoProposalTuple(
                    await redemptionWatchtower.vetoProposals(
                      redemption.redemptionKey
                    ),
                    {
                      redeemer: redemption.redeemer,
                      withdrawableAmount: 0,
                      finalizedAt: 0,
                      objectionsCount: 2,
                    }
                  )
                })

                it("should emit ObjectionRaised event", async () => {
                  await expect(tx)
                    .to.emit(redemptionWatchtower, "ObjectionRaised")
                    .withArgs(redemption.redemptionKey, guardians[1].address)
                })
              })

              context("when the raised objection is the third one", () => {
                let tx: ContractTransaction
                let initialWalletPendingRedemptionsValue: BigNumber
                let initialBridgeBalance: BigNumber
                let initialWatchtowerBalance: BigNumber

                before(async () => {
                  await createSnapshot()

                  initialWalletPendingRedemptionsValue = (
                    await bridge.wallets(redemption.walletPublicKeyHash)
                  ).pendingRedemptionsValue

                  initialBridgeBalance = await bank.balanceOf(bridge.address)

                  initialWatchtowerBalance = await bank.balanceOf(
                    redemptionWatchtower.address
                  )

                  // Raise the first objection.
                  await redemptionWatchtower
                    .connect(guardians[0])
                    .raiseObjection(
                      redemption.walletPublicKeyHash,
                      redemption.redeemerOutputScript
                    )
                  // Raise the second objection.
                  await redemptionWatchtower
                    .connect(guardians[1])
                    .raiseObjection(
                      redemption.walletPublicKeyHash,
                      redemption.redeemerOutputScript
                    )

                  // Set time to the latest possible moment the third
                  // objection can be raised. We need to subtract 2 seconds
                  // to make sure the `raiseObjection` transaction
                  // is mined 1 second before the delay expires.
                  const delayExpiresAt = redemption.requestedAt + levelTwoDelay
                  await increaseTime(
                    delayExpiresAt - (await lastBlockTime()) - 2
                  )

                  // Raise the third objection.
                  tx = await redemptionWatchtower
                    .connect(guardians[2])
                    .raiseObjection(
                      redemption.walletPublicKeyHash,
                      redemption.redeemerOutputScript
                    )
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should not emit VetoPeriodCheckOmitted event", async () => {
                  await expect(tx).to.not.emit(
                    redemptionWatchtower,
                    "VetoPeriodCheckOmitted"
                  )
                })

                it("should store the objection key", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(
                    await redemptionWatchtower.objections(
                      buildObjectionKey(
                        redemption.redemptionKey,
                        guardians[2].address
                      )
                    )
                  ).to.be.true
                })

                it("should update veto state properly", async () => {
                  // Penalty fee is 5% of the redemption amount.
                  const penaltyFee = redemption.amount.mul(5).div(100)
                  // The withdrawable amount left on the watchtower should
                  // be equal to the redemption amount minus the penalty fee.
                  const withdrawableAmount = redemption.amount.sub(penaltyFee)

                  assertVetoProposalTuple(
                    await redemptionWatchtower.vetoProposals(
                      redemption.redemptionKey
                    ),
                    {
                      redeemer: redemption.redeemer,
                      withdrawableAmount,
                      finalizedAt: await lastBlockTime(),
                      objectionsCount: 3,
                    }
                  )
                })

                it("should emit ObjectionRaised event", async () => {
                  await expect(tx)
                    .to.emit(redemptionWatchtower, "ObjectionRaised")
                    .withArgs(redemption.redemptionKey, guardians[2].address)
                })

                it("should mark the redeemer as banned", async () => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  expect(
                    await redemptionWatchtower.isBanned(redemption.redeemer)
                  ).to.be.true
                })

                it("should emit Banned event", async () => {
                  await expect(tx)
                    .to.emit(redemptionWatchtower, "Banned")
                    .withArgs(redemption.redeemer)
                })

                it("should emit VetoFinalized event", async () => {
                  await expect(tx)
                    .to.emit(redemptionWatchtower, "VetoFinalized")
                    .withArgs(redemption.redemptionKey)
                })

                it("should decrease wallet's pending redemptions value in the Bridge", async () => {
                  const currentWalletPendingRedemptionsValue = (
                    await bridge.wallets(redemption.walletPublicKeyHash)
                  ).pendingRedemptionsValue

                  const difference = initialWalletPendingRedemptionsValue.sub(
                    currentWalletPendingRedemptionsValue
                  )

                  expect(difference).to.be.equal(
                    redemption.amount.sub(redemption.treasuryFee)
                  )
                })

                it("should remove pending redemption in the Bridge", async () => {
                  const { requestedAt } = await bridge.pendingRedemptions(
                    redemption.redemptionKey
                  )

                  expect(requestedAt).to.be.equal(0)
                })

                it("should transfer the redemption amount from the Bridge", async () => {
                  const currentBridgeBalance = await bank.balanceOf(
                    bridge.address
                  )

                  const difference =
                    initialBridgeBalance.sub(currentBridgeBalance)

                  // The entire amount should be transferred to the watchtower.
                  expect(difference).to.be.equal(redemption.amount)

                  // Double-check the right event was emitted.
                  await expect(tx)
                    .to.emit(bank, "BalanceTransferred")
                    .withArgs(
                      bridge.address,
                      redemptionWatchtower.address,
                      redemption.amount
                    )
                })

                it("should leave a proper withdrawable amount and burn the penalty fee", async () => {
                  const currentWatchtowerBalance = await bank.balanceOf(
                    redemptionWatchtower.address
                  )

                  const difference = currentWatchtowerBalance.sub(
                    initialWatchtowerBalance
                  )

                  // Penalty fee is 5% of the redemption amount.
                  const penaltyFee = redemption.amount.mul(5).div(100)

                  // The withdrawable amount left on the watchtower should
                  // be equal to the redemption amount minus the penalty fee.
                  expect(difference).to.be.equal(
                    redemption.amount.sub(penaltyFee)
                  )

                  // Make sure the penalty fee was burned.
                  await expect(tx)
                    .to.emit(bank, "BalanceDecreased")
                    .withArgs(redemptionWatchtower.address, penaltyFee)
                })
              })
            })
          })
        })
      })
    })
  })

  describe("getRedemptionDelay", () => {
    before(async () => {
      await createSnapshot()

      await redemptionWatchtower.connect(governance).enableWatchtower(
        redemptionWatchtowerManager.address,
        guardians.map((g) => g.address)
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the redemption request does not exist", () => {
      it("should revert", async () => {
        await expect(
          redemptionWatchtower.getRedemptionDelay(
            "0xdf1d1a1cc88980461867cc49753d188c79c96c5a22115bdd8560a3317b786ff8"
          )
        ).to.be.revertedWith("Redemption request does not exist")
      })
    })

    context("when the redemption request exists", () => {
      let redemption: RedemptionData

      before(async () => {
        await createSnapshot()

        const redemptions = await createRedemptionRequests(
          SinglePendingRequestedRedemption
        )
        // eslint-disable-next-line prefer-destructuring
        redemption = redemptions[0]
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the watchtower has been disabled", () => {
        before(async () => {
          await createSnapshot()

          const lifetimeExpiresAt =
            (await redemptionWatchtower.watchtowerEnabledAt()) +
            (await redemptionWatchtower.watchtowerLifetime())

          // Increase time to the moment the watchtower lifetime expires.
          // The `disableWatchtower` transaction should be mined exactly one
          // second after the lifetime expires.
          await increaseTime(lifetimeExpiresAt - (await lastBlockTime()))

          // Disable the watchtower.
          await redemptionWatchtower.connect(thirdParty).disableWatchtower()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should return zero as the delay", async () => {
          expect(
            await redemptionWatchtower.getRedemptionDelay(
              redemption.redemptionKey
            )
          ).to.be.equal(0)
        })
      })

      context("when the watchtower has not been disabled", () => {
        context("when the requested amount is below the waived limit", () => {
          before(async () => {
            await createSnapshot()

            // Set the waived amount limit just above the redemption amount.
            // This way the requested amount is 1 sat lesser than it.
            await redemptionWatchtower
              .connect(redemptionWatchtowerManager)
              .updateWatchtowerParameters(
                await redemptionWatchtower.watchtowerLifetime(),
                20,
                await redemptionWatchtower.vetoFreezePeriod(),
                await redemptionWatchtower.defaultDelay(),
                await redemptionWatchtower.levelOneDelay(),
                await redemptionWatchtower.levelTwoDelay(),
                redemption.amount.add(1)
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should return zero as the delay", async () => {
            expect(
              await redemptionWatchtower.getRedemptionDelay(
                redemption.redemptionKey
              )
            ).to.be.equal(0)
          })
        })

        context(
          "when the requested amount is not below the waived limit",
          () => {
            before(async () => {
              await createSnapshot()

              // Set the waived amount limit to a value equal to the redemption amount.
              // This way the requested amount violates the limit.
              await redemptionWatchtower
                .connect(redemptionWatchtowerManager)
                .updateWatchtowerParameters(
                  await redemptionWatchtower.watchtowerLifetime(),
                  20,
                  await redemptionWatchtower.vetoFreezePeriod(),
                  await redemptionWatchtower.defaultDelay(),
                  await redemptionWatchtower.levelOneDelay(),
                  await redemptionWatchtower.levelTwoDelay(),
                  redemption.amount
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            context("when there are no objections", () => {
              it("should return the default delay", async () => {
                expect(
                  await redemptionWatchtower.getRedemptionDelay(
                    redemption.redemptionKey
                  )
                ).to.be.equal(await redemptionWatchtower.defaultDelay())
              })
            })

            context("when there is one objection", () => {
              before(async () => {
                await createSnapshot()

                // Raise the first objection.
                await redemptionWatchtower
                  .connect(guardians[0])
                  .raiseObjection(
                    redemption.walletPublicKeyHash,
                    redemption.redeemerOutputScript
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should return the level-one delay", async () => {
                expect(
                  await redemptionWatchtower.getRedemptionDelay(
                    redemption.redemptionKey
                  )
                ).to.be.equal(await redemptionWatchtower.levelOneDelay())
              })
            })

            context("when there are two objections", () => {
              before(async () => {
                await createSnapshot()

                // Raise the first objection.
                await redemptionWatchtower
                  .connect(guardians[0])
                  .raiseObjection(
                    redemption.walletPublicKeyHash,
                    redemption.redeemerOutputScript
                  )
                // Raise the second objection.
                await redemptionWatchtower
                  .connect(guardians[1])
                  .raiseObjection(
                    redemption.walletPublicKeyHash,
                    redemption.redeemerOutputScript
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should return the level-two delay", async () => {
                expect(
                  await redemptionWatchtower.getRedemptionDelay(
                    redemption.redemptionKey
                  )
                ).to.be.equal(await redemptionWatchtower.levelTwoDelay())
              })
            })

            context("when there are three objections", () => {
              before(async () => {
                await createSnapshot()

                // Raise the first objection.
                await redemptionWatchtower
                  .connect(guardians[0])
                  .raiseObjection(
                    redemption.walletPublicKeyHash,
                    redemption.redeemerOutputScript
                  )
                // Raise the second objection.
                await redemptionWatchtower
                  .connect(guardians[1])
                  .raiseObjection(
                    redemption.walletPublicKeyHash,
                    redemption.redeemerOutputScript
                  )
                // Raise the third objection.
                await redemptionWatchtower
                  .connect(guardians[2])
                  .raiseObjection(
                    redemption.walletPublicKeyHash,
                    redemption.redeemerOutputScript
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  redemptionWatchtower.getRedemptionDelay(
                    redemption.redemptionKey
                  )
                ).to.be.revertedWith("Redemption request does not exist")
              })
            })
          }
        )
      })
    })
  })

  describe("updateWatchtowerParameters", () => {
    let watchtowerLifetime: number
    let vetoPenaltyFeeDivisor: number
    let vetoFreezePeriod: number
    let defaultDelay: number
    let levelOneDelay: number
    let levelTwoDelay: number
    let waivedAmountLimit: BigNumber

    before(async () => {
      await createSnapshot()

      await redemptionWatchtower.connect(governance).enableWatchtower(
        redemptionWatchtowerManager.address,
        guardians.map((g) => g.address)
      )

      watchtowerLifetime = await redemptionWatchtower.watchtowerLifetime()
      vetoPenaltyFeeDivisor = 20 // Max value 5%
      vetoFreezePeriod = await redemptionWatchtower.vetoFreezePeriod()
      defaultDelay = await redemptionWatchtower.defaultDelay()
      levelOneDelay = await redemptionWatchtower.levelOneDelay()
      levelTwoDelay = await redemptionWatchtower.levelTwoDelay()
      waivedAmountLimit = await redemptionWatchtower.waivedAmountLimit()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the watchtower manager", () => {
      it("should revert", async () => {
        await expect(
          redemptionWatchtower
            .connect(thirdParty)
            .updateWatchtowerParameters(
              watchtowerLifetime,
              vetoPenaltyFeeDivisor,
              vetoFreezePeriod,
              defaultDelay,
              levelOneDelay,
              levelTwoDelay,
              waivedAmountLimit
            )
        ).to.be.revertedWith("Caller is not watchtower manager")
      })
    })

    context("when called by the watchtower manager", () => {
      context("when new parameters are invalid", () => {
        context("when the new lifetime is lesser than the current one", () => {
          it("should revert", async () => {
            await expect(
              redemptionWatchtower
                .connect(redemptionWatchtowerManager)
                .updateWatchtowerParameters(
                  watchtowerLifetime - 1, // lesser than current value by 1
                  vetoPenaltyFeeDivisor,
                  vetoFreezePeriod,
                  defaultDelay,
                  levelOneDelay,
                  levelTwoDelay,
                  waivedAmountLimit
                )
            ).to.be.revertedWith(
              "New lifetime must not be lesser than current one"
            )
          })
        })

        context(
          "when the new veto penalty fee is not in the proper range",
          () => {
            it("should revert", async () => {
              await expect(
                redemptionWatchtower
                  .connect(redemptionWatchtowerManager)
                  .updateWatchtowerParameters(
                    watchtowerLifetime,
                    // Decrease the divisor by 1 to exceed the max value.
                    vetoPenaltyFeeDivisor - 1,
                    vetoFreezePeriod,
                    defaultDelay,
                    levelOneDelay,
                    levelTwoDelay,
                    waivedAmountLimit
                  )
              ).to.be.revertedWith(
                "Redemption veto penalty fee must be in range [0%, 5%]"
              )
            })
          }
        )

        context("when level-two delay is lesser than level-one delay", () => {
          it("should revert", async () => {
            await expect(
              redemptionWatchtower
                .connect(redemptionWatchtowerManager)
                .updateWatchtowerParameters(
                  watchtowerLifetime,
                  vetoPenaltyFeeDivisor,
                  vetoFreezePeriod,
                  defaultDelay,
                  levelOneDelay,
                  levelOneDelay - 1,
                  waivedAmountLimit
                )
            ).to.be.revertedWith(
              "Redemption level-two delay must not be lesser than level-one delay"
            )
          })
        })

        context("when level-one delay is lesser than default delay", () => {
          it("should revert", async () => {
            await expect(
              redemptionWatchtower
                .connect(redemptionWatchtowerManager)
                .updateWatchtowerParameters(
                  watchtowerLifetime,
                  vetoPenaltyFeeDivisor,
                  vetoFreezePeriod,
                  defaultDelay,
                  defaultDelay - 1,
                  levelTwoDelay,
                  waivedAmountLimit
                )
            ).to.be.revertedWith(
              "Redemption level-one delay must not be lesser than default delay"
            )
          })
        })
      })

      context("when all new parameters are valid", () => {
        const testData: {
          testName: string
          newWatchtowerLifetime?: number
          newVetoPenaltyFeeDivisor?: number
          newVetoFreezePeriod?: number
          newDefaultDelay?: number
          newLevelOneDelay?: number
          newLevelTwoDelay?: number
          newWaivedAmountLimit?: BigNumber
        }[] = [
          {
            testName: "when watchtower lifetime is increased",
            newWatchtowerLifetime: 52_600_000, // 20 months
          },
          {
            testName:
              "when veto penalty is changed to to the maximum value of 5%",
            newVetoPenaltyFeeDivisor: 20, // 5%
          },
          {
            testName:
              "when veto penalty is changed to to the middle of the range",
            newVetoPenaltyFeeDivisor: 40, // 2.5%
          },
          {
            testName: "when veto penalty is changed to the minimum value of 0%",
            newVetoPenaltyFeeDivisor: 0, // 0 %
          },
          {
            testName: "when veto freeze period is changed to a non-zero value",
            newVetoFreezePeriod: 7200, // 2 hours
          },
          {
            testName: "when veto freeze period is changed to 0",
            newVetoFreezePeriod: 0,
          },
          {
            testName: "when delays are changed to a non-zero value",
            newDefaultDelay: 14400, // 4 hours
            newLevelOneDelay: 57600, // 16 hours
            newLevelTwoDelay: 115200, // 32 hours
          },
          {
            testName: "when delays are changed to 0",
            newDefaultDelay: 0,
            newLevelOneDelay: 0,
            newLevelTwoDelay: 0,
          },
          {
            testName: "when waived amount limit is changed to a non-zero value",
            newWaivedAmountLimit: BigNumber.from(50_000_000),
          },
        ]

        testData.forEach((test) => {
          let newWatchtowerLifetime: number
          let newVetoPenaltyFeeDivisor: number
          let newVetoFreezePeriod: number
          let newDefaultDelay: number
          let newLevelOneDelay: number
          let newLevelTwoDelay: number
          let newWaivedAmountLimit: BigNumber

          context(test.testName, async () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              const assignValue = (optionalValue, defaultValue) =>
                typeof optionalValue !== "undefined"
                  ? optionalValue
                  : defaultValue

              newWatchtowerLifetime = assignValue(
                test.newWatchtowerLifetime,
                watchtowerLifetime
              )
              newVetoPenaltyFeeDivisor = assignValue(
                test.newVetoPenaltyFeeDivisor,
                vetoPenaltyFeeDivisor
              )
              newVetoFreezePeriod = assignValue(
                test.newVetoFreezePeriod,
                vetoFreezePeriod
              )
              newDefaultDelay = assignValue(test.newDefaultDelay, defaultDelay)
              newLevelOneDelay = assignValue(
                test.newLevelOneDelay,
                levelOneDelay
              )
              newLevelTwoDelay = assignValue(
                test.newLevelTwoDelay,
                levelTwoDelay
              )
              newWaivedAmountLimit = assignValue(
                test.newWaivedAmountLimit,
                waivedAmountLimit
              )

              tx = await redemptionWatchtower
                .connect(redemptionWatchtowerManager)
                .updateWatchtowerParameters(
                  newWatchtowerLifetime,
                  newVetoPenaltyFeeDivisor,
                  newVetoFreezePeriod,
                  newDefaultDelay,
                  newLevelOneDelay,
                  newLevelTwoDelay,
                  newWaivedAmountLimit
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit WatchtowerParametersUpdated event", async () => {
              await expect(tx)
                .to.emit(redemptionWatchtower, "WatchtowerParametersUpdated")
                .withArgs(
                  newWatchtowerLifetime,
                  newVetoPenaltyFeeDivisor,
                  newVetoFreezePeriod,
                  newDefaultDelay,
                  newLevelOneDelay,
                  newLevelTwoDelay,
                  newWaivedAmountLimit
                )
            })

            it("should update the watchtower parameters", async () => {
              expect(
                await redemptionWatchtower.watchtowerLifetime()
              ).to.be.equal(newWatchtowerLifetime)

              expect(
                await redemptionWatchtower.vetoPenaltyFeeDivisor()
              ).to.be.equal(newVetoPenaltyFeeDivisor)

              expect(await redemptionWatchtower.vetoFreezePeriod()).to.be.equal(
                newVetoFreezePeriod
              )

              expect(await redemptionWatchtower.defaultDelay()).to.be.equal(
                newDefaultDelay
              )

              expect(await redemptionWatchtower.levelOneDelay()).to.be.equal(
                newLevelOneDelay
              )

              expect(await redemptionWatchtower.levelTwoDelay()).to.be.equal(
                newLevelTwoDelay
              )
            })
          })
        })
      })
    })
  })

  describe("isSafeRedemption", () => {
    let vetoedRedemption: RedemptionData
    let objectedNonVetoedRedemption: RedemptionData

    before(async () => {
      await createSnapshot()

      // eslint-disable-next-line prefer-destructuring
      vetoedRedemption = (
        await createRedemptionRequests(SinglePendingRequestedRedemption)
      )[0]

      // Create another redemption using the same SinglePendingRequestedRedemption
      // data. Use different redeemerOutputScript to avoid collision
      // with the first redemption.
      const redemptionData = JSON.parse(
        JSON.stringify(SinglePendingRequestedRedemption)
      )
      redemptionData.redemptionRequests[0].redeemerOutputScript =
        "0x17a914011beb6fb8499e075a57027fb0a58384f2d3f78487"
      // eslint-disable-next-line prefer-destructuring
      objectedNonVetoedRedemption = (
        await createRedemptionRequests(redemptionData)
      )[0]

      await redemptionWatchtower.connect(governance).enableWatchtower(
        redemptionWatchtowerManager.address,
        guardians.map((g) => g.address)
      )

      // Raise three objections to veto the first redemption and ban the redeemer.
      await redemptionWatchtower
        .connect(guardians[0])
        .raiseObjection(
          vetoedRedemption.walletPublicKeyHash,
          vetoedRedemption.redeemerOutputScript
        )
      await redemptionWatchtower
        .connect(guardians[1])
        .raiseObjection(
          vetoedRedemption.walletPublicKeyHash,
          vetoedRedemption.redeemerOutputScript
        )
      await redemptionWatchtower
        .connect(guardians[2])
        .raiseObjection(
          vetoedRedemption.walletPublicKeyHash,
          vetoedRedemption.redeemerOutputScript
        )

      // Raise a single objection to the second "objected but non-vetoed" redemption.
      await redemptionWatchtower
        .connect(guardians[0])
        .raiseObjection(
          objectedNonVetoedRedemption.walletPublicKeyHash,
          objectedNonVetoedRedemption.redeemerOutputScript
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the balance owner is banned", () => {
      it("should return false", async () => {
        // Check non-objected redemption with the banned redeemer as balance owner.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await redemptionWatchtower.isSafeRedemption(
            "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
            "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
            vetoedRedemption.redeemer,
            "0x0Bf9bD12462c43A91F13440faF9f9BD6ece37689"
          )
        ).to.be.false
      })
    })

    context("when the redeemer is banned", () => {
      it("should return false", async () => {
        // Check non-objected redemption with the banned redeemer as redeemer.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await redemptionWatchtower.isSafeRedemption(
            "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
            "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
            "0x0Bf9bD12462c43A91F13440faF9f9BD6ece37689",
            vetoedRedemption.redeemer
          )
        ).to.be.false
      })
    })

    context("when redemption key was vetoed", () => {
      it("should return false", async () => {
        // Check vetoed redemption with non-banned balance owner and redeemer.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await redemptionWatchtower.isSafeRedemption(
            vetoedRedemption.walletPublicKeyHash,
            vetoedRedemption.redeemerOutputScript,
            "0x0Bf9bD12462c43A91F13440faF9f9BD6ece37689",
            "0x90a4ac843763F7F345f2738CcC9F420D59751249"
          )
        ).to.be.false
      })
    })

    context("when redemption key was objected but not vetoed", () => {
      it("should return false", async () => {
        // Check objected but non-vetoed redemption with non-banned balance
        // owner and redeemer.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await redemptionWatchtower.isSafeRedemption(
            objectedNonVetoedRedemption.walletPublicKeyHash,
            objectedNonVetoedRedemption.redeemerOutputScript,
            "0x0Bf9bD12462c43A91F13440faF9f9BD6ece37689",
            "0x90a4ac843763F7F345f2738CcC9F420D59751249"
          )
        ).to.be.false
      })
    })

    context("when all safety criteria are met", () => {
      it("should return true", async () => {
        // Check non-objected redemption with non-banned balance owner and redeemer.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(
          await redemptionWatchtower.isSafeRedemption(
            "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
            "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
            "0x0Bf9bD12462c43A91F13440faF9f9BD6ece37689",
            "0x90a4ac843763F7F345f2738CcC9F420D59751249"
          )
        ).to.be.true
      })
    })
  })

  describe("unban", () => {
    before(async () => {
      await createSnapshot()

      await redemptionWatchtower.connect(governance).enableWatchtower(
        redemptionWatchtowerManager.address,
        guardians.map((g) => g.address)
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not the watchtower manager", () => {
      it("should revert", async () => {
        await expect(
          redemptionWatchtower.connect(thirdParty).unban(thirdParty.address)
        ).to.be.revertedWith("Caller is not watchtower manager")
      })
    })

    context("when the caller is the watchtower manager", () => {
      context("when the redeemer is not banned", () => {
        it("should revert", async () => {
          await expect(
            redemptionWatchtower
              .connect(redemptionWatchtowerManager)
              .unban(thirdParty.address)
          ).to.be.revertedWith("Redeemer is not banned")
        })
      })

      context("when the redeemer is banned", () => {
        let tx: ContractTransaction
        let redemption: RedemptionData

        before(async () => {
          await createSnapshot()

          const redemptions = await createRedemptionRequests(
            SinglePendingRequestedRedemption
          )
          // eslint-disable-next-line prefer-destructuring
          redemption = redemptions[0]

          // Raise three objections to veto the redemption and ban the redeemer.
          await redemptionWatchtower
            .connect(guardians[0])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )
          await redemptionWatchtower
            .connect(guardians[1])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )
          await redemptionWatchtower
            .connect(guardians[2])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )

          tx = await redemptionWatchtower
            .connect(redemptionWatchtowerManager)
            .unban(redemption.redeemer)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should remove the redeemer from the banned list", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await redemptionWatchtower.isBanned(redemption.redeemer)).to.be
            .false
        })

        it("should emit Unbanned event", async () => {
          await expect(tx)
            .to.emit(redemptionWatchtower, "Unbanned")
            .withArgs(redemption.redeemer)
        })
      })
    })
  })

  describe("withdrawVetoedFunds", () => {
    let redemption: RedemptionData
    let redeemerSigner: SignerWithAddress

    before(async () => {
      await createSnapshot()

      await redemptionWatchtower.connect(governance).enableWatchtower(
        redemptionWatchtowerManager.address,
        guardians.map((g) => g.address)
      )

      const redemptions = await createRedemptionRequests(
        SinglePendingRequestedRedemption
      )
      // eslint-disable-next-line prefer-destructuring
      redemption = redemptions[0]

      redeemerSigner = await impersonateAccount(redemption.redeemer, {
        from: governance,
        value: 10,
      })
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the veto is not finalized", () => {
      context("when there are no objections at all", () => {
        it("should revert", async () => {
          await expect(
            redemptionWatchtower
              .connect(redeemerSigner)
              .withdrawVetoedFunds(redemption.redemptionKey)
          ).to.be.revertedWith("Redemption veto not finalized")
        })
      })

      context("when there some objections", () => {
        before(async () => {
          await createSnapshot()

          // Raise two objections but do not finalize the veto.
          await redemptionWatchtower
            .connect(guardians[0])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )
          await redemptionWatchtower
            .connect(guardians[1])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            redemptionWatchtower
              .connect(redeemerSigner)
              .withdrawVetoedFunds(redemption.redemptionKey)
          ).to.be.revertedWith("Redemption veto not finalized")
        })
      })
    })

    context(
      "when the veto is finalized and the penalty fee is lesser than 100%",
      () => {
        let withdrawableAmount: BigNumber

        before(async () => {
          await createSnapshot()

          // Change the default 100% penalty fee to 5%.
          await redemptionWatchtower
            .connect(redemptionWatchtowerManager)
            .updateWatchtowerParameters(
              await redemptionWatchtower.watchtowerLifetime(),
              20,
              await redemptionWatchtower.vetoFreezePeriod(),
              await redemptionWatchtower.defaultDelay(),
              await redemptionWatchtower.levelOneDelay(),
              await redemptionWatchtower.levelTwoDelay(),
              await redemptionWatchtower.waivedAmountLimit()
            )

          // Veto the redemption.
          await redemptionWatchtower
            .connect(guardians[0])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )
          await redemptionWatchtower
            .connect(guardians[1])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )
          await redemptionWatchtower
            .connect(guardians[2])
            .raiseObjection(
              redemption.walletPublicKeyHash,
              redemption.redeemerOutputScript
            )

          // Withdrawable amount is the redemption amount minus the 5% penalty fee.
          withdrawableAmount = redemption.amount.sub(redemption.amount.div(20))
          expect(withdrawableAmount).to.be.equal(
            (await redemptionWatchtower.vetoProposals(redemption.redemptionKey))
              .withdrawableAmount
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when the caller is not the redeemer", () => {
          it("should revert", async () => {
            await expect(
              redemptionWatchtower
                .connect(thirdParty)
                .withdrawVetoedFunds(redemption.redemptionKey)
            ).to.be.revertedWith("Caller is not the redeemer")
          })
        })

        context("when the caller is the redeemer", () => {
          context("when the freeze period has not expired", () => {
            before(async () => {
              await createSnapshot()

              const freezePeriodExpiresAt =
                (
                  await redemptionWatchtower.vetoProposals(
                    redemption.redemptionKey
                  )
                ).finalizedAt + (await redemptionWatchtower.vetoFreezePeriod())

              // Increase time to one second before the freeze period expires.
              // The `withdrawVetoedFunds` transaction should be mined at the moment
              // of the freeze period expiration which is one second too early
              // to perform withdrawal.
              await increaseTime(
                freezePeriodExpiresAt - (await lastBlockTime()) - 1
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                redemptionWatchtower
                  .connect(redeemerSigner)
                  .withdrawVetoedFunds(redemption.redemptionKey)
              ).to.be.revertedWith("Freeze period not expired")
            })
          })

          context("when the freeze period has expired", () => {
            before(async () => {
              await createSnapshot()

              const freezePeriodExpiresAt =
                (
                  await redemptionWatchtower.vetoProposals(
                    redemption.redemptionKey
                  )
                ).finalizedAt + (await redemptionWatchtower.vetoFreezePeriod())

              // Increase time to the moment the freeze period expires.
              // The `withdrawVetoedFunds` transaction should be mined exactly one
              // second after the freeze period expiration.
              await increaseTime(
                freezePeriodExpiresAt - (await lastBlockTime())
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            context("when there are no funds to withdraw", () => {
              before(async () => {
                await createSnapshot()

                // Withdraw the entire amount from the watchtower.
                await redemptionWatchtower
                  .connect(redeemerSigner)
                  .withdrawVetoedFunds(redemption.redemptionKey)
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  redemptionWatchtower
                    .connect(redeemerSigner)
                    .withdrawVetoedFunds(redemption.redemptionKey)
                ).to.be.revertedWith("No funds to withdraw")
              })
            })

            context("when there are funds to withdraw", () => {
              let tx: ContractTransaction
              let initialWatchtowerBalance: BigNumber
              let initialRedeemerBalance: BigNumber

              before(async () => {
                await createSnapshot()

                initialWatchtowerBalance = await bank.balanceOf(
                  redemptionWatchtower.address
                )
                initialRedeemerBalance = await bank.balanceOf(
                  redemption.redeemer
                )

                // Withdraw the entire amount from the watchtower.
                tx = await redemptionWatchtower
                  .connect(redeemerSigner)
                  .withdrawVetoedFunds(redemption.redemptionKey)
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should emit VetoedFundsWithdrawn event", async () => {
                await expect(tx)
                  .to.emit(redemptionWatchtower, "VetoedFundsWithdrawn")
                  .withArgs(
                    redemption.redemptionKey,
                    redemption.redeemer,
                    withdrawableAmount
                  )
              })

              it("should set withdrawable amount to zero", async () => {
                expect(
                  (
                    await redemptionWatchtower.vetoProposals(
                      redemption.redemptionKey
                    )
                  ).withdrawableAmount
                ).to.be.equal(0)
              })

              it("should transfer the funds to the redeemer", async () => {
                const currentWatchtowerBalance = await bank.balanceOf(
                  redemptionWatchtower.address
                )
                const currentRedeemerBalance = await bank.balanceOf(
                  redemption.redeemer
                )

                // Watchtower's balance decreased.
                const watchtowerDifference = initialWatchtowerBalance.sub(
                  currentWatchtowerBalance
                )
                // Redeemer's balance increased.
                const redeemerDifference = currentRedeemerBalance.sub(
                  initialRedeemerBalance
                )

                expect(watchtowerDifference).to.be.equal(withdrawableAmount)
                expect(redeemerDifference).to.be.equal(withdrawableAmount)

                // Double-check the right event was emitted.
                await expect(tx)
                  .to.emit(bank, "BalanceTransferred")
                  .withArgs(
                    redemptionWatchtower.address,
                    redemption.redeemer,
                    withdrawableAmount
                  )
              })
            })
          })
        })
      }
    )

    context("when the veto is finalized and the penalty fee is 100%", () => {
      let withdrawableAmount: BigNumber

      before(async () => {
        await createSnapshot()

        // Veto the redemption.
        await redemptionWatchtower
          .connect(guardians[0])
          .raiseObjection(
            redemption.walletPublicKeyHash,
            redemption.redeemerOutputScript
          )
        await redemptionWatchtower
          .connect(guardians[1])
          .raiseObjection(
            redemption.walletPublicKeyHash,
            redemption.redeemerOutputScript
          )
        await redemptionWatchtower
          .connect(guardians[2])
          .raiseObjection(
            redemption.walletPublicKeyHash,
            redemption.redeemerOutputScript
          )

        // Withdrawable amount is 0 as the default penalty fee is 100%.
        withdrawableAmount = BigNumber.from(0)
        expect(withdrawableAmount).to.be.equal(
          (await redemptionWatchtower.vetoProposals(redemption.redemptionKey))
            .withdrawableAmount
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the caller is not the redeemer", () => {
        it("should revert", async () => {
          await expect(
            redemptionWatchtower
              .connect(thirdParty)
              .withdrawVetoedFunds(redemption.redemptionKey)
          ).to.be.revertedWith("Caller is not the redeemer")
        })
      })

      context("when the caller is the redeemer", () => {
        context("when the freeze period has not expired", () => {
          before(async () => {
            await createSnapshot()

            const freezePeriodExpiresAt =
              (
                await redemptionWatchtower.vetoProposals(
                  redemption.redemptionKey
                )
              ).finalizedAt + (await redemptionWatchtower.vetoFreezePeriod())

            // Increase time to one second before the freeze period expires.
            // The `withdrawVetoedFunds` transaction should be mined at the moment
            // of the freeze period expiration which is one second too early
            // to perform withdrawal.
            await increaseTime(
              freezePeriodExpiresAt - (await lastBlockTime()) - 1
            )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              redemptionWatchtower
                .connect(redeemerSigner)
                .withdrawVetoedFunds(redemption.redemptionKey)
            ).to.be.revertedWith("Freeze period not expired")
          })
        })

        context("when the freeze period has expired", () => {
          before(async () => {
            await createSnapshot()

            const freezePeriodExpiresAt =
              (
                await redemptionWatchtower.vetoProposals(
                  redemption.redemptionKey
                )
              ).finalizedAt + (await redemptionWatchtower.vetoFreezePeriod())

            // Increase time to the moment the freeze period expires.
            // The `withdrawVetoedFunds` transaction should be mined exactly one
            // second after the freeze period expiration.
            await increaseTime(freezePeriodExpiresAt - (await lastBlockTime()))
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              redemptionWatchtower
                .connect(redeemerSigner)
                .withdrawVetoedFunds(redemption.redemptionKey)
            ).to.be.revertedWith("No funds to withdraw")
          })
        })
      })
    })
  })

  type RedemptionData = {
    redemptionKey: string
    walletPublicKeyHash: string
    redeemerOutputScript: string
    redeemer: string
    requestedAt: number
    amount: BigNumber
    treasuryFee: BigNumber
  }

  async function createRedemptionRequests(
    data: RedemptionTestData
  ): Promise<RedemptionData[]> {
    // Simulate the wallet is a registered one.
    await bridge.setWallet(data.wallet.pubKeyHash, {
      ecdsaWalletID: data.wallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: data.wallet.pendingRedemptionsValue,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: data.wallet.state,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })

    // Simulate the prepared main UTXO belongs to the wallet.
    await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, data.mainUtxo)

    const redemptions: RedemptionData[] = []

    for (let i = 0; i < data.redemptionRequests.length; i++) {
      const { redeemer, redeemerOutputScript, amount } =
        data.redemptionRequests[i]

      /* eslint-disable no-await-in-loop */
      const redeemerSigner = await impersonateAccount(redeemer, {
        from: governance,
        value: 10,
      })

      await makeRedemptionAllowance(redeemerSigner, amount)

      await bridge
        .connect(redeemerSigner)
        .requestRedemption(
          data.wallet.pubKeyHash,
          data.mainUtxo,
          redeemerOutputScript,
          amount
        )

      const redemptionKey = buildRedemptionKey(
        data.wallet.pubKeyHash,
        redeemerOutputScript
      )

      const { requestedAt, treasuryFee } = await bridge.pendingRedemptions(
        redemptionKey
      )
      /* eslint-enable no-await-in-loop */

      redemptions.push({
        redemptionKey,
        walletPublicKeyHash: data.wallet.pubKeyHash.toString(),
        redeemerOutputScript: redeemerOutputScript.toString(),
        redeemer,
        requestedAt,
        amount: BigNumber.from(amount),
        treasuryFee,
      })
    }

    return redemptions
  }

  async function makeRedemptionAllowance(
    redeemer: SignerWithAddress,
    amount: BigNumberish
  ) {
    // Simulate the redeemer has a Bank balance allowing to make the request.
    await bank.setBalance(redeemer.address, amount)
    // Redeemer must allow the Bridge to spent the requested amount.
    await bank
      .connect(redeemer)
      .increaseBalanceAllowance(bridge.address, amount)
  }

  function buildRedemptionKey(
    walletPubKeyHash: BytesLike,
    redeemerOutputScript: BytesLike
  ): string {
    return ethers.utils.solidityKeccak256(
      ["bytes32", "bytes20"],
      [
        ethers.utils.solidityKeccak256(["bytes"], [redeemerOutputScript]),
        walletPubKeyHash,
      ]
    )
  }

  function buildObjectionKey(redemptionKey: string, guardian: string): string {
    return ethers.utils.solidityKeccak256(
      ["uint256", "address"],
      [redemptionKey, guardian]
    )
  }
})
