/* eslint-disable no-console */
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"
import * as fs from "fs"
import * as path from "path"

import {
  getBridgeStorageLayout,
  extractBridgeStateStorageSnapshot,
  BridgeStateStorageSnapshot,
  StorageLayout,
  StorageMember,
} from "../test/fixtures/bridgeStorageLayoutSnapshot"

type UpgradeStorageLayout = Parameters<typeof assertStorageUpgradeSafe>[0]

const SNAPSHOT_PATH = path.resolve(
  __dirname,
  "../test/fixtures/BridgeState.storageLayout.snapshot.json"
)

const SNAPSHOT_COMMENT =
  "Snapshot of BridgeState.Storage layout for Bridge.sol. This snapshot must be regenerated/updated by whichever future stack PR intentionally changes BridgeState.Storage layout, and a CI failure here on an unrelated PR means that PR unexpectedly touched shared storage layout."

/**
 * Converts a human-readable snapshot type string (e.g. "contract Bank",
 * "uint64", "mapping(uint256 => struct Deposit.DepositRequest)") to a
 * solc-compatible type identifier (e.g. "t_contract(Bank)", "t_uint64",
 * "t_mapping(t_uint256,t_struct(Deposit.DepositRequest))") suitable for
 * consumption by OpenZeppelin's assertStorageUpgradeSafe parser.
 */
function toTypeId(typeStr: string): string {
  if (!typeStr) return "t_unknown"
  const arrayMatch = typeStr.match(/^(.*)\[(\d*)\]$/)
  if (arrayMatch) {
    const base = arrayMatch[1].trim()
    const len = arrayMatch[2]
    return `t_array(${toTypeId(base)})${len || "dyn"}_storage`
  }
  if (typeStr.startsWith("contract ")) {
    const name = typeStr.slice("contract ".length).trim()
    return `t_contract(${name})`
  }
  if (typeStr.startsWith("struct ")) {
    const name = typeStr.slice("struct ".length).trim()
    return `t_struct(${name})`
  }
  if (typeStr.startsWith("enum ")) {
    const name = typeStr.slice("enum ".length).trim()
    return `t_enum(${name})`
  }
  if (typeStr.startsWith("mapping(") && typeStr.endsWith(")")) {
    const inner = typeStr.slice("mapping(".length, -1)
    const arrowIdx = inner.indexOf("=>")
    if (arrowIdx !== -1) {
      const keyStr = inner.slice(0, arrowIdx).trim()
      const valStr = inner.slice(arrowIdx + 2).trim()
      return `t_mapping(${toTypeId(keyStr)},${toTypeId(valStr)})`
    }
  }
  return `t_${typeStr}`
}

/**
 * Recursively registers a type and any nested types (mapping keys/values, array
 * base types, struct members) into the types map expected by
 * assertStorageUpgradeSafe.
 */
function registerType(
  types: StorageLayout["types"],
  setType: (id: string, entry: StorageLayout["types"][string]) => void,
  structMembersMap: Record<string, StorageMember[]>,
  typeStr: string,
  numberOfBytes?: string
): string {
  const typeId = toTypeId(typeStr)
  if (!typeStr) return typeId

  // Array handling
  const arrayMatch = typeStr.match(/^(.*)\[(\d*)\]$/)
  if (arrayMatch) {
    const baseStr = arrayMatch[1].trim()
    const len = arrayMatch[2]
    const baseTypeId = registerType(types, setType, structMembersMap, baseStr)
    setType(typeId, {
      label: typeStr,
      numberOfBytes:
        numberOfBytes || (len ? String(parseInt(len, 10) * 32) : "32"),
      encoding: len ? "inplace" : "dynamic_array",
      base: baseTypeId,
    })
    return typeId
  }

  // Mapping handling
  if (typeStr.startsWith("mapping(") && typeStr.endsWith(")")) {
    const inner = typeStr.slice("mapping(".length, -1)
    const arrowIdx = inner.indexOf("=>")
    if (arrowIdx !== -1) {
      const keyStr = inner.slice(0, arrowIdx).trim()
      const valStr = inner.slice(arrowIdx + 2).trim()
      const keyTypeId = registerType(types, setType, structMembersMap, keyStr)
      const valTypeId = registerType(types, setType, structMembersMap, valStr)
      setType(typeId, {
        label: typeStr,
        numberOfBytes: numberOfBytes || "32",
        encoding: "mapping",
        key: keyTypeId,
        value: valTypeId,
      })
      return typeId
    }
  }

  // Struct handling
  if (typeStr.startsWith("struct ")) {
    const name = typeStr.slice("struct ".length).trim()
    const matchingKey = Object.keys(structMembersMap).find(
      (k) => k === name || name.endsWith(`.${k}`) || k.endsWith(`.${name}`)
    )
    if (matchingKey && structMembersMap[matchingKey]) {
      const sMembers = structMembersMap[matchingKey]
      const maxSlot =
        sMembers.length > 0
          ? Math.max(...sMembers.map((m) => parseInt(m.slot, 10) || 0))
          : 0
      const structBytes = numberOfBytes || String((maxSlot + 1) * 32)
      const members = sMembers.map((sm) => {
        const smTypeId = registerType(
          types,
          setType,
          structMembersMap,
          sm.type,
          sm.numberOfBytes
        )
        return {
          label: sm.label,
          slot: sm.slot,
          offset: sm.offset,
          type: smTypeId,
        }
      })
      setType(typeId, {
        label: typeStr,
        numberOfBytes: structBytes,
        encoding: "inplace",
        members,
      })
      const shortTypeId = `t_struct(${matchingKey})`
      if (!types[shortTypeId]) {
        setType(shortTypeId, {
          label: `struct ${matchingKey}`,
          numberOfBytes: structBytes,
          encoding: "inplace",
          members,
        })
      }
      return typeId
    }
  }

  // Default / Contract / Enum / Primitive type
  if (!types[typeId] || (numberOfBytes && !types[typeId].numberOfBytes)) {
    setType(typeId, {
      label: typeStr,
      numberOfBytes: numberOfBytes || "32",
      encoding: "inplace",
    })
  }

  return typeId
}

