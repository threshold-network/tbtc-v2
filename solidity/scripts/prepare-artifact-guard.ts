/**
 * Parsing, selection and binding validation for the Sepolia rehearsal
 * prepare/activate artifacts (scripts/reservations-sepolia-rehearsal.ts).
 *
 * The boundary functions here are pure: they take file paths, raw text and
 * explicit expected values, and return results. The rehearsal script calls
 * them before reading addresses from an artifact, before choosing a
 * resumed partial, and before any transaction is built. Nothing in this
 * module touches hardhat or a signer.
 *
 * Artifact schema (version 2, no compatibility path — older JSON without
 * the binding block is rejected outright):
 *   schemaVersion: 2
 *   binding: {
 *     chainId:   11155111 (live Sepolia) | 31337 (local `rehearsal`
 *                 node) | null (in-memory hardhat fork),
 *     bridge:    the exact Bridge proxy address the artifact was produced
 *                 against, or null in fork mode,
 *     forkBlock: the pinned fork block for fork artifacts, else null
 *   }
 *   addresses: { bridge, oldGov, oldImpl, newImpl, newGov, router,
 *                vault, proxyAdmin, deployer } — every field a
 *                checksummed 0x address or null; the four deployment
 *                outputs (newImpl, router, vault, newGov) may never be
 *                the all-zero address once written.
 */

import fs from "fs"
import path from "path"
import { getAddress } from "ethers"

export const PREPARE_ARTIFACT_SCHEMA_VERSION = 2

export const SEPOLIA_CHAIN_ID = 11155111
export const REHEARSAL_CHAIN_ID = 31337

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = "0x0".padEnd(42, "0")

const ALL_ADDRESS_KEYS = [
  "bridge",
  "oldGov",
  "oldImpl",
  "newImpl",
  "newGov",
  "router",
  "vault",
  "proxyAdmin",
  "deployer",
] as const

/** The four deployment outputs a phase-activate artifact must carry. */
export const DEPLOYED_ADDRESS_KEYS = ["newImpl", "router", "vault", "newGov"] as const

export type AddressKey = (typeof ALL_ADDRESS_KEYS)[number]

export interface ArtifactBinding {
  chainId: number | null
  bridge: string | null
  forkBlock: number | null
}

/** Structurally valid artifact; individual address values may be null. */
export interface ParsedPrepareArtifact {
  schemaVersion?: number
  mode: "live" | "fork"
  network: string
  phase: string
  startBlock: number
  forkBlock: number | null
  activationBlock: number
  runAt: string
  binding: ArtifactBinding
  addresses: Record<AddressKey, string | null>
  steps: unknown[]
}

export type CandidateState = "partial" | "empty" | "broken"

export interface Candidate {
  file: string
  mtimeMs: number
  state: CandidateState
  artifact?: ParsedPrepareArtifact
  /** Human-readable reason the file is unusable (state === "broken"). */
  reason?: string
}

export type SelectionResult =
  | { kind: "rejected"; reason: string }
  | { kind: "none" }
  | { kind: "selected"; candidate: Candidate }

export interface ExecContext {
  live: boolean
  networkName: string
  /** The provider-reported chain id; null until it has been read. */
  chainId: number | null
  /** Pinned fork block; only meaningful when live === false. */
  forkBlock: number
  /** The exact Bridge proxy this execution runs against, when known. */
  bridge: string
}

export interface SelectOptions {
  /**
   * Phase activate requires all four deploy outputs (newImpl, router, vault,
   * newGov) to be present. `requireComplete` selects only complete artifacts;
   * when false a partial (at least one deployed address) is acceptable for
   * prepare resume.
   */
  requireComplete: boolean
}

/**
 * `true` for a structurally valid address or null. `rejectZeros` is for
 * fields that must be set by the time they are written: the all-zero
 * address is never a deployed contract.
 */
export function isAddressOrAbsent(value: unknown, rejectZeros = false): boolean {
  if (value === null || value === undefined) return true
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) return false
  if (rejectZeros && value.toLowerCase() === ZERO_ADDRESS) return false
  try {
    getAddress(value)
  } catch {
    return false
  }
  return true
}

function addressesValid(
  raw: unknown,
  rejectZeros: boolean
): raw is Record<AddressKey, string | null> {
  if (typeof raw !== "object" || raw === null) return false
  const record = raw as Record<string, unknown>
  return ALL_ADDRESS_KEYS.every((k) => isAddressOrAbsent(record[k], rejectZeros))
}

