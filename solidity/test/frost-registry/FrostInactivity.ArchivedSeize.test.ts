/* eslint-disable @typescript-eslint/no-unused-expressions */

import { FakeContract, smock } from "@defi-wonderland/smock"
import chai, { expect } from "chai"
import { Contract } from "ethers"
import { ethers, helpers } from "hardhat"
import type {
  IFrostAuthorizationSource,
  SortitionPool,
} from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

chai.use(smock.matchers)

describe("FrostInactivity archived seize", () => {
  const walletID =
    "0xabcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01"
  const walletMembersIDs = [11, 22]
  const wrongWalletMembersIDs = [11]
  const amount = 123
  const rewardMultiplier = 17

  let sortitionPool: FakeContract<SortitionPool>
  let authorizationSource: FakeContract<IFrostAuthorizationSource>
  let harness: Contract

  before(async () => {
    const [, operator1, operator2, provider1, provider2] =
      await ethers.getSigners()
    sortitionPool = await smock.fake<SortitionPool>("SortitionPool")
    authorizationSource = await smock.fake<IFrostAuthorizationSource>(
      "IFrostAuthorizationSource"
    )
    sortitionPool.getIDOperators.returns([
      operator1.address,
      operator2.address,
    ])
    authorizationSource.reportMaliciousBehavior.returns()

    const Inactivity = await ethers.getContractFactory("FrostInactivity")
    const inactivity = await Inactivity.deploy()
    await inactivity.deployed()
    const Harness = await ethers.getContractFactory(
      "FrostInactivitySeizeHarness",
      { libraries: { FrostInactivity: inactivity.address } }
    )
    harness = await Harness.deploy(
      sortitionPool.address,
      authorizationSource.address
    )
    await harness.deployed()

    await harness.recordWallet(
      walletID,
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["uint32[]"],
          [walletMembersIDs]
        )
      )
    )
    await harness.setStakingProvider(operator1.address, provider1.address)
    await harness.setStakingProvider(operator2.address, provider2.address)
  })

  beforeEach(async () => {
    authorizationSource.reportMaliciousBehavior.reset()
    await createSnapshot()
  })
  afterEach(async () => restoreSnapshot())

  it("preserves seizure for an active wallet", async () => {
    const [, , , provider1, provider2, notifier] = await ethers.getSigners()

    await harness.seize(
      amount,
      rewardMultiplier,
      notifier.address,
      walletID,
      walletMembersIDs
    )

    expect(
      authorizationSource.reportMaliciousBehavior
    ).to.have.been.calledOnceWith(
      amount,
      rewardMultiplier,
      notifier.address,
      [provider1.address, provider2.address]
    )
  })

  it("rejects wrong members and seizes with the retained archive", async () => {
    const [, , , provider1, provider2, notifier] = await ethers.getSigners()
    await harness.archiveWallet(walletID)

    await expect(
      harness.seize(
        amount,
        rewardMultiplier,
        notifier.address,
        walletID,
        wrongWalletMembersIDs
      )
    ).to.be.revertedWith("Invalid wallet members identifiers")
    expect(authorizationSource.reportMaliciousBehavior).not.to.have.been.called

    await harness.seize(
      amount,
      rewardMultiplier,
      notifier.address,
      walletID,
      walletMembersIDs
    )
    expect(
      authorizationSource.reportMaliciousBehavior
    ).to.have.been.calledOnceWith(
      amount,
      rewardMultiplier,
      notifier.address,
      [provider1.address, provider2.address]
    )
  })
})
