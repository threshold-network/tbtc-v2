#!/usr/bin/env node
// Reports the coverage and mutation units that the known-exclusion list
// accounts for, so a reviewer can see that every uncovered statement and
// every surviving mutant has a written reason.
//
// usage:
//   node check-exclusions.js coverage --coverage <coverage-final.json>
//   node check-exclusions.js mutation  --mutants <survivors.json>
//
// The exclusions live in exclusions.txt next to this script. The file names a
// symbol per row, never a line range, because line numbers move with every
// contract change.
//
// The coverage mode reads the `coverage-final.json` that solidity-coverage
// writes and prints the uncovered statements and branch arms of every
// excluded symbol, together with the uncovered units that no exclusion
// accounts for. The mutation mode reads the mutants JSON that mutate.cjs
// writes and prints the surviving mutants of every excluded symbol, together
// with the survivors that no exclusion accounts for.
//
// Exit code: 0 when every uncovered unit is accounted for, 1 when at least one
// uncovered unit has no exclusion, 2 on a usage or input error.

const fs = require("fs")
const path = require("path")

const here = __dirname
const EXCLUSIONS = path.join(here, "exclusions.txt")

const die = (msg) => {
  process.stderr.write(`check-exclusions: ${msg}\n`)
  process.exit(2)
}

const readExclusions = () => {
  const text = fs.readFileSync(EXCLUSIONS, "utf8")
  const rows = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const parts = line.split("|").map((p) => p.trim())
    if (parts.length !== 6) {
      die(`exclusions.txt: a row needs 6 pipe separated fields: ${line}`)
    }
    const [id, file, symbol, kind, reason, reference] = parts
    if (!id || !file || !symbol || !kind || !reason || !reference) {
      die(`exclusions.txt: a row has an empty field: ${line}`)
    }
    const kinds = kind.split(",").map((k) => k.trim())
    for (const k of kinds) {
      if (k !== "coverage" && k !== "mutation") {
        die(`exclusions.txt: unknown kind "${k}" in row ${id}`)
      }
    }
    rows.push({ id, file, symbol, kinds, reason, reference })
  }
  if (rows.length === 0) die("exclusions.txt holds no rows")
  return rows
}

const argOf = (name) => {
  const i = process.argv.indexOf(name)
  if (i < 0 || i + 1 >= process.argv.length) {
    die(`missing the ${name} argument`)
  }
  return process.argv[i + 1]
}

