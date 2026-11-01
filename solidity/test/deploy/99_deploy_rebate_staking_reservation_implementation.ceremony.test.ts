import { expect } from "chai"
import fs from "fs"
import path from "path"
import { artifacts } from "hardhat"
import { ethers } from "ethers"
import func, {
  additionalStakingSourcePath,
  artifactLinkSites,
  assertStorageGate,
  bridgeRuntimeWithLibraries,
  compiledStorageLayout,
  deployedLibraryRuntime,
  readStorageLayoutFile,
  type StorageLayout,
} from "../../deploy/99_deploy_rebate_staking_reservation_implementation"
import {
  EIP_1967_ADMIN_SLOT,
  EIP_1967_IMPLEMENTATION_SLOT,
  KNOWN_PROXY_ADMIN,
  KNOWN_TIMELOCK,
} from "../../deploy/85_deploy_tip109_governance_upgrade"

/**
 * The ceremony, end to end.
 *
 * Every other test in this suite calls an exported helper. That leaves the
 * wiring untested: deleting `assertStorageGate`, the enum pin inside it,
 * `assertRecordAddressMatchesImplementation` or
 * `assertBridgeRebateStakingPointer` from the deploy function leaves the
 * whole suite green, because nothing ever runs the deploy function.
 *
 * These cases run it. The mock HRE carries a chain shaped like the mainnet
 * one: the Bridge proxy delegates to an implementation that is not the
 * input, the RebateStaking proxy delegates to the build the baseline record
 * describes, the ProxyAdmin is owned by the Timelock, and the input Bridge
 * implementation is the release build linked against the release libraries.
 * Every one of those is a *real* artifact: the Bridge runtime is the
 * compiled one with the library addresses substituted, and the library
 * runtimes are the compiled ones with their own address written in, so the
 * ceremony's identity proofs run against the bytes they will meet on chain.
 *
 * Each negative case breaks one guard's precondition and asserts the reason
 * the ceremony stops with. A guard deleted from the call site makes the
 * ceremony complete, and the case fails.
 */

/** The parts of the HRE the ceremony touches. */
interface MockProvider {
  getCode(address: string): Promise<string>
  getStorage(address: string, slot: string): Promise<string>
  call(transaction: { data?: string }): Promise<string>
}

interface MockDeployments {
  get(name: string): Promise<{ address: string }>
  deploy(name: string): Promise<{ address: string }>
  read(name: string, method: string): Promise<string>
}

interface MockHre {
  network: { name: string }
  getNamedAccounts(): Promise<{ deployer: string }>
  getChainId(): Promise<string>
  deployments: MockDeployments
  ethers: {
    getAddress(value: string): string
    id(text: string): string
    keccak256(data: string): string
    Contract: typeof ethers.Contract
    Interface: typeof ethers.Interface
    ZeroAddress: string
    ZeroHash: string
    AbiCoder: typeof ethers.AbiCoder
    provider: MockProvider
  }
}

const NETWORK = "ceremony-mock"
const DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments", NETWORK)
const BASELINE_RECORD_PATH = path.join(
  __dirname,
  "..",
  "..",
  "deployments",
  "mainnet",
  "RebateStakingTIP109HotfixImplementation.json"
)

const BRIDGE_PROXY = "0x5e4861a80b55f035d899f66772117f00fa0e8e7b"
const STAKING_PROXY = "0x0184739c32edc3471d3e4860c8e39a5f3ff85a45"
const BRIDGE_IMPL_INPUT = "0x3333333333333333333333333333333333333333"
const CURRENT_BRIDGE_IMPL = "0x4444444444444444444444444444444444444444"
const NEW_STAKING_IMPL = "0x5555555555555555555555555555555555555555"
const DEPLOYER = "0x6666666666666666666666666666666666666666"
const OTHER_STAKING_IMPL = "0x7777777777777777777777777777777777777777"
const OTHER_POINTER = "0x9999999999999999999999999999999999999999"

const BASELINE_NAME = "RebateStakingTIP109HotfixImplementation"
const HEAD_NAME = "RebateStakingReservationImplementation"

