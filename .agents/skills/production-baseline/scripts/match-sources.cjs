#!/usr/bin/env node
// Find the git commits whose sources match a hardhat-deploy artifact.
//
// Reads sources[path].keccak256 from the artifact's solc metadata (or, when the
// artifact has no usable metadata, from solcInputs/<solcInputHash>.json next to
// it), hashes the same paths at every commit that touched them, and prints the
// commits where every local (non-npm) source matches.
//
// Usage:
//   node match-sources.cjs <artifact.json> [--repo DIR] [--prefix solidity/]
//                          [--revs "--all"] [--node-modules DIR]
//
// Needs a full (not blobless) clone and a keccak256 implementation:
// @noble/hashes (via NODE_PATH) or ethers (e.g. solidity/node_modules).
// Exit code: 0 = at least one full match, 1 = no full match, 2 = no source hashes.
"use strict"
const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")

function loadKeccak() {
  try {
    const { keccak_256 } = require("@noble/hashes/sha3")
    return (buf) => "0x" + Buffer.from(keccak_256(buf)).toString("hex")
  } catch (_) {}
  try {
    const ethers = require("ethers")
    const k = ethers.keccak256 || ethers.utils.keccak256
    return (buf) => k(buf)
  } catch (_) {}
  console.error(
    "No keccak256 implementation found. Run:\n" +
      '  npm i --prefix "$TMPDIR/k" @noble/hashes && export NODE_PATH="$TMPDIR/k/node_modules"'
  )
  process.exit(2)
}
const keccak = loadKeccak()

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : dflt
}
const repo = path.resolve(opt("--repo", "."))
const prefix = opt("--prefix", "solidity/")
const revs = opt("--revs", "--all").split(/\s+/).filter(Boolean)
const nodeModules = opt("--node-modules", null)
const artifactPath = args[0]
if (!artifactPath) {
  console.error(
    'usage: node match-sources.cjs <artifact.json> [--repo DIR] [--prefix solidity/] [--revs "--all"] [--node-modules DIR]'
  )
  process.exit(2)
}

const git = (a, enc = "utf8") =>
  execFileSync("git", ["-C", repo, ...a], { encoding: enc, maxBuffer: 1 << 30 })

// 1. Expected source hashes.
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"))
let expected = {}
let origin = null
const md =
  typeof artifact.metadata === "string"
    ? JSON.parse(artifact.metadata)
    : artifact.metadata
if (md && md.sources && Object.keys(md.sources).length) {
  for (const [p, s] of Object.entries(md.sources)) expected[p] = s.keccak256
  origin = "metadata"
} else if (artifact.solcInputHash) {
  const inp = path.join(
    path.dirname(artifactPath),
    "solcInputs",
    artifact.solcInputHash + ".json"
  )
  if (fs.existsSync(inp)) {
    const j = JSON.parse(fs.readFileSync(inp, "utf8"))
    for (const [p, s] of Object.entries(j.sources))
      expected[p] = keccak(Buffer.from(s.content, "utf8"))
    origin = "solcInput " + path.basename(inp)
  }
}
if (!origin) {
  console.log(
    `NO_SOURCE_HASHES ${artifactPath}: no metadata.sources and no solcInputs file; cannot pin by source hash.`
  )
  if (artifact.implementation)
    console.log(
      `  This is a proxy; check the artifact whose address is ${artifact.implementation}.`
    )
  if (artifact.libraries)
    console.log(`  Linked libraries: ${JSON.stringify(artifact.libraries)}`)
  process.exit(2)
}
const target = md && md.settings && md.settings.compilationTarget
console.log(`artifact: ${artifactPath}`)
console.log(
  `address: ${artifact.address}  target: ${
    target ? JSON.stringify(target) : "?"
  }  hashes from: ${origin}`
)

// npm packages, and copies of them that hardhat-dependency-compiler generates at build time.
const isExternal = (p) =>
  p.startsWith("@") || p.includes("hardhat-dependency-compiler/")
const local = Object.keys(expected).filter((p) => !isExternal(p))
const external = Object.keys(expected).filter(isExternal)

// 2. Candidate commits: every commit that touched one of the local sources.
const gitPaths = local.map((p) => prefix + p)
const commits = git(["rev-list", ...revs, "--", ...gitPaths])
  .split("\n")
  .filter(Boolean)
const blobHash = new Map()
const hashBlob = (id) => {
  if (!blobHash.has(id))
    blobHash.set(id, keccak(git(["cat-file", "blob", id], "buffer")))
  return blobHash.get(id)
}
const results = []
for (const c of commits) {
  const tree = new Map()
  for (const line of git(["ls-tree", "-r", c, "--", ...gitPaths]).split("\n")) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/)
    if (m) tree.set(m[2], m[1])
  }
  const bad = []
  for (const p of local) {
    const id = tree.get(prefix + p)
    if (!id || hashBlob(id) !== expected[p]) bad.push(id ? p : p + " (missing)")
  }
  results.push({ c, bad })
}

// 3. Report.
const full = results.filter((r) => r.bad.length === 0)
const show = (c) => git(["show", "-s", "--format=%H %cs %s", c]).trim()
console.log(
  `local sources: ${local.length}  candidate commits: ${commits.length}`
)
if (full.length) {
  console.log(
    `FULL MATCH at ${full.length} commit(s), newest first. The deployed local sources equal the tree at each, ` +
      "and at later commits on the same line until one of these files changes:"
  )
  for (const r of full) console.log("  " + show(r.c))
} else {
  console.log("NO FULL MATCH. Closest commits:")
  results.sort((a, b) => a.bad.length - b.bad.length)
  for (const r of results.slice(0, 3))
    console.log(
      `  ${show(r.c)}\n    mismatched (${r.bad.length}): ${r.bad
        .slice(0, 8)
        .join(", ")}`
    )
}

// 4. npm dependency sources (@keep-network/*, @openzeppelin/*, ...).
if (nodeModules) {
  const bad = external.filter((p) => {
    const f = path.join(
      nodeModules,
      p.replace(/^.*hardhat-dependency-compiler\//, "")
    )
    return !fs.existsSync(f) || keccak(fs.readFileSync(f)) !== expected[p]
  })
  console.log(
    `npm sources: ${external.length - bad.length}/${
      external.length
    } match ${nodeModules}`
  )
  for (const p of bad) console.log("  mismatch: " + p)
} else if (external.length) {
  const pkgs = [
    ...new Set(
      external.map((p) =>
        p
          .replace(/^.*hardhat-dependency-compiler\//, "")
          .split("/")
          .slice(0, 2)
          .join("/")
      )
    ),
  ]
  console.log(
    `npm sources not checked (${external.length} files from ${pkgs.join(
      ", "
    )}); pass --node-modules to check them.`
  )
}
process.exit(full.length ? 0 : 1)