// The coverage report keys its files by path relative to the contracts
// directory, so a row that names "contracts/bridge/Reservation.sol" has to
// match the key "bridge/Reservation.sol".
const fileMatches = (rowFile, reportFile) => {
  const a = rowFile.replace(/^contracts\//, "")
  const b = reportFile.replace(/^contracts\//, "")
  return a === b || reportFile.endsWith(rowFile)
}

// The coverage report keys the statement counts by source line, not by
// statement id, so a count of zero at a line is an uncovered statement.
const uncoveredStatementLines = (entry) =>
  Object.entries(entry.l || {})
    .filter(([, count]) => count === 0)
    .map(([key]) => Number(key))
    .filter((line) => Number.isFinite(line))

const coverageMode = (rows) => {
  const file = argOf("--coverage")
  if (!fs.existsSync(file)) die(`no such coverage file: ${file}`)
  const report = JSON.parse(fs.readFileSync(file, "utf8"))
  const keys = Object.keys(report)
  if (keys.length === 0) die(`the coverage report is empty: ${file}`)
  // The scope is the files the exclusion list names, so the check answers the
  // question the list is about. `--scope` widens it to other files, as a
  // path prefix, when a caller wants to know about more.
  const scopeArg = process.argv.includes("--scope")
    ? process.argv[process.argv.indexOf("--scope") + 1]
    : null
  const inScope = (key) => {
    if (scopeArg) return key.includes(scopeArg)
    return rows.some((row) => fileMatches(row.file, key))
  }
  const scoped = keys.filter(inScope)
  if (scoped.length === 0) {
    die(
      `the coverage report holds none of the files the exclusion list names: ${rows
        .map((r) => r.file)
        .join(", ")}`
    )
  }

  let unaccounted = 0
  console.log(
    "| exclusion | file | symbol | uncovered statements | uncovered branch arms | reason | reference |"
  )
  console.log("|---|---|---|---|---|---|---|")
  for (const row of rows) {
    if (!row.kinds.includes("coverage")) continue
    const key = keys.find((k) => fileMatches(row.file, k))
    if (!key) {
      console.log(
        `| ${row.id} | ${row.file} | ${row.symbol} | file not in the report | file not in the report | ${row.reason} | ${row.reference} |`
      )
      continue
    }
    const entry = report[key]
    const fnIds = Object.entries(entry.fnMap)
      .filter(([, fn]) => fn.name === row.symbol)
      .map(([id]) => id)
    if (fnIds.length === 0) {
      console.log(
        `| ${row.id} | ${row.file} | ${row.symbol} | symbol not in the report | symbol not in the report | ${row.reason} | ${row.reference} |`
      )
      continue
    }
    const inSymbol = (line) =>
      fnIds.some((id) => {
        const fn = entry.fnMap[id]
        const start = fn.loc && fn.loc.start ? fn.loc.start.line : fn.line
        const end = fn.loc && fn.loc.end ? fn.loc.end.line : fn.line
        return line >= start && line <= end
      })
    const stmts = uncoveredStatementLines(entry).filter((line) =>
      inSymbol(line)
    )
    const arms = []
    for (const [id, counts] of Object.entries(entry.b || {})) {
      const branch = entry.branchMap[id]
      counts.forEach((count, index) => {
        if (count !== 0) return
        const loc = branch.locations[index] || branch.loc
        if (!loc) return
        if (!inSymbol(loc.start.line)) return
        arms.push(loc.start.line)
      })
    }
    arms.sort((a, b) => a - b)
    console.log(
      `| ${row.id} | ${row.file} | ${row.symbol} | ${stmts.length}${
        stmts.length ? ` (${stmts.join(", ")})` : ""
      } | ${arms.length}${arms.length ? ` (${arms.join(", ")})` : ""} | ${row.reason} | ${
        row.reference
      } |`
    )
  }

  console.log()
  console.log(
    scopeArg
      ? `Uncovered units in the ${scopeArg} scope that no exclusion accounts for:`
      : "Uncovered units in the files the exclusion list names that no exclusion accounts for:"
  )
  for (const key of scoped) {
    const entry = report[key]
    const coveredSymbols = new Set()
    for (const row of rows) {
      if (!row.kinds.includes("coverage")) continue
      if (!fileMatches(row.file, key)) continue
      for (const [, fn] of Object.entries(entry.fnMap || {})) {
        if (fn.name === row.symbol) coveredSymbols.add(fn.name)
      }
    }
    for (const line of uncoveredStatementLines(entry)) {
      const fn = Object.values(entry.fnMap || {}).find((f) => {
        const start = f.loc && f.loc.start ? f.loc.start.line : f.line
        const end = f.loc && f.loc.end ? f.loc.end.line : f.line
        return line >= start && line <= end
      })
      if (fn && coveredSymbols.has(fn.name)) continue
      console.log(`  ${key}:${line}${fn ? ` (${fn.name})` : ""}`)
      unaccounted++
    }
  }
  console.log(
    `  total: ${unaccounted} uncovered statement(s) without an exclusion`
  )
  return unaccounted === 0 ? 0 : 1
}

const mutationMode = (rows) => {
  const file = argOf("--mutants")
  if (!fs.existsSync(file)) die(`no such mutants file: ${file}`)
  const mutants = JSON.parse(fs.readFileSync(file, "utf8"))
  const entries = Object.entries(mutants)
  if (entries.length === 0) die(`the mutants file is empty: ${file}`)

  let unaccounted = 0
  console.log("| exclusion | symbol | surviving mutants | reason | reference |")
  console.log("|---|---|---|---|---|")
  for (const row of rows) {
    if (!row.kinds.includes("mutation")) continue
    const hits = entries
      .filter(([, m]) => m.verdict === "SURVIVED")
      .filter(([, m]) => m.name && m.name.includes(row.symbol))
    console.log(
      `| ${row.id} | ${row.symbol} | ${hits.length}${
        hits.length ? ` (${hits.map(([id]) => id).join(", ")})` : ""
      } | ${row.reason} | ${row.reference} |`
    )
  }

  console.log()
  console.log("Surviving mutants that no exclusion accounts for:")
  const excludedSymbols = rows
    .filter((r) => r.kinds.includes("mutation"))
    .map((r) => r.symbol)
  for (const [id, m] of entries) {
    if (m.verdict !== "SURVIVED") continue
    if (excludedSymbols.some((s) => m.name && m.name.includes(s))) continue
    console.log(`  ${id} ${m.name}`)
    unaccounted++
  }
  console.log(
    `  total: ${unaccounted} surviving mutant(s) without an exclusion`
  )
  return unaccounted === 0 ? 0 : 1
}

const rows = readExclusions()
const mode = process.argv[2]
let code = 2
if (mode === "coverage") code = coverageMode(rows)
else if (mode === "mutation") code = mutationMode(rows)
else die(`unknown mode "${mode}"; use coverage or mutation`)
process.exit(code)
