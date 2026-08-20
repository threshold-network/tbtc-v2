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
