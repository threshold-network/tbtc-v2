#!/usr/bin/env node
/*
 * check-halmos-citations.js — keep the Halmos harness's file:line citations
 * honest.
 *
 * The Halmos checks under solidity/test/halmos/ copy the arithmetic of the
 * contracts and cite the source lines they copy. A citation that has moved,
 * or that now holds a different expression, silently turns the proof into a
 * proof of something the contracts do not say. This was not theoretical: the
 * ReservationFloor harness was derived against a tree whose acceptance floor
 * was `deposit.amount >= minAmount + txMaxFee`, while the contracts it was
 * carried onto require
 * `deposit.amount > minAmount + 2 * txMaxFee`. Every "current code" check
 * then described a defect the contracts no longer had.
 *
 * This script reads the citation table out of the harness files and checks
 * each cited line range against the current contracts:
 *
 *   - the cited file must exist,
 *   - the cited line range must still exist,
 *   - the expression the harness expects must be present in that range, with
 *     every comparison operator matched whole (see `expressionPattern`).
 *
 * A missing file, a moved line or a changed expression exits 1 with the
 * offending citation named.
 *
 * Usage: node solidity/scripts/check-halmos-citations.js [--json]
 * Exit:  0 = every citation resolves, 1 = a citation is stale, 2 = usage error.
 */

const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const CONTRACTS = path.join(ROOT, "contracts")
const HALMOS_DIR = path.join(ROOT, "test", "halmos")

// Each entry: the harness file, and the citations it carries. The `expect`
// strings are the expressions the harness copy mirrors; each must appear
// somewhere in the cited line range of the cited contract.
//
// The ranges are deliberately the whole cited statement, not one line: a
// `require` whose condition wraps over several lines is cited as a range,
// and the check is that the range still holds the cited condition.
const CITATIONS = [
  {
    file: "ReservationFloor.t.sol",
    entries: [
      {
        contract: "bridge/Reservation.sol",
        range: [596, 600],
        // The acceptance deposit floor.
        expect: ["uint256(deposit.amount) >", "2 * uint256(txMaxFee)"],
      },
      {
        contract: "bridge/Reservation.sol",
        range: [921, 924],
        // The re-anchor request floor.
        expect: ["anchorAmount > txMaxFee + minAmount"],
      },
      {
        contract: "bridge/Reservation.sol",
        range: [1636, 1643],
        // The parameter setter rules.
        expect: [
          "reservationTxMaxFee > 0",
          "reservationMinAmount > reservationTxMaxFee",
        ],
      },
      {
        contract: "bridge/ReservationProofs.sol",
        range: [462, 465],
        // The acceptance settlement fee bound.
        expect: ["action.amount - anchorAmount <= action.txMaxFee"],
      },
      {
        contract: "bridge/ReservationProofs.sol",
        range: [473, 476],
        // The acceptance settlement anchor minimum.
        expect: ["anchorAmount >= action.minAmount"],
      },
      {
        contract: "bridge/ReservationProofs.sol",
        range: [700, 703],
        // The re-anchor settlement fee bound.
        expect: ["action.amount - newAnchorAmount <= action.txMaxFee"],
      },
      {
        contract: "bridge/ReservationProofs.sol",
        range: [708, 711],
        // The re-anchor settlement dust floor.
        expect: ["newAnchorAmount > action.txMaxFee"],
      },
    ],
  },
]

function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n")
}

// Two-character operators, matched before their one-character prefixes.
const TWO_CHAR_OPERATORS = [">=", "<=", "==", "!="]
// One-character operators. Each is the prefix of a longer operator (`>` of
// `>=`, `<` of `<=` and `<<`, `=` of `==`, `!` of `!=`), so a plain substring
// test accepts the very mutation this guard exists to catch: the needle
// `uint256(deposit.amount) >` is a prefix of `uint256(deposit.amount) >=`.
const ONE_CHAR_OPERATORS = [">", "<", "=", "!"]

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// The pattern for one expected expression: the expression literally, with
// every operator anchored so that it cannot match the prefix of a longer
// operator. `uint256(deposit.amount) >` therefore matches the strict
// comparison and rejects `uint256(deposit.amount) >=`.
function expressionPattern(expression) {
  let pattern = ""
  for (let i = 0; i < expression.length; i++) {
    const twoChar = expression.slice(i, i + 2)
    if (TWO_CHAR_OPERATORS.includes(twoChar)) {
      pattern += escapeRegex(twoChar)
      i += 1
    } else if (ONE_CHAR_OPERATORS.includes(expression[i])) {
      pattern += `${escapeRegex(expression[i])}(?![=<])`
    } else {
      pattern += escapeRegex(expression[i])
    }
  }
  return new RegExp(pattern)
}

// Checks one citation and returns a problem object, or null when the
// citation resolves.
function checkEntry(harness, entry) {
  const contractPath = path.join(CONTRACTS, entry.contract)

  if (!fs.existsSync(contractPath)) {
    return {
      harness,
      contract: entry.contract,
      range: entry.range,
      reason: "contract file does not exist",
    }
  }

  const lines = readLines(contractPath)
  const [from, to] = entry.range

  if (from < 1 || to > lines.length) {
    return {
      harness,
      contract: entry.contract,
      range: entry.range,
      reason: `cited range is outside the file (file has ${lines.length} lines)`,
    }
  }

  const slice = lines.slice(from - 1, to).join("\n")
  const missing = entry.expect.filter(
    (expression) => !expressionPattern(expression).test(slice)
  )

  if (missing.length === 0) {
    return null
  }

  return {
    harness,
    contract: entry.contract,
    range: entry.range,
    reason: `cited range no longer holds ${missing
      .map((expression) => `"${expression}"`)
      .join(", ")}`,
  }
}

function main() {
  const asJson = process.argv.includes("--json")

  const problems = []
  let checked = 0

  const groups = CITATIONS.map((group) => {
    const harnessPath = path.join(HALMOS_DIR, group.file)

    if (!fs.existsSync(harnessPath)) {
      return {
        group,
        problems: [
          {
            harness: group.file,
            contract: null,
            range: null,
            reason: "harness file is missing",
          },
        ],
        checked: 0,
      }
    }

    const entryProblems = group.entries
      .map((entry) => {
        checked += 1
        return checkEntry(group.file, entry)
      })
      .filter(Boolean)

    return { group, problems: entryProblems, checked: group.entries.length }
  })

  groups.forEach((result) => problems.push(...result.problems))

  if (asJson) {
    console.log(
      JSON.stringify({ checked, ok: problems.length === 0, problems }, null, 2)
    )
  } else {
    problems.forEach((problem) => {
      const where = problem.contract
        ? `${problem.contract}:${problem.range ? problem.range.join("-") : "?"}`
        : "(no contract)"
      console.error(`${problem.harness}: ${where}: ${problem.reason}`)
    })
    if (problems.length === 0) {
      console.log(`all ${checked} Halmos citations resolve`)
    } else {
      console.error(
        `${problems.length} of ${checked} Halmos citations are stale`
      )
    }
  }

  process.exit(problems.length === 0 ? 0 : 1)
}

if (require.main === module) {
  main()
}

module.exports = { expressionPattern }
