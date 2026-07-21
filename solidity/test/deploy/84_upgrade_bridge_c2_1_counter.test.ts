/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import { constants, utils } from "ethers"
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
  const WALLETS_ADDRESS = "0x3000000000000000000000000000000000000004"
  const MOVING_FUNDS_ADDRESS = "0x3000000000000000000000000000000000000005"
  const FRAUD_ADDRESS = "0x3000000000000000000000000000000000000006"
  const P2TR_PRE_SIGNING_ADDRESS = "0x3000000000000000000000000000000000000007"
  const P2TR_RESERVATION_ADDRESS = "0x3000000000000000000000000000000000000008"
  const BRIDGE_ADDRESS = "0x4000000000000000000000000000000000000001"
  const PROXY_ADDRESS = "0x4000000000000000000000000000000000000002"

  const dependencyAddresses: Record<string, string> = {
    Bank: BANK_ADDRESS,
    LightRelay: LIGHT_RELAY_ADDRESS,
    WalletRegistry: WALLET_REGISTRY_ADDRESS,
    ReimbursementPool: REIMBURSEMENT_POOL_ADDRESS,
  }

  const libraryAddresses: Record<string, string> = {
    Deposit: DEPOSIT_ADDRESS,
    DepositSweep: DEPOSIT_SWEEP_ADDRESS,
    Redemption: REDEMPTION_ADDRESS,
    Wallets: WALLETS_ADDRESS,
    Fraud: FRAUD_ADDRESS,
    MovingFunds: MOVING_FUNDS_ADDRESS,
    P2TRPreSigning: P2TR_PRE_SIGNING_ADDRESS,
    P2TRReservation: P2TR_RESERVATION_ADDRESS,
  }

  interface DeployCall {
    name: string
    options: any
  }

  function createMockHre(
    networkTags: Record<string, boolean> = {},
    networkName = "hardhat"
  ) {
    const deployCalls: DeployCall[] = []
    const getCalls: string[] = []
    const logCalls: string[] = []
    const upgradeProxyCalls: any[][] = []
    const etherscanVerifyCalls: any[] = []
    const tenderlyVerifyCalls: any[] = []
    const runCalls: Array<{ taskName: string; options: any }> = []
    const signer = { address: DEPLOYER_ADDRESS }

    const mockHre: any = {
      ethers: {
        constants,
        utils,
        provider: {
          getBlockNumber: async () => 100,
          getBlock: async () => ({ hash: `0x${"ab".repeat(32)}` }),
          getStorageAt: async () => constants.HashZero,
          getLogs: async () => [],
        },
        getSigner: async (address: string) => {
          expect(address).to.equal(DEPLOYER_ADDRESS)
          return signer
        },
      },
      deployments: {
        get: async (name: string) => {
          getCalls.push(name)
          if (name === "Bridge") {
            return { address: BRIDGE_ADDRESS }
          }
          const address = dependencyAddresses[name]
          if (!address) {
            throw new Error(`Unexpected deployment lookup: ${name}`)
          }
          return { address }
        },
        deploy: async (name: string, options: any) => {
          deployCalls.push({ name, options })
          const address = libraryAddresses[name]
          if (!address) {
            throw new Error(`Unexpected deployment: ${name}`)
          }
          return { address, newlyDeployed: true }
        },
        log: (message: string) => {
          logCalls.push(message)
        },
      },
      getNamedAccounts: async () => ({
        deployer: DEPLOYER_ADDRESS,
        treasury: TREASURY_ADDRESS,
      }),
      getChainId: async () => "11155111",
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
      network: { name: networkName, tags: networkTags },
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
      deployCalls,
      getCalls,
      logCalls,
      upgradeProxyCalls,
      etherscanVerifyCalls,
      tenderlyVerifyCalls,
      runCalls,
    }
  }

  it("deploys and links the current version of every Bridge library", async () => {
    const { mockHre, deployCalls, getCalls, logCalls, upgradeProxyCalls } =
      createMockHre()

    await func(mockHre)

    expect(getCalls).to.deep.equal([
      "Bank",
      "LightRelay",
      "WalletRegistry",
      "ReimbursementPool",
    ])
    expect(deployCalls.map(({ name }) => name)).to.deep.equal([
      "P2TRReservation",
      "P2TRPreSigning",
      "Deposit",
      "DepositSweep",
      "Redemption",
      "Wallets",
      "Fraud",
      "MovingFunds",
    ])
    deployCalls.forEach(({ name, options }) => {
      expect(options.from, `${name} deployer`).to.equal(DEPLOYER_ADDRESS)
      expect(options.log, `${name} logging`).to.be.true
      expect(options.waitConfirmations, `${name} confirmations`).to.equal(1)
    })
    const walletsDeployCall = deployCalls.find(({ name }) => name === "Wallets")
    expect(walletsDeployCall).to.not.be.undefined
    expect(walletsDeployCall?.options.contract).to.equal(
      "contracts/bridge/Wallets.sol:Wallets"
    )

    expect(upgradeProxyCalls).to.have.lengthOf(1)
    const [proxyDeploymentName, newContractName, options] = upgradeProxyCalls[0]
    expect(proxyDeploymentName).to.equal("Bridge")
    expect(newContractName).to.equal("Bridge")
    expect(options.contractName).to.equal("Bridge")
    expect(options.initializerArgs).to.deep.equal([
      BANK_ADDRESS,
      LIGHT_RELAY_ADDRESS,
      TREASURY_ADDRESS,
      WALLET_REGISTRY_ADDRESS,
      REIMBURSEMENT_POOL_ADDRESS,
      6,
    ])
    expect(options.factoryOpts.signer).to.deep.equal({
      address: DEPLOYER_ADDRESS,
    })
    expect(options.factoryOpts.libraries).to.deep.equal(libraryAddresses)

    expect(logCalls).to.have.lengthOf(1)
    Object.entries(libraryAddresses).forEach(([name, address]) => {
      expect(logCalls[0]).to.include(`${name}: ${address}`)
    })
    expect(logCalls[0]).to.include(`Bridge: ${BRIDGE_ADDRESS}`)
  })

  it("verifies every deployed library on configured explorers", async () => {
    const { mockHre, etherscanVerifyCalls, tenderlyVerifyCalls, runCalls } =
      createMockHre({ etherscan: true, tenderly: true })

    await func(mockHre)

    expect(etherscanVerifyCalls.map(({ address }) => address)).to.deep.equal(
      Object.values(libraryAddresses)
    )
    expect(runCalls).to.deep.equal([
      {
        taskName: "verify",
        options: { address: PROXY_ADDRESS, constructorArgsParams: [] },
      },
    ])
    expect(tenderlyVerifyCalls).to.deep.equal([
      { name: "Deposit", address: DEPOSIT_ADDRESS },
      { name: "DepositSweep", address: DEPOSIT_SWEEP_ADDRESS },
      { name: "Redemption", address: REDEMPTION_ADDRESS },
      { name: "Wallets", address: WALLETS_ADDRESS },
      { name: "Fraud", address: FRAUD_ADDRESS },
      { name: "MovingFunds", address: MOVING_FUNDS_ADDRESS },
      { name: "P2TRPreSigning", address: P2TR_PRE_SIGNING_ADDRESS },
      { name: "P2TRReservation", address: P2TR_RESERVATION_ADDRESS },
      { name: "Bridge", address: BRIDGE_ADDRESS },
    ])
  })

  it("aborts a live-network upgrade before deployment or proxy mutation", async () => {
    const { mockHre, deployCalls, upgradeProxyCalls } = createMockHre(
      {},
      "sepolia"
    )

    try {
      await func(mockHre)
      expect.fail("expected live Bridge upgrade NO-GO")
    } catch (error) {
      expect((error as Error).message).to.include(
        "NO-GO 84_upgrade_bridge_c2_1_counter"
      )
    }

    expect(deployCalls).to.deep.equal([])
    expect(upgradeProxyCalls).to.deep.equal([])
  })
})
