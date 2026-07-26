/**
 * Assertion helpers for tests written against viem.
 *
 * `@nomiclabs/hardhat-waffle` installs chai matchers that understand ethers
 * contracts and ethers transaction responses. None of them work on a viem
 * transaction hash, so a test migrated to viem loses `revertedWith`, `emit`
 * and `withArgs` outright.
 *
 * Nomic's viem-native replacement exists but is Hardhat 3 only: the
 * `@nomicfoundation/hardhat-viem-matchers` prerelease was renamed to
 * `@nomicfoundation/hardhat-viem-assertions`, which is stable and maintained
 * but peer-depends on `hardhat@^3.8.0`. On Hardhat 2 there is nothing to
 * install, so the matchers have to be hand-written; this module is that layer.
 *
 * It covers what the migrated file needs: `revertedWith`, `emit`,
 * `emit(...).withArgs(...)` and the negation of `emit`. The suite uses more
 * than that and the rest is not written yet — `changeEtherBalance` (17 sites)
 * and the bare `to.be.reverted` with no reason (2 sites) have no equivalent
 * here.
 *
 * `test/helpers/viem.test.ts` is the proof that these fail when they should,
 * which for a hand-written matcher is the only thing separating it from no
 * matcher at all.
 */
import { expect } from "chai"
import {
  BaseError,
  ContractFunctionRevertedError,
  getAbiItem,
  getAddress,
  parseEventLogs,
} from "viem"

import type {
  Abi,
  AbiEvent,
  AbiParameter,
  Address,
  Hash,
  PublicClient,
} from "viem"

/** The emitting side of an event assertion: any viem contract instance. */
export interface EventEmitter {
  address: Address
  abi: Abi
}

/** One parsed log, in the shape this module needs. */
interface ParsedLog {
  address: string
  args?: Record<string, unknown> | readonly unknown[]
}

/**
 * Pulls the revert reason out of whatever viem threw.
 *
 * A reverting `write` surfaces two different ways depending on where the node
 * rejected it. A contract-level revert viem could decode arrives as a
 * `ContractFunctionRevertedError` carrying `reason`; a revert caught during
 * gas estimation arrives only as Hardhat's own message nested in the error
 * chain, so it has to be read back out of the text.
 */
