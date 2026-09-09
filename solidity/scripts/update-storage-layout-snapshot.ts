/* eslint-disable no-console */
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"
import * as fs from "fs"
import * as path from "path"

import bridgeTIP109HotfixDeployment from "../deployments/mainnet/BridgeTIP109HotfixImplementation.json"

import {
  getBridgeStorageLayout,
  bridgeStateEntry,
  bridgeStateLayout,
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

async function main(): Promise<void> {
  console.log(
    "Extracting current BridgeState.Storage layout from compiled artifacts..."
  )
  const rawLayout = await getBridgeStorageLayout()
  const currentSnapshot = extractBridgeStateStorageSnapshot(rawLayout)

  console.log(
    "Validating upgrade safety against the deployed TIP-109 Bridge layout..."
  )
  const deployedRawLayout =
    bridgeTIP109HotfixDeployment.storageLayout as unknown as StorageLayout

  // `self`'s absolute position must not move: bridgeStateLayout() below only
  // ever compares the flattened member list, never self's own slot/offset, so
  // a base-contract change that shifts BridgeState off its deployed slot
  // would otherwise pass every packing assertion silently. Mirrors the same
  // check in Bridge.StorageLayout.test.ts.
  const deployedSelf = bridgeStateEntry(deployedRawLayout)
  const updatedSelf = bridgeStateEntry(rawLayout)
  if (
    updatedSelf.slot !== deployedSelf.slot ||
    updatedSelf.offset !== deployedSelf.offset
  ) {
    throw new Error(
      `BridgeState 'self' position changed from slot ${deployedSelf.slot}, offset ${deployedSelf.offset} to slot ${updatedSelf.slot}, offset ${updatedSelf.offset}`
    )
  }

  const deployedLayout = bridgeStateLayout(deployedRawLayout)
  const updatedLayout = bridgeStateLayout(rawLayout)

  // unsafeAllowCustomTypes is required here because, under this project's
  // pinned solc 0.8.17, `.members` is never populated for enum types in
  // storageLayout output - see Bridge.StorageLayout.test.ts for the full
  // rationale and the companion enum-member-order pins that cover the gap
  // this leaves.
  assertStorageUpgradeSafe(
    deployedLayout as unknown as UpgradeStorageLayout,
    updatedLayout as unknown as UpgradeStorageLayout,
    true
  )
  console.log("Upgrade safety check passed.")

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
