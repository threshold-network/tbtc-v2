// Opt-in, local-only capture for PR #1067. Copy this file unchanged to dev.
import { extendProvider, task } from "hardhat/config"
import { ProviderWrapper } from "hardhat/internal/core/providers/wrapper"
import type {
  HardhatNetworkConfig,
  HardhatRuntimeEnvironment,
} from "hardhat/types"
import hardhatPackage from "hardhat/package.json"
import deployPackage from "hardhat-deploy/package.json"
import { version as ethersVersion } from "ethers"
import fs from "fs"
import path from "path"
import { homedir } from "os"
import { createHash } from "crypto"
import { execFileSync } from "child_process"
import config from "../hardhat.config"

const projectRoot = path.resolve(__dirname, "..")
const fixedTime = Date.parse("2026-09-07T00:00:00Z")
const NativeDate = Date
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex")
const implementationSlot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const adminSlot =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
const layoutContracts = [
  "@keep-network/ecdsa/contracts/WalletRegistry.sol:WalletRegistry",
  "contracts/bridge/BridgeGovernance.sol:BridgeGovernance",
  "contracts/cross-chain/wormhole/L1BTCDepositorNttWithExecutor.sol:L1BTCDepositorNttWithExecutor",
]
const optionalDeployFlags = [
  "UPGRADE_BRIDGE",
  "VERIFY_REBATE",
  "REPAIR_BRIDGE_REBATE_STAKING",
  "DEPLOY_TIP109",
  "DEPLOY_TIP109_HOTFIX",
]

// This plugin ALWAYS merges home configuration, even with an empty local file.
// Refuse ambient configuration instead of modifying the user's home directory.
if (
  fs.existsSync(path.join(homedir(), ".hardhat", "networks.json")) ||
  fs.existsSync(path.join(projectRoot, "..", ".env")) ||
  config.localNetworksConfig
) {
  throw new Error(
    "Parity requires a checkout without .env or local/home network configuration"
  )
}
if (optionalDeployFlags.some((name) => process.env[name] === "true")) {
  throw new Error("Optional deployment/upgrade flags must be unset for parity")
}
config.paths = { ...config.paths, root: projectRoot }
config.networks.hardhat.initialDate = new NativeDate(fixedTime).toISOString()
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args) {
    return Reflect.construct(target, args.length ? args : [fixedTime])
  },
  get(target, property, receiver) {
    return property === "now"
      ? () => fixedTime
      : Reflect.get(target, property, receiver)
  },
})
extendProvider(async (provider, _config, networkName) => {
  if (networkName !== "hardhat") return provider
  return new (class extends ProviderWrapper {
    private readonly delegate = provider

    async request(args) {
      if (
        ["eth_sendTransaction", "eth_sendRawTransaction"].includes(args.method)
      ) {
        const block = (await this.delegate.request({
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        })) as { timestamp: string }
        await this.delegate.request({
          method: "evm_setNextBlockTimestamp",
          params: [Number.parseInt(block.timestamp, 16) + 1],
        })
      }
      return this.delegate.request(args)
    }
  })(provider)
})