function bindingValid(raw: unknown, mode: "live" | "fork"): raw is ArtifactBinding {
  if (typeof raw !== "object" || raw === null) return false
  const record = raw as Record<string, unknown>
  const chainOk =
    (mode === "fork" && record.chainId === null) ||
    (typeof record.chainId === "number" &&
      Number.isInteger(record.chainId) &&
      record.chainId > 0)
  const forkBlockOk =
    (mode === "fork" &&
      typeof record.forkBlock === "number" &&
      Number.isInteger(record.forkBlock) &&
      record.forkBlock > 0) ||
    record.forkBlock === null
  return (
    chainOk &&
    forkBlockOk &&
    isAddressOrAbsent(record.bridge)
  )
}

/**
 * Parses unknown input into a schema-valid artifact. JSON failures and
 * schema failures both come back as `{ ok: false, reason }` so callers can
 * distinguish a valid artifact from a malformed file. `rejectZeros`
 * applies to the four deployment output fields, which are the ones a later
 * run would hand to deploy/activate.
 */
export function parsePrepareArtifact(
  raw: string,
  rejectZeros = false
): { ok: true; value: ParsedPrepareArtifact } | { ok: false; reason: string } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    return { ok: false, reason: `not valid JSON: ${String(e).slice(0, 160)}` }
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    return { ok: false, reason: "top-level value is not an object" }
  const o = json as Record<string, unknown>
  const fail = (reason: string) => ({ ok: false, reason })
  if (o.schemaVersion !== PREPARE_ARTIFACT_SCHEMA_VERSION)
    return fail(
      `schemaVersion must be ${PREPARE_ARTIFACT_SCHEMA_VERSION}, got ` +
        `${String(o.schemaVersion)} (old artifact without binding metadata)`
    )
  const mode = o.mode
  if (mode !== "live" && mode !== "fork")
    return fail(`mode must be "live" or "fork", got ${String(mode)}`)
  if (!bindingValid(o.binding, mode))
    return fail(
      `binding is missing or malformed (chainId/bridge/forkBlock must ` +
        `match mode "${mode}")`
    )
  if (!addressesValid(o.addresses, rejectZeros))
    return fail("addresses object is missing or holds a malformed address")
  if (
    !(typeof o.startBlock === "number" &&
      Number.isInteger(o.startBlock) &&
      o.startBlock >= 0) ||
    !(typeof o.activationBlock === "number" &&
      Number.isInteger(o.activationBlock) &&
      o.activationBlock >= 0)
  )
    return fail("startBlock/activationBlock are not integers")
  if (o.forkBlock !== null && typeof o.forkBlock !== "number")
    return fail("top-level forkBlock must be a number or null")
  if (!Array.isArray(o.steps)) return fail("steps must be an array")
  const parsed: ParsedPrepareArtifact = {
    mode,
    network: String(o.network ?? ""),
    phase: String(o.phase ?? "full"),
    startBlock: o.startBlock,
    forkBlock: o.forkBlock === null ? null : o.forkBlock,
    activationBlock: o.activationBlock,
    runAt: String(o.runAt ?? ""),
    binding: o.binding,
    addresses: o.addresses,
    steps: o.steps,
  }
  return { ok: true, value: parsed }
}

/**
 * True when all four deployment-output addresses are present (non-null).
 * Used to distinguish a partial prepare artifact from a complete one.
 */
export function hasAllDeployedAddresses(a: ParsedPrepareArtifact): boolean {
  return DEPLOYED_ADDRESS_KEYS.every((k) => !!a.addresses[k])
}

/**
 * Files of this execution context's prepare artifact set. Fork: only the
 * pinned file. Live: all files of this network, sorted by name so the
 * start block is the ordering key.
 */
export function prepareArtifactFiles(dir: string, ctx: ExecContext): string[] {
  if (!fs.existsSync(dir)) return []
  if (!ctx.live) {
    const f = `reservations-sepolia-rehearsal-${ctx.forkBlock}.json`
    return fs.existsSync(path.join(dir, f)) ? [f] : []
  }
  const prefix = `reservations-sepolia-rehearsal-${ctx.networkName}-`
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
}

/**
 * Selects the prepare artifact for this execution.
 *
 * - Any malformed file in the set is a rejection, never a silent skip.
 *   The rejection reason names the file and is actionable.
 * - Among valid files the newest (mtime) wins; a valid partial is always
 *   preferred over a valid empty one, so a current-run still-empty
 *   artifact never masks an older partial.
 * - `requireComplete` (activate) selects only fully-deployed artifacts
 *   (all four outputs); none -> `kind: "none"`.
 */
