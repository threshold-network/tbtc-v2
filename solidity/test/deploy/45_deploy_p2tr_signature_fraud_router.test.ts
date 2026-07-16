/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from "chai"
import hre, { deployments, ethers } from "hardhat"
import fs from "fs"
import path from "path"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { BridgeStub, P2TRSignatureFraudRouter } from "../../typechain"
import type { FrostCustodyPreflightReceipt } from "../../deploy/45_deploy_p2tr_signature_fraud_router"
import deployP2TRFraudRouter, {
  BOUNDED_V1_PROTOCOL_ID,
  BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT,
  BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT,
  abortLiveBridgeUpgradeWithoutVettedCompleteV2,
  isEphemeralLocalNetwork,
  runFrostCustodyPreflight,
} from "../../deploy/45_deploy_p2tr_signature_fraud_router"
import deployFrostWalletRegistry from "../../deploy/48_deploy_frost_wallet_registry"
import deployRebateAndPrepareTxs from "../../deploy/82_deploy_rebate_and_prepare_txs"
import deployTIP109GovernanceUpgrade from "../../deploy/85_deploy_tip109_governance_upgrade"
import deployTIP109Hotfix from "../../deploy/86_deploy_tip109_hotfix"

const expectPreflightFailure = async (
  promise: Promise<unknown>,
  message: string
): Promise<void> => {
  try {
    await promise
    expect.fail("expected FROST custody preflight to fail")
  } catch (error) {
    expect((error as Error).message).to.include(message)
  }
}

const createPreflightMockHre = (
  providerOverrides: Record<string, (...args: any[]) => Promise<any>>
): HardhatRuntimeEnvironment => {
  const sourceProvider = ethers.provider

  return {
    ...hre,
    getChainId: hre.getChainId.bind(hre),
    ethers: {
      constants: ethers.constants,
      utils: ethers.utils,
      provider: {
        getBlockNumber: sourceProvider.getBlockNumber.bind(sourceProvider),
        getBlock: sourceProvider.getBlock.bind(sourceProvider),
        getStorageAt: sourceProvider.getStorageAt.bind(sourceProvider),
        getLogs: sourceProvider.getLogs.bind(sourceProvider),
        ...providerOverrides,
      },
    },
  } as unknown as HardhatRuntimeEnvironment
}

const createLiveMockHre = (): {
  hre: HardhatRuntimeEnvironment
  deployCalls: string[]
  saveCalls: string[]
} => {
  const deployCalls: string[] = []
  const saveCalls: string[] = []
  const bridgeAddress = "0x1000000000000000000000000000000000000001"
  const blockHash = `0x${"ab".repeat(32)}`

  const mock = {
    network: { name: "sepolia", tags: {} },
    deployments: {
      get: async (name: string) => {
        if (name !== "Bridge") {
          throw new Error(`unexpected deployment lookup: ${name}`)
        }
        return { address: bridgeAddress }
      },
      deploy: async (name: string) => {
        deployCalls.push(name)
        return { address: bridgeAddress }
      },
      save: async (name: string) => {
        saveCalls.push(name)
      },
    },
    getNamedAccounts: async () => ({
      deployer: "0x2000000000000000000000000000000000000002",
    }),
    getChainId: async () => "11155111",
    ethers: {
      ...ethers,
      constants: ethers.constants,
      utils: ethers.utils,
      provider: {
        getBlockNumber: async () => 100,
        getBlock: async () => ({ hash: blockHash }),
        getStorageAt: async () => ethers.constants.HashZero,
        getLogs: async () => [],
      },
    },
    helpers: {},
    artifacts: {},
  } as unknown as HardhatRuntimeEnvironment

  return { hre: mock, deployCalls, saveCalls }
}

