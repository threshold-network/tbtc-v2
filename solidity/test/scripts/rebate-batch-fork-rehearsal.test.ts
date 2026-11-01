import assert from "assert"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import {
  assertStorageGate,
  compiledStorageLayout,
  readStorageLayoutFile,
} from "../../deploy/99_deploy_rebate_staking_reservation_implementation"
import {
  applyRehearsalStorageGate,
  classifyRevert,
} from "../../scripts/rebate-batch-fork-rehearsal"

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

describe("rebate-batch-fork-rehearsal (storage-layout gate)", () => {
  test("the gate the rehearsal calls rejects a swapped fee-mode enum", async () => {
    // The counterexample the review named. The semantic layout comparison
    // cannot see a reorder of `DepositOnly` and `RedemptionOnly`: the
    // pinned solc writes no enum members into the deployed layout, so the
    // comparison is relaxed for custom types. A reorder leaves the stored
    // byte width, the labels and the top-level slots unchanged, and the
    // rehearsal's actors are unstaked, so their calls never exercise a
    // persisted fee mode either. The rehearsal therefore has to apply the
    // enum-order pin itself, through the same gate the deploy script uses.
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "contracts",
        "bridge",
        "RebateStaking.sol"
      ),
      "utf8"
    )
    const swapped = source.replace(
      "enum RebateTreasuryFeeMode {\n        Both,\n        DepositOnly,\n        RedemptionOnly\n    }",
      "enum RebateTreasuryFeeMode {\n        Both,\n        RedemptionOnly,\n        DepositOnly\n    }"
    )
    assert.notEqual(swapped, source, "the enum in the source did not swap")

    const deployed = readStorageLayoutFile(
      path.join(
        __dirname,
        "..",
        "..",
        "deployments",
        "mainnet",
        "RebateStakingTIP109HotfixImplementation.json"
      )
    )
    const head = await compiledStorageLayout(
      "contracts/bridge/RebateStaking.sol:RebateStaking"
    )

    // The real source passes the whole gate.
    assertStorageGate({ deployed, head, stakingSource: source })

    // The swapped source fails it, at the enum pin.
    assert.throws(
      () => assertStorageGate({ deployed, head, stakingSource: swapped }),
      /declares \[Both, RedemptionOnly, DepositOnly\]/
    )
  })

  test("the rehearsal applies the whole gate, not only the layout parts", async () => {
    // The rehearsal has to apply the one gate that includes the enum pin.
    // Calling the two layout assertions on their own is what left the
    // reorder undetected.
    //
    // This is the rehearsal's own step, exercised: the step accepts the
    // real source and rejects a reordered one. A source-text scan of the
    // script could not prove that, because it says nothing about what the
    // step does when it runs.
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "contracts",
        "bridge",
        "RebateStaking.sol"
      ),
      "utf8"
    )
    const swapped = source.replace(
      "enum RebateTreasuryFeeMode {\n        Both,\n        DepositOnly,\n        RedemptionOnly\n    }",
      "enum RebateTreasuryFeeMode {\n        Both,\n        RedemptionOnly,\n        DepositOnly\n    }"
    )
    assert.notEqual(swapped, source, "the enum in the source did not swap")

    const swappedPath = path.join(
      os.tmpdir(),
      `rebate-rehearsal-swapped-${process.pid}.sol`
    )
    fs.writeFileSync(swappedPath, swapped)
    try {
      // The real source passes the step.
      const gate = await applyRehearsalStorageGate()
      assert.ok(gate.deployedFields > 0, "the step read no deployed fields")
      assert.ok(gate.headFields > 0, "the step read no head fields")

      // The reordered source fails it, at the enum pin.
      await assert.rejects(
        applyRehearsalStorageGate({ stakingSourcePath: swappedPath }),
        /declares \[Both, RedemptionOnly, DepositOnly\]/
      )
    } finally {
      fs.rmSync(swappedPath, { force: true })
    }
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
    //
    // The check is behavioural: the module is imported by a *real* entry
    // point, and the run has to end without the rehearsal having started.
    // A source-text scan of the guard would pass on a script whose guard is
    // never reached, or whose `main()` call sits beside the guard instead of
    // inside it.
    //
    // The entry is a file, not `node -e`: with `-e` there is no
    // `require.main`, so `require.main === module` would be false however
    // the script were written and the check would prove nothing.
    const entryPath = path.join(
      os.tmpdir(),
      `rebate-rehearsal-entry-${process.pid}.js`
    )
    fs.writeFileSync(
      entryPath,
      `require(${JSON.stringify(
        path.join(
          __dirname,
          "..",
          "..",
          "scripts",
          "rebate-batch-fork-rehearsal.ts"
        )
      )})\n`
    )
    const result = spawnSync(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", entryPath],
      {
        cwd: path.join(__dirname, "..", ".."),
        encoding: "utf8",
        timeout: 120_000,
      }
    )
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    assert.equal(result.status, 0, `importing the rehearsal failed:\n${output}`)
    // The rehearsal's first step announces itself. If `main()` had run, it
    // would have printed this and then failed on the pinned fork block.
    assert.ok(
      !output.includes("=== Step 1: impersonate actors ==="),
      `importing the rehearsal started the run:\n${output}`
    )
    assert.ok(
      !output.includes("Fork block is"),
      `importing the rehearsal started the run:\n${output}`
    )
    fs.rmSync(entryPath, { force: true })
  })
})
