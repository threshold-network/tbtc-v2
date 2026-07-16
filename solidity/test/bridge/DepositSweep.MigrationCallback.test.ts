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

  it("chunks oversized revealer arrays into batches of at most 100", async () => {
    const { harness, vault } = await deployFixture()
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("deposit-sweep-chunked")
    )

    // 150 distinct revealer addresses force the callback to issue two
    // batch hook invocations (100 + 50) instead of a single oversized
    // call that the vault would reject.
    const oversizedRevealers = Array.from({ length: 150 }, (_, i) =>
      ethers.utils.hexZeroPad(ethers.utils.hexlify(i + 1), 20)
    )

    await harness.setMigrationDebtVault(vault.address)
    await harness.notifyMigrationSweepCallback(
      vault.address,
      sweepTxHash,
      oversizedRevealers
    )

    expect(await vault.migrationSweepNotificationCalls()).to.equal(2)
    expect(await vault.lastSweepTxHash()).to.equal(sweepTxHash)
    // The mock records only the most recent batch; verify the last chunk
    // contains exactly the trailing 50 revealers.
    const tailChunk = oversizedRevealers.slice(100)
    expect(await vault.lastSweepRevealersHash()).to.equal(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(["address[]"], [tailChunk])
      )
    )
  })

  it("falls back per revealer only within the failing chunk", async () => {
    const { harness, vault } = await deployFixture()
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("deposit-sweep-chunked-fallback")
    )

    const oversizedRevealers = Array.from({ length: 150 }, (_, i) =>
      ethers.utils.hexZeroPad(ethers.utils.hexlify(i + 1), 20)
    )

    await harness.setMigrationDebtVault(vault.address)
    // Reverting the batch hook forces every chunk to fall back to the
    // single-revealer hook for its own entries.
    await vault.setShouldRevertMigrationSweepBatchHook(true)

    const tx = await harness.notifyMigrationSweepCallback(
      vault.address,
      sweepTxHash,
      oversizedRevealers
    )
    const receipt = await tx.wait()

    const failedTopic = harness.interface.getEventTopic(
      "MigrationSweepCallbackFailed"
    )
    const retryFailedTopic = harness.interface.getEventTopic(
      "MigrationSweepCallbackRetryFailed"
    )
    const failedEvents = receipt.logs.filter(
      ({ address, topics }) =>
        address === harness.address && topics[0] === failedTopic
    )
    const retryFailedEvents = receipt.logs.filter(
      ({ address, topics }) =>
        address === harness.address && topics[0] === retryFailedTopic
    )

    // One batch failure per chunk (150 revealers = 2 chunks).
    expect(failedEvents.length).to.equal(2)
    // Every revealer falls back to the single hook successfully (the
    // single hook is not configured to revert), so no retry-failure
    // events are emitted.
    expect(retryFailedEvents.length).to.equal(0)
    // The mock's batch hook reverts before incrementing its counter, so
    // only the 150 successful single-revealer retries are recorded.
    expect(await vault.migrationSweepNotificationCalls()).to.equal(150)
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

  it("completes the downstream migration sweep on operational retry after both hooks revert", async () => {
    const { harness, vault } = await deployFixture()
    const [revealer] = await ethers.getSigners()
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("deposit-sweep-operational-retry")
    )

    await harness.setMigrationDebtVault(vault.address)

    // Both the batch and per-revealer hooks revert (e.g. the downstream
    // notifier is temporarily reverting). The sweep proof stays fail-open and
    // both actionable alert events fire; no downstream notification lands.
    await vault.setShouldRevertMigrationSweepHook(true)
    const failTx = await harness.notifyMigrationSweepCallback(
      vault.address,
      sweepTxHash,
      [revealer.address]
    )
    await expect(failTx)
      .to.emit(harness, "MigrationSweepCallbackFailed")
      .withArgs(vault.address, sweepTxHash)
    await expect(failTx)
      .to.emit(harness, "MigrationSweepCallbackRetryFailed")
      .withArgs(vault.address, sweepTxHash, revealer.address)
    expect(await vault.migrationSweepNotificationCalls()).to.equal(0)

    // The operator clears the downstream failure and retries; the downstream
    // state transition now completes.
    await vault.setShouldRevertMigrationSweepHook(false)
    await harness.notifyMigrationSweepCallback(vault.address, sweepTxHash, [
      revealer.address,
    ])
    expect(await vault.migrationSweepNotificationCalls()).to.equal(1)
  })
})
