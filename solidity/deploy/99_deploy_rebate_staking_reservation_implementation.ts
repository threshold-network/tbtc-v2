/* eslint-disable no-console -- this script's output is the ceremony's pre-flight report */
import fs from "fs"
import path from "path"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { artifacts } from "hardhat"
import { ethers as utils } from "ethers"
import { getStorageUpgradeReport } from "@openzeppelin/upgrades-core"
import {
  EIP_1967_ADMIN_SLOT,
  EIP_1967_IMPLEMENTATION_SLOT,
  KNOWN_PROXY_ADMIN,
  KNOWN_TIMELOCK,
  KNOWN_COUNCIL_SAFE,
} from "./85_deploy_tip109_governance_upgrade"

/**
 * 99_deploy_rebate_staking_reservation_implementation.ts
 *
 * Deploys the freeze-head `RebateStaking` and emits ONE Timelock
 * `scheduleBatch` / `executeBatch` pair that upgrades the RebateStaking proxy
 * at action `[0]` and the Bridge proxy at action `[1]`.
 *
 * The Bridge implementation is an INPUT, never deployed here (human decision
 * R16-2): the release pipeline owns that deployment, so this script reads the
 * address from `BRIDGE_RESERVATION_IMPLEMENTATION`, refuses to run without
 * it, and refuses to run if it has no code on the target network. Deploying
 * a second Bridge implementation here is the failure mode R16-2 names: the
 * batch would then point action [1] at a build that is not the one the
 * pipeline deployed, and the pre-flight scan would happily certify that
 * other build. The script therefore has no `deploy` call for the Bridge and
 * no path that produces one.
 *
 * Why the order is loaded into the batch and not left to the operator:
 * the head `Redemption` library calls `RebateStaking.isRebateAuthorized`
 * (`0x96253dad`) on every callback redemption where `balanceOwner !=
 * redeemer`. The implementation installed on mainnet today does not have
 * that selector, and `RebateStaking` has neither a fallback nor a receive
 * function, so the call reverts with empty return data. If the Bridge
 * upgrade lands first, every vault redemptions reverts until the staking
 * upgrade lands. Two separate `schedule` calls are two transactions and
 * leave exactly that window open for `getMinDelay()` seconds. One
 * `executeBatch` is atomic, so the window does not exist.
 *
 * The script refuses to emit a batch that is not in the required order
 * (`assertBatchOrder`) and refuses to emit one whose artefacts fail the
 * selector scan (`assertSelectorPlan`). See
 * `agent-docs/overnight-2026-10-30/rebate-selector-risk.md` option A.
 */

/** Selectors the rebate path depends on, computed with `cast sig`. */
export const REBATE_SELECTORS = {
  /** `isRebateAuthorized(address,address)`, read by the head Redemption. */
  isRebateAuthorized: "0x96253dad",
  /** `setRebateAuthorization(address,bool)`, staker opt-in. */
  setRebateAuthorization: "0xee0282a0",
  /** `applyForRebate(address,uint64,uint8)`, called by Redemption and Deposit. */
  applyForRebate: "0xcd2387f6",
  /** `cancelRebate(address,uint256)`, called by Redemption and Deposit. */
  cancelRebate: "0x8741d9b4",
} as const

/**
 * `applyForRebate(address,uint256,uint8)` — a selector that looks right and
 * is not. Head uses `TreasuryFeeType` on the third argument, so the second
 * is `uint64` and the real selector is `0xcd2387f6`. A scan that accepts
 * this one would pass on a build that cannot be called by the libraries.
 */
export const TRAP_SELECTOR_UINT256_AMOUNT = "0xed6321ad"

const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
]
const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)

/** ProxyAdmin.upgrade(proxy, newImplementation) calldata. */
export function encodeUpgrade(proxy: string, newImpl: string): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [proxy, newImpl])
}

export interface RebateBatchAction {
  /** Calldata target. Both actions go to the same ProxyAdmin. */
  target: string
  /** ETH value. Always 0: ProxyAdmin.upgrade is not payable. */
  value: bigint
  /** `upgrade(proxy, implementation)` calldata. */
  data: string
  /** Human label for the runbook and the log. */
  description: string
}

export interface RebateBatch {
  actions: RebateBatchAction[]
  targets: string[]
  values: bigint[]
  payloads: string[]
  /** Deterministic salt; the operation hash is derived from the full batch. */
  salt: string
  /** Zero: the batch must not depend on another operation. */
  predecessor: string
}

/**
 * Builds the two-action batch with the staking upgrade forced to index 0.
 *
 * Throws rather than reorders: a caller that has the arguments backwards
 * has a wrong mental model and must read the failure, not get a silently
 * corrected batch.
 */
export function buildRebateBatch(params: {
  proxyAdmin: string
  rebateStakingProxy: string
  rebateStakingImplementation: string
  bridgeProxy: string
  bridgeImplementation: string
  salt: string
}): RebateBatch {
  if (
    params.rebateStakingProxy.toLowerCase() === params.bridgeProxy.toLowerCase()
  ) {
    throw new Error("RebateStaking and Bridge proxies are the same address")
  }
  // Ordering here is the whole point of the script. RebateStaking first.
  const actions: RebateBatchAction[] = [
    {
      target: params.proxyAdmin,
      value: BigInt(0),
      data: encodeUpgrade(
        params.rebateStakingProxy,
        params.rebateStakingImplementation
      ),
      description: "RebateStaking proxy upgrade via ProxyAdmin.upgrade()",
    },
    {
      target: params.proxyAdmin,
      value: BigInt(0),
      data: encodeUpgrade(params.bridgeProxy, params.bridgeImplementation),
      description: "Bridge proxy upgrade via ProxyAdmin.upgrade()",
    },
  ]
  const batch: RebateBatch = {
    actions,
    targets: actions.map((action) => action.target),
    values: actions.map((action) => action.value),
    payloads: actions.map((action) => action.data),
    salt: params.salt,
    predecessor: utils.ZeroHash,
  }
  assertBatchOrder(batch, {
    proxyAdmin: params.proxyAdmin,
    rebateStakingProxy: params.rebateStakingProxy,
    rebateStakingImplementation: params.rebateStakingImplementation,
    bridgeProxy: params.bridgeProxy,
    bridgeImplementation: params.bridgeImplementation,
  })
  return batch
}

export interface RebateBatchExpectation {
  proxyAdmin: string
  rebateStakingProxy: string
  rebateStakingImplementation: string
  bridgeProxy: string
  bridgeImplementation: string
}

/**
 * Re-decodes the batch and asserts every structural property the runbook
 * relies on. Throws on the first violation, naming it.
 *
 * Checked: exactly two actions, both to the ProxyAdmin, both zero value,
 * `[0]` is `upgrade(RebateStaking, newStakingImpl)` and `[1]` is
 * `upgrade(Bridge, newBridgeImpl)`, nothing in between, and the salt is the
 * expected one. This is the function that fails when the order is reversed.
 */
export function assertBatchOrder(
  batch: RebateBatch,
  expected: RebateBatchExpectation,
  expectedSalt?: string
): void {
  const { actions } = batch
  if (actions.length !== 2) {
    throw new Error(
      `Rebate batch must hold exactly 2 actions, got ${actions.length}`
    )
  }
  actions.forEach((action, index) => {
    if (action.target.toLowerCase() !== expected.proxyAdmin.toLowerCase()) {
      throw new Error(
        `Action [${index}] targets ${action.target}, expected ProxyAdmin ${expected.proxyAdmin}`
      )
    }
    if (action.value !== BigInt(0)) {
      throw new Error(
        `Action [${index}] carries value ${action.value.toString()}, expected 0`
      )
    }
    const decoded = proxyAdminInterface.decodeFunctionData(
      "upgrade",
      action.data
    )
    const proxy = (decoded[0] as string).toLowerCase()
    const implementation = (decoded[1] as string).toLowerCase()
    if (index === 0) {
      if (proxy !== expected.rebateStakingProxy.toLowerCase()) {
        throw new Error(
          `Action [0] upgrades ${proxy}, expected the RebateStaking proxy ${expected.rebateStakingProxy}. ` +
            "RebateStaking must be first: the Bridge implementation calls a selector the installed one lacks."
        )
      }
      if (
        implementation !== expected.rebateStakingImplementation.toLowerCase()
      ) {
        throw new Error(
          `Action [0] installs ${implementation}, expected ${expected.rebateStakingImplementation}`
        )
      }
    } else {
      if (proxy !== expected.bridgeProxy.toLowerCase()) {
        throw new Error(
          `Action [1] upgrades ${proxy}, expected the Bridge proxy ${expected.bridgeProxy}`
        )
      }
      if (implementation !== expected.bridgeImplementation.toLowerCase()) {
        throw new Error(
          `Action [1] installs ${implementation}, expected ${expected.bridgeImplementation}`
        )
      }
    }
  })
  if (batch.predecessor !== utils.ZeroHash) {
    throw new Error(
      `Batch predecessor must be the zero hash, got ${batch.predecessor}`
    )
  }
  if (expectedSalt !== undefined && batch.salt !== expectedSalt) {
    throw new Error(`Batch salt ${batch.salt} != expected ${expectedSalt}`)
  }
}

/** `Timelock.scheduleBatch(targets, values, payloads, predecessor, salt, delay)`. */
export function encodeScheduleBatch(batch: RebateBatch, delay: bigint): string {
  return new utils.Interface([
    "function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)",
  ]).encodeFunctionData("scheduleBatch", [
    batch.targets,
    batch.values,
    batch.payloads,
    batch.predecessor,
    batch.salt,
    delay,
  ])
}

/** `Timelock.executeBatch(targets, values, payloads, predecessor, salt)`. */
export function encodeExecuteBatch(batch: RebateBatch): string {
  return new utils.Interface([
    "function executeBatch(address[],uint256[],bytes[],bytes32,bytes32)",
  ]).encodeFunctionData("executeBatch", [
    batch.targets,
    batch.values,
    batch.payloads,
    batch.predecessor,
    batch.salt,
  ])
}

/**
 * `Timelock.hashOperationBatch(...)`, the id the `CallScheduled` and
 * `BatchCallScheduled` events carry. OpenZeppelin 4.8 hashes the batch
 * alone; the Timelock address is not part of the preimage.
 */
export function hashOperationBatch(batch: RebateBatch): string {
  return utils.keccak256(
    utils.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32"],
      [
        batch.targets,
        batch.values,
        batch.payloads,
        batch.predecessor,
        batch.salt,
      ]
    )
  )
}

/** Selectors found in `bytecode`, lowercased hex without a `0x` prefix. */
export function scanSelectors(
  bytecode: string,
  selectors: readonly string[] = Object.values(REBATE_SELECTORS)
): Record<string, boolean> {
  const haystack = bytecode.toLowerCase().replace(/^0x/, "")
  const found: Record<string, boolean> = {}
  selectors.forEach((selector) => {
    found[selector] = haystack.includes(
      selector.toLowerCase().replace(/^0x/, "")
    )
  })
  return found
}

/**
 * Scans a bytecode blob and asserts exactly the selectors it must and must
 * not carry. `required` false means "must be absent"; a selector listed in
 * neither is not asserted.
 */
