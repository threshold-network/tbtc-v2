/**
 * Runtime-code discriminators for the M1 `WalletProposalValidator`.
 *
 * The release gate for step 3a ("the validator address the client config names
 * has deployedBytecode containing `require(!bridge.isReservedDeposit(...))`")
 * cannot be a plain substring search: solc emits a revert string as one
 * `PUSH32`-and-`MSTORE` per 32-byte word, with the store sequence between
 * consecutive words, so `"Reserved deposits must not be swept"` never appears
 * contiguously even in a build that carries it. A search for the literal text
 * reports the *correct* build as missing.
 *
 * The reliable discriminators are the selectors of the calls a reservations
 * build must be able to make and receive:
 *
 *   - `isReservedDeposit(uint256)` on the Bridge, called by the validator's
 *     deposit-sweep rule. Absent from every pre-reservation build.
 *   - `validateReservationAnchorProposal` / `validateReservationReanchorProposal`
 *     on the validator itself. Absent from the pre-M1 mainnet validator, which
 *     therefore cannot validate a reservation proposal at all.
 *
 * The revert message is still checked, as its 32-byte words, as a second,
 * independent signal.
 */
import { id } from "ethers"

/**
 * The four-byte selector of a function signature: the first four bytes of the
 * keccak-256 hash, as it appears in a `PUSH4` in runtime code. Derived rather
 * than hardcoded so a signature edit cannot leave a stale selector behind.
 */
function selectorOf(signature: string): string {
  return id(signature).slice(2, 10)
}

/** `isReservedDeposit(uint256)`, the call the reserved-deposit rule makes. */
export const SELECTOR_IS_RESERVED_DEPOSIT = selectorOf(
  "isReservedDeposit(uint256)"
)

/** The anchor-proposal entry point a reservations validator must expose. */
export const SELECTOR_VALIDATE_RESERVATION_ANCHOR = selectorOf(
  "validateReservationAnchorProposal((bytes20,(bytes32,uint32),uint64,uint256),((bytes4,bytes,bytes,bytes4),bytes8,bytes20,bytes20,bytes4))"
)

/** The re-anchor-proposal entry point a reservations validator must expose. */
export const SELECTOR_VALIDATE_RESERVATION_REANCHOR = selectorOf(
  "validateReservationReanchorProposal((bytes20,uint256,uint64,bytes20,uint256))"
)

/** The reserved-deposit rule in the validator. */
export const RESERVED_SWEEP_REVERT = "Reserved deposits must not be swept"

/**
 * The distance allowed between two consecutive words of a message. solc emits
 * a `revert("...")` / `require(c, "...")` string as one `PUSH32`-and-`MSTORE`
 * per 32-byte word, so the payload words are contiguous *within* a word and
 * separated by the store sequence (`60 44 82 01 52 7f`, six bytes here, more
 * when the stack offset needs two bytes) *between* them. The message is
 * therefore never a straight substring of the code, and a gap bound is what
 * keeps the check from being satisfied by an unrelated literal further down.
 */
const MAX_WORD_GAP_BYTES = 16

/**
 * Reports whether the given message is present in EVM runtime code, as the
 * 32-byte words solc emits it in.
 *
 * A plain substring search reports a correct build as missing: words are
 * separated by the store sequence. A 31-byte-chunk search reports it as
 * present for the wrong reason: `"Reserved deposits must not be swept"` cut
 * into 31-byte pieces looks for `"...must not be s"` and then `"wept"`, and
 * `"wept"` occurs inside the unrelated `"Deposit already swept"` literal. Both
 * words must therefore be 32 bytes wide and close together.
 */
export function revertStringPresent(code: string, message: string): boolean {
  const bytes = Buffer.from(message, "ascii")
  const words: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32) {
    const word = Buffer.alloc(32)
    bytes.copy(word, 0, offset, Math.min(offset + 32, bytes.length))
    words.push(word.toString("hex"))
  }
  let cursor = 0
  for (let index = 0; index < words.length; index += 1) {
    const at = code.indexOf(words[index], cursor)
    if (at < 0) return false
    // `code` is a hex string: every byte is two characters, so the bound in
    // characters is twice the bound in bytes.
    if (index > 0 && at - cursor > MAX_WORD_GAP_BYTES * 2) return false
    cursor = at + words[index].length
  }
  return true
}

