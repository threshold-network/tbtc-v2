/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { expect } from "chai"
import { ethers } from "hardhat"
import fs from "fs"
import path from "path"
import func, {
  computeEvidenceDigest,
  scanPendingOptimisticMints,
} from "../../deploy/86_deploy_tip109_hotfix"
import {
  KNOWN_PROXY_ADMIN,
  KNOWN_COUNCIL_SAFE,
} from "../../deploy/85_deploy_tip109_governance_upgrade"

const { BigNumber, utils } = ethers

// The repo's chai setup registers waffle matchers but not chai-as-promised, so
// promise rejection is asserted through a small try/catch helper.
async function expectReject(
  promise: Promise<unknown>,
  substring?: string
): Promise<void> {
  try {
    await promise
    expect.fail("expected the promise to reject")
  } catch (error) {
    if (substring) {
      expect((error as Error).message).to.include(substring)
    }
  }
}

// Interfaces used to build mock RPC responses for the coordinator bindings and
// the pinned optimistic-minting scan.
const coordinatorIface = new utils.Interface([
  "function controller() view returns (address)",
  "function legacyVault() view returns (address)",
  "function bridge() view returns (address)",
])
const scanIface = new utils.Interface([
  "function deposits(uint256 depositKey) view returns (tuple(address depositor, uint64 amount, uint32 revealedAt, address vault, uint64 treasuryFee, uint32 sweptAt, bytes32 extraData))",
  "function isOptimisticMintingPaused() view returns (bool)",
  "function owner() view returns (address)",
  "function newVault() view returns (address)",
  "function upgradeInitiatedTimestamp() view returns (uint256)",
  "function migrationLocked() view returns (bool)",
  "function optimisticMintingDebt(address depositor) view returns (uint256)",
  "event OptimisticMintingFinalized(address indexed minter, uint256 indexed depositKey, address indexed depositor, uint256 optimisticMintingDebt)",
])
const bridgeGovIface = new utils.Interface([
  "function finalizeLegacyVaultMigration(address coordinator, uint256 snapshotBlockNumber, bytes32 snapshotBlockHash, bytes32 evidenceHash)",
])
// Multicall3 aggregate3 used by the pinned scan's batched, all-or-nothing reads.
const multicall3Iface = new utils.Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
])
// Live/identity getters read while gating cutover generation.
const retirementStateIface = new utils.Interface([
  "function LEGACY_MAINNET_TBTC_VAULT() view returns (address)",
  "function LEGACY_MAINNET_TBTC_VAULT_CODE_HASH() view returns (bytes32)",
  "function isVaultTrusted(address vault) view returns (bool)",
  "function migrationDebtVault() view returns (address)",
  "function owner() view returns (address)",
])
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11"
// The Council Safe address the deploy script normalizes to (EIP-55 checksum).
const COUNCIL_SAFE = utils.getAddress(KNOWN_COUNCIL_SAFE.toLowerCase())
// The exact immutable mainnet legacy TBTCVault runtime, captured from chain
// (address 0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD). Its keccak256 is the
// real LEGACY_MAINNET_TBTC_VAULT_CODE_HASH the deploy script's Phase-I preflight
// and post-deployment identity check both assert. Storing the real runtime lets
// the happy-path mock present the exact code hash headless — keccak256 is
// one-way, so a short placeholder blob cannot reproduce the real hash. Regenerate
// with: cast code 0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD --rpc-url <mainnet>.
const DEFAULT_LEGACY_CODE = fs
  .readFileSync(
    path.join(__dirname, "..", "data", "legacy-tbtc-vault-runtime.hex"),
    "utf8"
  )
  .trim()
const DEFAULT_LEGACY_CODE_HASH = utils.keccak256(DEFAULT_LEGACY_CODE)

