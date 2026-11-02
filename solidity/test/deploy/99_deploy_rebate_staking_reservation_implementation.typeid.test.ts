import { expect } from "chai"
import { spawn } from "child_process"
import path from "path"

/**
 * The type-id scan must return, and a test of that has to be able to fail.
 *
 * `semanticTypeId` falls back to `stripAstIds` for a type id the layout's
 * `types` table does not know. An earlier `stripAstIds` read a nested
 * argument list with a flat index and stopped on a comma without consuming
 * it, so `t_mapping(t_address,t_bool)` made it loop forever. That is a
 * synchronous JavaScript loop: the event loop never yields, so mocha's own
 * timeout never fires and the whole suite (and the process) hangs at 100% of
 * a core instead of reporting a failure. A regression of that shape cannot
 * be caught by an `it` that makes the call in-process.
 *
 * The calls are therefore made in a child process, and the parent, whose
 * event loop is free, kills the child when it stops answering. A hang then
 * shows up as a failing test that names the type id it stalled on.
 *
 * The child loads the deploy script exactly as a ceremony would (through
 * ts-node, with hardhat resolved from the project root), so the module's
 * start-up cost is part of the run. The parent allows that start-up its own,
 * long, budget and starts the short per-call clock only once the child has
 * reported that the module is loaded.
 *
 * The budgets are real wall-clock timers on purpose: what is under test is a
 * hard kill of a real process that is spinning, which fake timers cannot
 * stand in for.
 */

const SOLIDITY_ROOT = path.join(__dirname, "..", "..")
const DEPLOY_SCRIPT = path.join(
  SOLIDITY_ROOT,
  "deploy",
  "99_deploy_rebate_staking_reservation_implementation.ts"
)

/** Time for the child to start node, ts-node and hardhat and load the script. */
const LOAD_BUDGET_MS = 120_000
/** Time the child gets for each call once it is loaded; a real call takes microseconds. */
const CALL_BUDGET_MS = 10_000

interface GuardedRun {
  /** One parsed JSON value per call the child answered, in order. */
  results: unknown[]
  /** The child stopped answering and was killed. */
  stalled: boolean
  /** `load` when the module never finished loading, `call` otherwise. */
  stalledIn: "load" | "call" | undefined
  /** How many calls had been answered when the child was killed. */
  answered: number
  exitCode: number | null
  stderr: string
}

/**
 * Runs `script` in a fresh node process and enforces a hard timeout on it.
 *
 * The child's protocol is line based on stdout: `READY` once it is ready to
 * start, then one `RESULT <json>` line per call. Writing to a pipe is
 * synchronous on Linux, so a line is on the wire before the next call starts.
 * Every line restarts the clock; silence for longer than the budget is a
 * stall and the child is killed with SIGKILL, which a spinning loop cannot
 * ignore.
 */
function runGuarded(params: {
  script: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  loadBudgetMs: number
  callBudgetMs: number
}): Promise<GuardedRun> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        "-e",
        params.script,
        ...(params.args ?? []),
      ],
      {
        cwd: SOLIDITY_ROOT,
        env: { ...process.env, ...params.env },
        stdio: ["ignore", "pipe", "pipe"],
      }
    )

    const run: GuardedRun = {
      results: [],
      stalled: false,
      stalledIn: undefined,
      answered: 0,
      exitCode: null,
      stderr: "",
    }
    let ready = false
    let buffered = ""
    let clock: NodeJS.Timeout | undefined

    const arm = (): void => {
      clearTimeout(clock)
      clock = setTimeout(
        () => {
          run.stalled = true
          run.stalledIn = ready ? "call" : "load"
          child.kill("SIGKILL")
        },
        ready ? params.callBudgetMs : params.loadBudgetMs
      )
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf("\n")
      while (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line === "READY") {
          ready = true
          arm()
        } else if (line.startsWith("RESULT ")) {
          run.results.push(JSON.parse(line.slice("RESULT ".length)))
          run.answered += 1
          arm()
        }
        newline = buffered.indexOf("\n")
      }
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      run.stderr += chunk
    })

    child.on("close", (code) => {
      clearTimeout(clock)
      run.exitCode = code
      resolve(run)
    })

    arm()
  })
}

/**
 * The child program for the real call: load the deploy script, say READY,
 * then answer one `semanticTypeId` call per input.
 */
const SEMANTIC_TYPE_ID_CHILD = `
const mod = require(process.env.D99_MODULE)
const inputs = JSON.parse(process.env.D99_INPUTS)
process.stdout.write("READY\\n")
for (const typeId of inputs) {
  process.stdout.write("RESULT " + JSON.stringify(mod.semanticTypeId(typeId)) + "\\n")
}
process.exit(0)
`

/**
 * What each type id has to come out as when the `types` table is absent.
 * The first row is the one that hung. Rows with an AST id lose it; the array
 * length after `)` is not an AST id and has to stay.
 */
