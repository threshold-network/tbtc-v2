import { artifacts } from "hardhat"

/**
 * Storage layout entry as reported by solc's `storageLayout` output.
 */
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

/**
 * Reads solc's `storageLayout` output for a contract from its build info.
 */
export async function getStorageLayout(
  sourceName: string,
  contractName: string
): Promise<StorageLayout> {
  const buildInfo = await artifacts.getBuildInfo(
    `${sourceName}:${contractName}`
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

/**
 * Produces a compilation-independent canonical description of a storage
 * type: solc type identifiers embed AST ids (e.g.
 * `t_struct(Storage)12345_storage`) that differ between compilation units,
 * so the identifiers are normalized and struct members are expanded
 * recursively.
 */
export function canonicalType(
  typeId: string,
  types: StorageLayout["types"],
  seen: Set<string> = new Set()
): unknown {
  const normalized = typeId.replace(/\)\d+/g, ")")
  if (seen.has(typeId)) {
    return normalized
  }
  seen.add(typeId)

  const type = types[typeId]
  if (!type) {
    return normalized
  }

  const result: Record<string, unknown> = {
    id: normalized,
    encoding: type.encoding,
    numberOfBytes: type.numberOfBytes,
  }
  if (type.members) {
    result.members = type.members.map((member) => ({
      label: member.label,
      slot: member.slot,
      offset: member.offset,
      type: canonicalType(member.type, types, seen),
    }))
  }
  if (type.key) {
    result.key = canonicalType(type.key, types, seen)
  }
  if (type.value) {
    result.value = canonicalType(type.value, types, seen)
  }
  if (type.base) {
    result.base = canonicalType(type.base, types, seen)
  }
  return result
}

/**
 * Canonicalizes a full storage layout for cross-compilation-unit
 * comparison (see `canonicalType`).
 */
export function canonicalLayout(layout: StorageLayout): unknown {
  return layout.storage.map((entry) => ({
    label: entry.label,
    slot: entry.slot,
    offset: entry.offset,
    type: canonicalType(entry.type, layout.types),
  }))
}

/**
 * Reads the Bridge's storage layout via the `BridgeState` anchor. Bridge is
 * compiled in multiple optimizer jobs and its own build-info artifact can
 * point at a job without `storageLayout` output (the compiler-override
 * config for `BridgeGovernance.sol`, which imports `Bridge.sol`, has no
 * matching outputSelection) -- but `BridgeState`'s artifact points at the
 * validation-enabled job that also contains the compiled Bridge. Every test
 * that needs the Bridge-side layout must use this rather than
 * `getStorageLayout("contracts/bridge/Bridge.sol", "Bridge")`.
 */
export async function getBridgeStorageLayout(): Promise<StorageLayout> {
  const sourceName = "contracts/bridge/Bridge.sol"
  const contractName = "Bridge"
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

/**
 * Flattens the single `BridgeState.Storage self` struct entry into its
 * member list, so OpenZeppelin 1.x's `assertStorageUpgradeSafe` -- which
 * validates a flat top-level variable list, not one opaque struct-typed
 * slot -- checks the real Bridge/BridgeState member slots, packing,
 * mappings, structs, and `__gap` changes. Every contract that anchors its
 * storage through `BridgeState.Storage self` (`Bridge`, `BridgeStub`,
 * `ReservationRouter`) shares this shape.
 */
export function bridgeStateStorageLayout(layout: StorageLayout): StorageLayout {
  const bridgeState = layout.storage.find((entry) => entry.label === "self")
  if (!bridgeState) {
    throw new Error("BridgeState.Storage entry not found")
  }

  const bridgeStateType = layout.types[bridgeState.type]
  if (!bridgeStateType?.members) {
    throw new Error("BridgeState.Storage members not found")
  }

  return {
    storage: bridgeStateType.members,
    types: layout.types,
  }
}
