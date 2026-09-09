import { artifacts } from "hardhat"
import { expect } from "chai"

const BRIDGE_SOURCE = "contracts/bridge/Bridge.sol"
const BRIDGE_CONTRACT = "Bridge"
const ROUTER_SOURCE = "contracts/bridge/ReservationRouter.sol"
const ROUTER_CONTRACT = "ReservationRouter"

type StorageEntry = {
  astId: number
  contract: string
  label: string
  offset: number
  slot: string
  type: string
}

type StorageType = {
  label: string
  encoding: string
  numberOfBytes: string
  members?: StorageEntry[]
  key?: string
  value?: string
  base?: string
}

type StorageLayout = {
  storage: StorageEntry[]
  types: Record<string, StorageType>
}

// A storage entry reduced to the facts that must hold across both contracts:
// where the variable lives, how wide it is, and what it is. `astId` and
// `contract` are excluded because they identify the declaration site and
// therefore always differ between two distinct contracts. The raw `type` key
// is excluded too - see resolveEntries().
type SlotAssignment = {
  label: string
  slot: string
  offset: number
  type: string
  encoding: string
  numberOfBytes: string
}

type AstNode = {
  nodeType: string
  name?: string
  nodes?: AstNode[]
  stateVariable?: boolean
  mutability?: string
}

type BuildInfo = NonNullable<Awaited<ReturnType<typeof artifacts.getBuildInfo>>>

// Each contract's layout is read from the build-info job its own artifact
// points at. Sharing one job between both contracts looks tidier but is
// unsound: hardhat recompiles incrementally, so after a router-only edit the
// router's fresh code lands in a new job while every untouched contract still
// points at the previous one - which holds a stale copy of the router. A
// comparison sourced from a single job would then silently compare the Bridge
// against the pre-edit router and pass through exactly the drift it exists to
// catch.
async function getBuildInfo(
  sourceName: string,
  contractName: string
): Promise<BuildInfo> {
  const buildInfo = await artifacts.getBuildInfo(
    `${sourceName}:${contractName}`
  )
  if (!buildInfo) {
    throw new Error(`No build info for ${sourceName}:${contractName}`)
  }
  return buildInfo
}

function getStorageLayout(
  buildInfo: BuildInfo,
  sourceName: string,
  contractName: string
): StorageLayout {
  const contract = buildInfo.output.contracts[sourceName]?.[contractName] as
    | { storageLayout?: StorageLayout }
    | undefined
  if (!contract) {
    throw new Error(`${sourceName}:${contractName} not in its own build info`)
  }
  if (!contract.storageLayout) {
    throw new Error(`No storage layout for ${sourceName}:${contractName}`)
  }
  return contract.storageLayout
}

// Resolves each entry's type key against its own layout's type table. The keys
// themselves are not comparable across build-info jobs: solc derives them from
// AST node ids that are only unique within one compilation, so the very same
// struct appears as `t_struct(Storage)19357_storage` in one job and
// `t_struct(Storage)15676_storage` in another. The resolved description -
// fully qualified name, encoding and width - is stable and is what actually
// determines the slot a reference lands on.
function resolveEntries(
  layout: StorageLayout,
  entries: StorageEntry[]
): SlotAssignment[] {
  return entries.map((entry) => {
    const type = layout.types[entry.type]
    if (!type) {
      throw new Error(`Unknown storage type for \`${entry.label}\``)
    }
    return {
      label: entry.label,
      slot: entry.slot,
      offset: entry.offset,
      type: type.label,
      encoding: type.encoding,
      numberOfBytes: type.numberOfBytes,
    }
  })
}

function selfEntry(layout: StorageLayout): StorageEntry {
  const self = layout.storage.find((entry) => entry.label === "self")
  if (!self) {
    throw new Error("BridgeState.Storage anchor `self` not found")
  }
  return self
}

function selfMembers(layout: StorageLayout): StorageEntry[] {
  const members = layout.types[selfEntry(layout).type]?.members
  if (!members) {
    throw new Error("BridgeState.Storage members not found")
  }
  return members
}