/** A storage word holding an address in the EIP-1967 slot layout. */
function addressWord(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`
}

interface CeremonyOverrides {
  /** The implementation the RebateStaking proxy delegates to. */
  installedImplementation?: string
  /** `Bridge.getRebateStaking()`. */
  bridgePointer?: string
  /** The head layout the ceremony reads out of the record it wrote. */
  headLayout?: StorageLayout
}

interface CeremonyFixture {
  mockHre: MockHre
  baselineAddress: string
}

/**
 * The mock HRE, with the chain and the records the ceremony reads.
 */
async function createCeremony(
  overrides: CeremonyOverrides = {}
): Promise<CeremonyFixture> {
  const baseline: unknown = JSON.parse(
    fs.readFileSync(BASELINE_RECORD_PATH, "utf8")
  )
  if (
    typeof baseline !== "object" ||
    baseline === null ||
    !("address" in baseline) ||
    !("deployedBytecode" in baseline)
  ) {
    throw new Error("the baseline record has no address or bytecode")
  }
  const baselineRecord = baseline as {
    address: string
    deployedBytecode: string
  }
  const baselineAddress = baselineRecord.address
  const installedImplementation =
    overrides.installedImplementation ?? baselineAddress
  const bridgePointer = overrides.bridgePointer ?? STAKING_PROXY

  // The release Bridge build, linked against the release libraries.
  const bridgeArtifact = await artifacts.readArtifact("Bridge")
  const linkSites = artifactLinkSites(bridgeArtifact.deployedLinkReferences)
  const libraryAddresses: Record<string, string> = {}
  let counter = 0xa01
  linkSites.forEach((site) => {
    if (libraryAddresses[site.library] === undefined) {
      libraryAddresses[site.library] = ethers.getAddress(
        `0x${counter.toString(16).padStart(40, "0")}`
      )
      counter += 1
    }
  })
  const bridgeRuntime = bridgeRuntimeWithLibraries(
    bridgeArtifact.deployedBytecode,
    linkSites,
    libraryAddresses
  )

  const headLayout =
    overrides.headLayout ??
    (await compiledStorageLayout(
      "contracts/bridge/RebateStaking.sol:RebateStaking"
    ))
  const headArtifact = await artifacts.readArtifact("RebateStaking")

  // The chain: the code at each address the ceremony reads.
  const code: Record<string, string> = {
    [BRIDGE_IMPL_INPUT.toLowerCase()]: bridgeRuntime,
    [installedImplementation.toLowerCase()]: baselineRecord.deployedBytecode,
  }
  const libraryRuntimes = await Promise.all(
    Object.entries(libraryAddresses).map(async ([name, address]) => {
      const libraryArtifact = await artifacts.readArtifact(
        `contracts/bridge/${name}.sol:${name}`
      )
      return [
        address.toLowerCase(),
        deployedLibraryRuntime(libraryArtifact.deployedBytecode, address),
      ] as const
    })
  )
  libraryRuntimes.forEach(([address, runtime]) => {
    code[address] = runtime
  })

  const storage: Record<string, string> = {
    [`${STAKING_PROXY}:${EIP_1967_IMPLEMENTATION_SLOT}`]: addressWord(
      installedImplementation
    ),
    [`${BRIDGE_PROXY}:${EIP_1967_IMPLEMENTATION_SLOT}`]:
      addressWord(CURRENT_BRIDGE_IMPL),
    [`${STAKING_PROXY}:${EIP_1967_ADMIN_SLOT}`]: addressWord(
      KNOWN_PROXY_ADMIN.toLowerCase()
    ),
    [`${BRIDGE_PROXY}:${EIP_1967_ADMIN_SLOT}`]: addressWord(
      KNOWN_PROXY_ADMIN.toLowerCase()
    ),
  }

  const callInterface = new ethers.Interface([
    "function owner() view returns (address)",
    "function getMinDelay() view returns (uint256)",
  ])

  const provider: MockProvider = {
    async getCode(address: string): Promise<string> {
      return code[address.toLowerCase()] ?? "0x"
    },
    async getStorage(address: string, slot: string): Promise<string> {
      return (
        storage[`${address.toLowerCase()}:${slot}`] ?? `0x${"0".repeat(64)}`
      )
    },
    async call(transaction: { data?: string }): Promise<string> {
      const data = transaction.data ?? "0x"
      const fragment = callInterface.getFunction(data.slice(0, 10))
      if (fragment === null) {
        throw new Error(`no such function ${data.slice(0, 10)}`)
      }
      if (fragment.name === "owner") {
        return ethers.AbiCoder.defaultAbiCoder().encode(
          ["address"],
          [KNOWN_TIMELOCK]
        )
      }
      if (fragment.name === "getMinDelay") {
        return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [86400])
      }
      throw new Error(`unexpected call ${data.slice(0, 10)}`)
    },
  }

  // The records the ceremony reads out of disk.
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(DEPLOYMENTS_DIR, `${BASELINE_NAME}.json`),
    JSON.stringify(baselineRecord, null, 2)
  )

  const deployments: MockDeployments = {
    async get(name: string): Promise<{ address: string }> {
      if (name === "Bridge") return { address: BRIDGE_PROXY }
      if (name === "RebateStaking") return { address: STAKING_PROXY }
      throw new Error(`no deployment named ${name}`)
    },
    async deploy(name: string): Promise<{ address: string }> {
      if (name !== HEAD_NAME) {
        throw new Error(`the ceremony deployed ${name}`)
      }
      fs.writeFileSync(
        path.join(DEPLOYMENTS_DIR, `${HEAD_NAME}.json`),
        JSON.stringify(
          {
            address: NEW_STAKING_IMPL,
            deployedBytecode: headArtifact.deployedBytecode,
            storageLayout: headLayout,
          },
          null,
          2
        )
      )
      return { address: NEW_STAKING_IMPL }
    },
    async read(name: string, method: string): Promise<string> {
      if (name === "Bridge" && method === "getRebateStaking") {
        return bridgePointer
      }
      throw new Error(`unexpected read ${name}.${method}`)
    },
  }

  const mockHre: MockHre = {
    network: { name: NETWORK },
    getNamedAccounts: async () => ({ deployer: DEPLOYER }),
    getChainId: async () => "31337",
    deployments,
    ethers: {
      getAddress: ethers.getAddress,
      id: ethers.id,
      keccak256: ethers.keccak256,
      Contract: ethers.Contract,
      Interface: ethers.Interface,
      ZeroAddress: ethers.ZeroAddress,
      ZeroHash: ethers.ZeroHash,
      AbiCoder: ethers.AbiCoder,
      provider,
    },
  }

  return { mockHre, baselineAddress }
}

/** Runs the ceremony with the console quiet. */
async function runCeremony(
  mockHre: MockHre
): Promise<{ error: Error | undefined; output: string }> {
  const originalLog = console.log
  const messages: string[] = []
  console.log = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "))
  }
  let error: Error | undefined
  try {
    await func(mockHre as unknown as Parameters<typeof func>[0])
  } catch (caught) {
    error = caught as Error
  } finally {
    console.log = originalLog
  }
  return { error, output: messages.join("\n") }
}

/** The ceremony record the run wrote. */
function readCeremonyRecord(): Record<string, unknown> {
  const files = fs
    .readdirSync(DEPLOYMENTS_DIR)
    .filter((file) => file.startsWith("reservations-rebate-batch-"))
    .sort()
  if (files.length === 0) {
    throw new Error("the ceremony wrote no record")
  }
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(DEPLOYMENTS_DIR, files[files.length - 1]), "utf8")
  )
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the ceremony record is not an object")
  }
  return parsed as Record<string, unknown>
}

/** The head source with the fee-mode enum reordered. */
function reorderedSource(): string {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "contracts",
      "bridge",
      "RebateStaking.sol"
    ),
    "utf8"
  )
  const reordered = source.replace(
    "enum RebateTreasuryFeeMode {\n        Both,\n        DepositOnly,\n        RedemptionOnly\n    }",
    "enum RebateTreasuryFeeMode {\n        Both,\n        RedemptionOnly,\n        DepositOnly\n    }"
  )
  if (reordered === source) {
    throw new Error("the fee-mode enum in the source did not reorder")
  }
  return reordered
}

describe("deploy/99 the ceremony, end to end", () => {
  const originalBridgeImplementation =
    process.env.BRIDGE_RESERVATION_IMPLEMENTATION
  const originalExtraSourcePath = process.env.REBATE_STAKING_EXTRA_SOURCE_PATH

  beforeEach(() => {
    process.env.BRIDGE_RESERVATION_IMPLEMENTATION = BRIDGE_IMPL_INPUT
    delete process.env.REBATE_STAKING_EXTRA_SOURCE_PATH
    fs.rmSync(DEPLOYMENTS_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    fs.rmSync(DEPLOYMENTS_DIR, { recursive: true, force: true })
    if (originalBridgeImplementation === undefined) {
      delete process.env.BRIDGE_RESERVATION_IMPLEMENTATION
    } else {
      process.env.BRIDGE_RESERVATION_IMPLEMENTATION =
        originalBridgeImplementation
    }
    if (originalExtraSourcePath === undefined) {
      delete process.env.REBATE_STAKING_EXTRA_SOURCE_PATH
    } else {
      process.env.REBATE_STAKING_EXTRA_SOURCE_PATH = originalExtraSourcePath
    }
  })

  after(() => {
    fs.rmSync(DEPLOYMENTS_DIR, { recursive: true, force: true })
  })

  it("completes and emits the batch in the required order", async () => {
    const { mockHre } = await createCeremony()
    const { error, output } = await runCeremony(mockHre)
    expect(error, output).to.equal(undefined)

    const record = readCeremonyRecord()
    expect(record.network).to.equal(NETWORK)
    const existing = record.existingContracts as Record<string, string>
    expect(existing.BridgeRebateStaking).to.equal(STAKING_PROXY)
    expect(existing.Bridge).to.equal(BRIDGE_PROXY)
    expect(existing.RebateStaking).to.equal(STAKING_PROXY)
    const deployed = record.deployedContracts as Record<string, string>
    expect(deployed[HEAD_NAME]).to.equal(NEW_STAKING_IMPL)
    const inputs = record.inputContracts as Record<string, string>
    expect(inputs.BridgeReservationImplementation).to.equal(BRIDGE_IMPL_INPUT)
    const timelock = record.timelock as {
      batch: { targets: string[]; payloads: string[] }
    }
    expect(timelock.batch.targets).to.deep.equal([
      KNOWN_PROXY_ADMIN,
      KNOWN_PROXY_ADMIN,
    ])
    expect(timelock.batch.payloads.length).to.equal(2)

    // The order is the whole point of the batch, so the payloads are
    // decoded and checked rather than merely counted: action [0] upgrades
    // the RebateStaking proxy, action [1] the Bridge proxy. The addresses
    // are compared case-insensitively: the decoded ones are checksummed,
    // the fixtures are not.
    const proxyAdminInterface = new ethers.Interface([
      "function upgrade(address,address)",
    ])
    const decoded = timelock.batch.payloads.map((payload) =>
      proxyAdminInterface.decodeFunctionData("upgrade", payload)
    )
    expect(String(decoded[0][0]).toLowerCase()).to.equal(
      STAKING_PROXY.toLowerCase()
    )
    expect(String(decoded[0][1]).toLowerCase()).to.equal(
      NEW_STAKING_IMPL.toLowerCase()
    )
    expect(String(decoded[1][0]).toLowerCase()).to.equal(
      BRIDGE_PROXY.toLowerCase()
    )
    expect(String(decoded[1][1]).toLowerCase()).to.equal(
      BRIDGE_IMPL_INPUT.toLowerCase()
    )
  })

  it("stops when the head layout is incompatible with the deployed one", async () => {
    // Deleting the storage gate from the ceremony makes this run complete,
    // and the assertion below is what catches it.
    const head = await compiledStorageLayout(
      "contracts/bridge/RebateStaking.sol:RebateStaking"
    )
    const moved = JSON.parse(JSON.stringify(head)) as StorageLayout
    const field = moved.storage.find(
      (entry) => entry.label === "rebatePerToken"
    )
    if (field === undefined) throw new Error("no rebatePerToken field")
    field.slot = "99"

    const broken = await createCeremony({ headLayout: moved })
    const { error, output } = await runCeremony(broken.mockHre)
    expect(error, output).to.not.equal(undefined)
    expect(error?.message).to.match(/incompatible storage layout/i)
  })

  it("stops when the fee-mode enum is reordered in the source", async () => {
    // The enum pin is the one part of the gate the layout comparison
    // cannot see. Deleting it from the gate makes this run complete.
    //
    // The reordered source is pinned *in addition to* the canonical one,
    // never instead of it, so it can only make the gate stricter.
    const sourcePath = path.join(DEPLOYMENTS_DIR, "reordered-RebateStaking.sol")
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
    fs.writeFileSync(sourcePath, reorderedSource())
    process.env.REBATE_STAKING_EXTRA_SOURCE_PATH = sourcePath

    const { mockHre } = await createCeremony()
    const { error, output } = await runCeremony(mockHre)
    expect(error, output).to.not.equal(undefined)
    expect(error?.message).to.match(
      /declares \[Both, RedemptionOnly, DepositOnly\]/
    )
  })

  it("pins the canonical source even when an extra source is given", async () => {
    // The extra source is an *additional* pin, never a replacement. A
    // source in the right order must not be able to stand in for the
    // canonical source, and the canonical source is pinned either way.
    //
    // This is the property the seam could have got wrong: if the extra
    // source *replaced* the canonical one, a reordered canonical source
    // would pass whenever a correct-order extra source was present.
    const deployed = readStorageLayoutFile(BASELINE_RECORD_PATH)
    const head = await compiledStorageLayout(
      "contracts/bridge/RebateStaking.sol:RebateStaking"
    )
    const canonical = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "contracts",
        "bridge",
        "RebateStaking.sol"
      ),
      "utf8"
    )

    // A correct-order extra source does not rescue a reordered canonical
    // source: the canonical source is pinned in its own right.
    expect(() =>
      assertStorageGate({
        deployed,
        head,
        stakingSource: reorderedSource(),
        additionalStakingSources: [canonical],
      })
    ).to.throw(/declares \[Both, RedemptionOnly, DepositOnly\]/)

    // And a correct-order extra source does not rescue a canonical source
    // that carries no enum at all: the canonical source is not optional.
    expect(() =>
      assertStorageGate({
        deployed,
        head,
        stakingSource: "contract Unrelated { uint256 public x; }\n",
        additionalStakingSources: [canonical],
      })
    ).to.throw(/enum RebateTreasuryFeeMode not found/)
  })

  it("applies the extra source rather than ignoring it", async () => {
    // The extra source is genuinely pinned: a source that carries no enum
    // at all is rejected, not silently skipped. An extra source that was
    // ignored would leave the gate exactly as permissive as before.
    const sourcePath = path.join(DEPLOYMENTS_DIR, "no-enum.sol")
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
    fs.writeFileSync(
      sourcePath,
      "contract Unrelated { uint256 public x; }\n"
    )
    process.env.REBATE_STAKING_EXTRA_SOURCE_PATH = sourcePath

    const { mockHre } = await createCeremony()
    const { error, output } = await runCeremony(mockHre)
    expect(error, output).to.not.equal(undefined)
    expect(error?.message).to.match(/enum RebateTreasuryFeeMode not found/)
  })

  it("refuses the source override outside a test network", async () => {
    // The override is a test seam. On a live network it would change which
    // source the fee-mode enum order is pinned against, so a ceremony there
    // could certify a build against a source that is not the deployed
    // contract's. It has to be refused loudly, not silently ignored and
    // not silently honoured.
    process.env.REBATE_STAKING_EXTRA_SOURCE_PATH = path.join(
      DEPLOYMENTS_DIR,
      "reordered-RebateStaking.sol"
    )
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
    fs.writeFileSync(
      process.env.REBATE_STAKING_EXTRA_SOURCE_PATH,
      reorderedSource()
    )

    // The resolver refuses it off a test network...
    expect(() => additionalStakingSourcePath("mainnet")).to.throw(
      /REBATE_STAKING_EXTRA_SOURCE_PATH is set to .* test-only seam/
    )
    expect(() => additionalStakingSourcePath("sepolia")).to.throw(
      /test-only seam/
    )
    // ...and accepts it on one.
    expect(additionalStakingSourcePath(NETWORK)).to.equal(
      process.env.REBATE_STAKING_EXTRA_SOURCE_PATH
    )

    // The ceremony refuses it too, and it refuses it before doing any
    // work, so the reason the operator sees is the override and not some
    // later lookup.
    const { mockHre } = await createCeremony()
    mockHre.network = { name: "mainnet" }
    const { error, output } = await runCeremony(mockHre)
    expect(error, output).to.not.equal(undefined)
    expect(error?.message).to.match(
      /REBATE_STAKING_EXTRA_SOURCE_PATH is set to .* test-only seam/
    )
  })

  it("stops when the baseline record is not the installed implementation", async () => {
    // Deleting the record-versus-installed check from the ceremony makes
    // this run complete.
    const { mockHre } = await createCeremony({
      installedImplementation: OTHER_STAKING_IMPL,
    })
    const { error, output } = await runCeremony(mockHre)
    expect(error, output).to.not.equal(undefined)
    expect(error?.message).to.match(/is not the build the proxy delegates to/)
  })

  it("stops when the Bridge's rebate-staking pointer names another address", async () => {
    // Deleting the pointer check from the ceremony makes this run complete.
    const { mockHre } = await createCeremony({ bridgePointer: OTHER_POINTER })
    const { error, output } = await runCeremony(mockHre)
    expect(error, output).to.not.equal(undefined)
    expect(error?.message).to.match(/Bridge\.getRebateStaking\(\) is/)
  })

  it("reports a zero pointer as unset instead of stopping the run", async () => {
    // The documented "no rebate staking" state: the remedy would not land,
    // but it is not a mismatch, so the ceremony still emits the batch and
    // says so.
    const { mockHre } = await createCeremony({
      bridgePointer: ethers.ZeroAddress,
    })
    const { error, output } = await runCeremony(mockHre)
    expect(error, output).to.equal(undefined)
    expect(output).to.match(/WARNING: Bridge\.getRebateStaking\(\)/)
    const record = readCeremonyRecord()
    const existing = record.existingContracts as Record<string, string>
    expect(existing.BridgeRebateStaking).to.equal(ethers.ZeroAddress)
  })
})
