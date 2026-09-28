/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import { ethers } from "hardhat"
import { BigNumber } from "ethers"
import func, {
  RESERVATION_TERM_ENTRIES,
} from "../../deploy/97_set_reservation_parameters"
import type { ReservationTermEntry } from "../../deploy/97_set_reservation_parameters"
import bridgeFixture from "../fixtures/bridge"
import {
  RESERVATION_TERM_ENTRIES as FIXTURE_RESERVATION_TERM_ENTRIES,
  seedReservationTerms,
} from "../helpers/reservation-terms"

const DAY = 24 * 60 * 60

describe("Deploy Script 97: reservation term table seeding", () => {
  it("should seed the same entries as the Bridge fixture, 365 days first", () => {
    expect(RESERVATION_TERM_ENTRIES).to.deep.equal(
      FIXTURE_RESERVATION_TERM_ENTRIES
    )
    expect(RESERVATION_TERM_ENTRIES[0].termSeconds).to.equal(365 * DAY)
  })

  describe("on the hardhat network, inside the Bridge fixture", () => {
    it("should add every entry through BridgeGovernance, in order, leaving the fixture helper nothing to write", async () => {
      const { bridge, bridgeGovernance } = await bridgeFixture()
      const reservationRouter = await ethers.getContractAt(
        "ReservationRouter",
        bridge.address
      )

      // Every table write since genesis: the deploy script's finalizes, and
      // any write the fixture's helper made after them.
      const events = await reservationRouter.queryFilter(
        reservationRouter.filters.ReservationTermUpdated(),
        0,
        "latest"
      )
      const writes = await Promise.all(
        events.map(async (event) => ({
          termId: event.args.termId,
          termSeconds: event.args.termSeconds,
          custodyBps: event.args.custodyBps,
          enabled: event.args.enabled,
          to: (await event.getTransaction()).to,
        }))
      )
      expect(writes).to.deep.equal(
        RESERVATION_TERM_ENTRIES.map((entry) => ({
          ...entry,
          to: bridgeGovernance.address,
        }))
      )

      // eslint-disable-next-line no-restricted-syntax
      for (const entry of RESERVATION_TERM_ENTRIES) {
        // eslint-disable-next-line no-await-in-loop
        const stored = await reservationRouter.reservationTerm(entry.termId)
        expect(stored.termSeconds).to.equal(entry.termSeconds)
        expect(stored.custodyBps).to.equal(entry.custodyBps)
        expect(stored.enabled).to.equal(entry.enabled)
      }
      expect(await seedReservationTerms(bridge)).to.deep.equal([])
    })
  })

  describe("on a live non-mainnet network", () => {
    const GOVERNANCE = "0x1000000000000000000000000000000000000001"
    const BRIDGE = "0x0000000000000000000000000000000000000001"
    const BRIDGE_GOVERNANCE = "0x0000000000000000000000000000000000000002"
    const RESERVATION_VAULT = "0x0000000000000000000000000000000000000003"
    // Sepolia's governance delay (`09_deploy_bridge_governance.ts`).
    const GOVERNANCE_DELAY = 60
    const DEPLOYMENT_BLOCK = 100
    // Far enough past the deployment block that the event scan spans
    // several chunks.
    const LATEST_BLOCK = 7_000
    const STARTED_AT = 1_800_000_000

    type StagingEvent = {
      name:
        | "Started"
        | "Finalized"
        | "CapsStarted"
        | "CapsUpdated"
        | "ParametersStarted"
        | "ParametersUpdated"
      blockNumber: number
      logIndex: number
      args: any[]
    }

    const started = (
      entry: ReservationTermEntry,
      blockNumber: number,
      logIndex = 0
    ): StagingEvent => ({
      name: "Started",
      blockNumber,
      logIndex,
      args: [
        entry.termId,
        entry.termSeconds,
        entry.custodyBps,
        entry.enabled,
        BigNumber.from(STARTED_AT),
      ],
    })

    const finalized = (
      entry: ReservationTermEntry,
      blockNumber: number
    ): StagingEvent => ({
      name: "Finalized",
      blockNumber,
      logIndex: 0,
      args: [entry.termId, entry.termSeconds, entry.custodyBps, entry.enabled],
    })

    // A step 1 or step 2 staging event. A Started event carries the staged
    // values, the script's targets unless given; an Updated event's values
    // are not read.
    const stagingEvent = (
      name: StagingEvent["name"],
      blockNumber: number,
      values?: Record<string, unknown>
    ): StagingEvent => {
      const defaults: Partial<Record<string, Record<string, unknown>>> = {
        CapsStarted: TARGET_CAPS,
        ParametersStarted: TARGET_PARAMETERS,
      }
      const staged = values ?? defaults[name]
      return {
        name,
        blockNumber,
        logIndex: 0,
        args: staged
          ? [...Object.values(staged), BigNumber.from(STARTED_AT)]
          : [],
      }
    }

    // The live caps and parameters before any update is applied, and the
    // values steps 1 and 2 stage.
    const UNSET_CAPS = {
      maxReservationsAmountPerWallet: 0,
      reservationMaxSingleAmount: 0,
      maxActiveReservations: 0,
    }
    const TARGET_CAPS = {
      maxReservationsAmountPerWallet: 1_000_000,
      reservationMaxSingleAmount: 100_000,
      maxActiveReservations: 100,
    }
    const UNSET_PARAMETERS = {
      reservationVault: "0x0000000000000000000000000000000000000000",
      reservationMinAmount: 0,
      reservationTxMaxFee: 0,
      reservationTermSeconds: 0,
      reservationDissolutionDelay: 0,
      reservationMaxTotalAmount: 0,
      maxReservationsPerWallet: 0,
      reservationActionTimeout: 0,
      reservationRenewalWindowSeconds: 0,
    }
    const TARGET_PARAMETERS = {
      reservationVault: RESERVATION_VAULT,
      reservationMinAmount: 10_000,
      reservationTxMaxFee: 1_000,
      reservationTermSeconds: 90 * DAY,
      reservationDissolutionDelay: DAY,
      reservationMaxTotalAmount: 10_000_000,
      maxReservationsPerWallet: 5,
      reservationActionTimeout: DAY,
      reservationRenewalWindowSeconds: DAY,
    }

    const [yearEntry, monthEntry, quarterEntry] = RESERVATION_TERM_ENTRIES

    // The script's log lines from the last `run`.
    const logs: string[] = []

    /**
     * Runs the script against a mock HRE holding the given table, live caps
     * and parameters, and staging events, and returns the transactions it
     * sent whose method matches `select` (by default, the term-table ones).
     */
    async function run(
      options: {
        table?: ReservationTermEntry[]
        events?: StagingEvent[]
        now?: number
        caps?: Record<string, unknown>
        parameters?: Record<string, unknown>
        latestBlock?: number
        withoutReceipt?: boolean
      },
      select = (method: string) => method.includes("ReservationTerm")
    ): Promise<{ method: string; args: any[] }[]> {
      const table = options.table ?? []
      const events = options.events ?? []
      const executed: { method: string; args: any[] }[] = []
      logs.length = 0
      const queryFilter = async (
        filter: string,
        fromBlock: number,
        toBlock: number
      ) =>
        events.filter(
          (event) =>
            event.name === filter &&
            event.blockNumber >= fromBlock &&
            event.blockNumber <= toBlock
        )

      const mockHre: any = {
        network: { name: "sepolia" },
        getNamedAccounts: async () => ({ governance: GOVERNANCE }),
        helpers: {
          time: {
            increaseTime: async () => {
              throw new Error("the chain clock is not moved on a live network")
            },
          },
        },
        deployments: {
          log: (message: string) => {
            logs.push(message)
          },
          get: async (name: string) => {
            const addresses: Record<string, string> = {
              Bridge: BRIDGE,
              BridgeGovernance: BRIDGE_GOVERNANCE,
              ReservationVault: RESERVATION_VAULT,
            }
            if (!addresses[name]) {
              throw new Error(`No deployment found for: ${name}`)
            }
            return {
              address: addresses[name],
              receipt: options.withoutReceipt
                ? undefined
                : { blockNumber: DEPLOYMENT_BLOCK },
            }
          },
          read: async (name: string, method: string) => {
            if (name === "BridgeGovernance" && method === "governanceDelays") {
              return BigNumber.from(GOVERNANCE_DELAY)
            }
            throw new Error(`Unexpected read: ${name}.${method}`)
          },
          execute: async (
            name: string,
            _options: any,
            method: string,
            ...args: any[]
          ) => {
            expect(name).to.equal("BridgeGovernance")
            executed.push({ method, args })
          },
        },
        ethers: {
          BigNumber,
          provider: {
            getBlockNumber: async () => options.latestBlock ?? LATEST_BLOCK,
            getBlock: async () => ({
              timestamp: options.now ?? STARTED_AT + GOVERNANCE_DELAY,
            }),
          },
          getContractAt: async (name: string, address: string) => {
            if (name === "ReservationRouter") {
              expect(address).to.equal(BRIDGE)
              return {
                reservationTerm: async (termId: number) => {
                  const entry = table.find((e) => e.termId === termId)
                  return entry
                    ? {
                        termSeconds: entry.termSeconds,
                        custodyBps: entry.custodyBps,
                        enabled: entry.enabled,
                      }
                    : { termSeconds: 0, custodyBps: 0, enabled: false }
                },
                reservationCaps: async () => options.caps ?? UNSET_CAPS,
                reservationParameters: async () =>
                  options.parameters ?? UNSET_PARAMETERS,
                filters: {
                  ReservationCapsUpdated: () => "CapsUpdated",
                  ReservationParametersUpdated: () => "ParametersUpdated",
                },
                queryFilter,
              }
            }
            if (name === "BridgeGovernanceParameters") {
              expect(address).to.equal(BRIDGE_GOVERNANCE)
              return {
                filters: {
                  ReservationCapsUpdateStarted: () => "CapsStarted",
                  ReservationParametersUpdateStarted: () => "ParametersStarted",
                },
                queryFilter,
              }
            }
            if (name === "BridgeGovernance") {
              expect(address).to.equal(BRIDGE_GOVERNANCE)
              return {
                filters: {
                  ReservationTermUpdateStarted: () => "Started",
                  ReservationTermUpdateFinalized: () => "Finalized",
                },
                queryFilter,
              }
            }
            throw new Error(`Unexpected contract: ${name}`)
          },
        },
      }

      await func(mockHre)

      return executed.filter((tx) => select(tx.method))
    }

    const begin = (entry: ReservationTermEntry) => ({
      method: "beginReservationTermUpdate",
      args: [entry.termId, entry.termSeconds, entry.custodyBps, entry.enabled],
    })
    const finalize = { method: "finalizeReservationTermUpdate", args: [] }

    it("should begin the 365-day entry first over an empty table", async () => {
      expect(await run({})).to.deep.equal([begin(yearEntry)])
    })

    it("should finalize a staged entry once its delay has passed, then begin the next", async () => {
      expect(
        await run({
          events: [started(yearEntry, 6_500)],
          now: STARTED_AT + GOVERNANCE_DELAY,
        })
      ).to.deep.equal([finalize, begin(monthEntry)])
    })

    it("should send nothing while the staged entry's delay is running", async () => {
      expect(
        await run({
          events: [started(yearEntry, 6_500)],
          now: STARTED_AT + GOVERNANCE_DELAY - 1,
        })
      ).to.deep.equal([])
    })

    it("should begin the next missing entry after a finalized one", async () => {
      expect(
        await run({
          table: [yearEntry],
          events: [started(yearEntry, 2_100), finalized(yearEntry, 2_200)],
        })
      ).to.deep.equal([begin(monthEntry)])
    })

    it("should finalize the last entry and begin nothing more", async () => {
      expect(
        await run({
          table: [yearEntry, monthEntry],
          events: [
            started(yearEntry, 200),
            finalized(yearEntry, 300),
            started(monthEntry, 400),
            finalized(monthEntry, 500),
            started(quarterEntry, 6_900),
          ],
        })
      ).to.deep.equal([finalize])
    })

    it("should send nothing once every entry exists", async () => {
      expect(await run({ table: [...RESERVATION_TERM_ENTRIES] })).to.deep.equal(
        []
      )
    })

    it("should refuse to finalize a staged entry that is not the next missing one", async () => {
      let error: Error | undefined
      try {
        await run({ events: [started(quarterEntry, 6_500)] })
      } catch (e) {
        error = e as Error
      }
      expect(error?.message).to.match(/is not the next missing entry/)
    })

    it("should refuse a table entry holding other values", async () => {
      let error: Error | undefined
      try {
        await run({
          table: [yearEntry, { ...monthEntry, custodyBps: 3 }],
        })
      } catch (e) {
        error = e as Error
      }
      expect(error?.message).to.match(/Reservation term 2 holds/)
    })

    it("should find a staged entry exactly on a chunk boundary", async () => {
      // The second chunk starts at the deployment block plus the chunk size.
      expect(
        await run({ events: [started(yearEntry, DEPLOYMENT_BLOCK + 2_000)] })
      ).to.deep.equal([finalize, begin(monthEntry)])
    })

    it("should read a Started after a Finalized in the same block as staged", async () => {
      expect(
        await run({
          table: [yearEntry],
          events: [finalized(yearEntry, 3_000), started(monthEntry, 3_000, 1)],
        })
      ).to.deep.equal([finalize, begin(quarterEntry)])
    })

    it("should scan from the deployment block, past the fallback lookback, when the receipt exists", async () => {
      expect(
        await run({
          events: [started(yearEntry, DEPLOYMENT_BLOCK + 50)],
          latestBlock: 300_000,
        })
      ).to.deep.equal([finalize, begin(monthEntry)])
    })

    it("should bound the scan by the fallback lookback when there is no receipt", async () => {
      // The staged entry is older than the lookback, so it is not seen and
      // the first entry is begun again.
      expect(
        await run({
          events: [started(yearEntry, DEPLOYMENT_BLOCK + 50)],
          latestBlock: 300_000,
          withoutReceipt: true,
        })
      ).to.deep.equal([begin(yearEntry)])
    })

    context("when the staged entry has the next id but other values", () => {
      // eslint-disable-next-line no-restricted-syntax
      for (const [label, staged] of [
        ["seconds", { ...yearEntry, termSeconds: 30 * DAY }],
        ["custody fee", { ...yearEntry, custodyBps: 2 }],
        ["enabled flag", { ...yearEntry, enabled: false }],
      ] as [string, ReservationTermEntry][]) {
        it(`should refuse to finalize it (other ${label})`, async () => {
          let error: Error | undefined
          try {
            await run({ events: [started(staged, 6_500)] })
          } catch (e) {
            error = e as Error
          }
          expect(error?.message).to.match(/is not the next missing entry/)
        })
      }
    })

    it("should refuse a disabled table entry with matching length and custody fee", async () => {
      let error: Error | undefined
      try {
        await run({ table: [{ ...yearEntry, enabled: false }] })
      } catch (e) {
        error = e as Error
      }
      expect(error?.message).to.match(/Reservation term 1 holds/)
    })

    describe("steps 1 and 2 across re-runs", () => {
      const isCapsOrParametersBegin = (method: string) =>
        method === "beginReservationCapsUpdate" ||
        method === "beginReservationParametersUpdate"
      const bothBegins = [
        "beginReservationCapsUpdate",
        "beginReservationParametersUpdate",
      ]
      const methods = async (options: Parameters<typeof run>[0]) =>
        (await run(options, isCapsOrParametersBegin)).map((tx) => tx.method)

      it("should stage caps and parameters on the first run only, and not again while staged or once applied", async () => {
        // First run: nothing applied, nothing staged.
        expect(await methods({})).to.deep.equal(bothBegins)

        // Second run: both updates staged by the first run.
        const staging = [
          stagingEvent("CapsStarted", 200),
          stagingEvent("ParametersStarted", 200),
        ]
        expect(await methods({ events: staging })).to.deep.equal([])

        // Third run: both finalized, so the live values equal the targets
        // and the Bridge's update events follow the staging.
        expect(
          await methods({
            events: [
              ...staging,
              stagingEvent("CapsUpdated", 300),
              stagingEvent("ParametersUpdated", 301),
            ],
            caps: TARGET_CAPS,
            parameters: TARGET_PARAMETERS,
          })
        ).to.deep.equal([])
      })

      it("should not read an applied staging as staged", async () => {
        // Control for the staged check: an applied staging is not staged.
        expect(
          await methods({
            events: [
              stagingEvent("CapsStarted", 200),
              stagingEvent("CapsUpdated", 300),
            ],
            parameters: TARGET_PARAMETERS,
          })
        ).to.deep.equal(["beginReservationCapsUpdate"])
      })

      it("should not report caps as applied when only a non-first field differs", async () => {
        expect(
          await methods({
            caps: { ...TARGET_CAPS, maxActiveReservations: 99 },
            parameters: TARGET_PARAMETERS,
          })
        ).to.deep.equal([])
        expect(logs.join("\n")).to.not.match(/caps already hold/)
        expect(logs.join("\n")).to.match(
          /\[REFUSED\] Live reservation caps .*differing: maxActiveReservations\)/
        )
      })

      it("should not report parameters as applied when only a non-first field differs", async () => {
        expect(
          await methods({
            caps: TARGET_CAPS,
            parameters: {
              ...TARGET_PARAMETERS,
              reservationActionTimeout: 7_201,
            },
          })
        ).to.deep.equal([])
        expect(logs.join("\n")).to.not.match(/parameters already hold/)
        expect(logs.join("\n")).to.match(
          /\[REFUSED\] Live reservation parameters .*differing: reservationActionTimeout\)/
        )
      })

      it("should keep staged parameters staged when only caps were applied since", async () => {
        expect(
          await methods({
            events: [
              stagingEvent("CapsStarted", 150),
              stagingEvent("ParametersStarted", 200),
              stagingEvent("CapsUpdated", 300),
            ],
            caps: TARGET_CAPS,
          })
        ).to.deep.equal([])
        expect(logs.join("\n")).to.match(
          /reservation parameters update is already staged/
        )
      })

      it("should refuse, without a begin or a finalize instruction, caps that governance set to other values", async () => {
        expect(
          await methods({
            caps: { ...TARGET_CAPS, maxReservationsAmountPerWallet: 3_000_000 },
            parameters: TARGET_PARAMETERS,
          })
        ).to.deep.equal([])
        const output = logs.join("\n")
        expect(output).to.match(
          /\[REFUSED\] Live reservation caps .*differing: maxReservationsAmountPerWallet\)/
        )
        expect(output).to.not.match(/finalizeReservationCapsUpdate/)
      })

      it("should begin caps that are unset", async () => {
        expect(
          await methods({ caps: UNSET_CAPS, parameters: TARGET_PARAMETERS })
        ).to.deep.equal(["beginReservationCapsUpdate"])
        expect(logs.join("\n")).to.match(
          /PENDING FINALIZE.*finalizeReservationCapsUpdate/
        )
      })

      it("should refuse, without a finalize instruction, a staged caps update holding other values", async () => {
        expect(
          await methods({
            events: [
              stagingEvent("CapsStarted", 200, {
                ...TARGET_CAPS,
                reservationMaxSingleAmount: 200_000,
              }),
            ],
            parameters: TARGET_PARAMETERS,
          })
        ).to.deep.equal([])
        const output = logs.join("\n")
        expect(output).to.match(
          /\[REFUSED\] A reservation caps update staged with other values \(differing: reservationMaxSingleAmount\).*resolve it before re-running/
        )
        expect(output).to.not.match(/already staged/)
        expect(output).to.not.match(/finalizeReservationCapsUpdate/)
      })

      it("should report a staged caps update holding the targets as staged, with a finalize instruction", async () => {
        expect(
          await methods({
            events: [stagingEvent("CapsStarted", 200)],
            parameters: TARGET_PARAMETERS,
          })
        ).to.deep.equal([])
        const output = logs.join("\n")
        expect(output).to.match(/reservation caps update is already staged/)
        expect(output).to.match(
          /PENDING FINALIZE.*finalizeReservationCapsUpdate/
        )
        expect(output).to.not.match(/REFUSED/)
      })
    })
  })
})
