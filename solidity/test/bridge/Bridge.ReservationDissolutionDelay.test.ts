import { ethers, helpers } from "hardhat"
import { expect } from "chai"

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import type {
  Bridge,
  BridgeGovernance,
  ReservationRouter,
  TestReservation,
} from "../../typechain"
import { constants } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// `Reservation.MAX_RESERVATION_DISSOLUTION_DELAY`.
const MAX_RESERVATION_DISSOLUTION_DELAY = 730 * 24 * 60 * 60
// `Reservation.MIN_RESERVATION_TERM`.
const MIN_RESERVATION_TERM = 90 * 24 * 60 * 60
// `WalletProposalValidatorConstants.REQUEST_TIMEOUT_SAFETY_MARGIN`.
const REQUEST_TIMEOUT_SAFETY_MARGIN = 2 * 60 * 60

const BOUND_REVERT = "Reservation dissolution delay out of protocol bounds"

// A baseline that satisfies every unrelated requirement of
// `updateReservationParameters`, so each test varies only the dissolution
// delay.
const baseParams = {
  reservationVault: ethers.ZeroAddress,
  reservationMinAmount: 100_000,
  reservationTxMaxFee: 10_000,
  reservationTermSeconds: MIN_RESERVATION_TERM,
  reservationMaxTotalAmount: 4_000_000,
  maxReservationsPerWallet: 10,
  // Smallest value the action-timeout floor admits.
  reservationActionTimeout: 2 * REQUEST_TIMEOUT_SAFETY_MARGIN + 2,
  reservationRenewalWindowSeconds: 14 * 24 * 60 * 60,
}

// `BridgeGovernance`'s `reservationData` struct (`BridgeGovernanceParameters
// .ReservationData`) starts at storage slot 67 and spans four slots
// (`newReservationVault` and `newReservationMinAmount` pack into slot 0).
// `newReservationDissolutionDelay` is the third uint32 of slot 1 of that
// struct, i.e. absolute slot 68, bit offset 96, 32 bits wide.
const RESERVATION_DATA_SLOT = 67n
const DISSOLUTION_DELAY_STORAGE_SLOT = RESERVATION_DATA_SLOT + 1n
const DISSOLUTION_DELAY_BIT_OFFSET = 96n
const DISSOLUTION_DELAY_BIT_WIDTH = 32n

// 256-bit all-ones word.
const MAX_UINT256 =
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn

// 0x-prefixed, 32-byte-padded hex encoding of a storage word.
const padWordHex = (word: bigint): string =>
  `0x${(word & MAX_UINT256).toString(16).padStart(64, "0")}`

// Zeroes the `width`-wide field at bit offset `offset` within a 256-bit
// word, leaving every other bit untouched.
const clearField = (word: bigint, offset: bigint, width: bigint): bigint => {
  const field = (1n << width) - 1n
  return word & (MAX_UINT256 ^ (field << offset)) & MAX_UINT256
}

// Overwrites the staged `newReservationDissolutionDelay` in
// `BridgeGovernance`'s `reservationData` storage directly. Used to stage a
// value the `begin` guard would have rejected, so the finalize stage can be
// exercised in isolation.
async function stageDissolutionDelay(
  bridgeGovernance: BridgeGovernance,
  dissolutionDelay: number
): Promise<void> {
  const raw = await ethers.provider.getStorage(
    bridgeGovernance.target,
    ethers.toQuantity(DISSOLUTION_DELAY_STORAGE_SLOT)
  )
  const word = clearField(
    BigInt(raw),
    DISSOLUTION_DELAY_BIT_OFFSET,
    DISSOLUTION_DELAY_BIT_WIDTH
  )
  const updated =
    word | (BigInt(dissolutionDelay) << DISSOLUTION_DELAY_BIT_OFFSET)

  await ethers.provider.send("hardhat_setStorageAt", [
    bridgeGovernance.target,
    ethers.toQuantity(DISSOLUTION_DELAY_STORAGE_SLOT),
    padWordHex(updated),
  ])
}

async function deployTestReservation(): Promise<TestReservation> {
  const ReservationProofs = await ethers.getContractFactory("ReservationProofs")
  const reservationProofs = await ReservationProofs.deploy()

  const Reservation = await ethers.getContractFactory("Reservation")
  const reservation = await Reservation.deploy()

  const TestReservationFactory = await ethers.getContractFactory(
    "TestReservation",
    { libraries: { Reservation: reservation.target } }
  )

  return TestReservationFactory.deploy()
}

