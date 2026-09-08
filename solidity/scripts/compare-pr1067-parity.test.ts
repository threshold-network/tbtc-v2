import assert from "assert"
import {
  checkRawInventory,
  compareSnapshots,
  rawReport,
  readSnapshot,
  Snapshot,
} from "./compare-pr1067-parity"
import type { Json } from "./pr1067-parity-chain"

const test = it

assert(
  process.env.PARITY_BASELINE && process.env.PARITY_CANDIDATE,
  "Set PARITY_BASELINE and PARITY_CANDIDATE to fresh capture directories"
)
const baseline = readSnapshot(process.env.PARITY_BASELINE)
const candidate = readSnapshot(process.env.PARITY_CANDIDATE)
const artifact =
  "export/artifacts/contracts/bridge/BridgeGovernance.sol/BridgeGovernance.json"
const compiler = "contracts/bridge/BridgeGovernance.sol:BridgeGovernance"
const deployment = "deployments/hardhat/BridgeGovernance.json"
const zeroWord = `0x${"00".repeat(32)}`

function candidateBytes(name: string): Buffer {
  const value = candidate.get(name)
  assert(value !== undefined, `Missing candidate fixture: ${name}`)
  return value
}

function changedJson(
  file: string,
  keys: Array<string | number>,
  value: unknown
): Snapshot {
  const result = new Map(candidate)
  const document: Json = JSON.parse(candidateBytes(file).toString())
  const parent = keys
    .slice(0, -1)
    .reduce((object, key) => object[key], document)
  parent[keys[keys.length - 1]] = value
  result.set(file, Buffer.from(JSON.stringify(document, null, 2)))
  return result
}

function rejects(name: string, altered: () => Snapshot, reason: RegExp) {
  test(name, () =>
    assert.throws(() => compareSnapshots(baseline, altered()), reason)
  )
}

test("rejects empty captures before reporting raw byte parity", () => {
  assert.throws(
    () => checkRawInventory(rawReport(new Map(), new Map())),
    /Raw group inventory/
  )
})

test("accepts captured compatibility while preserving the raw byte failure", () => {
  const before = [...candidate].map(([name, data]) => [name, data.toString()])
  compareSnapshots(baseline, candidate)
  const raw = rawReport(baseline, candidate)
  assert.deepStrictEqual(
    ["export.json", "export/artifacts/", "deployments/", "export/deploy/"].map(
      (group) => [raw[group].identical, raw[group].different.length]
    ),
    [
      [1, 0],
      [82, 3],
      [118, 27],
      [42, 19],
    ]
  )
  assert.deepStrictEqual(
    [...candidate].map(([name, data]) => [name, data.toString()]),
    before
  )
})

