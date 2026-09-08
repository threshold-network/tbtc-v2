import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import { createRequire } from "module"
import policy from "./pr1067-parity-policy.json"
import {
  check,
  same,
  compareChains,
  proxyNames,
  Json,
} from "./pr1067-parity-chain"

export type Snapshot = Map<string, Buffer>
const hasOwn = <T extends Record<string, unknown>>(
  value: T,
  key: string
): key is keyof T & string => Object.prototype.hasOwnProperty.call(value, key)
export interface RawGroup {
  baselineFiles: number
  candidateFiles: number
  identical: number
  different: string[]
}
export type RawReport = Record<string, RawGroup>
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex")
const stringify = (value: unknown) => JSON.stringify(value, null, 2)
// Resolve the hash implementation owned by the pinned hardhat-deploy version.
const deployRequire = createRequire(
  require.resolve("hardhat-deploy/package.json")
)
const murmurModule = deployRequire("murmur-128")
const inputHash = (value: string) =>
  Buffer.from((murmurModule.default || murmurModule)(value)).toString("hex")
const oldInput =
  "deployments/hardhat/solcInputs/e17c589d40cacdccd6e1dd3b08c49fb5.json"
const newInput =
  "deployments/hardhat/solcInputs/e53191339a61b14bab032ac2cd14811d.json"
const proofFiles = [
  "chain.json",
  "compiler.json",
  "provenance.json",
  "package.json",
  "yarn.lock",
]
const groups = [
  "export.json",
  "export/artifacts/",
  "deployments/",
  "export/deploy/",
]
const artifactPath = (fqn: string) =>
  `export/artifacts/${fqn.replace(":", "/")}.json`
const bridgeGovernance =
  "contracts/bridge/BridgeGovernance.sol:BridgeGovernance"

export function readSnapshot(directory: string): Snapshot {
  const result = new Map<string, Buffer>()
  function visit(relative: string) {
    fs.readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    }).forEach((entry) => {
      const name = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) visit(name)
      else {
        check(entry.isFile(), `Snapshot contains a symlink/non-file: ${name}`)
        result.set(name, fs.readFileSync(path.join(directory, name)))
      }
    })
  }
  visit("")
  return result
}

function bytes(snapshot: Snapshot, name: string): Buffer {
  const value = snapshot.get(name)
  check(value !== undefined, `Missing snapshot file: ${name}`)
  return value
}

function json(snapshot: Snapshot, name: string): Json {
  return JSON.parse(bytes(snapshot, name).toString())
}

function canonicalJson(snapshot: Snapshot, name: string): Json {
  const value = json(snapshot, name)
  same(
    bytes(snapshot, name).toString(),
    stringify(value),
    `Non-canonical JSON: ${name}`
  )
  return value
}

export function rawReport(baseline: Snapshot, candidate: Snapshot): RawReport {
  return Object.fromEntries(
    groups.map((group) => {
      const belongs = (name: string) =>
        group.endsWith("/") ? name.startsWith(group) : name === group
      const before = [...baseline.keys()].filter(belongs).sort()
      const after = [...candidate.keys()].filter(belongs).sort()
      const different = [...new Set([...before, ...after])]
        .sort()
        .filter(
          (name) =>
            !baseline.has(name) ||
            !candidate.has(name) ||
            !bytes(baseline, name).equals(bytes(candidate, name))
        )
      return [
        group,
        {
          baselineFiles: before.length,
          candidateFiles: after.length,
          identical: before.filter(
            (name) =>
              candidate.has(name) &&
              bytes(baseline, name).equals(bytes(candidate, name))
          ).length,
          different,
        },
      ]
    })
  )
}

export function checkRawInventory(report: RawReport): void {
  same(
    groups.map((g) => [report[g].baselineFiles, report[g].candidateFiles]),
    [
      [1, 1],
      [85, 85],
      [144, 144],
      [61, 61],
    ],
    "Raw group inventory"
  )
}

