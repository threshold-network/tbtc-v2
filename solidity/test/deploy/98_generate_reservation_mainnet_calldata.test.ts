/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import hre, { ethers } from "hardhat"
import { Interface, getAddress } from "ethers"
import fs from "fs"
import path from "path"
import func, {
  buildReservationActionDefinitions,
  assertDissolutionDelayWithinScriptPolicy,
  assertFinalizeAcceptsReservationValues,
  assertHandoffAwareFleetFit,
  handoffAwareSlotCapacity,
  linkedRecordRuntime,
  RESERVATION_SURFACE_METHODS,
  KNOWN_TIMELOCK,
  KNOWN_COUNCIL_SAFE,
} from "../../deploy/98_generate_reservation_mainnet_calldata"
import { artifactLinkSites } from "../../deploy/99_deploy_rebate_staking_reservation_implementation"

/**
 * Asserts that `promise` rejects with an error whose message matches
 * `pattern`. `chai-as-promised` has no type definitions in this project
 * (see `test/bridge/Deployment.test.ts`'s unused import), so this plain
 * try/catch is the typed alternative used throughout this file.
 */
async function expectRejection(
  promise: Promise<unknown>,
  pattern: RegExp
): Promise<void> {
  let rejection: unknown
  try {
    await promise
  } catch (error) {
    rejection = error
  }
  // Fail outside the try block: an assertion thrown inside it would be
  // caught above and matched against `pattern`, and its own message
  // contains the pattern text, so a promise that never rejects would pass.
  if (rejection === undefined) {
    expect.fail(`expected rejection matching ${pattern}`)
  }
  expect((rejection as Error).message).to.match(pattern)
}

/**
 * The deploy function writes its calldata summary into
 * `solidity/deployments/mainnet/`, the same directory the deployment
 * artifacts live in. These helpers find and remove those summaries.
 */
const SUMMARY_DIR = path.join(__dirname, "..", "..", "deployments", "mainnet")
const SUMMARY_PREFIX = "reservation-bootstrap-calldata-"

function findSummaryFiles(): string[] {
  if (!fs.existsSync(SUMMARY_DIR)) return []
  return fs
    .readdirSync(SUMMARY_DIR)
    .filter((f) => f.startsWith(SUMMARY_PREFIX) && f.endsWith(".json"))
    .map((f) => path.join(SUMMARY_DIR, f))
}

function removeSummaryFiles(): void {
  findSummaryFiles().forEach((f) => {
    try {
      fs.unlinkSync(f)
    } catch {
      // Ignore cleanup errors
    }
  })
}

