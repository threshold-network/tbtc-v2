import { artifacts } from "hardhat"
import { expect } from "chai"
import { assertStorageUpgradeSafe } from "@openzeppelin/upgrades-core"
import * as fs from "fs"
import * as path from "path"

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
  })
})