const CASES: ReadonlyArray<{
  name: string
  typeId: string
  expected: string
}> = [
  {
    name: "a mapping of two plain types (the id that hung)",
    typeId: "t_mapping(t_address,t_bool)",
    expected: "t_mapping(t_address,t_bool)",
  },
  {
    name: "a mapping to a struct, as RebateStaking.stakes is",
    typeId: "t_mapping(t_address,t_struct(Stake)34999_storage)",
    expected: "t_mapping(t_address,t_struct(Stake))",
  },
  {
    name: "a mapping nested in a mapping",
    typeId: "t_mapping(t_address,t_mapping(t_uint256,t_bool))",
    expected: "t_mapping(t_address,t_mapping(t_uint256,t_bool))",
  },
  {
    name: "a comma inside a nested argument followed by a sibling argument",
    typeId: "t_mapping(t_mapping(t_address,t_uint256),t_bool)",
    expected: "t_mapping(t_mapping(t_address,t_uint256),t_bool)",
  },
  {
    name: "a mapping to an array of structs",
    typeId:
      "t_mapping(t_uint256,t_array(t_struct(Stake)34999_storage)dyn_storage)",
    expected: "t_mapping(t_uint256,t_array(t_struct(Stake))dyn_storage)",
  },
  {
    name: "a contract argument inside a mapping",
    typeId: "t_mapping(t_contract(IERC20Upgradeable)13046,t_uint256)",
    expected: "t_mapping(t_contract(IERC20Upgradeable),t_uint256)",
  },
  {
    name: "a single-argument struct id loses its AST id",
    typeId: "t_struct(Stake)34999_storage",
    expected: "t_struct(Stake)",
  },
  {
    name: "an array length is kept, it is not an AST id",
    typeId: "t_array(t_uint256)49_storage",
    expected: "t_array(t_uint256)49_storage",
  },
  {
    name: "a type id without arguments is returned as it is",
    typeId: "t_uint256",
    expected: "t_uint256",
  },
]

describe("deploy/99 type-id scan returns (finding: stripAstIds looped forever on a mapping)", () => {
  describe("the guard itself", () => {
    it("kills a child that spins and reports where it stalled", async () => {
      const run = await runGuarded({
        script: `
          process.stdout.write("READY\\n")
          process.stdout.write("RESULT 1\\n")
          for (;;) {}
        `,
        loadBudgetMs: 15_000,
        callBudgetMs: 1_000,
      })

      expect(run.stalled, "the spinning child was not killed").to.equal(true)
      expect(run.stalledIn).to.equal("call")
      expect(run.answered).to.equal(1)
      expect(run.exitCode, "SIGKILL leaves no exit code").to.equal(null)
    }).timeout(30_000)

    it("kills a child that never gets ready and says it was the load", async () => {
      const run = await runGuarded({
        script: "for (;;) {}",
        loadBudgetMs: 1_000,
        callBudgetMs: 1_000,
      })

      expect(run.stalled).to.equal(true)
      expect(run.stalledIn).to.equal("load")
      expect(run.answered).to.equal(0)
    }).timeout(30_000)
  })

  describe("semanticTypeId without a types table", () => {
    let run: GuardedRun

    before(async function runChild() {
      this.timeout(LOAD_BUDGET_MS + CASES.length * CALL_BUDGET_MS + 30_000)

      run = await runGuarded({
        script: SEMANTIC_TYPE_ID_CHILD,
        env: {
          D99_MODULE: DEPLOY_SCRIPT,
          D99_INPUTS: JSON.stringify(CASES.map(({ typeId }) => typeId)),
        },
        loadBudgetMs: LOAD_BUDGET_MS,
        callBudgetMs: CALL_BUDGET_MS,
      })
    })

    it("loads the deploy script and answers every call", () => {
      expect(
        run.stalled,
        run.stalled
          ? `the child stalled in ${run.stalledIn} after ${run.answered} of ` +
              `${CASES.length} calls; the call it was stuck on is ` +
              `${JSON.stringify(CASES[run.answered]?.typeId)}. stderr:\n${run.stderr}`
          : ""
      ).to.equal(false)
      expect(run.exitCode, run.stderr).to.equal(0)
      expect(run.answered).to.equal(CASES.length)
    })

    /** Why call `index` has no answer; only called when it has none. */
    const whyUnanswered = (index: number): string => {
      if (!run.stalled) {
        return `no answer: the child exited early. stderr:\n${run.stderr}`
      }
      if (index === run.answered) {
        return `no answer within ${CALL_BUDGET_MS} ms: the scan is looping on this id`
      }
      return `not reached: the child was killed earlier, stalled on ${CASES[run.answered]?.typeId}`
    }

    CASES.forEach(({ name, typeId, expected }, index) => {
      it(`${name}: ${typeId}`, () => {
        if (index >= run.answered) {
          expect.fail(whyUnanswered(index))
        }
        expect(run.results[index]).to.equal(expected)
      })
    })
  })
})
