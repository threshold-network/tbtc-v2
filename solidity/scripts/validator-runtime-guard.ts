/**
 * Runtime-code discriminators for the M1 `WalletProposalValidator`.
 *
 * The release gate for step 3a ("the validator address the client config names
 * has deployedBytecode containing `require(!bridge.isReservedDeposit(...))`")
 * cannot be a plain substring search: solc stores a revert message as a run of
 * 32-byte words carrying 31 bytes of payload each, so
 * `"Reserved deposits must not be swept"` never appears contiguously even in a
 * build that carries it. A search for the literal text reports the *correct*
 * build as missing.
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
 * The revert message is still checked, via its 31-byte words, as a second,
 * independent signal.
 */
/* eslint-disable no-restricted-syntax -- walking the message's 31-byte words in order */

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
export const SELECTOR_IS_RESERVED_DEPOSIT = selectorOf("isReservedDeposit(uint256)")

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
 * Reports whether the given message is present in EVM runtime code.
 *
 * solc emits a long string as a sequence of `PUSH32` words carrying 31 payload
 * bytes each (the 32nd byte is the opcode slot), so the check re-chunks the
 * message the same way and requires its words to appear in order. Opcodes
 * between the words are ignored.
 */
export function revertStringPresent(code: string, message: string): boolean {
  const bytes = Buffer.from(message, "ascii")
  const words: string[] = []
  for (let i = 0; i < bytes.length; i += 31) {
    words.push(bytes.subarray(i, i + 31).toString("hex"))
  }
  let cursor = 0
  for (const word of words) {
    const at = code.indexOf(word, cursor)
    if (at < 0) return false
    cursor = at + word.length
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
      detail: `"${RESERVED_SWEEP_REVERT}" as 31-byte words`,
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
