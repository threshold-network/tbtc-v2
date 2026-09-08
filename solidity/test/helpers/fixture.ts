import { ethers } from "hardhat"

type Fixture<T> = () => Promise<T>

const snapshots = new Map<Fixture<unknown>, { data: unknown; id: string }>()

/**
 * Drop-in replacement for `waffle.loadFixture` that checks whether its snapshot
 * still exists before trusting it.
 *
 * `@nomiclabs/hardhat-waffle` vendors its own fixture loader
 * (`dist/src/fixtures.js`) which discards the result of `evm_revert`:
 *
 *     await snapshot.provider.send("evm_revert", [snapshot.id])
 *     snapshot.id = await snapshot.provider.send("evm_snapshot", [])
 *     return snapshot.data
 *
 * Hardhat deletes a snapshot and every snapshot taken after it on a successful
 * revert, and returns `false` — changing nothing — for an id it no longer
 * knows. `hardhat-deploy`'s `deployments.fixture()`, which `bridgeFixture`
 * calls, reverts to the oldest live snapshot dozens of times per run, so every
 * cached fixture snapshot is destroyed repeatedly. Waffle then reverts nothing,
 * re-snapshots the *wrong* chain, and hands back the cached JS objects anyway:
 * the caller receives contract handles describing a world the chain is no
 * longer in.
 *
 * That is silent. It cost 28 failures in the full suite that every affected
 * file passed in isolation, presenting as "Caller is not the governance" and
 * "Not at current or previous difficulty" — because `bridge.governance()` and
 * the relay config belonged to whichever suite ran last.
 *
 * The fix is the same recovery `hardhat-deploy` already performs for its own
 * fixtures: if the snapshot is gone, drop it and re-run the fixture body.
 * Reverting stays the fast path; re-running is the correctness backstop.
 *
 * @param fixture Zero-argument fixture function. Identity is the cache key, so
 *        pass the same function reference (a module-level fixture), not a
 *        freshly-built closure.
 * @returns Whatever the fixture returned, with the chain guaranteed to be in
 *          the state that value was captured in.
 */
export async function loadFixture<T>(fixture: Fixture<T>): Promise<T> {
  const cached = snapshots.get(fixture)

  if (cached !== undefined) {
    const reverted = await ethers.provider.send("evm_revert", [cached.id])
    if (reverted === true) {
      cached.id = await ethers.provider.send("evm_snapshot", [])
      return cached.data as T
    }
    // Snapshot was spliced away by an older revert. The cached data no longer
    // describes the chain, so it must not be returned.
    snapshots.delete(fixture)
  }

  const data = await fixture()
  const id = await ethers.provider.send("evm_snapshot", [])
  snapshots.set(fixture as Fixture<unknown>, { data, id })
  return data
}

export default loadFixture
