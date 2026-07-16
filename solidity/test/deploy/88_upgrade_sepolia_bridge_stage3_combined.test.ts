/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai"
import { ethers } from "hardhat"
import fs from "fs"
import path from "path"
import func from "../../deploy/88_upgrade_sepolia_bridge_stage3_combined"

const { utils } = ethers

// Pinned values mirrored from the script under test.
const BRIDGE_PROXY = "0x9b1a7fE5a16A15F2f9475C5B231750598b113403"
const OLD_IMPL = "0xa14a9607dede925c7f7acfb27ce192771f8f6fa0"
const PROXY_ADMIN = "0x39f60b25c4598caf7e922d6fc063e9002db45845"
const PROXY_ADMIN_OWNER = "0x68ad60CC5e8f3B7cC53beaB321cf0e6036962dBc"
const BRIDGE_GOVERNANCE = "0x5F491868637fA298C5eE2BFcA557C02C083A4b4B"
const G1 = "0x1433e4f7a1FD121a0988d12A2323Bb95E2D54A0E"
const BANK = "0x4918fD33a22e7E2948B7444CbDd68efAa9E6a087"
const REGISTRY = "0x1234567890123456789012345678901234567890"
const NEW_IMPL = "0x2222222222222222222222222222222222222222"
const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

// The real old Sepolia implementation runtime (keccak matches the pinned
// EXPECTED_OLD_RUNTIME_HASH, controller selectors present, PR selectors absent).
const OLD_RUNTIME = fs
  .readFileSync(
    path.resolve(__dirname, "../data/stage3-old-bridge-impl-runtime.hex"),
    "utf8"
  )
  .trim()

// A short, placeholder-free runtime well under the EIP-170 limit for the new
// implementation.
const NEW_RUNTIME = `0x${"60".repeat(2000)}`
const REGISTRY_RUNTIME = `0x${"61".repeat(50)}`

async function expectReject(
  promise: Promise<unknown>,
  substring?: string
): Promise<void> {
  try {
    await promise
    expect.fail("expected the promise to reject")
  } catch (error) {
    if (substring) expect((error as Error).message).to.include(substring)
  }
}

const iface = new utils.Interface([
  "function owner() view returns (address)",
  "function governance() view returns (address)",
  "function mintingController() view returns (address)",
  "function getMintingController() view returns (address)",
  "function migrationDebtVault() view returns (address)",
  "function activeWalletPubKeyHash() view returns (bytes20)",
  "function bridge() view returns (address)",
  "function bank() view returns (address)",
  "function mintingPaused() view returns (bool)",
])
const sig = (fn: string) => iface.getSighash(fn)
const addrWord = (a: string) => utils.hexZeroPad(a.toLowerCase(), 32)

interface Overrides {
  chainId?: string
  deployer?: string
  bridgeCode?: string
  implSlot?: string
  oldRuntime?: string
  adminSlot?: string
  proxyAdminOwner?: string
  governance?: string
  initSlot?: string
  controller?: string
  slot81?: string
  g1Bridge?: string
  g1Bank?: string
  g1Paused?: boolean
  registryPresent?: boolean
  registryRuntime?: string
  registryOwner?: string
  registryEnvOwner?: string
  activeWallet?: string
  newRuntime?: string
}

