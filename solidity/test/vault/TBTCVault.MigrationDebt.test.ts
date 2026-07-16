import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers } from "hardhat"
import { expect } from "chai"

import type {
  Bank,
  BridgeForVaultHarness,
  MockMigrationSweepNotifier,
  TBTC,
  TBTCVaultHarness,
} from "../../typechain"

const SATOSHI_MULTIPLIER = ethers.BigNumber.from(10).pow(10)

describe("TBTCVault - MigrationDebt", () => {
  let deployer: SignerWithAddress
  let revealer: SignerWithAddress
  let reserve: SignerWithAddress
  let outsider: SignerWithAddress
  let anotherRevealer: SignerWithAddress
  let anotherReserve: SignerWithAddress

  let bank: Bank
  let bridgeHarness: BridgeForVaultHarness
  let notifier: MockMigrationSweepNotifier
  let tbtc: TBTC
  let vault: TBTCVaultHarness

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[deployer, revealer, reserve, outsider, anotherRevealer, anotherReserve] =
      await ethers.getSigners()

    const BankFactory = await ethers.getContractFactory("Bank")
    bank = await BankFactory.deploy()

    const BridgeHarnessFactory = await ethers.getContractFactory(
      "BridgeForVaultHarness"
    )
    bridgeHarness = await BridgeHarnessFactory.deploy(deployer.address)

    const TBTCFactory = await ethers.getContractFactory("TBTC")
    tbtc = await TBTCFactory.deploy()

    const NotifierFactory = await ethers.getContractFactory(
      "MockMigrationSweepNotifier"
    )
    notifier = await NotifierFactory.deploy()

    const VaultFactory = await ethers.getContractFactory("TBTCVaultHarness")
    vault = await VaultFactory.deploy(
      bank.address,
      tbtc.address,
      bridgeHarness.address
    )
    await bridgeHarness.setMigrationDebtVault(vault.address)

    await tbtc.transferOwnership(vault.address)

    // For test purposes we route Bank bridge callbacks through the deployer.
    await bank.updateBridge(deployer.address)
  })

  it("implements canRevealMigration = isMigrationRevealer && migrationDebt > 0", async () => {
    expect(await vault.canRevealMigration(revealer.address)).to.equal(false)

    await vault.setMigrationRevealer(revealer.address, true)
    expect(await vault.canRevealMigration(revealer.address)).to.equal(false)

    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(2)
    )
    expect(await vault.canRevealMigration(revealer.address)).to.equal(true)

    await vault.clearMigrationDebt(revealer.address)
    expect(await vault.canRevealMigration(revealer.address)).to.equal(false)
  })

  it("reverts on zero migration debt registration", async () => {
    await expect(
      vault.registerMigrationDebt(revealer.address, 0)
    ).to.be.revertedWith("Amount must be greater than 0")
  })

  it("reverts when migration debt is registered twice for the same revealer", async () => {
    await vault.registerMigrationDebt(revealer.address, SATOSHI_MULTIPLIER)

    await expect(
      vault.registerMigrationDebt(revealer.address, SATOSHI_MULTIPLIER)
    ).to.be.revertedWith(
      "Migration debt already registered (counter invariant)"
    )
  })

  it("reverts migration debt registration when bridge migration debt vault is not this vault", async () => {
    await bridgeHarness.setMigrationDebtVault(ethers.constants.AddressZero)

    await expect(
      vault.registerMigrationDebt(revealer.address, SATOSHI_MULTIPLIER)
    ).to.be.revertedWith("Bridge migration debt vault mismatch")
  })

  it("reverts enabling migration revealer when bridge migration debt vault is not this vault", async () => {
    await bridgeHarness.setMigrationDebtVault(ethers.constants.AddressZero)

    await expect(
      vault.setMigrationRevealer(revealer.address, true)
    ).to.be.revertedWith("Bridge migration debt vault mismatch")
  })

  it("allows disabling migration revealer when bridge migration debt vault is not this vault", async () => {
    await vault.setMigrationRevealer(revealer.address, true)
    await bridgeHarness.setMigrationDebtVault(ethers.constants.AddressZero)

    await expect(vault.setMigrationRevealer(revealer.address, false)).to.not.be
      .reverted
  })

  it("repays optimistic debt first, then migration debt, then mints remainder", async () => {
    await vault.setOptimisticMintingDebtForTest(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(10)
    )
    await vault.setMigrationRevealer(revealer.address, true)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(5)
    )

    await bank.increaseBalanceAndCall(vault.address, [revealer.address], [12])

    expect(await vault.optimisticMintingDebt(revealer.address)).to.equal(0)
    expect(await vault.migrationDebt(revealer.address)).to.equal(
      SATOSHI_MULTIPLIER.mul(3)
    )
    expect(await tbtc.balanceOf(revealer.address)).to.equal(0)
  })

  it("mints only the residual amount after both optimistic and migration debt repayment", async () => {
    await vault.setOptimisticMintingDebtForTest(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(2)
    )
    await vault.setMigrationRevealer(revealer.address, true)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(3)
    )

    await bank.increaseBalanceAndCall(vault.address, [revealer.address], [7])

    expect(await vault.optimisticMintingDebt(revealer.address)).to.equal(0)
    expect(await vault.migrationDebt(revealer.address)).to.equal(0)
    expect(await tbtc.balanceOf(revealer.address)).to.equal(
      SATOSHI_MULTIPLIER.mul(2)
    )
  })

  it("suppresses sweep minting when migration debt fully covers the callback amount", async () => {
    const sweepSats = 20
    const sweepAmount = SATOSHI_MULTIPLIER.mul(sweepSats)

    await vault.setMigrationRevealer(revealer.address, true)
    await vault.registerMigrationDebt(revealer.address, sweepAmount)

    const balanceBefore = await tbtc.balanceOf(revealer.address)

    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address],
      [sweepSats]
    )

    expect(await tbtc.balanceOf(revealer.address)).to.equal(balanceBefore)
    expect(await vault.migrationDebt(revealer.address)).to.equal(0)
  })

  it("notifies the configured migration sweep notifier when a revealer debt is fully repaid", async () => {
    const sweepSats = 7
    const sweepAmount = SATOSHI_MULTIPLIER.mul(sweepSats)
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("migration-sweep-complete")
    )

    await vault.setMigrationRevealer(revealer.address, true)
    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.registerMigrationDebt(revealer.address, sweepAmount)

    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address],
      [sweepSats]
    )

    await expect(
      vault.notifyPendingMigrationSweepForRevealer(
        sweepTxHash,
        revealer.address
      )
    )
      .to.emit(vault, "MigrationSweepNotified")
      .withArgs(revealer.address, reserve.address, sweepTxHash)

    expect(await notifier.notificationCount()).to.equal(1)
    expect(await notifier.lastReserve()).to.equal(reserve.address)
    expect(await notifier.lastCompletionRef()).to.equal(sweepTxHash)
    expect(await vault.migrationSweepReserve(revealer.address)).to.equal(
      ethers.constants.AddressZero
    )
  })

  it("does not notify migration completion before the revealer debt is fully repaid", async () => {
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("migration-sweep-partial")
    )

    await vault.setMigrationRevealer(revealer.address, true)
    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(2)
    )

    await bank.increaseBalanceAndCall(vault.address, [revealer.address], [1])

    await vault.notifyPendingMigrationSweepForRevealer(
      sweepTxHash,
      revealer.address
    )

    expect(await notifier.notificationCount()).to.equal(0)
    expect(await vault.migrationDebt(revealer.address)).to.equal(
      SATOSHI_MULTIPLIER
    )
    expect(await vault.migrationSweepReserve(revealer.address)).to.equal(
      reserve.address
    )
  })

  it("does not queue a migration completion when no reserve is configured at repayment", async () => {
    const sweepSats = 3
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("migration-sweep-delayed-config")
    )

    await vault.setMigrationRevealer(revealer.address, true)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(sweepSats)
    )

    // Debt is fully repaid while no reserve is configured for the revealer, so
    // no pending completion is queued and there is nothing to deliver later.
    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address],
      [sweepSats]
    )

    await vault.notifyPendingMigrationSweepForRevealer(
      sweepTxHash,
      revealer.address
    )
    expect(await notifier.notificationCount()).to.equal(0)

    // Configuring the notifier and reserve after the repayment must not replay
    // an already-elapsed completion that was never queued.
    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.notifyPendingMigrationSweepForRevealer(
      sweepTxHash,
      revealer.address
    )

    expect(await notifier.notificationCount()).to.equal(0)
  })

  it("does not complete a migration sweep for a regular-deposit (zero-address) revealer slot", async () => {
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("regular-deposit-sweep")
    )

    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationRevealer(revealer.address, true)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(3)
    )

    // A regular deposit by the revealer repays their migration debt, setting
    // the pending completion flag.
    await bank.increaseBalanceAndCall(vault.address, [revealer.address], [3])

    // DepositSweep populates the migration revealer slot only for
    // migration-tagged deposits, leaving regular-deposit slots as the zero
    // address. A regular sweep therefore drives the callback with a zero
    // address, which must not send a migration completion notification.
    await vault.notifyPendingMigrationSweep(sweepTxHash, [
      ethers.constants.AddressZero,
    ])
    expect(await notifier.notificationCount()).to.equal(0)

    // The genuine migration revealer address still completes the sweep.
    await vault.notifyPendingMigrationSweep(sweepTxHash, [revealer.address])
    expect(await notifier.notificationCount()).to.equal(1)
    expect(await notifier.lastReserve()).to.equal(reserve.address)
  })

  it("does not queue a migration completion when a notifier is set but no reserve is configured", async () => {
    const sweepSats = 6
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("migration-sweep-no-reserve")
    )

    // Notifier configured, but the revealer has no per-revealer reserve set.
    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationRevealer(revealer.address, true)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(sweepSats)
    )

    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address],
      [sweepSats]
    )

    // Repaying the debt with no reserve configured does not queue a pending
    // completion, so notifying delivers nothing and there is no queued flag to
    // clear.
    await expect(
      vault.notifyPendingMigrationSweepForRevealer(
        sweepTxHash,
        revealer.address
      )
    ).to.not.emit(vault, "MigrationSweepCompletionPendingCleared")
    expect(await notifier.notificationCount()).to.equal(0)

    // Configuring a reserve afterwards must not replay a completion that was
    // never queued.
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.notifyPendingMigrationSweepForRevealer(
      sweepTxHash,
      revealer.address
    )
    expect(await notifier.notificationCount()).to.equal(0)
  })

  it("clears pending migration completion when reserve mapping is cleared", async () => {
    const sweepSats = 4
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("migration-sweep-cleared")
    )

    await vault.setMigrationRevealer(revealer.address, true)
    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(sweepSats)
    )

    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address],
      [sweepSats]
    )

    await expect(
      vault.setMigrationSweepReserve(
        revealer.address,
        ethers.constants.AddressZero
      )
    )
      .to.emit(vault, "MigrationSweepCompletionPendingCleared")
      .withArgs(revealer.address)

    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.notifyPendingMigrationSweepForRevealer(
      sweepTxHash,
      revealer.address
    )

    expect(await notifier.notificationCount()).to.equal(0)
  })

  it("batch-notifies only revealers with pending migration sweep completion", async () => {
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("migration-sweep-batch")
    )

    await vault.setMigrationRevealer(revealer.address, true)
    await vault.setMigrationRevealer(anotherRevealer.address, true)
    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.setMigrationSweepReserve(
      anotherRevealer.address,
      anotherReserve.address
    )
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(2)
    )
    await vault.registerMigrationDebt(
      anotherRevealer.address,
      SATOSHI_MULTIPLIER.mul(3)
    )

    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address, anotherRevealer.address],
      [2, 3]
    )

    const tx = await vault.notifyPendingMigrationSweep(sweepTxHash, [
      revealer.address,
      outsider.address,
      anotherRevealer.address,
    ])
    const receipt = await tx.wait()
    const eventTopic = vault.interface.getEventTopic("MigrationSweepNotified")
    const notifications = receipt.logs.filter(
      ({ address, topics }) =>
        address === vault.address && topics[0] === eventTopic
    )

    expect(notifications.length).to.equal(2)
    expect(await notifier.notificationCount()).to.equal(2)
    expect(await notifier.lastReserve()).to.equal(anotherReserve.address)
    expect(await notifier.lastCompletionRef()).to.equal(sweepTxHash)
    expect(await vault.migrationSweepReserve(revealer.address)).to.equal(
      ethers.constants.AddressZero
    )
    expect(await vault.migrationSweepReserve(anotherRevealer.address)).to.equal(
      ethers.constants.AddressZero
    )
  })

  it("allows retrying migration completion after a notifier failure", async () => {
    const sweepSats = 4
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("migration-sweep-retry")
    )

    await vault.setMigrationRevealer(revealer.address, true)
    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(sweepSats)
    )

    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address],
      [sweepSats]
    )

    await notifier.setShouldRevert(true)
    await expect(
      vault.notifyPendingMigrationSweepForRevealer(
        sweepTxHash,
        revealer.address
      )
    ).to.be.revertedWith("Mock migration sweep notifier revert")

    await notifier.setShouldRevert(false)
    await vault.notifyPendingMigrationSweepForRevealer(
      sweepTxHash,
      revealer.address
    )

    expect(await notifier.notificationCount()).to.equal(1)
    expect(await vault.migrationSweepReserve(revealer.address)).to.equal(
      ethers.constants.AddressZero
    )
  })

  it("reverts batch notification when sweep tx hash is zero", async () => {
    await expect(
      vault.notifyPendingMigrationSweep(ethers.constants.HashZero, [
        revealer.address,
      ])
    ).to.be.revertedWith("Sweep tx hash must not be zero")
  })

  it("reverts batch notification when revealer batch exceeds max size", async () => {
    const oversizedBatch = Array.from({ length: 101 }, () => revealer.address)

    await expect(
      vault.notifyPendingMigrationSweep(
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("oversized-batch")),
        oversizedBatch
      )
    ).to.be.revertedWith("Too many revealers in batch")
  })

  it("reverts single-revealer notification when sweep tx hash is zero", async () => {
    await expect(
      vault.notifyPendingMigrationSweepForRevealer(
        ethers.constants.HashZero,
        revealer.address
      )
    ).to.be.revertedWith("Sweep tx hash must not be zero")
  })

  it("rejects unauthorized migration completion retry callers", async () => {
    const sweepTxHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("migration-sweep-unauthorized")
    )

    await expect(
      vault
        .connect(outsider)
        .notifyPendingMigrationSweepForRevealer(sweepTxHash, revealer.address)
    ).to.be.revertedWith("Caller is not the owner or Bridge")
  })

  it("rejects zero sweep transaction hashes for migration completion retries", async () => {
    await expect(
      vault.notifyPendingMigrationSweepForRevealer(
        ethers.constants.HashZero,
        revealer.address
      )
    ).to.be.revertedWith("Sweep tx hash must not be zero")
  })

  it("reverts setting migration sweep notifier to an EOA", async () => {
    await expect(
      vault.setMigrationSweepNotifier(outsider.address)
    ).to.be.revertedWith("Notifier must be contract or zero address")
  })

  it("allows clearing migration sweep notifier with the zero address", async () => {
    await vault.setMigrationSweepNotifier(notifier.address)

    await expect(vault.setMigrationSweepNotifier(ethers.constants.AddressZero))
      .to.not.be.reverted

    expect(await vault.migrationSweepNotifier()).to.equal(
      ethers.constants.AddressZero
    )
  })

  it("blocks migration debt re-registration while pending sweep completion is unresolved", async () => {
    const sweepSats = 5

    await vault.setMigrationRevealer(revealer.address, true)
    // A reserve is configured before repayment so the full repayment queues a
    // pending sweep completion (a completion is only queued when a reserve is
    // set to receive it).
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(sweepSats)
    )

    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address],
      [sweepSats]
    )

    // Full repayment leaves migration debt at zero with a pending sweep
    // completion outstanding.
    expect(await vault.migrationDebt(revealer.address)).to.equal(0)

    await expect(
      vault.registerMigrationDebt(revealer.address, SATOSHI_MULTIPLIER.mul(2))
    ).to.be.revertedWith(
      "Pending migration sweep completion must be consumed first"
    )

    // Consuming the pending callback through the configured notifier
    // unblocks subsequent re-registrations.
    await vault.setMigrationSweepNotifier(notifier.address)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.notifyPendingMigrationSweepForRevealer(
      ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("migration-sweep-consume")
      ),
      revealer.address
    )

    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(2)
    )
    expect(await vault.migrationDebt(revealer.address)).to.equal(
      SATOSHI_MULTIPLIER.mul(2)
    )
  })

  it("allows migration debt re-registration after the pending completion is cleared via zeroing the reserve", async () => {
    const sweepSats = 4

    await vault.setMigrationRevealer(revealer.address, true)
    await vault.setMigrationSweepReserve(revealer.address, reserve.address)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(sweepSats)
    )

    await bank.increaseBalanceAndCall(
      vault.address,
      [revealer.address],
      [sweepSats]
    )

    await vault.setMigrationSweepReserve(
      revealer.address,
      ethers.constants.AddressZero
    )

    await vault.registerMigrationDebt(revealer.address, SATOSHI_MULTIPLIER)
    expect(await vault.migrationDebt(revealer.address)).to.equal(
      SATOSHI_MULTIPLIER
    )
  })

  it("clears residual migration debt and disables the revealer", async () => {
    await vault.setMigrationRevealer(revealer.address, true)
    await vault.registerMigrationDebt(
      revealer.address,
      SATOSHI_MULTIPLIER.mul(3)
    )

    await bank.increaseBalanceAndCall(vault.address, [revealer.address], [1])

    await expect(vault.clearMigrationDebt(revealer.address))
      .to.emit(vault, "MigrationRevealerSet")
      .withArgs(revealer.address, false)
      .and.to.emit(vault, "MigrationDebtCleared")
      .withArgs(revealer.address, SATOSHI_MULTIPLIER.mul(2))

    expect(await vault.migrationDebt(revealer.address)).to.equal(0)
    expect(await vault.canRevealMigration(revealer.address)).to.equal(false)
    expect(await vault.hasOutstandingMigrationDebt()).to.equal(false)
  })
})
