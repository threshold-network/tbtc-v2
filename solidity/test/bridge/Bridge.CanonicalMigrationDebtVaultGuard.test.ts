import { expect } from "chai"
import hre from "hardhat"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import type {
  Bridge,
  BridgeGovernance,
  BridgeVaultStatusHarness,
  MockMigrationDebtVault,
  MockPartialMigrationDebtVault,
  MockRevertingMigrationDebtVault,
  MockTrustedNonConformingVault,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"

const { ethers, waffle } = hre

const SATOSHI_MULTIPLIER = ethers.BigNumber.from(10).pow(10)

const bridgeVaultGuardErrorsInterface = new ethers.utils.Interface([
  "error MigrationDebtVaultInterfaceMissing(address vault)",
  "error MigrationDebtVaultUnreachable(address vault)",
  "error PreviousMigrationDebtVaultHasDebt(address vault)",
  "error PreviousMigrationDebtVaultHasOptimisticDebt(address vault)",
  "error VaultHasOutstandingMigrationDebt(address vault)",
  "error VaultHasOutstandingOptimisticMintingDebt(address vault)",
  "error VaultIsCanonicalMigrationDebtVault(address vault)",
])

type BridgeVaultGuardError =
  | "MigrationDebtVaultInterfaceMissing"
  | "MigrationDebtVaultUnreachable"
  | "PreviousMigrationDebtVaultHasDebt"
  | "PreviousMigrationDebtVaultHasOptimisticDebt"
  | "VaultHasOutstandingMigrationDebt"
  | "VaultHasOutstandingOptimisticMintingDebt"
  | "VaultIsCanonicalMigrationDebtVault"

function getRevertData(error: unknown): string[] {
  const data: string[] = []
  const candidates: unknown[] = [error]

  while (candidates.length > 0) {
    const candidate = candidates.shift()

    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>
      if (typeof record.data === "string") {
        data.push(record.data)
      }
      if (record.data && typeof record.data === "object") {
        candidates.push(record.data)
      }
      if (record.error && typeof record.error === "object") {
        candidates.push(record.error)
      }
    }
  }

  return data
}

async function expectBridgeVaultGuardError(
  txPromise: Promise<unknown>,
  errorName: BridgeVaultGuardError,
  vaultAddress: string
): Promise<void> {
  try {
    await txPromise
    expect.fail(`expected revert with custom error ${errorName}`)
  } catch (error) {
    const revertData = getRevertData(error).find((data) => {
      try {
        bridgeVaultGuardErrorsInterface.decodeErrorResult(errorName, data)
        return true
      } catch (_) {
        return false
      }
    })

    expect(revertData, "revert data").to.not.equal(undefined)

    const [decodedVault] = bridgeVaultGuardErrorsInterface.decodeErrorResult(
      errorName,
      revertData as string
    )
    expect(decodedVault).to.equal(vaultAddress)
  }
}

