import fs from "fs"
import path from "path"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { ethers as utils } from "ethers"
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
  if (params.rebateStakingProxy.toLowerCase() === params.bridgeProxy.toLowerCase()) {
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
  for (const [index, action] of actions.entries()) {
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
  }
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
      [batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt]
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
  for (const selector of selectors) {
    found[selector] = haystack.includes(selector.toLowerCase().replace(/^0x/, ""))
  }
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
  const found = scanSelectors(bytecode, Object.keys(expectations))
  const problems: string[] = []
  for (const [selector, expectedPresent] of Object.entries(expectations)) {
    if (found[selector] !== expectedPresent) {
      problems.push(
        `${selector} is ${found[selector] ? "present" : "absent"}, expected ${expectedPresent ? "present" : "absent"}`
      )
    }
  }
  if (found[TRAP_SELECTOR_UINT256_AMOUNT] !== undefined) {
    // Not requested by the caller, but never acceptable on a rebate build.
    problems.push(`trap selector ${TRAP_SELECTOR_UINT256_AMOUNT} must not be accepted`)
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
  head: StorageEntry[]
): void {
  // `__gap` appears more than once in a real layout (the OZ base gap near
  // slot 1 and the contract's own trailing gap), so entries are matched by
  // label and occurrence rather than by label alone.
  const keyed = (entries: StorageEntry[]): Map<string, StorageEntry> => {
    const seen = new Map<string, number>()
    const keyedEntries = new Map<string, StorageEntry>()
    for (const entry of entries) {
      const occurrence = seen.get(entry.label) ?? 0
      seen.set(entry.label, occurrence + 1)
      keyedEntries.set(`${entry.label}#${occurrence}`, entry)
    }
    return keyedEntries
  }
  const headByKey = keyed(head)
  for (const [key, entry] of keyed(deployed)) {
    if (entry.label === "__gap") continue // shrinks by design, checked below
    const counterpart = headByKey.get(key)
    if (counterpart === undefined) {
      throw new Error(`layout: deployed field ${key} is gone at head`)
    }
    if (counterpart.slot !== entry.slot || counterpart.offset !== entry.offset) {
      throw new Error(
        `layout: ${entry.label} moved from slot ${entry.slot}+${entry.offset} ` +
          `to ${counterpart.slot}+${counterpart.offset}`
      )
    }
    if (counterpart.type !== entry.type) {
      throw new Error(
        `layout: ${entry.label} type changed from ${entry.type} to ${counterpart.type}`
      )
    }
  }
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
 * Reads and validates `storageLayout.storage` out of a hardhat-deploy
 * record. Records are files on disk, so the shape is parsed rather than
 * asserted: a missing or malformed layout must fail loudly, not read as an
 * empty layout that trivially passes the gate.
 */
export function readStorageLayout(recordPath: string): StorageEntry[] {
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
  return layout.storage.map((raw: unknown, index: number): StorageEntry => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${recordPath}: storageLayout.storage[${index}] is not an object`)
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
  })
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
    currentImplementation.toLowerCase() === candidateImplementation.toLowerCase()
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
  for (let index = 0; index < bytes.length; ) {
    const opcode = bytes[index]
    if (opcode === 0x73) {
      found.push(Buffer.from(bytes.subarray(index + 1, index + 21)).toString("hex"))
      index += 21
      continue
    }
    if (opcode >= 0x60 && opcode <= 0x7f) {
      index += 1 + (opcode - 0x5f)
      continue
    }
    index += 1
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
  const excluded = new Set(knownNonLibraries.map((address) => address.toLowerCase()))
  return extractPushedAddresses(bridgeImplCode).filter(
    (address) => !excluded.has(address.toLowerCase())
  )
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
    const word = await params.provider.getStorage(proxy, EIP_1967_IMPLEMENTATION_SLOT)
    return utils.getAddress(`0x${word.slice(26)}`)
  }
  const rebateImpl = await readImpl(params.rebateStakingProxy)
  const bridgeImpl = await readImpl(params.bridgeProxy)
  if (
    rebateImpl.toLowerCase() !== params.rebateStakingImplementation.toLowerCase()
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

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
  console.log("RebateStaking upgrade is action [0], the Bridge upgrade action [1]")
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
  console.log(`  current Bridge implementation: ${currentBridgeImpl} (action [1] changes it)`)

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
  if (proxyAdminFromStaking.toLowerCase() !== proxyAdminFromBridge.toLowerCase()) {
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
  const deploymentsDir = path.join(__dirname, "..", "deployments", hre.network.name)
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

  const libraryCandidates = linkedLibraryAddresses(bridgeImplCode, [
    Bridge.address,
    RebateStaking.address,
    proxyAdmin,
    KNOWN_TIMELOCK,
    KNOWN_COUNCIL_SAFE,
  ])
  const redemptionLibraries: string[] = []
  for (const candidate of libraryCandidates) {
    const code = await ethers.provider.getCode(candidate)
    if (code === "0x") continue
    const found = scanSelectors(code)
    if (found[REBATE_SELECTORS.isRebateAuthorized] === true) {
      redemptionLibraries.push(candidate)
    }
  }
  if (redemptionLibraries.length === 0) {
    throw new Error(
      `no library linked by the Bridge implementation ${bridgeImplAddress} carries ${REBATE_SELECTORS.isRebateAuthorized}. ` +
        "The batch would install a Bridge that cannot call the rebate gate, so the build is not the release build."
    )
  }
  for (const library of redemptionLibraries) {
    assertSelectorPresence(
      `Redemption library ${library}`,
      await ethers.provider.getCode(library),
      plan.newRedemption
    )
    console.log(`  Redemption library ${library}: calls isRebateAuthorized`)
  }
  console.log(
    `  Bridge implementation selectors: ${JSON.stringify(scanSelectors(bridgeImplCode))}`
  )

  // --- Step 6: Storage layout gate ---
  // Deployed layout comes from the record of the implementation the proxy
  // delegates to today; the head layout from the record just written. Both
  // are files, parsed rather than trusted.
  console.log("\n--- Storage layout gate ---")
  assertLayoutAppendOnly(
    readStorageLayout(recordPath("RebateStakingTIP109HotfixImplementation")),
    readStorageLayout(recordPath("RebateStakingReservationImplementation"))
  )
  console.log("  append-only, same end slot: OK")

  // --- Step 7: Build the single batch ---
  console.log("\n--- Building the Timelock batch ---")
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
  for (const [index, action] of batch.actions.entries()) {
    const decoded = proxyAdminInterface.decodeFunctionData(
      "upgrade",
      action.data
    )
    console.log(`  Action [${index}]: ${action.description}`)
    console.log(`    proxy:          ${String(decoded[0])}`)
    console.log(`    implementation: ${String(decoded[1])}`)
    console.log(`    calldata:       ${action.data}`)
  }
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
      RedemptionLibrary: redemptionLibraries[0],
    },
    existingContracts: {
      Bridge: Bridge.address,
      BridgeCurrentImplementation: currentBridgeImpl,
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
        await ethers.provider.getCode(redemptionLibraries[0])
      ),
      bridgeImplementationHas: scanSelectors(bridgeImplCode),
    },
    // Recorded next to the address so a later reader can tell which build
    // the proxy was pointed at without recompiling the source.
    deployedBytecodeHashes: {
      RebateStakingReservationImplementation: ethers.keccak256(
        readDeployedBytecode(recordPath("RebateStakingReservationImplementation"))
      ),
      BridgeReservationImplementation: ethers.keccak256(bridgeImplCode),
      RedemptionLibrary: ethers.keccak256(
        await ethers.provider.getCode(redemptionLibraries[0])
      ),
    },
  }
  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `reservations-rebate-batch-${Date.now()}.json`
  )
  try {
    fs.writeFileSync(summaryPath, JSON.stringify(record, null, 2))
    console.log(`\nCeremony record saved to: ${summaryPath}`)
  } catch (error) {
    console.log(`WARNING: Failed to write ceremony record: ${(error as Error).message}`)
  }

  console.log(`\n${"=".repeat(80)}`)
  console.log("BATCH SUMMARY")
  console.log("=".repeat(80))
  console.log("  [0] RebateStaking upgrade (plain ProxyAdmin.upgrade)")
  console.log(`      proxy: ${RebateStaking.address}`)
  console.log(`      new impl: ${rebateImpl.address}`)
  console.log("  [1] Bridge upgrade (plain ProxyAdmin.upgrade)")
  console.log(`      proxy: ${Bridge.address}`)
  console.log(`      new impl: ${bridgeImplAddress} (input, deployed by the release pipeline)`)
  console.log("  Reversed order reverts redemptions; see the fork rehearsal.")
  console.log("=".repeat(80))
}

export default func

func.tags = ["DeployRebateStakingReservationImplementation"]
func.dependencies = ["Bridge"]
func.runAtTheEnd = true
func.skip = async (): Promise<boolean> =>
  process.env.DEPLOY_REBATE_BATCH !== "true"