export function selectPrepareArtifact(
  dir: string,
  ctx: ExecContext,
  opts: SelectOptions
): SelectionResult {
  const files = prepareArtifactFiles(dir, ctx)
  const candidates: Candidate[] = []
  for (const f of files) {
    const full = path.join(dir, f)
    let state: CandidateState
    let reason = ""
    let artifact: ParsedPrepareArtifact | undefined
    try {
      const raw = fs.readFileSync(full, "utf8")
      const trimmed = raw.trim()
      if (trimmed === "") {
        state = "empty"
      } else {
        const parsed = parsePrepareArtifact(raw, opts.requireComplete)
        if (parsed.ok) {
          artifact = parsed.value
          state = hasAllDeployedAddresses(artifact) ? "partial" : "empty"
        } else {
          state = "broken"
          reason = parsed.reason
        }
      }
    } catch (e) {
      state = "broken"
      reason = `unreadable: ${String(e).slice(0, 160)}`
    }
    if (state === "broken") {
      return {
        kind: "rejected",
        reason:
          `prepare artifact ${f} is malformed: ${reason}. Remove or ` +
          `regenerate it (old artifacts without binding metadata are no ` +
          `longer accepted); no deployment will be attempted.`,
      }
    }
    candidates.push({ file: f, mtimeMs: fs.statSync(full).mtimeMs, state, artifact, reason })
  }
  const byNewest = (a: Candidate, b: Candidate) => b.mtimeMs - a.mtimeMs
  if (opts.requireComplete) {
    const complete = candidates.filter((c) => c.state === "partial")
    if (complete.length === 0) return { kind: "none" }
    complete.sort(byNewest)
    return { kind: "selected", candidate: complete[0] }
  }
  const partials = candidates.filter((c) => c.state === "partial")
  if (partials.length > 0) {
    partials.sort(byNewest)
    return { kind: "selected", candidate: partials[0] }
  }
  const empties = candidates.filter((c) => c.state === "empty")
  if (empties.length > 0) {
    empties.sort(byNewest)
    return { kind: "selected", candidate: empties[0] }
  }
  return { kind: "none" }
}

/**
 * Checks an artifact's binding against the execution context: provider
 * chain id, mode, network name, the exact Bridge proxy, and (for fork)
 * the pinned fork block. Returns null when it matches, else the
 * actionable mismatch message.
 */
export function bindingMismatch(
  a: ParsedPrepareArtifact,
  ctx: ExecContext
): string | null {
  if (a.mode !== (ctx.live ? "live" : "fork"))
    return `artifact mode is ${a.mode}, this run is ${ctx.live ? "live" : "fork"}`
  if (ctx.live) {
    if (ctx.chainId === null)
      return "provider chain id has not been read yet"
    if (a.binding.chainId !== ctx.chainId)
      return `binding chainId ${String(a.binding.chainId)} does not match ` +
        `provider chain ${ctx.chainId}`
    if (a.binding.forkBlock !== null)
      return "binding.forkBlock is set on a live artifact"
    if (a.binding.bridge === null)
      return "binding.bridge is missing on a live artifact"
    if (ctx.bridge !== "" && a.binding.bridge.toLowerCase() !== ctx.bridge.toLowerCase())
      return `binding bridge ${a.binding.bridge} != deployed Bridge ${ctx.bridge}`
    if (a.network !== ctx.networkName)
      return `artifact network "${a.network}" != execution network "${ctx.networkName}"`
    return null
  }
  if (a.binding.chainId !== null)
    return `binding chainId ${String(a.binding.chainId)} is set on a fork artifact`
  if (a.binding.forkBlock !== ctx.forkBlock)
    return `binding forkBlock ${String(a.binding.forkBlock)} != pinned ${ctx.forkBlock}`
  if (a.binding.bridge !== null)
    return "binding.bridge is set on a fork artifact"
  if (a.network !== "hardhat")
    return `artifact network "${a.network}" is not the in-memory hardhat fork`
  return null
}

/**
 * The one chain preflight that must pass before any signer or
 * transaction: provider chain id and execution mode agree, and the live
 * key-held run is exactly Sepolia (11155111). 31337 is only legal on
 * the explicit `rehearsal` network. Supported live networks: "sepolia"
 * (real key, chain 11155111) and "rehearsal" (local node, chain 31337).
 */
