import { ethers } from "hardhat"
import type { Bridge, BridgeStub, ReservationRouter } from "../../typechain"

const DAY = 24 * 60 * 60

/**
 * One entry of the reservation term table, as passed to
 * `setReservationTerm(termId, termSeconds, custodyBps, enabled)`.
 */
export interface ReservationTermEntry {
  termId: number
  termSeconds: number
  custodyBps: number
  enabled: boolean
}

/**
 * The ruled reservation term entries, in the order they are added. The
 * 365-day entry goes first: with a non-zero `depositRevealAheadPeriod`, the
 * setter requires the largest entry plus one day to cover that period on
 * every addition, which a short entry added alone may not.
 */
export const RESERVATION_TERM_ENTRIES: readonly ReservationTermEntry[] = [
  { termId: 1, termSeconds: 365 * DAY, custodyBps: 20, enabled: true },
  { termId: 2, termSeconds: 30 * DAY, custodyBps: 2, enabled: true },
  { termId: 3, termSeconds: 91 * DAY, custodyBps: 5, enabled: true },
]

/**
 * Adds the given entries to the Bridge's reservation term table through the
 * governance-only setter, impersonating and funding the Bridge governance.
 *
 * An id that already holds identical values (length, custody fee and enabled
 * flag) is skipped, so seeding is idempotent over a table a deploy script
 * already populated with the same entries. An id that holds different values
 * makes this throw, because the table never rewrites an entry and a silent
 * skip would leave tests running on values other than the ones they assume.
 *
 * @param bridge The Bridge; router functions are reached through its
 *        fallback, so the router ABI is bound to the Bridge address.
 * @param entries Entries to add, in order. Defaults to the ruled entries.
 * @returns The ids written, in order; skipped ids are left out.
 */
export async function seedReservationTerms(
  bridge: Bridge | (Bridge & BridgeStub),
  entries: readonly ReservationTermEntry[] = RESERVATION_TERM_ENTRIES
): Promise<number[]> {
  const reservationRouter: ReservationRouter = await ethers.getContractAt(
    "ReservationRouter",
    bridge.address
  )
  const governanceAddress = await bridge.governance()
  await ethers.provider.send("hardhat_impersonateAccount", [governanceAddress])
  await ethers.provider.send("hardhat_setBalance", [
    governanceAddress,
    "0x8AC7230489E80000",
  ])
  const governance = await ethers.getSigner(governanceAddress)

  const written: number[] = []
  // The stop runs in `finally` so a rejected entry does not leave the
  // governance account impersonated for the rest of the run: impersonation
  // is node state, which snapshot reverts do not undo.
  try {
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      const stored = await reservationRouter.reservationTerm(entry.termId)

      if (stored.termSeconds !== 0) {
        if (
          stored.termSeconds !== entry.termSeconds ||
          stored.custodyBps !== entry.custodyBps ||
          stored.enabled !== entry.enabled
        ) {
          throw new Error(
            `Reservation term ${entry.termId} holds (${stored.termSeconds}, ` +
              `${stored.custodyBps}, ${stored.enabled}), expected ` +
              `(${entry.termSeconds}, ${entry.custodyBps}, ${entry.enabled})`
          )
        }
        // eslint-disable-next-line no-continue
        continue
      }

      // eslint-disable-next-line no-await-in-loop
      await reservationRouter
        .connect(governance)
        .setReservationTerm(
          entry.termId,
          entry.termSeconds,
          entry.custodyBps,
          entry.enabled
        )
      written.push(entry.termId)
    }
  } finally {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [
      governanceAddress,
    ])
  }

  return written
}
