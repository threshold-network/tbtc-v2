import { expect } from "chai"
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"
import * as fs from "fs"
import * as path from "path"

import bridgeTIP109HotfixDeployment from "../../deployments/mainnet/BridgeTIP109HotfixImplementation.json"

// Snapshot fixture capturing the cumulative BridgeState.Storage layout for this
// PR stack. This snapshot must be regenerated/updated by whichever future stack
// PR intentionally changes BridgeState.Storage's layout, and a CI failure here
// on an unrelated PR means that PR unexpectedly touched shared storage layout.
import bridgeStateStorageSnapshot from "../fixtures/BridgeState.storageLayout.snapshot.json"
import {
  getBridgeStorageLayout,
  bridgeStateEntry,
  bridgeStateLayout,
  extractBridgeStateStorageSnapshot,
  StorageLayout,
} from "../fixtures/bridgeStorageLayoutSnapshot"

type UpgradeStorageLayout = Parameters<typeof assertStorageUpgradeSafe>[0]

function readEnumMemberOrder(
  relativeContractPath: string,
  enumName: string
): string[] {
  const source = fs.readFileSync(
    path.join(__dirname, "../../contracts", relativeContractPath),
    "utf8"
  )
  const match = source.match(
    new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`)
  )
  if (!match) {
    throw new Error(`enum ${enumName} not found in ${relativeContractPath}`)
  }
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""))
}

describe("Bridge storage layout", () => {
  it("is upgrade-safe against the deployed TIP-109 Bridge layout", async () => {
    const deployedRawLayout =
      bridgeTIP109HotfixDeployment.storageLayout as unknown as StorageLayout
    const updatedRawLayout = await getBridgeStorageLayout()

    // `self`'s absolute position must not move: bridgeStateLayout() below
    // only ever compares the flattened member list, never self's own
    // slot/offset, so a future base-contract change that shifts BridgeState
    // off its deployed slot would otherwise pass every packing assertion
    // silently.
    const deployedSelf = bridgeStateEntry(deployedRawLayout)
    const updatedSelf = bridgeStateEntry(updatedRawLayout)
    expect(updatedSelf.slot).to.equal(deployedSelf.slot)
    expect(updatedSelf.offset).to.equal(deployedSelf.offset)

    const deployedLayout = bridgeStateLayout(deployedRawLayout)
    const updatedLayout = bridgeStateLayout(updatedRawLayout)

    // The deployment artifact predates the current source only in date, not
    // in enum-member support: under this project's pinned solc 0.8.17,
    // `.members` is never populated for enum types in storageLayout output -
    // verified true for both the deployed baseline and a fresh compile of
    // this PR's own unchanged WalletState/MovedFundsSweepRequestState
    // enums. Allow incomplete custom-type descriptions while still
    // validating every concrete slot, packing decision, mapping, struct,
    // and storage-gap change.
    expect(() =>
      assertStorageUpgradeSafe(
        deployedLayout as unknown as UpgradeStorageLayout,
        updatedLayout as unknown as UpgradeStorageLayout,
        true
      )
    ).not.to.throw()

    // Companion to the relaxed check above: assertStorageUpgradeSafe's
    // unsafeAllowCustomTypes skips a type comparison whenever either side's
    // `.members` is undefined - true for WalletState and
    // MovedFundsSweepRequestState on both sides under this pinned solc
    // version (see above), so the library can never actually compare their
    // member order here. Pin the two enums' current declared order,
    // re-read directly from source on every run, against an explicit
    // expected list instead: reordering, inserting, or removing a member
    // changes the integer any already-persisted storage value decodes to,
    // so a manual, version-controlled gate is the only check available
    // until a solc upgrade adds real `.members` support.
    expect(
      readEnumMemberOrder("bridge/Wallets.sol", "WalletState")
    ).to.deep.equal([
      "Unknown",
      "Live",
      "MovingFunds",
      "Closing",
      "Closed",
      "Terminated",
    ])
    expect(
      readEnumMemberOrder(
        "bridge/MovingFunds.sol",
        "MovedFundsSweepRequestState"
      )
    ).to.deep.equal(["Unknown", "Pending", "Processed", "TimedOut"])

    // This PR's own three new enums (ReservationState, ActionType,
    // ActionState) hit the exact same solc 0.8.17 blind spot: pin their
    // declared order too, for the same reason as WalletState and
    // MovedFundsSweepRequestState above.
    expect(
      readEnumMemberOrder("bridge/Reservation.sol", "ReservationState")
    ).to.deep.equal([
      "Unknown",
      "Active",
      "ActionPending",
      "Closed",
      "Stranded",
    ])
    expect(
      readEnumMemberOrder("bridge/Reservation.sol", "ActionType")
    ).to.deep.equal([
      "None",
      "Acceptance",
      "Redemption",
      "Reanchor",
      "Dissolution",
    ])
    expect(
      readEnumMemberOrder("bridge/Reservation.sol", "ActionState")
    ).to.deep.equal([
      "Unknown",
      "Pending",
      "Settled",
      "TimedOut",
      "Vetoed",
      "Superseded",
    ])
  })

  it("fails when storage layout is broken", async () => {
    const deployedLayout = bridgeStateLayout(
      bridgeTIP109HotfixDeployment.storageLayout as unknown as StorageLayout
    )
    const updatedLayout = bridgeStateLayout(await getBridgeStorageLayout())

    // Mutate a deep clone to ensure the original updatedLayout is untouched
    const mutatedLayout = JSON.parse(
      JSON.stringify(updatedLayout)
    ) as StorageLayout

    // Find a concrete type to break by shrinking its numberOfBytes
    const typeKey = Object.keys(mutatedLayout.types).find(
      (k) => mutatedLayout.types[k].encoding === "inplace"
    )
    if (!typeKey) {
      throw new Error("No suitable concrete type found to mutate")
    }

    mutatedLayout.types[typeKey].numberOfBytes = (
      parseInt(mutatedLayout.types[typeKey].numberOfBytes, 10) - 1
    ).toString()

    expect(() =>
      assertStorageUpgradeSafe(
        deployedLayout as unknown as UpgradeStorageLayout,
        mutatedLayout as unknown as UpgradeStorageLayout,
        true
      )
    ).to.throw()
  })

  // Snapshot tripwire for BridgeState.Storage:
  // Deployed upgrade checks (assertStorageUpgradeSafe against TIP-109) only check
  // delta against the single deployed TIP-109 artifact, not the cumulative
  // merged state of the full multi-PR stack. This test asserts the actual,
  // compiled BridgeState.Storage layout matches the checked-in snapshot.
  //
  // NOTE: This snapshot must be regenerated/updated by whichever future stack PR
  // intentionally changes BridgeState.Storage's layout. A CI failure here on an
  // unrelated PR means that PR unexpectedly touched shared storage layout.
  it("matches the checked-in BridgeState.Storage snapshot layout", async () => {
    const rawLayout = await getBridgeStorageLayout()
    const currentSnapshot = extractBridgeStateStorageSnapshot(rawLayout)

    expect(currentSnapshot.self).to.deep.equal(
      bridgeStateStorageSnapshot.self,
      "BridgeState 'self' slot/offset/type has changed. Run 'yarn update-storage-layout-snapshot' (from solidity/) to regenerate after an intentional layout change."
    )

    expect(currentSnapshot.members).to.deep.equal(
      bridgeStateStorageSnapshot.members,
      "BridgeState.Storage members layout (labels, slots, offsets, types) has changed. Run 'yarn update-storage-layout-snapshot' (from solidity/) to regenerate after an intentional layout change."
    )

    expect(currentSnapshot.structMembers).to.deep.equal(
      bridgeStateStorageSnapshot.structMembers,
      "BridgeState.Storage struct members layout (labels, slots, offsets, types) has changed. Run 'yarn update-storage-layout-snapshot' (from solidity/) to regenerate after an intentional layout change."
    )
  })
})