describe("Deploy Script 86: TIP-109 Hotfix", () => {
  const DEPLOYER_ADDRESS = "0x1234567890123456789012345678901234567890"
  const LEGACY_DEPOSIT_ADDRESS = "0xE83bcc22A723f693eF0fEB7044F61aeC8c79fe02"
  const LEGACY_DEPOSIT_SWEEP_ADDRESS =
    "0x392635646Bc22FC13C86859d1f02B27974aC9b95"
  const LEGACY_FRAUD_ADDRESS = "0x51bBeF1c7cC3a1D3bC5E64CE6C3BA6E66fbA3559"

  const DEPOSIT_HOTFIX_ADDRESS = "0x0000000000000000000000000000000000000001"
  const DEPOSIT_SWEEP_HOTFIX_ADDRESS =
    "0x0000000000000000000000000000000000000002"
  const REDEMPTION_HOTFIX_ADDRESS = "0x0000000000000000000000000000000000000003"
  const FRAUD_HOTFIX_ADDRESS = "0x0000000000000000000000000000000000000004"
  const WALLETS_ADDRESS = "0x0000000000000000000000000000000000000005"
  const MOVING_FUNDS_ADDRESS = "0x0000000000000000000000000000000000000006"
  const BRIDGE_IMPL_ADDRESS = "0x0000000000000000000000000000000000000007"
  const REBATE_IMPL_ADDRESS = "0x0000000000000000000000000000000000000008"
  const BRIDGE_PROXY_ADDRESS = "0x5e4861a80B55f035D899f66772117F00FA0E8e7B"
  const REBATE_STAKING_PROXY_ADDRESS =
    "0x0184739c02d51bFc1cc2E3a2bF6bbBe31e265a45"
  const BRIDGE_GOV_ADDRESS = "0xCBcFa30000000000000000000000000000000009"
  const BRIDGE_GOV_HOTFIX_ADDRESS = "0x000000000000000000000000000000000000000A"
  const TBTC_VAULT_HOTFIX_ADDRESS = "0x000000000000000000000000000000000000000B"
  const BANK_ADDRESS = "0x000000000000000000000000000000000000000C"
  const TBTC_TOKEN_ADDRESS = "0x000000000000000000000000000000000000000D"
  // The exact mainnet legacy TBTCVault address. The Phase-I preflight and the
  // post-deployment identity check both compare the resolved TBTCVault against
  // this exact address, so the happy-path mock must present it.
  const TBTC_VAULT_ADDRESS = "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD"
  const VAULT_MANAGEMENT_HOTFIX_ADDRESS =
    "0x000000000000000000000000000000000000000f"
  const COORDINATOR_HOTFIX_ADDRESS =
    "0x0000000000000000000000000000000000000010"
  const SNAPSHOT_HASH = `0x${"ab".repeat(32)}`

  interface DeployCall {
    name: string
    options: any
  }
  interface GetCall {
    name: string
  }
  interface SaveCall {
    name: string
    data: any
  }

  let originalMkdirSync: typeof fs.mkdirSync
  let originalWriteFileSync: typeof fs.writeFileSync
  let originalConsoleLog: typeof console.log
  let savedEnv: Record<string, string | undefined>
  let capturedSummary: any
  let summaryWritten: boolean

  const ENV_KEYS = [
    "BRIDGE_FRAUD_EVENT_FROM_BLOCK",
    "GENERATE_TBTC_VAULT_CUTOVER",
    "TBTCVAULT_OM_EVENT_FROM_BLOCK",
    "TBTCVAULT_OM_SNAPSHOT_BLOCK",
  ]

  beforeEach(() => {
    originalMkdirSync = fs.mkdirSync
    originalWriteFileSync = fs.writeFileSync
    originalConsoleLog = console.log
    savedEnv = {}
    ENV_KEYS.forEach((k) => {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    })
    capturedSummary = undefined
    summaryWritten = false
    const mutableFs = fs as any
    mutableFs.mkdirSync = () => undefined
    mutableFs.writeFileSync = (_file: string, content: string) => {
      summaryWritten = true
      capturedSummary = JSON.parse(content)
    }
    console.log = () => undefined
  })

  afterEach(() => {
    const mutableFs = fs as any
    mutableFs.mkdirSync = originalMkdirSync
    mutableFs.writeFileSync = originalWriteFileSync
    console.log = originalConsoleLog
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    })
  })

  // Scan-mock configuration. Defaults describe a clean, fully-locked state with
  // one finalized-and-swept deposit, so the cutover generates successfully.
  interface ScanConfig {
    omLogs?: Array<{
      depositKey: string
      depositor: string
      blockNumber: number
      transactionIndex: number
      logIndex: number
      transactionHash: string
    }>
    deposits?: Record<
      string,
      { depositor: string; vault: string; revealedAt: number; sweptAt: number }
    >
    paused?: boolean
    legacyOwner?: string
    newVault?: string
    upgradeInitiatedTimestamp?: number
    migrationLocked?: boolean
    snapshotBlockTimestamp?: number
    residualDebt?: Record<string, string>
    callError?: boolean
    // Cutover chain / identity / live-state gating.
    chainId?: string
    // Overrides the address the registry resolves for "TBTCVault", so the
    // Phase-I preflight's exact-legacy-address check can be driven to abort.
    legacyDeploymentAddress?: string
    implKnownLegacy?: string
    implKnownCodeHash?: string
    legacyCode?: string
    coordinatorCode?: string
    coordinatorBuildObject?: string
    successorOwner?: string
    legacyTrusted?: boolean
    successorTrusted?: boolean
    migrationDebtVault?: string
  }

  const encodeAddress = (a: string) =>
    utils.defaultAbiCoder.encode(["address"], [a])
  const encodeBool = (b: boolean) => utils.defaultAbiCoder.encode(["bool"], [b])
  const encodeUint = (n: number | string) =>
    utils.defaultAbiCoder.encode(["uint256"], [n])

  const blockTagsSeen: number[] = []

  function createMockHre(scan: ScanConfig = {}): {
    mockHre: any
    deployCalls: DeployCall[]
    getCalls: GetCall[]
    saveCalls: SaveCall[]
  } {
    const deployCalls: DeployCall[] = []
    const getCalls: GetCall[] = []
    const saveCalls: SaveCall[] = []

    const deployAddressMap: Record<string, string> = {
      DepositTIP109Hotfix: DEPOSIT_HOTFIX_ADDRESS,
      DepositSweepTIP109Hotfix: DEPOSIT_SWEEP_HOTFIX_ADDRESS,
      RedemptionTIP109Hotfix: REDEMPTION_HOTFIX_ADDRESS,
      FraudTIP109Hotfix: FRAUD_HOTFIX_ADDRESS,
      VaultManagementTIP109Hotfix: VAULT_MANAGEMENT_HOTFIX_ADDRESS,
      BridgeTIP109HotfixImplementation: BRIDGE_IMPL_ADDRESS,
      RebateStakingTIP109HotfixImplementation: REBATE_IMPL_ADDRESS,
      BridgeGovernanceTIP109Hotfix: BRIDGE_GOV_HOTFIX_ADDRESS,
      TBTCVaultTIP109Hotfix: TBTC_VAULT_HOTFIX_ADDRESS,
      LegacyTBTCVaultMigrationCoordinatorTIP109Hotfix:
        COORDINATOR_HOTFIX_ADDRESS,
    }

    const getAddressMap: Record<string, string> = {
      Deposit: LEGACY_DEPOSIT_ADDRESS,
      DepositSweep: LEGACY_DEPOSIT_SWEEP_ADDRESS,
      Fraud: LEGACY_FRAUD_ADDRESS,
      Wallets: WALLETS_ADDRESS,
      MovingFunds: MOVING_FUNDS_ADDRESS,
      Bridge: BRIDGE_PROXY_ADDRESS,
      RebateStaking: REBATE_STAKING_PROXY_ADDRESS,
      BridgeGovernance: BRIDGE_GOV_ADDRESS,
      Bank: BANK_ADDRESS,
      TBTC: TBTC_TOKEN_ADDRESS,
      TBTCVault: scan.legacyDeploymentAddress ?? TBTC_VAULT_ADDRESS,
    }

    const paddedAdmin = `0x${"0".repeat(24)}${KNOWN_PROXY_ADMIN.slice(
      2
    ).toLowerCase()}`

    const sig = (name: string) => scanIface.getSighash(name)
    const csig = (name: string) => coordinatorIface.getSighash(name)
    const rsig = (name: string) => retirementStateIface.getSighash(name)

    // Per-target read dispatch, shared by direct calls and Multicall3 subcalls.
    const dispatch = (toRaw: string, data: string): string => {
      const to = utils.getAddress(toRaw)
      const selector = data.slice(0, 10)

      if (to === utils.getAddress(COORDINATOR_HOTFIX_ADDRESS)) {
        if (selector === csig("controller"))
          return encodeAddress(BRIDGE_GOV_HOTFIX_ADDRESS)
        if (selector === csig("legacyVault"))
          return encodeAddress(TBTC_VAULT_ADDRESS)
        if (selector === csig("bridge"))
          return encodeAddress(BRIDGE_PROXY_ADDRESS)
        if (selector === sig("migrationLocked"))
          return encodeBool(scan.migrationLocked ?? true)
      }
      if (to === utils.getAddress(TBTC_VAULT_ADDRESS)) {
        if (selector === sig("isOptimisticMintingPaused"))
          return encodeBool(scan.paused ?? true)
        if (selector === sig("owner"))
          return encodeAddress(scan.legacyOwner ?? COORDINATOR_HOTFIX_ADDRESS)
        if (selector === sig("newVault"))
          return encodeAddress(scan.newVault ?? TBTC_VAULT_HOTFIX_ADDRESS)
        if (selector === sig("upgradeInitiatedTimestamp"))
          return encodeUint(scan.upgradeInitiatedTimestamp ?? 1000)
        if (selector === sig("optimisticMintingDebt")) {
          const [depositor] = scanIface.decodeFunctionData(
            "optimisticMintingDebt",
            data
          )
          return encodeUint(
            scan.residualDebt?.[utils.getAddress(depositor)] ?? 0
          )
        }
      }
      // New TBTCVault (successor) live owner read.
      if (
        to === utils.getAddress(TBTC_VAULT_HOTFIX_ADDRESS) &&
        selector === rsig("owner")
      ) {
        return encodeAddress(scan.successorOwner ?? COUNCIL_SAFE)
      }
      // New Bridge implementation legacy-identity constants.
      if (to === utils.getAddress(BRIDGE_IMPL_ADDRESS)) {
        if (selector === rsig("LEGACY_MAINNET_TBTC_VAULT"))
          return encodeAddress(scan.implKnownLegacy ?? TBTC_VAULT_ADDRESS)
        if (selector === rsig("LEGACY_MAINNET_TBTC_VAULT_CODE_HASH"))
          return utils.defaultAbiCoder.encode(
            ["bytes32"],
            [scan.implKnownCodeHash ?? DEFAULT_LEGACY_CODE_HASH]
          )
      }
      // Bridge proxy reads: the scan's per-deposit request plus the live
      // trust/pointer state read while gating cutover generation.
      if (to === utils.getAddress(BRIDGE_PROXY_ADDRESS)) {
        if (selector === sig("deposits")) {
          const [key] = scanIface.decodeFunctionData("deposits", data)
          const dep = scan.deposits?.[BigNumber.from(key).toHexString()]
          const record = dep ?? {
            depositor: DEPLOYER_ADDRESS,
            vault: TBTC_VAULT_ADDRESS,
            revealedAt: 1,
            sweptAt: 1,
          }
          return scanIface.encodeFunctionResult("deposits", [
            [
              record.depositor,
              0,
              record.revealedAt,
              record.vault,
              0,
              record.sweptAt,
              utils.hexZeroPad("0x0", 32),
            ],
          ])
        }
        if (selector === rsig("isVaultTrusted")) {
          const [vault] = retirementStateIface.decodeFunctionData(
            "isVaultTrusted",
            data
          )
          const queried = utils.getAddress(vault)
          if (queried === utils.getAddress(TBTC_VAULT_ADDRESS))
            return encodeBool(scan.legacyTrusted ?? true)
          if (queried === utils.getAddress(TBTC_VAULT_HOTFIX_ADDRESS))
            return encodeBool(scan.successorTrusted ?? false)
          return encodeBool(false)
        }
        if (selector === rsig("migrationDebtVault"))
          return encodeAddress(
            scan.migrationDebtVault ?? ethers.constants.AddressZero
          )
      }
      throw new Error(`Unexpected mock call to ${to} selector ${selector}`)
    }

    const handleCall = (tx: any, blockTag?: any): string => {
      if (scan.callError) {
        throw new Error("Simulated RPC subcall failure")
      }
      if (blockTag !== undefined) {
        blockTagsSeen.push(Number(blockTag))
      }
      const to = utils.getAddress(tx.to)
      if (to === utils.getAddress(MULTICALL3_ADDRESS)) {
        const [calls] = multicall3Iface.decodeFunctionData(
          "aggregate3",
          tx.data
        )
        // all-or-nothing: dispatch every subcall; a throw aborts the aggregate.
        return multicall3Iface.encodeFunctionResult("aggregate3", [
          calls.map((call: any) => ({
            success: true,
            returnData: dispatch(call.target, call.callData),
          })),
        ])
      }
      return dispatch(tx.to, tx.data)
    }

    const omTopic = scanIface.getEventTopic("OptimisticMintingFinalized")
    const buildOmLogs = () =>
      (scan.omLogs ?? []).map((l) => ({
        address: TBTC_VAULT_ADDRESS,
        topics: [
          omTopic,
          utils.hexZeroPad(DEPLOYER_ADDRESS, 32),
          utils.hexZeroPad(BigNumber.from(l.depositKey).toHexString(), 32),
          utils.hexZeroPad(l.depositor, 32),
        ],
        data: encodeUint(0),
        blockNumber: l.blockNumber,
        transactionIndex: l.transactionIndex,
        logIndex: l.logIndex,
        transactionHash: l.transactionHash,
      }))

    const mockHre: any = {
      ethers: {
        ...ethers,
        provider: {
          getBlockNumber: async () => 20000000,
          getLogs: async (filter: any) => {
            if (
              filter.address === TBTC_VAULT_ADDRESS &&
              filter.topics?.[0] === omTopic
            ) {
              // Return each finalized log only from the chunk that spans its
              // block, so the chunked scan does not see false duplicates.
              return buildOmLogs().filter(
                (l) =>
                  l.blockNumber >= filter.fromBlock &&
                  l.blockNumber <= filter.toBlock
              )
            }
            return []
          },
          getStorageAt: async () => paddedAdmin,
          getBlock: async (n: number) => ({
            hash: SNAPSHOT_HASH,
            number: n,
            timestamp: scan.snapshotBlockTimestamp ?? 1000 + 86400 + 1,
          }),
          getCode: async (addr: string) => {
            const target = utils.getAddress(addr)
            if (target === utils.getAddress(COORDINATOR_HOTFIX_ADDRESS))
              return scan.coordinatorCode ?? "0x60006000"
            if (target === utils.getAddress(TBTC_VAULT_ADDRESS))
              return scan.legacyCode ?? DEFAULT_LEGACY_CODE
            return "0x"
          },
          call: async (tx: any, blockTag?: any) => handleCall(tx, blockTag),
          getTransaction: async () => {
            throw new Error("No transaction lookup expected")
          },
        },
        utils: ethers.utils,
        getContractAt: async () => ({
          governanceDelays: async () => ethers.BigNumber.from(172800),
        }),
      },
      deployments: {
        deploy: async (name: string, options: any) => {
          deployCalls.push({ name, options })
          const address = deployAddressMap[name]
          if (!address) throw new Error(`No deployment mock for: ${name}`)
          return { address, newlyDeployed: true }
        },
        get: async (name: string) => {
          getCalls.push({ name })
          const address = getAddressMap[name]
          if (!address)
            throw new Error(`No existing deployment mock for: ${name}`)
          return {
            address,
            receipt: name === "Bridge" ? { blockNumber: 42 } : undefined,
          }
        },
        save: async (name: string, data: any) => {
          saveCalls.push({ name, data })
        },
      },
      artifacts: {
        readArtifactSync: () => ({ abi: [] }),
        // Minimal build-info for the coordinator runtime-bytecode verification.
        // The default object matches the mocked coordinator getCode; no
        // immutable references are declared for the headless mock.
        getBuildInfo: async () => ({
          output: {
            contracts: {
              "contracts/vault/LegacyTBTCVaultMigrationCoordinator.sol": {
                LegacyTBTCVaultMigrationCoordinator: {
                  evm: {
                    deployedBytecode: {
                      object: scan.coordinatorBuildObject ?? "60006000",
                      immutableReferences: {},
                    },
                  },
                },
              },
            },
          },
        }),
      },
      getNamedAccounts: async () => ({ deployer: DEPLOYER_ADDRESS }),
      // Cutover generation is only produced for mainnet; default the mock to
      // chain 1 so the cutover-mode suites exercise the full gate.
      getChainId: async () => scan.chainId ?? "1",
      network: { name: "hardhat", tags: {} },
    }

    return { mockHre, deployCalls, getCalls, saveCalls }
  }

  async function runScript(scan: ScanConfig = {}): Promise<{
    deployCalls: DeployCall[]
    getCalls: GetCall[]
    saveCalls: SaveCall[]
  }> {
    const { mockHre, deployCalls, getCalls, saveCalls } = createMockHre(scan)
    await func(mockHre)
    return { deployCalls, getCalls, saveCalls }
  }

  describe("skip guard", () => {
    let originalDeployFlag: string | undefined
    beforeEach(() => {
      originalDeployFlag = process.env.DEPLOY_TIP109_HOTFIX
      delete process.env.DEPLOY_TIP109_HOTFIX
    })
    afterEach(() => {
      if (originalDeployFlag === undefined)
        delete process.env.DEPLOY_TIP109_HOTFIX
      else process.env.DEPLOY_TIP109_HOTFIX = originalDeployFlag
    })
    it("skips unless DEPLOY_TIP109_HOTFIX is true", async () => {
      expect(await func.skip!({} as any)).to.equal(true)
      process.env.DEPLOY_TIP109_HOTFIX = "false"
      expect(await func.skip!({} as any)).to.equal(true)
      process.env.DEPLOY_TIP109_HOTFIX = "true"
      expect(await func.skip!({} as any)).to.equal(false)
    })
  })

  describe("Phase-I preflight (chain and exact legacy identity)", () => {
    // A distinct, valid address that is NOT the real legacy vault, used to drive
    // the preflight's exact-legacy-address abort.
    const WRONG_LEGACY_ADDRESS = "0x1111111111111111111111111111111111111111"

    // Runs the full deploy function against a mock configured to fail exactly one
    // preflight check, and asserts it aborts with NO side effects: no contract
    // deployed (the preflight runs before the first deploy), and no summary JSON
    // written (hence no executable preparation or cutover action emitted).
    async function expectPreflightAbort(
      scan: ScanConfig,
      message: string
    ): Promise<void> {
      const { mockHre, deployCalls } = createMockHre(scan)
      await expectReject(func(mockHre), message)
      expect(deployCalls.length).to.equal(0)
      expect(summaryWritten).to.equal(false)
    }

    // The preflight is unconditional, so it must abort identically in the default
    // preparation mode and the explicit cutover mode.
    const MODES: Array<{ name: string; cutover: boolean }> = [
      { name: "preparation mode", cutover: false },
      { name: "cutover mode", cutover: true },
    ]

    MODES.forEach(({ name, cutover }) => {
      describe(name, () => {
        beforeEach(() => {
          if (cutover) process.env.GENERATE_TBTC_VAULT_CUTOVER = "true"
        })

        it("aborts before any deploy, action, or summary on the wrong chain id", async () => {
          await expectPreflightAbort(
            { chainId: "5" },
            "is not Ethereum mainnet"
          )
        })

        it("aborts before any deploy, action, or summary on a wrong legacy vault address", async () => {
          await expectPreflightAbort(
            { legacyDeploymentAddress: WRONG_LEGACY_ADDRESS },
            "is not the exact legacy vault"
          )
        })

        it("aborts before any deploy, action, or summary on a wrong legacy code hash", async () => {
          await expectPreflightAbort(
            { legacyCode: "0xdeadbeef" },
            "does not match the expected"
          )
        })
      })
    })
  })

  describe("library and vault deployment", () => {
    it("deploys fresh copies of every modified linked Bridge library, including VaultManagement", async () => {
      const { deployCalls, getCalls } = await runScript()
      const deployNames = deployCalls.map((c) => c.name)
      expect(deployNames).to.include("DepositTIP109Hotfix")
      expect(deployNames).to.include("VaultManagementTIP109Hotfix")
      const vm = deployCalls.find(
        (c) => c.name === "VaultManagementTIP109Hotfix"
      )
      expect(vm!.options.contract).to.equal("VaultManagement")
      const getNames = getCalls.map((c) => c.name)
      expect(getNames).to.not.include("VaultManagement")
    })

    it("links the Bridge implementation to the fresh VaultManagement library", async () => {
      const { deployCalls } = await runScript()
      const bridge = deployCalls.find(
        (c) => c.name === "BridgeTIP109HotfixImplementation"
      )
      expect(bridge!.options.libraries.VaultManagement).to.equal(
        VAULT_MANAGEMENT_HOTFIX_ADDRESS
      )
    })

    it("deploys a new BridgeGovernance and TBTCVault", async () => {
      const { deployCalls } = await runScript()
      const gov = deployCalls.find(
        (c) => c.name === "BridgeGovernanceTIP109Hotfix"
      )
      expect(gov!.options.args[0]).to.equal(BRIDGE_PROXY_ADDRESS)
      const vault = deployCalls.find((c) => c.name === "TBTCVaultTIP109Hotfix")
      expect(vault!.options.args).to.deep.equal([
        BANK_ADDRESS,
        TBTC_TOKEN_ADDRESS,
        BRIDGE_PROXY_ADDRESS,
      ])
    })

    it("does not persist executable seedFraudChallengeEscrow calldata", async () => {
      await runScript()
      const seedAction = capturedSummary.postUpgradeActions.find(
        (a: any) => a.function === "seedFraudChallengeEscrow(uint256)"
      )
      expect(seedAction).to.not.have.property("data")
      expect(seedAction.requiresRecomputation).to.equal(true)
    })
  })

  describe("coordinator deployment", () => {
    it("deploys the coordinator with controller=new BridgeGovernance, legacyVault, and Bridge", async () => {
      const { deployCalls } = await runScript()
      const coord = deployCalls.find(
        (c) => c.name === "LegacyTBTCVaultMigrationCoordinatorTIP109Hotfix"
      )
      expect(coord, "coordinator deploy").to.not.equal(undefined)
      expect(coord!.options.contract).to.equal(
        "LegacyTBTCVaultMigrationCoordinator"
      )
      expect(coord!.options.args).to.deep.equal([
        BRIDGE_GOV_HOTFIX_ADDRESS,
        TBTC_VAULT_ADDRESS,
        BRIDGE_PROXY_ADDRESS,
      ])
    })

    it("persists the coordinator address in deployedContracts", async () => {
      await runScript()
      expect(
        capturedSummary.deployedContracts
          .LegacyTBTCVaultMigrationCoordinatorTIP109Hotfix
      ).to.equal(COORDINATOR_HOTFIX_ADDRESS)
    })

    it("aborts without writing JSON when the coordinator bindings do not match", async () => {
      // Point the coordinator's reported controller at the wrong address by
      // making the mock return a bad binding.
      const { mockHre } = createMockHre()
      const originalCall = mockHre.ethers.provider.call
      mockHre.ethers.provider.call = async (tx: any, blockTag?: any) => {
        if (
          utils.getAddress(tx.to) ===
            utils.getAddress(COORDINATOR_HOTFIX_ADDRESS) &&
          tx.data.slice(0, 10) === coordinatorIface.getSighash("controller")
        ) {
          return utils.defaultAbiCoder.encode(["address"], [DEPLOYER_ADDRESS])
        }
        return originalCall(tx, blockTag)
      }
      await expectReject(
        func(mockHre),
        "Coordinator immutable bindings do not match"
      )
      expect(summaryWritten).to.equal(false)
    })
  })

  describe("preparation actions (default mode)", () => {
    it("generates preparation actions in the required order", async () => {
      await runScript()
      const migration = capturedSummary.legacyVaultMigration
      expect(migration.coordinator).to.equal(COORDINATOR_HOTFIX_ADDRESS)
      const actions = migration.preparationActions
      expect(actions).to.have.lengthOf(4)
      // 1. new-vault ownership to Council.
      expect(actions[0].target).to.equal(TBTC_VAULT_HOTFIX_ADDRESS)
      // 2. pause legacy optimistic minting (conditional).
      expect(actions[1].target).to.equal(TBTC_VAULT_ADDRESS)
      expect(actions[1]).to.have.property("precondition")
      // 3. transfer legacy vault ownership to the coordinator.
      expect(actions[2].target).to.equal(TBTC_VAULT_ADDRESS)
      // 4. initiate the legacy vault upgrade through the new BridgeGovernance.
      expect(actions[3].target).to.equal(BRIDGE_GOV_HOTFIX_ADDRESS)
      expect(actions[3].governanceDelaySeconds).to.equal("86400")
    })

    it("emits no action targeting the legacy vault finalizeUpgrade", async () => {
      await runScript()
      const migration = capturedSummary.legacyVaultMigration
      const finalizeSelector = new utils.Interface([
        "function finalizeUpgrade()",
      ]).getSighash("finalizeUpgrade")
      migration.preparationActions.forEach((a: any) => {
        if (a.data) expect(a.data.slice(0, 10)).to.not.equal(finalizeSelector)
      })
    })

    it("produces a non-executable cutover placeholder with no calldata", async () => {
      await runScript()
      const cutover = capturedSummary.legacyVaultMigration.cutoverAction
      expect(cutover.target).to.equal(BRIDGE_GOV_HOTFIX_ADDRESS)
      expect(cutover).to.not.have.property("data")
      expect(cutover.requiresCutoverMode).to.equal(true)
    })

    it("does not run the pinned scan in default mode (no scan output)", async () => {
      await runScript()
      expect(capturedSummary.legacyVaultMigration.scan).to.equal(undefined)
    })
  })

  describe("cutover mode", () => {
    beforeEach(() => {
      process.env.GENERATE_TBTC_VAULT_CUTOVER = "true"
    })

    it("generates one cutover action decoding to finalizeLegacyVaultMigration with the exact coordinator and evidence", async () => {
      await runScript({
        omLogs: [
          {
            depositKey: "0x01",
            depositor: DEPLOYER_ADDRESS,
            blockNumber: 17000000,
            transactionIndex: 0,
            logIndex: 0,
            transactionHash: SNAPSHOT_HASH,
          },
        ],
        deposits: {
          [BigNumber.from(1).toHexString()]: {
            depositor: DEPLOYER_ADDRESS,
            vault: TBTC_VAULT_ADDRESS,
            revealedAt: 1,
            sweptAt: 12345,
          },
        },
      })

      const cutover = capturedSummary.legacyVaultMigration.cutoverAction
      expect(cutover.target).to.equal(BRIDGE_GOV_HOTFIX_ADDRESS)
      expect(cutover).to.have.property("data")
      const decoded = bridgeGovIface.decodeFunctionData(
        "finalizeLegacyVaultMigration",
        cutover.data
      )
      expect(utils.getAddress(decoded.coordinator)).to.equal(
        utils.getAddress(COORDINATOR_HOTFIX_ADDRESS)
      )
      expect(decoded.snapshotBlockHash).to.equal(SNAPSHOT_HASH)
      expect(decoded.evidenceHash).to.equal(cutover.evidenceHash)

      // The scan carries the digest inputs.
      const { scan } = capturedSummary.legacyVaultMigration
      expect(scan.finalizedEventCount).to.equal(1)
      expect(scan.unsweptFinalizedCount).to.equal(0)
    })

    it("uses the same explicit block tag for every scan read", async () => {
      blockTagsSeen.length = 0
      await runScript({
        omLogs: [
          {
            depositKey: "0x01",
            depositor: DEPLOYER_ADDRESS,
            blockNumber: 17000000,
            transactionIndex: 0,
            logIndex: 0,
            transactionHash: SNAPSHOT_HASH,
          },
        ],
        deposits: {
          [BigNumber.from(1).toHexString()]: {
            depositor: DEPLOYER_ADDRESS,
            vault: TBTC_VAULT_ADDRESS,
            revealedAt: 1,
            sweptAt: 12345,
          },
        },
      })
      // All state/deposit reads pin the same finalized snapshot block.
      const uniqueTags = new Set(blockTagsSeen)
      expect(blockTagsSeen.length).to.be.greaterThan(0)
      expect(uniqueTags.size).to.equal(1)
      expect([...uniqueTags][0]).to.equal(20000000 - 64)
    })

    it("does not block cutover generation on thousands of residual debtors when every key is swept", async () => {
      const residualDebt: Record<string, string> = {}
      residualDebt[utils.getAddress(DEPLOYER_ADDRESS)] = "437660000000000"
      await runScript({
        omLogs: [
          {
            depositKey: "0x01",
            depositor: DEPLOYER_ADDRESS,
            blockNumber: 17000000,
            transactionIndex: 0,
            logIndex: 0,
            transactionHash: SNAPSHOT_HASH,
          },
        ],
        deposits: {
          [BigNumber.from(1).toHexString()]: {
            depositor: DEPLOYER_ADDRESS,
            vault: TBTC_VAULT_ADDRESS,
            revealedAt: 1,
            sweptAt: 12345, // swept
          },
        },
        residualDebt,
      })
      const cutover = capturedSummary.legacyVaultMigration.cutoverAction
      expect(cutover).to.have.property("data")
      expect(
        capturedSummary.legacyVaultMigration.scan.residualDebtorCount
      ).to.equal(1)
    })

    it("aborts without JSON when a finalized deposit is unswept", async () => {
      await expectReject(
        runScript({
          omLogs: [
            {
              depositKey: "0x01",
              depositor: DEPLOYER_ADDRESS,
              blockNumber: 17000000,
              transactionIndex: 0,
              logIndex: 0,
              transactionHash: SNAPSHOT_HASH,
            },
          ],
          deposits: {
            [BigNumber.from(1).toHexString()]: {
              depositor: DEPLOYER_ADDRESS,
              vault: TBTC_VAULT_ADDRESS,
              revealedAt: 1,
              sweptAt: 0, // UNSWEPT -> dangerous
            },
          },
        }),
        "unswept finalized"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the legacy vault is not paused", async () => {
      await expectReject(runScript({ paused: false }), "not paused")
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the legacy owner is not the coordinator", async () => {
      await expectReject(
        runScript({ legacyOwner: DEPLOYER_ADDRESS }),
        "not owned by the coordinator"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON on an RPC subcall error", async () => {
      await expectReject(runScript({ callError: true }))
      expect(summaryWritten).to.equal(false)
    })
  })

  describe("cutover finality, identity, and live-state gating", () => {
    beforeEach(() => {
      process.env.GENERATE_TBTC_VAULT_CUTOVER = "true"
    })

    // A clean, fully-locked, mainnet state with one finalized-and-swept deposit,
    // so the scan proves P empty and every cutover gate is reachable. Individual
    // tests flip a single field to drive one abort.
    const cleanCutoverScan = (overrides: ScanConfig = {}): ScanConfig => ({
      omLogs: [
        {
          depositKey: "0x01",
          depositor: DEPLOYER_ADDRESS,
          blockNumber: 17000000,
          transactionIndex: 0,
          logIndex: 0,
          transactionHash: SNAPSHOT_HASH,
        },
      ],
      deposits: {
        [BigNumber.from(1).toHexString()]: {
          depositor: DEPLOYER_ADDRESS,
          vault: TBTC_VAULT_ADDRESS,
          revealedAt: 1,
          sweptAt: 12345,
        },
      },
      ...overrides,
    })

    it("generates the cutover and decodes per-deposit and residual reads batched through Multicall3", async () => {
      const residualDebt: Record<string, string> = {}
      residualDebt[utils.getAddress(DEPLOYER_ADDRESS)] = "437660000000000"
      await runScript(cleanCutoverScan({ residualDebt }))
      const cutover = capturedSummary.legacyVaultMigration.cutoverAction
      expect(cutover).to.have.property("data")
      const { scan } = capturedSummary.legacyVaultMigration
      // The deposit batch decoded the finalized key and the residual batch
      // decoded the depositor debt; both went through the Multicall3 aggregate.
      expect(scan.finalizedEventCount).to.equal(1)
      expect(scan.residualDebtorCount).to.equal(1)
    })

    it("aborts without JSON when the snapshot override is newer than the finality boundary", async () => {
      // head 20000000, boundary 20000000 - 64 = 19999936; 20000000 > 19999936.
      process.env.TBTCVAULT_OM_SNAPSHOT_BLOCK = String(20000000)
      await expectReject(
        runScript(cleanCutoverScan()),
        "newer than the finalized boundary"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("accepts a snapshot override exactly at the finality boundary", async () => {
      process.env.TBTCVAULT_OM_SNAPSHOT_BLOCK = String(20000000 - 64)
      await runScript(cleanCutoverScan())
      expect(
        capturedSummary.legacyVaultMigration.cutoverAction
      ).to.have.property("data")
    })

    it("aborts without JSON when the chain is not Ethereum mainnet", async () => {
      await expectReject(
        runScript(cleanCutoverScan({ chainId: "5" })),
        "not Ethereum mainnet"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the legacy code hash does not match the Bridge implementation constant", async () => {
      // The Phase-I preflight passes (the resolved legacy vault carries the real
      // runtime, so its hash equals the hard-coded constant); this drives the
      // SECOND binding check, where the freshly compiled implementation reports a
      // different LEGACY_MAINNET_TBTC_VAULT_CODE_HASH than the on-chain runtime.
      await expectReject(
        runScript(
          cleanCutoverScan({ implKnownCodeHash: `0x${"11".repeat(32)}` })
        ),
        "code hash"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the legacy address does not match the Bridge implementation constant", async () => {
      await expectReject(
        runScript(cleanCutoverScan({ implKnownLegacy: DEPLOYER_ADDRESS })),
        "does not match the Bridge implementation"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the successor vault is not Council-owned", async () => {
      await expectReject(
        runScript(cleanCutoverScan({ successorOwner: DEPLOYER_ADDRESS })),
        "not the Council Safe"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the legacy vault is not currently trusted", async () => {
      await expectReject(
        runScript(cleanCutoverScan({ legacyTrusted: false })),
        "legacy vault is not currently trusted"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the successor vault is already trusted", async () => {
      await expectReject(
        runScript(cleanCutoverScan({ successorTrusted: true })),
        "successor vault is already trusted"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when a canonical migration-debt vault is already set", async () => {
      await expectReject(
        runScript(cleanCutoverScan({ migrationDebtVault: DEPLOYER_ADDRESS })),
        "expected the zero address"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the coordinator runtime bytecode content differs from the artifact", async () => {
      await expectReject(
        runScript(cleanCutoverScan({ coordinatorCode: "0x60006001" })),
        "runtime bytecode does not match"
      )
      expect(summaryWritten).to.equal(false)
    })

    it("aborts without JSON when the coordinator runtime bytecode length differs from the artifact", async () => {
      await expectReject(
        runScript(cleanCutoverScan({ coordinatorBuildObject: "600060" })),
        "length"
      )
      expect(summaryWritten).to.equal(false)
    })
  })

  describe("pinned scan from-block enforcement", () => {
    it("rejects a from-block override that starts after the enforced mainnet legacy deployment block", async () => {
      // The enforcement runs at the top of the scan, before any RPC read, so a
      // stub provider is sufficient.
      await expectReject(
        scanPendingOptimisticMints({} as any, {
          chainId: 1,
          legacyVault: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD",
          bridge: BRIDGE_PROXY_ADDRESS,
          coordinator: COORDINATOR_HOTFIX_ADDRESS,
          successorVault: TBTC_VAULT_HOTFIX_ADDRESS,
          fromBlockOverride: 17000000,
          requireLockedState: false,
        }),
        "starts after the enforced legacy deployment block"
      )
    })

    it("rejects a snapshot override newer than the finalized boundary", async () => {
      // Reproduces the vet's reorg scenario: head 1000, override 1000, while the
      // finalized boundary is 1000 - 64 = 936. The throw happens before any
      // per-deposit read, so a getBlockNumber-only stub provider is sufficient.
      await expectReject(
        scanPendingOptimisticMints(
          { getBlockNumber: async () => 1000 } as any,
          {
            chainId: 1,
            legacyVault: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD",
            bridge: BRIDGE_PROXY_ADDRESS,
            coordinator: COORDINATOR_HOTFIX_ADDRESS,
            successorVault: TBTC_VAULT_HOTFIX_ADDRESS,
            snapshotBlockNumberOverride: 1000,
            requireLockedState: false,
          }
        ),
        "newer than the finalized boundary"
      )
    })
  })

  describe("evidence digest", () => {
    const base = {
      chainId: 1,
      legacyVault: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD",
      bridge: BRIDGE_PROXY_ADDRESS,
      fromBlock: 16472741,
      snapshotBlockNumber: 25502458,
      snapshotBlockHash: SNAPSHOT_HASH,
      finalizedEventCount: 2,
      depositKeys: [BigNumber.from(5), BigNumber.from(2)],
    }

    it("is deterministic and order-independent in the deposit key set", () => {
      const a = computeEvidenceDigest(base)
      const b = computeEvidenceDigest({
        ...base,
        depositKeys: [BigNumber.from(2), BigNumber.from(5)],
      })
      expect(a.evidenceHash).to.equal(b.evidenceHash)
      expect(a.depositSetHash).to.equal(b.depositSetHash)
    })

    it("changes when any deposit key, block, address, or count changes", () => {
      const ref = computeEvidenceDigest(base).evidenceHash
      expect(
        computeEvidenceDigest({
          ...base,
          depositKeys: [BigNumber.from(5), BigNumber.from(3)],
        }).evidenceHash
      ).to.not.equal(ref)
      expect(
        computeEvidenceDigest({ ...base, snapshotBlockNumber: 25502459 })
          .evidenceHash
      ).to.not.equal(ref)
      expect(
        computeEvidenceDigest({ ...base, legacyVault: BRIDGE_PROXY_ADDRESS })
          .evidenceHash
      ).to.not.equal(ref)
      expect(
        computeEvidenceDigest({ ...base, finalizedEventCount: 3 }).evidenceHash
      ).to.not.equal(ref)
    })
  })
})
