import { artifacts, run } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"

// Storage-layout invariant test.
//
// This test reads the compiled Bridge.sol artifact's `storageLayout`
// section (emitted by solc when `outputSelection` includes
// "storageLayout" -- see hardhat.config.ts) and compares it against
// a pinned snapshot file.
//
// On first run -- when the snapshot file does not yet exist -- the
// test creates it from the current layout and PASSES with a console
// warning so CI does not block on bootstrap. The developer is
// expected to inspect and commit the generated snapshot. On every
// subsequent run, the test FAILS on any drift -- which is the
// intended failure mode: silent slot shifts in BridgeState.Storage
// would corrupt every existing wallet entry after an upgrade, and
// this test is the tripwire that catches the mistake before it
// ships.
//
// Acceptable change workflow:
//
//   1. Make the storage layout change (add a new field at the end of
//      BridgeState.Storage, decrement __gap, etc.).
//   2. Run the test -- it will fail with a diff.
//   3. Inspect the diff. If the change is intentional and
//      upgrade-safe (new fields appended after existing ones, __gap
//      decremented accordingly, no existing field's slot/offset
//      shifted), delete the snapshot file.
//   4. Re-run the test -- it bootstraps the new snapshot.
//   5. Commit the updated snapshot together with the layout change.
//
// Not-acceptable mistakes the test catches:
//
//   * Inserting a new field in the middle of the struct (shifts
//     subsequent fields' slots -- breaks every existing wallet
//     entry).
//   * Changing an existing field's type to a different storage size.
//   * Reordering existing fields.
//   * Forgetting to decrement __gap after adding a field (the gap
//     fills the would-be-shifted slots; without decrementing, the
//     next upgrade silently corrupts).

const BRIDGE_FQN = "contracts/bridge/Bridge.sol:Bridge"
const SNAPSHOT_PATH = path.resolve(__dirname, "Bridge.storage-layout.json")

interface StorageEntry {
  astId: number
  contract: string
  label: string
  offset: number
  slot: string
  type: string
}

interface StorageTypeMember {
  astId?: number
  contract?: string
  label: string
  offset: number
  slot: string
  type: string
}

interface StorageType {
  encoding: string
  label: string
  numberOfBytes: string
  base?: string
  key?: string
  value?: string
  members?: StorageTypeMember[]
}

interface StorageLayout {
  storage: StorageEntry[]
  types: Record<string, StorageType>
}

