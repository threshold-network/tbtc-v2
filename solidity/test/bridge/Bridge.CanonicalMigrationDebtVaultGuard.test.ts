import { expect } from "chai"
import hre from "hardhat"

import type {
  BridgeVaultStatusHarness,
  MockMigrationDebtVault,
} from "../../typechain"

const { ethers } = hre

const SATOSHI_MULTIPLIER = ethers.BigNumber.from(10).pow(10)

describe("Bridge - Canonical migration debt vault guard", () => {
  let harness: BridgeVaultStatusHarness
  let vault: MockMigrationDebtVault
  let rotatedVault: MockMigrationDebtVault

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
  })

  it("reverts when untrusting the canonical migration debt vault", async () => {
    await harness.setVaultStatus(vault.address, true)
    await harness.setMigrationDebtVault(vault.address)

    await expect(
      harness.setVaultStatus(vault.address, false)
    ).to.be.revertedWith("Vault is canonical migration debt vault")
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

    await expect(harness.setMigrationDebtVault(eoaLike)).to.be.revertedWith(
      "Vault does not implement migration debt interface"
    )
  })

  it("reverts when overwriting a canonical vault with outstanding debt", async () => {
    const [, revealer] = await ethers.getSigners()

    await harness.setVaultStatus(vault.address, true)
    await harness.setVaultStatus(rotatedVault.address, true)
    await harness.setMigrationDebtVault(vault.address)

    // Register debt on the current canonical vault.
    await vault.registerMigrationDebt(revealer.address, 1)

    await expect(
      harness.setMigrationDebtVault(rotatedVault.address)
    ).to.be.revertedWith(
      "Use rotateMigrationDebtVault when outstanding debt exists"
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
      await expect(
        harness.rotateMigrationDebtVault(
          newVault.address,
          previousVault.address
        )
      ).to.be.revertedWith("Previous vault has outstanding migration debt")
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
      await expect(
        harness.setMigrationDebtVault(newVault.address)
      ).to.be.revertedWith(
        "Use rotateMigrationDebtVault when outstanding debt exists"
      )

      // The setVaultStatus drain guard still rejects untrust of the canonical
      // vault directly (the existing pre-PR canonical-vault guard).
      await expect(
        harness.setVaultStatus(previousVault.address, false)
      ).to.be.revertedWith("Vault is canonical migration debt vault")
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
      await expect(
        harness.setMigrationDebtVault(newVault.address)
      ).to.be.revertedWith(
        "Use rotateMigrationDebtVault when outstanding debt exists"
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
