import { expect } from "chai"
import { ethers } from "hardhat"

describe("BridgeGovernance ECDSA cutover readiness ABI", () => {
  it("has the fixed selector, exact 38-word order, and all-zero idle vector", async () => {
    const parameters = await (
      await ethers.getContractFactory("BridgeGovernanceParameters")
    ).deploy()
    const verifier = await (
      await ethers.getContractFactory("EcdsaFraudRouterCutoverVerifier")
    ).deploy()
    const cutover = await (
      await ethers.getContractFactory("EcdsaFraudRouterCutover", {
        libraries: {
          EcdsaFraudRouterCutoverVerifier: verifier.address,
        },
      })
    ).deploy()
    const governance = await (
      await ethers.getContractFactory("BridgeGovernance", {
        libraries: {
          BridgeGovernanceParameters: parameters.address,
          EcdsaFraudRouterCutover: cutover.address,
        },
      })
    ).deploy(ethers.constants.AddressZero, 3600)

    expect(
      governance.interface.getSighash("ecdsaFraudCutoverReadiness")
    ).to.equal("0x4c1a700d")

    const raw = await ethers.provider.call({
      to: governance.address,
      data: "0x4c1a700d",
    })
    expect(ethers.utils.hexDataLength(raw)).to.equal(38 * 32)
    expect(raw).to.equal(`0x${"00".repeat(38 * 32)}`)

    const [readiness] = governance.interface.decodeFunctionResult(
      "ecdsaFraudCutoverReadiness",
      raw
    )
    expect(Number(readiness.phase)).to.equal(0)
    expect(readiness.oldRouter).to.equal(ethers.constants.AddressZero)
    expect(readiness.newRouter).to.equal(ethers.constants.AddressZero)
    expect(readiness.inventoryCommitment).to.equal(ethers.constants.HashZero)
    expect(readiness.postMigrationCommitment).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourceSigner).to.equal(ethers.constants.AddressZero)
    expect(readiness.sourceId).to.equal(ethers.constants.HashZero)
    expect(readiness.reconciler).to.equal(ethers.constants.AddressZero)
    expect(readiness.reconcilerSourceId).to.equal(ethers.constants.HashZero)
    expect(readiness.pendingReconciler).to.equal(ethers.constants.AddressZero)
    expect(readiness.pendingReconcilerSourceId).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.finalizedBlock).to.equal(0)
    expect(readiness.finalizedBlockHash).to.equal(ethers.constants.HashZero)
    expect(readiness.migratedBlock).to.equal(0)
    expect(readiness.migrationConfirmedAt).to.equal(0)
    expect(readiness.sourceContext.durableStoreIdentity).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourceContext.endpointIdentity).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourceContext.trustDomain).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourceContext.policyHash).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.reconcilerContext.durableStoreIdentity).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.pendingReconcilerContext.policyHash).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourceContextCommitment).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.reconcilerContextCommitment).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourceCheckpointRoleDigest).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.reconcilerCheckpointRoleDigest).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourceCheckpointCommitment).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourcePreflightCommitment).to.equal(
      ethers.constants.HashZero
    )
    expect(readiness.sourcePreflightBlock).to.equal(0)
    expect(readiness.drainBlock).to.equal(0)
    expect(readiness.maxTailBlocks).to.equal(0)
    expect(readiness.stageDeadlineBlock).to.equal(0)
    expect(readiness.ownerAuthorizationHash).to.equal(ethers.constants.HashZero)
  })
})
