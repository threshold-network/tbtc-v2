import { artifacts } from "hardhat"
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

type StorageEntry = {
  label: string
  offset: number
  slot: string
  type: string
}

type StorageLayout = {
  storage: StorageEntry[]
  types: Record<
    string,
    {
      label: string
      encoding: string
      numberOfBytes: string
      members?: StorageEntry[]
      key?: string
      value?: string
      base?: string
    }
  >
}

type UpgradeStorageLayout = Parameters<typeof assertStorageUpgradeSafe>[0]

async function getBridgeStorageLayout(): Promise<StorageLayout> {
  const sourceName = "contracts/bridge/Bridge.sol"
  const contractName = "Bridge"
  // Bridge is compiled in multiple optimizer jobs and its final artifact can
  // point at a job without storageLayout output. BridgeState's artifact points
  // at the validation-enabled job that also contains the compiled Bridge.
  const buildInfo = await artifacts.getBuildInfo(
    "contracts/bridge/BridgeState.sol:BridgeState"
  )
  if (!buildInfo) {
    throw new Error(`No build info for ${sourceName}:${contractName}`)
  }

  const layout = (
    buildInfo.output.contracts[sourceName][contractName] as {
      storageLayout?: StorageLayout
    }
  ).storageLayout
  if (!layout) {
    throw new Error(`No storage layout for ${sourceName}:${contractName}`)
  }

  return layout
}

function bridgeStateEntry(layout: StorageLayout): StorageEntry {
  const bridgeState = layout.storage.find((entry) => entry.label === "self")
  if (!bridgeState) {
    throw new Error("BridgeState.Storage entry not found")
  }
  return bridgeState
}

function bridgeStateLayout(layout: StorageLayout): StorageLayout {
  const bridgeState = bridgeStateEntry(layout)

  const bridgeStateType = layout.types[bridgeState.type]
  if (!bridgeStateType?.members) {
    throw new Error("BridgeState.Storage members not found")
  }

  // Bridge stores its state in one library struct. Flatten that struct for
  // OpenZeppelin 1.x so its normal gap-consumption algorithm validates the
  // real member slots; that release rejects every nested-struct append before
  // applying the nested struct's own __gap semantics.
  return {
    storage: bridgeStateType.members,
    types: layout.types,
  }
}

type StorageMember = {
  label: string
  slot: string
  offset: number
  type: string
  numberOfBytes?: string
}

type BridgeStateStorageSnapshot = {
  _comment?: string
  self: {
    slot: string
    offset: number
    type: string
  }
  members: StorageMember[]
  structMembers: Record<string, StorageMember[]>
}

function extractStructMembersFromMapping(
  layout: StorageLayout,
  selfMembers: StorageEntry[],
  mappingLabel: string
): StorageMember[] {
  const mappingMember = selfMembers.find((m) => m.label === mappingLabel)
  if (!mappingMember) {
    throw new Error(`BridgeState.Storage member '${mappingLabel}' not found`)
  }
  const mappingType = layout.types[mappingMember.type]
  if (!mappingType?.value) {
    throw new Error(
      `Mapping value type for member '${mappingLabel}' not found in layout.types`
    )
  }
  const structType = layout.types[mappingType.value]
  if (!structType?.members) {
    throw new Error(
      `Struct members for mapping '${mappingLabel}' (${mappingType.value}) not found in layout.types`
    )
  }

  return structType.members.map((m) => {
    const typeInfo = layout.types[m.type]
    return {
      label: m.label,
      slot: m.slot,
      offset: m.offset,
      type: typeInfo ? typeInfo.label : m.type,
      numberOfBytes: typeInfo ? typeInfo.numberOfBytes : undefined,
    }
  })
}

function extractBridgeStateStorageSnapshot(
  layout: StorageLayout
): BridgeStateStorageSnapshot {
  const self = bridgeStateEntry(layout)
  const selfType = layout.types[self.type]
  if (!selfType?.members) {
    throw new Error("BridgeState.Storage members not found")
  }

  return {
    self: {
      slot: self.slot,
      offset: self.offset,
      type: selfType.label || self.type,
    },
    members: selfType.members.map((m) => {
      const typeInfo = layout.types[m.type]
      return {
        label: m.label,
        slot: m.slot,
        offset: m.offset,
        type: typeInfo ? typeInfo.label : m.type,
        numberOfBytes: typeInfo ? typeInfo.numberOfBytes : undefined,
      }
    }),
    structMembers: {
      PendingReservedDeposit: extractStructMembersFromMapping(
        layout,
        selfType.members,
        "pendingReservedDeposit"
      ),
      ReservationRequest: extractStructMembersFromMapping(
        layout,
        selfType.members,
        "reservations"
      ),
      ReservationAction: extractStructMembersFromMapping(
        layout,
        selfType.members,
        "reservationActions"
      ),
    },
  }
}

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
      "BridgeState 'self' slot/offset/type has changed"
    )

    expect(currentSnapshot.members).to.deep.equal(
      bridgeStateStorageSnapshot.members,
      "BridgeState.Storage members layout (labels, slots, offsets, types) has changed"
    )

    expect(currentSnapshot.structMembers).to.deep.equal(
      bridgeStateStorageSnapshot.structMembers,
      "BridgeState.Storage struct members layout (labels, slots, offsets, types) has changed"
    )
  })
})
