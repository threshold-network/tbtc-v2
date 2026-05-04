import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers } from "hardhat"
import { expect } from "chai"

import type {
  DepositRevealGuardHarness,
  MockMigrationDebtVault,
  MockRegularVault,
} from "../../typechain"

const MIGRATION_TAG = "AC_MIGRATEV1"
const MIGRATION_DEBT_MISSING_REASON = ethers.utils.formatBytes32String(
  "MIGRATION_DEBT_MISSING"
)
const MIGRATION_TAG_REQUIRED_REASON = ethers.utils.formatBytes32String(
  "MIGRATION_TAG_REQUIRED"
)
const MIGRATION_REVEALER_NOT_ALLOWED_REASON = ethers.utils.formatBytes32String(
  "MIGRATION_REVEALER_NOT_ALLOWED"
)
const MIGRATION_REVEALER_MISMATCH_REASON = ethers.utils.formatBytes32String(
  "MIGRATION_REVEALER_MISMATCH"
)
const MIGRATION_VAULT_CALL_FAILED_REASON = ethers.utils.formatBytes32String(
  "MIGRATION_VAULT_CALL_FAILED"
)
const SATOSHI_MULTIPLIER = ethers.BigNumber.from(10).pow(10)
const migrationRevealRejectedInterface = new ethers.utils.Interface([
  "error MigrationRevealRejected(bytes32 reasonCode)",
])

const encodeMigrationExtraData = (revealer: string): string =>
  ethers.utils.hexConcat([
    ethers.utils.hexlify(ethers.utils.toUtf8Bytes(MIGRATION_TAG)),
    ethers.utils.hexZeroPad(revealer, 20),
  ])

const toLittleEndian8 = (value: number): string =>
  Buffer.from(
    ethers.utils
      .hexZeroPad(ethers.BigNumber.from(value).toHexString(), 8)
      .substring(2),
    "hex"
  )
    .reverse()
    .toString("hex")

const buildFundingTx = (
  depositor: string,
  reveal: {
    fundingOutputIndex: number
    blindingFactor: string
    walletPubKeyHash: string
    refundPubKeyHash: string
    refundLocktime: string
    vault: string
  },
  amountSats: number,
  extraData?: string
) => {
  let depositScript: string

  if (extraData) {
    depositScript =
      `0x14${depositor.substring(2)}75` +
      `20${extraData.substring(2)}75` +
      `08${reveal.blindingFactor.substring(2)}75` +
      `76a914${reveal.walletPubKeyHash.substring(2)}87` +
      "63ac67" +
      `76a914${reveal.refundPubKeyHash.substring(2)}88` +
      `04${reveal.refundLocktime.substring(2)}b175` +
      "ac68"
  } else {
    depositScript =
      `0x14${depositor.substring(2)}75` +
      `08${reveal.blindingFactor.substring(2)}75` +
      `76a914${reveal.walletPubKeyHash.substring(2)}87` +
      "63ac67" +
      `76a914${reveal.refundPubKeyHash.substring(2)}88` +
      `04${reveal.refundLocktime.substring(2)}b175` +
      "ac68"
  }

  const scriptHash = ethers.utils.sha256(depositScript)

  return {
    version: "0x01000000",
    inputVector:
      "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20dc2b952f0100000000ffffffff",
    outputVector: `0x01${toLittleEndian8(
      amountSats
    )}220020${scriptHash.substring(2)}`,
    locktime: "0x00000000",
  }
}

const fundingTxHash = (tx: {
  version: string
  inputVector: string
  outputVector: string
  locktime: string
}): string =>
  ethers.utils.sha256(
    ethers.utils.sha256(
      `0x${tx.version.substring(2)}` +
        `${tx.inputVector.substring(2)}` +
        `${tx.outputVector.substring(2)}` +
        `${tx.locktime.substring(2)}`
    )
  )

