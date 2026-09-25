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
      name: "Started" | "Finalized"
      blockNumber: number
      logIndex: number
      args: any[]
    }

    const started = (
      entry: ReservationTermEntry,
      blockNumber: number,
      timestamp = STARTED_AT
    ): StagingEvent => ({
      name: "Started",
      blockNumber,
      logIndex: 0,
      args: [
        entry.termId,
        entry.termSeconds,
        entry.custodyBps,
        entry.enabled,
        BigNumber.from(timestamp),
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

    const [yearEntry, monthEntry, quarterEntry] = RESERVATION_TERM_ENTRIES

    /**
     * Runs the script against a mock HRE holding the given table and
     * staging events, and returns the term-table transactions it sent.
     */
    async function run(options: {
      table?: ReservationTermEntry[]
      events?: StagingEvent[]
      now?: number
    }): Promise<{ method: string; args: any[] }[]> {
      const table = options.table ?? []
      const events = options.events ?? []
      const executed: { method: string; args: any[] }[] = []

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
          log: () => undefined,
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
              receipt: { blockNumber: DEPLOYMENT_BLOCK },
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
            getBlockNumber: async () => LATEST_BLOCK,
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
              }
            }
            if (name === "BridgeGovernance") {
              expect(address).to.equal(BRIDGE_GOVERNANCE)
              return {
                filters: {
                  ReservationTermUpdateStarted: () => "Started",
                  ReservationTermUpdateFinalized: () => "Finalized",
                },
                queryFilter: async (
                  filter: string,
                  fromBlock: number,
                  toBlock: number
                ) =>
                  events.filter(
                    (event) =>
                      event.name === filter &&
                      event.blockNumber >= fromBlock &&
                      event.blockNumber <= toBlock
                  ),
              }
            }
            throw new Error(`Unexpected contract: ${name}`)
          },
        },
      }

      await func(mockHre)

      return executed.filter((tx) => tx.method.includes("ReservationTerm"))
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
  })
})
