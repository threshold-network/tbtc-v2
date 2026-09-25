/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import hre, { ethers } from "hardhat"
import { utils } from "ethers"
import fs from "fs"
import path from "path"
import func, {
  buildReservationActionDefinitions,
  buildReservationTermActionDefinitions,
  checkReservationTermTable,
  KNOWN_TIMELOCK,
  KNOWN_COUNCIL_SAFE,
} from "../../deploy/98_generate_reservation_mainnet_calldata"
import { RESERVATION_TERM_ENTRIES } from "../../deploy/97_set_reservation_parameters"

const DAY = 24 * 60 * 60
// The live mainnet `depositRevealAheadPeriod`.
const MAINNET_REVEAL_AHEAD_PERIOD = 150 * DAY
// `WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN`.
const DEPOSIT_REFUND_SAFETY_MARGIN = DAY

// The bootstrap actions, then one begin/finalize pair per ruled term entry.
const BOOTSTRAP_METHODS = [
  "setReservationRouter",
  "beginReservationCapsUpdate",
  "beginReservationParametersUpdate",
  "finalizeReservationCapsUpdate",
  "finalizeReservationParametersUpdate",
  "setVaultStatus",
]
const TERM_METHODS = RESERVATION_TERM_ENTRIES.flatMap(() => [
  "beginReservationTermUpdate",
  "finalizeReservationTermUpdate",
])

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
  // The failure is raised outside the `try`: raised inside, the `catch`
  // would match `pattern` against the failure's own message, which quotes
  // the pattern, and pass whenever the promise resolves.
  let rejection: Error | undefined
  try {
    await promise
  } catch (error) {
    rejection = error as Error
  }
  if (!rejection) {
    expect.fail(`expected rejection matching ${pattern}`)
  }
  expect(rejection.message).to.match(pattern)
}