describe("deploy/45 P2TR fraud evidence NO-GO", () => {
  let bridge: BridgeStub

  beforeEach(async () => {
    await deployments.fixture()
    const Bridge = await deployments.get("Bridge")
    bridge = (await ethers.getContractAt(
      "BridgeStub",
      Bridge.address
    )) as BridgeStub
    await bridge.resetFrostWalletRegistryForTest(ethers.constants.AddressZero)
    await bridge.resetP2TRFraudRouterForTest(ethers.constants.AddressZero)
  })

  it("derives the raw preflight slots from the committed formal layout", () => {
    const layout = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../formal/Bridge.storage-layout.json"),
        "utf8"
      )
    ) as {
      storage: { label: string; slot: string; type: string }[]
      types: Record<string, { members?: { label: string; slot: string }[] }>
    }
    const self = layout.storage.find(({ label }) => label === "self")!
    const members = layout.types[self.type].members!
    const frostRegistry = members.find(
      ({ label }) => label === "frostWalletRegistry"
    )!
    const p2trRouter = members.find(({ label }) => label === "p2trFraudRouter")!

    expect(self.slot).to.equal("51")
    expect(frostRegistry.slot).to.equal("32")
    expect(p2trRouter.slot).to.equal("34")
    expect(Number(self.slot) + Number(frostRegistry.slot)).to.equal(
      BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT
    )
    expect(Number(self.slot) + Number(p2trRouter.slot)).to.equal(
      BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT
    )
  })

  it("keeps the bounded router unwired and persists a pinned zero-state receipt", async () => {
    const Bridge = await deployments.get("Bridge")
    const routerDeployment = await deployments.get("P2TRSignatureFraudRouter")
    const router = (await ethers.getContractAt(
      "P2TRSignatureFraudRouter",
      routerDeployment.address
    )) as P2TRSignatureFraudRouter
    const receipt = routerDeployment.linkedData
      ?.frostCustodyPreflight as FrostCustodyPreflightReceipt

    expect(await bridge.p2trFraudRouter()).to.equal(
      ethers.constants.AddressZero
    )
    expect(await router.bridge()).to.equal(Bridge.address)
    expect(await router.evidenceProtocolID()).to.equal(BOUNDED_V1_PROTOCOL_ID)

    expect(receipt.schemaVersion).to.equal("tbtc/frost-custody-preflight/v1")
    expect(receipt.networkName).to.equal("hardhat")
    expect(receipt.chainId).to.equal("31337")
    expect(receipt.bridge).to.equal(Bridge.address)
    expect(receipt.scanFromBlock).to.equal(0)
    expect(receipt.scanToBlock).to.equal(receipt.snapshotBlockNumber)
    expect(receipt.registrationsFound).to.equal(0)
    expect(receipt.frostWalletRegistry).to.equal(ethers.constants.AddressZero)
    expect(receipt.configuredP2TRFraudRouter).to.equal(
      ethers.constants.AddressZero
    )
    expect(receipt.configuredRouterStatus).to.equal("unset")
    expect(receipt.frostWalletRegistryStorageSlot).to.equal(
      BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT
    )
    expect(receipt.p2trFraudRouterStorageSlot).to.equal(
      BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT
    )
    expect(receipt.storageLayoutEvidence).to.equal(
      "test/formal/Bridge.storage-layout.json"
    )

    const snapshotBlock = await ethers.provider.getBlock(
      receipt.snapshotBlockNumber
    )
    expect(snapshotBlock.hash).to.equal(receipt.snapshotBlockHash)
    expect(
      await ethers.provider.getStorageAt(
        Bridge.address,
        BRIDGE_FROST_WALLET_REGISTRY_STORAGE_SLOT,
        receipt.snapshotBlockNumber
      )
    ).to.equal(ethers.constants.HashZero)
    expect(
      await ethers.provider.getStorageAt(
        Bridge.address,
        BRIDGE_P2TR_FRAUD_ROUTER_STORAGE_SLOT,
        receipt.snapshotBlockNumber
      )
    ).to.equal(ethers.constants.HashZero)
  })

  it("fails on a non-zero FROST registry storage word", async () => {
    await bridge.resetFrostWalletRegistryForTest(
      (
        await ethers.getSigners()
      )[1].address
    )

    await expectPreflightFailure(
      runFrostCustodyPreflight(hre, bridge.address),
      "frost registry storage slot"
    )
  })

  it("fails on a non-zero P2TR router storage word", async () => {
    await bridge.resetP2TRFraudRouterForTest(
      (
        await ethers.getSigners()
      )[1].address
    )

    await expectPreflightFailure(
      runFrostCustodyPreflight(hre, bridge.address),
      "P2TR router storage slot"
    )
  })

  it("fails when NewFrostWalletRegistered exists in history", async () => {
    await bridge.emitNewFrostWalletRegisteredForTest()

    await expectPreflightFailure(
      runFrostCustodyPreflight(hre, bridge.address),
      "prior FROST wallet registration"
    )
  })

  it("fails when the zero-ECDSA NewWalletRegisteredV2 marker exists", async () => {
    await bridge.emitZeroEcdsaWalletRegisteredV2ForTest()

    await expectPreflightFailure(
      runFrostCustodyPreflight(hre, bridge.address),
      "prior FROST wallet registration"
    )
  })

  it("fails closed on malformed or unavailable raw storage reads", async () => {
    await expectPreflightFailure(
      runFrostCustodyPreflight(
        createPreflightMockHre({ getStorageAt: async () => "0x00" }),
        bridge.address
      ),
      "malformed Bridge storage slot"
    )

    await expectPreflightFailure(
      runFrostCustodyPreflight(
        createPreflightMockHre({
          getStorageAt: async () => {
            throw new Error("storage RPC unavailable")
          },
        }),
        bridge.address
      ),
      "storage RPC unavailable"
    )
  })

  it("fails closed when either registration log query fails", async () => {
    await expectPreflightFailure(
      runFrostCustodyPreflight(
        createPreflightMockHre({
          getLogs: async () => {
            throw new Error("NewFrostWalletRegistered RPC unavailable")
          },
        }),
        bridge.address
      ),
      "NewFrostWalletRegistered RPC unavailable"
    )

    let queryCount = 0
    await expectPreflightFailure(
      runFrostCustodyPreflight(
        createPreflightMockHre({
          getLogs: async () => {
            queryCount += 1
            if (queryCount === 2) {
              throw new Error("NewWalletRegisteredV2 RPC unavailable")
            }
            return []
          },
        }),
        bridge.address
      ),
      "NewWalletRegisteredV2 RPC unavailable"
    )
  })

  it("fails closed when the pinned snapshot hash changes", async () => {
    const getBlock = ethers.provider.getBlock.bind(ethers.provider)
    let readCount = 0
    const reorgedHre = createPreflightMockHre({
      getBlock: async (...args: unknown[]) => {
        const block = await getBlock(...(args as [number]))
        readCount += 1
        return readCount === 1
          ? block
          : { ...block, hash: `0x${"cd".repeat(32)}` }
      },
    })

    await expectPreflightFailure(
      runFrostCustodyPreflight(reorgedHre, bridge.address),
      "snapshot block reorged"
    )
  })

  for (const [upgradePath, deployFunction] of [
    ["45_deploy_p2tr_signature_fraud_router", deployP2TRFraudRouter],
    ["48_deploy_frost_wallet_registry", deployFrostWalletRegistry],
    ["82_deploy_rebate_and_prepare_txs", deployRebateAndPrepareTxs],
    ["85_deploy_tip109_governance_upgrade", deployTIP109GovernanceUpgrade],
    ["86_deploy_tip109_hotfix", deployTIP109Hotfix],
  ] as const) {
    it(`aborts live ${upgradePath} before writes or calldata output`, async () => {
      const mock = createLiveMockHre()
      const logs: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => logs.push(args.join(" "))

      try {
        await expectPreflightFailure(
          deployFunction(mock.hre),
          `NO-GO ${upgradePath}`
        )
      } finally {
        console.log = originalLog
      }

      expect(mock.deployCalls).to.deep.equal([])
      expect(mock.saveCalls).to.deep.equal([])
      expect(logs).to.have.lengthOf(1)
      expect(logs[0]).to.match(/^FROST_CUSTODY_PREFLIGHT_RECEIPT=/)
      expect(logs[0]).not.to.include("calldata")
      expect(logs[0]).not.to.include("SUMMARY")
    })
  }

  it("runs the write-free NO-GO dependency first on every active path", () => {
    for (const deployFunction of [
      deployP2TRFraudRouter,
      deployFrostWalletRegistry,
      deployRebateAndPrepareTxs,
      deployTIP109GovernanceUpgrade,
      deployTIP109Hotfix,
    ]) {
      expect(deployFunction.dependencies?.[0]).to.equal("FrostCustodyNoGo")
    }
  })

  it("default-denies every non-ephemeral network and returns NO-GO", async () => {
    expect(isEphemeralLocalNetwork("hardhat")).to.equal(true)
    expect(isEphemeralLocalNetwork("development")).to.equal(true)
    expect(isEphemeralLocalNetwork("system_tests")).to.equal(true)
    expect(isEphemeralLocalNetwork("sepolia")).to.equal(false)
    expect(isEphemeralLocalNetwork("mainnet")).to.equal(false)
    expect(isEphemeralLocalNetwork("custom-live-network")).to.equal(false)

    await expectPreflightFailure(
      abortLiveBridgeUpgradeWithoutVettedCompleteV2(hre, "test-upgrade"),
      "NO-GO test-upgrade"
    )
  })
})
