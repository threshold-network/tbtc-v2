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

  const vault = "0x2553E09f832c9f5C656808bb7A24793818877732"
  const rotatedVault = "0x8f485c7cc57f17f853f6dd2d807cc96d2aeb2729"

  beforeEach(async () => {
    const HarnessFactory = await ethers.getContractFactory(
      "BridgeVaultStatusHarness"
    )
    harness = await HarnessFactory.deploy()
  })

  it("reverts when untrusting the canonical migration debt vault", async () => {
    await harness.setVaultStatus(vault, true)
    await harness.setMigrationDebtVault(vault)

    await expect(harness.setVaultStatus(vault, false)).to.be.revertedWith(
      "Vault is canonical migration debt vault"
    )
  })

  it("allows untrusting a vault after clearing the canonical migration debt vault", async () => {
    await harness.setVaultStatus(vault, true)
    await harness.setMigrationDebtVault(vault)
    await harness.setMigrationDebtVault(ethers.constants.AddressZero)

    await expect(harness.setVaultStatus(vault, false))
      .to.emit(harness, "VaultStatusUpdated")
      .withArgs(vault, false)
    expect(await harness.isVaultTrusted(vault)).to.equal(false)
  })

  it("rotates canonical migration debt vault and untrusts previous vault atomically", async () => {
    await harness.setVaultStatus(vault, true)
    await harness.setVaultStatus(rotatedVault, true)
    await harness.setMigrationDebtVault(vault)

    await expect(harness.rotateMigrationDebtVault(rotatedVault, vault))
      .to.emit(harness, "MigrationDebtVaultUpdated")
      .withArgs(rotatedVault)
      .and.to.emit(harness, "VaultStatusUpdated")
      .withArgs(vault, false)

    expect(await harness.migrationDebtVault()).to.equal(
      ethers.utils.getAddress(rotatedVault)
    )
    expect(await harness.isVaultTrusted(vault)).to.equal(false)
    expect(await harness.isVaultTrusted(rotatedVault)).to.equal(true)
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

      // Register debt on the previous vault
      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(50)
      )

      // Set previous vault as canonical, then change canonical to new vault
      await harness.setMigrationDebtVault(previousVault.address)
      await harness.setMigrationDebtVault(newVault.address)

      // Attempt to untrust old vault -- should revert because it has debt
      await expect(
        harness.setVaultStatus(previousVault.address, false)
      ).to.be.revertedWith("Vault has outstanding migration debt")
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

    it("blocks two-step bypass: setMigrationDebtVault + setVaultStatus", async () => {
      const [, revealer] = await ethers.getSigners()

      // Register debt on the previous vault
      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(200)
      )

      // Step 1 of the attack: set vault as canonical
      await harness.setMigrationDebtVault(previousVault.address)

      // Step 2 of the attack: change canonical pointer away
      await harness.setMigrationDebtVault(newVault.address)

      // Step 3 of the attack: untrust the old vault with outstanding debt
      // This should be blocked by the migration debt drain guard
      await expect(
        harness.setVaultStatus(previousVault.address, false)
      ).to.be.revertedWith("Vault has outstanding migration debt")

      // Vault must remain trusted since untrust was blocked
      expect(await harness.isVaultTrusted(previousVault.address)).to.equal(true)
    })

    it("allows untrusting after vault debt is fully cleared", async () => {
      const [, revealer] = await ethers.getSigners()

      // Register debt, set as canonical, then move canonical away
      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(75)
      )
      await harness.setMigrationDebtVault(previousVault.address)
      await harness.setMigrationDebtVault(newVault.address)

      // Fully repay the debt
      await previousVault.repayMigrationDebt(revealer.address)

      // Now untrusting should succeed because debt is cleared
      await expect(harness.setVaultStatus(previousVault.address, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(previousVault.address, false)
      expect(await harness.isVaultTrusted(previousVault.address)).to.equal(
        false
      )
    })

    it("allows untrusting after residual debt is administratively cleared", async () => {
      const [, revealer] = await ethers.getSigners()

      await previousVault.registerMigrationDebt(
        revealer.address,
        SATOSHI_MULTIPLIER.mul(75)
      )
      await previousVault.setMigrationRevealer(revealer.address, true)

      await harness.setMigrationDebtVault(previousVault.address)
      await harness.setMigrationDebtVault(newVault.address)

      await previousVault.clearMigrationDebt(revealer.address)

      await expect(harness.setVaultStatus(previousVault.address, false))
        .to.emit(harness, "VaultStatusUpdated")
        .withArgs(previousVault.address, false)
      expect(await harness.isVaultTrusted(previousVault.address)).to.equal(
        false
      )
    })
  })
})