async function capture(hre: HardhatRuntimeEnvironment, destination: string) {
  const rpc = (method: string, params: unknown[]) =>
    hre.network.provider.send(method, params)
  const count = Number(await rpc("eth_blockNumber", []))
  const numbers = Array.from(
    { length: count + 1 },
    (_, i) => `0x${i.toString(16)}`
  )
  const blocks = await Promise.all(
    numbers.map((n) => rpc("eth_getBlockByNumber", [n, false]))
  )
  // Both sides use a method untouched by helpers/provider.ts. Keep RPC fields
  // intact: no address, gas, receipt or timestamp normalization after capture.
  const fullBlocks = await Promise.all(
    numbers.map((n) => rpc("eth_getBlockByNumber", [n, true]))
  )
  const transactions = fullBlocks.flatMap((block) => block.transactions)
  const receipts = await Promise.all(
    transactions.map((tx) => rpc("eth_getTransactionReceipt", [tx.hash]))
  )
  const deployments = await hre.deployments.all()
  const proxies: Record<
    string,
    {
      address: string
      implementation: string
      admin: string
      adminOwner: string
    }
  > = Object.fromEntries(
    await Promise.all(
      Object.entries(deployments)
        .filter(([, d]) => d.implementation)
        .map(async ([name, d]) => {
          const [implementation, admin] = await Promise.all([
            rpc("eth_getStorageAt", [d.address, implementationSlot, "latest"]),
            rpc("eth_getStorageAt", [d.address, adminSlot, "latest"]),
          ])
          const adminAddress = `0x${admin.slice(-40)}`
          return [
            name,
            {
              address: d.address,
              implementation,
              admin,
              adminOwner: await rpc("eth_call", [
                { to: adminAddress, data: "0x8da5cb5b" },
                "latest",
              ]),
            },
          ]
        })
    )
  )
  const addresses = [
    ...new Set(
      [
        ...Object.values(deployments).flatMap((d) =>
          [d.address, d.implementation].filter(Boolean)
        ),
        ...receipts.map((r) => r.contractAddress).filter(Boolean),
        ...Object.values(proxies).map((p) => `0x${p.admin.slice(-40)}`),
      ].map((a) => a.toLowerCase())
    ),
  ].sort()
  const code = Object.fromEntries(
    await Promise.all(
      addresses.map(async (address) => [
        address,
        await rpc("eth_getCode", [address, "latest"]),
      ])
    )
  )
  const owners = Object.fromEntries(
    await Promise.all(
      Object.entries(deployments)
        .filter(([, d]) =>
          d.abi.some(
            (f) =>
              f.type === "function" &&
              f.name === "owner" &&
              f.inputs.length === 0
          )
        )
        .map(async ([name, d]) => [
          name,
          await rpc("eth_call", [
            { to: d.address, data: "0x8da5cb5b" },
            "latest",
          ]),
        ])
    )
  )
  const governance = Object.fromEntries(
    await Promise.all(
      Object.entries(deployments).flatMap(([name, d]) =>
        d.abi
          .filter(
            (f) =>
              f.type === "function" &&
              ["governance", "walletOwner"].includes(f.name) &&
              f.inputs.length === 0 &&
              f.outputs.length === 1 &&
              f.outputs[0].type === "address"
          )
          .map(async (f) => [
            `${name}.${f.name}`,
            await hre.deployments.read(name, f.name),
          ])
      )
    )
  )
  const compiler = Object.fromEntries(
    await Promise.all(
      layoutContracts.map(async (fqn) => {
        const info = await hre.artifacts.getBuildInfo(fqn)
        if (!info) throw new Error(`Missing compiler evidence: ${fqn}`)
        const [source, name] = fqn.split(":")
        return [
          fqn,
          {
            solcVersion: info.solcVersion,
            solcLongVersion: info.solcLongVersion,
            input: info.input,
            output: info.output.contracts[source][name],
          },
        ]
      })
    )
  )
  const { accounts, ...network } = hre.network.config
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(
      path.join(destination, name),
      JSON.stringify(
        data,
        (_key, value) => {
          if (typeof value === "bigint") return value.toString()
          if (value instanceof Map) return [...value.entries()]
          return value
        },
        2
      )
    )
  fs.mkdirSync(destination, { recursive: true })
  write("chain.json", {
    chainId: await rpc("eth_chainId", []),
    blocks,
    transactions,
    receipts,
    namedAccounts: await hre.getNamedAccounts(),
    proxies,
    owners,
    governance,
    code,
  })
  write("compiler.json", compiler)
  write("provenance.json", {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim(),
    node: process.version,
    hardhat: hardhatPackage.version,
    hardhatDeploy: deployPackage.version,
    ethers: ethersVersion,
    lockfileSha256: sha256(
      fs.readFileSync(path.join(projectRoot, "yarn.lock"))
    ),
    captureSha256: sha256(fs.readFileSync(__filename)),
    configSha256: sha256(
      fs.readFileSync(path.join(projectRoot, "hardhat.config.ts"))
    ),
    transactionCaptureMethod: "eth_getBlockByNumber(number,true)",
    network,
    accountsSha256: sha256(Buffer.from(JSON.stringify(accounts))),
    compilerOverrides: Object.keys(hre.config.solidity.overrides).sort(),
    arguments: process.argv.slice(2),
    environment: { USE_EXTERNAL_DEPLOY: "true", TEST_USE_STUBS_TBTC: "true" },
  })
  const files = ["export.json", "yarn.lock", "package.json"]
  files.forEach((name) =>
    fs.copyFileSync(path.join(projectRoot, name), path.join(destination, name))
  )
  const directories = ["export/artifacts", "export/deploy", "deployments"]
  directories.forEach((name) =>
    fs.cpSync(path.join(projectRoot, name), path.join(destination, name), {
      recursive: true,
    })
  )
}

task("deploy").setAction(async (args, hre, runSuper) => {
  const destination = process.env.PR1067_CAPTURE
  if (
    hre.network.name !== "hardhat" ||
    (hre.network.config as HardhatNetworkConfig).forking?.enabled ||
    process.env.USE_EXTERNAL_DEPLOY !== "true" ||
    process.env.TEST_USE_STUBS_TBTC !== "true"
  )
    throw new Error(
      "Parity requires non-forked in-process Hardhat with both test deployment flags"
    )
  if (
    !destination ||
    !path.isAbsolute(destination) ||
    fs.existsSync(destination)
  ) {
    throw new Error(
      "PR1067_CAPTURE must name a new absolute snapshot directory"
    )
  }
  const result = await runSuper(args)
  await capture(hre, destination)
  return result
})
export default config
