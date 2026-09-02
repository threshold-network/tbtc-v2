/* eslint-disable no-console */
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"
import * as fs from "fs"
import * as path from "path"

import {
  getBridgeStorageLayout,
  extractBridgeStateStorageSnapshot,
  BridgeStateStorageSnapshot,
  StorageLayout,
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
  if (typeStr.startsWith("contract ")) {
    const name = typeStr.slice("contract ".length).trim()
    return `t_contract(${name})`
  }
  if (typeStr.startsWith("struct ")) {
    const name = typeStr.slice("struct ".length).trim()
    return `t_struct(${name})`
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
  const arrayMatch = typeStr.match(/^(.*)\[(\d*)\]$/)
  if (arrayMatch) {
    const base = arrayMatch[1].trim()
    const len = arrayMatch[2]
    return `t_array(${toTypeId(base)})${len || "dyn"}_storage`
  }
  return `t_${typeStr}`
}

/**
 * Wraps snapshot members as a minimal `{ storage, types }` layout object
 * expected by OpenZeppelin's assertStorageUpgradeSafe.
 */
function snapshotToLayout(snapshot: BridgeStateStorageSnapshot): StorageLayout {
  const types: StorageLayout["types"] = {}
  const storage = snapshot.members.map((m) => {
    const typeId = toTypeId(m.type)
    types[typeId] = {
      label: m.type,
      numberOfBytes: m.numberOfBytes || "32",
      encoding: "inplace",
    }
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
  // eslint-disable-next-line no-underscore-dangle
  currentSnapshot._comment = SNAPSHOT_COMMENT

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

  fs.writeFileSync(
    SNAPSHOT_PATH,
    `${JSON.stringify(currentSnapshot, null, 2)}\n`
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
