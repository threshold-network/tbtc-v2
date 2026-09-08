import { assert } from "chai"
import { backoffRetrier, Hex, skipRetryWhenMatched } from "../../src"

describe("Utils", () => {
  describe("Hex", () => {
    const stringUnprefixed =
      "6e30e6da7a7881a70de2a1cf67b77f2f643e58eb0d055b0f5ef85802a9167727"
    const stringPrefixed =
      "0x6e30e6da7a7881a70de2a1cf67b77f2f643e58eb0d055b0f5ef85802a9167727"
    const stringReversed =
      "277716a90258f85e0f5b050deb583e642f7fb767cfa1e20da781787adae6306e"

    const validInputTests = [
      {
        name: "unprefixed string",
        input: stringUnprefixed,
        expectedString: stringUnprefixed,
        expectedPrefixedString: stringPrefixed,
      },
      {
        name: "prefixed string",
        input: stringPrefixed,
        expectedString: stringUnprefixed,
        expectedPrefixedString: stringPrefixed,
      },
      {
        name: "prefixed uppercase string",
        input: stringPrefixed.toUpperCase(),
        expectedString: stringUnprefixed,
        expectedPrefixedString: stringPrefixed,
      },
      {
        name: "string with leading and trailing zeros",
        input: "00000a12d073c00000",
        expectedString: "00000a12d073c00000",
        expectedPrefixedString: "0x00000a12d073c00000",
      },
      {
        name: "empty string",
        input: "",
        expectedString: "",
        expectedPrefixedString: "",
      },
      {
        name: "unprefixed buffer",
        input: Buffer.from(stringUnprefixed, "hex"),
        expectedString: stringUnprefixed,
        expectedPrefixedString: stringPrefixed,
      },
      {
        name: "unprefixed uppercase buffer",
        input: Buffer.from(stringUnprefixed.toUpperCase(), "hex"),
        expectedString: stringUnprefixed,
        expectedPrefixedString: stringPrefixed,
      },
      {
        name: "empty buffer",
        input: Buffer.from("", "hex"),
        expectedString: "",
        expectedPrefixedString: "",
      },
    ]

    const invalidInputTests = [
      {
        name: "string with a character out of 0-9,a-z,A-Z",
        input: "3a9f5G",
        expectedErrorMessage: "invalid format of hex string",
      },
      {
        name: "string of odd length",
        input: "ab12345",
        expectedErrorMessage: "invalid length of hex string: 7",
      },
    ]

    validInputTests.forEach(
      ({ name, input, expectedString, expectedPrefixedString }) => {
        context(`with input as ${name}`, () => {
          const hex = Hex.from(input)

          describe("`${hex}`", () => {
            it("should output expected string", () => {
              const actual = `${hex}`
              assert.equal(actual, expectedString)
            })
          })

          describe("toString", () => {
            it("should output expected string", () => {
              const actual = hex.toString()
              assert.equal(actual, expectedString)
            })
          })

          describe("toPrefixedString", () => {
            it("should output expected string", () => {
              const actual = hex.toPrefixedString()
              assert.equal(actual, expectedPrefixedString)
            })
          })
        })
      }
    )

    invalidInputTests.forEach(({ name, input, expectedErrorMessage }) => {
      context(`with input as ${name}`, () => {
        it(`should throw error with message: ${expectedErrorMessage}`, () => {
          assert.throws(
            () => {
              Hex.from(input)
            },
            Error,
            expectedErrorMessage
          )
        })
      })
    })

    describe("reverse", () => {
      const hex = Hex.from(stringPrefixed)
      const hexReversed = hex.reverse()

      it("should not modify source hex", () => {
        assert.equal(hex.toString(), stringUnprefixed)
      })

      it("should reverse target hex", () => {
        assert.equal(hexReversed.toString(), stringReversed)
      })
    })

    describe("toBuffer", () => {
      const hex = Hex.from(stringPrefixed)
      const expectedBuffer = Buffer.from(stringUnprefixed, "hex")

      it("should output a buffer", () => {
        assert.deepEqual(hex.toBuffer(), expectedBuffer)
      })

      it("should not modify source hex when target buffer is changed", () => {
        const buffer = hex.toBuffer()
        buffer.reverse()

        assert.equal(hex.toString(), stringUnprefixed)
      })
    })

    describe("equals", () => {
      const hexLowerCased = Hex.from(stringPrefixed.toLowerCase())
      const hexUpperCased = Hex.from(stringPrefixed.toUpperCase())

      context("for the same values with matching cases", () => {
        it("should return true", () => {
          assert.isTrue(hexUpperCased.equals(hexUpperCased))
        })
      })

      context("for the same values but not matching cases", () => {
        it("should return true", () => {
          assert.isTrue(hexLowerCased.equals(hexUpperCased))
        })
      })

      context("for the same value but prefixed and unprefixed", () => {
        it("should return true", () => {
          assert.isTrue(
            Hex.from(stringPrefixed).equals(Hex.from(stringUnprefixed))
          )
        })
      })

      context("for different values", () => {
        it("should return false", () => {
          const otherValue: Hex = Hex.from(stringPrefixed.slice(-2))
          assert.isFalse(hexLowerCased.equals(otherValue))
        })
      })
    })
  })
})

describe("backoffRetrier with skipRetryWhenMatched", () => {
  // The exact revert reason the WalletRegistry contract produces for
  // closed/terminated wallets. Pinned here so a contract-side rewording
  // breaks a test instead of silently restoring the retry behavior.
  const notRegisteredRevert = "Wallet with the given ID has not been registered"

  const retrier = <T>() =>
    backoffRetrier<T>(
      3,
      1,
      () => {},
      skipRetryWhenMatched([notRegisteredRevert])
    )

  it("should not retry when the error matches a non-retryable pattern", async () => {
    let attempts = 0
    let caughtError: Error | undefined

    try {
      await retrier<void>()(async () => {
        attempts += 1
        throw new Error(
          `call revert exception; reason="${notRegisteredRevert}"`
        )
      })
    } catch (error) {
      caughtError = error as Error
    }

    assert.isDefined(caughtError)
    assert.include(caughtError!.message, notRegisteredRevert)
    assert.equal(attempts, 1)
  })

  it("should keep retrying errors that do not match", async () => {
    let attempts = 0
    let caughtError: Error | undefined

    try {
      await retrier<void>()(async () => {
        attempts += 1
        throw new Error("server unavailable")
      })
    } catch (error) {
      caughtError = error as Error
    }

    assert.isDefined(caughtError)
    assert.include(caughtError!.message, "server unavailable")
    // `retries` guarded attempts plus the final unguarded attempt.
    assert.equal(attempts, 4)
  })

  it("should return the result when a retried call eventually succeeds", async () => {
    let attempts = 0

    const result = await retrier<string>()(async () => {
      attempts += 1
      if (attempts < 2) {
        throw new Error("server unavailable")
      }
      return "ok"
    })

    assert.equal(result, "ok")
    assert.equal(attempts, 2)
  })
})