export function assertSelectorPresence(
  label: string,
  bytecode: string,
  expectations: Record<string, boolean>
): Record<string, boolean> {
  // The trap selector is scanned alongside the expected ones. Scanning only
  // `Object.keys(expectations)` leaves it out of `found`, and absent from a
  // `Record<string, boolean>` is `undefined` -- so a guard keyed on that
  // lookup can never fire, whatever the bytecode carries.
  const found = scanSelectors(bytecode, [
    ...Object.keys(expectations),
    TRAP_SELECTOR_UINT256_AMOUNT,
  ])
  const problems: string[] = []
  Object.entries(expectations).forEach(([selector, expectedPresent]) => {
    if (found[selector] !== expectedPresent) {
      problems.push(
        `${selector} is ${found[selector] ? "present" : "absent"}, expected ${expectedPresent ? "present" : "absent"}`
      )
    }
  })
  // A boolean, not `!== undefined`: once the key is scanned, `undefined`
  // never comes back, so that test is true for every build and would reject
  // the correct one.
  if (found[TRAP_SELECTOR_UINT256_AMOUNT] === true) {
    // Not requested by the caller, but never acceptable on a rebate build.
    problems.push(
      `trap selector ${TRAP_SELECTOR_UINT256_AMOUNT} is present and must not be accepted`
    )
  }
  if (problems.length > 0) {
    throw new Error(`${label} selector scan failed: ${problems.join("; ")}`)
  }
  return found
}

/**
 * The full pre-flight selector plan for this ceremony.
 *
 * `rebateStaking: "installed"` is the implementation the proxy delegates to
 * today: it must already answer `applyForRebate` and `cancelRebate`, and it
 * must NOT answer the two authorization selectors. That absence is the
 * hazard the batch closes, so a build where it is already present means the
 * ceremony plan is wrong and the operator must stop.
 *
 * `rebateStaking: "new"` is the freeze-head build: all four present.
 *
 * The Redemption library is where the new selector is called from, so it
 * must carry it once the Bridge implementation links it.
 */
export function rebateSelectorPlan(): {
  installedStaking: Record<string, boolean>
  newStaking: Record<string, boolean>
  newRedemption: Record<string, boolean>
} {
  return {
    installedStaking: {
      [REBATE_SELECTORS.isRebateAuthorized]: false,
      [REBATE_SELECTORS.setRebateAuthorization]: false,
      [REBATE_SELECTORS.applyForRebate]: true,
      [REBATE_SELECTORS.cancelRebate]: true,
    },
    newStaking: {
      [REBATE_SELECTORS.isRebateAuthorized]: true,
      [REBATE_SELECTORS.setRebateAuthorization]: true,
      [REBATE_SELECTORS.applyForRebate]: true,
      [REBATE_SELECTORS.cancelRebate]: true,
    },
    newRedemption: {
      [REBATE_SELECTORS.isRebateAuthorized]: true,
      [REBATE_SELECTORS.setRebateAuthorization]: false,
      [REBATE_SELECTORS.applyForRebate]: true,
      [REBATE_SELECTORS.cancelRebate]: true,
    },
  }
}

/**
 * Storage-layout gate: every slot of the pre-upgrade layout must keep its
 * label, slot and offset, and the new layout must not end before it did.
 * `rebateAuthorizations` is appended at 108 into what was `__gap[0]`, and
 * the gap shrinks from 49 to 48, so the end slot is unchanged at 157.
 */
export interface StorageEntry {
  label: string
  slot: string
  offset: string
  /** solc type string, e.g. `t_uint256` or `t_array(t_uint256)49_storage`. */
  type: string
}

/**
 * A whole `storageLayout` as solc emits it: the flat entry list plus the
 * `types` table that gives each type id its members.
 *
 * The type ids are compilation-local: the same source compiled twice names
 * its struct `t_struct(Stake)34999_storage` in one build and
 * `t_struct(Stake)36253_storage` in the other, and renumbers its contract
 * types the same way (`t_contract(IERC20Upgradeable)13046` versus
 * `...13055`). Those ids are opaque handles into the `types` table, not
 * descriptions of the type, so comparing them across two compilations
 * compares compiler bookkeeping rather than the storage.
 */
export interface StorageLayout {
  storage: StorageEntry[]
  types: Record<string, unknown>
}

/**
 * The layout shape `@openzeppelin/upgrades-core` expects. Its own
 * `StorageLayout` type is stricter than the records on disk (it wants the
 * `contract` and `astId` fields solc writes), so the two are bridged with a
 * cast at the one call site rather than by re-declaring the library's
 * types here.
 */
type UpgradesStorageLayout = Parameters<typeof getStorageUpgradeReport>[0]

/**
 * The semantic form of a solc type id: what the type *is*, read out of the
 * layout's own `types` table.
 *
 * solc's type ids are compilation-local handles:
 * `t_contract(IERC20Upgradeable)13046` in one compilation and
 * `t_contract(IERC20Upgradeable)13055` in the next name the same type.
 * The `types` table gives each id its `label`, which carries no AST id:
 * `contract IERC20Upgradeable`, `struct RebateStaking.Stake`,
 * `mapping(address => struct RebateStaking.Stake)`, `uint256[49]`. Those
 * labels are what two compilations can be compared by.
 *
 * A type id the table does not know is returned with its AST suffix
 * stripped, so an unknown type still compares by shape rather than by
 * numbering.
 */
export function semanticTypeId(
  typeId: string,
  types: Record<string, unknown> = {}
): string {
  const labelled = types[typeId]
  if (
    typeof labelled === "object" &&
    labelled !== null &&
    "label" in labelled
  ) {
    const { label } = labelled as { label: unknown }
    if (typeof label === "string") {
      return label
    }
  }
  // No label available: strip the AST ids from the type id, e.g.
  // `t_struct(Stake)34999_storage` -> `t_struct(Stake)`.
  //
  // The AST id is only stripped where it is one. In
  // `t_array(t_uint256)49_storage` the number after the bracket is the
  // array's *length*, and stripping it would make `uint256[49]` and
  // `uint256[48]` the same type.
  return stripAstIds(typeId)
}

/** The type ids whose trailing number is an AST id rather than a length. */
const AST_ID_HEADS: Record<string, true> = {
  t_struct: true,
  t_contract: true,
  t_enum: true,
  t_userDefinedValueType: true,
}

/**
 * Removes the AST ids from a type id, keeping the array lengths.
 *
 * solc's type ids carry the AST id of the declaration in a few places:
 * `t_struct(Stake)34999_storage`, `t_contract(IERC20Upgradeable)13046`,
 * `t_enum(RebateTreasuryFeeMode)34969`. The same declaration gets a
 * different id in the next compilation, so the ids have to go for two
 * builds to be compared.
 */
function stripAstIds(typeId: string): string {
  const open = typeId.indexOf("(")
  if (open === -1) return typeId
  const head = typeId.slice(0, open)
  if (AST_ID_HEADS[head] === true) {
    return typeId.replace(/\)(\d+)(_[a-z]+)?$/, ")")
  }
  // A composite head: recurse into the arguments, which is where the
  // struct and contract ids live. The suffix after the closing bracket is
  // an array length and stays verbatim: `t_array(t_uint256)49_storage`
  // and `t_array(t_uint256)48_storage` are different types.
  const close = typeId.lastIndexOf(")")
  if (close < open) return typeId
  const typeArguments = splitTopLevelArguments(typeId.slice(open + 1, close))
  return `${head}(${typeArguments.map(stripAstIds).join(",")})${typeId.slice(close + 1)}`
}

/**
 * Splits a type argument list on the commas that are not inside a nested
 * one, so `t_address,t_mapping(t_address,t_bool)` gives two arguments.
 *
 * A comma has to be consumed by whoever reads it: a reader that stops on
 * `,` without advancing past it never makes progress and loops forever,
 * which is what a flat scan over a nested type did.
 */
function splitTopLevelArguments(args: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index]
    if (char === "(") {
      depth += 1
    } else if (char === ")") {
      depth -= 1
    } else if (char === "," && depth === 0) {
      parts.push(args.slice(start, index))
      start = index + 1
    }
  }
  parts.push(args.slice(start))
  return parts
}

/**
 * The storage-layout comparison this gate uses.
 *
 * `@openzeppelin/upgrades-core` compares two layouts by their *meaning*:
 * it parses each type id against that compilation's `types` table, resolves
 * struct and enum members, and reports a difference only when the storage
 * really differs. Two builds of the same source that differ only in their
 * AST numbering are equal to it, which is exactly the property this gate
 * needs, and the one the raw type-id comparison did not have.
 *
 * The library is asked for `unsafeAllowCustomTypes` because the pinned
 * solc 0.8.17 does not populate `.members` for enums in `storageLayout`
 * output, so the library would otherwise refuse to compare the
 * `RebateTreasuryFeeMode` enum at all. The repo's own
 * `test/bridge/Bridge.StorageLayout.test.ts` makes the same allowance for
 * the same reason and pins the enum member order from source instead. The
 * enum order is pinned the same way here.
 */
export const LAYOUT_COMPARISON_OPTIONS = {
  unsafeAllowCustomTypes: true,
  unsafeAllowRenames: false,
} as const

/**
 * The declared member order of the staking fee-mode enum.
 *
 * The pinned solc 0.8.17 does not populate `.members` for enums in
 * `storageLayout` output, so `unsafeAllowCustomTypes` makes the library skip
 * the `RebateTreasuryFeeMode` comparison entirely. That relaxation is only
 * safe while the enum's order is pinned by something else, because
 * reordering `DepositOnly` and `RedemptionOnly` leaves the stored byte
 * width, the top-level slots and the selector plan unchanged while every
 * persisted value of 1 or 2 silently decodes as the opposite fee policy.
 *
 * The order is therefore pinned here, against the source, before the
 * relaxed comparison is allowed to stand. `RebateStaking.sol` declares the
 * enum in this order; the deployed record's `types` table names the enum
 * but does not list its members, so the source is the only place the
 * deployed order can be read from.
 */
export const REBATE_TREASURY_FEE_MODE_ORDER = [
  "Both",
  "DepositOnly",
  "RedemptionOnly",
] as const

/**
 * The member order of a source-declared enum, read from the file.
 *
 * The same shape the repo's own `Bridge.StorageLayout.test.ts` uses for the
 * Bridge enums: the declaration is read from source on every run, so a
 * reorder in the source is a change this gate sees.
 *
 * @param source the Solidity source text of the contract.
 * @param enumName the enum's name.
 */