// Names of the storage-bearing variables the contract declares itself, in
// declaration order. Constants and immutables are excluded: they live in code,
// not in storage, so they cannot shift a slot. Variables inherited from base
// contracts are excluded too - those are covered by the slot comparison, which
// sees the fully resolved layout.
function declaredStateVariables(
  buildInfo: BuildInfo,
  sourceName: string,
  contractName: string
): string[] {
  const ast = buildInfo.output.sources[sourceName]?.ast as AstNode | undefined
  if (!ast?.nodes) {
    throw new Error(`No AST for ${sourceName}`)
  }
  const contract = ast.nodes.find(
    (node) =>
      node.nodeType === "ContractDefinition" && node.name === contractName
  )
  if (!contract?.nodes) {
    throw new Error(`Contract definition ${contractName} not found`)
  }
  return contract.nodes
    .filter(
      (node) =>
        node.nodeType === "VariableDeclaration" &&
        node.stateVariable === true &&
        node.mutability === "mutable"
    )
    .map((node) => node.name as string)
}

// The Bridge routes every call carrying an unmatched selector to the router via
// `delegatecall`, so router code reads and writes Bridge storage. Any
// divergence between the layouts the two contracts resolve - a base-contract
// change on one side, a state variable added to the router - silently corrupts
// Bridge state on the first routed call. These assertions are the executable
// form of the storage-parity invariant documented in ReservationRouter.sol.
describe("Bridge and ReservationRouter storage parity", () => {
  let bridgeLayout: StorageLayout
  let routerLayout: StorageLayout
  let routerBuildInfo: BuildInfo

  before(async () => {
    const bridgeBuildInfo = await getBuildInfo(BRIDGE_SOURCE, BRIDGE_CONTRACT)
    routerBuildInfo = await getBuildInfo(ROUTER_SOURCE, ROUTER_CONTRACT)

    bridgeLayout = getStorageLayout(
      bridgeBuildInfo,
      BRIDGE_SOURCE,
      BRIDGE_CONTRACT
    )
    routerLayout = getStorageLayout(
      routerBuildInfo,
      ROUTER_SOURCE,
      ROUTER_CONTRACT
    )
  })

  it("assigns every storage variable to the same slot in both contracts", async () => {
    // Element-wise and order-sensitive: equal length rejects a variable added
    // to either side, and equal entries at equal indices reject a reorder, a
    // repacking or a type change. Deep equality rather than an upgrade-safety
    // check, because the router needs strict identity with the Bridge, not the
    // weaker "safe to append" relation an upgrade check permits.
    expect(resolveEntries(routerLayout, routerLayout.storage)).to.deep.equal(
      resolveEntries(bridgeLayout, bridgeLayout.storage)
    )
  })

  it("resolves BridgeState.Storage to the same member layout in both contracts", async () => {
    // Both contracts compile the same BridgeState.sol, so this can only
    // diverge when one of the two build-info jobs is stale. Comparing the
    // members turns that staleness into a loud failure instead of a
    // comparison quietly made against outdated slots.
    expect(
      resolveEntries(routerLayout, selfMembers(routerLayout))
    ).to.deep.equal(resolveEntries(bridgeLayout, selfMembers(bridgeLayout)))
  })

  it("declares BridgeState.Storage self as the router's only state variable", async () => {
    // Guards the router side of the invariant on its own terms: new
    // reservation state belongs in BridgeState.Storage, appended against its
    // `__gap`, never in a router-local variable.
    expect(
      declaredStateVariables(routerBuildInfo, ROUTER_SOURCE, ROUTER_CONTRACT)
    ).to.deep.equal(["self"])
  })

  it("anchors self at the same slot and offset in both contracts", async () => {
    // Redundant with the element-wise comparison today, but pinned separately
    // because `self` is the single anchor every storage reference in the
    // reservation code resolves through.
    const bridgeSelf = selfEntry(bridgeLayout)
    const routerSelf = selfEntry(routerLayout)

    expect(routerSelf.slot).to.equal(bridgeSelf.slot)
    expect(routerSelf.offset).to.equal(bridgeSelf.offset)
    expect(routerLayout.types[routerSelf.type].label).to.equal(
      bridgeLayout.types[bridgeSelf.type].label
    )
  })
})
