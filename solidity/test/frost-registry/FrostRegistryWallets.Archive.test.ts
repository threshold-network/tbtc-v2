import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import { Contract } from "ethers"
import {
  FROST_REGISTRY_MAX_RUNTIME_BYTES,
  EXPECTED_UNLINKED_REGISTRY_RUNTIME_HASH,
  zeroRuntimeLinks,
} from "../../deploy/54_upgrade_frost_wallet_registry_archive"

async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  const expectedSelector = ethers.utils.id(`${errorName}()`).slice(0, 10)

  try {
    await promise
  } catch (err) {
    const error = err as {
      data?: string
      message?: string
      error?: { data?: string }
    }
    const revertData = error.data || error.error?.data || ""
    const message = error.message || String(err)

    if (
      revertData.toLowerCase().startsWith(expectedSelector.toLowerCase()) ||
      message.toLowerCase().includes(expectedSelector.toLowerCase()) ||
      message.includes(errorName)
    ) {
      return
    }

    throw new Error(
      `expected ${errorName} (${expectedSelector}), got: ${message}`
    )
  }

  throw new Error(`expected ${errorName} but transaction succeeded`)
}

describe("FrostRegistryWallets archive", () => {
  const walletID =
    "0xb1de1afa17e1cbb20d8a4f8e54f8a55fbf5c8d2da9e1c6c4d1f0c7b3a2e5d4c8"
  const membersIdsHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["uint32[]"], [[1, 2, 3, 4, 5]])
  )

  let harness: Contract

  beforeEach(async () => {
    const Harness = await ethers.getContractFactory(
      "FrostRegistryWalletsHarness"
    )
    harness = await Harness.deploy()
    await harness.deployed()
  })

  async function addAndArchive(): Promise<void> {
    await harness.recordAddedWalletWithMembers(membersIdsHash, walletID)
    await harness.deleteWallet(walletID)
  }

  it("distinguishes unknown, active, and archived records", async () => {
    let activeRecord = await harness.getWallet(walletID)
    let retainedRecord = await harness.getRetainedWallet(walletID)
    let archivedRecord = await harness.getArchivedWallet(walletID)
    expect(activeRecord.membersIdsHash).to.equal(ethers.constants.HashZero)
    expect(activeRecord.xOnlyOutputKey).to.equal(ethers.constants.HashZero)
    expect(retainedRecord.membersIdsHash).to.equal(ethers.constants.HashZero)
    expect(retainedRecord.xOnlyOutputKey).to.equal(ethers.constants.HashZero)
    expect(archivedRecord.membersIdsHash).to.equal(ethers.constants.HashZero)
    expect(archivedRecord.xOnlyOutputKey).to.equal(ethers.constants.HashZero)

    await harness.recordAddedWalletWithMembers(membersIdsHash, walletID)

    activeRecord = await harness.getWallet(walletID)
    retainedRecord = await harness.getRetainedWallet(walletID)
    archivedRecord = await harness.getArchivedWallet(walletID)
    expect(activeRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(activeRecord.xOnlyOutputKey).to.equal(walletID)
    expect(retainedRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(retainedRecord.xOnlyOutputKey).to.equal(walletID)
    expect(archivedRecord.membersIdsHash).to.equal(ethers.constants.HashZero)
    expect(archivedRecord.xOnlyOutputKey).to.equal(ethers.constants.HashZero)

    await harness.deleteWallet(walletID)

    activeRecord = await harness.getWallet(walletID)
    retainedRecord = await harness.getRetainedWallet(walletID)
    archivedRecord = await harness.getArchivedWallet(walletID)
    expect(activeRecord.membersIdsHash).to.equal(ethers.constants.HashZero)
    expect(activeRecord.xOnlyOutputKey).to.equal(ethers.constants.HashZero)
    expect(retainedRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(retainedRecord.xOnlyOutputKey).to.equal(walletID)
    expect(archivedRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(archivedRecord.xOnlyOutputKey).to.equal(walletID)
    expect(await harness.getRetainedWalletMembersIdsHash(walletID)).to.equal(
      membersIdsHash
    )
  })

  it("backfills only a genuine pre-archive closed wallet", async () => {
    await expectCustomError(
      harness.backfillArchivedWalletMembership(walletID, membersIdsHash),
      "WalletWasNeverRegistered"
    )

    await harness.recordAddedWalletWithMembers(membersIdsHash, walletID)
    await expectCustomError(
      harness.backfillArchivedWalletMembership(walletID, membersIdsHash),
      "WalletStillRegistered"
    )

    await harness.legacyDeleteWalletWithoutArchive(walletID)
    expect((await harness.getWallet(walletID)).xOnlyOutputKey).to.equal(
      ethers.constants.HashZero
    )
    expect((await harness.getRetainedWallet(walletID)).xOnlyOutputKey).to.equal(
      ethers.constants.HashZero
    )

    await expectCustomError(
      harness.backfillArchivedWalletMembership(
        walletID,
        ethers.constants.HashZero
      ),
      "WalletMembersIdsHashIsZero"
    )

    await harness.backfillArchivedWalletMembership(walletID, membersIdsHash)
    const retainedRecord = await harness.getRetainedWallet(walletID)
    expect(retainedRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(retainedRecord.xOnlyOutputKey).to.equal(walletID)

    await expectCustomError(
      harness.backfillArchivedWalletMembership(walletID, membersIdsHash),
      "WalletAlreadyArchived"
    )
  })

  it("writes the archive tombstone only once", async () => {
    await addAndArchive()

    await expectCustomError(
      harness.deleteWallet(walletID),
      "WalletNotRegistered"
    )

    const archivedRecord = await harness.getArchivedWallet(walletID)
    expect(archivedRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(archivedRecord.xOnlyOutputKey).to.equal(walletID)
  })

  it("rejects archived wallet IDs through registration validation", async () => {
    await addAndArchive()

    await expectCustomError(
      harness.validateXOnlyOutputKey(walletID),
      "XOnlyOutputKeyAlreadyRegistered"
    )
  })

  it("consumes twenty-eight reserved Data slots without changing its total size", async () => {
    const buildInfo = await artifacts.getBuildInfo(
      "contracts/frost-registry/FrostWalletRegistry.sol:FrostWalletRegistry"
    )
    expect(buildInfo).to.not.equal(undefined)

    const { storageLayout } = buildInfo!.output.contracts[
      "contracts/frost-registry/FrostWalletRegistry.sol"
    ].FrostWalletRegistry as unknown as {
      storageLayout: {
        storage: Array<{
          label: string
          slot: string
          offset: number
          type: string
        }>
        types: Record<
          string,
          {
            label: string
            numberOfBytes: string
            members: Array<{ label: string; slot: string; type: string }>
          }
        >
      }
    }
    const walletsStorage = storageLayout.storage.find(
      (entry: { label: string }) => entry.label === "wallets"
    )
    expect(walletsStorage).to.not.equal(undefined)

    const dataType = storageLayout.types[walletsStorage!.type]
    expect(
      dataType.members.map((member: { label: string }) => member.label)
    ).to.deep.equal([
      "registry",
      "archived",
      "archiveMigrationManifestHash",
      "archiveMigrationAuthority",
      "archiveMigrationUpgradeBlock",
      "archiveMigrationState",
      "archiveMigrationOldImplementationCodeHash",
      "archiveMigrationNewImplementationCodeHash",
      "archiveMigrationMerkleRoot",
      "archiveMigrationHistoryRoot",
      "archiveMigrationPendingManifestHash",
      "archiveMigrationExpectedCount",
      "archiveMigrationCompletedCount",
      "archiveMigrationClaimedBitMap",
      "archiveMigrationCheckpointHash",
      "archiveMigrationCheckpointBlock",
      "archiveMigrationMaxTailBlocks",
      "archiveMigrationUpgradeDeadlineBlock",
      "archiveMigrationSourceAttester",
      "archiveMigrationReconcilerAttester",
      "archiveMigrationSourceAttestationHash",
      "archiveMigrationReconcilerAttestationHash",
      "archiveMigrationSourceIdentityHash",
      "archiveMigrationSourceEndpointIdentityHash",
      "archiveMigrationSourceTrustDomainHash",
      "archiveMigrationSourceEndpointPolicyHash",
      "archiveMigrationReconcilerIdentityHash",
      "archiveMigrationReconcilerEndpointIdentityHash",
      "archiveMigrationReconcilerTrustDomainHash",
      "archiveMigrationReconcilerEndpointPolicyHash",
      "archiveMigrationFinalSourceAttestationHash",
      "archiveMigrationFinalReconcilerAttestationHash",
      "__gap",
    ])
    expect(
      dataType.members.map((member: { slot: string }) => member.slot)
    ).to.deep.equal([
      "0",
      "1",
      "2",
      "3",
      "3",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "13",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
      "22",
      "23",
      "24",
      "25",
      "26",
      "27",
      "28",
    ])

    expect(
      dataType.members.map((member: { offset?: number }) => member.offset ?? 0)
    ).to.deep.equal([
      0, 0, 0, 0, 20, 28, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 12, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])

    const gap = dataType.members[32]
    expect(storageLayout.types[gap.type].label).to.equal("uint256[22]")
    expect(dataType.numberOfBytes).to.equal("1600")
  })

  it("pins the complete proxy storage layout", async () => {
    const buildInfo = await artifacts.getBuildInfo(
      "contracts/frost-registry/FrostWalletRegistry.sol:FrostWalletRegistry"
    )
    expect(buildInfo).to.not.equal(undefined)

    const { storageLayout } = buildInfo!.output.contracts[
      "contracts/frost-registry/FrostWalletRegistry.sol"
    ].FrostWalletRegistry as unknown as {
      storageLayout: {
        storage: Array<{ label: string; slot: string; offset: number }>
      }
    }

    expect(
      storageLayout.storage.map(
        (entry: { label: string; slot: string; offset: number }) => ({
          label: entry.label,
          slot: entry.slot,
          offset: entry.offset,
        })
      )
    ).to.deep.equal([
      { label: "governance", slot: "0", offset: 0 },
      { label: "__gap", slot: "1", offset: 0 },
      { label: "reimbursementPool", slot: "50", offset: 0 },
      { label: "__gap", slot: "51", offset: 0 },
      { label: "_initialized", slot: "100", offset: 0 },
      { label: "_initializing", slot: "100", offset: 1 },
      { label: "authorization", slot: "101", offset: 0 },
      { label: "dkg", slot: "151", offset: 0 },
      { label: "wallets", slot: "202", offset: 0 },
      {
        label: "_maliciousDkgResultSlashingAmount",
        slot: "252",
        offset: 0,
      },
      {
        label: "_maliciousDkgResultNotificationRewardMultiplier",
        slot: "253",
        offset: 0,
      },
      {
        label: "_sortitionPoolRewardsBanDuration",
        slot: "254",
        offset: 0,
      },
      { label: "_dkgResultSubmissionGas", slot: "255", offset: 0 },
      { label: "_dkgResultApprovalGasOffset", slot: "256", offset: 0 },
      {
        label: "_notifyOperatorInactivityGasOffset",
        slot: "257",
        offset: 0,
      },
      { label: "_notifySeedTimeoutGasOffset", slot: "258", offset: 0 },
      {
        label: "_notifyDkgTimeoutNegativeGasOffset",
        slot: "259",
        offset: 0,
      },
      { label: "inactivityClaimNonce", slot: "260", offset: 0 },
      { label: "registered", slot: "261", offset: 0 },
      { label: "walletOwner", slot: "262", offset: 0 },
      { label: "lifecycleOwner", slot: "263", offset: 0 },
      { label: "randomBeacon", slot: "264", offset: 0 },
      { label: "authorizationSource", slot: "265", offset: 0 },
    ])
  })

  it("pins at least 512 bytes of production EIP-170 margin", async () => {
    const artifact = await artifacts.readArtifact("FrostWalletRegistry")
    const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2

    expect(runtimeBytes).to.be.greaterThan(0)
    expect(runtimeBytes).to.be.at.most(FROST_REGISTRY_MAX_RUNTIME_BYTES)

    const linkReferences = Object.values(
      artifact.deployedLinkReferences
    ).flatMap((byLibrary) => Object.values(byLibrary).flat())
    expect(
      ethers.utils.keccak256(
        zeroRuntimeLinks(artifact.deployedBytecode, linkReferences)
      )
    ).to.equal(EXPECTED_UNLINKED_REGISTRY_RUNTIME_HASH)

    const buildInfo = await artifacts.getBuildInfo(
      "contracts/frost-registry/FrostWalletRegistry.sol:FrostWalletRegistry"
    )
    expect(buildInfo).to.not.equal(undefined)
    expect(buildInfo!.solcVersion).to.equal("0.8.17")
    expect(buildInfo!.solcLongVersion).to.equal("0.8.17+commit.8df45f5f")
    expect(buildInfo!.input.settings.optimizer).to.deep.equal({
      enabled: true,
      runs: 200,
    })
    expect(buildInfo!.input.settings.metadata).to.deep.equal({
      useLiteralContent: true,
    })
  })
})