describe("Deploy Script 98: Reservation Mainnet Calldata Generation", () => {
  const DEPLOYER_ADDRESS = "0x1234567890123456789012345678901234567890"
  const BRIDGE_ADDRESS = "0x0000000000000000000000000000000000000001"
  const BRIDGE_GOVERNANCE_ADDRESS = "0x0000000000000000000000000000000000000002"
  const RESERVATION_VAULT_ADDRESS = "0x0000000000000000000000000000000000000003"
  const RESERVATION_ROUTER_ADDRESS =
    "0xAABbCcddEe00112233445566778899AaBbCCdDeE"
  const PROXY_ADMIN_ADDRESS = "0x1111111111111111111111111111111111111111"
  const ROUTER_DEPLOYED_BYTECODE = "0x600160005260206000f3"

  // The real compiled BridgeGovernance ABI -- used as the single encoding
  // source, mirroring what the deploy script itself loads via
  // `artifacts.readArtifact`.
  let bridgeGovernanceArtifact: any
  let bridgeGovInterface: utils.Interface

  before(async () => {
    bridgeGovernanceArtifact = await hre.artifacts.readArtifact(
      "BridgeGovernance"
    )
    bridgeGovInterface = new ethers.utils.Interface(
      bridgeGovernanceArtifact.abi
    )
  })

  // A complete set of env vars that satisfies every validation the script
  // performs: Decision 1, the live-wallet sizing relation (liveWalletsCount
  // mocked to 10, MAX_ACTIVE below), and every mirrored
  // updateReservationParameters on-chain require.
  const VALID_ENV: Record<string, string> = {
    RESERVATION_PER_WALLET_CAP_SATS: "1000000",
    RESERVATION_SINGLE_AMOUNT_CAP_SATS: "100000",
    RESERVATION_MAX_ACTIVE: "5",
    RESERVATION_MIN_AMOUNT_SATS: "10000",
    RESERVATION_TX_MAX_FEE_SATS: "1000",
    RESERVATION_TERM_SECONDS: "7776000", // 90 days, above MIN_RESERVATION_TERM (30 days)
    RESERVATION_DISSOLUTION_DELAY_SECONDS: "86400",
    RESERVATION_MAX_TOTAL_AMOUNT_SATS: "500000", // 5 * 100000, satisfies Decision 1
    RESERVATION_MAX_PER_WALLET: "1",
    RESERVATION_ACTION_TIMEOUT_SECONDS: "86400",
    RESERVATION_RENEWAL_WINDOW_SECONDS: "86400",
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
    reservationRouterOnChain?: string
    routerOnChainCode?: string
    proxyAdminOwner?: string
    bridgeGovernanceOwner?: string
    depositRevealAheadPeriod?: number
  }): { mockHre: any } {
    const liveWalletsCount = overrides?.liveWalletsCount ?? 10
    const liveWalletsCountAtFinalize =
      overrides?.liveWalletsCountAtFinalize ?? liveWalletsCount
    const reservationRouterOnChain =
      overrides?.reservationRouterOnChain ?? ethers.constants.AddressZero
    const routerOnChainCode =
      overrides?.routerOnChainCode ?? ROUTER_DEPLOYED_BYTECODE
    const proxyAdminOwner = overrides?.proxyAdminOwner ?? KNOWN_TIMELOCK
    const bridgeGovernanceOwner =
      overrides?.bridgeGovernanceOwner ?? KNOWN_COUNCIL_SAFE
    const depositRevealAheadPeriod =
      overrides?.depositRevealAheadPeriod ?? MAINNET_REVEAL_AHEAD_PERIOD

    const addressMap: Record<string, string> = {
      Bridge: BRIDGE_ADDRESS,
      BridgeGovernance: BRIDGE_GOVERNANCE_ADDRESS,
      ReservationVault: RESERVATION_VAULT_ADDRESS,
      ReservationRouter: RESERVATION_ROUTER_ADDRESS,
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
          if (name !== "BridgeGovernance") {
            throw new Error(`Unexpected artifact request: ${name}`)
          }
          return bridgeGovernanceArtifact
        },
      },
      ethers: {
        provider: {
          getStorageAt: async () =>
            `0x${"0".repeat(24)}${PROXY_ADMIN_ADDRESS.slice(2).toLowerCase()}`,
          getCode: async () => routerOnChainCode,
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
            return { address, deployedBytecode: ROUTER_DEPLOYED_BYTECODE }
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
          if (name === "Bridge" && method === "getReservationRouter") {
            return reservationRouterOnChain
          }
          if (name === "Bridge" && method === "depositParameters") {
            return { depositRevealAheadPeriod }
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
    it("should generate calldata for all 6 bootstrap actions, then the term entries, in point-of-no-return order", async () => {
      const { mockHre } = createMockHre()
      const capture = captureConsoleLog()
      let output: string
      try {
        await func(mockHre)
      } finally {
        output = capture.restore()
      }

      // Each term method's selector repeats per entry; its first occurrence
      // must still follow setVaultStatus.
      const selectors = [
        ...BOOTSTRAP_METHODS,
        "beginReservationTermUpdate",
        "finalizeReservationTermUpdate",
      ].map((method) => bridgeGovInterface.getSighash(method))

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

    it("should throw when RESERVATION_TERM_SECONDS is below the 30-day MIN_RESERVATION_TERM", async () => {
      process.env.RESERVATION_TERM_SECONDS = String(30 * DAY - 1)
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /MIN_RESERVATION_TERM/)
    })

    it("should accept RESERVATION_TERM_SECONDS at the 30-day MIN_RESERVATION_TERM", async () => {
      process.env.RESERVATION_TERM_SECONDS = String(30 * DAY)
      const { mockHre } = createMockHre()
      const capture = captureConsoleLog()
      try {
        await func(mockHre)
      } finally {
        capture.restore()
      }
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

    it("should throw when the action timeout does not exceed the safety margin", async () => {
      process.env.RESERVATION_ACTION_TIMEOUT_SECONDS = "7200" // exactly the margin
      const { mockHre } = createMockHre()
      await expectRejection(func(mockHre), /ACTION_TIMEOUT_SECONDS/)
    })
  })

  describe("checkReservationTermTable (pure)", () => {
    const entry = (termId: number, termDays: number, custodyBps = 5) => ({
      termId,
      termSeconds: termDays * DAY,
      custodyBps,
      enabled: true,
    })

    it("should accept the ruled entries at the live reveal-ahead period and a 7-day window", () => {
      checkReservationTermTable(
        RESERVATION_TERM_ENTRIES,
        MAINNET_REVEAL_AHEAD_PERIOD,
        7 * DAY
      )
    })

    it("should accept a largest entry of 149 days at the 150-day reveal-ahead period", () => {
      checkReservationTermTable(
        [entry(1, 149)],
        MAINNET_REVEAL_AHEAD_PERIOD,
        DAY
      )
    })

    it("should refuse a largest entry one second under 149 days at the 150-day reveal-ahead period", () => {
      expect(() =>
        checkReservationTermTable(
          [
            {
              termId: 1,
              termSeconds: 149 * DAY - 1,
              custodyBps: 5,
              enabled: true,
            },
          ],
          MAINNET_REVEAL_AHEAD_PERIOD,
          DAY
        )
      ).to.throw(/depositRevealAheadPeriod/)
    })

    it("should refuse the ruled entries with the 30-day entry added first", () => {
      const [longest, month, quarter] = RESERVATION_TERM_ENTRIES
      expect(() =>
        checkReservationTermTable(
          [month, longest, quarter],
          MAINNET_REVEAL_AHEAD_PERIOD,
          7 * DAY
        )
      ).to.throw(/Reservation term 2 .*depositRevealAheadPeriod/)
    })

    it("should accept a short first entry while it covers the reveal-ahead period", () => {
      checkReservationTermTable(
        [entry(2, 30), entry(1, 365)],
        30 * DAY + DEPOSIT_REFUND_SAFETY_MARGIN,
        DAY
      )
    })

    it("should refuse a renewal window equal to the smallest entry", () => {
      expect(() =>
        checkReservationTermTable(RESERVATION_TERM_ENTRIES, 0, 30 * DAY)
      ).to.throw(/is not shorter than reservation term 2/)
    })

    it("should accept a renewal window one second below the smallest entry", () => {
      checkReservationTermTable(RESERVATION_TERM_ENTRIES, 0, 30 * DAY - 1)
    })
  })

  describe("buildReservationTermActionDefinitions (pure)", () => {
    it("should return a begin/finalize pair per entry, in order", () => {
      const actions = buildReservationTermActionDefinitions(
        RESERVATION_TERM_ENTRIES
      )
      expect(actions.map((a) => a.method)).to.deep.equal(TERM_METHODS)
      RESERVATION_TERM_ENTRIES.forEach((termEntry, index) => {
        expect(actions[2 * index].args).to.deep.equal([
          termEntry.termId,
          termEntry.termSeconds,
          termEntry.custodyBps,
          termEntry.enabled,
        ])
        expect(actions[2 * index + 1].args).to.deep.equal([])
      })
    })

    it("should encode every action against the real BridgeGovernance ABI", () => {
      buildReservationTermActionDefinitions(RESERVATION_TERM_ENTRIES).forEach(
        (action) => {
          const calldata = bridgeGovInterface.encodeFunctionData(
            action.method,
            action.args
          )
          expect(
            bridgeGovInterface.decodeFunctionData(action.method, calldata)
          ).to.have.lengthOf(action.args.length)
        }
      )
    })
  })

  describe("reservation term table checks (full run)", () => {
    it("should throw when the live reveal-ahead period exceeds the largest entry plus 24 hours", async () => {
      const { mockHre } = createMockHre({
        depositRevealAheadPeriod: 365 * DAY + DEPOSIT_REFUND_SAFETY_MARGIN + 1,
      })
      await expectRejection(func(mockHre), /depositRevealAheadPeriod/)
    })

    it("should accept a live reveal-ahead period of exactly the largest entry plus 24 hours", async () => {
      const { mockHre } = createMockHre({
        depositRevealAheadPeriod: 365 * DAY + DEPOSIT_REFUND_SAFETY_MARGIN,
      })
      const capture = captureConsoleLog()
      try {
        await func(mockHre)
      } finally {
        capture.restore()
      }
    })

    it("should throw when the renewal window is not shorter than the smallest entry", async () => {
      process.env.RESERVATION_RENEWAL_WINDOW_SECONDS = String(30 * DAY)
      const { mockHre } = createMockHre()
      await expectRejection(
        func(mockHre),
        /is not shorter than reservation term/
      )
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
      try {
        await func(mockHre)
        expect.fail("expected func to throw")
      } catch (error) {
        const { message } = error as Error
        expect(message).to.not.include(
          "Occupancy cap exceeds live wallet slot capacity"
        )
        expect(message).to.include("Wallet reservations cap exceeded")
      }
    })
  })

  describe("deployment summary JSON", () => {
    const deploymentsDir = path.join(
      __dirname,
      "..",
      "..",
      "deployments",
      "mainnet"
    )

    function findSummaryFiles(): string[] {
      if (!fs.existsSync(deploymentsDir)) return []
      return fs
        .readdirSync(deploymentsDir)
        .filter(
          (f) =>
            f.startsWith("reservation-bootstrap-calldata-") &&
            f.endsWith(".json")
        )
        .map((f) => path.join(deploymentsDir, f))
    }

    function cleanupSummaryFiles(): void {
      findSummaryFiles().forEach((f) => {
        try {
          fs.unlinkSync(f)
        } catch {
          // Ignore cleanup errors
        }
      })
    }

    let summary: any

    beforeEach(async () => {
      cleanupSummaryFiles()
      const { mockHre } = createMockHre()
      await func(mockHre)
      const files = findSummaryFiles()
      expect(files.length).to.be.greaterThan(0)
      summary = JSON.parse(fs.readFileSync(files[0], "utf-8"))
    })

    afterEach(() => {
      cleanupSummaryFiles()
    })

    it("should have governanceActions derived from the single action list, in order, with 6 bootstrap entries and a pair per term entry", () => {
      expect(summary.governanceActions).to.be.an("array")
      expect(summary.governanceActions).to.have.lengthOf(12)

      const expectedSelectors = [...BOOTSTRAP_METHODS, ...TERM_METHODS].map(
        (method) => bridgeGovInterface.getSighash(method)
      )

      summary.governanceActions.forEach((action: any, index: number) => {
        expect(action.to).to.equal(BRIDGE_GOVERNANCE_ADDRESS)
        expect(action.data.slice(0, 10)).to.equal(expectedSelectors[index])
        expect(action).to.have.property("description")
        expect(action).to.have.property("value")
      })
    })

    it("should stage the ruled term entries, 365 days first", () => {
      const staged = summary.governanceActions
        .slice(BOOTSTRAP_METHODS.length)
        .filter((_: any, index: number) => index % 2 === 0)
        .map((action: any) => {
          const [termId, termSeconds, custodyBps, enabled] =
            bridgeGovInterface.decodeFunctionData(
              "beginReservationTermUpdate",
              action.data
            )
          return { termId, termSeconds, custodyBps, enabled }
        })

      expect(staged).to.deep.equal([
        { termId: 1, termSeconds: 365 * DAY, custodyBps: 20, enabled: true },
        { termId: 2, termSeconds: 30 * DAY, custodyBps: 2, enabled: true },
        { termId: 3, termSeconds: 91 * DAY, custodyBps: 5, enabled: true },
      ])
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
  })
})
