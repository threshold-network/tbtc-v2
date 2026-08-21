import { expect } from "chai"
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"

import bridgeTIP109HotfixDeployment from "../../deployments/mainnet/BridgeTIP109HotfixImplementation.json"
import {
  bridgeStateStorageLayout,
  getBridgeStorageLayout,
  StorageLayout,
} from "../helpers/storage-layout"

type UpgradeStorageLayout = Parameters<typeof assertStorageUpgradeSafe>[0]

describe("Bridge storage layout", () => {
  it("is upgrade-safe against the deployed TIP-109 Bridge layout", async () => {
    const deployedLayout = bridgeStateStorageLayout(
      bridgeTIP109HotfixDeployment.storageLayout as unknown as StorageLayout
    )
    const updatedLayout = bridgeStateStorageLayout(
      await getBridgeStorageLayout()
    )

    // The checked-in deployment artifact predates solc's enum-members output.
    // Allow incomplete custom-type descriptions while still validating every
    // concrete slot, packing decision, mapping, struct, and storage-gap change.
    expect(() =>
      assertStorageUpgradeSafe(
        deployedLayout as unknown as UpgradeStorageLayout,
        updatedLayout as unknown as UpgradeStorageLayout,
        true
      )
    ).not.to.throw()
  })
})
