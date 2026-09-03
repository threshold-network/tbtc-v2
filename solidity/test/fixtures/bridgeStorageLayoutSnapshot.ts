import { artifacts } from "hardhat"

export type StorageEntry = {
  label: string
  offset: number
  slot: string
  type: string
}

export type StorageLayout = {
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

export async function getBridgeStorageLayout(): Promise<StorageLayout> {
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

export function bridgeStateEntry(layout: StorageLayout): StorageEntry {
  const bridgeState = layout.storage.find((entry) => entry.label === "self")
  if (!bridgeState) {
    throw new Error("BridgeState.Storage entry not found")
  }
  return bridgeState
}

export function bridgeStateLayout(layout: StorageLayout): StorageLayout {
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

export type StorageMember = {
  label: string
  slot: string
  offset: number
  type: string
  numberOfBytes?: string
}

export type BridgeStateStorageSnapshot = {
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

export function extractBridgeStateStorageSnapshot(
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
    // NOTE: Adding a new struct-valued member to BridgeState.Storage requires
    // adding it to this `structMembers` mapping by hand, since it is not derived
    // programmatically from `selfType.members`. The independent
    // `assertStorageUpgradeSafe`-against-deployed-baseline check in the test file
    // remains a backstop for such an omission, but this snapshot's own
    // struct-member coverage would silently miss it otherwise.
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