function checkProvenance(baseline: Snapshot, candidate: Snapshot) {
  const a = json(baseline, "provenance.json")
  const b = json(candidate, "provenance.json")
  const profiles: Array<[Snapshot, Json, "baseline" | "candidate"]> = [
    [baseline, a, "baseline"],
    [candidate, b, "candidate"],
  ]
  profiles.forEach(([snapshot, p, side]) => {
    same(p.node, "v24.11.1", `${side}: Node version`)
    same(
      p.arguments,
      [
        "deploy",
        "--config",
        "scripts/pr1067-parity.config.ts",
        "--network",
        "hardhat",
        "--no-compile",
        "--reset",
        "--write",
        "true",
        "--export",
        "export.json",
      ],
      `${side}: actual capture arguments`
    )
    same(
      hash(bytes(snapshot, "package.json")),
      policy[`${side}PackageSha256`],
      `${side}: reviewed package`
    )
    same(p.hardhat, "2.29.0", `${side}: Hardhat version`)
    same(
      p.hardhatDeploy,
      side === "baseline" ? "0.11.15" : "1.0.4",
      `${side}: hardhat-deploy version`
    )
    same(
      p.lockfileSha256,
      hash(bytes(snapshot, "yarn.lock")),
      `${side}: lockfile content`
    )
    same(
      p.lockfileSha256,
      policy[`${side}LockfileSha256`],
      `${side}: reviewed lockfile`
    )
    same(
      p.configSha256,
      policy[`${side}ConfigSha256`],
      `${side}: reviewed config`
    )
    same(
      p.captureSha256,
      hash(fs.readFileSync(path.join(__dirname, "pr1067-parity.config.ts"))),
      `${side}: capture source`
    )
    same(
      p.transactionCaptureMethod,
      "eth_getBlockByNumber(number,true)",
      `${side}: raw transaction method`
    )
    same(
      p.compilerOverrides,
      policy.layouts.map((fqn) => fqn.split(":")[0]).sort(),
      `${side}: compiler overrides`
    )
    check(/^[a-f0-9]{40}$/.test(p.revision), `${side}: revision`)
    same(
      p.environment,
      { USE_EXTERNAL_DEPLOY: "true", TEST_USE_STUBS_TBTC: "true" },
      `${side}: deployment environment`
    )
    same(p.network.forking.enabled, false, `${side}: unexpected fork`)
  })
  same(a.revision, policy.baselineRevision, "Pinned dev baseline")
  same(a.ethers, "ethers/5.5.4", "Baseline ethers version")
  same(b.ethers, "6.17.0", "Candidate ethers version")
  same(a.network.blockGasLimit, 30000000, "Baseline block gas limit")
  same(
    a.network.gas,
    Math.min(2 ** 24, a.network.blockGasLimit),
    "Baseline Fusaka gas cap"
  )
  same(b.network.gas, "auto", "Candidate gas estimation")
  const adjusted = JSON.parse(JSON.stringify(b))
  ;[
    "revision",
    "ethers",
    "hardhatDeploy",
    "lockfileSha256",
    "configSha256",
  ].forEach((key) => {
    adjusted[key] = a[key]
  })
  adjusted.network.gas = a.network.gas
  same(adjusted, a, "Unlisted effective configuration/provenance difference")
  return a.network.gas as number
}

function compareCompiler(baseline: Snapshot, candidate: Snapshot) {
  const a = json(baseline, "compiler.json")
  const b = json(candidate, "compiler.json")
  same(
    Object.keys(a).sort(),
    [...policy.layouts].sort(),
    "Baseline compiler inventory"
  )
  same(
    Object.keys(b).sort(),
    [...policy.layouts].sort(),
    "Candidate compiler inventory"
  )
  policy.layouts.forEach((fqn) => {
    const before = a[fqn]
    const after = b[fqn]
    same(
      before.solcLongVersion,
      "0.8.17+commit.8df45f5f",
      `${fqn}: compiler version`
    )
    const oldSelection = before.input.settings.outputSelection["*"]["*"]
    same(
      after.input.settings.outputSelection["*"]["*"],
      [...oldSelection, "storageLayout"],
      `${fqn}: output selection`
    )
    check(
      !hasOwn(before.output, "storageLayout"),
      `${fqn}: baseline layout already present`
    )
    check(
      hasOwn(after.output, "storageLayout"),
      `${fqn}: missing compiler layout`
    )
    const adjusted = JSON.parse(JSON.stringify(after))
    adjusted.input.settings.outputSelection["*"]["*"] = oldSelection
    delete adjusted.output.storageLayout
    same(adjusted, before, `${fqn}: unlisted compiler input/output change`)
    const pairs: Array<[Snapshot, Json]> = [
      [baseline, before],
      [candidate, after],
    ]
    pairs.forEach(([snapshot, compilation]) => {
      const artifact = json(snapshot, artifactPath(fqn))
      ;["abi", "metadata"].forEach((field) =>
        same(
          artifact[field],
          compilation.output[field],
          `${fqn}: compiler/artifact ${field}`
        )
      )
      same(
        artifact.bytecode,
        `0x${compilation.output.evm.bytecode.object}`,
        `${fqn}: creation bytecode`
      )
      same(
        artifact.deployedBytecode,
        `0x${compilation.output.evm.deployedBytecode.object}`,
        `${fqn}: runtime bytecode`
      )
      // export-artifacts moves these objects to the top-level bytecode fields.
      const evm = JSON.parse(JSON.stringify(artifact.evm))
      evm.bytecode.object = artifact.bytecode.slice(2)
      evm.deployedBytecode.object = artifact.deployedBytecode.slice(2)
      same(evm, compilation.output.evm, `${fqn}: compiler/artifact evm`)
    })
  })
  const before = canonicalJson(baseline, oldInput)
  const after = canonicalJson(candidate, newInput)
  same(before, a[bridgeGovernance].input, "Baseline recorded compiler input")
  same(after, b[bridgeGovernance].input, "Candidate recorded compiler input")
  return b
}