function revertReason(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk(
      (candidate) => candidate instanceof ContractFunctionRevertedError
    ) as ContractFunctionRevertedError | null

    if (reverted?.reason !== undefined) {
      return reverted.reason
    }
    if (reverted?.data?.errorName !== undefined) {
      return reverted.data.errorName
    }
  }

  const text = error instanceof Error ? error.message : String(error)

  const withReason = text.match(/reverted with reason string ['"](.*?)['"]/)
  if (withReason !== null) {
    return withReason[1]
  }

  const customError = text.match(/reverted with custom error ['"](.*?)['"]/)
  if (customError !== null) {
    return customError[1]
  }

  return text
}

/**
 * Replaces `await expect(tx).to.be.revertedWith(reason)`.
 *
 * Takes the unawaited call, because a viem `write` that reverts rejects on
 * the way out rather than resolving to something a matcher can inspect.
 */
export async function expectRevert(
  call: Promise<unknown>,
  reason: string
): Promise<void> {
  let error: unknown
  let reverted = false

  try {
    await call
  } catch (caught) {
    error = caught
    reverted = true
  }

  if (!reverted) {
    expect.fail(`expected a revert with "${reason}", but the call succeeded`)
  }

  expect(revertReason(error)).to.equal(reason)
}

/**
 * Normalises one decoded event argument against its declared ABI type.
 *
 * Normalising by the *declared* type rather than by the JavaScript runtime
 * type is the whole point. Both sides arrive in whatever shape their author
 * wrote — viem decodes `uint256` to `bigint` while tests write number
 * literals, and it checksums addresses while tests hold whatever case they
 * were given — so some coercion is unavoidable. Coercing by runtime type is
 * what makes it unsound: rendering every numeric as its decimal string lets
 * the string `"123456"` satisfy a `uint256` that carried `123456`. Keyed on
 * the ABI, a `string` parameter never gets numeric treatment and the two
 * cannot collide.
 */
export function normalizeArg(type: AbiParameter, value: unknown): unknown {
  const solidityType = type.type

  if (/\[\d*\]$/.test(solidityType)) {
    const element = {
      ...type,
      type: solidityType.replace(/\[\d*\]$/, ""),
    } as AbiParameter
    return Array.isArray(value)
      ? value.map((item) => normalizeArg(element, item))
      : value
  }

  if (solidityType === "tuple") {
    const components =
      (type as { components?: readonly AbiParameter[] }).components ?? []
    const source = value as Record<string, unknown> | readonly unknown[]
    return components.map((component, index) =>
      normalizeArg(
        component,
        Array.isArray(source)
          ? source[index]
          : (source as Record<string, unknown>)[component.name ?? `${index}`]
      )
    )
  }

  // Every scalar is tagged with the family it was normalised as. Coercion
  // within a family is wanted — `1`, `1n` and `"1"` should all satisfy a
  // `uint256`. Coercion *across* families is the bug: untagged, a `string`
  // parameter carrying "100" is satisfied by the number `100`, and a
  // `uint256` carrying 100 is satisfied by the string "100". The tag makes
  // those two values distinguishable while leaving the useful coercion alone.
  if (solidityType === "address") {
    return ["address", getAddress(String(value))]
  }

  if (/^u?int\d*$/.test(solidityType)) {
    return ["integer", BigInt(value as string | number | bigint).toString()]
  }

  if (solidityType === "bool") {
    return ["bool", Boolean(value)]
  }

  if (solidityType === "string") {
    return ["string", String(value)]
  }

  // `bytes` and `bytesN`: hex, compared without regard to case.
  return ["bytes", String(value).toLowerCase()]
}

/** Orders a decoded `args` object by the event's declared parameter order. */
function positionalArgs(
  event: AbiEvent,
  args: Record<string, unknown> | readonly unknown[] | undefined
): unknown[] {
  if (args === undefined) {
    return []
  }
  return event.inputs.map((input, index) =>
    Array.isArray(args)
      ? args[index]
      : (args as Record<string, unknown>)[input.name ?? `${index}`]
  )
}

/** `JSON.stringify` throws on a bigint, which would mask the real failure. */
function describeValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? `${item}` : item
  )
}

/** Every log of `eventName` in the receipt that `emitter` itself produced. */
async function logsFrom(
  publicClient: PublicClient,
  hash: Hash,
  emitter: EventEmitter,
  eventName: string
): Promise<ParsedLog[]> {
  const receipt = await publicClient.getTransactionReceipt({ hash })

  const parsed = parseEventLogs({
    abi: emitter.abi,
    eventName,
    logs: receipt.logs,
  }) as unknown as ParsedLog[]

  return parsed.filter(
    (log) => getAddress(log.address) === getAddress(emitter.address)
  )
}

/**
 * Replaces `await expect(tx).to.emit(contract, name).withArgs(...)`.
 *
 * Omit `args` for the bare `to.emit(contract, name)` form. Matching is
 * "some log in the receipt matches", which is what the waffle matcher did.
 */
export async function expectEvent(
  publicClient: PublicClient,
  hash: Hash,
  emitter: EventEmitter,
  eventName: string,
  args?: unknown[]
): Promise<void> {
  const logs = await logsFrom(publicClient, hash, emitter, eventName)

  expect(
    logs.length,
    `expected ${eventName} to be emitted by ${emitter.address}`
  ).to.be.greaterThan(0)

  if (args === undefined) {
    return
  }

  const event = getAbiItem({ abi: emitter.abi, name: eventName }) as
    | AbiEvent
    | undefined

  if (event === undefined) {
    expect.fail(`${eventName} is not in the ABI of ${emitter.address}`)
  }

  if (args.length !== event.inputs.length) {
    expect.fail(
      `${eventName} takes ${event.inputs.length} arguments, but ` +
        `${args.length} were expected`
    )
  }

  const expected = event.inputs.map((input, index) =>
    normalizeArg(input, args[index])
  )
  const seen = logs.map((log) =>
    positionalArgs(event, log.args).map((value, index) =>
      normalizeArg(event.inputs[index], value)
    )
  )

  expect(
    seen,
    `expected ${eventName} with args ${describeValue(expected)}`
  ).to.deep.include(expected)
}

/** Replaces `await expect(tx).to.not.emit(contract, name)`. */
export async function expectNoEvent(
  publicClient: PublicClient,
  hash: Hash,
  emitter: EventEmitter,
  eventName: string
): Promise<void> {
  const logs = await logsFrom(publicClient, hash, emitter, eventName)

  expect(
    logs.length,
    `expected ${eventName} not to be emitted by ${emitter.address}`
  ).to.equal(0)
}