function createMockHre(o: Overrides = {}): {
  mockHre: any
  deployCalls: any[]
  upgradeCalls: any[]
  savedProxy: boolean
} {
  const deployCalls: any[] = []
  const upgradeCalls: any[] = []
  const state = { savedProxy: false }

  const codeFor = (addr: string): string => {
    const a = addr.toLowerCase()
    if (a === BRIDGE_PROXY.toLowerCase()) return o.bridgeCode ?? "0x1234"
    if (a === OLD_IMPL.toLowerCase()) return o.oldRuntime ?? OLD_RUNTIME
    if (a === REGISTRY.toLowerCase())
      return o.registryRuntime ?? REGISTRY_RUNTIME
    if (a === NEW_IMPL.toLowerCase()) return o.newRuntime ?? NEW_RUNTIME
    return "0x"
  }

  const provider = {
    getCode: async (addr: string) => codeFor(addr),
    getStorageAt: async (addr: string, slot: string | number) => {
      const s = typeof slot === "number" ? slot : slot.toLowerCase()
      if (s === IMPL_SLOT) return o.implSlot ?? addrWord(OLD_IMPL)
      if (s === ADMIN_SLOT) return o.adminSlot ?? addrWord(PROXY_ADMIN)
      if (s === 50) return o.initSlot ?? utils.hexZeroPad("0x05", 32)
      if (s === 81) return o.slot81 ?? addrWord(G1)
      return utils.hexZeroPad("0x00", 32)
    },
    call: async ({ to, data }: { to: string; data: string }) => {
      const selector = data.slice(0, 10)
      const a = to.toLowerCase()
      // Encode addresses lowercased so a differently-checksummed test constant
      // never trips ethers' checksum validation.
      const encAddr = (v: string) =>
        utils.defaultAbiCoder.encode(["address"], [v.toLowerCase()])
      if (a === PROXY_ADMIN.toLowerCase())
        return encAddr(o.proxyAdminOwner ?? PROXY_ADMIN_OWNER)
      if (a === REGISTRY.toLowerCase())
        return encAddr(o.registryOwner ?? PROXY_ADMIN_OWNER)
      if (a === BRIDGE_PROXY.toLowerCase()) {
        if (selector === sig("governance"))
          return encAddr(o.governance ?? BRIDGE_GOVERNANCE)
        if (
          selector === sig("mintingController") ||
          selector === sig("getMintingController")
        )
          return encAddr(o.controller ?? G1)
        if (selector === sig("activeWalletPubKeyHash"))
          return utils.defaultAbiCoder.encode(
            ["bytes20"],
            [o.activeWallet ?? "0x0000000000000000000000000000000000000000"]
          )
        if (selector === sig("migrationDebtVault"))
          return encAddr("0x0000000000000000000000000000000000000000")
      }
      if (a === G1.toLowerCase()) {
        if (selector === sig("bridge"))
          return encAddr(o.g1Bridge ?? BRIDGE_PROXY)
        if (selector === sig("bank")) return encAddr(o.g1Bank ?? BANK)
        if (selector === sig("mintingPaused"))
          return utils.defaultAbiCoder.encode(["bool"], [o.g1Paused ?? false])
      }
      return "0x"
    },
    getBalance: async () => ethers.BigNumber.from(0),
    getBlockNumber: async () => 11280610,
    getLogs: async () => [],
    getTransaction: async () => ({ value: ethers.BigNumber.from(0) }),
  }

  const registryArtifact = {
    deployedBytecode: o.registryRuntime ?? REGISTRY_RUNTIME,
  }

  const mockHre: any = {
    ethers: {
      ...ethers,
      provider,
      getSigner: async () => ({ address: PROXY_ADMIN_OWNER }),
      Contract: class {
        // eslint-disable-next-line class-methods-use-this
        upgradeAndCall(...args: unknown[]) {
          upgradeCalls.push(args)
          return {
            wait: async () => ({ transactionHash: "0xabc", blockNumber: 1 }),
          }
        }
      },
      utils: ethers.utils,
      constants: ethers.constants,
      BigNumber: ethers.BigNumber,
    },
    deployments: {
      deploy: async (name: string, opts: any) => {
        deployCalls.push({ name, options: opts })
        return {
          address: name.includes("Implementation") ? NEW_IMPL : REGISTRY,
        }
      },
      get: async (name: string) => {
        if (name === "CovenantSpendAuthorization") {
          if (o.registryPresent === false) throw new Error("not found")
          return { address: REGISTRY }
        }
        return { address: BRIDGE_PROXY, receipt: { blockNumber: 4553028 } }
      },
      save: async () => {
        state.savedProxy = true
      },
    },
    artifacts: {
      readArtifact: async () => registryArtifact,
      readArtifactSync: () => ({ abi: [] }),
    },
    getNamedAccounts: async () => ({
      deployer: o.deployer ?? PROXY_ADMIN_OWNER,
    }),
    getChainId: async () => o.chainId ?? "11155111",
    network: { name: "sepolia", tags: {} },
  }
  return { mockHre, deployCalls, upgradeCalls, savedProxy: state.savedProxy }
}