export function readEnumMemberOrder(
  source: string,
  enumName: string
): string[] {
  const match = source.match(
    new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`)
  )
  if (!match) {
    throw new Error(`enum ${enumName} not found in the staking source`)
  }
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""))
}

/**
 * Enforces the declared member order of the staking fee-mode enum.
 *
 * The comparison itself is relaxed because the deployed layout carries no
 * enum members, so this is the check that stands in for it: the source is
 * read and its order has to be the pinned one. A reorder in the source
 * fails here, before the relaxed comparison is allowed to pass it.
 */
export function assertEnumMemberOrder(params: {
  /** The staking contract's source text. */
  source: string
  /** The enum's name. */
  enumName: string
  /** The member order the deployed build has to declare. */
  expected: readonly string[]
}): string[] {
  const { source, enumName, expected } = params
  const actual = readEnumMemberOrder(source, enumName)
  if (
    actual.length !== expected.length ||
    actual.some((member, index) => member !== expected[index])
  ) {
    throw new Error(
      `layout: enum ${enumName} declares [${actual.join(", ")}], expected ` +
        `[${expected.join(", ")}]. The deployed build carries no enum members, ` +
        "so the comparison cannot see a reorder, and a reorder changes the " +
        "fee policy every persisted value of 1 or 2 decodes to."
    )
  }
  return actual
}

/**
 * The semantic storage-layout gate.
 *
 * Two layouts are compared by what they *store*, not by the opaque ids solc
 * hands out. `@openzeppelin/upgrades-core` resolves every type id against
 * the `types` table of its own compilation, so a struct that one build calls
 * `t_struct(Stake)34999_storage` and the other calls
 * `t_struct(Stake)36253_storage` is one struct, and a field whose real type
 * changed is reported even when the ids differ.
 *
 * This is the check that has to hold before a live proxy is pointed at a
 * new implementation. It returns the report so the caller can print it; it
 * throws on the first incompatibility, naming the field.
 */
export function assertLayoutCompatible(
  deployed: StorageLayout,
  head: StorageLayout
): string {
  let report
  try {
    report = getStorageUpgradeReport(
      normaliseLayout(deployed) as unknown as UpgradesStorageLayout,
      normaliseLayout(head) as unknown as UpgradesStorageLayout,
      {
        ...LAYOUT_COMPARISON_OPTIONS,
        unsafeAllowLinkedLibraries: false,
        unsafeSkipStorageCheck: false,
        unsafeAllow: [],
        kind: "transparent",
      }
    )
  } catch (error) {
    throw new Error(
      `layout: the storage layouts could not be compared: ${
        (error as Error).message
      }`
    )
  }
  if (!report.pass) {
    throw new Error(
      `layout: incompatible storage layout\n${report.explain(false)}`
    )
  }
  return report.explain(false)
}

/**
 * Puts a layout into the shape the comparison expects.
 *
 * The offsets are the one field the two sources disagree about: solc
 * writes them as numbers in a build's `storageLayout`, and the
 * hardhat-deploy record that reads the same layout back writes them as
 * strings. `0` and `"0"` are different values to a strict comparison, so
 * a layout that was read from a record would otherwise report every
 * packed field as having moved. The offsets are numbers here, which is
 * what solc emits.
 */
function normaliseLayout(layout: StorageLayout): {
  storage: Record<string, unknown>[]
  types: Record<string, unknown>
} {
  return {
    ...layout,
    storage: layout.storage.map((entry) => ({
      ...entry,
      offset: Number(entry.offset),
    })),
  }
}

/** Last absolute slot an entry covers. Arrays span their declared length. */
function endSlot(entry: StorageEntry): number {
  const match = /^t_array\(.*\)(\d+)_storage$/.exec(entry.type)
  const length = match === null ? 1 : Number(match[1])
  return Number(entry.slot) + length - 1
}

/**
 * Storage-layout gate: every named field of the pre-upgrade layout keeps its
 * label, slot and offset, the layout ends at the same slot, and every slot
 * the shrinking `__gap` gave up is claimed by a named field.
 *
 * `rebateAuthorizations` is appended at 108 (the old `__gap[0]`) and the gap
 * shrinks from 49 to 48, so the end slot stays 157. Anything else is a
 * storage collision on a live proxy and must stop the ceremony.
 */
export function assertLayoutAppendOnly(
  deployed: StorageEntry[],
  head: StorageEntry[],
  types?: { deployed?: StorageLayout; head?: StorageLayout }
): void {
  // `__gap` appears more than once in a real layout (the OZ base gap near
  // slot 1 and the contract's own trailing gap), so entries are matched by
  // label and occurrence rather than by label alone.
  const keyed = (entries: StorageEntry[]): Map<string, StorageEntry> => {
    const seen = new Map<string, number>()
    const keyedEntries = new Map<string, StorageEntry>()
    entries.forEach((entry) => {
      const occurrence = seen.get(entry.label) ?? 0
      seen.set(entry.label, occurrence + 1)
      keyedEntries.set(`${entry.label}#${occurrence}`, entry)
    })
    return keyedEntries
  }
  const headByKey = keyed(head)
  keyed(deployed).forEach((entry, key) => {
    // The `__gap` shrinks by design, so it is checked below instead.
    if (entry.label === "__gap") return
    const counterpart = headByKey.get(key)
    if (counterpart === undefined) {
      throw new Error(`layout: deployed field ${key} is gone at head`)
    }
    // The offset is compared numerically: solc writes it as a number and
    // the hardhat-deploy record writes the same value back as a string,
    // so `0` and `"0"` are the same offset.
    if (
      counterpart.slot !== entry.slot ||
      Number(counterpart.offset) !== Number(entry.offset)
    ) {
      throw new Error(
        `layout: ${entry.label} moved from slot ${entry.slot}+${entry.offset} ` +
          `to ${counterpart.slot}+${counterpart.offset}`
      )
    }
    // The two type ids are compared by meaning, not verbatim: solc
    // renumbers its type ids on every compilation, so the same field has a
    // different id in the two builds even though it stores the same thing.
    const deployedType = semanticTypeId(entry.type, types?.deployed?.types)
    const headType = semanticTypeId(counterpart.type, types?.head?.types)
    if (headType !== deployedType) {
      throw new Error(
        `layout: ${entry.label} type changed from ${entry.type} to ${counterpart.type}`
      )
    }
  })
  const deployedEnd = Math.max(...deployed.map(endSlot))
  const headEnd = Math.max(...head.map(endSlot))
  if (headEnd !== deployedEnd) {
    throw new Error(
      `layout: head ends at slot ${headEnd}, deployed ended at ${deployedEnd}`
    )
  }
  const trailingGap = (entries: StorageEntry[]): StorageEntry | undefined =>
    entries
      .filter((entry) => entry.label === "__gap")
      .sort((a, b) => Number(a.slot) - Number(b.slot))
      .pop()
  const deployedGap = trailingGap(deployed)
  const headGap = trailingGap(head)
  if (deployedGap === undefined || headGap === undefined) return
  const gapStart = Number(deployedGap.slot)
  if (Number(headGap.slot) < gapStart) {
    throw new Error(
      `layout: head __gap starts at ${headGap.slot}, below the deployed ${deployedGap.slot}`
    )
  }
  for (let slot = gapStart; slot < Number(headGap.slot); slot += 1) {
    const owner = head.find((entry) => Number(entry.slot) === slot)
    if (owner === undefined) {
      throw new Error(
        `layout: slot ${slot} is neither a named field nor covered by the head __gap`
      )
    }
  }
}

/**
 * The complete storage gate, in one place.
 *
 * The gate has three parts and they only stand together:
 *
 *  1. `assertLayoutCompatible` compares the two layouts by what they store.
 *  2. `assertLayoutAppendOnly` checks that every named field keeps its
 *     slot and that the shrinking `__gap` gave up only to named fields.
 *  3. `assertEnumMemberOrder` pins the member order of the fee-mode enum.
 *
 * Part 3 is not optional. The comparison in part 1 is relaxed
 * (`unsafeAllowCustomTypes`) because the pinned solc 0.8.17 writes no enum
 * members into the deployed layout, so the library cannot compare
 * `RebateTreasuryFeeMode` and would otherwise refuse the whole layout. That
 * relaxation is only safe while the enum's order is pinned by something the
 * comparison cannot see.
 *
 * A reorder of `DepositOnly` and `RedemptionOnly` leaves the stored byte
 * width, the labels, the top-level slots and the selector plan unchanged,
 * and every persisted value of 1 or 2 would silently decode as the
 * opposite fee policy.
 *
 * The rehearsal and the deploy script both call this, so the rehearsal
 * proves at least what the ceremony enforces: it cannot pass a build the
 * ceremony would reject.
 *
 * @param deployed the layout of the implementation the proxy delegates to.
 * @param head the layout of the implementation the ceremony would install.
 * @param stakingSource the staking contract's source text.
 */
export function assertStorageGate(params: {
  deployed: StorageLayout
  head: StorageLayout
  stakingSource: string
}): void {
  const { deployed, head, stakingSource } = params
  assertLayoutCompatible(deployed, head)
  assertLayoutAppendOnly(deployed.storage, head.storage, {
    deployed,
    head,
  })
  assertEnumMemberOrder({
    source: stakingSource,
    enumName: "RebateTreasuryFeeMode",
    expected: REBATE_TREASURY_FEE_MODE_ORDER,
  })
}

/**
 * Reads and validates `storageLayout.storage` out of a hardhat-deploy
 * record. Records are files on disk, so the shape is parsed rather than
 * asserted: a missing or malformed layout must fail loudly, not read as an
 * empty layout that trivially passes the gate.
 */
export function readStorageLayout(recordPath: string): StorageEntry[] {
  return readStorageLayoutFile(recordPath).storage
}

/**
 * Reads a whole `storageLayout` out of a hardhat-deploy record: the flat
 * entry list and the `types` table that gives every type id its members.
 *
 * The `types` table is what makes a semantic comparison possible. It is
 * required, not optional: a layout without it cannot be compared by
 * meaning, and the gate must not silently fall back to comparing opaque
 * type ids across two different compilations.
 */
export function readStorageLayoutFile(recordPath: string): StorageLayout {
  const parsed: unknown = JSON.parse(fs.readFileSync(recordPath, "utf8"))
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("storageLayout" in parsed)
  ) {
    throw new Error(`${recordPath}: no storageLayout`)
  }
  const layout = parsed.storageLayout
  if (
    typeof layout !== "object" ||
    layout === null ||
    !("storage" in layout) ||
    !Array.isArray(layout.storage)
  ) {
    throw new Error(`${recordPath}: storageLayout.storage is not an array`)
  }
  if (
    !("types" in layout) ||
    typeof layout.types !== "object" ||
    layout.types === null
  ) {
    throw new Error(`${recordPath}: storageLayout.types is missing`)
  }
  const storage = layout.storage.map(
    (raw: unknown, index: number): StorageEntry => {
      if (typeof raw !== "object" || raw === null) {
        throw new Error(
          `${recordPath}: storageLayout.storage[${index}] is not an object`
        )
      }
      const entry: Record<string, unknown> = raw as Record<string, unknown>
      const { label, slot, offset, type } = entry
      // solc writes `slot` as a decimal string and `offset` as a number.
      const normalisedOffset =
        typeof offset === "number" ? String(offset) : offset
      if (
        typeof label !== "string" ||
        typeof slot !== "string" ||
        typeof normalisedOffset !== "string" ||
        typeof type !== "string"
      ) {
        throw new Error(
          `${recordPath}: storageLayout.storage[${index}] needs label/slot/offset/type`
        )
      }
      return { label, slot, offset: normalisedOffset, type }
    }
  )
  return { storage, types: layout.types as Record<string, unknown> }
}

/**
 * The storage layout the compiler produces for a contract, read out of the
 * build info.
 *
 * This is the layout of the *exact build* that is deployed, not of a record
 * written earlier: the fork rehearsal deploys the staking implementation it
 * compiled and compares that build's layout against the deployed one, and a
 * record could describe a different build.
 *
 * @param contractName the fully qualified contract name, e.g.
 *   `contracts/bridge/RebateStaking.sol:RebateStaking`.
 */
export async function compiledStorageLayout(
  contractName: string
): Promise<StorageLayout> {
  const buildInfo = await artifacts.getBuildInfo(contractName)
  if (buildInfo === undefined) {
    throw new Error(`no build info for ${contractName}`)
  }
  const source = contractName.split(":")[0]
  const name = contractName.split(":")[1]
  const output = buildInfo.output.contracts[source]
  const contract = output?.[name]
  if (contract === undefined || !("storageLayout" in contract)) {
    throw new Error(`the ${contractName} build info carries no storage layout`)
  }
  const layout: unknown = contract.storageLayout
  return layout as StorageLayout
}

/** Reads the runtime bytecode hardhat-deploy recorded for a deployment. */
export function readDeployedBytecode(recordPath: string): string {
  const parsed: unknown = JSON.parse(fs.readFileSync(recordPath, "utf8"))
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("deployedBytecode" in parsed)
  ) {
    throw new Error(`${recordPath}: no deployedBytecode`)
  }
  const code = parsed.deployedBytecode
  if (typeof code !== "string" || !code.startsWith("0x")) {
    throw new Error(`${recordPath}: deployedBytecode is not a hex string`)
  }
  return code
}

/** Reads the address hardhat-deploy recorded for a deployment. */
export function readRecordAddress(recordPath: string): unknown {
  const parsed: unknown = JSON.parse(fs.readFileSync(recordPath, "utf8"))
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) {
    throw new Error(`${recordPath}: no address`)
  }
  return (parsed as Record<string, unknown>).address
}