describe("Deploy Script 98: Reservation Mainnet Calldata Generation", () => {
  const DEPLOYER_ADDRESS = "0x1234567890123456789012345678901234567890"
  const BRIDGE_ADDRESS = "0x0000000000000000000000000000000000000001"
  const BRIDGE_GOVERNANCE_ADDRESS = "0x0000000000000000000000000000000000000002"
  const RESERVATION_VAULT_ADDRESS = "0x0000000000000000000000000000000000000003"
  const RESERVATION_ROUTER_ADDRESS =
    "0xAABbCcddEe00112233445566778899AaBbCCdDeE"
  const PROXY_ADMIN_ADDRESS = "0x1111111111111111111111111111111111111111"

  // The real compiled BridgeGovernance ABI -- used as the single encoding
  // source, mirroring what the deploy script itself loads via
  // `artifacts.readArtifact`.
  let bridgeGovernanceArtifact: any
  let bridgeGovInterface: Interface

  // The real compiled ReservationRouter artifact. The router is
  // library-linked, so its `deployedBytecode` carries solc's link
  // placeholders -- which is why a deployment record of it does too, and why
  // the on-chain check has to link the record before comparing.
  let routerArtifact: any
  /** The addresses a deployment record would say it linked, by library name. */
  let routerLibraries: Record<string, string>
  /** The runtime the router has on chain when linked as `routerLibraries`. */
  let routerLinkedRuntime: string
  /** The compiled ReservationVault artifact, and the runtime it deploys. */
  let vaultArtifact: any
  let vaultRuntime: string
  /** The vault's build info and the immutable ranges it reports. */
  let vaultBuildInfo: any
  let vaultImmutables: Record<string, { start: number; length: number }[]>

  /**
   * The runtime a deploy of the vault artifact leaves at its address: the
   * artifact's code with the constructor's immutable values written into the
   * slots the compiler reserved for them. This suite mocks the HRE and
   * deploys no contracts, and the vault's constructor calls into `TBTCVault`,
   * so this is the shape `getCode` returns without a live deploy.
   */
  function deployedStyleRuntime(): string {
    const bytes = vaultArtifact.deployedBytecode
      .toLowerCase()
      .replace(/^0x/, "")
      .split("")
    const references = Object.values(vaultImmutables)
    // A build with no immutables would make the masking assertions vacuous.
    expect(references.length).to.be.greaterThan(0)
    references
      .flat()
      .forEach(
        ({ start, length }: { start: number; length: number }, index) => {
          // A distinct, obviously non-zero word per immutable, so a slot left
          // zero-filled by the artifact is visible.
          const word = (index + 0xa1)
            .toString(16)
            .repeat(64)
            .slice(0, length * 2)
          for (let offset = 0; offset < length * 2; offset += 1) {
            bytes[2 * start + offset] = word[offset]
          }
        }
      )
    return `0x${bytes.join("")}`
  }

  before(async () => {
    bridgeGovernanceArtifact =
      await hre.artifacts.readArtifact("BridgeGovernance")
    bridgeGovInterface = new ethers.Interface(bridgeGovernanceArtifact.abi)
    routerArtifact = await hre.artifacts.readArtifact("ReservationRouter")
    const linkSites = artifactLinkSites(routerArtifact.deployedLinkReferences)
    routerLibraries = Object.fromEntries(
      [...new Set(linkSites.map((site) => site.library))].map((library, i) => [
        library,
        `0x${(i + 5).toString(16).repeat(40)}`,
      ])
    )
    routerLinkedRuntime = linkedRecordRuntime({
      name: "ReservationRouter",
      recordBytecode: routerArtifact.deployedBytecode,
      artifactBytecode: routerArtifact.deployedBytecode,
      linkSites,
      libraries: routerLibraries,
    })
    vaultArtifact = await hre.artifacts.readArtifact("ReservationVault")
    vaultBuildInfo = await hre.artifacts.getBuildInfo(
      "contracts/vault/ReservationVault.sol:ReservationVault"
    )
    vaultImmutables =
      vaultBuildInfo.output.contracts["contracts/vault/ReservationVault.sol"]
        .ReservationVault.evm.deployedBytecode.immutableReferences ?? {}
    vaultRuntime = deployedStyleRuntime()
  })

  // A complete set of env vars that satisfies every validation the script
  // performs: Decision 1, the live-wallet sizing relation (liveWalletsCount
  // mocked to 10, MAX_ACTIVE below), and every mirrored
  // updateReservationParameters on-chain require.
  const VALID_ENV: Record<string, string> = {
    RESERVATION_PER_WALLET_CAP_SATS: "1000000",
    RESERVATION_SINGLE_AMOUNT_CAP_SATS: "100000",
    RESERVATION_MAX_ACTIVE: "5",
    RESERVATION_MAX_THIRD_PARTY_REANCHOR_HOLDS: "1",
    RESERVATION_HANDOFF_RESERVE_WALLETS: "1",
    RESERVATION_MIN_AMOUNT_SATS: "10000",
    RESERVATION_TX_MAX_FEE_SATS: "1000",
    RESERVATION_TERM_SECONDS: "7776000", // 90 days = MIN_RESERVATION_TERM
    RESERVATION_DISSOLUTION_DELAY_SECONDS: "86400",
    RESERVATION_MAX_TOTAL_AMOUNT_SATS: "500000", // 5 * 100000, satisfies Decision 1
    RESERVATION_MAX_PER_WALLET: "1",
    RESERVATION_ACTION_TIMEOUT_SECONDS: "86400",
    RESERVATION_RENEWAL_WINDOW_SECONDS: "86400",
    // The address the irreversibility sign-off names; the mock's
    // ReservationVault record points at the same one.
    RESERVATION_VAULT: RESERVATION_VAULT_ADDRESS,
  }
  const ENV_KEYS = Object.keys(VALID_ENV)

  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = {}
    ENV_KEYS.forEach((key) => {
      savedEnv[key] = process.env[key]
      process.env[key] = VALID_ENV[key]
    })
  })

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    })
    // Every full run of the deploy function writes a calldata summary into
    // solidity/deployments/mainnet/. Those files are not deployment
    // artifacts, and the deployment-artifacts suite reads that directory, so
    // leaving one behind races with that suite when the tests run in
    // parallel (the pull-request CI mode). Remove them after every test,
    // not only in the suite that inspects their content.
    removeSummaryFiles()
  })

  /**
   * Creates a mock HRE resolving the four reservation contracts, the
   * governance role owners, the router's on-chain state/bytecode, and the
   * live-wallet count -- everything the deploy script reads before
   * generating calldata. Every knob defaults to a value that makes the
   * happy path succeed.
   */
  function createMockHre(overrides?: {
    networkName?: string
    liveWalletsCount?: number
    liveWalletsCountAtFinalize?: number
    depositRevealAheadPeriod?: number
    reservationRouterOnChain?: string
    routerOnChainCode?: string
    proxyAdminOwner?: string
    bridgeGovernanceOwner?: string
    depositDustThreshold?: bigint
    /** What `Bridge.governance()` returns: the handoff's postcondition. */
    bridgeGovernanceOnChain?: string
    /** Code at the BridgeGovernance record's address. */
    bridgeGovernanceOnChainCode?: string
    /** Code at the ReservationVault record's address. */
    vaultOnChainCode?: string
  }): { mockHre: any } {
    const liveWalletsCount = overrides?.liveWalletsCount ?? 10
    const liveWalletsCountAtFinalize =
      overrides?.liveWalletsCountAtFinalize ?? liveWalletsCount
    const reservationRouterOnChain =
      overrides?.reservationRouterOnChain ?? ethers.ZeroAddress
    const routerOnChainCode =
      overrides?.routerOnChainCode ?? routerLinkedRuntime
    const proxyAdminOwner = overrides?.proxyAdminOwner ?? KNOWN_TIMELOCK
    const bridgeGovernanceOwner =
      overrides?.bridgeGovernanceOwner ?? KNOWN_COUNCIL_SAFE
    // Defaults keep VALID_ENV feasible: dust at the single-amount cap and a
    // reveal-ahead period inside the 90-day term plus the 24h margin.
    const depositDustThreshold =
      overrides?.depositDustThreshold ?? BigInt(100000)
    const depositRevealAheadPeriod =
      overrides?.depositRevealAheadPeriod ?? 7776000
    const bridgeGovernanceOnChain =
      overrides?.bridgeGovernanceOnChain ?? BRIDGE_GOVERNANCE_ADDRESS
    // The compiled artifact's own runtime: it carries every reservation
    // selector, so the surface check passes on the happy path.
    const bridgeGovernanceOnChainCode =
      overrides?.bridgeGovernanceOnChainCode ??
      bridgeGovernanceArtifact.deployedBytecode
    const vaultOnChainCode = overrides?.vaultOnChainCode ?? vaultRuntime

    const addressMap: Record<string, string> = {
      Bridge: BRIDGE_ADDRESS,
      BridgeGovernance: BRIDGE_GOVERNANCE_ADDRESS,
      ReservationVault: RESERVATION_VAULT_ADDRESS,
      ReservationRouter: RESERVATION_ROUTER_ADDRESS,
    }

    const codeByAddress: Record<string, string> = {
      [BRIDGE_GOVERNANCE_ADDRESS.toLowerCase()]: bridgeGovernanceOnChainCode,
      [RESERVATION_VAULT_ADDRESS.toLowerCase()]: vaultOnChainCode,
      [RESERVATION_ROUTER_ADDRESS.toLowerCase()]: routerOnChainCode,
    }

    let liveWalletsCountReadCalls = 0
    const ownerByAddress: Record<string, string> = {
      [PROXY_ADMIN_ADDRESS.toLowerCase()]: proxyAdminOwner,
      [BRIDGE_GOVERNANCE_ADDRESS.toLowerCase()]: bridgeGovernanceOwner,
    }

    const mockHre: any = {
      network: { name: overrides?.networkName ?? "mainnet" },
      getChainId: async () => "31337",
      getNamedAccounts: async () => ({ deployer: DEPLOYER_ADDRESS }),
      artifacts: {
        readArtifact: async (name: string) => {
          if (name === "BridgeGovernance") {
            return bridgeGovernanceArtifact
          }
          if (name === "ReservationRouter") {
            return routerArtifact
          }
          if (name === "ReservationVault") {
            return vaultArtifact
          }
          throw new Error(`Unexpected artifact request: ${name}`)
        },
        getBuildInfo: async (name: string) => {
          if (
            name === "contracts/vault/ReservationVault.sol:ReservationVault"
          ) {
            return vaultBuildInfo
          }
          throw new Error(`Unexpected build info request: ${name}`)
        },
      },
      ethers: {
        provider: {
          getStorage: async () =>
            `0x${"0".repeat(24)}${PROXY_ADMIN_ADDRESS.slice(2).toLowerCase()}`,
          getCode: async (address: string) =>
            codeByAddress[address.toLowerCase()] ?? "0x",
        },
        getContractAt: async (_abi: any, address: string) => ({
          owner: async () => ownerByAddress[address.toLowerCase()],
        }),
      },
      deployments: {
        get: async (name: string) => {
          const address = addressMap[name]
          if (!address) {
            throw new Error(`No deployment found for: ${name}`)
          }
          if (name === "ReservationRouter") {
            // A hardhat-deploy record: the unlinked artifact bytecode plus
            // the addresses the deployment linked into it.
            return {
              address,
              deployedBytecode: routerArtifact.deployedBytecode,
              libraries: routerLibraries,
            }
          }
          if (name === "ReservationVault") {
            // The vault links no library, so its record carries the
            // artifact's own runtime.
            return {
              address,
              deployedBytecode: vaultArtifact.deployedBytecode,
              libraries: {},
            }
          }
          return { address }
        },
        read: async (name: string, method: string) => {
          if (name === "Bridge" && method === "liveWalletsCount") {
            liveWalletsCountReadCalls += 1
            return liveWalletsCountReadCalls === 1
              ? liveWalletsCount
              : liveWalletsCountAtFinalize
          }
          if (name === "Bridge" && method === "depositParameters") {
            // Index access (array form) and named access are both read by
            // the deploy script's feasibility guards.
            return Object.assign(
              [
                depositDustThreshold,
                BigInt(500),
                BigInt(100000),
                depositRevealAheadPeriod,
              ],
              {
                depositDustThreshold,
                depositTreasuryFeeDivisor: BigInt(500),
                depositTxMaxFee: BigInt(100000),
                depositRevealAheadPeriod,
              }
            )
          }
          if (name === "Bridge" && method === "getReservationRouter") {
            return reservationRouterOnChain
          }
          if (name === "Bridge" && method === "governance") {
            return bridgeGovernanceOnChain
          }
          throw new Error(`Unexpected read: ${name}.${method}`)
        },
      },
    }

    return { mockHre }
  }

  function captureConsoleLog(): { restore: () => string } {
    const messages: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      messages.push(args.join(" "))
    }
    return {
      restore: () => {
        console.log = originalLog
        return messages.join("\n")
      },
    }
  }

  describe("tags", () => {
    it("should have the correct tag", () => {
      expect(func.tags).to.include("GenerateReservationMainnetCalldata")
    })
  })

  describe("skip guard", () => {
    it("should skip on non-mainnet networks without the force env var", async () => {
      delete process.env.DEPLOY_RESERVATION_BOOTSTRAP_CALDATA
      const result = await func.skip!({ network: { name: "sepolia" } } as any)
      expect(result).to.be.true
    })

    it("should not skip on mainnet", async () => {
      const result = await func.skip!({ network: { name: "mainnet" } } as any)
      expect(result).to.be.false
    })

    it("should not skip on a non-mainnet network when force env var is true", async () => {
      process.env.DEPLOY_RESERVATION_BOOTSTRAP_CALDATA = "true"
      try {
        const result = await func.skip!({
          network: { name: "sepolia" },
        } as any)
        expect(result).to.be.false
      } finally {
        delete process.env.DEPLOY_RESERVATION_BOOTSTRAP_CALDATA
      }
    })
  })

  describe("buildReservationActionDefinitions (pure)", () => {
    const params = {
      reservationRouter: RESERVATION_ROUTER_ADDRESS,
      reservationVault: RESERVATION_VAULT_ADDRESS,
      perWalletCap: BigInt(1_000_000),
      singleAmountCap: BigInt(100_000),
      maxActive: 5,
      maxThirdPartyReanchorHolds: 1,
      handoffReserveWallets: 1,
      minAmount: BigInt(10_000),
      txMaxFee: BigInt(1_000),
      termSeconds: 7_776_000,
      dissolutionDelay: 86_400,
      maxTotalAmount: BigInt(500_000),
      maxReservationsPerWallet: 1,
      actionTimeout: 86_400,
      renewalWindowSeconds: 86_400,
    }

    it("should return exactly 6 actions in the point-of-no-return order", () => {
      const actions = buildReservationActionDefinitions(params)
      expect(actions).to.have.lengthOf(6)
      expect(actions.map((a) => a.method)).to.deep.equal([
        "setReservationRouter",
        "beginReservationCapsUpdate",
        "beginReservationParametersUpdate",
        "finalizeReservationCapsUpdate",
        "finalizeReservationParametersUpdate",
        "setVaultStatus",
      ])
    })

    it("should pass through args for setReservationRouter", () => {
      const actions = buildReservationActionDefinitions(params)
      expect(actions[0].args).to.deep.equal([RESERVATION_ROUTER_ADDRESS])
    })

    it("should pass through args for beginReservationCapsUpdate in ABI order", () => {
      const actions = buildReservationActionDefinitions(params)
      expect(actions[1].args).to.deep.equal([
        params.perWalletCap,
        params.singleAmountCap,
        params.maxActive,
        params.maxThirdPartyReanchorHolds,
        params.handoffReserveWallets,
      ])
    })

    it("should pass through args for beginReservationParametersUpdate in ABI order", () => {
      const actions = buildReservationActionDefinitions(params)
      expect(actions[2].args).to.deep.equal([
        params.reservationVault,
        params.minAmount,
        params.txMaxFee,
        params.termSeconds,
        params.dissolutionDelay,
        params.maxTotalAmount,
        params.maxReservationsPerWallet,
        params.actionTimeout,
        params.renewalWindowSeconds,
      ])
    })

    it("should encode finalizeReservationCapsUpdate and finalizeReservationParametersUpdate with no args", () => {
      const actions = buildReservationActionDefinitions(params)
      expect(actions[3].args).to.deep.equal([])
      expect(actions[4].args).to.deep.equal([])
    })

    it("should call setVaultStatus with the vault address and true", () => {
      const actions = buildReservationActionDefinitions(params)
      expect(actions[5].args).to.deep.equal([params.reservationVault, true])
    })

    it("should state the true finalize-order constraint, not a begin-order constraint", () => {
      const actions = buildReservationActionDefinitions(params)
      const capsNote = actions[1].details.Note
      const paramsNote = actions[2].details.Note

      // The real on-chain constraint is finalize-order, not begin-order.
      expect(capsNote).to.include("finalize")
      expect(capsNote).to.not.include("before beginReservationParametersUpdate")
      expect(capsNote.toLowerCase()).to.include(
        "begin-call order does not matter"
      )
      expect(paramsNote.toLowerCase()).to.include("after")
    })

    it("should encode every action to a calldata blob matching the real BridgeGovernance ABI", () => {
      const actions = buildReservationActionDefinitions(params)
      actions.forEach((action) => {
        const calldata = bridgeGovInterface.encodeFunctionData(
          action.method,
          action.args
        )
        const decoded = bridgeGovInterface.decodeFunctionData(
          action.method,
          calldata
        )
        expect(decoded.length).to.equal(action.args.length)
      })
    })
  })

  describe("calldata generation (full run)", () => {
    it("should generate calldata for all 6 actions in point-of-no-return order", async () => {
      const { mockHre } = createMockHre()
      const capture = captureConsoleLog()
      let output: string
      try {
        await func(mockHre)
      } finally {
        output = capture.restore()
      }

      const selectors = [
        "setReservationRouter",
        "beginReservationCapsUpdate",
        "beginReservationParametersUpdate",
        "finalizeReservationCapsUpdate",
        "finalizeReservationParametersUpdate",
        "setVaultStatus",
      ].map((method) => bridgeGovInterface.getFunction(method)!.selector)

      const indices = selectors.map((sel) => output.indexOf(sel))
      indices.forEach((index, i) => {
        expect(index, `selector for action ${i} not logged`).to.be.greaterThan(
          -1
        )
      })
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i]).to.be.greaterThan(
          indices[i - 1],
          "actions must be logged in point-of-no-return order"
        )
      }
    })

    it("should print a direct Council Safe -> BridgeGovernance submission route, not a Timelock route", async () => {
      const { mockHre } = createMockHre()
      const capture = captureConsoleLog()
      let output: string
      try {
        await func(mockHre)
      } finally {
        output = capture.restore()
      }

      expect(output).to.include("Council Safe -> BridgeGovernance")
      expect(output).to.not.include("Timelock.schedule")
      expect(output).to.not.include("Timelock.execute")
    })

    it("should skip entirely on a local network", async () => {
      const { mockHre } = createMockHre({ networkName: "hardhat" })
      await func(mockHre) // must not throw despite no deployments/reads wired
    })
  })

  describe("governance role validation (finding: hardcoded addresses never validated on-chain)", () => {
    it("should throw when the ProxyAdmin owner does not match KNOWN_TIMELOCK", async () => {
      const { mockHre } = createMockHre({
        proxyAdminOwner: "0x9999999999999999999999999999999999999999",
      })
      await expectRejection(func(mockHre), /KNOWN_TIMELOCK/)
    })

    it("should throw when the BridgeGovernance owner does not match KNOWN_COUNCIL_SAFE", async () => {
      const { mockHre } = createMockHre({
        bridgeGovernanceOwner: "0x9999999999999999999999999999999999999999",
      })
      await expectRejection(func(mockHre), /KNOWN_COUNCIL_SAFE/)
    })
  })

  describe("router on-chain verification (finding: no on-chain check before embedding router address)", () => {
    it("should throw when Bridge.getReservationRouter() is already set", async () => {
      const { mockHre } = createMockHre({
        reservationRouterOnChain: RESERVATION_ROUTER_ADDRESS,
      })
      await expectRejection(func(mockHre), /already set/)
    })

    it("should throw when on-chain bytecode does not match the compiled artifact", async () => {
      const { mockHre } = createMockHre({
        routerOnChainCode: "0xdeadbeef",
      })
      await expectRejection(func(mockHre), /bytecode/)
    })
  })

  describe("router runtime check links the record's bytecode (finding: linked code compared with unlinked bytes)", () => {
    it("has a linked router build, so the record's bytecode carries placeholders", () => {
      expect(routerArtifact.deployedBytecode).to.include("__$")
      expect(Object.keys(routerLibraries).length).to.be.greaterThan(0)
      expect(routerLinkedRuntime).to.not.equal(routerArtifact.deployedBytecode)
    })

    it("passes when the on-chain code is the record's bytecode with its libraries linked", async () => {
      const { mockHre } = createMockHre()
      await func(mockHre) // must not throw
    })

    it("throws when the on-chain code differs at a library link site only", async () => {
      const [library] = Object.keys(routerLibraries)
      const wrongLibraries = {
        ...routerLibraries,
        [library]: "0x9999999999999999999999999999999999999999",
      }
      const { mockHre } = createMockHre({
        routerOnChainCode: linkedRecordRuntime({
          name: "ReservationRouter",
          recordBytecode: routerArtifact.deployedBytecode,
          artifactBytecode: routerArtifact.deployedBytecode,
          linkSites: artifactLinkSites(routerArtifact.deployedLinkReferences),
          libraries: wrongLibraries,
        }),
      })
      await expectRejection(func(mockHre), /does not match the compiled/)
    })

    it("throws when the record was written from a different build", () => {
      expect(() =>
        linkedRecordRuntime({
          name: "ReservationRouter",
          recordBytecode: `0x${"00".repeat(10)}`,
          artifactBytecode: routerArtifact.deployedBytecode,
          linkSites: artifactLinkSites(routerArtifact.deployedLinkReferences),
          libraries: routerLibraries,
        })
      ).to.throw(/different build than the compiled artifact/)
    })

    it("throws when the record carries no address for a linked library", () => {
      expect(() =>
        linkedRecordRuntime({
          name: "ReservationRouter",
          recordBytecode: routerArtifact.deployedBytecode,
          artifactBytecode: routerArtifact.deployedBytecode,
          linkSites: artifactLinkSites(routerArtifact.deployedLinkReferences),
          libraries: {},
        })
      ).to.throw(/carries no linked address for/)
    })
  })

  describe("updateReservationParameters precondition mirroring (finding: only 2 of 6 preconditions checked)", () => {
    it("should throw when RESERVATION_TX_MAX_FEE_SATS is zero", async () => {
      process.env.RESERVATION_TX_MAX_FEE_SATS = "0"
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /TX_MAX_FEE_SATS/)
    })

    it("should throw when RESERVATION_MIN_AMOUNT_SATS does not exceed the tx max fee", async () => {
      process.env.RESERVATION_MIN_AMOUNT_SATS = "1000"
      process.env.RESERVATION_TX_MAX_FEE_SATS = "1000"
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /MIN_AMOUNT_SATS/)
    })

    it("should throw when RESERVATION_TERM_SECONDS exceeds MAX_RESERVATION_TERM", async () => {
      process.env.RESERVATION_TERM_SECONDS = "63072001" // 730 days + 1s
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /MAX_RESERVATION_TERM/)
    })

    it("should throw when the renewal window is not shorter than the term", async () => {
      process.env.RESERVATION_RENEWAL_WINDOW_SECONDS =
        process.env.RESERVATION_TERM_SECONDS!
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /RENEWAL_WINDOW_SECONDS/)
    })

    it("should throw when the renewal window is zero", async () => {
      process.env.RESERVATION_RENEWAL_WINDOW_SECONDS = "0"
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /RENEWAL_WINDOW_SECONDS/)
    })

    it("should throw when the action timeout leaves a fresh deposit no signing window", async () => {
      process.env.RESERVATION_ACTION_TIMEOUT_SECONDS = "14401" // 2h margin + 2h min age + 1
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /ACTION_TIMEOUT_SECONDS/)
    })

    it("should throw when RESERVATION_HANDOFF_RESERVE_WALLETS is zero", async () => {
      process.env.RESERVATION_HANDOFF_RESERVE_WALLETS = "0"
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /HANDOFF_RESERVE_WALLETS/)
    })
  })

  // --- A05-01: the vault the ceremony stages is the vault the Bridge keeps
  // for the lifetime of every live reservation, and the pre-flight sign-off
  // binds that address in writing. The deployment record is not that
  // address: a re-run of 95_deploy_reservation_vault.ts after a recompile
  // rewrites it. So the script has to be told the signed-off address, and
  // has to prove the code at the record is the code this build deploys.
  describe("reservation vault sign-off binding (finding: the record decided the vault)", () => {
    it("should throw when RESERVATION_VAULT is not the deployment record's address", async () => {
      process.env.RESERVATION_VAULT =
        "0x0000000000000000000000000000000000000099"
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /RESERVATION_VAULT/)
    })

    it("should throw when RESERVATION_VAULT is not an address", async () => {
      process.env.RESERVATION_VAULT = "not-an-address"
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /is not an Ethereum address/)
    })

    it("should throw when the code at the recorded vault does not match the artifact", async () => {
      const { mockHre } = createMockHre({
        vaultOnChainCode: `${vaultRuntime}00`,
      })
      await expectRejection(func(mockHre), /keccak256 of the code at/)
    })

    it("should report an empty account as carrying no code", async () => {
      const { mockHre } = createMockHre({ vaultOnChainCode: "0x" })
      await expectRejection(func(mockHre), /carries no code/)
    })

    it("should generate calldata when the address and the code hash match", async () => {
      const { mockHre } = createMockHre()
      await func(mockHre)
    })

    it("should accept a runtime whose immutable slots carry values, not the artifact's zeros", async () => {
      // The artifact's `deployedBytecode` leaves the constructor's immutable
      // slots zero-filled; the chain does not. `vaultRuntime` is the
      // populated form, so the happy path above and this case only pass if
      // the guard masks those slots on both sides.
      expect(vaultRuntime).to.not.equal(vaultArtifact.deployedBytecode)
      const { mockHre } = createMockHre({ vaultOnChainCode: vaultRuntime })
      await func(mockHre)
    })

    it("should throw when a byte outside the immutable slots differs", async () => {
      // Byte 8 is in the dispatcher prologue, far from any immutable slot;
      // the immutable references are asserted non-empty above.
      const tampered = `${vaultRuntime.slice(0, 2 + 16)}ff${vaultRuntime.slice(2 + 20)}`
      expect(tampered).to.not.equal(vaultRuntime)
      const { mockHre } = createMockHre({ vaultOnChainCode: tampered })
      await expectRejection(func(mockHre), /keccak256 of the code at/)
    })

    it("should throw when an immutable slot is left zero-filled", async () => {
      // A runtime that claims the artifact's own bytes is not enough: the
      // record must describe a deployed vault, and a zero-filled immutable
      // slot is the artifact, not a deployment. Masking cannot hide a wrong
      // address, but an untouched slot is still worth rejecting evidence
      // for, and this pins that the mask does not accept a different length.
      const truncated = vaultRuntime.slice(0, -2)
      const { mockHre } = createMockHre({ vaultOnChainCode: truncated })
      await expectRejection(func(mockHre), /keccak256 of the code at/)
    })
  })

  // --- A05-02: `owner()` alone cannot tell a handed-over,
  // reservation-capable BridgeGovernance from one the Council Safe owns but
  // never handed to the Bridge, or from a build that predates the
  // reservation surface. Both make every action below revert on arrival.
  describe("BridgeGovernance ceremony target (finding: only owner() was checked)", () => {
    const PRE_RESERVATION_GOVERNANCE = "0x6080604052348015600f57600080fd5b50"

    it("should throw when Bridge.governance() is the old governance", async () => {
      const { mockHre } = createMockHre({
        bridgeGovernanceOnChain: "0x6b3E0e4b0b6C63c7C1c1B1a1C1D1E1F1a1B1C1D1",
      })
      await expectRejection(func(mockHre), /Bridge\.governance\(\) is/)
    })

    it("should name Stage 1 as what the mismatch is missing", async () => {
      const { mockHre } = createMockHre({
        bridgeGovernanceOnChain: "0x6b3E0e4b0b6C63c7C1c1B1a1C1D1E1F1a1B1C1D1",
      })
      await expectRejection(func(mockHre), /Stage 1/)
    })

    it("should throw when the target address carries no code", async () => {
      const { mockHre } = createMockHre({
        bridgeGovernanceOnChainCode: "0x",
      })
      await expectRejection(func(mockHre), /no code at/)
    })

    it("should throw, naming the missing methods, when the target lacks the reservation selectors", async () => {
      const { mockHre } = createMockHre({
        bridgeGovernanceOnChainCode: PRE_RESERVATION_GOVERNANCE,
      })
      let rejection: unknown
      try {
        await func(mockHre)
      } catch (error) {
        rejection = error
      }
      expect(rejection, "func should throw").to.be.instanceOf(Error)
      const { message } = rejection as Error
      expect(message).to.include("does not expose")
      // The whole surface, not just the first missing selector.
      expect(message).to.include("beginReservationCapsUpdate")
      expect(message).to.include("pendingReservationParametersUpdate")
      expect(message).to.include("setVaultStatus")
    })

    it("should require every method the actions encode, plus both pending views", () => {
      const encoded = buildReservationActionDefinitions({
        reservationRouter: RESERVATION_ROUTER_ADDRESS,
        reservationVault: RESERVATION_VAULT_ADDRESS,
        perWalletCap: BigInt(1_000_000),
        singleAmountCap: BigInt(100_000),
        maxActive: 5,
        maxThirdPartyReanchorHolds: 1,
        handoffReserveWallets: 1,
        minAmount: BigInt(10_000),
        txMaxFee: BigInt(1_000),
        termSeconds: 7_776_000,
        dissolutionDelay: 86_400,
        maxTotalAmount: BigInt(500_000),
        maxReservationsPerWallet: 1,
        actionTimeout: 86_400,
        renewalWindowSeconds: 86_400,
      }).map((action) => action.method)

      encoded.forEach((method) => {
        expect(RESERVATION_SURFACE_METHODS).to.include(method)
      })
      expect(RESERVATION_SURFACE_METHODS).to.include(
        "pendingReservationCapsUpdate"
      )
      expect(RESERVATION_SURFACE_METHODS).to.include(
        "pendingReservationParametersUpdate"
      )
    })
  })

  // --- A05-03: `beginReservationCapsUpdate` validates none of its five
  // values and `beginReservationParametersUpdate` validates only the
  // dissolution delay and the action-timeout ceiling, so a value outside the
  // finalize rules used to stage cleanly and be rejected 48h later, with no
  // cancel left.
  describe("finalize-time value acceptance (finding: caps lower bounds missing)", () => {
    const acceptedValues = {
      perWalletCap: BigInt(1_000_000),
      singleAmountCap: BigInt(100_000),
      maxActive: 5,
      maxThirdPartyReanchorHolds: 1,
      handoffReserveWallets: 1,
      minAmount: BigInt(10_000),
      txMaxFee: BigInt(1_000),
      termSeconds: 7_776_000,
      dissolutionDelay: 86_400,
      maxTotalAmount: BigInt(500_000),
      maxReservationsPerWallet: 1,
      actionTimeout: 86_400,
      renewalWindowSeconds: 86_400,
    }

    it("should accept the launch values", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues(acceptedValues)
      ).to.not.throw()
    })

    it("should reject a zero maxActiveReservations with the on-chain require text", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          maxActive: 0,
        })
      ).to.throw(/Active reservations cap must be greater than zero/)
    })

    it("should reject a negative maxActiveReservations", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          maxActive: -1,
        })
      ).to.throw(/RESERVATION_MAX_ACTIVE \(-1\)/)
    })

    it("should reject a zero hand-off reserve with the on-chain require text", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          handoffReserveWallets: 0,
        })
      ).to.throw(/Hand-off reserve must be greater than zero/)
    })

    it("should reject a zero tx max fee", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          txMaxFee: BigInt(0),
        })
      ).to.throw(/Reservation transaction max fee must be greater than zero/)
    })

    it("should reject a min amount that does not exceed the tx max fee", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          minAmount: acceptedValues.txMaxFee,
        })
      ).to.throw(/Reservation minimum amount must be greater/)
    })

    it("should reject a term below the protocol minimum", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          termSeconds: 7_775_999,
        })
      ).to.throw(/Reservation term out of protocol bounds/)
    })

    it("should reject an action timeout above the protocol maximum", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          actionTimeout: 63_072_001,
        })
      ).to.throw(/Reservation action timeout out of protocol bounds/)
    })

    it("should reject a zero max-reservations-per-wallet", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          maxReservationsPerWallet: 0,
        })
      ).to.throw(/Max reservations per wallet must be greater than zero/)
    })

    it("should accept a zero single-amount cap, which the contract reads as disabled", () => {
      // `Reservation.validateReservationCapsInvariant` short-circuits when
      // `reservationMaxSingleAmount == 0`: zero is how governance disables
      // that amount cap, and the relational ceiling disappears with it. A
      // mirror that rejected the total here would refuse calldata the
      // contract accepts.
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          singleAmountCap: BigInt(0),
          maxTotalAmount: BigInt(500_000),
        })
      ).to.not.throw()
    })

    it("should still reject a total above capacity when the single-amount cap is set", () => {
      expect(() =>
        assertFinalizeAcceptsReservationValues({
          ...acceptedValues,
          singleAmountCap: BigInt(1_000),
          maxTotalAmount: BigInt(5_001),
        })
      ).to.throw(/Amount cap exceeds slot capacity/)
    })

    it("should throw from the deploy function when MAX_ACTIVE and MAX_TOTAL_AMOUNT are both zero", async () => {
      // The case the finding used: every guard on MAX_ACTIVE in this script
      // was an upper bound, so 0 sailed through, staged, and was rejected by
      // the caps finalize 48h later.
      process.env.RESERVATION_MAX_ACTIVE = "0"
      process.env.RESERVATION_MAX_TOTAL_AMOUNT_SATS = "0"
      const { mockHre } = createMockHre()
      await expectRejection(
        func(mockHre),
        /Active reservations cap must be greater than zero/
      )
    })
  })

  // A reserved reveal is only possible when the deposit refund window the
  // Bridge demands (reveal-ahead period) fits inside the one a reservation
  // allows (term plus the 24h refund safety margin), and when a dust-sized
  // deposit fits under every amount cap. Both rules are also enforced
  // on-chain: `BridgeState.assertReservedDepositsFeasible`
  // (contracts/bridge/BridgeState.sol:703-734) is called by both
  // reservation setters while a vault is set
  // (Reservation.sol:1689, :1792) and by `updateDepositParameters`
  // (BridgeState.sol:666). The deploy script mirrors the same rules so an
  // operator learns about a bad value here instead of at finalize.
  describe("reserved-deposit feasibility against the live deposit parameters", () => {
    it("should throw when the reveal-ahead period exceeds the term plus the refund safety margin", async () => {
      // Live mainnet value: 150 days, against VALID_ENV's 90-day term.
      const { mockHre } = createMockHre({ depositRevealAheadPeriod: 12960000 })
      await expectRejection(func(mockHre), /depositRevealAheadPeriod/)
    })

    it("should accept the longest reveal-ahead period whose reveal window is still positive", async () => {
      // term 7,776,000s; reveal-ahead + 2h drift - 24h margin + 1h feasibility
      // margin == term gives 7,776,000 + 75,600.
      const { mockHre } = createMockHre({
        depositRevealAheadPeriod: 7776000 + 75600,
      })
      await func(mockHre)
    })

    it("should throw when the dust threshold exceeds a non-zero amount cap", async () => {
      // Live mainnet value: 1,000,000 sats, against VALID_ENV's 100,000 cap.
      const { mockHre } = createMockHre({
        depositDustThreshold: BigInt(1000000),
      })
      await expectRejection(func(mockHre), /depositDustThreshold/)
    })
  })

  describe("live-wallet slot capacity (finding: not re-verified before finalize)", () => {
    it("should throw at begin-time when MAX_ACTIVE exceeds liveWalletsCount", async () => {
      const { mockHre } = createMockHre({ liveWalletsCount: 2 }) // MAX_ACTIVE=5 > 2
      await expectRejection(func(mockHre), /RESERVATION_MAX_ACTIVE/)
    })

    it("should throw immediately before finalize when live-wallet count drops between the two reads", async () => {
      // Passes the begin-time check (10 live wallets) but a wallet retires
      // before the finalize-time re-check (2 live wallets, below MAX_ACTIVE=5).
      const { mockHre } = createMockHre({
        liveWalletsCount: 10,
        liveWalletsCountAtFinalize: 2,
      })
      await expectRejection(
        func(mockHre),
        /no longer holds immediately before finalize/
      )
    })

    it("should not reference the nonexistent 'Occupancy cap exceeds live wallet slot capacity' revert string", async () => {
      const { mockHre } = createMockHre({ liveWalletsCount: 2 })
      let rejection: unknown
      try {
        await func(mockHre)
      } catch (error) {
        rejection = error
      }
      expect(rejection, "func should throw").to.be.instanceOf(Error)
      const { message } = rejection as Error
      expect(message).to.not.include(
        "Occupancy cap exceeds live wallet slot capacity"
      )
      expect(message).to.include("Wallet reservations cap exceeded")
    })
  })

  // The on-chain hand-off reserve gate in `Reservation.reserveAcceptanceCapacity`
  // caps the active position count at
  //   max(0, liveWalletsCount - handoffReserveWallets) * maxReservationsPerWallet,
  // strictly below the naive `liveWalletsCount * maxReservationsPerWallet`
  // the script used to check alone.
  describe("hand-off reserve-aware fleet fit", () => {
    it("should throw at begin-time when MAX_ACTIVE exceeds the hand-off reserve-aware capacity", async () => {
      // 6 live wallets, hand-off reserve 2, per-wallet 1 => capacity 4.
      // MAX_ACTIVE=5 passes the naive relation (5 <= 6) but not the
      // hand-off-aware one (5 > 4).
      const { mockHre } = createMockHre({ liveWalletsCount: 6 })
      process.env.RESERVATION_HANDOFF_RESERVE_WALLETS = "2"
      await expectRejection(
        func(mockHre),
        /hand-off reserve-aware slot capacity/
      )
    })

    it("should throw at begin-time when the live-wallet count is at or below the hand-off reserve", async () => {
      // 5 live wallets, hand-off reserve 5 => remaining wallets 0, capacity
      // 0, so no position can ever be accepted. The naive relation
      // (5 <= 5) still passes, so only the hand-off-aware check can
      // catch this.
      const { mockHre } = createMockHre({ liveWalletsCount: 5 })
      process.env.RESERVATION_HANDOFF_RESERVE_WALLETS = "5"
      await expectRejection(
        func(mockHre),
        /hand-off reserve-aware slot capacity/
      )
    })

    it("should throw immediately before finalize when the hand-off-aware capacity shrinks between the two reads", async () => {
      // Passes the begin-time check (10 live wallets, reserve 1 => capacity
      // 9, MAX_ACTIVE=5) and the naive finalize check (5 live wallets =>
      // naive capacity 5), but the hand-off-aware finalize capacity is
      // 5 - 1 = 4, below MAX_ACTIVE=5.
      const { mockHre } = createMockHre({
        liveWalletsCount: 10,
        liveWalletsCountAtFinalize: 5,
      })
      await expectRejection(
        func(mockHre),
        /hand-off reserve-aware slot capacity/
      )
    })

    it("should accept a cap that fits the hand-off reserve-aware capacity", async () => {
      // 6 live wallets, reserve 2, per-wallet 1 => capacity 4.
      // MAX_ACTIVE=4 is exactly at the ceiling and must pass.
      process.env.RESERVATION_MAX_ACTIVE = "4"
      // Decision 1: maxTotalAmount <= MAX_ACTIVE * singleAmountCap
      // = 4 * 100000.
      process.env.RESERVATION_MAX_TOTAL_AMOUNT_SATS = "400000"
      const { mockHre } = createMockHre({ liveWalletsCount: 6 })
      process.env.RESERVATION_HANDOFF_RESERVE_WALLETS = "2"
      const capture = captureConsoleLog()
      let output: string
      try {
        await func(mockHre)
      } finally {
        output = capture.restore()
      }
      expect(output).to.include("Hand-off reserve-aware fleet fit OK")
    })

    it("should compute the hand-off-aware capacity the way the contract does", () => {
      expect(
        handoffAwareSlotCapacity({
          liveWalletsCount: 10,
          handoffReserveWallets: 1,
          maxReservationsPerWallet: 1,
        })
      ).to.equal(9)
      expect(
        handoffAwareSlotCapacity({
          liveWalletsCount: 2,
          handoffReserveWallets: 2,
          maxReservationsPerWallet: 1,
        })
      ).to.equal(0)
      expect(
        handoffAwareSlotCapacity({
          liveWalletsCount: 1,
          handoffReserveWallets: 3,
          maxReservationsPerWallet: 1,
        })
      ).to.equal(0)
      expect(
        handoffAwareSlotCapacity({
          liveWalletsCount: 10,
          handoffReserveWallets: 2,
          maxReservationsPerWallet: 3,
        })
      ).to.equal(24)
    })

    it("should not throw from the pure fleet-fit helper when the cap fits", () => {
      expect(() =>
        assertHandoffAwareFleetFit({
          maxActive: 4,
          liveWalletsCount: 6,
          handoffReserveWallets: 2,
          maxReservationsPerWallet: 1,
        })
      ).to.not.throw()
    })

    it("should throw from the pure fleet-fit helper when the cap does not fit", () => {
      expect(() =>
        assertHandoffAwareFleetFit({
          maxActive: 5,
          liveWalletsCount: 6,
          handoffReserveWallets: 2,
          maxReservationsPerWallet: 1,
        })
      ).to.throw(/Hand-off reserve exceeded/)
    })
  })

  // The maximum below mirrors the on-chain
  // `Reservation.MAX_RESERVATION_DISSOLUTION_DELAY` bound, so the script
  // refuses an over-long delay before the calldata is signed instead of
  // letting it revert on-chain at finalize.
  describe("dissolution delay script policy", () => {
    it("should throw when the dissolution delay is zero", async () => {
      process.env.RESERVATION_DISSOLUTION_DELAY_SECONDS = "0"
      const { mockHre } = createMockHre()
      await expectRejection(
        func(mockHre),
        /RESERVATION_DISSOLUTION_DELAY_SECONDS \(0\) must be greater than zero/
      )
    })

    it("should throw when the dissolution delay exceeds 730 days", async () => {
      process.env.RESERVATION_DISSOLUTION_DELAY_SECONDS = "63072001" // 730 days + 1s
      const { mockHre } = createMockHre()
      await expectRejection(
        func(mockHre),
        /RESERVATION_DISSOLUTION_DELAY_SECONDS \(63072001\) exceeds/
      )
    })

    it("should accept a dissolution delay of exactly 730 days", async () => {
      process.env.RESERVATION_DISSOLUTION_DELAY_SECONDS = "63072000" // 730 days
      const { mockHre } = createMockHre()
      await func(mockHre)
    })

    it("should name the maximum as mirroring the on-chain bound", async () => {
      process.env.RESERVATION_DISSOLUTION_DELAY_SECONDS = "63072001"
      const { mockHre } = createMockHre()
      let rejection: unknown
      try {
        await func(mockHre)
      } catch (error) {
        rejection = error
      }
      expect(rejection, "func should throw").to.be.instanceOf(Error)
      const { message } = rejection as Error
      expect(message).to.include("deploy-script guard")
      expect(message).to.include("MAX_RESERVATION_DISSOLUTION_DELAY")
    })

    it("should reject a zero delay from the pure policy helper", () => {
      expect(() => assertDissolutionDelayWithinScriptPolicy(0)).to.throw(
        /must be greater than zero/
      )
      expect(() => assertDissolutionDelayWithinScriptPolicy(-1)).to.throw(
        /must be greater than zero/
      )
    })

    it("should reject a delay above the maximum from the pure policy helper", () => {
      expect(() =>
        assertDissolutionDelayWithinScriptPolicy(63_072_001)
      ).to.throw(/exceeds this script's maximum dissolution delay/)
    })

    it("should accept delays inside the policy band from the pure policy helper", () => {
      expect(() => assertDissolutionDelayWithinScriptPolicy(1)).to.not.throw()
      expect(() =>
        assertDissolutionDelayWithinScriptPolicy(63_072_000)
      ).to.not.throw()
    })
  })

  describe("reserved-reveal feasibility guard", () => {
    it("should reject a 90-day term when the live reveal-ahead period is 150 days", async () => {
      // term 7,776,000s < min feasible term 12,884,400s
      // (= 12,960,000 + 7,200 - 86,400 + 3,600)
      const { mockHre } = createMockHre({
        depositRevealAheadPeriod: 12_960_000,
      })
      await expectRejection(
        func(mockHre),
        /minimum feasible term \(12884400s\)/
      )
    })

    it("should accept a 152-day term when the live reveal-ahead period is 150 days", async () => {
      // term 13,132,800s >= min feasible term 12,884,400s
      process.env.RESERVATION_TERM_SECONDS = "13132800"
      const { mockHre } = createMockHre({
        depositRevealAheadPeriod: 12_960_000,
      })
      const capture = captureConsoleLog()
      let output: string
      try {
        await func(mockHre)
      } finally {
        output = capture.restore()
      }
      expect(output).to.include("Reserved-reveal window OK")
    })

    it("should pass with no lower bound when the reveal-ahead period is zero", async () => {
      // depositRevealAheadPeriod 0 disables the ahead-period check in
      // Deposit.sol, so the guard has nothing to enforce on top of the
      // existing term bounds.
      const { mockHre } = createMockHre({ depositRevealAheadPeriod: 0 })
      const capture = captureConsoleLog()
      let output: string
      try {
        await func(mockHre)
      } finally {
        output = capture.restore()
      }
      expect(output).to.include("Reserved-reveal window OK")
    })
  })

  describe("deployment summary JSON", () => {
    let summary: any

    beforeEach(async () => {
      removeSummaryFiles()
      const { mockHre } = createMockHre()
      await func(mockHre)
      const files = findSummaryFiles()
      expect(files.length).to.be.greaterThan(0)
      summary = JSON.parse(fs.readFileSync(files[0], "utf-8"))
    })

    afterEach(() => {
      removeSummaryFiles()
    })

    it("should have governanceActions derived from the single action list, in order, with 6 entries", () => {
      expect(summary.governanceActions).to.be.an("array")
      expect(summary.governanceActions).to.have.lengthOf(6)

      const expectedSelectors = [
        "setReservationRouter",
        "beginReservationCapsUpdate",
        "beginReservationParametersUpdate",
        "finalizeReservationCapsUpdate",
        "finalizeReservationParametersUpdate",
        "setVaultStatus",
      ].map((method) => bridgeGovInterface.getFunction(method)!.selector)

      summary.governanceActions.forEach((action: any, index: number) => {
        expect(action.to).to.equal(BRIDGE_GOVERNANCE_ADDRESS)
        expect(action.data.slice(0, 10)).to.equal(expectedSelectors[index])
        expect(action).to.have.property("description")
        expect(action).to.have.property("value")
      })
    })

    it("should not have a separate exampleConfig representation", () => {
      expect(summary).to.not.have.property("exampleConfig")
    })

    it("should record both the begin-time and finalize-time live-wallet slot capacity checks", () => {
      expect(summary.liveWalletSlotCapacity).to.have.property(
        "atBeginGeneration"
      )
      expect(summary.liveWalletSlotCapacity).to.have.property(
        "atFinalizeGeneration"
      )
      expect(summary.liveWalletSlotCapacity.atBeginGeneration.satisfied).to.be
        .true
      expect(summary.liveWalletSlotCapacity.atFinalizeGeneration.satisfied).to
        .be.true
    })

    it("should include ProxyAdmin, Timelock, and CouncilSafe in existingContracts", () => {
      expect(summary.existingContracts.ProxyAdmin).to.equal(PROXY_ADMIN_ADDRESS)
      expect(summary.existingContracts.Timelock).to.equal(KNOWN_TIMELOCK)
      expect(summary.existingContracts.CouncilSafe).to.equal(KNOWN_COUNCIL_SAFE)
    })

    it("should record both the begin-time and finalize-time hand-off reserve-aware fleet fit checks", () => {
      expect(summary.handoffAwareFleetFit).to.have.property("atBeginGeneration")
      expect(summary.handoffAwareFleetFit).to.have.property(
        "atFinalizeGeneration"
      )
      expect(summary.handoffAwareFleetFit.handoffReserveWallets).to.equal(1)
      expect(summary.handoffAwareFleetFit.atBeginGeneration.satisfied).to.be
        .true
      expect(summary.handoffAwareFleetFit.atFinalizeGeneration.satisfied).to.be
        .true
      // 10 live wallets, reserve 1, per-wallet 1 => 9.
      expect(
        summary.handoffAwareFleetFit.atBeginGeneration.slotCapacity
      ).to.equal(9)
      expect(
        summary.handoffAwareFleetFit.atFinalizeGeneration.slotCapacity
      ).to.equal(9)
    })

    it("should record the dissolution delay script policy and its satisfaction", () => {
      expect(summary.dissolutionDelayPolicy.dissolutionDelaySeconds).to.equal(
        86400
      )
      expect(
        summary.dissolutionDelayPolicy.maxDissolutionDelaySeconds
      ).to.equal(63072000)
      expect(summary.dissolutionDelayPolicy.satisfied).to.be.true
      expect(summary.dissolutionDelayPolicy.description).to.include(
        "deploy-script policy"
      )
    })

    // The summary feeds Safe transaction builders and other ethers v6
    // tooling, which reject a mixed-case address whose EIP-55 checksum is
    // wrong. Every address in it must already be in checksum form.
    it("should write EIP-55 checksummed governance addresses", () => {
      ;["Timelock", "CouncilSafe"].forEach((name) => {
        const address = summary.existingContracts[name]
        expect(address, name).to.equal(getAddress(address.toLowerCase()))
      })
    })
  })
})