describe("88_upgrade_sepolia_bridge_stage3_combined", () => {
  const ENV_KEYS = [
    "DEPLOY_STAGE3_COMBINED_UPGRADE",
    "EXECUTE_STAGE3_COMBINED_UPGRADE",
    "COVENANT_SPEND_AUTHORIZATION_OWNER",
    "COVENANT_SPEND_AUTHORIZATION",
    "ETHERSCAN_API_KEY",
  ]
  let savedEnv: Record<string, string | undefined>
  let originalMkdirSync: typeof fs.mkdirSync
  let originalWriteFileSync: typeof fs.writeFileSync
  let originalConsoleLog: typeof console.log
  let summaryWritten: boolean

  beforeEach(() => {
    savedEnv = {}
    ENV_KEYS.forEach((k) => {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    })
    process.env.COVENANT_SPEND_AUTHORIZATION_OWNER = PROXY_ADMIN_OWNER

    summaryWritten = false
    originalMkdirSync = fs.mkdirSync
    originalWriteFileSync = fs.writeFileSync
    originalConsoleLog = console.log
    ;(fs as any).mkdirSync = () => undefined
    ;(fs as any).writeFileSync = () => {
      summaryWritten = true
    }
    console.log = () => undefined
  })

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    })
    ;(fs as any).mkdirSync = originalMkdirSync
    ;(fs as any).writeFileSync = originalWriteFileSync
    console.log = originalConsoleLog
  })

  it("is tagged for the Stage-3 combined upgrade", () => {
    expect(func.tags).to.include("UpgradeSepoliaBridgeStage3Combined")
  })

  it("skips unless DEPLOY_STAGE3_COMBINED_UPGRADE is true", async () => {
    expect(await func.skip!({} as any)).to.equal(true)
    process.env.DEPLOY_STAGE3_COMBINED_UPGRADE = "true"
    expect(await func.skip!({} as any)).to.equal(false)
  })

  async function expectPreflightAbort(o: Overrides, message: string) {
    const { mockHre, deployCalls, upgradeCalls } = createMockHre(o)
    await expectReject(func(mockHre), message)
    expect(deployCalls.length, "no deploy on abort").to.equal(0)
    expect(upgradeCalls.length, "no upgrade on abort").to.equal(0)
    expect(summaryWritten, "no summary on abort").to.equal(false)
  }

  it("refuses a non-Sepolia chain", () =>
    expectPreflightAbort({ chainId: "1" }, "is not Sepolia"))

  it("refuses when the deployer is not the ProxyAdmin owner", () =>
    expectPreflightAbort(
      { deployer: "0x9999999999999999999999999999999999999999" },
      "is not the ProxyAdmin owner"
    ))

  it("refuses when the Bridge proxy has no code", () =>
    expectPreflightAbort({ bridgeCode: "0x" }, "has no code"))

  it("refuses when the implementation slot is not the pinned old impl", () =>
    expectPreflightAbort(
      { implSlot: addrWord("0x0000000000000000000000000000000000000001") },
      "not the pinned old implementation"
    ))

  it("refuses when the old implementation runtime hash mismatches", () =>
    expectPreflightAbort({ oldRuntime: "0xdeadbeef" }, "does not match the"))

  it("refuses when the admin slot is not the pinned ProxyAdmin", () =>
    expectPreflightAbort(
      { adminSlot: addrWord("0x0000000000000000000000000000000000000002") },
      "not the pinned ProxyAdmin"
    ))

  it("refuses when the initializer version is not 5", () =>
    expectPreflightAbort(
      { initSlot: utils.hexZeroPad("0x06", 32) },
      "expected 5"
    ))

  it("refuses when a controller getter does not return G1", () =>
    expectPreflightAbort(
      { controller: "0x0000000000000000000000000000000000000003" },
      "Controller getters returned"
    ))

  it("refuses when raw slot 81 is not the controller", () =>
    expectPreflightAbort(
      { slot81: addrWord("0x0000000000000000000000000000000000000004") },
      "Raw slot 81"
    ))

  it("refuses when G1 wiring is unexpected", () =>
    expectPreflightAbort({ g1Paused: true }, "G1 wiring unexpected"))

  it("refuses when the registry deployment is missing", () =>
    expectPreflightAbort(
      { registryPresent: false },
      "CovenantSpendAuthorization deployment not found"
    ))

  it("refuses when the registry owner does not match the requested owner", () =>
    expectPreflightAbort(
      { registryOwner: "0x0000000000000000000000000000000000000005" },
      "does not match the"
    ))

  it("prepares (deploys 7 libs + implementation) without upgrading the proxy", async () => {
    const { mockHre, deployCalls, upgradeCalls } = createMockHre()
    await func(mockHre)

    const libNames = [
      "DepositStage3Combined",
      "DepositSweepStage3Combined",
      "RedemptionStage3Combined",
      "WalletsStage3Combined",
      "FraudStage3Combined",
      "MovingFundsStage3Combined",
      "VaultManagementStage3Combined",
    ]
    // eslint-disable-next-line no-restricted-syntax
    for (const name of libNames) {
      expect(
        deployCalls.find((c) => c.name === name),
        `library ${name}`
      ).to.not.be.undefined
    }
    const implCall = deployCalls.find(
      (c) => c.name === "BridgeStage3CombinedImplementation"
    )
    expect(implCall, "implementation deploy").to.not.be.undefined
    expect(implCall.options.contract).to.equal("Bridge")
    // Preparation mode must NOT upgrade the proxy.
    expect(upgradeCalls.length).to.equal(0)
    // Summary is written even in preparation mode.
    expect(summaryWritten).to.equal(true)
  })

  it("aborts preparation when the new implementation exceeds EIP-170", async () => {
    const { mockHre } = createMockHre({
      newRuntime: `0x${"60".repeat(25000)}`,
    })
    await expectReject(func(mockHre), "EIP-170 limit")
  })
})
