import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import { Contract } from "ethers"

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
    let archivedRecord = await harness.getArchivedWallet(walletID)
    expect(activeRecord.membersIdsHash).to.equal(ethers.constants.HashZero)
    expect(activeRecord.xOnlyOutputKey).to.equal(ethers.constants.HashZero)
    expect(archivedRecord.membersIdsHash).to.equal(ethers.constants.HashZero)
    expect(archivedRecord.xOnlyOutputKey).to.equal(ethers.constants.HashZero)

    await harness.recordAddedWalletWithMembers(membersIdsHash, walletID)

    activeRecord = await harness.getWallet(walletID)
    archivedRecord = await harness.getArchivedWallet(walletID)
    expect(activeRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(activeRecord.xOnlyOutputKey).to.equal(walletID)
    expect(archivedRecord.membersIdsHash).to.equal(ethers.constants.HashZero)
    expect(archivedRecord.xOnlyOutputKey).to.equal(ethers.constants.HashZero)

    await harness.deleteWallet(walletID)

    activeRecord = await harness.getWallet(walletID)
    archivedRecord = await harness.getArchivedWallet(walletID)
    expect(activeRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(activeRecord.xOnlyOutputKey).to.equal(walletID)
    expect(archivedRecord.membersIdsHash).to.equal(membersIdsHash)
    expect(archivedRecord.xOnlyOutputKey).to.equal(walletID)
    expect(await harness.getRetainedWalletMembersIdsHash(walletID)).to.equal(
      membersIdsHash
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

  it("consumes one reserved Data slot without changing its total size", async () => {
    const buildInfo = await artifacts.getBuildInfo(
      "contracts/frost-registry/FrostWalletRegistry.sol:FrostWalletRegistry"
    )
    expect(buildInfo).to.not.equal(undefined)

    const { storageLayout } =
      buildInfo!.output.contracts[
        "contracts/frost-registry/FrostWalletRegistry.sol"
      ].FrostWalletRegistry
    const walletsStorage = storageLayout.storage.find(
      (entry: { label: string }) => entry.label === "wallets"
    )
    expect(walletsStorage).to.not.equal(undefined)

    const dataType = storageLayout.types[walletsStorage!.type]
    expect(
      dataType.members.map((member: { label: string }) => member.label)
    ).to.deep.equal(["registry", "archived", "__gap"])
    expect(
      dataType.members.map((member: { slot: string }) => member.slot)
    ).to.deep.equal(["0", "1", "2"])

    const gap = dataType.members[2]
    expect(storageLayout.types[gap.type].label).to.equal("uint256[48]")
    expect(dataType.numberOfBytes).to.equal("1600")
  })
})