export interface CodeCheck {
  name: string
  ok: boolean
  detail: string
}

/**
 * The 3a release gate for one validator address: the runtime must be the
 * reservations build, i.e. it must be able to make the reserved-deposit call
 * and must expose both reservation proposal entry points.
 */
export function validatorRuntimeChecks(code: string): CodeCheck[] {
  const hex = code.toLowerCase()
  return [
    {
      name: "validator calls bridge.isReservedDeposit",
      ok: hex.includes(SELECTOR_IS_RESERVED_DEPOSIT),
      detail: `selector 0x${SELECTOR_IS_RESERVED_DEPOSIT}`,
    },
    {
      name: "validator exposes validateReservationAnchorProposal",
      ok: hex.includes(SELECTOR_VALIDATE_RESERVATION_ANCHOR),
      detail: `selector 0x${SELECTOR_VALIDATE_RESERVATION_ANCHOR}`,
    },
    {
      name: "validator exposes validateReservationReanchorProposal",
      ok: hex.includes(SELECTOR_VALIDATE_RESERVATION_REANCHOR),
      detail: `selector 0x${SELECTOR_VALIDATE_RESERVATION_REANCHOR}`,
    },
    {
      name: "validator carries the reserved-deposit revert message",
      ok: revertStringPresent(hex, RESERVED_SWEEP_REVERT),
      detail: `"${RESERVED_SWEEP_REVERT}" as 32-byte words`,
    },
  ]
}

/**
 * The Bridge half of the gate, asked behaviourally rather than by inspecting
 * the proxy's runtime: a transparent proxy's own code never changes, so the
 * reservation surface lives in the implementation it delegates to. `eth_call`
 * reaches whatever the proxy currently delegates to, which is exactly what the
 * validator will reach at signing time.
 */
export async function bridgeAnswersIsReservedDeposit(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> },
  bridgeAddress: string
): Promise<{ ok: boolean; detail: string }> {
  // isReservedDeposit(uint256) with a zero deposit key.
  const calldata = `0x${SELECTOR_IS_RESERVED_DEPOSIT}${"0".repeat(64)}`
  try {
    const result = await provider.call({ to: bridgeAddress, data: calldata })
    return {
      ok: result === `0x${"0".repeat(64)}`,
      detail: `isReservedDeposit(0) returned ${result}`,
    }
  } catch (error) {
    return {
      ok: false,
      detail: `isReservedDeposit(0) reverted: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      } - the Bridge is still the pre-reservation implementation`,
    }
  }
}

/** `bridge()`, the address the validator was constructed with. */
const SELECTOR_BRIDGE = selectorOf("bridge()")

/** The variable hardhat-deploy swaps the record directory on. */
export const FIXTURE_ENV = "HARDHAT_DEPLOY_FIXTURE"

/**
 * Both entry points read and write the real `deployments/<network>` records,
 * so fixture mode is fatal for them: hardhat-deploy resolves
 * `deployments.get` against the fixture directory instead, and a missing
 * record in fixture mode is not an error the script can notice. The variable
 * is treated as set whenever it is non-empty - `0` and `false` included -
 * because hardhat-deploy only checks that it is present.
 */
export function assertNotFixtureMode(
  env: NodeJS.ProcessEnv = process.env
): void {
  const raw = env[FIXTURE_ENV]
  if (raw === undefined || raw === "") {
    return
  }
  throw new Error(
    `${FIXTURE_ENV} is set to ${JSON.stringify(raw)}: fixture mode resolves ` +
      "deployment records to the fixture directory instead of the network's " +
      "deployed records. Unset it and re-run."
  )
}

/**
 * Reads the Bridge the validator calls. The gate asks this address rather
 * than the deployment record, because an override or a stale record would
 * otherwise probe a Bridge the validator never calls.
 */
