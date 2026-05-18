/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { expect } from "chai"
import { ethers } from "hardhat"
import fs from "fs"
import func from "../../deploy/86_deploy_tip109_hotfix"
import { KNOWN_PROXY_ADMIN } from "../../deploy/85_deploy_tip109_governance_upgrade"

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

  let originalMkdir: typeof fs.promises.mkdir
  let originalWriteFile: typeof fs.promises.writeFile
  let originalConsoleLog: typeof console.log
  let originalFraudScanFromBlock: string | undefined
  let capturedSummary: any

  beforeEach(() => {
    originalMkdir = fs.promises.mkdir
    originalWriteFile = fs.promises.writeFile
    originalConsoleLog = console.log
    originalFraudScanFromBlock = process.env.BRIDGE_FRAUD_EVENT_FROM_BLOCK
    capturedSummary = undefined
    const mutablePromises = fs.promises as any
    mutablePromises.mkdir = async () => undefined
    mutablePromises.writeFile = async (_file: string, content: string) => {
      capturedSummary = JSON.parse(content)
    }
    console.log = () => undefined
    delete process.env.BRIDGE_FRAUD_EVENT_FROM_BLOCK
  })

  afterEach(() => {
    const mutablePromises = fs.promises as any
    mutablePromises.mkdir = originalMkdir
    mutablePromises.writeFile = originalWriteFile
    console.log = originalConsoleLog

    if (originalFraudScanFromBlock === undefined) {
      delete process.env.BRIDGE_FRAUD_EVENT_FROM_BLOCK
    } else {
      process.env.BRIDGE_FRAUD_EVENT_FROM_BLOCK = originalFraudScanFromBlock
    }
  })

  function createMockHre(): {
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
      BridgeTIP109HotfixImplementation: BRIDGE_IMPL_ADDRESS,
      RebateStakingTIP109HotfixImplementation: REBATE_IMPL_ADDRESS,
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
    }

    const paddedAdmin = `0x${"0".repeat(24)}${KNOWN_PROXY_ADMIN.slice(
      2
    ).toLowerCase()}`

    const mockHre: any = {
      ethers: {
        ...ethers,
        provider: {
          getBlockNumber: async () => 100,
          getLogs: async () => [],
          getStorageAt: async () => paddedAdmin,
          getTransaction: async () => {
            throw new Error("No transaction lookup expected for empty log scan")
          },
        },
        utils: ethers.utils,
      },
      deployments: {
        deploy: async (name: string, options: any) => {
          deployCalls.push({ name, options })
          const address = deployAddressMap[name]
          if (!address) {
            throw new Error(`No deployment mock for: ${name}`)
          }
          return { address, newlyDeployed: true }
        },
        get: async (name: string) => {
          getCalls.push({ name })
          const address = getAddressMap[name]
          if (!address) {
            throw new Error(`No existing deployment mock for: ${name}`)
          }
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
      },
      getNamedAccounts: async () => ({ deployer: DEPLOYER_ADDRESS }),
      getChainId: async () => "31337",
      network: { name: "hardhat", tags: {} },
    }

    return { mockHre, deployCalls, getCalls, saveCalls }
  }

  async function runScript(): Promise<{
    deployCalls: DeployCall[]
    getCalls: GetCall[]
    saveCalls: SaveCall[]
  }> {
    const { mockHre, deployCalls, getCalls, saveCalls } = createMockHre()
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
      if (originalDeployFlag === undefined) {
        delete process.env.DEPLOY_TIP109_HOTFIX
      } else {
        process.env.DEPLOY_TIP109_HOTFIX = originalDeployFlag
      }
    })

    it("skips unless DEPLOY_TIP109_HOTFIX is true", async () => {
      expect(await func.skip!({} as any)).to.equal(true)

      process.env.DEPLOY_TIP109_HOTFIX = "false"
      expect(await func.skip!({} as any)).to.equal(true)

      process.env.DEPLOY_TIP109_HOTFIX = "true"
      expect(await func.skip!({} as any)).to.equal(false)
    })
  })

  it("deploys fresh copies of every modified linked Bridge library", async () => {
    const { deployCalls, getCalls } = await runScript()
    const deployNames = deployCalls.map((call) => call.name)

    expect(deployNames).to.include("DepositTIP109Hotfix")
    expect(deployNames).to.include("DepositSweepTIP109Hotfix")
    expect(deployNames).to.include("RedemptionTIP109Hotfix")
    expect(deployNames).to.include("FraudTIP109Hotfix")

    const expectedLibraryDeployments = [
      ["DepositTIP109Hotfix", "Deposit"],
      ["DepositSweepTIP109Hotfix", "DepositSweep"],
      ["RedemptionTIP109Hotfix", "Redemption"],
      ["FraudTIP109Hotfix", "Fraud"],
    ]

    expectedLibraryDeployments.forEach(([name, contract]) => {
      const deployCall = deployCalls.find((call) => call.name === name)
      expect(deployCall).to.not.equal(undefined)
      expect(deployCall!.options.contract).to.equal(contract)
      expect(deployCall!.options.skipIfAlreadyDeployed).to.equal(false)
    })

    const getNames = getCalls.map((call) => call.name)
    expect(getNames).to.not.include("Deposit")
    expect(getNames).to.not.include("DepositSweep")
    expect(getNames).to.not.include("Fraud")
  })

  it("links the Bridge implementation to the freshly deployed Fraud library", async () => {
    const { deployCalls } = await runScript()

    const bridgeCall = deployCalls.find(
      (call) => call.name === "BridgeTIP109HotfixImplementation"
    )
    expect(bridgeCall).to.not.equal(undefined)

    const { libraries } = bridgeCall!.options
    expect(libraries.Fraud).to.equal(FRAUD_HOTFIX_ADDRESS)
    expect(libraries.Fraud).to.not.equal(LEGACY_FRAUD_ADDRESS)
    expect(libraries.Deposit).to.equal(DEPOSIT_HOTFIX_ADDRESS)
    expect(libraries.Deposit).to.not.equal(LEGACY_DEPOSIT_ADDRESS)
    expect(libraries.DepositSweep).to.equal(DEPOSIT_SWEEP_HOTFIX_ADDRESS)
    expect(libraries.DepositSweep).to.not.equal(LEGACY_DEPOSIT_SWEEP_ADDRESS)
    expect(libraries.Redemption).to.equal(REDEMPTION_HOTFIX_ADDRESS)
    expect(libraries.Wallets).to.equal(WALLETS_ADDRESS)
    expect(libraries.MovingFunds).to.equal(MOVING_FUNDS_ADDRESS)
  })

  it("records fresh library addresses in the deployment summary", async () => {
    await runScript()

    expect(capturedSummary).to.not.equal(undefined)
    expect(capturedSummary.deployedContracts.DepositTIP109Hotfix).to.equal(
      DEPOSIT_HOTFIX_ADDRESS
    )
    expect(capturedSummary.deployedContracts.DepositSweepTIP109Hotfix).to.equal(
      DEPOSIT_SWEEP_HOTFIX_ADDRESS
    )
    expect(capturedSummary.deployedContracts.FraudTIP109Hotfix).to.equal(
      FRAUD_HOTFIX_ADDRESS
    )
    expect(capturedSummary.reusedContracts).to.not.have.property("Fraud")
    expect(capturedSummary.reusedContracts).to.not.have.property("Deposit")
    expect(capturedSummary.reusedContracts).to.not.have.property("DepositSweep")
    expect(capturedSummary.libraries.Fraud).to.equal(FRAUD_HOTFIX_ADDRESS)
  })
})