const expectMigrationRevealRejected = async (
  txPromise: Promise<unknown>,
  reasonCode: string
) => {
  try {
    await txPromise
    expect.fail("expected MigrationRevealRejected revert")
  } catch (error) {
    const hardhatError = error as {
      data?: string
      error?: { data?: string }
      errorName?: string
      errorArgs?: Array<string>
      message: string
    }

    const revertData =
      hardhatError.data ??
      hardhatError.error?.data ??
      migrationRevealRejectedInterface.encodeErrorResult(
        "MigrationRevealRejected",
        hardhatError.errorArgs ?? []
      )

    const [decodedReasonCode] =
      migrationRevealRejectedInterface.decodeErrorResult(
        "MigrationRevealRejected",
        revertData
      )

    expect(
      hardhatError.errorName ?? "MigrationRevealRejected",
      hardhatError.message
    ).to.equal("MigrationRevealRejected")
    expect(decodedReasonCode).to.equal(reasonCode)
  }
}

describe("Deposit - Migration Reveal Guard Harness", () => {
  let migrationRevealer: SignerWithAddress
  let unauthorizedRevealer: SignerWithAddress
  let mismatchEncodedRevealer: SignerWithAddress
  let regularDepositor: SignerWithAddress

  let harness: DepositRevealGuardHarness
  let migrationVault: MockMigrationDebtVault
  let regularVault: MockRegularVault

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[
      migrationRevealer,
      unauthorizedRevealer,
      mismatchEncodedRevealer,
      regularDepositor,
    ] = await ethers.getSigners()

    const DepositLibraryFactory = await ethers.getContractFactory("Deposit")
    const depositLibrary = await DepositLibraryFactory.deploy()

    const HarnessFactory = await ethers.getContractFactory(
      "DepositRevealGuardHarness",
      {
        libraries: {
          "contracts/bridge/Deposit.sol:Deposit": depositLibrary.address,
        },
      }
    )
    harness = await HarnessFactory.deploy(10000, 0)

    const MigrationVaultFactory = await ethers.getContractFactory(
      "MockMigrationDebtVault"
    )
    migrationVault = await MigrationVaultFactory.deploy()

    const RegularVaultFactory = await ethers.getContractFactory(
      "MockRegularVault"
    )
    regularVault = await RegularVaultFactory.deploy()

    await harness.setWalletState(walletPubKeyHash, 1)
    await harness.setVaultStatus(migrationVault.address, true)
    await harness.setVaultStatus(regularVault.address, true)
    await harness.setMigrationDebtVault(migrationVault.address)
  })

  const migrationReveal = {
    fundingOutputIndex: 0,
    blindingFactor: "0xf9f0c90d00039523",
    walletPubKeyHash,
    refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
    refundLocktime: "0x60bcea61",
    vault: "",
  }

  it("reverts when migration debt is missing", async () => {
    await migrationVault.setMigrationRevealer(migrationRevealer.address, true)

    const extraData = encodeMigrationExtraData(migrationRevealer.address)
    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(
      migrationRevealer.address,
      reveal,
      20000,
      extraData
    )

    await expectMigrationRevealRejected(
      harness
        .connect(migrationRevealer)
        .revealDepositWithExtraData(tx, reveal, extraData),
      MIGRATION_DEBT_MISSING_REASON
    )
  })

  it("round-trips migration extraData encoding for tag and revealer", async () => {
    const extraData = encodeMigrationExtraData(migrationRevealer.address)

    expect(await harness.isMigrationReveal(extraData)).to.equal(true)
    expect(await harness.decodeMigrationRevealer(extraData)).to.equal(
      migrationRevealer.address
    )
  })

  it("reverts when migration revealer is unauthorized", async () => {
    await migrationVault.registerMigrationDebt(
      unauthorizedRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const extraData = encodeMigrationExtraData(unauthorizedRevealer.address)
    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(
      unauthorizedRevealer.address,
      reveal,
      20000,
      extraData
    )

    await expectMigrationRevealRejected(
      harness
        .connect(unauthorizedRevealer)
        .revealDepositWithExtraData(tx, reveal, extraData),
      MIGRATION_REVEALER_NOT_ALLOWED_REASON
    )
  })

  it("reverts when encoded revealer mismatches sender", async () => {
    await migrationVault.setMigrationRevealer(migrationRevealer.address, true)
    await migrationVault.registerMigrationDebt(
      migrationRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const mismatchedExtraData = encodeMigrationExtraData(
      mismatchEncodedRevealer.address
    )
    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(
      migrationRevealer.address,
      reveal,
      20000,
      mismatchedExtraData
    )

    await expectMigrationRevealRejected(
      harness
        .connect(migrationRevealer)
        .revealDepositWithExtraData(tx, reveal, mismatchedExtraData),
      MIGRATION_REVEALER_MISMATCH_REASON
    )
  })

  it("reverts non-migration reveal from registered migration revealer", async () => {
    await migrationVault.setMigrationRevealer(migrationRevealer.address, true)
    await migrationVault.registerMigrationDebt(
      migrationRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(migrationRevealer.address, reveal, 20000)

    await expectMigrationRevealRejected(
      harness.connect(migrationRevealer).revealDeposit(tx, reveal),
      MIGRATION_TAG_REQUIRED_REASON
    )
  })

  it("reverts non-migration reveal from registered migration revealer when vault is zero", async () => {
    await migrationVault.setMigrationRevealer(migrationRevealer.address, true)
    await migrationVault.registerMigrationDebt(
      migrationRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const reveal = { ...migrationReveal, vault: ethers.constants.AddressZero }
    const tx = buildFundingTx(migrationRevealer.address, reveal, 20000)

    await expectMigrationRevealRejected(
      harness.connect(migrationRevealer).revealDeposit(tx, reveal),
      MIGRATION_TAG_REQUIRED_REASON
    )
  })

  it("reverts migration-tagged reveal for trusted vault without migration interface", async () => {
    const extraData = encodeMigrationExtraData(migrationRevealer.address)
    const reveal = { ...migrationReveal, vault: regularVault.address }
    const tx = buildFundingTx(
      migrationRevealer.address,
      reveal,
      20000,
      extraData
    )

    await expectMigrationRevealRejected(
      harness
        .connect(migrationRevealer)
        .revealDepositWithExtraData(tx, reveal, extraData),
      MIGRATION_VAULT_CALL_FAILED_REASON
    )
  })

  it("accepts a valid migration-tagged reveal", async () => {
    await migrationVault.setMigrationRevealer(migrationRevealer.address, true)
    await migrationVault.registerMigrationDebt(
      migrationRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const extraData = encodeMigrationExtraData(migrationRevealer.address)
    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(
      migrationRevealer.address,
      reveal,
      20000,
      extraData
    )

    await expect(
      harness
        .connect(migrationRevealer)
        .revealDepositWithExtraData(tx, reveal, extraData)
    ).to.not.be.reverted

    const depositKey = ethers.utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [fundingTxHash(tx), reveal.fundingOutputIndex]
    )
    const deposit = await harness.getDeposit(depositKey)
    expect(deposit.depositor).to.equal(migrationRevealer.address)
    expect(deposit.extraData).to.equal(extraData)
  })

  it("keeps regular non-migration flow working for non-migration revealers", async () => {
    await migrationVault.setMigrationRevealer(migrationRevealer.address, true)
    await migrationVault.registerMigrationDebt(
      migrationRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(regularDepositor.address, reveal, 20000)

    await expect(harness.connect(regularDepositor).revealDeposit(tx, reveal)).to
      .not.be.reverted
  })

  it("keeps regular non-migration flow working for non-migration revealers when vault is zero", async () => {
    await migrationVault.setMigrationRevealer(migrationRevealer.address, true)
    await migrationVault.registerMigrationDebt(
      migrationRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const reveal = { ...migrationReveal, vault: ethers.constants.AddressZero }
    const tx = buildFundingTx(regularDepositor.address, reveal, 20000)

    await expect(harness.connect(regularDepositor).revealDeposit(tx, reveal)).to
      .not.be.reverted
  })

  it("reverts non-migration reveal after migrationDebtVault rotation when revealer remains registered in reveal vault", async () => {
    await migrationVault.setMigrationRevealer(migrationRevealer.address, true)
    await migrationVault.registerMigrationDebt(
      migrationRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const MigrationVaultFactory = await ethers.getContractFactory(
      "MockMigrationDebtVault"
    )
    const rotatedMigrationVault = await MigrationVaultFactory.deploy()
    await harness.setVaultStatus(rotatedMigrationVault.address, true)
    await harness.setMigrationDebtVault(rotatedMigrationVault.address)

    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(migrationRevealer.address, reveal, 20000)

    await expectMigrationRevealRejected(
      harness.connect(migrationRevealer).revealDeposit(tx, reveal),
      MIGRATION_TAG_REQUIRED_REASON
    )
  })

  it("reverts non-migration reveal after migrationDebtVault rotation when revealer is registered in canonical vault", async () => {
    const MigrationVaultFactory = await ethers.getContractFactory(
      "MockMigrationDebtVault"
    )
    const rotatedMigrationVault = await MigrationVaultFactory.deploy()
    await harness.setVaultStatus(rotatedMigrationVault.address, true)
    await harness.setMigrationDebtVault(rotatedMigrationVault.address)

    await rotatedMigrationVault.setMigrationRevealer(
      migrationRevealer.address,
      true
    )
    await rotatedMigrationVault.registerMigrationDebt(
      migrationRevealer.address,
      SATOSHI_MULTIPLIER.mul(20000)
    )

    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(migrationRevealer.address, reveal, 20000)

    await expectMigrationRevealRejected(
      harness.connect(migrationRevealer).revealDeposit(tx, reveal),
      MIGRATION_TAG_REQUIRED_REASON
    )
  })

  it("reverts non-migration reveal when canonical vault staticcall fails", async () => {
    // Set canonical migrationDebtVault to regularVault (empty contract).
    // Calling isMigrationRevealer on it will fail because the function
    // does not exist, producing a staticcall failure. The fix should
    // treat this as indeterminate and revert rather than returning false.
    await harness.setMigrationDebtVault(regularVault.address)

    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(regularDepositor.address, reveal, 20000)

    await expectMigrationRevealRejected(
      harness.connect(regularDepositor).revealDeposit(tx, reveal),
      MIGRATION_VAULT_CALL_FAILED_REASON
    )
  })

  it("reverts non-migration reveal when canonical vault staticcall fails even if reveal vault says not registered", async () => {
    // Canonical vault is regularVault (staticcall fails). Reveal vault
    // is a working migrationVault where the depositor is NOT registered.
    // The canonical vault failure should cause a revert regardless of
    // what the reveal vault would return.
    await harness.setMigrationDebtVault(regularVault.address)

    const reveal = { ...migrationReveal, vault: migrationVault.address }
    const tx = buildFundingTx(regularDepositor.address, reveal, 20000)

    // regularDepositor is not registered in migrationVault, so the reveal
    // vault would say "not registered" -- but the canonical vault failure
    // must take precedence and revert.
    await expectMigrationRevealRejected(
      harness.connect(regularDepositor).revealDeposit(tx, reveal),
      MIGRATION_VAULT_CALL_FAILED_REASON
    )
  })

  it("allows non-migration reveal when reveal vault lacks migration-debt helpers", async () => {
    // Canonical vault is a working migrationVault where depositor is NOT
    // registered (clean "not registered" response). Reveal vault is a
    // trusted regularVault (empty contract, staticcall fails). The reveal
    // vault fallback should stay fail-open for plain IVault compatibility.
    const reveal = { ...migrationReveal, vault: regularVault.address }
    const tx = buildFundingTx(regularDepositor.address, reveal, 20000)

    await expect(harness.connect(regularDepositor).revealDeposit(tx, reveal)).to
      .not.be.reverted
  })
})