function validateDeployments(snapshot: Snapshot, chain: Json) {
  const records = [...snapshot.keys()].filter(
    (name) =>
      name.startsWith("deployments/hardhat/") &&
      name.endsWith(".json") &&
      !name.includes("/solcInputs/")
  )
  const receipts = new Map(
    chain.receipts.map((r: Json) => [r.transactionHash, r])
  )
  const inputHashes = new Map<string, string>()
  let receiptCount = 0
  records.forEach((name) => {
    const deployment = json(snapshot, name)
    if (deployment.solcInputHash) {
      const inputName = `deployments/hardhat/solcInputs/${deployment.solcInputHash}.json`
      if (!inputHashes.has(inputName)) {
        inputHashes.set(
          inputName,
          inputHash(bytes(snapshot, inputName).toString())
        )
      }
      same(
        inputHashes.get(inputName),
        deployment.solcInputHash,
        `${name}: compiler input hash`
      )
    }
    if (!deployment.receipt) return
    receiptCount += 1
    const { receipt } = deployment
    const rpc: Json = receipts.get(receipt.transactionHash)
    check(Boolean(rpc), `${name}: receipt transaction not captured`)
    same(receipt.blockHash, rpc.blockHash, `${name}: receipt block hash`)
    ;[
      "blockNumber",
      "transactionIndex",
      "gasUsed",
      "cumulativeGasUsed",
      "status",
    ].forEach((key) =>
      same(BigInt(receipt[key]), BigInt(rpc[key]), `${name}: receipt ${key}`)
    )
    ;["to", "from", "contractAddress"].forEach((key) =>
      same(
        receipt[key]?.toLowerCase() ?? null,
        rpc[key],
        `${name}: receipt ${key}`
      )
    )
    if (rpc.contractAddress) {
      same(
        deployment.address.toLowerCase(),
        rpc.contractAddress,
        `${name}: deployed address`
      )
    }
    same(receipt.logsBloom, rpc.logsBloom, `${name}: receipt bloom`)
    same(receipt.logs.length, rpc.logs.length, `${name}: receipt log count`)
    receipt.logs.forEach((log: Json, index: number) => {
      const captured = rpc.logs[index]
      ;["blockHash", "transactionHash", "data", "topics"].forEach((key) =>
        same(log[key], captured[key], `${name}: log ${key}`)
      )
      ;["blockNumber", "transactionIndex", "logIndex"].forEach((key) =>
        same(BigInt(log[key]), BigInt(captured[key]), `${name}: log ${key}`)
      )
      same(log.address.toLowerCase(), captured.address, `${name}: log address`)
    })
  })
  same(receiptCount, 46, "Local deployment receipt inventory")
  proxyNames.forEach((name) => {
    const record = json(snapshot, `deployments/hardhat/${name}.json`)
    const proxy = chain.proxies[name]
    same(proxy.address, record.address, `${name}: proxy address`)
    same(
      `0x${proxy.implementation.slice(-40)}`,
      record.implementation.toLowerCase(),
      `${name}: implementation slot`
    )
  })
  ;[
    ["Bridge.governance", "BridgeGovernance"],
    ["WalletRegistry.governance", "WalletRegistryGovernance"],
    ["WalletRegistry.walletOwner", "Bridge"],
  ].forEach(([getter, contract]) =>
    same(
      chain.governance[getter],
      json(snapshot, `deployments/hardhat/${contract}.json`).address,
      `${getter}: governance relationship`
    )
  )
}

