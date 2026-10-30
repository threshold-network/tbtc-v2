#!/usr/bin/env node
// Computes the `tbtc-v2.slither.findings` bar from one Slither JSON and the
// triage list next to this script.
//
// usage:
//   node check-slither-triage.js --slither <slither.json> [--scope <path prefix>] [--head <sha>]
//
// The bar's scope in verification/coverage.yml is `solidity/contracts/bridge/`,
// which is the directory prefix matched here, not the twelve Solidity files the
// coverage aggregates name. A finding is in scope when any of its elements maps
// to a file under that prefix, which is the same rule the bar's first
// measurement used.
//
// A finding leaves the count when slither-triage.txt carries a row for it whose
// verdict is `false-positive` or `accepted`. A finding with no row, or with a
// row whose verdict is `open`, stays in the count. The bar value printed is
// that number, so `0` means every in-scope finding has a written disposition,
// not that the tool is silent.
//
// Exit code: 0 when the bar value is 0 and every row matches a finding, 1 when
// a finding has no disposition or a row matches nothing (a row that outlived
// its finding has to be removed, not left behind), 2 on a usage or input error.

const fs = require("fs")
const path = require("path")

const TRIAGE = path.join(__dirname, "slither-triage.txt")
const DEFAULT_SCOPE = "contracts/bridge/"
const VERDICTS = ["false-positive", "accepted", "open"]

const die = (msg) => {
  process.stderr.write(`check-slither-triage: ${msg}\n`)
  process.exit(2)
}

const argOf = (name) => {
  const i = process.argv.indexOf(name)
  if (i < 0 || i + 1 >= process.argv.length) {
    die(`missing the ${name} argument`)
  }
  return process.argv[i + 1]
}

const hasArg = (name) => process.argv.includes(name)

const readTriage = (file) => {
  if (!fs.existsSync(file)) die(`no such triage file: ${file}`)
  const rows = []
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.trim()
      if (line === "" || line.startsWith("#")) return
      const parts = line.split("|").map((p) => p.trim())
      if (parts.length !== 6) {
        die(`a row needs 6 pipe separated fields, line ${index + 1}: ${line}`)
      }
      const [id, detector, file_, symbol, verdict, reason] = parts
      for (const [name, value] of Object.entries({
        id,
        detector,
        file: file_,
        symbol,
        verdict,
        reason,
      })) {
        if (!value) die(`a row has an empty ${name}, line ${index + 1}: ${id}`)
      }
      if (!VERDICTS.includes(verdict)) {
        die(`unknown verdict "${verdict}" in row ${id}`)
      }
      rows.push({
        id,
        detector,
        file: file_,
        symbol,
        verdict,
        reason,
        used: false,
      })
    })
  if (rows.length === 0) die(`the triage file holds no rows: ${file}`)
  return rows
}

