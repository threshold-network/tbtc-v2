import { expect } from "chai"
import { utils } from "ethers"
import fs from "fs"
import path from "path"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeploymentsManager } from "hardhat-deploy/dist/src/DeploymentsManager"
import type { Deployment, DeployOptions } from "hardhat-deploy/types"

describe("Peg keeper migration deployment dependencies", () => {
  const solidityPath = path.resolve(__dirname, "../..")
  const governance = "0x1000000000000000000000000000000000000001"
  const governanceV2 = "0x2000000000000000000000000000000000000002"
  const networks = ["mainnet", "sepolia"]
  const migrationTags = [
    "BridgeGovernanceV2",
    "TransferBridgeGovernanceV2",
    "UpgradeBridgeV6PegKeeper",
  ]
  const environmentVariables = [
    "DEPLOY_BRIDGE_GOVERNANCE_V2",
    "DEPLOY_BRIDGE_GOVERNANCE_TRANSFER",
    "DEPLOY_PROTOCOL_PEG_KEEPER_UPGRADE",
    "INITIAL_PEG_KEEPER",
    "ALLOW_UNSAFE_ORDER",
  ]
  let savedEnvironment: Record<string, string | undefined>
  let originalLog: typeof console.log
  let logs: string[]

  beforeEach(() => {
    savedEnvironment = {}
    environmentVariables.forEach((name) => {
      savedEnvironment[name] = process.env[name]
      delete process.env[name]
    })
    logs = []
    originalLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(" "))
  })

  afterEach(() => {
    environmentVariables.forEach((name) => {
      if (savedEnvironment[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnvironment[name]
    })
    console.log = originalLog
  })

  function migrationEnvironment(network: string, v2AlreadyDeployed = true) {
    const records: Record<string, Deployment> = {}
    const getCalls: string[] = []
    const deployCalls: { name: string; options: DeployOptions }[] = []
    const saveCalls: string[] = []
    const allowedDeployments = [
      "BridgeGovernanceParametersV2",
      "BridgeGovernanceV2",
      "DepositV6PegKeeper",
      "RedemptionV6PegKeeper",
      "BridgeV6PegKeeperImplementation",
      "RebateStakingV6Implementation",
    ]
    if (v2AlreadyDeployed) {
      records.BridgeGovernanceV2 = { address: governanceV2, abi: [] }
    }
    const get = async (name: string) => {
      getCalls.push(name)
      if (!records[name]) {
        const recordPath = path.join(
          solidityPath,
          "deployments",
          network,
          `${name}.json`
        )
        if (!fs.existsSync(recordPath)) {
          throw new Error(`No deployment found for: ${name}`)
        }
        records[name] = JSON.parse(fs.readFileSync(recordPath, "utf8"))
      }
      return records[name]
    }
    const hre = {
      config: {
        paths: { deployments: path.join(solidityPath, "deployments") },
      },
      network: { name: network, tags: {} },
      getNamedAccounts: async () => ({ deployer: governance, governance }),
      deployments: {
        get,
        deploy: async (name: string, options: DeployOptions) => {
          expect(
            allowedDeployments,
            `Fresh deployment requested: ${name}`
          ).to.include(name)
          deployCalls.push({ name, options })
          records[name] = { address: governanceV2, abi: [] }
          return records[name]
        },
        save: async (name: string, record: Deployment) => {
          expect(["Bridge", "RebateStaking"]).to.include(name)
          saveCalls.push(name)
          records[name] = record
        },
      },
      helpers: {
        upgrades: {
          deployProxy: async () => {
            throw new Error("Fresh proxy deployment must not run")
          },
        },
        ownable: {
          transferOwnership: async (name: string) => {
            expect(name).to.equal("BridgeGovernanceV2")
          },
        },
      },
      ethers: {
        utils,
        getContractAt: async () => ({
          owner: async () => governance,
          governance: async () => governanceV2,
        }),
        provider: {
          getStorageAt: async () => utils.hexZeroPad(governance, 32),
        },
      },
      artifacts: { readArtifactSync: () => ({ abi: [] }) },
    } as unknown as HardhatRuntimeEnvironment
    const manager = new DeploymentsManager(hre, hre.network)

    return {
      records,
      getCalls,
      deployCalls,
      saveCalls,
      // Use hardhat-deploy's real tag resolution and skip evaluation. Calling
      // migration functions directly would miss dependencies running first.
      run: (tag: string) =>
        manager.executeDeployScripts(
          [path.join(solidityPath, "deploy")],
          [tag]
        ),
    }
  }

  networks.forEach((network) => {
    it(`deploys V2 against the existing ${network} Bridge`, async () => {
      process.env.DEPLOY_BRIDGE_GOVERNANCE_V2 = "true"
      const env = migrationEnvironment(network, false)

      await env.run("BridgeGovernanceV2")

      expect(env.getCalls).to.deep.equal(["Bridge"])
      expect(env.deployCalls.map(({ name }) => name)).to.deep.equal([
        "BridgeGovernanceParametersV2",
        "BridgeGovernanceV2",
      ])
      expect(env.deployCalls[1].options.args).to.deep.equal([
        env.records.Bridge.address,
        network === "sepolia" ? 60 : 172800,
      ])
    })

    it(`generates transfer calldata using existing ${network} governance records`, async () => {
      process.env.DEPLOY_BRIDGE_GOVERNANCE_TRANSFER = "true"
      const env = migrationEnvironment(network)

      await env.run("TransferBridgeGovernanceV2")

      expect(env.deployCalls).to.have.lengthOf(0)
      expect(env.getCalls).to.deep.equal([
        "BridgeGovernance",
        "BridgeGovernanceV2",
      ])
      expect(logs.join("\n")).to.include(env.records.BridgeGovernance.address)
      expect(logs.join("\n")).to.include("finalizeBridgeGovernanceTransfer")
    })
  })

  it("deploys V2 before generating transfer calldata when both opt-ins are set", async () => {
    process.env.DEPLOY_BRIDGE_GOVERNANCE_V2 = "true"
    process.env.DEPLOY_BRIDGE_GOVERNANCE_TRANSFER = "true"
    const env = migrationEnvironment("mainnet", false)

    await env.run("TransferBridgeGovernanceV2")

    expect(env.getCalls).to.deep.equal([
      "Bridge",
      "BridgeGovernance",
      "BridgeGovernanceV2",
    ])
    expect(env.deployCalls).to.have.lengthOf(2)
    expect(logs.join("\n")).to.include("finalizeBridgeGovernanceTransfer")
  })

  it("prepares the upgrade using existing mainnet proxy and library records", async () => {
    process.env.DEPLOY_PROTOCOL_PEG_KEEPER_UPGRADE = "true"
    process.env.INITIAL_PEG_KEEPER = governance
    const env = migrationEnvironment("mainnet")

    await env.run("UpgradeBridgeV6PegKeeper")

    expect(env.deployCalls.map(({ name }) => name)).to.deep.equal([
      "DepositV6PegKeeper",
      "RedemptionV6PegKeeper",
      "BridgeV6PegKeeperImplementation",
      "RebateStakingV6Implementation",
    ])
    expect(env.deployCalls[2].options.libraries).to.include({
      DepositSweep: env.records.DepositSweep.address,
      Wallets: env.records.Wallets.address,
      Fraud: env.records.Fraud.address,
      MovingFunds: env.records.MovingFunds.address,
    })
    expect(env.saveCalls).to.deep.equal(["Bridge", "RebateStaking"])
    expect(logs.join("\n")).to.include("Timelock batch")
  })

  migrationTags.forEach((tag) => {
    it(`skips ${tag} and its dependencies without opt-in`, async () => {
      const env = migrationEnvironment("mainnet")

      await env.run(tag)

      expect(env.getCalls).to.have.lengthOf(0)
      expect(env.deployCalls).to.have.lengthOf(0)
      expect(env.saveCalls).to.have.lengthOf(0)
    })
  })
})
