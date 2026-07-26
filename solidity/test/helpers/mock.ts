/*
 * The `__mock__*` names below are the administrative entry points of
 * `MockContract.sol`, deliberately namespaced there so they cannot be confused
 * with — or collide with — a function of the interface being mocked. They are
 * dictated by the contract, so the dangling-underscore rule does not apply.
 */
/* eslint-disable no-underscore-dangle */
import { ethers, artifacts } from "hardhat"

import type { BigNumberish, Contract, Signer } from "ethers"
import type { FunctionFragment, Interface, ParamType } from "ethers/lib/utils"

/**
 * Programmable contract mock, replacing `@defi-wonderland/smock`.
 *
 * smock configured its fakes by mutating in-process JavaScript state inside
 * Hardhat's EVM, which is why its API was synchronous — and also why it broke
 * on Hardhat >= 2.20 and is archived upstream with no forward path. This
 * replacement drives an ordinary deployed contract (`MockContract.sol`)
 * over the public provider API, so it depends on nothing Hardhat can change
 * underneath it.
 *
 * The consequence is that configuration is a transaction, so every setup and
 * inspection call here returns a promise and must be awaited. That is the one
 * behavioural difference from smock and the reason the migration touches call
 * sites at all.
 *
 * Semantics follow Foundry's `vm.mockCall` deliberately: an exact-calldata
 * entry wins over a selector-wide default, and an unconfigured function
 * returns the zero value of its return type, matching smock.
 *
 * That last part is not free. Solidity compares returndatasize against the
 * size its ABI expects and reverts on a short answer, so a mock cannot answer
 * an unconfigured function with empty data — it has to return a correctly
 * encoded zero. Only this helper knows the mocked ABI, so it computes those
 * encodings up front and installs them in the mock as a base layer that
 * `reset` does not disturb.
 */

/** A recorded call, decoded against the mocked interface. */
export interface MockCall {
  /** Decoded arguments, in declaration order. */
  args: unknown[]
}

/** Configuration and inspection handle for one function of a mock. */
export interface MockedFunction {
  /**
   * Answers every call to this function with `value`, unless a
   * `whenCalledWith` entry matches first. Call with no argument for a function
   * that returns nothing.
   */
  returns(value?: unknown): Promise<void>
  /** Makes every call to this function revert. */
  reverts(reason?: string): Promise<void>
  /** Narrows the next `returns`/`reverts` to one exact argument list. */
  whenCalledWith(...args: unknown[]): {
    returns(value?: unknown): Promise<void>
    reverts(reason?: string): Promise<void>
  }
  /** Drops every response configured for this function and every call recorded for it. */
  reset(): Promise<void>
  /** Number of calls recorded for this function. */
  callCount(): Promise<number>
  /** The i-th recorded call, decoded. */
  getCall(index: number): Promise<MockCall>
  /** Every recorded call, decoded. */
  getCalls(): Promise<MockCall[]>
}

export type Mock<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown
    ? T[K] & MockedFunction
    : T[K]
} & {
  address: string
  /** Signer that sends from the mock's own address, as smock's `fake.wallet` did. */
  wallet: Signer
  /** Underlying deployed `MockContract`, for anything this helper does not wrap. */
  mockContract: Contract
  /** Drops all configured responses and all recorded calls. */
  reset(): Promise<void>
}

/** Selectors of `MockContract`'s own administrative entry points. */
function adminSelectors(mockInterface: Interface): Set<string> {
  return new Set(
    Object.keys(mockInterface.functions)
      .filter((signature) => signature.startsWith("__mock__"))
      .map((signature) => mockInterface.getSighash(signature))
  )
}

/**
 * `MockContract` answers the mocked interface through its fallback, so its own
 * `__mock__*` entry points share the selector space with whatever is being
 * mocked. A four-byte collision would silently shadow a real function, which
 * would be a very confusing test failure. It cannot happen by accident, but it
 * costs nothing to prove rather than assume.
 */
function assertNoSelectorCollision(
  target: Interface,
  mockInterface: Interface,
  targetName: string
): void {
  const reserved = adminSelectors(mockInterface)

  Object.keys(target.functions).forEach((signature) => {
    const selector = target.getSighash(signature)
    if (reserved.has(selector)) {
      throw new Error(
        `${targetName}.${signature} has selector ${selector}, which collides ` +
          "with a MockContract administrative function. This mock cannot " +
          "represent that interface."
      )
    }
  })
}

