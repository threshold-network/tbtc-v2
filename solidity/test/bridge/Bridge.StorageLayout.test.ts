import { artifacts } from "hardhat"
import { expect } from "chai"
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"

import bridgeTIP109HotfixDeployment from "../../deployments/mainnet/BridgeTIP109HotfixImplementation.json"

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

function bridgeStateLayout(layout: StorageLayout): StorageLayout {
  const bridgeState = layout.storage.find((entry) => entry.label === "self")
  if (!bridgeState) {
    throw new Error("BridgeState.Storage entry not found")
  }

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

describe("Bridge storage layout", () => {
  it("is upgrade-safe against the deployed TIP-109 Bridge layout", async () => {
    const deployedLayout = bridgeStateLayout(
      bridgeTIP109HotfixDeployment.storageLayout as unknown as StorageLayout
    )
    const updatedLayout = bridgeStateLayout(await getBridgeStorageLayout())

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