describe("Bridge - Canonical migration debt vault guard", () => {
  let harness: BridgeVaultStatusHarness
  let vault: MockMigrationDebtVault
  let rotatedVault: MockMigrationDebtVault
  let partialVault: MockPartialMigrationDebtVault

  beforeEach(async () => {
    const HarnessFactory = await ethers.getContractFactory(
      "BridgeVaultStatusHarness"
    )
    harness = await HarnessFactory.deploy()

    const MockVaultFactory = await ethers.getContractFactory(
      "MockMigrationDebtVault"
    )
    vault = (await MockVaultFactory.deploy()) as MockMigrationDebtVault
    rotatedVault = (await MockVaultFactory.deploy()) as MockMigrationDebtVault

    const MockPartialVaultFactory = await ethers.getContractFactory(
      "MockPartialMigrationDebtVault"
    )
    partialVault =
      (await MockPartialVaultFactory.deploy()) as MockPartialMigrationDebtVault
  })

  it("reverts when untrusting the canonical migration debt vault", async () => {
    await harness.setVaultStatus(vault.address, true)
    await harness.setMigrationDebtVault(vault.address)

    await expectBridgeVaultGuardError(
      harness.setVaultStatus(vault.address, false),
      "VaultIsCanonicalMigrationDebtVault",
      vault.address
    )
  })

  it("allows untrusting a vault after clearing the canonical migration debt vault", async () => {
    await harness.setVaultStatus(vault.address, true)
    await harness.setMigrationDebtVault(vault.address)
    await harness.setMigrationDebtVault(ethers.constants.AddressZero)

    await expect(harness.setVaultStatus(vault.address, false))
      .to.emit(harness, "VaultStatusUpdated")
      .withArgs(vault.address, false)
    expect(await harness.isVaultTrusted(vault.address)).to.equal(false)
  })

  it("rotates canonical migration debt vault and untrusts previous vault atomically", async () => {
    await harness.setVaultStatus(vault.address, true)
    await harness.setVaultStatus(rotatedVault.address, true)
    await harness.setMigrationDebtVault(vault.address)

    await expect(
      harness.rotateMigrationDebtVault(rotatedVault.address, vault.address)
    )
      .to.emit(harness, "MigrationDebtVaultUpdated")
      .withArgs(rotatedVault.address)
      .and.to.emit(harness, "VaultStatusUpdated")
      .withArgs(vault.address, false)

    expect(await harness.migrationDebtVault()).to.equal(rotatedVault.address)
    expect(await harness.isVaultTrusted(vault.address)).to.equal(false)
    expect(await harness.isVaultTrusted(rotatedVault.address)).to.equal(true)
  })

  it("reverts when set target does not implement the migration debt interface", async () => {
    // EOA-shaped address has no code -> staticcall fails -> probe rejects.
    const eoaLike = "0x2553E09f832c9f5C656808bb7A24793818877732"
    await harness.setVaultStatus(eoaLike, true)

    await expectBridgeVaultGuardError(
      harness.setMigrationDebtVault(eoaLike),
      "MigrationDebtVaultInterfaceMissing",
      eoaLike
    )
  })

  it("reverts when set target implements only the outstanding-debt selector", async () => {
    await harness.setVaultStatus(partialVault.address, true)

    await expectBridgeVaultGuardError(
      harness.setMigrationDebtVault(partialVault.address),
      "MigrationDebtVaultInterfaceMissing",
      partialVault.address
    )
  })

  it("reverts when overwriting a canonical vault with outstanding debt", async () => {
    const [, revealer] = await ethers.getSigners()

    await harness.setVaultStatus(vault.address, true)
    await harness.setVaultStatus(rotatedVault.address, true)
    await harness.setMigrationDebtVault(vault.address)

    // Register debt on the current canonical vault.
    await vault.registerMigrationDebt(revealer.address, 1)

    await expectBridgeVaultGuardError(
      harness.setMigrationDebtVault(rotatedVault.address),
      "PreviousMigrationDebtVaultHasDebt",
      vault.address
    )
  })

  it("allows emergency disable when current canonical vault is bricked", async () => {
    // Stand up a vault, set it as canonical, then make it stop answering by
    // pointing the trust list at a non-conforming address — but since the
    // canonical pointer still points at the working vault, the fail-open
    // staticcall in the previous-vault debt guard returns false (no debt),
    // so emergency disable to address(0) succeeds.
    await harness.setVaultStatus(vault.address, true)
    await harness.setMigrationDebtVault(vault.address)

    await expect(harness.setMigrationDebtVault(ethers.constants.AddressZero))
      .to.emit(harness, "MigrationDebtVaultUpdated")
      .withArgs(ethers.constants.AddressZero)

    expect(await harness.migrationDebtVault()).to.equal(
      ethers.constants.AddressZero
    )
  })

  it("reverts when untrusting a vault with outstanding optimistic minting debt", async () => {
    await harness.setVaultStatus(vault.address, true)
    await vault.setHasOutstandingOptimisticMintingDebt(true)

    await expectBridgeVaultGuardError(
      harness.setVaultStatus(vault.address, false),
      "VaultHasOutstandingOptimisticMintingDebt",
      vault.address
    )
    expect(await harness.isVaultTrusted(vault.address)).to.equal(true)
  })

  it("allows untrusting a vault once optimistic minting debt is cleared", async () => {
    await harness.setVaultStatus(vault.address, true)
    await vault.setHasOutstandingOptimisticMintingDebt(true)
    await vault.setHasOutstandingOptimisticMintingDebt(false)

    await expect(harness.setVaultStatus(vault.address, false))
      .to.emit(harness, "VaultStatusUpdated")
      .withArgs(vault.address, false)
    expect(await harness.isVaultTrusted(vault.address)).to.equal(false)
  })

  it("reverts rotating away from a vault with outstanding optimistic minting debt", async () => {
    await harness.setVaultStatus(vault.address, true)
    await harness.setVaultStatus(rotatedVault.address, true)
    await harness.setMigrationDebtVault(vault.address)
    await vault.setHasOutstandingOptimisticMintingDebt(true)

    await expectBridgeVaultGuardError(
      harness.rotateMigrationDebtVault(rotatedVault.address, vault.address),
      "PreviousMigrationDebtVaultHasOptimisticDebt",
      vault.address
    )
    expect(await harness.migrationDebtVault()).to.equal(vault.address)
    expect(await harness.isVaultTrusted(vault.address)).to.equal(true)
  })

  it("allows rotation once the previous vault optimistic minting debt is cleared", async () => {
    await harness.setVaultStatus(vault.address, true)
    await harness.setVaultStatus(rotatedVault.address, true)
    await harness.setMigrationDebtVault(vault.address)
    await vault.setHasOutstandingOptimisticMintingDebt(true)
    await vault.setHasOutstandingOptimisticMintingDebt(false)

    await expect(
      harness.rotateMigrationDebtVault(rotatedVault.address, vault.address)
    )
      .to.emit(harness, "MigrationDebtVaultUpdated")
      .withArgs(rotatedVault.address)
      .and.to.emit(harness, "VaultStatusUpdated")
      .withArgs(vault.address, false)
    expect(await harness.migrationDebtVault()).to.equal(rotatedVault.address)
    expect(await harness.isVaultTrusted(vault.address)).to.equal(false)
  })

  it("treats a vault that reverts on the optimistic-debt staticcall as having no debt (fail-open untrust)", async () => {
    const MockRevertingVaultFactory = await ethers.getContractFactory(
      "MockRevertingMigrationDebtVault"
    )
    const revertingVault = await MockRevertingVaultFactory.deploy()

    await harness.setVaultStatus(revertingVault.address, true)
    // Vault would report optimistic debt, but its staticcall reverts.
    await revertingVault.setHasOutstandingOptimisticMintingDebt(true)
    await revertingVault.setReverting(true)

    await expect(harness.setVaultStatus(revertingVault.address, false))
      .to.emit(harness, "VaultStatusUpdated")
      .withArgs(revertingVault.address, false)
    expect(await harness.isVaultTrusted(revertingVault.address)).to.equal(false)
  })
})