function fragmentsByName(target: Interface): Map<string, FunctionFragment[]> {
  const byName = new Map<string, FunctionFragment[]>()

  Object.values(target.functions).forEach((fragment) => {
    const existing = byName.get(fragment.name)
    if (existing) {
      existing.push(fragment)
    } else {
      byName.set(fragment.name, [fragment])
    }
  })

  return byName
}

/**
 * Picks the fragment to use for a name. Overloads are ambiguous by name alone;
 * rather than guess, fail loudly and let the caller address the mock's
 * `mockContract` directly.
 */
function resolveFragment(
  fragments: FunctionFragment[],
  name: string,
  targetName: string
): FunctionFragment {
  if (fragments.length > 1) {
    throw new Error(
      `${targetName}.${name} is overloaded (${fragments.length} signatures). ` +
        "Address it through the mock's mockContract handle instead."
    )
  }

  return fragments[0]
}

/**
 * The zero value of an ABI type, shaped the way `defaultAbiCoder` wants it.
 *
 * Dynamic types cannot be zero-filled word-wise, and tuples have to be built
 * component by component, so this walks the type rather than assuming a flat
 * layout.
 */
function zeroValueFor(type: ParamType): unknown {
  if (type.baseType === "array") {
    if (type.arrayLength === -1) {
      return []
    }
    return Array.from({ length: type.arrayLength }, () =>
      zeroValueFor(type.arrayChildren)
    )
  }

  if (type.baseType === "tuple") {
    return type.components.map((component) => zeroValueFor(component))
  }

  if (type.baseType === "address") {
    return ethers.constants.AddressZero
  }

  if (type.baseType === "bool") {
    return false
  }

  if (type.baseType === "string") {
    return ""
  }

  if (type.baseType === "bytes") {
    return "0x"
  }

  const fixedBytes = /^bytes(\d+)$/.exec(type.baseType)
  if (fixedBytes) {
    return `0x${"00".repeat(Number(fixedBytes[1]))}`
  }

  // Everything left is uint*/int*.
  return 0
}

function encodeReturn(fragment: FunctionFragment, value: unknown): string {
  if (fragment.outputs === null || fragment.outputs.length === 0) {
    return "0x"
  }

  // A single-output function is configured with a bare value; a multi-output
  // one with an array, as smock did.
  const values =
    fragment.outputs.length === 1 && !Array.isArray(value) ? [value] : value

  return ethers.utils.defaultAbiCoder.encode(
    fragment.outputs,
    values as unknown[]
  )
}

function encodeRevert(reason?: string): string {
  if (reason === undefined) {
    return "0x"
  }

  return (
    ethers.utils.id("Error(string)").slice(0, 10) +
    ethers.utils.defaultAbiCoder.encode(["string"], [reason]).slice(2)
  )
}

/**
 * Deploys a programmable mock answering `target`'s interface.
 *
 * @param target Name of the contract or interface to mock, as passed to
 *        `artifacts.readArtifact` — e.g. `"IBridge"`.
 * @param options.address Deploy the mock at this exact address, replacing
 *        whatever is there. Mirrors smock's `{ address }` option.
 * @returns A handle exposing each of `target`'s functions with `returns`,
 *          `whenCalledWith`, `reverts`, `reset`, `callCount` and `getCall`.
 */