describe("Bridge storage layout invariant", () => {
  // Resolve the Bridge storage layout via Hardhat's build-info API
  // rather than a hard-coded artifact path. The formal-invariants
  // test runner sets TEST_USE_STUBS_TBTC=true, which causes some
  // test fixtures to compile alternate stubs; relying on a path
  // means the layout test fails depending on which stub set is
  // active. The build-info API resolves the same way regardless.
  let layout: StorageLayout

  before(async () => {
    // Ensure contracts are compiled in the current run. Hardhat
    // normally runs `compile` before `test`, but the formal-invariants
    // task can be invoked with `--no-compile`; explicit compile keeps
    // the test self-sufficient.
    await run("compile", { quiet: true })

    const buildInfo = await artifacts.getBuildInfo(BRIDGE_FQN)
    if (!buildInfo) {
      throw new Error(
        `Build info for ${BRIDGE_FQN} not found. The contract must ` +
          "be compiled with outputSelection including 'storageLayout' " +
          "(configured in hardhat.config.ts)."
      )
    }
    const contractOutput = buildInfo.output.contracts[
      "contracts/bridge/Bridge.sol"
    ]?.Bridge as { storageLayout?: StorageLayout } | undefined
    if (!contractOutput?.storageLayout) {
      throw new Error(
        "Bridge contract output missing storageLayout. Ensure " +
          "hardhat.config.ts has outputSelection including " +
          "'storageLayout' for the 0.8.17 compiler."
      )
    }
    layout = contractOutput.storageLayout
  })

  it("matches the pinned snapshot", () => {
    // Restrict the snapshotted layout to the storage-relevant subset.
    // We drop ast IDs and contract source paths because they change
    // when unrelated files are added/removed; the load-bearing
    // invariant is the slot/offset/type for each labeled field, plus
    // the type definitions.
    const layoutForSnapshot = canonicalizeLayout(layout)

    if (!fs.existsSync(SNAPSHOT_PATH)) {
      // The bootstrap branch -- "create the snapshot if it doesn't
      // exist and pass" -- previously ran on every fresh checkout in
      // CI, which made this test a no-op: it would write a
      // throwaway snapshot and pass even though no validation
      // happened. To make CI actually enforce the invariant, the
      // snapshot is committed to the repo and a missing snapshot in
      // CI is a hard failure.
      //
      // Local bootstrap (legitimate first-time generation or
      // intentional layout-change refresh) is still possible: set
      // `BRIDGE_STORAGE_LAYOUT_BOOTSTRAP=1` and the test will create
      // the snapshot and pass, with a console warning. The env var
      // is intentionally not set in CI, so missing-snapshot-in-CI
      // remains a hard failure.
      if (process.env.BRIDGE_STORAGE_LAYOUT_BOOTSTRAP === "1") {
        fs.writeFileSync(
          SNAPSHOT_PATH,
          `${JSON.stringify(layoutForSnapshot, null, 2)}\n`,
          "utf8"
        )
        // eslint-disable-next-line no-console
        console.warn(
          `\n[bootstrap] Bridge storage-layout snapshot created at ${SNAPSHOT_PATH}.\n` +
            "Inspect the file and commit it. Subsequent test runs will " +
            "compare against this snapshot and fail on any drift.\n"
        )
        return
      }
      throw new Error(
        [
          `Bridge storage-layout snapshot missing at ${SNAPSHOT_PATH}.`,
          "If you are intentionally regenerating the snapshot",
          "(layout change is upgrade-safe and reviewed), run the test",
          "locally with BRIDGE_STORAGE_LAYOUT_BOOTSTRAP=1, then commit",
          "the generated snapshot. CI never runs with that env var",
          "set, so the snapshot must be checked into source control.",
        ].join(" ")
      )
    }

    const snapshot = JSON.parse(
      fs.readFileSync(SNAPSHOT_PATH, "utf8")
    ) as ReturnType<typeof canonicalizeLayout>

    expect(layoutForSnapshot).to.deep.equal(
      snapshot,
      [
        "Bridge storage layout drifted from the pinned snapshot.",
        "If the change is intentional and upgrade-safe (new fields ",
        "appended at the END of BridgeState.Storage, __gap decremented ",
        "accordingly, no existing field's slot/offset shifted), ",
        "re-run the test with BRIDGE_STORAGE_LAYOUT_BOOTSTRAP=1 to " +
          "regenerate the snapshot, then commit it.",
        "",
        "If the change is NOT intentional (e.g. you inserted a field in ",
        "the middle of the struct, or forgot to decrement __gap), the ",
        "test failure has caught a real upgrade-safety regression.",
      ].join(" ")
    )
  })

  it("declares __gap of the expected explicit size", () => {
    // Independent of the snapshot diff above, hold the line on the
    // OpenZeppelin upgrade-safety convention: BridgeState.Storage
    // should have a `__gap[N]` reserved-slot array as its LAST
    // member. The combined "explicit fields + __gap" length must
    // sum to a stable target (50 per the convention used throughout
    // the codebase) so that future field additions require an
    // explicit __gap reduction.
    //
    // The previous version of this test only checked that __gap was
    // of the form uint256[\d+] -- which silently passed if someone
    // added a field but forgot to decrement __gap (the gap would
    // still match the regex). That defeated the test's purpose. The
    // version below asserts the EXACT expected gap size, computed
    // from a pinned total, so a missed decrement fails loudly.
    const selfVar = layout.storage.find((entry) => entry.label === "self")
    expect(selfVar, "Bridge.self storage variable missing").to.exist

    const selfType = layout.types[selfVar!.type]
    expect(selfType.members, "BridgeState.Storage members missing").to.exist

    // BridgeState.Storage's explicit fields + __gap must sum to this
    // pinned reserved total. The number intentionally deviates from
    // the typical OpenZeppelin convention of 50; BridgeState's own
    // header comment notes verbatim: "Here we want to have more
    // slots as there are planned upgrades of the Bridge contract."
    // The value below is the actual current sum (explicit fields +
    // gap entries) at the time this test was bootstrapped. Update
    // only with deliberate intent, alongside a snapshot refresh.
    //
    // C-2 (RFC v6, scope-reduced edition) appended one new
    // explicit field — `currentNewWalletScheme` (enum, 1 byte;
    // in its own storage slot since the preceding field is a
    // mapping) — and decremented `__gap` by 1, leaving the
    // member+gap total unchanged at 104.
    //
    // C-2.1 appends `ecdsaWalletCount` (uint128, 16 bytes) which
    // packs into slot 38 at offset 1 (right after the 1-byte
    // enum) WITHOUT taking a new slot. No `__gap` decrement; the
    // member+gap total grows by 1 (104 → 105).
    //
    // The companion `ecdsaWalletCountSeeded` flag + the
    // `seedEcdsaWalletCount` external originally specified in
    // RFC v6 are deferred to a follow-up PR (see `BridgeState.sol`
    // rationale block) and will land alongside another snapshot
    // refresh.
    //
    // D-1 appends `ecdsaRetired` (bool, 1 byte) which packs into
    // slot 38 at offset 17 (right after `ecdsaWalletCount`'s
    // 16 bytes which sit at offsets 1-16) WITHOUT taking a new
    // slot. No `__gap` decrement; the member+gap total grows by
    // 1 (105 → 106). D-2.1 shipped the `retireEcdsa()` setter
    // + `EcdsaRetired` event; D-2.2 slice 1 added the public
    // `ecdsaRetired()` getter and dropped the emit. D-2.2
    // slice 3 removed the `setNewWalletScheme` setter but
    // preserved the `currentNewWalletScheme` storage field
    // (upgrade-safety: never remove a slot from a proxy
    // storage layout), so the slot 38 layout + the
    // `EXPECTED_RESERVED_TOTAL` count below are unchanged.
    const EXPECTED_RESERVED_TOTAL = 106

    const explicitMemberCount = selfType.members!.length - 1
    const expectedGapSize = EXPECTED_RESERVED_TOTAL - explicitMemberCount

    const gap = selfType.members!.find((m) => m.label === "__gap")
    expect(gap, "BridgeState.Storage.__gap reserved-slot member missing").to
      .exist

    const gapType = layout.types[gap!.type]
    expect(
      gapType.label,
      `__gap should be uint256[${expectedGapSize}] (explicit fields = ${explicitMemberCount}, reserved total = ${EXPECTED_RESERVED_TOTAL})`
    ).to.equal(`uint256[${expectedGapSize}]`)
  })
})

