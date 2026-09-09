import { artifacts } from "hardhat"
import { expect } from "chai"

// This suite guards the storage-layout invariants introduced by the
// protocol peg-keeper allowlist PR:
//
//   - `BridgeState.Storage` (embedded in `Bridge.self`): `rebateStakingDisabled`
//     was packed into the same slot as the pre-existing `rebateStaking`
//     address, the new `pegKeepers` mapping consumed the slot immediately
//     after it, and the reserved `__gap` shrank from 48 to 47 slots to
//     compensate.
//   - `RebateStaking`: the new `deprecated` flag took the slot immediately
//     after the pre-existing `rebateAuthorizations` mapping, and the
//     reserved `__gap` shrank from 48 to 47 slots to compensate.
//
// `@openzeppelin/hardhat-upgrades` normally validates storage-layout safety
// via `validateUpgrade`/`prepareUpgrade`, but those entry points require a
// reference *ContractFactory* (i.e. a second version of the contract
// compiled into the very same Hardhat project) or an already-deployed proxy
// address -- they cannot compare two arbitrary source snapshots (e.g. the
// current tree vs. an older git commit) directly. `BridgeState` is also a
// library, not a deployable/proxied contract, so it cannot go through
// `validateUpgrade` at all.
//
// Instead this suite reads the solc `storageLayout` compiler output (which
// `@openzeppelin/hardhat-upgrades` already forces on for every compiled
// contract, see its `TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE`
// hook) and asserts the exact slot/offset facts above, so a future change
// that silently breaks packing or `__gap` sizing fails CI immediately.

type StorageEntry = {
  label: string
  offset: number
  slot: string
  type: string
}

type StorageLayout = {
  storage: StorageEntry[]
  types: Record<string, { members?: StorageEntry[] }>
}

type BuildInfoContracts = {
  output?: {
    contracts?: Record<
      string,
      Record<string, { storageLayout?: StorageLayout }>
    >
  }
}

async function getStorageLayout(
  fullyQualifiedName: string
): Promise<StorageLayout> {
  const [sourceName, contractName] = fullyQualifiedName.split(":")

  const buildInfo = (await artifacts.getBuildInfo(fullyQualifiedName)) as
    | BuildInfoContracts
    | undefined

  const storageLayout =
    buildInfo?.output?.contracts?.[sourceName]?.[contractName]?.storageLayout

  if (!storageLayout) {
    throw new Error(
      `storageLayout not found for ${fullyQualifiedName}. Ensure ` +
        "@openzeppelin/hardhat-upgrades is loaded (it injects the " +
        "'storageLayout' output selection) and run `yarn build` first."
    )
  }

  return storageLayout
}

function findMember(members: StorageEntry[], label: string): StorageEntry {
  const entry = members.find((member) => member.label === label)
  if (!entry) {
    throw new Error(`Storage member '${label}' not found in compiled layout`)
  }
  return entry
}

describe("Storage layout regressions", () => {
  describe("BridgeState.Storage (embedded as Bridge.self)", () => {
    let members: StorageEntry[]

    before(async () => {
      const layout = await getStorageLayout(
        "contracts/bridge/Bridge.sol:Bridge"
      )

      const self = findMember(layout.storage, "self")
      const structType = layout.types[self.type]

      if (!structType?.members) {
        throw new Error(
          `Expected 'self' to be a struct type with members, got '${self.type}'`
        )
      }

      members = structType.members
    })

    it("packs 'rebateStakingDisabled' into the same slot as 'rebateStaking'", () => {
      const rebateStaking = findMember(members, "rebateStaking")
      const rebateStakingDisabled = findMember(members, "rebateStakingDisabled")

      expect(rebateStaking.type).to.equal("t_address")
      expect(rebateStakingDisabled.type).to.equal("t_bool")
      expect(rebateStakingDisabled.slot).to.equal(rebateStaking.slot)
      expect(rebateStakingDisabled.offset).to.be.greaterThan(
        rebateStaking.offset
      )
    })

    it("places 'pegKeepers' in the slot immediately after 'rebateStaking'", () => {
      const rebateStaking = findMember(members, "rebateStaking")
      const pegKeepers = findMember(members, "pegKeepers")

      expect(pegKeepers.type).to.match(/^t_mapping/)
      expect(pegKeepers.slot).to.equal(
        (BigInt(rebateStaking.slot) + BigInt(1)).toString()
      )
    })

    it("keeps the reserved '__gap' at 47 slots", () => {
      const gap = findMember(members, "__gap")
      expect(gap.type).to.equal("t_array(t_uint256)47_storage")
    })
  })

  describe("RebateStaking", () => {
    let storage: StorageEntry[]

    before(async () => {
      const layout = await getStorageLayout(
        "contracts/bridge/RebateStaking.sol:RebateStaking"
      )
      storage = layout.storage
    })

    it("places 'deprecated' in the slot immediately after 'rebateAuthorizations'", () => {
      const rebateAuthorizations = findMember(storage, "rebateAuthorizations")
      const deprecated = findMember(storage, "deprecated")

      expect(rebateAuthorizations.type).to.equal(
        "t_mapping(t_address,t_mapping(t_address,t_bool))"
      )
      expect(deprecated.type).to.equal("t_bool")
      expect(deprecated.offset).to.equal(0)
      expect(deprecated.slot).to.equal(
        (BigInt(rebateAuthorizations.slot) + BigInt(1)).toString()
      )
    })

    it("keeps RebateStaking's own reserved '__gap' at 47 slots", () => {
      // `__gap` is not a unique label: Initializable and OwnableUpgradeable
      // each declare their own reserved `__gap` array earlier in the layout.
      // RebateStaking's own gap is the one immediately following `deprecated`.
      const deprecated = findMember(storage, "deprecated")
      const expectedSlot = (BigInt(deprecated.slot) + BigInt(1)).toString()
      const gap = storage.find(
        (entry) => entry.label === "__gap" && entry.slot === expectedSlot
      )

      if (!gap) {
        throw new Error(
          "Could not find RebateStaking's own '__gap' entry " +
            `(expected at slot ${expectedSlot}) in the compiled storage layout`
        )
      }

      expect(gap.type).to.equal("t_array(t_uint256)47_storage")
    })
  })
})