describe("rotateMigrationDebtVault interface probe", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge
  let bridgeGovernance: BridgeGovernance
  let previousVault: MockMigrationDebtVault
  let conformingVault: MockMigrationDebtVault
  let partialVault: MockPartialMigrationDebtVault
  let nonConformingVault: MockTrustedNonConformingVault

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, bridge, bridgeGovernance } =
      await waffle.loadFixture(bridgeFixture))

    const MockVaultFactory = await ethers.getContractFactory(
      "MockMigrationDebtVault"
    )
    previousVault = (await MockVaultFactory.deploy()) as MockMigrationDebtVault
    conformingVault =
      (await MockVaultFactory.deploy()) as MockMigrationDebtVault

    const MockPartialVaultFactory = await ethers.getContractFactory(
      "MockPartialMigrationDebtVault"
    )
    partialVault =
      (await MockPartialVaultFactory.deploy()) as MockPartialMigrationDebtVault

    const NonConformingVaultFactory = await ethers.getContractFactory(
      "MockTrustedNonConformingVault"
    )
    nonConformingVault =
      (await NonConformingVaultFactory.deploy()) as MockTrustedNonConformingVault

    await bridgeGovernance
      .connect(governance)
      .setVaultStatus(previousVault.address, true)
    await bridgeGovernance
      .connect(governance)
      .setMigrationDebtVault(previousVault.address)
  })

  it("reverts with MigrationDebtVaultInterfaceMissing when new vault is trusted but lacks the interface", async () => {
    await bridgeGovernance
      .connect(governance)
      .setVaultStatus(nonConformingVault.address, true)

    await expectBridgeVaultGuardError(
      bridgeGovernance
        .connect(governance)
        .rotateMigrationDebtVault(
          nonConformingVault.address,
          previousVault.address
        ),
      "MigrationDebtVaultInterfaceMissing",
      nonConformingVault.address
    )
  })

  it("reverts with MigrationDebtVaultInterfaceMissing when new vault implements only the outstanding-debt selector", async () => {
    await bridgeGovernance
      .connect(governance)
      .setVaultStatus(partialVault.address, true)

    await expectBridgeVaultGuardError(
      bridgeGovernance
        .connect(governance)
        .rotateMigrationDebtVault(partialVault.address, previousVault.address),
      "MigrationDebtVaultInterfaceMissing",
      partialVault.address
    )
  })

  it("reverts with MigrationDebtVaultInterfaceMissing when new vault is an EOA", async () => {
    await bridgeGovernance
      .connect(governance)
      .setVaultStatus(thirdParty.address, true)

    await expectBridgeVaultGuardError(
      bridgeGovernance
        .connect(governance)
        .rotateMigrationDebtVault(thirdParty.address, previousVault.address),
      "MigrationDebtVaultInterfaceMissing",
      thirdParty.address
    )
  })

  it("succeeds when new vault is address(0)", async () => {
    await expect(
      bridgeGovernance
        .connect(governance)
        .rotateMigrationDebtVault(
          ethers.constants.AddressZero,
          previousVault.address
        )
    )
      .to.emit(bridge, "MigrationDebtVaultUpdated")
      .withArgs(ethers.constants.AddressZero)
      .and.to.emit(bridge, "VaultStatusUpdated")
      .withArgs(previousVault.address, false)

    expect(await bridge.migrationDebtVault()).to.equal(
      ethers.constants.AddressZero
    )
    expect(await bridge.isVaultTrusted(previousVault.address)).to.equal(false)
  })

  it("succeeds when new vault implements the full interface", async () => {
    await bridgeGovernance
      .connect(governance)
      .setVaultStatus(conformingVault.address, true)

    await expect(
      bridgeGovernance
        .connect(governance)
        .rotateMigrationDebtVault(
          conformingVault.address,
          previousVault.address
        )
    )
      .to.emit(bridge, "MigrationDebtVaultUpdated")
      .withArgs(conformingVault.address)
      .and.to.emit(bridge, "VaultStatusUpdated")
      .withArgs(previousVault.address, false)

    expect(await bridge.migrationDebtVault()).to.equal(conformingVault.address)
    expect(await bridge.isVaultTrusted(previousVault.address)).to.equal(false)
    expect(await bridge.isVaultTrusted(conformingVault.address)).to.equal(true)
  })
})

