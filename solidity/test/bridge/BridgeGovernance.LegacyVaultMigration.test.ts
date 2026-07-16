import { expect } from "chai"
import { ethers } from "hardhat"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type { Contract } from "ethers"

const GOVERNANCE_DELAY = 3600

// Step ordinals mirror MockOrchestrationBridge.Step.
const STEP = {
  Attestation: 0,
  UntrustLegacy: 1,
  TrustSuccessor: 2,
  SetMigrationDebtVault: 3,
}

const SNAPSHOT_BLOCK = 1000
const SNAPSHOT_HASH =
  "0x3333333333333333333333333333333333333333333333333333333333333333"
const EVIDENCE_HASH =
  "0x4444444444444444444444444444444444444444444444444444444444444444"

describe("BridgeGovernance - Legacy vault migration", () => {
  let owner: SignerWithAddress
  let thirdParty: SignerWithAddress
  let legacyVault: SignerWithAddress
  let successorVault: SignerWithAddress

  let mockBridge: Contract
  let bridgeGovernance: Contract
  let coordinator: Contract

  async function deploy(name: string, args: unknown[] = []): Promise<Contract> {
    const factory = await ethers.getContractFactory(name)
    const contract = await factory.deploy(...args)
    await contract.deployed()
    return contract
  }

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[owner, thirdParty, legacyVault, successorVault] =
      await ethers.getSigners()

    mockBridge = await deploy("MockOrchestrationBridge")
    // Deployer (owner) is the BridgeGovernance Ownable owner. BridgeGovernance
    // links the BridgeGovernanceParameters library.
    const params = await deploy("BridgeGovernanceParameters")
    const bridgeGovernanceFactory = await ethers.getContractFactory(
      "BridgeGovernance",
      { libraries: { BridgeGovernanceParameters: params.address } }
    )
    bridgeGovernance = await bridgeGovernanceFactory.deploy(
      mockBridge.address,
      GOVERNANCE_DELAY
    )
    await bridgeGovernance.deployed()
    coordinator = await deploy("MockMigrationCoordinator", [
      bridgeGovernance.address,
      mockBridge.address,
      legacyVault.address,
      successorVault.address,
    ])
  })

  describe("access control", () => {
    it("restricts the attestation setter, initiation, and finalization to the owner", async () => {
      await expect(
        bridgeGovernance
          .connect(thirdParty)
          .setLegacyVaultOptimisticMintingDebtAttestation(
            legacyVault.address,
            coordinator.address,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            EVIDENCE_HASH
          )
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(
        bridgeGovernance
          .connect(thirdParty)
          .initiateLegacyVaultUpgrade(
            coordinator.address,
            successorVault.address
          )
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(
        bridgeGovernance
          .connect(thirdParty)
          .finalizeLegacyVaultMigration(
            coordinator.address,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            EVIDENCE_HASH
          )
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  describe("initiateLegacyVaultUpgrade", () => {
    it("validates the coordinator bindings and forwards the initiation", async () => {
      await bridgeGovernance
        .connect(owner)
        .initiateLegacyVaultUpgrade(coordinator.address, successorVault.address)

      expect(await coordinator.initiateCalled()).to.equal(true)
      expect(await coordinator.initiatedSuccessor()).to.equal(
        successorVault.address
      )
    })

    it("reverts when the coordinator's controller is not this governance", async () => {
      await coordinator.setBindings(
        thirdParty.address,
        mockBridge.address,
        legacyVault.address,
        successorVault.address
      )
      await expect(
        bridgeGovernance
          .connect(owner)
          .initiateLegacyVaultUpgrade(
            coordinator.address,
            successorVault.address
          )
      ).to.be.revertedWith("Coordinator controller must be this governance")
    })

    it("reverts when the coordinator's Bridge does not match", async () => {
      await coordinator.setBindings(
        bridgeGovernance.address,
        thirdParty.address,
        legacyVault.address,
        successorVault.address
      )
      await expect(
        bridgeGovernance
          .connect(owner)
          .initiateLegacyVaultUpgrade(
            coordinator.address,
            successorVault.address
          )
      ).to.be.revertedWith("Coordinator bridge mismatch")
    })
  })

  describe("finalizeLegacyVaultMigration", () => {
    it("executes the five-step cutover in order and emits the event", async () => {
      await expect(
        bridgeGovernance
          .connect(owner)
          .finalizeLegacyVaultMigration(
            coordinator.address,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            EVIDENCE_HASH
          )
      )
        .to.emit(bridgeGovernance, "LegacyVaultMigrationFinalized")
        .withArgs(
          coordinator.address,
          legacyVault.address,
          successorVault.address,
          EVIDENCE_HASH
        )

      // The Bridge received exactly attestation, untrust, trust, set-canonical.
      expect(await mockBridge.callOrderLength()).to.equal(4)
      expect(await mockBridge.callOrder(0)).to.equal(STEP.Attestation)
      expect(await mockBridge.callOrder(1)).to.equal(STEP.UntrustLegacy)
      expect(await mockBridge.callOrder(2)).to.equal(STEP.TrustSuccessor)
      expect(await mockBridge.callOrder(3)).to.equal(STEP.SetMigrationDebtVault)

      // The coordinator finalization ran, and the attestation carried this
      // coordinator and legacy vault.
      expect(await coordinator.finalizeCalled()).to.equal(true)
      expect(await mockBridge.attestedVault()).to.equal(legacyVault.address)
      expect(await mockBridge.attestedCoordinator()).to.equal(
        coordinator.address
      )
    })

    it("reverts when the coordinator has no successor set", async () => {
      await coordinator.setBindings(
        bridgeGovernance.address,
        mockBridge.address,
        legacyVault.address,
        ethers.constants.AddressZero
      )
      await expect(
        bridgeGovernance
          .connect(owner)
          .finalizeLegacyVaultMigration(
            coordinator.address,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            EVIDENCE_HASH
          )
      ).to.be.revertedWith("Successor vault not set")
    })

    it("rolls back atomically when any Bridge substep reverts", async () => {
      // eslint-disable-next-line no-restricted-syntax
      for (const step of [
        STEP.Attestation,
        STEP.UntrustLegacy,
        STEP.TrustSuccessor,
        STEP.SetMigrationDebtVault,
      ]) {
        // eslint-disable-next-line no-await-in-loop
        await mockBridge.setRevertOnStep(step, true)
        // eslint-disable-next-line no-await-in-loop
        await expect(
          bridgeGovernance
            .connect(owner)
            .finalizeLegacyVaultMigration(
              coordinator.address,
              SNAPSHOT_BLOCK,
              SNAPSHOT_HASH,
              EVIDENCE_HASH
            )
        ).to.be.revertedWith("Bridge step reverted")
        // No step persisted; the whole cutover rolled back.
        // eslint-disable-next-line no-await-in-loop
        expect(await mockBridge.callOrderLength()).to.equal(0)
        // eslint-disable-next-line no-await-in-loop
        expect(await coordinator.finalizeCalled()).to.equal(false)
        // eslint-disable-next-line no-await-in-loop
        await mockBridge.setRevertOnStep(step, false)
      }
    })

    it("rolls back atomically when the coordinator finalization reverts", async () => {
      await coordinator.setRevertOnFinalize(true)
      await expect(
        bridgeGovernance
          .connect(owner)
          .finalizeLegacyVaultMigration(
            coordinator.address,
            SNAPSHOT_BLOCK,
            SNAPSHOT_HASH,
            EVIDENCE_HASH
          )
      ).to.be.revertedWith("Coordinator finalize reverted")
      // The two Bridge steps before the coordinator call also rolled back.
      expect(await mockBridge.callOrderLength()).to.equal(0)
    })
  })
})