rejects(
  "rejects an ABI change",
  () => changedJson(artifact, ["abi"], []),
  /compiler\/artifact abi/
)
rejects(
  "rejects creation bytecode drift",
  () => changedJson(artifact, ["bytecode"], "0x00"),
  /creation bytecode/
)
rejects(
  "rejects runtime bytecode drift",
  () => changedJson(artifact, ["deployedBytecode"], "0x00"),
  /runtime bytecode/
)
rejects(
  "rejects an invented storage layout",
  () => changedJson(artifact, ["storageLayout", "storage", 0, "slot"], "99999"),
  /compiler storage layout/
)
rejects(
  "rejects an extra field in a layout-exempt artifact",
  () => changedJson(artifact, ["unreviewed"], true),
  /unlisted artifact difference/
)
rejects(
  "rejects different JSON formatting in an exempt artifact",
  () => {
    const altered = new Map(candidate)
    altered.set(
      artifact,
      Buffer.concat([candidateBytes(artifact), Buffer.from("\n")])
    )
    return altered
  },
  /Non-canonical JSON/
)
rejects(
  "rejects a changed compiler option",
  () =>
    changedJson(
      "compiler.json",
      [compiler, "input", "settings", "optimizer", "runs"],
      201
    ),
  /unlisted compiler input\/output change/
)
rejects(
  "rejects a broken compiler input reference",
  () => changedJson(deployment, ["solcInputHash"], "0".repeat(32)),
  /Missing snapshot file/
)
rejects(
  "rejects a fabricated deployment receipt hash",
  () => changedJson(deployment, ["receipt", "blockHash"], zeroWord),
  /receipt block hash/
)
rejects(
  "rejects a fabricated RPC receipt log hash",
  () =>
    changedJson(
      "chain.json",
      ["receipts", 41, "logs", 0, "blockHash"],
      zeroWord
    ),
  /log block hash/
)
rejects(
  "rejects a changed proxy owner",
  () =>
    changedJson("chain.json", ["proxies", "Bridge", "adminOwner"], zeroWord),
  /admin owner/
)
rejects(
  "rejects a changed implementation slot",
  () =>
    changedJson(
      "chain.json",
      ["proxies", "Bridge", "implementation"],
      zeroWord
    ),
  /implementation slot/
)
rejects(
  "rejects altered ownership calldata",
  () =>
    changedJson(
      "chain.json",
      ["transactions", 41, "input"],
      `0xf2fde38b${zeroWord.slice(2)}`
    ),
  /signed hash/
)
rejects(
  "rejects a second gas-limit change",
  () => changedJson("chain.json", ["transactions", 42, "gas"], "0xffff"),
  /signed hash/
)
rejects(
  "rejects a changed state root",
  () => changedJson("chain.json", ["blocks", 42, "stateRoot"], zeroWord),
  /header hash/
)
rejects(
  "rejects a changed block size",
  () => changedJson("chain.json", ["blocks", 42, "size"], "0x1"),
  /encoded size/
)
rejects(
  "rejects an unlisted receipt field",
  () => changedJson("chain.json", ["receipts", 0, "unreviewed"], true),
  /Unlisted chain\/code\/ownership difference/
)
rejects(
  "rejects an unlisted deployment field",
  () => changedJson(deployment, ["unreviewed"], true),
  /unlisted deployment difference/
)
rejects(
  "rejects a changed effective gas setting",
  () => changedJson("provenance.json", ["network", "gas"], 1000000),
  /Candidate gas estimation/
)
rejects(
  "rejects package drift",
  () => changedJson("package.json", ["unreviewed"], true),
  /reviewed package/
)
rejects(
  "rejects a new artifact file",
  () => {
    const altered = new Map(candidate)
    altered.set("export/artifacts/Unexpected.json", Buffer.from("{}"))
    return altered
  },
  /File inventory differs/
)
rejects(
  "rejects a missing artifact",
  () => {
    const altered = new Map(candidate)
    altered.delete(artifact)
    return altered
  },
  /File inventory differs/
)
rejects(
  "rejects an extra file outside the four parity groups",
  () => {
    const altered = new Map(candidate)
    altered.set("unexpected.txt", Buffer.from("unexpected"))
    return altered
  },
  /Unlisted file/
)
rejects(
  "rejects further changes to a reviewed compiled script",
  () => {
    const altered = new Map(candidate)
    const name = "export/deploy/26_transfer_proxy_admin_ownership.js"
    altered.set(
      name,
      Buffer.concat([candidateBytes(name), Buffer.from("\n// unexpected")])
    )
    return altered
  },
  /reviewed candidate script/
)
rejects(
  "rejects a changed existing-network deployment",
  () => {
    const name = [...candidate.keys()].find(
      (key) => key.startsWith("deployments/mainnet/") && key.endsWith(".json")
    )
    assert(name !== undefined, "Missing mainnet deployment fixture")
    return changedJson(name, ["unreviewed"], true)
  },
  /Unlisted byte difference/
)
rejects(
  "rejects changed deployed runtime code",
  () => {
    const chain = JSON.parse(candidateBytes("chain.json").toString())
    const admin = `0x${chain.proxies.Bridge.admin.slice(-40)}`
    return changedJson("chain.json", ["code", admin], "0x00")
  },
  /Unlisted chain\/code\/ownership difference/
)