describe("setMigrationDebtVault outgoing-debt guard - fail-closed", () => {
  let harness: BridgeVaultStatusHarness
  let previousVault: MockMigrationDebtVault
  let newVault: MockMigrationDebtVault
  let revertingVault: MockRevertingMigrationDebtVault

  beforeEach(async () => {
    const HarnessFactory = await ethers.getContractFactory(
      "BridgeVaultStatusHarness"
    )
    harness = await HarnessFactory.deploy()

    const MockVaultFactory = await ethers.getContractFactory(
      "MockMigrationDebtVault"
    )
    previousVault = await MockVaultFactory.deploy()
    newVault = await MockVaultFactory.deploy()

    const MockRevertingVaultFactory = await ethers.getContractFactory(
      "MockRevertingMigrationDebtVault"
    )
    revertingVault = await MockRevertingVaultFactory.deploy()

    await harness.setVaultStatus(previousVault.address, true)
    await harness.setVaultStatus(newVault.address, true)
    await harness.setVaultStatus(revertingVault.address, true)
  })

  it("reverts with MigrationDebtVaultUnreachable when previous canonical vault staticcall fails", async () => {
    await harness.setMigrationDebtVault(revertingVault.address)
    await revertingVault.setReverting(true)

    await expectBridgeVaultGuardError(
      harness.setMigrationDebtVault(newVault.address),
      "MigrationDebtVaultUnreachable",
      revertingVault.address
    )

    expect(await harness.migrationDebtVault()).to.equal(revertingVault.address)
  })

  it("reverts with PreviousMigrationDebtVaultHasDebt when previous answers true", async () => {
    const [, revealer] = await ethers.getSigners()

    await previousVault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(1)
    )
    await harness.setMigrationDebtVault(previousVault.address)

    await expectBridgeVaultGuardError(
      harness.setMigrationDebtVault(newVault.address),
      "PreviousMigrationDebtVaultHasDebt",
      previousVault.address
    )

    expect(await harness.migrationDebtVault()).to.equal(previousVault.address)
  })

  it("succeeds when previous answers false", async () => {
    await harness.setMigrationDebtVault(previousVault.address)

    await expect(harness.setMigrationDebtVault(newVault.address))
      .to.emit(harness, "MigrationDebtVaultUpdated")
      .withArgs(newVault.address)

    expect(await harness.migrationDebtVault()).to.equal(newVault.address)
  })

  it("succeeds for the emergency-disable lane", async () => {
    await harness.setMigrationDebtVault(revertingVault.address)
    await revertingVault.setReverting(true)

    await expect(harness.setMigrationDebtVault(ethers.constants.AddressZero))
      .to.emit(harness, "MigrationDebtVaultUpdated")
      .withArgs(ethers.constants.AddressZero)

    expect(await harness.migrationDebtVault()).to.equal(
      ethers.constants.AddressZero
    )
  })
})

