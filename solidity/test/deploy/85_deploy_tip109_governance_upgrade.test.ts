/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import hre, { ethers, deployments } from "hardhat"
import fs from "fs"
import path from "path"
import func, {
  encodeRebateStakingUpgrade,
  encodeBridgeUpgradeAndCall,
  encodeSetRebateStaking,
  encodeBeginDepositTreasuryFeeDivisorUpdate,
  KNOWN_PROXY_ADMIN,
  KNOWN_T_TOKEN,
} from "../../deploy/85_deploy_tip109_governance_upgrade"

describe("Deploy Script 85: TIP-109 Governance Upgrade", () => {
  // Shared test addresses used across multiple describe blocks.
  // Deployment artifacts produced by deploy() calls.
  const DEPLOYER_ADDRESS = "0x1234567890123456789012345678901234567890"
  const DEPOSIT_ADDRESS = "0x0000000000000000000000000000000000000001"
  const REDEMPTION_ADDRESS = "0x0000000000000000000000000000000000000002"
  const DEPOSIT_SWEEP_ADDRESS = "0x0000000000000000000000000000000000000003"
  const WALLETS_ADDRESS = "0x0000000000000000000000000000000000000004"
  const FRAUD_ADDRESS = "0x0000000000000000000000000000000000000005"
  const MOVING_FUNDS_ADDRESS = "0x0000000000000000000000000000000000000006"
  const BRIDGE_IMPL_ADDRESS = "0x0000000000000000000000000000000000000007"
  const REBATE_IMPL_ADDRESS = "0x0000000000000000000000000000000000000008"
  const BRIDGE_PROXY_ADDRESS = "0x5e4861a80B55f035D899f66772117F00FA0E8e7B"
  const REBATE_STAKING_PROXY_ADDRESS =
    "0x0184739c02d51bFc1cc2E3a2bF6bbBe31e265a45"
  const BRIDGE_GOV_ADDRESS = "0xCBcFa30000000000000000000000000000000009"

  // Address maps shared by all mock HRE instances.
  const deployAddressMap: Record<string, string> = {
    Deposit: DEPOSIT_ADDRESS,
    Redemption: REDEMPTION_ADDRESS,
    BridgeTIP109Implementation: BRIDGE_IMPL_ADDRESS,
    RebateStakingTIP109Implementation: REBATE_IMPL_ADDRESS,
  }

  const getAddressMap: Record<string, string> = {
    DepositSweep: DEPOSIT_SWEEP_ADDRESS,
    Wallets: WALLETS_ADDRESS,
    Fraud: FRAUD_ADDRESS,
    MovingFunds: MOVING_FUNDS_ADDRESS,
    Bridge: BRIDGE_PROXY_ADDRESS,
    RebateStaking: REBATE_STAKING_PROXY_ADDRESS,
    BridgeGovernance: BRIDGE_GOV_ADDRESS,
  }

  // Manual mock tracking interfaces (sinon not available in project).
  interface DeployCall {
    name: string
    options: any
  }

  interface GetCall {
    name: string
  }

  interface EtherscanVerifyCall {
    artifact: any
  }

  interface RunCall {
    taskName: string
    options: any
  }

  /**
   * Creates a mock HRE with deploy/get/etherscan-verify/run tracking
   * arrays. Callers receive both the mock object and all tracking arrays
   * for assertion. Supports optional network tags and configurable
   * hre.run behavior (resolve or reject) for verification tests.
   */
  function createMockHre(options?: {
    networkTags?: Record<string, boolean>
    runBehavior?: "resolve" | "reject"
  }): {
    mockHre: any
    deployCalls: DeployCall[]
    getCalls: GetCall[]
    etherscanVerifyCalls: EtherscanVerifyCall[]
    runCalls: RunCall[]
  } {
    const deployCalls: DeployCall[] = []
    const getCalls: GetCall[] = []
    const etherscanVerifyCalls: EtherscanVerifyCall[] = []
    const runCalls: RunCall[] = []

    // Pad the known ProxyAdmin address into EIP-1967 storage slot format
    const paddedAdmin = `0x${"0".repeat(24)}${KNOWN_PROXY_ADMIN.slice(
      2
    ).toLowerCase()}`

    const mockHre: any = {
      ethers: {
        ...ethers,
        provider: {
          getStorageAt: async () => paddedAdmin,
        },
        utils: ethers.utils,
        constants: ethers.constants,
      },
      deployments: {
        deploy: async (name: string, opts: any) => {
          deployCalls.push({ name, options: opts })
          const address = deployAddressMap[name] || ethers.constants.AddressZero
          return { address, newlyDeployed: true }
        },
        get: async (name: string) => {
          getCalls.push({ name })
          const address = getAddressMap[name]
          if (!address) {
            throw new Error(`No deployment found for: ${name}`)
          }
          return { address }
        },
      },
      getNamedAccounts: async () => ({ deployer: DEPLOYER_ADDRESS }),
      getChainId: async () => "31337",
      network: { name: "hardhat", tags: options?.networkTags || {} },
      helpers: {
        etherscan: {
          verify: async (artifact: any) => {
            etherscanVerifyCalls.push({ artifact })
          },
        },
      },
      run: async (taskName: string, taskOptions: any) => {
        runCalls.push({ taskName, options: taskOptions })
        if (options?.runBehavior === "reject") {
          throw new Error("Etherscan verification failed: mock error")
        }
      },
    }

    return { mockHre, deployCalls, getCalls, etherscanVerifyCalls, runCalls }
  }

  describe("skip guard", () => {
    let originalEnv: string | undefined

    beforeEach(() => {
      originalEnv = process.env.DEPLOY_TIP109
      delete process.env.DEPLOY_TIP109
    })

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.DEPLOY_TIP109
      } else {
        process.env.DEPLOY_TIP109 = originalEnv
      }
    })

    it("should skip when DEPLOY_TIP109 is not set", async () => {
      const result = await func.skip!({} as any)
      expect(result).to.be.true
    })

    it("should skip when DEPLOY_TIP109 is set to something other than true", async () => {
      process.env.DEPLOY_TIP109 = "false"
      const result = await func.skip!({} as any)
      expect(result).to.be.true

      process.env.DEPLOY_TIP109 = "yes"
      const result2 = await func.skip!({} as any)
      expect(result2).to.be.true

      process.env.DEPLOY_TIP109 = "1"
      const result3 = await func.skip!({} as any)
      expect(result3).to.be.true
    })

    it("should not skip when DEPLOY_TIP109 is set to true", async () => {
      process.env.DEPLOY_TIP109 = "true"
      const result = await func.skip!({} as any)
      expect(result).to.be.false
    })
  })

  describe("tags", () => {
    it("should have correct tag", () => {
      expect(func.tags).to.include("DeployTIP109GovernanceUpgrade")
    })
  })

  describe("contract deployment phase", () => {
    let deployCalls: DeployCall[]
    let getCalls: GetCall[]
    let mockHre: any

    beforeEach(() => {
      const mock = createMockHre()
      deployCalls = mock.deployCalls
      getCalls = mock.getCalls
      mockHre = mock.mockHre
    })

    describe("unit: deployment calls", () => {
      it("should deploy Deposit library with correct options", async () => {
        await func(mockHre)

        const depositCall = deployCalls.find((c) => c.name === "Deposit")
        expect(depositCall).to.not.be.undefined
        expect(depositCall!.options.from).to.equal(DEPLOYER_ADDRESS)
        expect(depositCall!.options.log).to.be.true
        expect(depositCall!.options.waitConfirmations).to.equal(1)
      })

      it("should deploy Redemption library with correct options", async () => {
        await func(mockHre)

        const redemptionCall = deployCalls.find((c) => c.name === "Redemption")
        expect(redemptionCall).to.not.be.undefined
        expect(redemptionCall!.options.from).to.equal(DEPLOYER_ADDRESS)
        expect(redemptionCall!.options.log).to.be.true
        expect(redemptionCall!.options.waitConfirmations).to.equal(1)
      })

      it("should resolve existing libraries via deployments.get()", async () => {
        await func(mockHre)

        const expectedLibraries = [
          "DepositSweep",
          "Wallets",
          "Fraud",
          "MovingFunds",
        ]
        const getNames = getCalls.map((c) => c.name)

        expectedLibraries.forEach((lib) => {
          expect(getNames).to.include(
            lib,
            `Expected deployments.get() to be called with "${lib}"`
          )
        })
      })

      it("should deploy Bridge implementation with distinct artifact name", async () => {
        await func(mockHre)

        const bridgeCall = deployCalls.find(
          (c) => c.name === "BridgeTIP109Implementation"
        )
        expect(bridgeCall).to.not.be.undefined
        expect(bridgeCall!.options.contract).to.equal("Bridge")
        expect(bridgeCall!.options.skipIfAlreadyDeployed).to.equal(false)

        // Verify it does NOT use the name "Bridge" (avoid proxy artifact overwrite)
        const directBridgeCall = deployCalls.find(
          (c) => c.name === "Bridge" && c.options?.contract === undefined
        )
        expect(directBridgeCall).to.be.undefined
      })

      it("should define all 6 required libraries for Bridge implementation deployment", async () => {
        await func(mockHre)

        const bridgeCall = deployCalls.find(
          (c) => c.name === "BridgeTIP109Implementation"
        )
        expect(bridgeCall).to.not.be.undefined

        const { libraries } = bridgeCall!.options
        expect(libraries).to.not.be.undefined

        const expectedLibKeys = [
          "Deposit",
          "DepositSweep",
          "Redemption",
          "Wallets",
          "Fraud",
          "MovingFunds",
        ]
        const actualKeys = Object.keys(libraries)
        expect(actualKeys).to.have.lengthOf(6)

        expectedLibKeys.forEach((key) => {
          expect(libraries).to.have.property(key)
          expect(libraries[key]).to.not.equal(ethers.constants.AddressZero)
        })

        // Verify correct address mapping (not swapped)
        expect(libraries.Deposit).to.equal(DEPOSIT_ADDRESS)
        expect(libraries.DepositSweep).to.equal(DEPOSIT_SWEEP_ADDRESS)
        expect(libraries.Redemption).to.equal(REDEMPTION_ADDRESS)
        expect(libraries.Wallets).to.equal(WALLETS_ADDRESS)
        expect(libraries.Fraud).to.equal(FRAUD_ADDRESS)
        expect(libraries.MovingFunds).to.equal(MOVING_FUNDS_ADDRESS)
      })

      it("should deploy RebateStaking implementation with distinct artifact name", async () => {
        await func(mockHre)

        const rebateCall = deployCalls.find(
          (c) => c.name === "RebateStakingTIP109Implementation"
        )
        expect(rebateCall).to.not.be.undefined
        expect(rebateCall!.options.contract).to.equal("RebateStaking")
        expect(rebateCall!.options.skipIfAlreadyDeployed).to.equal(false)

        // Verify it does NOT use the name "RebateStaking" (avoid proxy artifact overwrite)
        const directRebateCall = deployCalls.find(
          (c) => c.name === "RebateStaking"
        )
        expect(directRebateCall).to.be.undefined
      })
    })

    describe("integration: deployment on hardhat network", () => {
      let originalEnv: string | undefined

      before(async () => {
        originalEnv = process.env.DEPLOY_TIP109
        process.env.DEPLOY_TIP109 = "true"
        await deployments.fixture()
      })

      after(() => {
        if (originalEnv === undefined) {
          delete process.env.DEPLOY_TIP109
        } else {
          process.env.DEPLOY_TIP109 = originalEnv
        }
      })

      it("should produce valid addresses for all deployed contracts", async () => {
        await func(hre)

        const depositArtifact = await deployments.get("Deposit")
        expect(depositArtifact.address).to.not.equal(
          ethers.constants.AddressZero
        )

        const redemptionArtifact = await deployments.get("Redemption")
        expect(redemptionArtifact.address).to.not.equal(
          ethers.constants.AddressZero
        )

        const bridgeImplArtifact = await deployments.get(
          "BridgeTIP109Implementation"
        )
        expect(bridgeImplArtifact.address).to.not.equal(
          ethers.constants.AddressZero
        )

        const rebateImplArtifact = await deployments.get(
          "RebateStakingTIP109Implementation"
        )
        expect(rebateImplArtifact.address).to.not.equal(
          ethers.constants.AddressZero
        )
      })

      it("should log all deployed addresses to console", async () => {
        const loggedMessages: string[] = []
        const originalLog = console.log
        console.log = (...args: any[]) => {
          loggedMessages.push(args.join(" "))
        }

        try {
          await func(hre)

          const allOutput = loggedMessages.join("\n")

          // Verify that deployed addresses appear in the console output
          const depositArtifact = await deployments.get("Deposit")
          const redemptionArtifact = await deployments.get("Redemption")
          const bridgeImplArtifact = await deployments.get(
            "BridgeTIP109Implementation"
          )
          const rebateImplArtifact = await deployments.get(
            "RebateStakingTIP109Implementation"
          )

          expect(allOutput).to.include(depositArtifact.address)
          expect(allOutput).to.include(redemptionArtifact.address)
          expect(allOutput).to.include(bridgeImplArtifact.address)
          expect(allOutput).to.include(rebateImplArtifact.address)
        } finally {
          console.log = originalLog
        }
      })
    })
  })

  describe("calldata generation", () => {
    // ABI interfaces used for decoding generated calldata
    const proxyAdminABI = [
      "function upgrade(address proxy, address implementation)",
      "function upgradeAndCall(address proxy, address implementation, bytes data)",
    ]
    const bridgeABI = [
      "function initializeV5_RepairRebateStaking(address newRebateStaking)",
    ]
    const bridgeGovABI = [
      "function setRebateStaking(address rebateStaking)",
      "function beginDepositTreasuryFeeDivisorUpdate(uint64 _newDepositTreasuryFeeDivisor)",
    ]

    const proxyAdminIface = new ethers.utils.Interface(proxyAdminABI)
    const bridgeIface = new ethers.utils.Interface(bridgeABI)
    const bridgeGovIface = new ethers.utils.Interface(bridgeGovABI)

    // Calldata-specific test addresses (implementation addresses distinct
    // from deployment phase to test with non-trivial checksummed values).
    const BRIDGE_IMPL = "0xAABbCcddEe00112233445566778899AaBbCCdDeE"
    const REBATE_IMPL = "0x1122334455667788990011223344556677889900"

    describe("RebateStaking upgrade calldata", () => {
      it("should encode upgrade(address,address) with correct proxy and impl", () => {
        const calldata = encodeRebateStakingUpgrade(
          REBATE_STAKING_PROXY_ADDRESS,
          REBATE_IMPL
        )

        // Verify the function selector is upgrade(address,address) = 0x99a88ec4
        expect(calldata.slice(0, 10)).to.equal("0x99a88ec4")

        // Decode and verify parameters
        const decoded = proxyAdminIface.decodeFunctionData("upgrade", calldata)
        expect(decoded.proxy).to.equal(REBATE_STAKING_PROXY_ADDRESS)
        expect(decoded.implementation).to.equal(REBATE_IMPL)
      })
    })

    describe("Bridge upgradeAndCall calldata", () => {
      it("should encode upgradeAndCall(address,address,bytes) with correct params", () => {
        const calldata = encodeBridgeUpgradeAndCall(
          BRIDGE_PROXY_ADDRESS,
          BRIDGE_IMPL
        )

        // Verify the function selector is upgradeAndCall(address,address,bytes) = 0x9623609d
        expect(calldata.slice(0, 10)).to.equal("0x9623609d")

        // Decode outer calldata and verify proxy and impl addresses
        const decoded = proxyAdminIface.decodeFunctionData(
          "upgradeAndCall",
          calldata
        )
        expect(decoded.proxy).to.equal(BRIDGE_PROXY_ADDRESS)
        expect(decoded.implementation).to.equal(BRIDGE_IMPL)
      })

      it("should encode initializeV5_RepairRebateStaking(address(0)) as inner data", () => {
        const calldata = encodeBridgeUpgradeAndCall(
          BRIDGE_PROXY_ADDRESS,
          BRIDGE_IMPL
        )

        // Decode the outer calldata to extract inner bytes
        const decoded = proxyAdminIface.decodeFunctionData(
          "upgradeAndCall",
          calldata
        )
        const innerData: string = decoded.data

        // Decode the inner calldata and verify it targets initializeV5
        const innerDecoded = bridgeIface.decodeFunctionData(
          "initializeV5_RepairRebateStaking",
          innerData
        )

        // The repair target must be address(0) per D-7
        expect(innerDecoded.newRebateStaking).to.equal(
          ethers.constants.AddressZero
        )
      })
    })

    describe("setRebateStaking calldata", () => {
      it("should encode setRebateStaking(address) with rebate staking proxy", () => {
        const calldata = encodeSetRebateStaking(REBATE_STAKING_PROXY_ADDRESS)

        // Decode and verify the function and parameter
        const decoded = bridgeGovIface.decodeFunctionData(
          "setRebateStaking",
          calldata
        )
        expect(decoded.rebateStaking).to.equal(REBATE_STAKING_PROXY_ADDRESS)
      })

      it("should use setRebateStaking selector, not begin/finalize variant", () => {
        const calldata = encodeSetRebateStaking(REBATE_STAKING_PROXY_ADDRESS)

        // The selector must match setRebateStaking(address), which is a
        // direct onlyOwner call on BridgeGovernance
        const expectedSelector = bridgeGovIface.getSighash("setRebateStaking")
        expect(calldata.slice(0, 10)).to.equal(expectedSelector)
      })
    })

    describe("beginDepositTreasuryFeeDivisorUpdate calldata", () => {
      it("should encode beginDepositTreasuryFeeDivisorUpdate(uint64) with 500", () => {
        const calldata = encodeBeginDepositTreasuryFeeDivisorUpdate(500)

        // Decode and verify the function and parameter
        const decoded = bridgeGovIface.decodeFunctionData(
          "beginDepositTreasuryFeeDivisorUpdate",
          calldata
        )
        expect(decoded._newDepositTreasuryFeeDivisor).to.equal(500)
      })
    })

    describe("execution order", () => {
      it("should place RebateStaking upgrade FIRST and Bridge upgradeAndCall SECOND in timelock actions", async () => {
        const { mockHre } = createMockHre()

        const loggedMessages: string[] = []
        const originalLog = console.log

        // Capture console.log output to verify ordering
        console.log = (...args: any[]) => {
          loggedMessages.push(args.join(" "))
        }

        try {
          await func(mockHre)
        } finally {
          console.log = originalLog
        }

        const allOutput = loggedMessages.join("\n")

        // The RebateStaking upgrade calldata (0x99a88ec4) must appear before
        // the Bridge upgradeAndCall calldata (0x9623609d) in the output
        const rebateUpgradeIndex = allOutput.indexOf("0x99a88ec4")
        const bridgeUpgradeIndex = allOutput.indexOf("0x9623609d")

        expect(rebateUpgradeIndex).to.be.greaterThan(
          -1,
          "RebateStaking upgrade calldata should be logged"
        )
        expect(bridgeUpgradeIndex).to.be.greaterThan(
          -1,
          "Bridge upgradeAndCall calldata should be logged"
        )
        expect(rebateUpgradeIndex).to.be.lessThan(
          bridgeUpgradeIndex,
          "RebateStaking upgrade must appear BEFORE Bridge upgradeAndCall"
        )
      })
    })
  })

  describe("etherscan verification", () => {
    it("should skip verification when network.tags.etherscan is not set", async () => {
      const { mockHre, etherscanVerifyCalls, runCalls } = createMockHre({
        networkTags: {},
      })

      await func(mockHre)

      expect(etherscanVerifyCalls).to.have.lengthOf(
        0,
        "helpers.etherscan.verify should not be called when etherscan tag is absent"
      )
      expect(
        runCalls.filter((c) => c.taskName === "verify:verify")
      ).to.have.lengthOf(
        0,
        "hre.run('verify:verify') should not be called when etherscan tag is absent"
      )
    })

    it("should call verification for all 4 contracts when network.tags.etherscan is set", async () => {
      const { mockHre, etherscanVerifyCalls, runCalls } = createMockHre({
        networkTags: { etherscan: true },
      })

      await func(mockHre)

      // Deposit, Redemption, and RebateStaking should be verified via
      // helpers.etherscan.verify
      expect(etherscanVerifyCalls).to.have.lengthOf(
        3,
        "helpers.etherscan.verify should be called 3 times (Deposit, Redemption, RebateStaking)"
      )

      // Verify that the correct deployment artifacts were passed
      const verifiedAddresses = etherscanVerifyCalls.map(
        (c) => c.artifact.address
      )
      expect(verifiedAddresses).to.include(DEPOSIT_ADDRESS)
      expect(verifiedAddresses).to.include(REDEMPTION_ADDRESS)
      expect(verifiedAddresses).to.include(REBATE_IMPL_ADDRESS)

      // Bridge should be verified via hre.run("verify:verify") with libraries
      const verifyRunCalls = runCalls.filter(
        (c) => c.taskName === "verify:verify"
      )
      expect(verifyRunCalls).to.have.lengthOf(
        1,
        "hre.run('verify:verify') should be called once for Bridge"
      )

      const bridgeVerifyOptions = verifyRunCalls[0].options
      expect(bridgeVerifyOptions.address).to.equal(BRIDGE_IMPL_ADDRESS)
      expect(bridgeVerifyOptions.constructorArguments).to.deep.equal([])

      // All 6 libraries must be included in the verification options
      const libs = bridgeVerifyOptions.libraries
      expect(Object.keys(libs)).to.have.lengthOf(6)
      expect(libs.Deposit).to.equal(DEPOSIT_ADDRESS)
      expect(libs.DepositSweep).to.equal(DEPOSIT_SWEEP_ADDRESS)
      expect(libs.Redemption).to.equal(REDEMPTION_ADDRESS)
      expect(libs.Wallets).to.equal(WALLETS_ADDRESS)
      expect(libs.Fraud).to.equal(FRAUD_ADDRESS)
      expect(libs.MovingFunds).to.equal(MOVING_FUNDS_ADDRESS)
    })

    it("should handle Bridge verification failure gracefully without crashing", async () => {
      const { mockHre } = createMockHre({
        networkTags: { etherscan: true },
        runBehavior: "reject",
      })

      // The deploy function should complete without throwing even when
      // hre.run("verify:verify") rejects
      await func(mockHre)
    })
  })

  describe("deployment summary JSON", () => {
    // Directory where the deploy script writes JSON summaries.
    // The deploy script uses path.join(__dirname, "..", "deployments", network)
    // where __dirname is the deploy/ directory.
    const deploymentsDir = path.join(
      __dirname,
      "..",
      "..",
      "deployments",
      "hardhat"
    )

    // Collect JSON files created during each test for cleanup.
    function findSummaryFiles(): string[] {
      if (!fs.existsSync(deploymentsDir)) return []
      return fs
        .readdirSync(deploymentsDir)
        .filter(
          (f) => f.startsWith("tip109-deployment-") && f.endsWith(".json")
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let summary: any
    let summaryFiles: string[]

    beforeEach(async () => {
      cleanupSummaryFiles()

      const { mockHre } = createMockHre()
      await func(mockHre)

      summaryFiles = findSummaryFiles()
      if (summaryFiles.length > 0) {
        const content = fs.readFileSync(summaryFiles[0], "utf-8")
        summary = JSON.parse(content)
      } else {
        summary = null
      }
    })

    afterEach(() => {
      cleanupSummaryFiles()
    })

    it("should write a JSON summary file to the deployments directory", () => {
      expect(summaryFiles.length).to.be.greaterThan(
        0,
        "Expected at least one tip109-deployment-*.json file to be written"
      )
    })

    it("should have all required top-level keys", () => {
      expect(summary).to.not.be.null

      const requiredKeys = [
        "network",
        "timestamp",
        "deployer",
        "chainId",
        "deployedContracts",
        "existingContracts",
        "timelockActions",
        "councilSafeActions",
        "governanceActions",
        "libraries",
        "verificationChecks",
      ]

      requiredKeys.forEach((key) => {
        expect(
          summary,
          `Missing required top-level key: ${key}`
        ).to.have.property(key)
      })
    })

    it("should have correct metadata fields", () => {
      expect(summary).to.not.be.null
      expect(summary.network).to.equal("hardhat")
      expect(summary.deployer).to.equal(DEPLOYER_ADDRESS)
      expect(summary.chainId).to.equal("31337")
      expect(summary.timestamp).to.be.a("string")
    })

    it("should have timelockActions with RebateStaking first and Bridge second", () => {
      expect(summary).to.not.be.null
      expect(summary.timelockActions).to.be.an("array")
      expect(summary.timelockActions).to.have.lengthOf(2)

      // Index 0 must be RebateStaking upgrade
      expect(summary.timelockActions[0].description).to.include("RebateStaking")
      // Selector for upgrade(address,address) = 0x99a88ec4
      expect(summary.timelockActions[0].data.slice(0, 10)).to.equal(
        "0x99a88ec4"
      )

      // Index 1 must be Bridge upgradeAndCall
      expect(summary.timelockActions[1].description).to.include("Bridge")
      // Selector for upgradeAndCall(address,address,bytes) = 0x9623609d
      expect(summary.timelockActions[1].data.slice(0, 10)).to.equal(
        "0x9623609d"
      )
    })

    it("should have each timelockAction with required fields", () => {
      expect(summary).to.not.be.null
      expect(summary.timelockActions).to.be.an("array")

      summary.timelockActions.forEach(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (action: any, index: number) => {
          expect(
            action,
            `timelockActions[${index}] missing target`
          ).to.have.property("target")
          expect(
            action,
            `timelockActions[${index}] missing data`
          ).to.have.property("data")
          expect(action).to.have.property("value")
          expect(
            action,
            `timelockActions[${index}] missing description`
          ).to.have.property("description")
        }
      )
    })

    it("should have deployedContracts with all 4 entries", () => {
      expect(summary).to.not.be.null
      const dc = summary.deployedContracts

      const requiredKeys = [
        "Deposit",
        "Redemption",
        "BridgeTIP109Implementation",
        "RebateStakingTIP109Implementation",
      ]

      requiredKeys.forEach((key) => {
        expect(dc).to.have.property(key)
        expect(dc[key]).to.not.equal(ethers.constants.AddressZero)
      })
    })

    it("should have existingContracts with all required entries", () => {
      expect(summary).to.not.be.null
      const ec = summary.existingContracts

      const requiredKeys = [
        "Bridge",
        "ProxyAdmin",
        "Timelock",
        "CouncilSafe",
        "BridgeGovernance",
        "RebateStaking",
        "TToken",
      ]

      requiredKeys.forEach((key) => {
        expect(ec, `Missing existingContracts key: ${key}`).to.have.property(
          key
        )
      })
    })

    it("should have libraries with all 6 entries", () => {
      expect(summary).to.not.be.null
      const libs = summary.libraries

      expect(Object.keys(libs)).to.have.lengthOf(6)

      const requiredKeys = [
        "Deposit",
        "DepositSweep",
        "Redemption",
        "Wallets",
        "Fraud",
        "MovingFunds",
      ]

      requiredKeys.forEach((key) => {
        expect(libs).to.have.property(key)
      })
    })

    it("should have councilSafeActions with setRebateStaking entry", () => {
      expect(summary).to.not.be.null
      expect(summary.councilSafeActions).to.be.an("array")
      expect(summary.councilSafeActions.length).to.be.greaterThan(0)

      const setRebateAction = summary.councilSafeActions.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) =>
          a.description &&
          a.description.toLowerCase().includes("setrebatestaking")
      )
      expect(setRebateAction).to.not.be.undefined
      expect(setRebateAction).to.have.property("to")
      expect(setRebateAction).to.have.property("data")
      expect(setRebateAction).to.have.property("value")
      expect(setRebateAction).to.have.property("description")
    })

    it("should have governanceActions with beginDepositTreasuryFeeDivisorUpdate entry", () => {
      expect(summary).to.not.be.null
      expect(summary.governanceActions).to.be.an("array")
      expect(summary.governanceActions.length).to.be.greaterThan(0)

      const feeAction = summary.governanceActions.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any) =>
          a.description &&
          a.description
            .toLowerCase()
            .includes("begindeposittreasuryfeedivisorupdate")
      )
      expect(feeAction).to.not.be.undefined
      expect(feeAction).to.have.property("to")
      expect(feeAction).to.have.property("data")
      expect(feeAction).to.have.property("value")
      expect(feeAction).to.have.property("description")
    })

    describe("verificationChecks", () => {
      it("should be an array with exactly 7 entries", () => {
        expect(summary).to.not.be.null
        expect(summary.verificationChecks).to.be.an("array")
        expect(summary.verificationChecks).to.have.lengthOf(7)
      })

      it("should have command, expectedResult, and description fields on each entry", () => {
        expect(summary).to.not.be.null
        expect(summary.verificationChecks).to.be.an("array")

        summary.verificationChecks.forEach(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (entry: any, index: number) => {
            expect(
              entry,
              `verificationChecks[${index}] missing command`
            ).to.have.property("command")
            expect(
              entry,
              `verificationChecks[${index}] missing expectedResult`
            ).to.have.property("expectedResult")
            expect(
              entry,
              `verificationChecks[${index}] missing description`
            ).to.have.property("description")

            expect(entry.command).to.be.a("string").and.not.be.empty
            expect(entry.expectedResult).to.be.a("string").and.not.be.empty
            expect(entry.description).to.be.a("string").and.not.be.empty
          }
        )
      })

      it("should have check[0] reference getRebateStaking with address(0) expected", () => {
        expect(summary).to.not.be.null
        const check = summary.verificationChecks[0]
        expect(check.command).to.include("getRebateStaking")
        expect(check.expectedResult).to.match(/address\(0\)|0x0{40}/i)
      })

      it("should have a storage layout check referencing slots 79, 80, and gap 81-128", () => {
        expect(summary).to.not.be.null

        const storageCheck = summary.verificationChecks.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) =>
            c.description.toLowerCase().includes("storage") ||
            c.description.toLowerCase().includes("slot")
        )
        expect(
          storageCheck,
          "Expected a verification check referencing storage layout"
        ).to.not.be.undefined

        // Slot numbers must appear in command or expectedResult
        const combined = `${storageCheck.command} ${storageCheck.expectedResult} ${storageCheck.description}`
        expect(combined).to.include("79")
        expect(combined).to.include("80")
        expect(combined).to.match(/81|__gap|gap/)
      })

      it("should have a RebateStaking state preservation check with documented constants", () => {
        expect(summary).to.not.be.null

        const stateCheck = summary.verificationChecks.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) =>
            c.description.toLowerCase().includes("state") ||
            c.description.toLowerCase().includes("rebatestaking")
        )
        expect(
          stateCheck,
          "Expected a verification check for RebateStaking state preservation"
        ).to.not.be.undefined

        const combined = `${stateCheck.command} ${stateCheck.expectedResult} ${stateCheck.description}`
        // rebatePerToken = 1e18 = 1000000000000000000
        expect(combined).to.match(/1000000000000000000|1e18/)
        // rollingWindow and unstakingPeriod = 2592000
        expect(combined).to.include("2592000")
        // T token address
        expect(combined.toLowerCase()).to.include(KNOWN_T_TOKEN.toLowerCase())
      })

      it("should have a selector count check expecting 56", () => {
        expect(summary).to.not.be.null

        const selectorCheck = summary.verificationChecks.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => c.description.toLowerCase().includes("selector")
        )
        expect(
          selectorCheck,
          "Expected a verification check for selector count"
        ).to.not.be.undefined

        const combined = `${selectorCheck.command} ${selectorCheck.expectedResult}`
        expect(combined).to.include("56")
      })

      it("should have a bytecode linkage check referencing Deposit and Redemption addresses", () => {
        expect(summary).to.not.be.null

        const bytecodeCheck = summary.verificationChecks.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => c.description.toLowerCase().includes("bytecode")
        )
        expect(
          bytecodeCheck,
          "Expected a verification check for bytecode linkage"
        ).to.not.be.undefined

        const combined = `${bytecodeCheck.command} ${bytecodeCheck.expectedResult}`
        // The check should reference the deployed Deposit and Redemption
        // library addresses (from deployAddressMap in mock)
        expect(combined.toLowerCase()).to.include(
          DEPOSIT_ADDRESS.toLowerCase().slice(2)
        )
        expect(combined.toLowerCase()).to.include(
          REDEMPTION_ADDRESS.toLowerCase().slice(2)
        )
      })
    })
  })

  describe("deployment summary console output", () => {
    it("should print verification commands to console", async () => {
      const { mockHre } = createMockHre()

      const loggedMessages: string[] = []
      const originalLog = console.log

      console.log = (...args: any[]) => {
        loggedMessages.push(args.join(" "))
      }

      try {
        await func(mockHre)
      } finally {
        console.log = originalLog
      }

      const allOutput = loggedMessages.join("\n")

      // Console output should include a verification section with cast commands
      expect(allOutput.toLowerCase()).to.include(
        "verification",
        "Console output should include a verification section"
      )
      expect(allOutput).to.include(
        "cast",
        "Console output should include cast commands"
      )
    })

    it("should print a human-readable action summary with decoded parameters", async () => {
      const { mockHre } = createMockHre()

      const loggedMessages: string[] = []
      const originalLog = console.log

      console.log = (...args: any[]) => {
        loggedMessages.push(args.join(" "))
      }

      try {
        await func(mockHre)
      } finally {
        console.log = originalLog
      }

      const allOutput = loggedMessages.join("\n")

      // The human-readable summary should include key deployment info
      expect(allOutput).to.include(
        "hardhat",
        "Console output should include the network name"
      )
      expect(allOutput).to.include(
        DEPLOYER_ADDRESS,
        "Console output should include the deployer address"
      )

      // Should include summary file path reference
      expect(allOutput).to.include(
        "tip109-deployment-",
        "Console output should reference the saved JSON file"
      )
    })
  })
})
