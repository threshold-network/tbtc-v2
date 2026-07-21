/* eslint-disable @typescript-eslint/no-unused-expressions */

import { BigNumber } from "ethers"
import { ethers, helpers, waffle } from "hardhat"
import { expect } from "chai"
import { smock } from "@defi-wonderland/smock"
import type { Bridge, BridgeStub } from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import {
  COVERAGE_AUTHORIZATION_TUPLE,
  buildCoverageInitializationPayload,
} from "../utils/p2trCoverage"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { defaultAbiCoder, keccak256, solidityPack, toUtf8Bytes } = ethers.utils

describe("Bridge COMPLETE_V2 Taproot output-key coverage", () => {
  let bridge: Bridge & BridgeStub
  let deployer: any
  let migrator: any

  before(async () => {
    const fixture = await waffle.loadFixture(bridgeFixture)
    deployer = fixture.deployer
    migrator = fixture.thirdParty
    ;[bridge] = (await fixture.deployBridge(1, migrator.address)) as [
      Bridge & BridgeStub,
      any
    ]
  })

  beforeEach(async () => createSnapshot())
  afterEach(async () => restoreSnapshot())

  const statePayload = () => defaultAbiCoder.encode(["uint8"], [2])
  const leafStatePayload = (index: number) =>
    defaultAbiCoder.encode(["uint8", "uint64"], [3, index])
  const outputKeyPayload = (depositKey: BigNumber) =>
    defaultAbiCoder.encode(["uint8", "uint256"], [4, depositKey])

  const deployCompleteRouter = async (targetBridge = bridge) => {
    const frostRegistry = await smock.fake(
      "IFrostRegistryForP2TRPreAuthorization"
    )
    const proposalValidator = await smock.fake(
      "IProposalValidatorForP2TRPreAuthorization"
    )
    proposalValidator.bridge.returns(targetBridge.address)
    await targetBridge.resetFrostWalletRegistryForTest(frostRegistry.address)

    const Registry = await ethers.getContractFactory(
      "P2TRAuthorizationRegistry"
    )
    const registry = await Registry.deploy(
      targetBridge.address,
      frostRegistry.address,
      proposalValidator.address
    )
    await registry.deployed()
    const Router = await ethers.getContractFactory(
      "CompleteP2TRSignatureFraudRouter"
    )
    const router = await Router.deploy(targetBridge.address, registry.address)
    await router.deployed()
    return { frostRegistry, registry, router }
  }

  it("requires an exact one-shot inventory and every positional Merkle leaf before activation", async () => {
    const txHash = keccak256(toUtf8Bytes("historical-taproot-funding"))
    const outputIndex = 7
    const walletID = keccak256(toUtf8Bytes("historical-wallet"))
    const outputKey = keccak256(toUtf8Bytes("historical-output-key"))
    const utxo = {
      txHash,
      txOutputIndex: outputIndex,
      txOutputValue: 1_500_000,
    }
    await bridge.setHistoricalTaprootDepositForCoverage(
      utxo,
      walletID,
      outputKey
    )

    const depositKey = BigNumber.from(
      keccak256(solidityPack(["bytes32", "uint32"], [txHash, outputIndex]))
    )
    const commitment = keccak256(
      solidityPack(["bytes32", "bytes32"], [walletID, outputKey])
    )
    const leaf = keccak256(
      defaultAbiCoder.encode(
        ["string", "uint64", "uint256", "bytes32", "bytes32", "bytes32"],
        [
          "tbtc-p2tr-output-key-coverage-leaf-v1",
          0,
          depositKey,
          walletID,
          outputKey,
          commitment,
        ]
      )
    )
    const { frostRegistry, registry, router } = await deployCompleteRouter()
    const initialization = await buildCoverageInitializationPayload(
      bridge,
      migrator.address,
      leaf,
      1,
      registry.address,
      router.address,
      migrator
    )

    await expect(
      bridge
        .connect(migrator)
        .processTaprootOutputKeyCoverage(initialization.payload)
    ).to.be.revertedWith("Caller is not governance")

    const governanceOnlySignature = await deployer.signMessage(
      ethers.utils.arrayify(initialization.digest)
    )
    await expect(
      bridge.connect(deployer).processTaprootOutputKeyCoverage(
        defaultAbiCoder.encode(
          [
            "uint8",
            COVERAGE_AUTHORIZATION_TUPLE,
            "bytes",
            "bytes",
            "bytes",
          ],
          [
            0,
            initialization.authorization,
            initialization.sourceSignatures[0],
            initialization.sourceSignatures[1],
            governanceOnlySignature,
          ]
        )
      )
    ).to.be.revertedWith("Invalid coverage authorization")

    const invalidInventory = await buildCoverageInitializationPayload(
      bridge,
      migrator.address,
      ethers.constants.HashZero,
      1,
      registry.address,
      router.address,
      migrator
    )
    await expect(
      bridge
        .connect(deployer)
        .processTaprootOutputKeyCoverage(invalidInventory.payload)
    ).to.be.revertedWith("Invalid coverage inventory")

    await expect(
      bridge
        .connect(deployer)
        .processTaprootOutputKeyCoverage(initialization.payload)
    )
      .to.emit(bridge, "TaprootOutputKeyCoverageInitialized")
      .withArgs(leaf, 1)
    await expect(
      bridge
        .connect(deployer)
        .processTaprootOutputKeyCoverage(initialization.payload)
    ).to.be.revertedWith("Coverage inventory already initialized")

    await expect(bridge.connect(deployer).setP2TRFraudRouter(router.address)).to
      .be.reverted

    const migrationPayload = defaultAbiCoder.encode(
      ["uint8", "uint64", "uint256", "bytes32", "bytes32", "bytes32[]"],
      [1, 0, depositKey, walletID, outputKey, []]
    )
    const batchPayload = defaultAbiCoder.encode(
      ["uint8", "bytes[]"],
      [5, [migrationPayload]]
    )
    await expect(
      bridge.connect(migrator).processTaprootOutputKeyCoverage(batchPayload)
    )
      .to.emit(bridge, "TaprootOutputKeyCoverageLeafMigrated")
      .withArgs(0, depositKey, walletID, outputKey, 1)
    await expect(
      bridge.connect(migrator).processTaprootOutputKeyCoverage(batchPayload)
    ).not.to.emit(bridge, "TaprootOutputKeyCoverageLeafMigrated")

    const encodedState =
      await bridge.callStatic.processTaprootOutputKeyCoverage(statePayload())
    const [initialized, root, count, migratedCount] = defaultAbiCoder.decode(
      ["bool", "bytes32", "uint64", "uint64"],
      encodedState
    )
    expect(initialized).to.be.true
    expect(root).to.equal(leaf)
    expect(count).to.equal(1)
    expect(migratedCount).to.equal(1)

    const encodedLeaf = await bridge.callStatic.processTaprootOutputKeyCoverage(
      leafStatePayload(0)
    )
    expect(defaultAbiCoder.decode(["bool"], encodedLeaf)[0]).to.be.true
    const encodedOutputKey =
      await bridge.callStatic.processTaprootOutputKeyCoverage(
        outputKeyPayload(depositKey)
      )
    expect(defaultAbiCoder.decode(["bytes32"], encodedOutputKey)[0]).to.equal(
      outputKey
    )
    await expect(
      bridge.connect(migrator).processTaprootOutputKeyCoverage(migrationPayload)
    ).to.be.reverted

    await bridge.connect(deployer).setP2TRFraudRouter(router.address)
    expect(await bridge.p2trFraudRouter()).to.equal(router.address)
    expect(await router.authorizationRegistry()).to.equal(registry.address)
    expect(await registry.bridge()).to.equal(bridge.address)
    expect(await registry.frostRegistry()).to.equal(frostRegistry.address)
    expect(await router.evidenceProtocolID()).to.equal(
      keccak256(toUtf8Bytes("tbtc/p2tr-signature-fraud/evidence/complete-v2"))
    )
  })

  it("supports a provable empty inventory without fabricating a root", async () => {
    const { registry, router } = await deployCompleteRouter()
    const initialization = await buildCoverageInitializationPayload(
      bridge,
      migrator.address,
      ethers.constants.HashZero,
      0,
      registry.address,
      router.address,
      migrator
    )
    await bridge
      .connect(deployer)
      .processTaprootOutputKeyCoverage(initialization.payload)
    const encoded = await bridge.callStatic.processTaprootOutputKeyCoverage(
      statePayload()
    )
    const state = defaultAbiCoder.decode(
      ["bool", "bytes32", "uint64", "uint64"],
      encoded
    )
    expect(state[0]).to.be.true
    expect(state[1]).to.equal(ethers.constants.HashZero)
    expect(state[2]).to.equal(0)
    expect(state[3]).to.equal(0)
  })

  it("terminally resolves a swept snapshot leaf without locking activation", async () => {
    const txHash = keccak256(toUtf8Bytes("swept-during-coverage"))
    const outputIndex = 3
    const walletID = keccak256(toUtf8Bytes("swept-wallet"))
    const outputKey = keccak256(toUtf8Bytes("swept-output-key"))
    const utxo = {
      txHash,
      txOutputIndex: outputIndex,
      txOutputValue: 1_700_000,
    }
    await bridge.setHistoricalTaprootDepositForCoverage(
      utxo,
      walletID,
      outputKey
    )
    const depositKey = BigNumber.from(
      keccak256(solidityPack(["bytes32", "uint32"], [txHash, outputIndex]))
    )
    const commitment = keccak256(
      solidityPack(["bytes32", "bytes32"], [walletID, outputKey])
    )
    const leaf = keccak256(
      defaultAbiCoder.encode(
        ["string", "uint64", "uint256", "bytes32", "bytes32", "bytes32"],
        [
          "tbtc-p2tr-output-key-coverage-leaf-v1",
          0,
          depositKey,
          walletID,
          outputKey,
          commitment,
        ]
      )
    )
    const { registry, router } = await deployCompleteRouter()
    const initialization = await buildCoverageInitializationPayload(
      bridge,
      migrator.address,
      leaf,
      1,
      registry.address,
      router.address,
      migrator
    )
    await bridge
      .connect(deployer)
      .processTaprootOutputKeyCoverage(initialization.payload)

    const resolution = defaultAbiCoder.encode(
      ["uint8", "uint64", "uint256", "bytes32", "bytes32", "bytes32[]"],
      [6, 0, depositKey, walletID, outputKey, []]
    )
    const resolutionBatch = defaultAbiCoder.encode(
      ["uint8", "bytes[]"],
      [5, [resolution]]
    )
    await expect(
      bridge.connect(migrator).processTaprootOutputKeyCoverage(resolutionBatch)
    ).to.be.revertedWith("Live coverage leaf cannot be terminally resolved")

    await bridge.setSweptDeposits([utxo])
    await expect(
      bridge.connect(migrator).processTaprootOutputKeyCoverage(resolutionBatch)
    )
      .to.emit(bridge, "TaprootOutputKeyCoverageLeafTerminallyResolved")
      .withArgs(0, depositKey, walletID, outputKey, 1)
    await expect(
      bridge.connect(migrator).processTaprootOutputKeyCoverage(resolutionBatch)
    ).not.to.emit(
      bridge,
      "TaprootOutputKeyCoverageLeafTerminallyResolved"
    )
    expect(
      defaultAbiCoder.decode(
        ["bytes32"],
        await bridge.callStatic.processTaprootOutputKeyCoverage(
          outputKeyPayload(depositKey)
        )
      )[0]
    ).to.equal(ethers.constants.HashZero)
    await bridge.connect(deployer).setP2TRFraudRouter(router.address)
  })

  it("accepts EIP-1271 authorization and exposes the signed watermark", async () => {
    const fixture = await waffle.loadFixture(bridgeFixture)
    const authority = await smock.fake("IERC1271")
    authority.isValidSignature.returns("0x1626ba7e")
    const [contractBridge] = (await fixture.deployBridge(
      1,
      authority.address
    )) as [Bridge & BridgeStub, any]
    const { registry, router } = await deployCompleteRouter(contractBridge)
    const initialization = await buildCoverageInitializationPayload(
      contractBridge,
      authority.address,
      ethers.constants.HashZero,
      0,
      registry.address,
      router.address,
      undefined,
      "0x1234"
    )
    await contractBridge
      .connect(fixture.deployer)
      .processTaprootOutputKeyCoverage(initialization.payload)
    const readback = defaultAbiCoder.decode(
      [
        "address",
        "bytes32",
        "address",
        "uint64",
        "uint64",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      await contractBridge.callStatic.processTaprootOutputKeyCoverage(
        defaultAbiCoder.encode(["uint8"], [7])
      )
    )
    expect(readback[0]).to.equal(authority.address)
    expect(readback[1]).to.equal(initialization.digest)
    expect(readback[2]).to.equal(router.address)
  })
})