function setDissolutionDelay(
  testReservation: TestReservation,
  dissolutionDelay: number
) {
  return testReservation.updateReservationParameters(
    baseParams.reservationVault,
    baseParams.reservationMinAmount,
    baseParams.reservationTxMaxFee,
    baseParams.reservationTermSeconds,
    dissolutionDelay,
    baseParams.reservationMaxTotalAmount,
    baseParams.maxReservationsPerWallet,
    baseParams.reservationActionTimeout,
    baseParams.reservationRenewalWindowSeconds
  )
}

describe("Reservation - dissolution delay bound", () => {
  let testReservation: TestReservation

  beforeEach(async () => {
    testReservation = await deployTestReservation()
  })

  describe("updateReservationParameters (library setter)", () => {
    it("accepts exactly 730 days", async () => {
      await setDissolutionDelay(
        testReservation,
        MAX_RESERVATION_DISSOLUTION_DELAY
      )
    })

    it("reverts at 730 days + 1 second", async () => {
      await expect(
        setDissolutionDelay(
          testReservation,
          MAX_RESERVATION_DISSOLUTION_DELAY + 1
        )
      ).to.be.revertedWith(BOUND_REVERT)
    })
  })
})

describe("Reservation - governance ceremony dissolution delay bound", () => {
  let governance: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let bridgeGovernance: BridgeGovernance
  let bridge: Bridge
  let reservationRouter: ReservationRouter

  before(async () => {
    ;({ governance, thirdParty, bridgeGovernance, bridge } =
      await bridgeFixture())

    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.target
    )
  })

  const newReservationDissolutionDelayMax = MAX_RESERVATION_DISSOLUTION_DELAY
  const newReservationDissolutionDelayOverMax =
    MAX_RESERVATION_DISSOLUTION_DELAY + 1
  const newReservationMinAmount = 20000
  const newReservationTxMaxFee = 2000
  const newReservationTermSeconds = 8640000 // 100 days
  const newReservationMaxTotalAmount = 4000000
  const newMaxReservationsPerWallet = 10
  const newReservationActionTimeout = 172800
  const newReservationRenewalWindowSeconds = 172800

  let currentReservationVault: string

  before(async () => {
    const parameters = await reservationRouter.reservationParameters()
    currentReservationVault = parameters.reservationVault
  })

  describe("beginReservationParametersUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .beginReservationParametersUpdate(
              currentReservationVault,
              newReservationMinAmount,
              newReservationTxMaxFee,
              newReservationTermSeconds,
              newReservationDissolutionDelayMax,
              newReservationMaxTotalAmount,
              newMaxReservationsPerWallet,
              newReservationActionTimeout,
              newReservationRenewalWindowSeconds
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: any

      context("with a dissolution delay at the bound (730 days)", () => {
        before(async () => {
          await createSnapshot()
          tx = await bridgeGovernance
            .connect(governance)
            .beginReservationParametersUpdate(
              currentReservationVault,
              newReservationMinAmount,
              newReservationTxMaxFee,
              newReservationTermSeconds,
              newReservationDissolutionDelayMax,
              newReservationMaxTotalAmount,
              newMaxReservationsPerWallet,
              newReservationActionTimeout,
              newReservationRenewalWindowSeconds
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should succeed (stages the value)", async () => {
          // just check no revert
        })

        it("should emit ReservationParametersUpdateStarted event", async () => {
          const blockTimestamp = await helpers.time.lastBlockTime()
          const paramsLib = await helpers.contracts.getContract(
            "BridgeGovernanceParameters"
          )
          const bridgeGovernanceEvents = paramsLib.attach(
            bridgeGovernance.target
          )
          await expect(tx)
            .to.emit(
              bridgeGovernanceEvents,
              "ReservationParametersUpdateStarted"
            )
            .withArgs(
              currentReservationVault,
              newReservationMinAmount,
              newReservationTxMaxFee,
              newReservationTermSeconds,
              newReservationDissolutionDelayMax,
              newReservationMaxTotalAmount,
              newMaxReservationsPerWallet,
              newReservationActionTimeout,
              newReservationRenewalWindowSeconds,
              blockTimestamp
            )
        })
      })

      context(
        "with a dissolution delay over the bound (730 days + 1 second)",
        () => {
          before(async () => {
            await createSnapshot()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert at the begin stage", async () => {
            await expect(
              bridgeGovernance
                .connect(governance)
                .beginReservationParametersUpdate(
                  currentReservationVault,
                  newReservationMinAmount,
                  newReservationTxMaxFee,
                  newReservationTermSeconds,
                  newReservationDissolutionDelayOverMax,
                  newReservationMaxTotalAmount,
                  newMaxReservationsPerWallet,
                  newReservationActionTimeout,
                  newReservationRenewalWindowSeconds
                )
            ).to.be.revertedWith(BOUND_REVERT)
          })
        }
      )
    })
  })

  describe("finalizeReservationParametersUpdate", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(thirdParty)
            .finalizeReservationParametersUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the update process is not initialized", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeReservationParametersUpdate()
        ).to.be.revertedWith("Change not initiated")
      })
    })

    context("when the governance delay has not passed", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .beginReservationParametersUpdate(
            currentReservationVault,
            newReservationMinAmount,
            newReservationTxMaxFee,
            newReservationTermSeconds,
            newReservationDissolutionDelayMax,
            newReservationMaxTotalAmount,
            newMaxReservationsPerWallet,
            newReservationActionTimeout,
            newReservationRenewalWindowSeconds
          )

        await helpers.time.increaseTime(constants.governanceDelay - 60) // -1min
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bridgeGovernance
            .connect(governance)
            .finalizeReservationParametersUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })
    })

    context(
      "when the update process is initialized and governance delay passed",
      () => {
        let tx: any

        context("with a dissolution delay at the bound (730 days)", () => {
          before(async () => {
            await createSnapshot()

            await bridgeGovernance
              .connect(governance)
              .beginReservationParametersUpdate(
                currentReservationVault,
                newReservationMinAmount,
                newReservationTxMaxFee,
                newReservationTermSeconds,
                newReservationDissolutionDelayMax,
                newReservationMaxTotalAmount,
                newMaxReservationsPerWallet,
                newReservationActionTimeout,
                newReservationRenewalWindowSeconds
              )

            await helpers.time.increaseTime(constants.governanceDelay)

            tx = await bridgeGovernance
              .connect(governance)
              .finalizeReservationParametersUpdate()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the reservation parameters", async () => {
            const params = await reservationRouter.reservationParameters()
            expect(params.reservationVault).to.be.equal(currentReservationVault)
            expect(params.reservationMinAmount).to.be.equal(
              newReservationMinAmount
            )
            expect(params.reservationTxMaxFee).to.be.equal(
              newReservationTxMaxFee
            )
            expect(params.reservationTermSeconds).to.be.equal(
              newReservationTermSeconds
            )
            expect(params.reservationDissolutionDelay).to.be.equal(
              newReservationDissolutionDelayMax
            )
            expect(params.reservationMaxTotalAmount).to.be.equal(
              newReservationMaxTotalAmount
            )
            expect(params.maxReservationsPerWallet).to.be.equal(
              newMaxReservationsPerWallet
            )
            expect(params.reservationActionTimeout).to.be.equal(
              newReservationActionTimeout
            )
            expect(params.reservationRenewalWindowSeconds).to.be.equal(
              newReservationRenewalWindowSeconds
            )
          })

          it("should emit ReservationParametersUpdated event", async () => {
            await expect(tx)
              .to.emit(reservationRouter, "ReservationParametersUpdated")
              .withArgs(
                newReservationMinAmount,
                newReservationTxMaxFee,
                newReservationTermSeconds,
                newReservationDissolutionDelayMax,
                newReservationMaxTotalAmount,
                newMaxReservationsPerWallet,
                newReservationActionTimeout,
                newReservationRenewalWindowSeconds
              )
          })
        })

        context(
          "with a dissolution delay over the bound (730 days + 1 second)",
          () => {
            before(async () => {
              await createSnapshot()

              // The begin-stage guard rejects an over-bound delay, so the
              // staged value is written straight into the governance
              // contract's storage. That isolates the finalize stage: the
              // staged value is read, the staged change is cleared, and the
              // value is forwarded to the Bridge's reservation setter, which
              // must reject it.
              await bridgeGovernance
                .connect(governance)
                .beginReservationParametersUpdate(
                  currentReservationVault,
                  newReservationMinAmount,
                  newReservationTxMaxFee,
                  newReservationTermSeconds,
                  newReservationDissolutionDelayMax,
                  newReservationMaxTotalAmount,
                  newMaxReservationsPerWallet,
                  newReservationActionTimeout,
                  newReservationRenewalWindowSeconds
                )

              await stageDissolutionDelay(
                bridgeGovernance,
                newReservationDissolutionDelayOverMax
              )

              await helpers.time.increaseTime(constants.governanceDelay)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert at the finalize stage (forwarded to library setter)", async () => {
              await expect(
                bridgeGovernance
                  .connect(governance)
                  .finalizeReservationParametersUpdate()
              ).to.be.revertedWith(BOUND_REVERT)
            })
          }
        )
      }
    )
  })
})
