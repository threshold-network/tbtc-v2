import hre, { artifacts, ethers } from "hardhat"
import { smock } from "@defi-wonderland/smock"
import chai, { expect } from "chai"

chai.use(smock.matchers)

async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  const expectedSelector = ethers.utils.id(`${errorName}()`).slice(0, 10)
  try {
    await promise
  } catch (err) {
    const errAny = err as {
      data?: string
      message?: string
      error?: { data?: string }
    }
    const revertData = errAny.data || errAny.error?.data || ""
    const errMsg = errAny.message || String(err)

    if (
      (revertData &&
        revertData.toLowerCase().startsWith(expectedSelector.toLowerCase())) ||
      errMsg.toLowerCase().includes(expectedSelector.toLowerCase()) ||
      errMsg.includes(errorName)
    ) {
      return
    }

    throw new Error(
      `expected ${errorName} (${expectedSelector}), got: ${errMsg}`
    )
  }

  throw new Error(`expected ${errorName} but transaction succeeded`)
}

describe("FrostDkg liveness security", () => {
  const AWAITING_RESULT = 2
  const CHALLENGE = 3
  const CHALLENGE_PERIOD = 20
  const SUBMISSION_TIMEOUT = 40
  const GROUP_SIZE = 100
  const MALICIOUS_SELECTED_ID = 1
  const HONEST_SELECTED_ID = 2
  const NON_SELECTED_ID = 777

  const selectedMembers = Array.from(
    { length: GROUP_SIZE },
    (_, index) => index + 1
  )

  let maliciousSelected: any
  let honestSelected: any
  let nonSelected: any
  let challenger: any
  let pool: any
  let harness: any

  const resultFor = (submitterMemberIndex: number, members: number[]) => ({
    submitterMemberIndex,
    xOnlyOutputKey: ethers.utils.id(
      `frost-dkg-liveness-${submitterMemberIndex}-${members[0]}`
    ),
    misbehavedMembersIndices: [],
    signatures: "0x",
    signingMembersIndices: [],
    members,
    membersHash: ethers.constants.HashZero,
  })

  beforeEach(async () => {
    ;[, maliciousSelected, honestSelected, nonSelected, challenger] =
      await ethers.getSigners()

    pool = await smock.fake(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )

    pool.isLocked.returns(false)
    pool.isOperatorInPool
      .whenCalledWith(maliciousSelected.address)
      .returns(true)
    pool.isOperatorInPool.whenCalledWith(honestSelected.address).returns(true)
    pool.isOperatorInPool.whenCalledWith(nonSelected.address).returns(true)
    pool.getIDOperator
      .whenCalledWith(MALICIOUS_SELECTED_ID)
      .returns(maliciousSelected.address)
    pool.getIDOperator
      .whenCalledWith(HONEST_SELECTED_ID)
      .returns(honestSelected.address)
    pool.getIDOperator
      .whenCalledWith(NON_SELECTED_ID)
      .returns(nonSelected.address)
    pool.selectGroup.returns(selectedMembers)

    const Validator = await ethers.getContractFactory("FrostDkgValidator")
    const validator = await Validator.deploy(pool.address)
    await validator.deployed()

    const Harness = await ethers.getContractFactory("FrostDkgLivenessHarness")
    harness = await Harness.deploy(
      pool.address,
      validator.address,
      honestSelected.address,
      CHALLENGE_PERIOD,
      SUBMISSION_TIMEOUT
    )
    await harness.deployed()

    await harness.lockState()
    pool.isLocked.returns(true)
    await harness.start(ethers.utils.id("frost-dkg-liveness-seed"))
    expect(await harness.state()).to.equal(AWAITING_RESULT)
  })

  it("rejects a current pool operator outside the seed-selected group", async () => {
    const forgedMembers = [...selectedMembers]
    forgedMembers[0] = NON_SELECTED_ID
    const forgedResult = resultFor(1, forgedMembers)

    await expectCustomError(
      harness.connect(nonSelected).submitResult(forgedResult),
      "InvalidGroupMembers"
    )

    expect(await harness.state()).to.equal(AWAITING_RESULT)
  })

  it("blocks a challenged submitter from repeating while preserving honest resubmission", async () => {
    const maliciousResult = resultFor(1, selectedMembers)

    await harness.connect(maliciousSelected).submitResult(maliciousResult)
    expect(await harness.state()).to.equal(CHALLENGE)

    await harness.connect(challenger).challengeResult(maliciousResult)
    expect(await harness.state()).to.equal(AWAITING_RESULT)

    await expectCustomError(
      harness.connect(maliciousSelected).submitResult(maliciousResult),
      "SubmitterChallengedForCurrentDkg"
    )

    const honestResult = resultFor(2, selectedMembers)
    await expect(harness.connect(honestSelected).submitResult(honestResult)).to
      .not.be.reverted
    expect(await harness.state()).to.equal(CHALLENGE)
  })

  it("blocks a challenged operator through another selected member index", async () => {
    const duplicatedMembers = [...selectedMembers]
    duplicatedMembers[1] = MALICIOUS_SELECTED_ID
    pool.selectGroup.returns(duplicatedMembers)

    const firstSubmission = resultFor(1, duplicatedMembers)
    await harness.connect(maliciousSelected).submitResult(firstSubmission)
    await harness.connect(challenger).challengeResult(firstSubmission)

    const alternateIndexSubmission = resultFor(2, duplicatedMembers)
    await expectCustomError(
      harness.connect(maliciousSelected).submitResult(alternateIndexSubmission),
      "SubmitterChallengedForCurrentDkg"
    )

    expect(await harness.state()).to.equal(AWAITING_RESULT)
  })

  it("expires submitter quarantine when a new DKG round starts", async () => {
    const maliciousResult = resultFor(1, selectedMembers)

    await harness.connect(maliciousSelected).submitResult(maliciousResult)
    await harness.connect(challenger).challengeResult(maliciousResult)

    const deadline = await harness.resultSubmissionDeadline()
    const currentBlock = await ethers.provider.getBlockNumber()
    const blocksPastDeadline = deadline.toNumber() + 1 - currentBlock
    if (blocksPastDeadline > 0) {
      await hre.network.provider.send("hardhat_mine", [
        `0x${blocksPastDeadline.toString(16)}`,
      ])
    }
    await harness.notifyDkgTimeout()

    pool.isLocked.returns(false)
    await harness.lockState()
    pool.isLocked.returns(true)
    await harness.start(ethers.utils.id("frost-dkg-liveness-next-seed"))

    await expect(
      harness.connect(maliciousSelected).submitResult(maliciousResult)
    ).to.not.be.reverted
    expect(await harness.state()).to.equal(CHALLENGE)
  })

  it("keeps the original deadline and unlocks immediately after the exact timeout boundary", async () => {
    const originalDeadline = await harness.resultSubmissionDeadline()
    const maliciousResult = resultFor(1, selectedMembers)

    await harness.connect(maliciousSelected).submitResult(maliciousResult)
    await harness.connect(challenger).challengeResult(maliciousResult)

    expect(await harness.resultSubmissionStartBlockOffset()).to.equal(0)
    expect(await harness.resultSubmissionDeadline()).to.equal(originalDeadline)

    const currentBlock = await ethers.provider.getBlockNumber()
    const blocksToDeadline = originalDeadline.toNumber() - currentBlock
    if (blocksToDeadline > 0) {
      await hre.network.provider.send("hardhat_mine", [
        `0x${blocksToDeadline.toString(16)}`,
      ])
    }

    expect(await ethers.provider.getBlockNumber()).to.equal(
      originalDeadline.toNumber()
    )
    expect(await harness.hasDkgTimedOut()).to.equal(false)

    await hre.network.provider.send("hardhat_mine", ["0x1"])
    expect(await harness.hasDkgTimedOut()).to.equal(true)

    await (await harness.notifyDkgTimeout()).wait()
    expect(pool.unlock).to.have.been.calledOnce
  })

  it("keeps selected-group submission within a bounded gas budget", async () => {
    const selectedResult = resultFor(1, selectedMembers)
    const receipt = await (
      await harness.connect(maliciousSelected).submitResult(selectedResult)
    ).wait()

    expect(receipt.gasUsed).to.be.lt(1_500_000)
  })

  it("consumes one reserved FrostDkg storage slot for round quarantine", async () => {
    const buildInfo = await artifacts.getBuildInfo(
      "contracts/frost-registry/FrostWalletRegistry.sol:FrostWalletRegistry"
    )
    expect(buildInfo).to.not.equal(undefined)

    const storageLayout =
      buildInfo!.output.contracts[
        "contracts/frost-registry/FrostWalletRegistry.sol"
      ].FrostWalletRegistry.storageLayout
    const dkgStorage = storageLayout.storage.find(
      (entry: { label: string }) => entry.label === "dkg"
    )
    const walletsStorage = storageLayout.storage.find(
      (entry: { label: string }) => entry.label === "wallets"
    )
    expect(dkgStorage).to.not.equal(undefined)
    expect(walletsStorage).to.not.equal(undefined)
    expect(dkgStorage!.slot).to.equal("151")
    expect(walletsStorage!.slot).to.equal("202")

    const dkgType = storageLayout.types[dkgStorage!.type]
    const tail = dkgType.members.slice(-2)
    expect(tail.map((member: { label: string }) => member.label)).to.deep.equal(
      ["challengedSubmitterDkgStartBlocks", "__gap"]
    )
    expect(tail[0].slot).to.equal("14")
    expect(tail[1].slot).to.equal("15")
    expect(storageLayout.types[tail[1].type].label).to.equal("uint256[36]")
    expect(dkgType.numberOfBytes).to.equal("1632")
  })
})