const normFile = (file) => file.replace(/^solidity\//, "")

// A finding's candidate keys are the (detector, file, symbol) triples of its
// elements, so a row matches whether the detector names the function, the event
// or the expression element first.
const candidates = (finding) => {
  const keys = []
  for (const element of finding.elements || []) {
    const mapping = element.source_mapping || {}
    const file = mapping.filename_relative || mapping.filename_short
    const symbol = element.name
    if (!file || !symbol) continue
    keys.push(`${finding.check}\u0000${normFile(file)}\u0000${symbol}`)
  }
  return [...new Set(keys)]
}

const lineOf = (finding) => {
  for (const element of finding.elements || []) {
    const mapping = element.source_mapping || {}
    const file = mapping.filename_relative || mapping.filename_short
    if (!file) continue
    const lines = mapping.lines || []
    return `${normFile(file)}:${lines.length ? lines[0] : "?"}`
  }
  return "?"
}

const symbolOf = (finding) => {
  for (const element of finding.elements || []) {
    const mapping = element.source_mapping || {}
    if (!mapping.filename_relative && !mapping.filename_short) continue
    return element.name || "?"
  }
  return "?"
}

const main = () => {
  const jsonFile = argOf("--slither")
  if (!fs.existsSync(jsonFile)) die(`no such slither file: ${jsonFile}`)
  const scope = hasArg("--scope") ? argOf("--scope") : DEFAULT_SCOPE
  const head = hasArg("--head") ? argOf("--head") : null

  const data = JSON.parse(fs.readFileSync(jsonFile, "utf8"))
  const detectors = (data.results || {}).detectors || []
  if (detectors.length === 0)
    die(`the slither report holds no results: ${jsonFile}`)

  const inScope = detectors.filter((finding) =>
    (finding.elements || []).some((element) => {
      const mapping = element.source_mapping || {}
      const file = mapping.filename_relative || mapping.filename_short
      return file && normFile(file).includes(scope)
    }),
  )

  const rows = readTriage(TRIAGE)
  const byKey = new Map(
    rows.map((row) => [
      `${row.detector}\u0000${normFile(row.file)}\u0000${row.symbol}`,
      row,
    ]),
  )

  const untriaged = []
  const perVerdict = { "false-positive": 0, accepted: 0, open: 0 }
  const perDetector = {}
  const table = []

  for (const finding of inScope) {
    perDetector[finding.check] = (perDetector[finding.check] || 0) + 1
    let row = null
    for (const key of candidates(finding)) {
      const candidate = byKey.get(key)
      if (candidate) {
        row = candidate
        break
      }
    }
    table.push({ finding, row })
    if (!row) {
      untriaged.push(finding)
      continue
    }
    row.used = true
    if (row.verdict === "open") {
      perVerdict.open += 1
      untriaged.push(finding)
    } else {
      perVerdict[row.verdict] += 1
    }
  }

  const stale = rows.filter((row) => !row.used)
  const barValue = untriaged.length

  const out = []
  out.push(
    `Slither triage, scope \`${scope}\`${head ? `, head ${head}` : ""}, ` +
      `${inScope.length} of ${detectors.length} results in scope.`,
  )
  out.push("")
  out.push("| # | detector | impact | file:line | symbol | verdict | row |")
  out.push("|---|---|---|---|---|---|---|")
  table.forEach(({ finding, row }, index) => {
    out.push(
      `| ${index + 1} | ${finding.check} | ${finding.impact || "?"} | ` +
        `${lineOf(finding)} | ${symbolOf(finding)} | ` +
        `${row ? row.verdict : "untriaged"} | ${row ? row.id : "-"} |`,
    )
  })
  out.push("")

  // The reasons are long and mostly shared, so print each one once with the
  // rows that carry it rather than once per row.
  const groups = new Map()
  for (const finding of inScope) {
    let row = null
    for (const key of candidates(finding)) {
      const candidate = byKey.get(key)
      if (candidate) {
        row = candidate
        break
      }
    }
    if (!row) continue
    const key = `${row.verdict}\u0000${row.reason}`
    if (!groups.has(key))
      groups.set(key, { verdict: row.verdict, reason: row.reason, ids: [] })
    groups.get(key).ids.push(row.id)
  }
  out.push("## Reasons")
  out.push("")
  for (const { verdict, reason, ids } of groups.values()) {
    const sorted = [...ids].sort()
    const shown = sorted.slice(0, 8).join(", ")
    const more = sorted.length > 8 ? `, and ${sorted.length - 8} more` : ""
    out.push(
      `- \`${verdict}\` (${sorted.length} rows: ${shown}${more}): ${reason}`,
    )
  }
  out.push("")

  if (untriaged.length > 0) {
    out.push("## Findings with no disposition")
    out.push("")
    for (const finding of untriaged) {
      out.push(
        `- ${finding.check} (${finding.impact || "?"}) at ${lineOf(finding)} ` +
          `${symbolOf(finding)}`,
      )
    }
    out.push("")
  }
  if (stale.length > 0) {
    out.push("## Triage rows that match no finding")
    out.push("")
    for (const row of stale) {
      out.push(`- ${row.id} ${row.detector} ${row.file} ${row.symbol}`)
    }
    out.push("")
  }

  out.push("## Bar")
  out.push("")
  out.push(`- in-scope findings: ${inScope.length}`)
  for (const [detector, count] of Object.entries(perDetector).sort()) {
    out.push(`  - ${detector}: ${count}`)
  }
  out.push(`- false-positive: ${perVerdict["false-positive"]}`)
  out.push(`- accepted: ${perVerdict.accepted}`)
  out.push(`- open: ${perVerdict.open}`)
  out.push(`- untriaged: ${untriaged.length}`)
  out.push(`- stale triage rows: ${stale.length}`)
  out.push("")
  out.push(
    `tbtc-v2.slither.findings = ${barValue} (in-scope findings with no ` +
      `triage row or with verdict \`open\`), bar is \`== 0\`: ` +
      `${barValue === 0 ? "MET" : "NOT MET"}`,
  )

  process.stdout.write(out.join("\n") + "\n")
  return barValue === 0 && stale.length === 0 ? 0 : 1
}

process.exit(main())
