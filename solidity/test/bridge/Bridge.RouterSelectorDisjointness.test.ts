import { artifacts, ethers } from "hardhat"
import { expect } from "chai"

const BRIDGE_CONTRACT = "Bridge"
const ROUTER_CONTRACT = "ReservationRouter"

// Maps every external/public function's 4-byte selector to its signature.
// The ABI hardhat compiles into each artifact only ever lists public and
// external members, so no internal/private filtering is needed here.
async function selectorsByContract(
  contractName: string
): Promise<Map<string, string>> {
  const artifact = await artifacts.readArtifact(contractName)
  const iface = new ethers.utils.Interface(artifact.abi)

  const bySelector = new Map<string, string>()
  Object.keys(iface.functions).forEach((signature) => {
    bySelector.set(iface.getSighash(signature), signature)
  })
  return bySelector
}

// The Bridge's fallback() delegatecalls any selector it does not itself
// implement to the ReservationRouter. If a future Bridge function were ever
// added sharing a 4-byte selector with an existing router function, the
// Bridge's own dispatch would match first and the router function would
// become silently unreachable - no revert, no signal, just dead code behind
// a live selector. This test is the executable form of the selector-
// disjointness invariant documented on both Bridge.sol and
// ReservationRouter.sol.
//
// Both contracts directly inherit `Governable`, so `governance()` and
// `transferGovernance(address)` are present, with identical selectors, in
// both ABIs. That overlap is not the kind of accidental collision this test
// guards against: the router only inherits `Governable` (alongside
// `Initializable`) to mirror the Bridge's storage layout so `self` lands at
// the same slot in both contracts (see "Mirror of the Bridge's storage
// anchor" in ReservationRouter.sol, invariant 1). The router's own copies of
// these two functions are never reached through the Bridge - the Bridge
// answers its own inherited `governance()`/`transferGovernance()` before the
// fallback ever runs - and calling them directly on the router's own address
// is inert by invariant 3 (NO STANDALONE AUTHORITY): the router's own
// `governance` storage is never initialized, so every call reverts. They are
// excluded here by name so any other, unexpected collision still fails loud.
const SHARED_BASE_SELECTORS: Record<string, true> = {
  "governance()": true,
  "transferGovernance(address)": true,
}

describe("Bridge and ReservationRouter selector disjointness", () => {
  it("shares no 4-byte function selector between Bridge and ReservationRouter", async () => {
    const bridgeSelectors = await selectorsByContract(BRIDGE_CONTRACT)
    const routerSelectors = await selectorsByContract(ROUTER_CONTRACT)

    const collisions = [...bridgeSelectors.entries()]
      .filter(
        ([selector, signature]) =>
          !(signature in SHARED_BASE_SELECTORS) && routerSelectors.has(selector)
      )
      .map(
        ([selector, signature]) =>
          `${selector}: Bridge.${signature} vs ReservationRouter.${routerSelectors.get(
            selector
          )}`
      )

    expect(collisions, collisions.join("\n")).to.deep.equal([])
  })
})
