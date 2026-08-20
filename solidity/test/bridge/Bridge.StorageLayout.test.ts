import { artifacts } from "hardhat"
import { expect } from "chai"
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"

import bridgeTIP109HotfixDeployment from "../../deployments/mainnet/BridgeTIP109HotfixImplementation.json"
import {
  bridgeStateStorageLayout,
  StorageLayout,
} from "../helpers/storage-layout"

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