export async function createMock<T>(
  target: string,
  options: { address?: string } = {}
): Promise<Mock<T>> {
  const targetArtifact = await artifacts.readArtifact(target)
  const targetInterface = new ethers.utils.Interface(targetArtifact.abi)

  const mockFactory = await ethers.getContractFactory("MockContract")
  let mockContract = await mockFactory.deploy()
  await mockContract.deployed()

  assertNoSelectorCollision(targetInterface, mockContract.interface, target)

  // Install the response of last resort for every function, so an unstubbed
  // one answers with a correctly sized zero instead of reverting the caller.
  const baseFragments = Object.values(targetInterface.functions)
  const baseSelectors = baseFragments.map((fragment) =>
    targetInterface.getSighash(fragment)
  )
  const baseReturns = baseFragments.map((fragment) =>
    fragment.outputs === null || fragment.outputs.length === 0
      ? "0x"
      : ethers.utils.defaultAbiCoder.encode(
          fragment.outputs,
          fragment.outputs.map((output) => zeroValueFor(output))
        )
  )
  await mockContract.__mock__setBaseReturns(baseSelectors, baseReturns)

  if (options.address !== undefined) {
    // Move the deployed bytecode to the requested address. The mock's storage
    // starts empty there, which is what a freshly configured mock expects.
    const code = await ethers.provider.getCode(mockContract.address)
    await ethers.provider.send("hardhat_setCode", [options.address, code])
    mockContract = mockContract.attach(options.address)
  }

  await ethers.provider.send("hardhat_impersonateAccount", [
    mockContract.address,
  ])
  await ethers.provider.send("hardhat_setBalance", [
    mockContract.address,
    "0x21e19e0c9bab2400000", // 10_000 ETH, so the mock can pay for its own sends
  ])
  const wallet = await ethers.getSigner(mockContract.address)

  const byName = fragmentsByName(targetInterface)

  function buildFunction(name: string): MockedFunction {
    const fragment = resolveFragment(byName.get(name) ?? [], name, target)
    const selector = targetInterface.getSighash(fragment)

    const setForCalldata = async (
      args: unknown[],
      behaviour: "return" | "revert",
      payload: unknown
    ): Promise<void> => {
      const callData = targetInterface.encodeFunctionData(
        fragment,
        args as never[]
      )

      if (behaviour === "return") {
        await mockContract.__mock__setReturnForCalldata(
          callData,
          encodeReturn(fragment, payload)
        )
      } else {
        await mockContract.__mock__setRevertForCalldata(
          callData,
          encodeRevert(payload as string | undefined)
        )
      }
    }

    const decodeCall = (callData: string): MockCall => ({
      args: Array.from(
        targetInterface.decodeFunctionData(fragment, callData)
      ) as unknown[],
    })

    return {
      async returns(value?: unknown): Promise<void> {
        await mockContract.__mock__setReturnForSelector(
          selector,
          encodeReturn(fragment, value)
        )
      },

      async reverts(reason?: string): Promise<void> {
        await mockContract.__mock__setRevertForSelector(
          selector,
          encodeRevert(reason)
        )
      },

      whenCalledWith(...args: unknown[]) {
        return {
          returns: (value?: unknown) => setForCalldata(args, "return", value),
          reverts: (reason?: string) => setForCalldata(args, "revert", reason),
        }
      },

      async reset(): Promise<void> {
        await mockContract.__mock__resetSelector(selector)
      },

      async callCount(): Promise<number> {
        const count: BigNumberish =
          await mockContract.__mock__callCountForSelector(selector)
        return Number(count)
      },

      async getCall(index: number): Promise<MockCall> {
        const callData: string = await mockContract.__mock__callForSelectorAt(
          selector,
          index
        )
        return decodeCall(callData)
      },

      async getCalls(): Promise<MockCall[]> {
        const count: BigNumberish =
          await mockContract.__mock__callCountForSelector(selector)
        const calls: MockCall[] = []

        for (let i = 0; i < Number(count); i++) {
          // Sequential on purpose: ordering is the point of this accessor.
          // eslint-disable-next-line no-await-in-loop
          const callData: string = await mockContract.__mock__callForSelectorAt(
            selector,
            i
          )
          calls.push(decodeCall(callData))
        }

        return calls
      },
    }
  }

  const functions = new Map<string, MockedFunction>()
  const readContract = new ethers.Contract(
    mockContract.address,
    targetArtifact.abi,
    ethers.provider
  )

  const handle = {
    address: mockContract.address,
    wallet,
    mockContract,
    async reset(): Promise<void> {
      await mockContract.__mock__reset()
    },
  }

  return new Proxy(handle, {
    get(base, property: string | symbol, receiver) {
      if (typeof property !== "string" || property in base) {
        return Reflect.get(base, property, receiver)
      }

      if (!byName.has(property)) {
        return Reflect.get(base, property, receiver)
      }

      if (!functions.has(property)) {
        // Callable like the contract itself, so a test can read through the
        // mock, with the configuration surface hung off the same object —
        // which is the shape smock's fakes had.
        const callable = (...args: unknown[]) => readContract[property](...args)
        functions.set(
          property,
          Object.assign(callable, buildFunction(property)) as MockedFunction
        )
      }

      return functions.get(property)
    },
  }) as unknown as Mock<T>
}

export default createMock