describe("Bridge - Migration debt drain guard", () => {
  let harness: BridgeVaultStatusHarness
  let previousVault: MockMigrationDebtVault
  let newVault: MockMigrationDebtVault

  beforeEach(async () => {
    const [, revealer] = await ethers.getSigners()

    const HarnessFactory = await ethers.getContractFactory(
      "BridgeVaultStatusHarness"
    )
    harness = await HarnessFactory.deploy()

    const MockVaultFactory = await ethers.getContractFactory(
      "MockMigrationDebtVault"
    )
    previousVault = await MockVaultFactory.deploy()
    newVault = await MockVaultFactory.deploy()

    // Trust both vaults via the harness
    await harness.setVaultStatus(previousVault.address, true)
    await harness.setVaultStatus(newVault.address, true)
  })

  describe("rotateMigrationDebtVault", () => {
    it("reverts when previous vault has outstanding migration debt", async () => {
      const [, revealer] = await ethers.getSigners()

      // Register debt on the previous vault so it has outstanding debt
      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(100)
      )

      // Set previous vault as canonical migration debt vault
      await harness.setMigrationDebtVault(previousVault.address)

      // Rotation should revert because previous vault has outstanding debt
      await expectBridgeVaultGuardError(
        harness.rotateMigrationDebtVault(
          newVault.address,
          previousVault.address
        ),
        "PreviousMigrationDebtVaultHasDebt",
        previousVault.address
      )
    })

    it("succeeds when previous vault is fully drained", async () => {
      const [, revealer] = await ethers.getSigners()

      // Register and then fully repay debt so vault is drained
      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(100)
      )
      await previousVault.repayMigrationDebt(revealer.address)

      // Set previous vault as canonical migration debt vault
      await harness.setMigrationDebtVault(previousVault.address)

      // Rotation should succeed because previous vault is fully drained
      await expect(
        harness.rotateMigrationDebtVault(
          newVault.address,
          previousVault.address
        )
      )
        .to.emit(harness, "MigrationDebtVaultUpdated")
        .withArgs(newVault.address)
        .and.to.emit(harness, "VaultStatusUpdated")
        .withArgs(previousVault.address, false)

      expect(await harness.migrationDebtVault()).to.equal(newVault.address)
      expect(await harness.isVaultTrusted(previousVault.address)).to.equal(
        false
      )
      expect(await harness.isVaultTrusted(newVault.address)).to.equal(true)
    })
  })

  describe("setVaultStatus - two-step bypass prevention", () => {
    it("reverts when untrusting a vault with outstanding migration debt", async () => {
      const [, revealer] = await ethers.getSigners()

      // Register debt on the previous vault, then set it as canonical.
      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(50)
      )
      await harness.setMigrationDebtVault(previousVault.address)

      // The two-step bypass (setMigrationDebtVault away, then setVaultStatus
      // false) is now blocked at step 1: setMigrationDebtVault refuses to
      // overwrite a canonical vault with outstanding debt.
      await expectBridgeVaultGuardError(
        harness.setMigrationDebtVault(newVault.address),
        "PreviousMigrationDebtVaultHasDebt",
        previousVault.address
      )

      // The setVaultStatus drain guard still rejects untrust of the canonical
      // vault directly (the existing pre-PR canonical-vault guard).
      await expectBridgeVaultGuardError(
        harness.setVaultStatus(previousVault.address, false),
        "VaultIsCanonicalMigrationDebtVault",
        previousVault.address
      )
    })

    it("allows trust and untrust for non-migration-debt vaults", async () => {
      // Use a plain address (not a contract implementing ITBTCVaultMigrationDebt)
      const plainVault = "0x1111111111111111111111111111111111111111"

      // Trust the plain vault
      await expect(harness.setVaultStatus(plainVault, true))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(plainVault, true)
      expect(await harness.isVaultTrusted(plainVault)).to.equal(true)

      // Untrust the plain vault -- should succeed without interference
      await expect(harness.setVaultStatus(plainVault, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(plainVault, false)
      expect(await harness.isVaultTrusted(plainVault)).to.equal(false)
    })

    it("blocks setMigrationDebtVault rewrite while the current canonical has debt", async () => {
      const [, revealer] = await ethers.getSigners()

      // Register debt on the previous vault and set it as canonical.
      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(200)
      )
      await harness.setMigrationDebtVault(previousVault.address)

      // Attempting to bypass via setMigrationDebtVault(newVault) is rejected
      // because the previous canonical vault still owes debt -- governance
      // must use rotateMigrationDebtVault (which itself enforces the debt
      // drain guard before atomically untrusting the previous vault).
      await expectBridgeVaultGuardError(
        harness.setMigrationDebtVault(newVault.address),
        "PreviousMigrationDebtVaultHasDebt",
        previousVault.address
      )

      // The previous vault remains canonical and trusted.
      expect(await harness.migrationDebtVault()).to.equal(previousVault.address)
      expect(await harness.isVaultTrusted(previousVault.address)).to.equal(true)
    })

    it("allows rotation after vault debt is fully cleared", async () => {
      const [, revealer] = await ethers.getSigners()

      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(75)
      )
      await harness.setMigrationDebtVault(previousVault.address)

      // Fully repay the debt before attempting to rotate canonical away.
      await previousVault.repayMigrationDebt(revealer.address)

      // Now setMigrationDebtVault(new) succeeds because previous has no debt.
      await expect(harness.setMigrationDebtVault(newVault.address))
        .to.emit(harness, "MigrationDebtVaultUpdated")
        .withArgs(newVault.address)

      // And the previous vault can be untrusted because it has no debt and
      // is no longer canonical.
      await expect(harness.setVaultStatus(previousVault.address, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(previousVault.address, false)
      expect(await harness.isVaultTrusted(previousVault.address)).to.equal(
        false
      )
    })

    it("allows rotation after residual debt is administratively cleared", async () => {
      const [, revealer] = await ethers.getSigners()

      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(75)
      )
      await previousVault.setMigrationRevealer(revealer.address, true)
      await harness.setMigrationDebtVault(previousVault.address)

      // Administratively clear the debt before rotation.
      await previousVault.clearMigrationDebt(revealer.address)

      await expect(harness.setMigrationDebtVault(newVault.address))
        .to.emit(harness, "MigrationDebtVaultUpdated")
        .withArgs(newVault.address)

      await expect(harness.setVaultStatus(previousVault.address, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(previousVault.address, false)
      expect(await harness.isVaultTrusted(previousVault.address)).to.equal(
        false
      )
    })
  })
})