export async function validatorDeclaredBridge(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> },
  validatorAddress: string
): Promise<string> {
  const result = await provider.call({
    to: validatorAddress,
    data: `0x${SELECTOR_BRIDGE}`,
  })
  if (!result.startsWith("0x") || result.length < 42) {
    throw new Error(
      `${validatorAddress} did not answer bridge(): ${result.slice(0, 74)}`
    )
  }
  return `0x${result.slice(-40)}`
}

/**
 * Compares the validator's Bridge with the one the release expects. A
 * disagreement is a gate failure, not a warning: the reserved-deposit rule
 * calls this address for every deposit in a sweep proposal, so a validator
 * built against another Bridge either fails every sweep or trusts a Bridge
 * the release does not ship.
 */
export function validatorBridgeCheck(
  declaredBridge: string,
  expectedBridge: string
): CodeCheck {
  const declared = declaredBridge.toLowerCase()
  const zero = `0x${"0".repeat(40)}`
  if (declared === zero) {
    return {
      name: "validator points at the expected Bridge",
      ok: false,
      detail: "validator.bridge() returned the zero address",
    }
  }
  return {
    name: "validator points at the expected Bridge",
    ok: declared === expectedBridge.toLowerCase(),
    detail: `validator.bridge() ${declaredBridge}, expected ${expectedBridge}`,
  }
}

/** What the gate needs from a provider: `eth_call`, nothing else. */
export interface GateProvider {
  call: (tx: { to: string; data: string }) => Promise<string>
}

export interface GateInput {
  provider: GateProvider
  chainId: number
  validatorAddress: string
  validatorCode: string
  /** The Bridge the release expects: `BRIDGE_ADDRESS` or the record. */
  expectedBridge: string
  activationBlock: number
  releaseBlock: number
  setVaultStatusBlock: number
}

export interface GateResult {
  checks: CodeCheck[]
  /** The Bridge the validator calls, when it could be read. */
  declaredBridge?: string
  failed: number
}

/**
 * The whole 3a/3b verdict, from chain reads and the release's own numbers.
 * The gate script owns argument parsing and printing; everything that decides
 * the verdict is here, so a test can drive the consuming path instead of its
 * helpers.
 */
export async function reservationActivationChecks(
  input: GateInput
): Promise<GateResult> {
  const checks: CodeCheck[] = []
  checks.push({
    name: "chain id is 1",
    ok: input.chainId === 1,
    detail: `chainId ${input.chainId}`,
  })
  checks.push({
    name: "validator has code",
    ok: input.validatorCode !== "0x",
    detail: `${input.validatorAddress} (${
      input.validatorCode === "0x" ? "0" : (input.validatorCode.length - 2) / 2
    } bytes)`,
  })
  checks.push(...validatorRuntimeChecks(input.validatorCode))

  let declaredBridge: string | undefined
  try {
    declaredBridge = await validatorDeclaredBridge(
      input.provider,
      input.validatorAddress
    )
    checks.push(validatorBridgeCheck(declaredBridge, input.expectedBridge))
  } catch (error) {
    checks.push({
      name: "validator points at the expected Bridge",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  if (declaredBridge === undefined) {
    checks.push({
      name: "Bridge answers isReservedDeposit",
      ok: false,
      detail: "not probed: the validator's bridge() could not be read",
    })
  } else {
    // The validator's own Bridge, not the record or the override: that is the
    // address its reserved-deposit rule calls for every deposit in a proposal.
    const probe = await bridgeAnswersIsReservedDeposit(
      input.provider,
      declaredBridge
    )
    checks.push({
      name: "Bridge answers isReservedDeposit",
      ok: probe.ok,
      detail: probe.detail,
    })
  }

  checks.push({
    name: "activation block is above the release block",
    ok: input.activationBlock > input.releaseBlock,
    detail: `activation ${input.activationBlock} > release ${input.releaseBlock}`,
  })
  checks.push({
    name: "activation block is at or below the setVaultStatus block",
    ok: input.activationBlock <= input.setVaultStatusBlock,
    detail: `activation ${input.activationBlock} <= setVaultStatus ${input.setVaultStatusBlock}`,
  })

  return {
    checks,
    declaredBridge,
    failed: checks.filter((check) => !check.ok).length,
  }
}