/**
 * Ties the storage gate's baseline record to the implementation the proxy
 * actually delegates to.
 *
 * The gate compares two *files*: the pre-upgrade layout from the
 * `RebateStakingTIP109HotfixImplementation` record and the head layout from
 * the record this script wrote. Neither file is the chain, and nothing else
 * binds them: hardhat-deploy rewrites records in place
 * (`RebateStaking.json` on mainnet already carries `numDeployments: 2`), so a
 * record can describe a build the proxy does not point at. The gate would
 * then certify the upgrade against the wrong storage layout -- the one thing
 * standing between a layout-breaking upgrade and a live proxy.
 *
 * The address is the one record field that can be compared with the chain, so
 * it is compared here, before either layout is read.
 */
export function assertRecordAddressMatchesImplementation(params: {
  /** The record's name, for the error message. */
  name: string
  /** The record's `address` field, as parsed from the file. */
  recordAddress: unknown
  /** The implementation in the proxy's EIP-1967 implementation slot. */
  installedImplementation: string
}): void {
  const { name, recordAddress, installedImplementation } = params
  if (typeof recordAddress !== "string") {
    throw new Error(
      `the ${name} record carries no address, so it cannot be matched against the ` +
        `implementation the proxy delegates to (${installedImplementation})`
    )
  }
  if (recordAddress.toLowerCase() !== installedImplementation.toLowerCase()) {
    throw new Error(
      `the ${name} record describes ${recordAddress}, but the proxy's EIP-1967 ` +
        `implementation slot holds ${installedImplementation}. The record is not ` +
        "the build the proxy delegates to, so its storage layout is not the " +
        "deployed layout; refusing to run the storage gate against it."
    )
  }
}

/**
 * Asserts the Bridge's stored rebate-staking pointer is the proxy this batch
 * upgrades.
 *
 * `Bridge.getRebateStaking()` is the pointer every rebate path reads before it
 * touches the staking contract
 * (`Redemption.isRebateAuthorized`, `applyForRebate`), so the batch only lands
 * its remedy if the pointer names the proxy the batch upgrades. A *non-zero*
 * pointer to any other address is fatal and this function throws on it: the
 * call lands on a contract without `isRebateAuthorized` and reverts with empty
 * return data, which is the exact breakage the batch exists to close.
 *
 * A zero pointer is the documented "no rebate staking" state: the gate
 * soft-fails to `false`, so it cannot break a redemption. It is still not a
 * pass here -- the remedy would not land -- but it is not a mismatch, so the
 * caller reports it as `unset` and the operator decides.
 */
export function assertBridgeRebateStakingPointer(params: {
  /** `Bridge.getRebateStaking()`, as read from the chain. */
  bridgePointer: string
  /** The RebateStaking proxy this batch upgrades. */
  rebateStakingProxy: string
}): "unset" | "matches" {
  const { bridgePointer, rebateStakingProxy } = params
  if (bridgePointer.toLowerCase() === utils.ZeroAddress.toLowerCase()) {
    return "unset"
  }
  if (bridgePointer.toLowerCase() !== rebateStakingProxy.toLowerCase()) {
    throw new Error(
      `Bridge.getRebateStaking() is ${bridgePointer}, but the batch upgrades the ` +
        `RebateStaking proxy ${rebateStakingProxy}. A non-zero pointer to another ` +
        "address makes every rebate path call a contract without " +
        "`isRebateAuthorized` and revert with empty return data; refusing to " +
        "emit the batch."
    )
  }
  return "matches"
}

/**
 * Asserts that the reservation router the Bridge dispatches into is the
 * release build, when one is installed.
 *
 * The Bridge's `fallback()` delegatecalls `self.reservationRouter` for every
 * unmatched selector, so every reservation entry point -- acceptance
 * requests, re-anchor requests, the proof submissions, the parameter
 * setters -- runs *the router's* code, in the Bridge's storage context.
 * The rest of this script certifies the Bridge wrapper and every library it
 * links; without this check the router, the one contract every reservation
 * call actually executes, is never certified at all.
 *
 * The router is write-once (`BridgeState.setReservationRouter`), so a
 * mismatch here cannot be repaired by the batch this script emits: the
 * router's code is fixed at install time, and only a Bridge implementation
 * upgrade could replace it. That is exactly why the drift has to be caught
 * before the ceremony rather than after it.
 *
 * The check covers the router's libraries as well as its wrapper. The
 * router's control plane - the caps, the re-anchor cooldown, the
 * reservation state machine - lives in the `Reservation` and
 * `ReservationProofs` libraries it delegatecalls, and the wrapper proof
 * deliberately ignores the bytes at the link sites (that is how it learns
 * which library the router links). Without a separate proof of the
 * libraries, a byte-identical router linked against an older library
 * build would be certified while dispatching into different code.
 *
 * A zero pointer is the bootstrap ordering, not a mismatch: the router is
 * installed by the reservation bootstrap (`98`), which runs before the
 * upgrade ceremony this script prepares. The caller reports it so the
 * operator sees it, and the ceremony proceeds.
 */
export function assertReservationRouterRuntime(params: {
  /** `Bridge.getReservationRouter()`, as read from the chain. */
  routerAddress: string
  /** The runtime at that address, as deployed. */
  onChainRuntime: string
  /** The release build's artifact runtime for the router. */
  artifactRuntime: string
  /** The artifact's `deployedLinkReferences`, as link sites. */
  linkSites: LinkSite[]
  /**
   * The release build's artifact runtime for each library the router links,
   * keyed by library name. The router's control plane lives in these
   * libraries, so their code is what the Bridge actually executes.
   */
  libraryRuntimes?: Record<string, string>
  /**
   * The runtime at each linked library address, as deployed, keyed by
   * library name. Omitted only when `libraryRuntimes` is omitted.
   */
  onChainLibraryRuntimes?: Record<string, string>
}): "unset" | "matches" {
  const {
    routerAddress,
    onChainRuntime,
    artifactRuntime,
    linkSites,
    libraryRuntimes,
    onChainLibraryRuntimes,
  } = params
  if (routerAddress.toLowerCase() === utils.ZeroAddress.toLowerCase()) {
    return "unset"
  }
  if (onChainRuntime === "0x" || onChainRuntime === "0x0") {
    throw new Error(
      `the Bridge's reservation router is ${routerAddress}, but that address has ` +
        "no code on chain. Every reservation call the Bridge dispatches would " +
        "revert; refusing to run the ceremony."
    )
  }
  // The router links the `Reservation` and `ReservationProofs` libraries, so
  // its runtime carries placeholders where the artifact leaves the library
  // addresses. `proveLinkedRuntimeIdentity` reads the candidate's own
  // address at every link site to learn which library it links, then
  // compares the rest of the runtime byte for byte against the release
  // build. No deployment record is consulted, so a rewritten record cannot
  // make the check pass.
  const identity = proveLinkedRuntimeIdentity({
    candidateAddress: routerAddress,
    candidateRuntime: onChainRuntime,
    artifactRuntime,
    linkSites,
    label: "ReservationRouter",
    artifactLabel: "ReservationRouter",
  })
  if (!identity.isBridge) {
    throw new Error(
      `the Bridge's reservation router at ${routerAddress} is not the release ` +
        `build of the ReservationRouter: ${identity.reason}. The Bridge ` +
        "dispatches every reservation call into it, and the router is " +
        "write-once, so the batch this script emits cannot repair it; " +
        "refusing to run the ceremony."
    )
  }

  // The wrapper is only half of what the Bridge executes. The router
  // delegatecalls the `Reservation` and `ReservationProofs` libraries, and
  // those libraries hold the reservation control plane - the caps, the
  // cooldown, the state machine. `proveLinkedRuntimeIdentity` deliberately
  // excludes the link-site bytes from its comparison (that is how it learns
  // which library the candidate links), so a byte-identical wrapper linked
  // against an older or unrelated library passes the check above while
  // dispatching into different code.
  //
  // The libraries are therefore proven separately, the way Step 2b proves
  // the Bridge's own libraries: the runtime at the linked address has to be
  // the release build's runtime, with the library's own address written in.
  const linkedLibraries = Object.keys(identity.libraries).sort()
  const expectedLibraries = ["Reservation", "ReservationProofs"]
  if (
    linkedLibraries.length !== expectedLibraries.length ||
    expectedLibraries.some((name) => !linkedLibraries.includes(name))
  ) {
    throw new Error(
      `the Bridge's reservation router at ${routerAddress} links ` +
        `[${linkedLibraries.join(", ")}], but the release ReservationRouter ` +
        `build links [${expectedLibraries.join(", ")}]. The reservation ` +
        "control plane lives in those libraries, so the router would " +
        "dispatch into code that is not the release build; refusing to run " +
        "the ceremony."
    )
  }
  if (libraryRuntimes !== undefined) {
    // The libraries are checked one after another, in a fixed order, so the
    // first rejection is the one reported.
    // eslint-disable-next-line no-restricted-syntax
    for (const library of linkedLibraries) {
      const address = identity.libraries[library]
      const onChainLibraryRuntime = onChainLibraryRuntimes?.[library]
      if (onChainLibraryRuntime === undefined) {
        throw new Error(
          `the Bridge's reservation router at ${routerAddress} links ${library} ` +
            `at ${address}, but the runtime at that address was not read, so ` +
            "the library cannot be proven; refusing to run the ceremony."
        )
      }
      if (onChainLibraryRuntime === "0x" || onChainLibraryRuntime === "0x0") {
        throw new Error(
          `the Bridge's reservation router at ${routerAddress} links ${library} ` +
            `at ${address}, but that address has no code on chain. Every ` +
            "reservation call the Bridge dispatches would revert; refusing " +
            "to run the ceremony."
        )
      }
      const artifactLibraryRuntime = libraryRuntimes[library]
      if (artifactLibraryRuntime === undefined) {
        throw new Error(
          `the Bridge's reservation router at ${routerAddress} links ${library} ` +
            `at ${address}, but there is no release build of ${library} to ` +
            "compare it against; refusing to run the ceremony."
        )
      }
      const result = proveLibraryIdentity({
        name: library,
        address,
        onChainRuntime: onChainLibraryRuntime,
        artifactRuntime: artifactLibraryRuntime,
      })
      if (!result.matches) {
        throw new Error(
          `the Bridge's reservation router at ${routerAddress} links ${library} ` +
            `at ${address}, but ${result.reason}. The Bridge dispatches every ` +
            "reservation call through the router into these libraries, and " +
            "the router is write-once, so the batch this script emits cannot " +
            "repair it; refusing to run the ceremony."
        )
      }
    }
  }
  return "matches"
}

/**
 * Reads the runtime at each address the router links, keyed by library name.
 *
 * The addresses are read out of the router's own on-chain runtime, at the
 * link sites the release artifact declares: the artifact carries a
 * placeholder there and the deployed router carries the address it was
 * linked against. Reading them from the deployed runtime - rather than from
 * a deployment record - is what makes the library proof independent of any
 * record an operator could rewrite.
 *
 * A router whose runtime does not carry an address at a link site is
 * rejected here, the same way `proveLinkedRuntimeIdentity` rejects it.
 */
export async function readRouterLibraryRuntimes(
  routerAddress: string,
  routerArtifact: {
    deployedBytecode: string
    deployedLinkReferences: Record<
      string,
      Record<string, { start: number; length: number }[]>
    >
  },
  provider: { getCode: (address: string) => Promise<string> }
): Promise<Record<string, string>> {
  const runtimes: Record<string, string> = {}
  const runtime = await provider.getCode(routerAddress)
  const candidate = runtime.toLowerCase().replace(/^0x/, "")
  // eslint-disable-next-line no-restricted-syntax
  for (const site of artifactLinkSites(routerArtifact.deployedLinkReferences)) {
    const from = site.start * 2
    const to = from + site.length * 2
    const linked = candidate.slice(from, to)
    if (linked.length !== site.length * 2 || !/^[0-9a-f]+$/.test(linked)) {
      throw new Error(
        `the Bridge's reservation router at ${routerAddress} carries no ` +
          `address at the ${site.library} link site, so the library it ` +
          "dispatches into cannot be identified; refusing to run the ceremony."
      )
    }
    // eslint-disable-next-line no-await-in-loop
    runtimes[site.library] = await provider.getCode(
      utils.getAddress(`0x${linked}`)
    )
  }
  return runtimes
}