/**
 * Wraps snapshot members as a `{ storage, types }` layout object expected
 * by OpenZeppelin's assertStorageUpgradeSafe, fully registering struct members
 * and mapping value types so internal struct changes can be validated.
 */
function snapshotToLayout(snapshot: BridgeStateStorageSnapshot): StorageLayout {
  const types: StorageLayout["types"] = {}
  const setType = (id: string, entry: StorageLayout["types"][string]) => {
    types[id] = entry
  }
  const structMembersMap = snapshot.structMembers || {}

  Object.keys(structMembersMap).forEach((structName) => {
    registerType(types, setType, structMembersMap, `struct ${structName}`)
  })

  const storage = snapshot.members.map((m) => {
    const typeId = registerType(
      types,
      setType,
      structMembersMap,
      m.type,
      m.numberOfBytes
    )
    return {
      label: m.label,
      slot: m.slot,
      offset: m.offset,
      type: typeId,
    }
  })
  return { storage, types }
}

async function main(): Promise<void> {
  console.log(
    "Extracting current BridgeState.Storage layout from compiled artifacts..."
  )
  const rawLayout = await getBridgeStorageLayout()
  const currentSnapshot = extractBridgeStateStorageSnapshot(rawLayout)

  if (fs.existsSync(SNAPSHOT_PATH)) {
    console.log("Found existing snapshot fixture. Validating upgrade safety...")
    const oldSnapshot: BridgeStateStorageSnapshot = JSON.parse(
      fs.readFileSync(SNAPSHOT_PATH, "utf8")
    )

    // Check that `self`'s slot and offset have not changed
    if (
      currentSnapshot.self.slot !== oldSnapshot.self.slot ||
      currentSnapshot.self.offset !== oldSnapshot.self.offset
    ) {
      throw new Error(
        `BridgeState 'self' position changed from slot ${oldSnapshot.self.slot}, offset ${oldSnapshot.self.offset} to slot ${currentSnapshot.self.slot}, offset ${currentSnapshot.self.offset}`
      )
    }

    const oldLayout = snapshotToLayout(oldSnapshot)
    const newLayout = snapshotToLayout(currentSnapshot)

    assertStorageUpgradeSafe(
      oldLayout as unknown as UpgradeStorageLayout,
      newLayout as unknown as UpgradeStorageLayout,
      true
    )
    console.log("Upgrade safety check passed.")
  } else {
    console.log(
      "No existing snapshot fixture found. Generating fresh snapshot..."
    )
  }

  // Key order matches the checked-in fixture (`_comment` first) so re-running
  // this script never produces a spurious key-reordering diff when nothing
  // about the layout actually changed.
  const snapshotToWrite: BridgeStateStorageSnapshot = {
    _comment: SNAPSHOT_COMMENT,
    self: currentSnapshot.self,
    members: currentSnapshot.members,
    structMembers: currentSnapshot.structMembers,
  }
  fs.writeFileSync(
    SNAPSHOT_PATH,
    `${JSON.stringify(snapshotToWrite, null, 2)}\n`
  )
  console.log(
    `Successfully updated BridgeState storage layout snapshot at ${SNAPSHOT_PATH}`
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      "Storage layout snapshot update failed:",
      error.message || error
    )
    process.exit(1)
  })
