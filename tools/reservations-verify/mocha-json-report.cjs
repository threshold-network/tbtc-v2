// Mocha reporter for the mutation harness: writes the run to a JSON file instead of stdout, so the
// compiler messages and the gas reporter that also write to stdout cannot corrupt it. Each entry
// carries the runnable type that Mocha holds on the object itself ("test" or "hook"), which is what
// keeps a hook failure apart from a failing test whose title merely looks like one.
//
// The event names come from the live runner's own constants, so this file needs no module
// resolution of its own: it lives outside the Hardhat project, where mocha is not installed.
const fs = require("fs")

const error = (err) => (err ? { name: err.name, message: err.message } : null)

const entry = (runnable, err) =>
  runnable
    ? {
        type: runnable.type,
        hook: runnable.originalTitle || null,
        title: runnable.title,
        fullTitle: runnable.fullTitle(),
        file: runnable.file,
        err: error(err || runnable.err),
      }
    : {
        type: null,
        hook: null,
        title: null,
        fullTitle: null,
        file: null,
        err: error(err),
      }

module.exports = class MutationJSONReporter {
  constructor(runner, options = {}) {
    const output =
      (options.reporterOption && options.reporterOption.output) ||
      process.env.MUTATION_JSON
    if (!output)
      throw new Error(
        "mocha-json-report needs reporterOptions.output or MUTATION_JSON"
      )
    const { constants } = runner.constructor
    const report = {
      stats: { tests: 0, passes: 0, failures: 0, pending: 0 },
      passes: [],
      failures: [],
      pending: [],
    }
    runner.on(constants.EVENT_TEST_END, () => {
      report.stats.tests += 1
    })
    runner.on(constants.EVENT_TEST_PASS, (runnable) => {
      report.stats.passes += 1
      report.passes.push(entry(runnable))
    })
    // The error is an argument of the event: a failing hook does not carry it on itself.
    runner.on(constants.EVENT_TEST_FAIL, (runnable, err) => {
      report.stats.failures += 1
      report.failures.push(entry(runnable, err))
    })
    runner.on(constants.EVENT_TEST_PENDING, (runnable) => {
      report.stats.pending += 1
      report.pending.push(entry(runnable))
    })
    runner.once(constants.EVENT_RUN_END, () => {
      fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    })
  }
}