/**
 * The reservation router the Bridge dispatches into, read from the proxy's
 * storage rather than through a getter.
 *
 * The getter cannot be used here. `Bridge.getReservationRouter()` belongs to
 * the reservation-capable Bridge implementation, and this ceremony runs
 * BEFORE that implementation is installed: it is the script that installs
 * it. The deployed Bridge has no such selector, so an `eth_call` for it
 * reverts with empty data - and installing the router first cannot fix that,
 * because the router's setter lives on the same implementation the ceremony
 * has not installed yet.
 *
 * The pointer is a plain storage word, so it is read from the slot the
 * validated layout puts it in. That works on any implementation, including
 * the one currently deployed, and it reads the same bytes the getter would
 * return.
 */
export async function readReservationRouterPointer(params: {
  /** The Bridge proxy. */
  proxyAddress: string
  /** The validated storage layout of the Bridge's state. */
  layout: StorageLayout
  provider: { getStorage(address: string, position: string): Promise<string> }
}): Promise<string> {
  const { proxyAddress, layout, provider } = params
  const stateType = Object.values(layout.types ?? {}).find((type) => {
    if (typeof type !== "object" || type === null) return false
    return (type as { label?: unknown }).label === "struct BridgeState.Storage"
  })
  const stateMembers =
    stateType !== undefined &&
    typeof stateType === "object" &&
    stateType !== null
      ? (stateType as { members?: unknown }).members
      : undefined
  if (!Array.isArray(stateMembers)) {
    throw new Error(
      "the Bridge storage layout has no `struct BridgeState.Storage` members, " +
        "so the reservation router's slot cannot be determined; refusing to " +
        "run the ceremony."
    )
  }
  const pointer = stateMembers.find(
    (member) => member.label === "reservationRouter"
  )
  if (pointer === undefined) {
    throw new Error(
      "the Bridge storage layout has no `reservationRouter` member, so the " +
        "reservation router's slot cannot be determined; refusing to run the " +
        "ceremony."
    )
  }
  if (Number(pointer.offset) !== 0) {
    throw new Error(
      `the Bridge storage layout puts \`reservationRouter\` at offset ` +
        `${pointer.offset}, so it does not occupy a whole word and cannot be ` +
        "read on its own; refusing to run the ceremony."
    )
  }
  // `BridgeState.Storage` lives inside the Bridge's own `self` variable, so
  // the pointer's absolute slot is the `self` slot plus the pointer's slot
  // inside the struct. Both are read out of the layout, so nothing here is
  // pinned by hand.
  const self = layout.storage.find((entry) => entry.label === "self")
  if (self === undefined) {
    throw new Error(
      "the Bridge storage layout has no `self` entry, so the reservation " +
        "router's absolute slot cannot be determined; refusing to run the " +
        "ceremony."
    )
  }
  const slot = Number(self.slot) + Number(pointer.slot)
  const word = await provider.getStorage(proxyAddress, utils.toBeHex(slot, 32))
  return utils.getAddress(`0x${word.slice(-40)}`)
}

/**
 * The Bridge implementation this batch upgrades to, as an input.
 *
 * Human decision R16-2: the release pipeline deploys the Bridge
 * implementation, so this script only reads its address. The value is
 * required, and a missing one is an error rather than a default, because a
 * default would silently point action [1] at a build nobody deployed.
 */
export function requireBridgeImplementationInput(
  value: string | undefined
): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      "BRIDGE_RESERVATION_IMPLEMENTATION is required: name the Bridge " +
        "implementation the release pipeline deployed. This script does not " +
        "deploy a Bridge implementation (human decision R16-2), because a " +
        "batch pointing at a build other than the deployed one is the exact " +
        "failure the ordering work exists to prevent."
    )
  }
  return utils.getAddress(value.trim())
}

/**
 * The batch is pointless if action [1] installs the implementation the
 * Bridge proxy already delegates to, so that case is refused.
 */
export function assertBridgeImplementationChanges(
  currentImplementation: string,
  candidateImplementation: string
): void {
  if (
    currentImplementation.toLowerCase() ===
    candidateImplementation.toLowerCase()
  ) {
    throw new Error(
      `the Bridge implementation ${candidateImplementation} is the one the Bridge proxy already delegates to. ` +
        "Action [1] would be a no-op."
    )
  }
}

/**
 * Every 20-byte address literal in a runtime bytecode, read from the
 * `PUSH20` immediates. The Bridge implementation embeds the addresses of the
 * libraries it links, so this is how the pre-flight finds the `Redemption`
 * library a given Bridge build actually calls, without trusting a record.
 */
export function extractPushedAddresses(bytecode: string): string[] {
  const hex = bytecode.toLowerCase().replace(/^0x/, "")
  if (hex.length % 2 !== 0) {
    throw new Error("bytecode has an odd number of hex digits")
  }
  const bytes = Buffer.from(hex, "hex")
  const found: string[] = []
  let index = 0
  while (index < bytes.length) {
    const opcode = bytes[index]
    if (opcode === 0x73) {
      found.push(
        Buffer.from(bytes.subarray(index + 1, index + 21)).toString("hex")
      )
      index += 21
    } else if (opcode >= 0x60 && opcode <= 0x7f) {
      // A PUSHn immediate is skipped whole, so an address inside one is
      // never mistaken for a PUSH20.
      index += 1 + (opcode - 0x5f)
    } else {
      index += 1
    }
  }
  return [...new Set(found)].map((address) => utils.getAddress(`0x${address}`))
}

/**
 * The libraries the Bridge implementation links, read from its bytecode.
 * A library address is one that carries code and is not the proxy, the
 * admin, the implementation or a known system contract; the pre-flight uses
 * this to find the `Redemption` library and scan it.
 */
export function linkedLibraryAddresses(
  bridgeImplCode: string,
  knownNonLibraries: readonly string[]
): string[] {
  const excluded = new Set(
    knownNonLibraries.map((address) => address.toLowerCase())
  )
  return extractPushedAddresses(bridgeImplCode).filter(
    (address) => !excluded.has(address.toLowerCase())
  )
}

/**
 * The link sites of a compiled artifact: for every library the artifact
 * links, the byte offsets in the *deployed* bytecode where that library's
 * address is written.
 */
export interface LinkSite {
  /** Library name, e.g. `Redemption`. */
  library: string
  /** Byte offset into the deployed bytecode. */
  start: number
  /** Length in bytes; always 20 for an address. */
  length: number
}

/**
 * The link sites of an artifact, read from its `deployedLinkReferences`.
 *
 * `deployedLinkReferences` is the map of the *runtime* code: the offsets
 * where solc writes each linked library's address. Reading it is what makes
 * the Bridge-identity proof possible, because it says which library each
 * address literal in the runtime belongs to.
 */
export function artifactLinkSites(
  deployedLinkReferences: Record<
    string,
    Record<string, { start: number; length: number }[]>
  >
): LinkSite[] {
  const sites: LinkSite[] = []
  Object.values(deployedLinkReferences).forEach((libraries) => {
    Object.entries(libraries).forEach(([library, references]) => {
      references.forEach((reference) => {
        sites.push({
          library,
          start: reference.start,
          length: reference.length,
        })
      })
    })
  })
  return sites
}

/**
 * The Bridge runtime the artifact describes, with the library addresses
 * substituted for the placeholders.
 *
 * solc leaves an unlinked address in the runtime as a
 * `__$<34 hex chars>$__` placeholder, one per library. Substituting each
 * placeholder with the address the link map says belongs to that library
 * gives the *expected* runtime for a given set of library addresses: two
 * builds of the same Bridge are equal to it when they link the same
 * libraries, and differ when they do not.
 */
export function bridgeRuntimeWithLibraries(
  deployedBytecode: string,
  sites: LinkSite[],
  libraryAddresses: Record<string, string>
): string {
  const hex = deployedBytecode.toLowerCase().replace(/^0x/, "")
  const chunks = new Map<string, string>()
  sites.forEach((site) => {
    const chunk = hex.slice(site.start * 2, site.start * 2 + site.length * 2)
    if (chunk.length !== site.length * 2) {
      throw new Error(
        `link site for ${site.library} at ${site.start} is outside the bytecode`
      )
    }
    chunks.set(chunk, site.library)
  })
  let out = hex
  chunks.forEach((library, chunk) => {
    const address = libraryAddresses[library]
    if (address === undefined) {
      throw new Error(`no address given for the linked library ${library}`)
    }
    const normalised = address.toLowerCase().replace(/^0x/, "")
    if (normalised.length !== 40) {
      throw new Error(`${library} address ${address} is not 20 bytes`)
    }
    out = out.split(chunk).join(normalised)
  })
  return `0x${out}`
}

/**
 * What the identity proof concluded about a candidate Bridge build.
 */
export interface BridgeIdentity {
  /** The candidate is the Bridge artifact, linked as described. */
  isBridge: boolean
  /** The libraries the candidate links, by name. */
  libraries: Record<string, string>
  /** Why the candidate was rejected, when it was. */
  reason?: string
}

/**
 * A linked library that was checked against the release build.
 */
export interface LibraryIdentity {
  /** The library's name, e.g. `Deposit`. */
  name: string
  /** The address the Bridge build links it at. */
  address: string
  /** Whether the runtime at that address is this library's build. */
  matches: boolean
  /** Why the library was rejected, when it was. */
  reason?: string
}

/**
 * The runtime a library build is expected to have on chain.
 *
 * A library's deployed runtime is the artifact's runtime with the
 * library's *own* address written into it: solc emits a library with a
 * `PUSH20 <its own address>` in the deployed code, and the artifact holds
 * that slot as zeros, because the address is not known at compile time.
 * Every other byte is the same.
 *
 * The self-reference slot is *pinned*, not taken from the candidate: solc
 * always writes it at the head of the deployed runtime, right behind the
 * `PUSH20` opcode, so the expected runtime is the artifact with the
 * library's address written into that one fixed prefix. The artifact is the
 * trusted side of the comparison, and it decides where the address goes.
 *
 * The earlier version of this function let the candidate choose: it took
 * the offset from wherever the address appeared in the on-chain runtime.
 * That admitted a runtime which kept its real self-reference zero and put
 * the address in some other zero region of the artifact - a `PUSH20 0x0`
 * constant, or a padded selector - and that runtime is not the release
 * library: it has lost the direct-call guard, because the direct-call
 * guard *is* the self-reference.
 *
 * @param artifactRuntime the release build's runtime for this library.
 * @param onChainRuntime the runtime at the linked address, as deployed.
 * @param libraryAddress the address the library is linked at.
 */
export function expectedLibraryRuntime(
  artifactRuntime: string,
  onChainRuntime: string,
  libraryAddress: string
): string {
  const artifact = artifactRuntime.toLowerCase().replace(/^0x/, "")
  const onChain = onChainRuntime.toLowerCase().replace(/^0x/, "")
  const address = libraryAddress.toLowerCase().replace(/^0x/, "")
  if (address.length !== 40) {
    throw new Error(`library address ${libraryAddress} is not 20 bytes`)
  }
  if (artifact.length !== onChain.length) {
    throw new Error(
      `the runtime is ${onChain.length / 2} bytes, the build is ${artifact.length / 2} bytes`
    )
  }
  const occurrences = onChain.split(address).length - 1
  if (occurrences !== 1) {
    // The runtime does not carry the address it is supposed to be
    // deployed at. That is the swapped-library case: the code at the
    // linked address belongs to a library deployed somewhere else.
    throw new Error(
      `the runtime carries the library's own address ${occurrences} times, expected exactly 1, ` +
        "so the code at this address was not deployed at this address"
    )
  }
  // The expected runtime is built from the artifact, with the address in
  // the one place solc puts it. The candidate is never asked where its own
  // address sits.
  return deployedLibraryRuntime(artifact, address)
}

