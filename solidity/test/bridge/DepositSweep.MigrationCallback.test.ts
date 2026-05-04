import { expect } from "chai"
import hardhat from "hardhat"

import type {
  DepositSweepCallbackHarness,
  MockMigrationSweepVault,
} from "../../typechain"

const { ethers } = hardhat

describe("DepositSweep - Migration callback", () => {
  async function deployFixture(): Promise<{
    harness: DepositSweepCallbackHarness
    vault: MockMigrationSweepVault
  }> {
    const HarnessFactory = await ethers.getContractFactory(
      "DepositSweepCallbackHarness"
    )
    const harness =
      (await HarnessFactory.deploy()) as DepositSweepCallbackHarness

    const VaultFactory = await ethers.getContractFactory(
      "MockMigrationSweepVault"
    )
    const vault = (await VaultFactory.deploy()) as MockMigrationSweepVault

    return { harness, vault }
  }

  it("notifies the canonical migration debt vault callback with the sweep tx hash and revealers", async () => {
    const { harness, vault } = await deployFixture()
    const [revealer] = await ethers.getSigners()
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("deposit-sweep-migration")
    )

    await harness.setMigrationDebtVault(vault.address)
    await harness.notifyMigrationSweepCallback(vault.address, sweepTxHash, [
      revealer.address,
    ])

    expect(await vault.migrationSweepNotificationCalls()).to.equal(1)
    expect(await vault.lastSweepTxHash()).to.equal(sweepTxHash)
    expect(await vault.lastSweepRevealersHash()).to.equal(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(["address[]"], [[revealer.address]])
      )
    )
  })

  it("skips the callback for non-canonical vaults", async () => {
    const { harness, vault } = await deployFixture()
    const [revealer, otherVault] = await ethers.getSigners()
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("deposit-sweep-non-canonical")
    )

    await harness.setMigrationDebtVault(otherVault.address)
    await harness.notifyMigrationSweepCallback(vault.address, sweepTxHash, [
      revealer.address,
    ])

    expect(await vault.migrationSweepNotificationCalls()).to.equal(0)
  })

  it("fails open, emits an event, and retries revealers individually when the batch callback reverts", async () => {
    const { harness, vault } = await deployFixture()
    const [revealer] = await ethers.getSigners()
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("deposit-sweep-callback-failure")
    )

    await harness.setMigrationDebtVault(vault.address)
    await vault.setShouldRevertMigrationSweepBatchHook(true)

    await expect(
      harness.notifyMigrationSweepCallback(vault.address, sweepTxHash, [
        revealer.address,
      ])
    )
      .to.emit(harness, "MigrationSweepCallbackFailed")
      .withArgs(vault.address, sweepTxHash)

    expect(await vault.migrationSweepNotificationCalls()).to.equal(1)
    expect(await vault.lastSweepTxHash()).to.equal(sweepTxHash)
    expect(await vault.lastSweepRevealersHash()).to.equal(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(["address[]"], [[revealer.address]])
      )
    )
  })

  it("emits per-revealer retry failures when batch and single callbacks both revert", async () => {
    const { harness, vault } = await deployFixture()
    const [revealer] = await ethers.getSigners()
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("deposit-sweep-retry-failure")
    )

    await harness.setMigrationDebtVault(vault.address)
    await vault.setShouldRevertMigrationSweepHook(true)

    await expect(
      harness.notifyMigrationSweepCallback(vault.address, sweepTxHash, [
        revealer.address,
      ])
    )
      .to.emit(harness, "MigrationSweepCallbackRetryFailed")
      .withArgs(vault.address, sweepTxHash, revealer.address)

    expect(await vault.migrationSweepNotificationCalls()).to.equal(0)
  })
})