export function chainPreflight(
  networkName: string,
  chainId: number,
  live: boolean
): string | null {
  if (!live) {
    if (networkName === "hardhat") {
      if (chainId !== REHEARSAL_CHAIN_ID)
        return `hardhat fork chain id ${chainId} is not ${REHEARSAL_CHAIN_ID}; ` +
          `refusing to send any transaction`
      return null
    }
    if (networkName === "rehearsal") {
      if (chainId !== REHEARSAL_CHAIN_ID)
        return `rehearsal node chain id ${chainId} is not ${REHEARSAL_CHAIN_ID}; ` +
          `refusing to send any transaction`
      return null
    }
    return `network "${networkName}" is not a supported execution network ` +
      `(expected "hardhat" fork, or "rehearsal"); refusing to send any transaction`
  }
  // Live: permitted networks are sepolia (11155111) and rehearsal (31337).
  if (networkName === "sepolia") {
    if (chainId !== SEPOLIA_CHAIN_ID)
      return `provider chain id ${chainId} is not Sepolia (${SEPOLIA_CHAIN_ID}); ` +
        `refusing to send any transaction`
    return null
  }
  if (networkName === "rehearsal") {
    if (chainId !== REHEARSAL_CHAIN_ID)
      return `provider chain id ${chainId} is not ${REHEARSAL_CHAIN_ID}; ` +
        `refusing to send any transaction`
    return null
  }
  return `network "${networkName}" is not a supported live network ` +
    `("sepolia" or "rehearsal"); refusing to send any transaction`
}

/**
 * Builds a schema-valid, no-steps artifact for a fresh run. The caller
 * fills in mode-specific fields after the chain preflight has passed
 * (live: startBlock/bridge; fork: forkBlock).
 */
export function buildFreshArtifact(input: {
  live: boolean
  networkName: string
  phase: string
  startBlock: number
  activationBlock: number
  chainId: number | null
  bridge: string | null
  forkBlock: number | null
  addresses: Record<AddressKey, string | null>
}): ParsedPrepareArtifact {
  return {
    schemaVersion: PREPARE_ARTIFACT_SCHEMA_VERSION,
    mode: input.live ? "live" : "fork",
    network: input.networkName,
    phase: input.phase || "full",
    startBlock: input.startBlock,
    forkBlock: input.forkBlock,
    activationBlock: input.activationBlock,
    runAt: new Date().toISOString(),
    binding: {
      chainId: input.chainId,
      bridge: input.bridge,
      forkBlock: input.forkBlock,
    },
    addresses: input.addresses,
    steps: [],
  }
}

/**
 * Returns the filename for a prepare/activation artifact given the execution
 * context. Used by both the guard module and the rehearsal script to
 * construct the same paths.
 */
export function prepareArtifactFilename(
  ctx: Pick<ExecContext, "live" | "networkName" | "forkBlock">,
  kind: "rehearsal" | "activation",
  startBlock: number
): string {
  const base = ctx.live
    ? `${ctx.networkName}-${startBlock}`
    : `${ctx.forkBlock}`
  return `reservations-sepolia-${kind}-${base}.json`
}

/**
 * Early binding check that uses only the provider chain id and execution
 * mode — no on-chain state required. Returns a reason string on mismatch,
 * null when the binding is compatible at this level.
 *
 * Run this before `readState` / `getSigner`. The full binding check
 * (including Bridge proxy address) is done after `readState` via
 * `bindingMismatch`.
 */
export function bindingPreflight(
  a: ParsedPrepareArtifact,
  ctx: Pick<ExecContext, "live" | "networkName" | "chainId" | "forkBlock">
): string | null {
  if (a.mode !== (ctx.live ? "live" : "fork"))
    return `artifact mode is ${a.mode}, this run is ${ctx.live ? "live" : "fork"}`
  if (ctx.live) {
    if (ctx.chainId === null)
      return "provider chain id has not been read yet"
    if (a.binding.chainId !== ctx.chainId)
      return `binding chainId ${String(a.binding.chainId)} does not match ` +
        `provider chain ${ctx.chainId}`
    if (a.network !== ctx.networkName)
      return `artifact network "${a.network}" != execution network "${ctx.networkName}"`
    return null
  }
  if (a.binding.chainId !== null)
    return `binding chainId is set on a fork artifact`
  if (a.network !== "hardhat")
    return `artifact network "${a.network}" is not the in-memory hardhat fork`
  return null
}

/**
 * Atomically writes a schema-valid prepare artifact to `target`. Uses a
 * temp file + rename so a mid-write kill does not leave a corrupt artifact
 * that would poison the next run's selection. The BigInt replacer is built
 * in so step values containing bigints are serialized correctly.
 */
export function writePrepareArtifact(
  target: string,
  artifact: ParsedPrepareArtifact,
  extra: Record<string, unknown> = {}
): void {
  const text = JSON.stringify(
    { schemaVersion: PREPARE_ARTIFACT_SCHEMA_VERSION, ...artifact, ...extra },
    (_k, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  )
  const tmp = `${target}.tmp`
  try {
    fs.unlinkSync(tmp)
  } catch {
    // ignore
  }
  fs.writeFileSync(tmp, text + "\n")
  fs.renameSync(tmp, target)
}
