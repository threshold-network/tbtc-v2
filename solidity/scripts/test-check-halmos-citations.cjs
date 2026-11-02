const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const { test } = require("node:test")

const { expressionPattern } = require("./check-halmos-citations")

const script = path.join(__dirname, "check-halmos-citations.js")

// A comparison operator has to be matched whole. `>` is the prefix of `>=`,
// so a substring test accepts the acceptance-floor relaxation the guard
// exists to catch: the needle below is a prefix of the mutated source line.
test("a strict comparison does not accept its non-strict form", () => {
  const needle = "uint256(deposit.amount) >"

  assert.equal(expressionPattern(needle).test(needle), true)
  assert.equal(
    expressionPattern(needle).test("uint256(deposit.amount) >="),
    false
  )
})

// The <= bound of the settlement fee check must not accept a strict
// comparison, which would read as a different rule.
test("a <= bound does not accept a < comparison", () => {
  const needle = "action.amount - anchorAmount <= action.txMaxFee"

  assert.equal(expressionPattern(needle).test(needle), true)
  assert.equal(
    expressionPattern(needle).test(
      "action.amount - anchorAmount < action.txMaxFee"
    ),
    false
  )
})

// A non-strict needle still matches, so bounding the operator does not make
// the entries written with `>=` unresolvable.
test("a non-strict comparison still matches itself", () => {
  const needle = "anchorAmount >= action.minAmount"

  assert.equal(expressionPattern(needle).test(needle), true)
})

// An operator in the middle of an expression is bounded too, which is what
// already caught this mutation before the fix.
test("a mid-expression operator is bounded", () => {
  const needle = "anchorAmount > txMaxFee + minAmount"

  assert.equal(expressionPattern(needle).test(needle), true)
  assert.equal(
    expressionPattern(needle).test("anchorAmount >= txMaxFee + minAmount"),
    false
  )
})

// The expected expressions are source text, not regular expressions.
test("regex metacharacters in an expected expression are literal", () => {
  const needle = "2 * uint256(txMaxFee)"

  assert.equal(expressionPattern(needle).test(needle), true)
  assert.equal(expressionPattern(needle).test("22uint256(txMaxFee)"), false)
})

// The whole point of the table: every citation has to resolve against the
// contracts in the tree, so a moved statement or a stale range fails here
// before it reaches a reviewer.
test("every citation resolves against the contracts at this head", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" })

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /all \d+ Halmos citations resolve/)
})
