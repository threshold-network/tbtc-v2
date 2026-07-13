/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import func from "../../deploy/84_upgrade_bridge_c2_1_counter"

describe("Deploy Script 84: Bridge C-2.1a Counter Upgrade", () => {
  const DEPLOYER_ADDRESS = "0x1000000000000000000000000000000000000001"
  const TREASURY_ADDRESS = "0x1000000000000000000000000000000000000002"
  const BANK_ADDRESS = "0x2000000000000000000000000000000000000001"
  const LIGHT_RELAY_ADDRESS = "0x2000000000000000000000000000000000000002"
  const WALLET_REGISTRY_ADDRESS = "0x2000000000000000000000000000000000000003"
  const REIMBURSEMENT_POOL_ADDRESS =
    "0x2000000000000000000000000000000000000004"
  const DEPOSIT_ADDRESS = "0x3000000000000000000000000000000000000001"
  const DEPOSIT_SWEEP_ADDRESS = "0x3000000000000000000000000000000000000002"
  const REDEMPTION_ADDRESS = "0x3000000000000000000000000000000000000003"
  const MOVING_FUNDS_ADDRESS = "0x3000000000000000000000000000000000000004"
  const WALLETS_ADDRESS = "0x4000000000000000000000000000000000000001"
  const FRAUD_ADDRESS = "0x4000000000000000000000000000000000000002"
  const BRIDGE_ADDRESS = "0x5000000000000000000000000000000000000001"
  const PROXY_ADDRESS = "0x5000000000000000000000000000000000000002"

  const existingDeployments: Record<string, string> = {
    Bank: BANK_ADDRESS,
    LightRelay: LIGHT_RELAY_ADDRESS,
    WalletRegistry: WALLET_REGISTRY_ADDRESS,
    ReimbursementPool: REIMBURSEMENT_POOL_ADDRESS,
    Deposit: DEPOSIT_ADDRESS,
    DepositSweep: DEPOSIT_SWEEP_ADDRESS,
    Redemption: REDEMPTION_ADDRESS,
    MovingFunds: MOVING_FUNDS_ADDRESS,
  }

  const newLibraries: Record<string, string> = {
    Wallets: WALLETS_ADDRESS,
    Fraud: FRAUD_ADDRESS,
  }

  interface DeployCall {
    name: string
    options: any
  }

  function createMockHre(networkTags: Record<string, boolean> = {}) {
    const getCalls: string[] = []
    const deployCalls: DeployCall[] = []
    const upgradeProxyCalls: any[][] = []
    const etherscanVerifyCalls: any[] = []
    const tenderlyVerifyCalls: any[] = []
    const runCalls: Array<{ taskName: string; options: any }> = []

    const mockHre: any = {
      ethers: {
        getSigner: async (address: string) => {
          expect(address).to.equal(DEPLOYER_ADDRESS)
          return { address }
        },
      },
      deployments: {
        get: async (name: string) => {
          getCalls.push(name)
          const address = existingDeployments[name]
          if (!address) {
            throw new Error(`Unexpected deployment lookup: ${name}`)
          }
          return { address }
        },
        deploy: async (name: string, options: any) => {
          deployCalls.push({ name, options })
          const address = newLibraries[name]
          if (!address) {
            throw new Error(`Unexpected deployment: ${name}`)
          }
          return { address, newlyDeployed: true }
        },
      },
      getNamedAccounts: async () => ({
        deployer: DEPLOYER_ADDRESS,
        treasury: TREASURY_ADDRESS,
      }),
      helpers: {
        upgrades: {
          upgradeProxy: async (...args: any[]) => {
            upgradeProxyCalls.push(args)
            return [
              { address: BRIDGE_ADDRESS },
              { address: PROXY_ADDRESS, args: [] },
            ]
          },
        },
        etherscan: {
          verify: async (deployment: any) => {
            etherscanVerifyCalls.push(deployment)
          },
        },
      },
      network: { tags: networkTags },
      tenderly: {
        verify: async (deployment: any) => {
          tenderlyVerifyCalls.push(deployment)
        },
      },
      run: async (taskName: string, options: any) => {
        runCalls.push({ taskName, options })
      },
    }

    return {
      mockHre,
      getCalls,
      deployCalls,
      upgradeProxyCalls,
      etherscanVerifyCalls,
      tenderlyVerifyCalls,
      runCalls,
    }
  }

  it("reuses unchanged libraries and deploys and links current Wallets and Fraud", async () => {
    const { mockHre, getCalls, deployCalls, upgradeProxyCalls } =
      createMockHre()
    const logCalls: string[] = []
    const originalLog = console.log
    console.log = (message?: any) => logCalls.push(String(message))

    try {
      await func(mockHre)
    } finally {
      console.log = originalLog
    }

    expect(getCalls).to.deep.equal([
      "Bank",
      "LightRelay",
      "WalletRegistry",
      "ReimbursementPool",
      "Deposit",
      "DepositSweep",
      "Redemption",
      "MovingFunds",
    ])
    expect(deployCalls.map(({ name }) => name)).to.deep.equal([
      "Wallets",
      "Fraud",
    ])
    deployCalls.forEach(({ name, options }) => {
      expect(options.from, `${name} deployer`).to.equal(DEPLOYER_ADDRESS)
      expect(options.log, `${name} logging`).to.be.true
      expect(options.waitConfirmations, `${name} confirmations`).to.equal(1)
    })
    expect(deployCalls[0].options.contract).to.equal(
      "contracts/bridge/Wallets.sol:Wallets"
    )

    expect(upgradeProxyCalls).to.have.lengthOf(1)
    const [, , options] = upgradeProxyCalls[0]
    expect(options.factoryOpts.libraries).to.deep.equal({
      Deposit: DEPOSIT_ADDRESS,
      DepositSweep: DEPOSIT_SWEEP_ADDRESS,
      Redemption: REDEMPTION_ADDRESS,
      Wallets: WALLETS_ADDRESS,
      Fraud: FRAUD_ADDRESS,
      MovingFunds: MOVING_FUNDS_ADDRESS,
    })
    expect(logCalls).to.have.lengthOf(1)
    expect(logCalls[0]).to.include(`Wallets library at ${WALLETS_ADDRESS}`)
    expect(logCalls[0]).to.include(`Fraud library at ${FRAUD_ADDRESS}`)
  })

  it("verifies both freshly deployed libraries", async () => {
    const { mockHre, etherscanVerifyCalls, tenderlyVerifyCalls, runCalls } =
      createMockHre({ etherscan: true, tenderly: true })

    await func(mockHre)

    expect(etherscanVerifyCalls.map(({ address }) => address)).to.deep.equal([
      WALLETS_ADDRESS,
      FRAUD_ADDRESS,
    ])
    expect(runCalls).to.deep.equal([
      {
        taskName: "verify",
        options: { address: PROXY_ADDRESS, constructorArgsParams: [] },
      },
    ])
    expect(tenderlyVerifyCalls).to.deep.equal([
      { name: "Wallets", address: WALLETS_ADDRESS },
      { name: "Fraud", address: FRAUD_ADDRESS },
      { name: "Bridge", address: BRIDGE_ADDRESS },
    ])
  })
})