/**
 * The runtime a library build has on chain, constructed from its artifact.
 *
 * solc emits a library with a `PUSH20 <its own address>` at the head of
 * the deployed runtime, and the artifact holds that slot as zeros, because
 * the address is not known at compile time. The deployed runtime is the
 * artifact's runtime with that slot filled in.
 *
 * This is where the self-reference slot is decided. The address goes
 * behind the leading `PUSH20` opcode, because that is where solc puts it,
 * and the artifact is the trusted side of the comparison: the candidate
 * runtime is never asked where its own address sits.
 */
export function deployedLibraryRuntime(
  artifactRuntime: string,
  libraryAddress: string
): string {
  const artifact = artifactRuntime.toLowerCase().replace(/^0x/, "")
  const address = libraryAddress.toLowerCase().replace(/^0x/, "")
  if (address.length !== 40) {
    throw new Error(`library address ${libraryAddress} is not 20 bytes`)
  }
  // The self-reference is the `PUSH20` at the head of the runtime, which
  // the artifact holds as zeros.
  const selfReference = artifact.slice(0, 42)
  if (selfReference !== `73${"0".repeat(40)}`) {
    throw new Error(
      "the library artifact does not open with a zero address, so its self-reference " +
        "is not where the deployment writes the library's own address"
    )
  }
  return `0x${`73${address}`}${artifact.slice(42)}`
}

/**
 * Checks one linked library against the release build it has to be.
 *
 * The Bridge implementation is a dispatcher: it holds the addresses of its
 * libraries and delegatecalls into them. Proving that the *Bridge* build is
 * the right one therefore proves nothing about the code that will run: a
 * Bridge linked to the correct `Redemption` library but to a wrong-version
 * `Deposit` library is a byte-identical Bridge wrapper that dispatches
 * `revealDeposit` into the wrong code. `ProxyAdmin.upgrade` only installs
 * an address, so nothing else would catch it.
 *
 * This check closes that gap: the runtime at the linked address has to be
 * the release build's runtime for that library, with the library's own
 * address substituted.
 */
export function proveLibraryIdentity(params: {
  /** The library's name, e.g. `Deposit`. */
  name: string
  /** The address the Bridge build links the library at. */
  address: string
  /** The runtime at that address, as deployed. */
  onChainRuntime: string
  /** The release build's artifact runtime for this library. */
  artifactRuntime: string
}): LibraryIdentity {
  const { name, address, onChainRuntime, artifactRuntime } = params
  let expected: string
  try {
    expected = expectedLibraryRuntime(artifactRuntime, onChainRuntime, address)
  } catch (error) {
    return {
      name,
      address,
      matches: false,
      reason: (error as Error).message,
    }
  }
  if (onChainRuntime.toLowerCase() !== expected.toLowerCase()) {
    return {
      name,
      address,
      matches: false,
      reason:
        `the runtime at ${address} is not the ${name} build this Bridge links, ` +
        "so the Bridge would dispatch into different code than the release build",
    }
  }
  return { name, address, matches: true }
}

/**
 * Whether a candidate runtime is a library that refers to itself.
 *
 * solc writes a library's own address into the runtime it deploys: the
 * `Redemption` library's runtime begins with `PUSH20 <its own address>`.
 * A candidate that carries its own address among its PUSH20 literals is
 * therefore a library, not the Bridge implementation.
 *
 * This is the case the review named: passed in as
 * `BRIDGE_RESERVATION_IMPLEMENTATION`, the `Redemption` library satisfies
 * every other check in the pre-flight. It has code, it is not the
 * implementation the Bridge proxy already delegates to, and it does carry
 * the `isRebateAuthorized` selector the scan looks for. Rejecting a
 * self-reference is what stops it from being certified as the Bridge.
 */
export function isSelfReferencingLibrary(
  candidateAddress: string,
  candidateRuntime: string
): boolean {
  const candidate = candidateAddress.toLowerCase().replace(/^0x/, "")
  return extractPushedAddresses(candidateRuntime).some(
    (address) => address.toLowerCase().replace(/^0x/, "") === candidate
  )
}

/**
 * Proves that a candidate runtime is the build described by an artifact.
 *
 * The proof is a bytecode identity, not a heuristic:
 *
 *  1. A candidate that refers to itself is rejected: it is a library, and
 *    the Bridge and the ReservationRouter are not libraries.
 *  2. The candidate's runtime is compared against the artifact's own runtime
 *     with the link sites filled in. Everything except the library addresses
 *     has to match byte for byte, so a candidate that is not this build does
 *     not pass, whatever its address literals look like.
 *  3. The library addresses the candidate links are read from the
 *     artifact's link map, so the `Redemption` library is *named*, not
 *     guessed from a PUSH20 scan.
 *
 * No deployment record is consulted: the candidate's own bytes say which
 * library it links at each site, so a rewritten or stale record cannot make
 * the check pass.
 */
export function proveLinkedRuntimeIdentity(params: {
  /** The candidate's address on chain. */
  candidateAddress: string
  /** The candidate's runtime bytecode, as deployed. */
  candidateRuntime: string
  /** The artifact's deployed bytecode, with link placeholders. */
  artifactRuntime: string
  /** The artifact's deployed link references. */
  linkSites: LinkSite[]
  /** What the candidate is, for the "it is a library" message. */
  label: string
  /** What the artifact describes, for the "differs from" message. */
  artifactLabel: string
}): BridgeIdentity {
  const {
    candidateAddress,
    candidateRuntime,
    artifactRuntime,
    linkSites,
    label,
    artifactLabel,
  } = params
  const candidate = candidateRuntime.toLowerCase().replace(/^0x/, "")
  const artifact = artifactRuntime.toLowerCase().replace(/^0x/, "")

  // Step 1: a library is not the implementation.
  if (isSelfReferencingLibrary(candidateAddress, candidateRuntime)) {
    return {
      isBridge: false,
      libraries: {},
      reason:
        `the candidate ${candidateAddress} refers to itself in its own runtime, ` +
        `so it is a library and not the ${label}`,
    }
  }

  // At every link site the artifact carries a placeholder and the candidate
  // carries the real address. Read both at the same offset: the artifact's
  // placeholder names the library, the candidate's address says which
  // library it links.
  const libraries: Record<string, string> = {}
  const placeholderToAddress = new Map<string, string>()
  let rejection: string | undefined
  linkSites.forEach((site) => {
    // The first rejection wins; the rest of the sites are not read.
    if (rejection !== undefined) return
    const from = site.start * 2
    const to = from + site.length * 2
    const placeholder = artifact.slice(from, to)
    const linked = candidate.slice(from, to)
    if (placeholder.length !== site.length * 2) {
      throw new Error(
        `link site for ${site.library} at ${site.start} is outside the artifact bytecode`
      )
    }
    if (linked.length !== site.length * 2) {
      rejection = `the candidate runtime is shorter than the ${artifactLabel} artifact's link site for ${site.library}`
      return
    }
    if (!/^[0-9a-f]+$/.test(linked)) {
      rejection = `the candidate runtime carries a non-hex value at the ${site.library} link site`
      return
    }
    const existing = placeholderToAddress.get(placeholder)
    if (existing !== undefined && existing !== linked) {
      rejection = `the candidate links two different addresses for ${site.library}`
      return
    }
    placeholderToAddress.set(placeholder, linked)
    libraries[site.library] = utils.getAddress(`0x${linked}`)
  })
  if (rejection !== undefined) {
    return { isBridge: false, libraries, reason: rejection }
  }

  // Step 2: everything outside the link sites must match byte for byte.
  const expected = bridgeRuntimeWithLibraries(
    artifactRuntime,
    linkSites,
    libraries
  )
  if (expected.slice(2) !== candidate) {
    return {
      isBridge: false,
      libraries,
      reason: `the candidate runtime differs from the ${artifactLabel} artifact outside the library link sites`,
    }
  }

  return { isBridge: true, libraries }
}

/**
 * Proves that a candidate runtime is the Bridge implementation.
 *
 * The proof is a bytecode identity, not a heuristic:
 *
 *  1. A candidate that refers to itself is rejected: it is a library, and
 *    the Bridge implementation is not a library.
 *  2. The candidate's runtime is compared against the Bridge artifact's own
 *     runtime with the link sites filled in. Everything except the library
 *     addresses has to match byte for byte, so a candidate that is not this
 *    Bridge does not pass, whatever its address literals look like.
 *  3. The library addresses the candidate links are read from the
 *    artifact's link map, so the `Redemption` library is *named*, not
 *    guessed from a PUSH20 scan.
 */
export function proveBridgeIdentity(params: {
  /** The candidate's address on chain. */
  candidateAddress: string
  /** The candidate's runtime bytecode, as deployed. */
  candidateRuntime: string
  /** The Bridge artifact's deployed bytecode, with link placeholders. */
  artifactRuntime: string
  /** The Bridge artifact's deployed link references. */
  linkSites: LinkSite[]
}): BridgeIdentity {
  return proveLinkedRuntimeIdentity({
    ...params,
    label: "Bridge implementation",
    artifactLabel: "Bridge",
  })
}

/**
 * Post-execution check, to run after `executeBatch` mines.
 *
 * Reads both EIP-1967 implementation slots and asserts they moved to the
 * batch's implementations, then makes the call that used to revert. A
 * `false` answer is the pass: the redeemer has no stake, so a correct
 * implementation short-circuits before touching `rebateAuthorizations`.
 * A revert here means the staking action did not land.
 */
export async function postExecutionCheck(params: {
  provider: { getStorage(address: string, position: string): Promise<string> }
  rebateStakingProxy: string
  rebateStakingImplementation: string
  bridgeProxy: string
  bridgeImplementation: string
}): Promise<Record<string, string>> {
  const readImpl = async (proxy: string): Promise<string> => {
    const word = await params.provider.getStorage(
      proxy,
      EIP_1967_IMPLEMENTATION_SLOT
    )
    return utils.getAddress(`0x${word.slice(26)}`)
  }
  const rebateImpl = await readImpl(params.rebateStakingProxy)
  const bridgeImpl = await readImpl(params.bridgeProxy)
  if (
    rebateImpl.toLowerCase() !==
    params.rebateStakingImplementation.toLowerCase()
  ) {
    throw new Error(
      `post-execution: RebateStaking impl is ${rebateImpl}, expected ${params.rebateStakingImplementation}`
    )
  }
  if (bridgeImpl.toLowerCase() !== params.bridgeImplementation.toLowerCase()) {
    throw new Error(
      `post-execution: Bridge impl is ${bridgeImpl}, expected ${params.bridgeImplementation}`
    )
  }
  const staking = new utils.Contract(
    params.rebateStakingProxy,
    ["function isRebateAuthorized(address,address) view returns (bool)"],
    params.provider as utils.Provider
  )
  const authorized: unknown = await staking.isRebateAuthorized(
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002"
  )
  if (authorized !== false) {
    throw new Error(
      `post-execution: isRebateAuthorized returned ${String(authorized)} for an unstaked redeemer`
    )
  }
  return {
    rebateStakingImplementation: rebateImpl,
    bridgeImplementation: bridgeImpl,
    isRebateAuthorizedUnstakedRedeemer: "false",
  }
}

