const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { test } = require("node:test")
const { execSync } = require("node:child_process")

const root = path.resolve(__dirname, "..")

test("the repository Solhint policy rejects regressions", async (context) => {
  const solhintOutput = execSync(
    "npx solhint --formatter json 'contracts/**/*.sol'",
    { cwd: root, encoding: "utf8" }
  )

  const results = JSON.parse(solhintOutput)

  // Count warnings per rule. The JSON formatter's trailing summary object
  // has no filePath; entries with no ruleId are not rule violations.
  const warningCounts = results
    .filter((item) => item.filePath && item.ruleId)
    .reduce(
      (counts, { ruleId }) => ({
        ...counts,
        [ruleId]: (counts[ruleId] || 0) + 1,
      }),
      {}
    )

  // These are the actual empirical counts from the current tree, matching
  // the baseline documented in docs/toolchain-upgrades.md.
  const expectedWarningCounts = {
    ordering: 45,
    "func-name-mixedcase": 5,
    "event-name-capwords": 3,
    "max-states-count": 2,
  }

  await context.test("warning counts match baseline", () => {
    Object.entries(expectedWarningCounts).forEach(([ruleId, expectedCount]) => {
      const actualCount = warningCounts[ruleId] || 0
      assert.strictEqual(
        actualCount,
        expectedCount,
        `Rule ${ruleId}: expected ${expectedCount} warnings, got ${actualCount}`
      )
    })

    const unexpectedRules = Object.keys(warningCounts).filter(
      (ruleId) => !(ruleId in expectedWarningCounts)
    )
    assert.strictEqual(
      unexpectedRules.length,
      0,
      `Unexpected warning rules found: ${unexpectedRules.join(", ")}`
    )
  })

  const solhintConfigPath = path.join(root, ".solhint.json")
  const solhintConfig = JSON.parse(fs.readFileSync(solhintConfigPath, "utf8"))

  const securityRules = [
    "reentrancy",
    "avoid-low-level-calls",
    "avoid-call-value",
    "avoid-tx-origin",
    "check-send-result",
    "not-rely-on-time",
    "not-rely-on-block-hash",
    "avoid-sha3",
    "avoid-suicide",
    "avoid-throw",
    "no-inline-assembly",
    "no-complex-fallback",
    "multiple-sends",
  ]

  await context.test("security rules remain at error severity", () => {
    securityRules.forEach((rule) => {
      const config = solhintConfig.rules[rule]
      assert.ok(
        config !== undefined,
        `Security rule ${rule} is missing from .solhint.json`
      )
      // Config can be "error" or ["error", options]
      const severity = Array.isArray(config) ? config[0] : config
      assert.strictEqual(
        severity,
        "error",
        `Security rule ${rule} is not set to "error" (got "${severity}")`
      )
    })
  })
})