// canonicalizeLayout strips solc output fields that drift on unrelated
// source changes (astId, source-path contract attributions, AST IDs
// embedded in type identifiers) while keeping every load-bearing
// storage invariant: per-field label, slot, offset, and type
// definition.
//
// solc embeds AST IDs in type identifiers like
//   "t_struct(Storage)32254_storage"
//   "t_contract(Bank)26367"
//   "t_mapping(t_bytes20,t_struct(Wallet)46452_storage)"
// These AST IDs change whenever the set of compiled source files
// shifts (e.g. a new file is added, ordering changes). They have no
// semantic meaning for storage layout -- the same struct compiled
// twice produces the same slot layout regardless of which AST ID
// solc chose. Stripping them is necessary for the snapshot to be
// stable across the dev environment and CI (where lockfile + solc
// version are pinned but the set of compiled files can still differ
// across runs due to dependency resolution or test fixture changes).
function stripAstIds(typeId: string): string {
  // Strip the AST IDs that solc embeds after the closing paren of
  // struct/contract/enum type identifiers. The AST IDs change across
  // compilations whenever the set of source files shifts; the type
  // semantics do not.
  //
  // Critically, we must NOT strip the trailing digit of array type
  // identifiers like `t_array(t_uint256)45_storage` -- there the
  // digits are the array LENGTH, not an AST ID, and stripping them
  // collapses arrays of different lengths into the same canonical
  // key. A previous catch-all regex `/\)\d+/g` did exactly that and
  // caused `t_array(t_uint256)45_storage` and
  // `t_array(t_uint256)49_storage` to collide under one key, which
  // then broke the __gap size assertion when the wrong array's
  // label was looked up.
  //
  // The fix uses three targeted regexes, one per AST-bearing form.
  // Each is anchored to its prefix so array (and any other future
  // non-AST-bearing) type identifiers are untouched.
  return typeId
    .replace(/(t_struct\([^)]+\))\d+/g, "$1")
    .replace(/(t_contract\([^)]+\))\d+/g, "$1")
    .replace(/(t_enum\([^)]+\))\d+/g, "$1")
}

function canonicalizeLayout(layout: StorageLayout) {
  const storage = layout.storage.map((entry) => ({
    label: entry.label,
    offset: entry.offset,
    slot: entry.slot,
    type: stripAstIds(entry.type),
  }))
  const types: Record<
    string,
    {
      encoding: string
      label: string
      numberOfBytes: string
      base?: string
      key?: string
      value?: string
      members?: { label: string; offset: number; slot: string; type: string }[]
    }
  > = {}
  Object.entries(layout.types).forEach(([name, def]) => {
    types[stripAstIds(name)] = {
      encoding: def.encoding,
      label: def.label,
      numberOfBytes: def.numberOfBytes,
      ...(def.base !== undefined ? { base: stripAstIds(def.base) } : {}),
      ...(def.key !== undefined ? { key: stripAstIds(def.key) } : {}),
      ...(def.value !== undefined ? { value: stripAstIds(def.value) } : {}),
      ...(def.members
        ? {
            members: def.members.map((m) => ({
              label: m.label,
              offset: m.offset,
              slot: m.slot,
              type: stripAstIds(m.type),
            })),
          }
        : {}),
    }
  })
  return { storage, types }
}
