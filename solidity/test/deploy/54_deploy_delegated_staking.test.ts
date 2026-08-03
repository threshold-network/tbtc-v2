import hre, { deployments, ethers } from "hardhat"
import { expect } from "chai"
import deployDelegatedStaking from "../../deploy/54_deploy_delegated_staking"

describe("54_deploy_delegated_staking", () => {
  const names = [
    "SignerRegistry",
    "StakeVault",
    "SlashingModule",
    "WalletExposureLedger",
    "SeatAllocator",
    "RewardsDistributor",
    "FeeRouter",
  ]

  it("attaches to a complete prior deployment and reruns idempotently", async function rerunsCompleteDeployment() {
    this.timeout(240_000)

    // The canonical untagged fixture resolves the external ECDSA/random
    // beacon deployment chain before the local Bridge/FROST dependencies.
    await deployments.fixture()
    const addressesBefore = await Promise.all(
      names.map(async (name) => (await deployments.get(name)).address)
    )

    await deployDelegatedStaking(hre)

    const addressesAfter = await Promise.all(
      names.map(async (name) => (await deployments.get(name)).address)
    )
    expect(addressesAfter).to.deep.equal(addressesBefore)

    const signerRegistry = await ethers.getContractAt(
      "SignerRegistry",
      addressesAfter[0]
    )
    const seatAllocator = await ethers.getContractAt(
      "SeatAllocator",
      addressesAfter[4]
    )
    const rewardsDistributor = await ethers.getContractAt(
      "RewardsDistributor",
      addressesAfter[5]
    )
    const feeRouter = await ethers.getContractAt("FeeRouter", addressesAfter[6])
    expect(await signerRegistry.seatAllocator()).to.equal(seatAllocator.address)
    expect(await feeRouter.rewardsDistributor()).to.equal(
      rewardsDistributor.address
    )
  })

  it("resumes after only the first proxy was persisted", async function resumesPartialDeployment() {
    this.timeout(240_000)
    await deployments.fixture()

    for (const name of names) {
      await deployments.delete(name)
    }

    const { deployer } = await hre.getNamedAccounts()
    const signer = await ethers.getSigner(deployer)
    const governanceDelay = 172800
    const [partialSignerRegistry] = await hre.helpers.upgrades.deployProxy(
      "SignerRegistry",
      {
        contractName: "SignerRegistry",
        initializerArgs: [governanceDelay, 30 * 24 * 60 * 60, 2500, 500],
        factoryOpts: { signer },
        proxyOpts: { kind: "transparent" },
      }
    )

    await deployDelegatedStaking(hre)

    expect((await deployments.get("SignerRegistry")).address).to.equal(
      partialSignerRegistry.address
    )
    for (const name of names.slice(1)) {
      expect((await deployments.get(name)).address).not.to.equal(
        ethers.constants.AddressZero
      )
    }

    const seatAllocator = await ethers.getContractAt(
      "SeatAllocator",
      (
        await deployments.get("SeatAllocator")
      ).address
    )
    expect(await partialSignerRegistry.seatAllocator()).to.equal(
      seatAllocator.address
    )
  })
})