const func: DeployFunction =
  async function deployRebateStakingReservationImplementation(
    hre: HardhatRuntimeEnvironment
  ) {
    const { deploy, get } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const { ethers } = hre

    const deployOptions: DeployOptions = {
      from: deployer,
      log: true,
      waitConfirmations: 1,
    }

    console.log("=".repeat(80))
    console.log(
      "Next Bridge upgrade: RebateStaking + Bridge in ONE Timelock batch"
    )
    console.log(
      "RebateStaking upgrade is action [0], the Bridge upgrade action [1]"
    )
    console.log("=".repeat(80))
    console.log(`Network: ${hre.network.name}`)
    console.log(`Deployer: ${deployer}`)

    // --- Step 1: Resolve the proxies ---
    const Bridge = await get("Bridge")
    const RebateStaking = await get("RebateStaking")
    console.log(`  Bridge proxy:    ${Bridge.address}`)
    console.log(`  RebateStaking proxy: ${RebateStaking.address}`)

    // --- Step 2: The Bridge implementation, an input ---
    // Human decision R16-2: the release pipeline deploys the Bridge
    // implementation, this script does not. The address is required, and a
    // missing one stops the script rather than falling back to a default.
    const bridgeImplAddress = requireBridgeImplementationInput(
      process.env.BRIDGE_RESERVATION_IMPLEMENTATION
    )
    const bridgeImplCode = await ethers.provider.getCode(bridgeImplAddress)
    if (bridgeImplCode === "0x") {
      throw new Error(
        `BRIDGE_RESERVATION_IMPLEMENTATION ${bridgeImplAddress} has no code on ${hre.network.name}`
      )
    }
    console.log("\n--- Bridge implementation (input, not deployed here) ---")
    console.log(`  ${bridgeImplAddress}`)
    console.log(`  runtime bytes: ${(bridgeImplCode.length - 2) / 2}`)

    // The Bridge build must not be the one already installed: a batch that
    // upgrades the Bridge proxy to the implementation it already delegates to
    // would silently do nothing on action [1].
    const currentBridgeImplWord = await ethers.provider.getStorage(
      (await get("Bridge")).address,
      EIP_1967_IMPLEMENTATION_SLOT
    )
    const currentBridgeImpl = ethers.getAddress(
      `0x${currentBridgeImplWord.slice(26)}`
    )
    assertBridgeImplementationChanges(currentBridgeImpl, bridgeImplAddress)
    console.log(
      `  current Bridge implementation: ${currentBridgeImpl} (action [1] changes it)`
    )

    // The input must actually be the Bridge. Every other check in this script
    // asks whether an address is *usable*; this one asks whether the code
    // behind it is the Bridge implementation, and it does so by bytecode
    // identity against the Bridge artifact:
    //
    //   - a candidate that refers to its own address is a library, and the
    //     Bridge implementation is not a library. The `Redemption` library
    //     passed in here would otherwise satisfy every other check: it has
    //     code, it is not the installed implementation, and it does carry
    //     the `isRebateAuthorized` selector the scan below looks for;
    //   - the rest of the runtime must match the Bridge artifact's runtime
    //     byte for byte, with the library link sites filled in with the
    //     addresses the candidate links.
    //
    // The libraries are then *named* from the artifact's link map, so the
    // `Redemption` library is identified rather than guessed at from a
    // PUSH20 scan.
    console.log("\n--- Bridge identity proof ---")
    const bridgeArtifact = await artifacts.readArtifact("Bridge")
    const identity = proveBridgeIdentity({
      candidateAddress: bridgeImplAddress,
      candidateRuntime: bridgeImplCode,
      artifactRuntime: bridgeArtifact.deployedBytecode,
      linkSites: artifactLinkSites(bridgeArtifact.deployedLinkReferences),
    })
    if (!identity.isBridge) {
      throw new Error(
        `BRIDGE_RESERVATION_IMPLEMENTATION ${bridgeImplAddress} is not the Bridge implementation: ` +
          `${identity.reason}. Action [1] would install code the Bridge proxy cannot dispatch to.`
      )
    }
    console.log(`  runtime matches the Bridge artifact: OK`)
    Object.entries(identity.libraries).forEach(([library, address]) => {
      console.log(`  links ${library}: ${address}`)
    })
    const redemptionLibrary = identity.libraries.Redemption
    if (redemptionLibrary === undefined) {
      throw new Error(
        `the Bridge implementation ${bridgeImplAddress} does not link a Redemption library, ` +
          "so the batch would install a Bridge that cannot call the rebate gate."
      )
    }

    // --- Step 2b: the linked libraries themselves ---
    // The Bridge implementation is a dispatcher: it holds the addresses of
    // its libraries and delegatecalls into them. The identity proof above
    // establishes that the *wrapper* is the release build, but the wrapper's
    // bytes say nothing about the code behind the addresses it links: a
    // Bridge linked to the correct `Redemption` library and to a
    // wrong-version `Deposit` library is a byte-identical wrapper that
    // dispatches `revealDeposit` into different code.
    //
    // `ProxyAdmin.upgrade` only installs an address, and the ERC-1967 proxy
    // only requires that the implementation has code, so nothing downstream
    // would catch a swapped library. Every linked library is therefore
    // checked here against the release build: the runtime at the linked
    // address has to be that build's runtime, with the library's own address
    // written in.
    console.log("\n--- Linked library verification ---")
    const libraryNames = Object.keys(identity.libraries)
    if (libraryNames.length === 0) {
      throw new Error(
        `the Bridge implementation ${bridgeImplAddress} links no libraries at all, ` +
          "so it cannot be the release Bridge build."
      )
    }
    const libraryIdentities: LibraryIdentity[] = []
    // The libraries are checked one after another because each check reads
    // the chain; the order does not matter, only that every one of them is
    // checked before the batch is emitted.
    // eslint-disable-next-line no-restricted-syntax
    for (const library of libraryNames) {
      const address = identity.libraries[library]
      // eslint-disable-next-line no-await-in-loop
      const libraryArtifact = await artifacts.readArtifact(
        `contracts/bridge/${library}.sol:${library}`
      )
      // eslint-disable-next-line no-await-in-loop
      const onChainRuntime = await ethers.provider.getCode(address)
      const result = proveLibraryIdentity({
        name: library,
        address,
        onChainRuntime,
        artifactRuntime: libraryArtifact.deployedBytecode,
      })
      libraryIdentities.push(result)
      if (!result.matches) {
        throw new Error(
          `the Bridge implementation ${bridgeImplAddress} links ${library} at ${address}, ` +
            `but ${result.reason}. Action [1] would install a Bridge that dispatches ` +
            `into code that is not the release build.`
        )
      }
      console.log(`  ${library} at ${address}: release build OK`)
    }

    // --- Step 2c: the reservation router the Bridge dispatches into ---
    // The Bridge's `fallback()` delegatecalls `self.reservationRouter` for
    // every unmatched selector, so every reservation entry point -- the
    // acceptance and re-anchor requests, the proof submissions, the
    // parameter setters -- runs the router's code in the Bridge's storage
    // context. The checks above certify the Bridge wrapper and the
    // libraries it links; without this one the router, the contract every
    // reservation call actually executes, is never certified at all.
    //
    // The router is write-once (`BridgeState.setReservationRouter`), so a
    // mismatch cannot be repaired by the batch this script emits: only a
    // Bridge implementation upgrade could replace it. Catching the drift
    // before the ceremony is the point.
    //
    // A zero pointer is the bootstrap ordering, not a mismatch: the
    // reservation bootstrap (`98`) installs the router, and it runs before
    // the upgrade ceremony this script prepares. The operator sees the
    // warning and the ceremony proceeds.
    console.log("\n--- Reservation router verification ---")
    const routerArtifact = await artifacts.readArtifact(
      "contracts/bridge/ReservationRouter.sol:ReservationRouter"
    )
    const routerAddress: string = await readReservationRouterPointer({
      proxyAddress: Bridge.address,
      layout: await compiledStorageLayout("contracts/bridge/Bridge.sol:Bridge"),
      provider: ethers.provider,
    })
    // The router's control plane lives in the two libraries it links, so
    // their release builds are read too: the wrapper proof below deliberately
    // ignores the link-site bytes, and without the libraries' own proof the
    // check would certify a wrapper whose dispatch target is unchecked.
    const routerLibraryArtifacts: Record<string, string> = {}
    // eslint-disable-next-line no-restricted-syntax
    for (const library of ["Reservation", "ReservationProofs"]) {
      // eslint-disable-next-line no-await-in-loop
      const libraryArtifact = await artifacts.readArtifact(
        `contracts/bridge/${library}.sol:${library}`
      )
      routerLibraryArtifacts[library] = libraryArtifact.deployedBytecode
    }
    if (
      assertReservationRouterRuntime({
        routerAddress,
        onChainRuntime:
          routerAddress === ethers.ZeroAddress
            ? "0x"
            : await ethers.provider.getCode(routerAddress),
        artifactRuntime: routerArtifact.deployedBytecode,
        linkSites: artifactLinkSites(routerArtifact.deployedLinkReferences),
        libraryRuntimes: routerLibraryArtifacts,
        onChainLibraryRuntimes: await readRouterLibraryRuntimes(
          routerAddress,
          routerArtifact,
          ethers.provider
        ),
      }) === "unset"
    ) {
      console.log(
        `  WARNING: Bridge.getReservationRouter() is ${ethers.ZeroAddress}: the ` +
          "reservation router is not installed yet. Every reservation call the " +
          "Bridge dispatches would revert until the bootstrap installs it."
      )
    } else {
      console.log(
        `  ${routerAddress}: matches the release ReservationRouter build: OK`
      )
    }

    // --- Step 3: Deploy the freeze-head RebateStaking implementation ---
    console.log("\n--- Deploying RebateStaking implementation ---")
    const rebateImpl = await deploy("RebateStakingReservationImplementation", {
      ...deployOptions,
      contract: "RebateStaking",
      skipIfAlreadyDeployed: false,
    })
    console.log(`  RebateStaking implementation (NEW): ${rebateImpl.address}`)

    // --- Step 4: Discover the ProxyAdmin ---
    console.log("\n--- Discovering ProxyAdmin ---")

    const adminData = await ethers.provider.getStorage(
      RebateStaking.address,
      EIP_1967_ADMIN_SLOT
    )
    const proxyAdminFromStaking = ethers.getAddress(`0x${adminData.slice(26)}`)
    const bridgeAdminData = await ethers.provider.getStorage(
      Bridge.address,
      EIP_1967_ADMIN_SLOT
    )
    const proxyAdminFromBridge = ethers.getAddress(
      `0x${bridgeAdminData.slice(26)}`
    )
    if (
      proxyAdminFromStaking.toLowerCase() !== proxyAdminFromBridge.toLowerCase()
    ) {
      throw new Error(
        `Admin mismatch: RebateStaking proxy admin ${proxyAdminFromStaking}, Bridge proxy admin ${proxyAdminFromBridge}`
      )
    }
    const proxyAdmin = proxyAdminFromStaking
    console.log(`  ProxyAdmin: ${proxyAdmin}`)
    if (proxyAdmin.toLowerCase() !== KNOWN_PROXY_ADMIN.toLowerCase()) {
      console.log(`  WARNING: does not match known ${KNOWN_PROXY_ADMIN}`)
    }

    const proxyAdminContract = new ethers.Contract(
      proxyAdmin,
      ["function owner() view returns (address)"],
      ethers.provider
    )
    const proxyAdminOwner = (await proxyAdminContract.owner()) as string
    if (proxyAdminOwner.toLowerCase() !== KNOWN_TIMELOCK.toLowerCase()) {
      throw new Error(
        `ProxyAdmin owner is ${proxyAdminOwner}, expected the Timelock ${KNOWN_TIMELOCK}. ` +
          "Without Timelock ownership the batch cannot execute and option E is the only path."
      )
    }
    console.log(`  ProxyAdmin owner: ${proxyAdminOwner} (Timelock)`)

    // --- Step 5: Pre-flight selector scan ---
    // Three artefacts, three jobs:
    //   the installed staking implementation, which must lack the two
    //   authorization selectors (that absence is the hazard the batch closes),
    //   the head `RebateStaking` build, which must carry all four,
    //   and the `Redemption` library that the INPUT Bridge build actually
    //   links, which must call `isRebateAuthorized`.
    //
    // The Bridge implementation is a thin dispatcher and its libraries are
    // reached by delegatecall, so a scan of the Bridge bytecode alone reports
    // a false all-clear. The library is found in the Bridge build's own
    // bytecode, by its PUSH20 literals, and then scanned.
    console.log("\n--- Pre-flight selector scan ---")
    const plan = rebateSelectorPlan()
    const installedImplWord = await ethers.provider.getStorage(
      RebateStaking.address,
      EIP_1967_IMPLEMENTATION_SLOT
    )
    const installedImpl = ethers.getAddress(`0x${installedImplWord.slice(26)}`)
    const installedCode = await ethers.provider.getCode(installedImpl)
    const deploymentsDir = path.join(
      __dirname,
      "..",
      "deployments",
      hre.network.name
    )
    const recordPath = (name: string): string =>
      path.join(deploymentsDir, `${name}.json`)
    const newStakingCode = readDeployedBytecode(
      recordPath("RebateStakingReservationImplementation")
    )

    assertSelectorPresence(
      `installed RebateStaking ${installedImpl}`,
      installedCode,
      plan.installedStaking
    )
    console.log(
      "  installed RebateStaking: authorization selectors absent (the hazard)"
    )
    assertSelectorPresence(
      "head RebateStaking build",
      newStakingCode,
      plan.newStaking
    )
    console.log("  head RebateStaking: all four rebate selectors present")

    // The Redemption library is the one the identity proof *named* from the
    // Bridge artifact's link map, not one guessed at from a PUSH20 scan. The
    // scan used to be the only way to find it, and it could not tell the
    // Redemption library apart from any other library that happens to carry
    // the same selector.
    const redemptionCode = await ethers.provider.getCode(redemptionLibrary)
    if (redemptionCode === "0x") {
      throw new Error(
        `the Redemption library ${redemptionLibrary} linked by the Bridge implementation ${bridgeImplAddress} has no code`
      )
    }
    assertSelectorPresence(
      `Redemption library ${redemptionLibrary}`,
      redemptionCode,
      plan.newRedemption
    )
    console.log(
      `  Redemption library ${redemptionLibrary}: calls isRebateAuthorized`
    )
    console.log(
      `  Bridge implementation selectors: ${JSON.stringify(scanSelectors(bridgeImplCode))}`
    )

    // --- Step 6: Storage layout gate ---
    // Deployed layout comes from the record of the implementation the proxy
    // delegates to today; the head layout from the record just written. Both
    // are files, parsed rather than trusted.
    //
    // The comparison is semantic: `@openzeppelin/upgrades-core` resolves each
    // type against the `types` table of its own compilation, so the two
    // records are compared by what they store and not by the opaque,
    // compilation-local type ids solc hands out. The two builds of this same
    // source differ in those ids and agree in everything else, so an
    // id-by-id comparison would reject the intended upgrade.
    //
    // The gate is the one function, so the rehearsal enforces the same
    // three checks this script does.
    console.log("\n--- Storage layout gate ---")
    // The gate compares files; the proxy delegates to an address. Bind the
    // baseline record to the implementation in the EIP-1967 slot first, so a
    // rewritten or stale record cannot certify the upgrade against a layout
    // that is not the deployed one.
    const deployedRecordName = "RebateStakingTIP109HotfixImplementation"
    const deployedRecordPath = recordPath(deployedRecordName)
    assertRecordAddressMatchesImplementation({
      name: deployedRecordName,
      recordAddress: readRecordAddress(deployedRecordPath),
      installedImplementation: installedImpl,
    })
    console.log(
      `  baseline record ${deployedRecordName} is the installed implementation ${installedImpl}: OK`
    )
    const deployedLayout = readStorageLayoutFile(deployedRecordPath)
    const headLayout = readStorageLayoutFile(
      recordPath("RebateStakingReservationImplementation")
    )
    const stakingSource = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "bridge", "RebateStaking.sol"),
      "utf8"
    )
    assertStorageGate({
      deployed: deployedLayout,
      head: headLayout,
      stakingSource,
    })
    console.log("  storage layout compatible (semantic comparison): OK")
    console.log("  append-only, same end slot: OK")
    console.log(
      `  RebateTreasuryFeeMode order pinned: [${REBATE_TREASURY_FEE_MODE_ORDER.join(", ")}]`
    )

    // --- Step 7: Build the single batch ---
    console.log("\n--- Building the Timelock batch ---")
    // The batch upgrades the proxy; the Bridge has to point at it. A stale or
    // wrong non-zero pointer leaves the rebate path calling code that cannot
    // answer it, which is the breakage the batch is meant to close.
    const bridgeRebateStaking: string = await hre.deployments.read(
      "Bridge",
      "getRebateStaking"
    )
    if (
      assertBridgeRebateStakingPointer({
        bridgePointer: bridgeRebateStaking,
        rebateStakingProxy: RebateStaking.address,
      }) === "unset"
    ) {
      console.log(
        `  WARNING: Bridge.getRebateStaking() is ${utils.ZeroAddress}: the batch ` +
          "upgrades the proxy but leaves the Bridge's pointer unset, so the rebate " +
          "path stays disabled until a separate setRebateStaking call lands."
      )
    } else {
      console.log(`  Bridge.getRebateStaking() == ${RebateStaking.address}: OK`)
    }
    const timelock = new ethers.Contract(
      KNOWN_TIMELOCK,
      ["function getMinDelay() view returns (uint256)"],
      ethers.provider
    )
    const delay = (await timelock.getMinDelay()) as bigint
    const batch = buildRebateBatch({
      proxyAdmin,
      rebateStakingProxy: RebateStaking.address,
      rebateStakingImplementation: rebateImpl.address,
      bridgeProxy: Bridge.address,
      bridgeImplementation: bridgeImplAddress,
      salt: ethers.id("reservations-m1/freeze/rebate-staking-then-bridge"),
    })
    const scheduleCalldata = encodeScheduleBatch(batch, delay)
    const executeCalldata = encodeExecuteBatch(batch)
    const operationId = hashOperationBatch(batch)

    console.log(`  Timelock: ${KNOWN_TIMELOCK}`)
    console.log(`  Delay: ${delay.toString()}s`)
    console.log(`  Salt: ${batch.salt}`)
    console.log(`  Operation id: ${operationId}`)
    batch.actions.forEach((action, index) => {
      const decoded = proxyAdminInterface.decodeFunctionData(
        "upgrade",
        action.data
      )
      console.log(`  Action [${index}]: ${action.description}`)
      console.log(`    proxy:          ${String(decoded[0])}`)
      console.log(`    implementation: ${String(decoded[1])}`)
      console.log(`    calldata:       ${action.data}`)
    })
    console.log(`\n  scheduleBatch calldata: ${scheduleCalldata}`)
    console.log(`  executeBatch calldata:  ${executeCalldata}`)

    // --- Step 8: Save the ceremony record ---
    const chainId = await hre.getChainId()
    const record = {
      network: hre.network.name,
      timestamp: new Date().toISOString(),
      chainId,
      deployer,
      purpose:
        "Install the freeze-head RebateStaking ahead of the Bridge in one Timelock " +
        "batch, so the next Bridge upgrade does not break vault redemptions. The " +
        "Bridge implementation is an input deployed by the release pipeline " +
        "(human decision R16-2), not by this script.",
      deployedContracts: {
        RebateStakingReservationImplementation: rebateImpl.address,
      },
      inputContracts: {
        BridgeReservationImplementation: bridgeImplAddress,
        RedemptionLibrary: redemptionLibrary,
      },
      existingContracts: {
        Bridge: Bridge.address,
        BridgeCurrentImplementation: currentBridgeImpl,
        BridgeRebateStaking: bridgeRebateStaking,
        RebateStaking: RebateStaking.address,
        RebateStakingInstalledImplementation: installedImpl,
        ProxyAdmin: proxyAdmin,
        ProxyAdminOwner: proxyAdminOwner,
        Timelock: KNOWN_TIMELOCK,
        CouncilSafe: KNOWN_COUNCIL_SAFE,
      },
      timelock: {
        delay: delay.toString(),
        operationId,
        batch: {
          targets: batch.targets,
          values: batch.values.map(String),
          payloads: batch.payloads,
          predecessor: batch.predecessor,
          salt: batch.salt,
        },
        scheduleCalldata,
        executeCalldata,
      },
      selectors: {
        scanned: plan,
        installedRebateStakingHas: scanSelectors(installedCode),
        headRebateStakingHas: scanSelectors(newStakingCode),
        redemptionLibraryHas: scanSelectors(
          await ethers.provider.getCode(redemptionLibrary)
        ),
        bridgeImplementationHas: scanSelectors(bridgeImplCode),
      },
      // Recorded next to the address so a later reader can tell which build
      // the proxy was pointed at without recompiling the source.
      deployedBytecodeHashes: {
        RebateStakingReservationImplementation: ethers.keccak256(
          readDeployedBytecode(
            recordPath("RebateStakingReservationImplementation")
          )
        ),
        BridgeReservationImplementation: ethers.keccak256(bridgeImplCode),
        RedemptionLibrary: ethers.keccak256(
          await ethers.provider.getCode(redemptionLibrary)
        ),
      },
    }
    const summaryDir = path.join(
      __dirname,
      "..",
      "deployments",
      hre.network.name
    )
    fs.mkdirSync(summaryDir, { recursive: true })
    const summaryPath = path.join(
      summaryDir,
      `reservations-rebate-batch-${Date.now()}.json`
    )
    try {
      fs.writeFileSync(summaryPath, JSON.stringify(record, null, 2))
      console.log(`\nCeremony record saved to: ${summaryPath}`)
    } catch (error) {
      console.log(
        `WARNING: Failed to write ceremony record: ${(error as Error).message}`
      )
    }

    console.log(`\n${"=".repeat(80)}`)
    console.log("BATCH SUMMARY")
    console.log("=".repeat(80))
    console.log("  [0] RebateStaking upgrade (plain ProxyAdmin.upgrade)")
    console.log(`      proxy: ${RebateStaking.address}`)
    console.log(`      new impl: ${rebateImpl.address}`)
    console.log("  [1] Bridge upgrade (plain ProxyAdmin.upgrade)")
    console.log(`      proxy: ${Bridge.address}`)
    console.log(
      `      new impl: ${bridgeImplAddress} (input, deployed by the release pipeline)`
    )
    console.log("  Reversed order reverts redemptions; see the fork rehearsal.")
    console.log("=".repeat(80))
  }

export default func

func.tags = ["DeployRebateStakingReservationImplementation"]
// No `Bridge` dependency: this script reads the `Bridge` *record*, never the
// deploy script that writes it. hardhat-deploy resolves a script's
// `dependencies` *before* it consults `skip` (1.0.4,
// `DeploymentsManager.executeDeployScripts`), so a `"Bridge"` dependency runs
// `06_deploy_bridge.ts` on every network even when this script then skips
// itself, and 06 has neither a `skip` nor a mainnet guard. On mainnet the
// Bridge is already deployed, so the run aborts inside 06 -- after 06 has
// re-deployed `Deposit`, `DepositSweep` and `Wallets` (their sources change in
// this release, so hardhat-deploy finds the recorded deployment transaction
// stale) and rewritten those records to name implementations the live Bridge
// does not link. A local or rehearsal run that needs the records built first
// passes the tags explicitly:
// `--tags Bridge,DeployRebateStakingReservationImplementation`.
func.runAtTheEnd = true
func.skip = async (): Promise<boolean> =>
  process.env.DEPLOY_REBATE_BATCH !== "true"
