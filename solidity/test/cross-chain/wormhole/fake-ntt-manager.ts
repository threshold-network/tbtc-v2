/**
 * Shape of the hand-rolled NttManager stand-in used by the NTT depositor tests.
 *
 * These suites do not use `createMock` — they build a plain object with the
 * methods the contract under test calls, then hang `returns`/`reset`/`call` off
 * those methods to drive and inspect them. The object was previously typed as
 * `Record<string, unknown>`, which made every one of those accesses a type
 * error, so the file's type-safety was fictional even though it ran.
 */
export interface FakeMethod {
  returns: (value?: unknown) => void
  reset: () => void
  call?: (...args: never[]) => unknown
}

export interface FakeNttManager {
  address: string
  transfer: ((...args: never[]) => Promise<number>) & FakeMethod
  quoteDeliveryPrice: ((...args: never[]) => Promise<unknown>) & FakeMethod
}