export function compareSnapshots(
  baseline: Snapshot,
  candidate: Snapshot
): RawReport {
  const allowed = (name: string) =>
    proofFiles.includes(name) ||
    groups.some((group) =>
      group.endsWith("/") ? name.startsWith(group) : name === group
    )
  ;[baseline, candidate].forEach((snapshot) =>
    [...snapshot.keys()].forEach((name) =>
      check(allowed(name), `Unlisted file: ${name}`)
    )
  )
  const candidateInventory = [...candidate.keys()].map((name) =>
    name === newInput ? oldInput : name
  )
  same(
    candidateInventory.sort(),
    [...baseline.keys()].sort(),
    "File inventory differs"
  )
  const report = rawReport(baseline, candidate)
  checkRawInventory(report)
  const baselineGas = checkProvenance(baseline, candidate)
  const compiler = compareCompiler(baseline, candidate)
  const aChain = json(baseline, "chain.json")
  const bChain = json(candidate, "chain.json")
  validateDeployments(baseline, aChain)
  validateDeployments(candidate, bChain)
  const layouts = new Map(policy.layouts.map((fqn) => [artifactPath(fqn), fqn]))
  ;[...baseline.keys()].forEach((name) => {
    if (proofFiles.includes(name) || name === oldInput) return
    if (hasOwn(policy.compiledDeployScripts, name)) {
      const reviewed = policy.compiledDeployScripts[name]
      same(
        hash(bytes(baseline, name)),
        reviewed.baseline,
        `${name}: reviewed baseline script`
      )
      same(
        hash(bytes(candidate, name)),
        reviewed.candidate,
        `${name}: reviewed candidate script`
      )
      return
    }
    const layout = layouts.get(name)
    if (layout !== undefined) {
      const before = canonicalJson(baseline, name)
      const after = canonicalJson(candidate, name)
      check(
        !hasOwn(before, "storageLayout"),
        `${name}: baseline layout presence`
      )
      same(
        after.storageLayout,
        compiler[layout].output.storageLayout,
        `${name}: compiler storage layout`
      )
      delete after.storageLayout
      same(
        stringify(after),
        bytes(baseline, name).toString(),
        `${name}: unlisted artifact difference`
      )
      return
    }
    if (policy.changedDeployments.includes(name)) {
      const before = canonicalJson(baseline, name)
      const after = canonicalJson(candidate, name)
      // The receipt and every log have already been bound to their own chain.
      after.receipt.blockHash = before.receipt.blockHash
      same(
        after.receipt.logs.length,
        before.receipt.logs.length,
        `${name}: log count`
      )
      after.receipt.logs = after.receipt.logs.map((log: Json, i: number) => ({
        ...log,
        blockHash: before.receipt.logs[i].blockHash,
      }))
      if (name === "deployments/hardhat/BridgeGovernance.json") {
        check(
          !hasOwn(before, "storageLayout"),
          `${name}: baseline storage layout`
        )
        same(
          after.storageLayout,
          compiler[bridgeGovernance].output.storageLayout,
          `${name}: compiler storage layout`
        )
        same(
          before.solcInputHash,
          path.basename(oldInput, ".json"),
          `${name}: old input reference`
        )
        same(
          after.solcInputHash,
          path.basename(newInput, ".json"),
          `${name}: new input reference`
        )
        delete after.storageLayout
        after.solcInputHash = before.solcInputHash
      }
      same(
        stringify(after),
        bytes(baseline, name).toString(),
        `${name}: unlisted deployment difference`
      )
      return
    }
    check(
      bytes(baseline, name).equals(bytes(candidate, name)),
      `Unlisted byte difference: ${name}`
    )
  })
  compareChains(aChain, bChain, baselineGas)
  return report
}

if (require.main === module) {
  try {
    const [baselineDirectory, candidateDirectory, mode] = process.argv.slice(2)
    check(
      Boolean(baselineDirectory && candidateDirectory) &&
        (!mode || mode === "--raw"),
      "Usage: ts-node scripts/compare-pr1067-parity.ts BASELINE CANDIDATE [--raw]"
    )
    const baseline = readSnapshot(baselineDirectory)
    const candidate = readSnapshot(candidateDirectory)
    const raw = rawReport(baseline, candidate)
    checkRawInventory(raw)
    process.stdout.write(`${stringify(raw)}\n`)
    const strict = groups
      .slice(0, 3)
      .every((group) => raw[group].different.length === 0)
    process.stdout.write(
      `Original whole-file byte parity: ${strict ? "PASS" : "FAIL"}\n`
    )
    if (mode === "--raw") process.exitCode = strict ? 0 : 1
    else {
      compareSnapshots(baseline, candidate)
      process.stdout.write(
        "Compatibility with the two reviewed exceptions: PASS\n"
      )
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  }
}
