import { deployments, ethers } from "hardhat"
import { expect } from "chai"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type { TimelockDeployed } from "../typechain"

const ONE_DAY_IN_SECONDS = 86400

describe("TimelockDeployed", () => {
  let deployer: SignerWithAddress
  let proposer: SignerWithAddress
  let executor: SignerWithAddress
  let timelockDeployed: TimelockDeployed

  let PROPOSER_ROLE: string
  let EXECUTOR_ROLE: string

  before(async () => {
    await deployments.fixture(["TimelockDeployed"])

    const signers = await ethers.getSigners()
    if (signers.length < 3) {
      throw new Error(
        `Not enough signers available for test. Need at least 3, but got ${signers.length}.`
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[deployer, proposer, executor] = signers

    const TimelockDeployedFactory = await ethers.getContractFactory(
      "TimelockDeployed"
    )
    timelockDeployed = (await TimelockDeployedFactory.connect(deployer).deploy(
      ONE_DAY_IN_SECONDS, // minDelay
      [proposer.address], // proposers
      [executor.address] // executors
    )) as TimelockDeployed

    PROPOSER_ROLE = await timelockDeployed.PROPOSER_ROLE()
    EXECUTOR_ROLE = await timelockDeployed.EXECUTOR_ROLE()
  })

  describe("Deployment", () => {
    it("Should deploy the contract to a valid address", async () => {
      expect(ethers.utils.isAddress(timelockDeployed.address)).to.equal(true)
    })

    it("Should set the minimum delay correctly", async () => {
      const minDelay = await timelockDeployed.getMinDelay()
      expect(minDelay).to.equal(ONE_DAY_IN_SECONDS)
    })

    it("Should grant the proposer role to the specified address", async () => {
      expect(
        await timelockDeployed.hasRole(PROPOSER_ROLE, proposer.address)
      ).to.equal(true)
    })

    it("Should grant the executor role to the specified address", async () => {
      expect(
        await timelockDeployed.hasRole(EXECUTOR_ROLE, executor.address)
      ).to.equal(true)
    })
  })
})
