// Compare the complete BridgeState struct against a chosen pre-upgrade ref.
// Usage: node scripts/check-bridge-storage-layout.cjs <base-ref> <solc-js-path>
const fs = require("fs")
const path = require("path")
const assert = require("assert")
const { execFileSync } = require("child_process")

const root = path.resolve(__dirname, "..")
const [baseRef, compilerPath] = process.argv.slice(2)
assert(baseRef && compilerPath, "Provide a base ref and solc-js 0.8.17 path")
const baseCommit = execFileSync(
  "git",
  ["rev-parse", "--verify", `${baseRef}^{commit}`],
  { cwd: root }
)
  .toString()
  .trim()
const solc = require("solc/wrapper")(require(path.resolve(compilerPath)))
assert(solc.version().startsWith("0.8.17+"), "Use the project's solc 0.8.17")

const buildDir = path.join(root, "build/build-info")
const build = fs
  .readdirSync(buildDir)
  .map((file) => JSON.parse(fs.readFileSync(path.join(buildDir, file))))
  .find(
    (info) => info.output.contracts?.["contracts/bridge/Bridge.sol"]?.Bridge
  )
assert(build, "Run hardhat compile before checking the storage layout")

const current = JSON.parse(JSON.stringify(build.input))
for (const [name, source] of Object.entries(current.sources)) {
  if (name.startsWith("contracts/") && fs.existsSync(path.join(root, name))) {
    source.content = fs.readFileSync(path.join(root, name), "utf8")
  }
}
current.sources["contracts/test/BridgeStateLayoutProbe.sol"] = {
  content:
    'pragma solidity 0.8.17; import "../bridge/BridgeState.sol"; contract BridgeStateLayoutProbe { BridgeState.Storage internal state; }',
}
current.settings.outputSelection = { "*": { "*": ["storageLayout"] } }
const previous = JSON.parse(JSON.stringify(current))
for (const [name, source] of Object.entries(previous.sources)) {
  if (name.startsWith("contracts/")) {
    try {
      source.content = execFileSync(
        "git",
        ["show", `${baseCommit}:solidity/${name}`],
        {
          cwd: root,
          stdio: ["ignore", "pipe", "ignore"],
        }
      ).toString()
    } catch {
      // Newly added sources do not change the old BridgeState definition.
    }
  }
}

function compile(input) {
  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (output.errors || []).filter(
    (error) => error.severity === "error"
  )
  assert(
    !errors.length,
    errors.map((error) => error.formattedMessage).join("\n")
  )
  const layout =
    output.contracts["contracts/test/BridgeStateLayoutProbe.sol"]
      .BridgeStateLayoutProbe.storageLayout
  return { layout, type: layout.types[layout.storage[0].type] }
}

function typeShape(layout, id, seen = new Set()) {
  if (seen.has(id)) return { recursive: layout.types[id].label }
  const type = layout.types[id]
  const visited = new Set([...seen, id])
  return {
    encoding: type.encoding,
    label: type.label,
    bytes: type.numberOfBytes,
    key: type.key && typeShape(layout, type.key, visited),
    value: type.value && typeShape(layout, type.value, visited),
    base: type.base && typeShape(layout, type.base, visited),
    members: type.members?.map((member) => ({
      label: member.label,
      slot: member.slot,
      offset: member.offset,
      type: typeShape(layout, member.type, visited),
    })),
  }
}

const old = compile(previous)
const next = compile(current)
for (const field of old.type.members.filter(
  (member) => member.label !== "__gap"
)) {
  const updated = next.type.members.find(
    (member) => member.label === field.label
  )
  assert(updated, `Removed field: ${field.label}`)
  assert.equal(updated.slot, field.slot, `Slot changed: ${field.label}`)
  assert.equal(updated.offset, field.offset, `Offset changed: ${field.label}`)
  assert.deepStrictEqual(
    typeShape(next.layout, updated.type),
    typeShape(old.layout, field.type),
    `Type changed: ${field.label}`
  )
}
assert.equal(
  next.type.numberOfBytes,
  old.type.numberOfBytes,
  "Total struct size changed"
)
const oldGap = old.type.members.find((member) => member.label === "__gap")
const newGap = next.type.members.find((member) => member.label === "__gap")
const payout = next.type.members.find(
  (member) => member.label === "pendingFraudChallengePayouts"
)
assert.equal(
  payout.slot,
  oldGap.slot,
  "Mapping did not consume the first gap slot"
)
assert.equal(
  BigInt(newGap.slot),
  BigInt(oldGap.slot) + 1n,
  "Gap did not move by one slot"
)
assert.equal(
  next.layout.types[newGap.type].label,
  "uint256[47]",
  "Unexpected remaining gap"
)
console.log(
  `PASS: ${old.type.members.length - 1} existing fields unchanged; ${
    next.type.numberOfBytes
  } bytes; payout uses gap slot ${payout.slot}; 47 slots remain`
)
