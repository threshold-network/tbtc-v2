/**
 * Shape of the hand-rolled NttManager stand-in used by the NTT depositor tests.
 *
 * Be aware that this fake is inert. Its `address` is a freshly generated EOA,
 * so the contract under test never calls back into the JS object, and the
 * `returns`/`reset` members the suites hang off its methods are assigned as
 * empty functions — configuring one changes nothing. Those suites pass on
 * hardcoded expectations, not on anything the fake supplies.
 *
 * This interface therefore describes accesses, not behaviour. It exists
 * because the object was previously typed `Record<string, unknown>`, which
 * made every one of those accesses a type error. Replacing the fake with a
 * real `createMock` is the durable fix and is out of scope here.
 */
export interface FakeMethod {
  returns: (value?: unknown) => void
  reset: () => void
}

export interface FakeNttManager {
  address: string
  // The `never[]` parameters are what let the differently-shaped async
  // functions the suites define inline be assigned here. Nothing calls these
  // through this type, so the parameters never need to be nameable.
  transfer: ((...args: never[]) => Promise<number>) & FakeMethod
  quoteDeliveryPrice: ((...args: never[]) => Promise<unknown>) & FakeMethod
}
