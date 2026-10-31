import assert from "assert"
import fs from "fs"
import path from "path"
import { classifyRevert } from "../../scripts/rebate-batch-fork-rehearsal"

const test = it

/**
 * The rehearsal's negative control is only worth anything if a "reverted"
 * verdict rests on an EVM revert. These cases pin the classifier against
 * the error shapes the rehearsal actually sees on Hardhat and against the
 * infrastructure failures that must never be counted as reverts.
 */
describe("rebate-batch-fork-rehearsal (revert classification)", () => {
  describe("a bare revert is the only thing that proves the hazard", () => {
    test("recognises Hardhat's bare-revert error", () => {
      // The shape Hardhat raises for a revert with empty return data. The
      // error carries no `code` at all, which is why the classifier cannot
      // key on `code` alone.
      const error = Object.assign(
        new Error("Transaction reverted without a reason string"),
        { data: "0x", stackTrace: [] }
      )
      Object.defineProperty(error, "constructor", {
        value: { name: "SolidityError" },
      })
      assert.equal(classifyRevert(error).kind, "bare")
    })

    test("recognises ethers' CALL_EXCEPTION with empty return data", () => {
      const error = Object.assign(new Error("missing revert data"), {
        code: "CALL_EXCEPTION",
        data: "0x",
      })
      assert.equal(classifyRevert(error).kind, "bare")
    })

    test("recognises a JSON-RPC revert with no return data", () => {
      const error = Object.assign(new Error("execution reverted"), {
        code: "-32000",
        data: "0x",
      })
      assert.equal(classifyRevert(error).kind, "bare")
    })
  })

  describe("a revert with a payload is not a bare revert", () => {
    test("recognises an Error(string) revert", () => {
      const data =
        "0x08c379a0" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000004" +
        "6e6f706500000000000000000000000000000000000000000000000000000000"
      const error = Object.assign(
        new Error(
          "VM Exception while processing transaction: reverted with reason string 'nope'"
        ),
        { data, stackTrace: [] }
      )
      assert.equal(classifyRevert(error).kind, "reason")
    })

    test("recognises a custom-error revert", () => {
      const data =
        "0x1234567800000000000000000000000000000000000000000000000000000001"
      const error = Object.assign(
        new Error(
          "VM Exception while processing transaction: reverted with an unrecognized custom error (return data: 0x12345678)"
        ),
        { data, stackTrace: [] }
      )
      assert.equal(classifyRevert(error).kind, "custom-error")
    })

    test("recognises a panic revert", () => {
      const data =
        "0x4e487b71" +
        "0000000000000000000000000000000000000000000000000000000000000001"
      const error = Object.assign(new Error("VM Exception: panic"), {
        data,
        stackTrace: [],
      })
      assert.equal(classifyRevert(error).kind, "reason")
    })
  })

  describe("an infrastructure failure is never a revert", () => {
    test("rejects a transport timeout", () => {
      const error = Object.assign(new Error("request timed out"), {
        code: "TIMEOUT",
      })
      assert.equal(classifyRevert(error).kind, "not-a-revert")
    })

    test("rejects a nonce error", () => {
      const error = Object.assign(new Error("nonce has already been used"), {
        code: "NONCE_EXPIRED",
      })
      assert.equal(classifyRevert(error).kind, "not-a-revert")
    })

    test("rejects a funding error", () => {
      const error = Object.assign(
        new Error("insufficient funds for intrinsic transaction cost"),
        { code: "INSUFFICIENT_FUNDS" }
      )
      assert.equal(classifyRevert(error).kind, "not-a-revert")
    })

    test("rejects an argument-encoding error", () => {
      const error = Object.assign(new Error("invalid arrayify value"), {
        code: "INVALID_ARGUMENT",
      })
      assert.equal(classifyRevert(error).kind, "not-a-revert")
    })

    test("rejects a plain error with no revert shape at all", () => {
      assert.equal(classifyRevert(new Error("boom")).kind, "not-a-revert")
    })

    test("rejects a string that merely mentions a revert", () => {
      // The old classifier accepted anything that did not carry the two
      // Hardhat phrases, so a plain string was enough.
      assert.equal(
        classifyRevert("Transaction reverted without a reason string").kind,
        "not-a-revert"
      )
    })
  })
})

describe("rebate-batch-fork-rehearsal (entrypoint)", () => {
  test("does not run the rehearsal when it is imported", () => {
    // The counterexample the review named: this test file imports the
    // classifier, and the module's unconditional `main()` call started the
    // whole fork run beside the test suite. The head CI log shows it:
    // `Error: Fork block is 121, expected pinned 0`.
    //
    // The guard is `require.main === module`, the same one
    // `scripts/compare-pr1067-parity.ts` uses, and it holds under
    // `hardhat run`, which is how the script is invoked.
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "scripts",
        "rebate-batch-fork-rehearsal.ts"
      ),
      "utf8"
    )
    assert.ok(
      source.includes("if (require.main === module) {"),
      "the rehearsal must guard its entrypoint with require.main === module"
    )
    // The call to `main()` has to be inside that guard, not beside it.
    const guardIndex = source.indexOf("if (require.main === module) {")
    const callIndex = source.indexOf("main().catch(")
    assert.ok(guardIndex !== -1, "no entrypoint guard found")
    assert.ok(callIndex > guardIndex, "main() is called outside the guard")
  })
})
