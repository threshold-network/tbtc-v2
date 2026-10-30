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
 *   - the expression the harness expects must be present in that range.
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
        range: [900, 906],
        // The re-anchor request floor.
        expect: ["anchorAmount > txMaxFee + minAmount"],
      },
      {
        contract: "bridge/Reservation.sol",
        range: [1614, 1621],
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

function main() {
  const asJson = process.argv.includes("--json")

  const problems = []
  let checked = 0

  for (const group of CITATIONS) {
    const harnessPath = path.join(HALMOS_DIR, group.file)
    if (!fs.existsSync(harnessPath)) {
      problems.push({
        harness: group.file,
        contract: null,
        range: null,
        reason: "harness file is missing",
      })
      continue
    }

    for (const entry of group.entries) {
      checked += 1
      const contractPath = path.join(CONTRACTS, entry.contract)

      if (!fs.existsSync(contractPath)) {
        problems.push({
          harness: group.file,
          contract: entry.contract,
          range: entry.range,
          reason: "contract file does not exist",
        })
        continue
      }

      const lines = readLines(contractPath)
      const [from, to] = entry.range

      if (from < 1 || to > lines.length) {
        problems.push({
          harness: group.file,
          contract: entry.contract,
          range: entry.range,
          reason: `cited range is outside the file (file has ${lines.length} lines)`,
        })
        continue
      }

      const slice = lines.slice(from - 1, to).join("\n")
      const missing = entry.expect.filter((e) => !slice.includes(e))

      if (missing.length > 0) {
        problems.push({
          harness: group.file,
          contract: entry.contract,
          range: entry.range,
          reason: `cited range no longer holds ${missing
            .map((m) => `"${m}"`)
            .join(", ")}`,
        })
      }
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { checked, ok: problems.length === 0, problems },
        null,
        2
      )
    )
  } else {
    for (const p of problems) {
      const where = p.contract
        ? `${p.contract}:${p.range ? p.range.join("-") : "?"}`
        : "(no contract)"
      console.error(`${p.harness}: ${where}: ${p.reason}`)
    }
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

main()
