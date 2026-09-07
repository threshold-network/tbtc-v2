import { expect } from "chai"
import { ethers } from "hardhat"
import { mine, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import deployReimbursementPool from "@keep-network/random-beacon/export/deploy/01_deploy_reimbursement_pool"
import deployBeaconSortitionPool from "@keep-network/random-beacon/export/deploy/02_deploy_beacon_sortition_pool"
import deployBeaconDkgValidator from "@keep-network/random-beacon/export/deploy/03_deploy_beacon_dkg_validator"
import deployRandomBeacon from "@keep-network/random-beacon/export/deploy/04_deploy_random_beacon"
import deployRandomBeaconGovernance from "@keep-network/random-beacon/export/deploy/07_deploy_random_beacon_governance"
import deployRandomBeaconChaosnet from "@keep-network/random-beacon/export/deploy/09_deploy_random_beacon_chaosnet"
import waitForConfirmations from "../../helpers/wait-for-confirmations"

const scripts: [string, string[], DeployFunction][] = [
  [
    "01_deploy_reimbursement_pool.js",
    ["ReimbursementPool"],
    deployReimbursementPool,
  ],
  [
    "02_deploy_beacon_sortition_pool.js",
    ["BeaconSortitionPool"],
    deployBeaconSortitionPool,
  ],
  [
    "03_deploy_beacon_dkg_validator.js",
    ["BeaconDkgValidator"],
    deployBeaconDkgValidator,
  ],
  [
    "04_deploy_random_beacon.js",
    [
      "BLS",
      "BeaconAuthorization",
      "BeaconDkg",
      "BeaconInactivity",
      "RandomBeacon",
    ],
    deployRandomBeacon,
  ],
  [
    "07_deploy_random_beacon_governance.js",
    ["RandomBeaconGovernance"],
    deployRandomBeaconGovernance,
  ],
  [
    "09_deploy_random_beacon_chaosnet.js",
    ["RandomBeaconChaosnet"],
    deployRandomBeaconChaosnet,
  ],
]

function createMockHre(missingTransactionHash = false) {
  const deployer = "0x1000000000000000000000000000000000000001"
  const verified: string[] = []
  const effects: string[] = []
  const deployment = (name: string) => ({
    address: "0x2000000000000000000000000000000000000002",
    transactionHash: missingTransactionHash ? undefined : ethers.id(name),
    name,
  })
  let release: () => void
  let entered: () => void
  const confirmed = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })

  const provider = {
    // The old callers reach the actual v6 NotImplementedError here.
    waitForTransaction: ethers.provider.waitForTransaction.bind(
      ethers.provider
    ),
    getTransaction: async (hash: string) => {
      effects.push(`getTransaction:${hash}`)
      return {
        wait: async (confirmations: number, timeout: number) => {
          expect(confirmations).to.equal(2)
          expect(timeout).to.equal(300000)
          effects.push(`wait:${hash}`)
          entered()
          await confirmed
          effects.push("confirmed")
          return { hash, status: 1 }
        },
      }
    },
  }
  const mockHre = {
    getNamedAccounts: async () => ({ deployer, chaosnetOwner: deployer }),
    deployments: {
      get: async (name: string) => deployment(name),
      getOrNull: async () => null,
      read: async () => deployer,
      deploy: async (name: string) => {
        effects.push(`deploy:${name}`)
        return deployment(name)
      },
      execute: async () => effects.push("execute"),
      log: () => {},
    },
    helpers: {
      address: {
        equal: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      },
      number: {
        to1e18: (value: number) => ethers.parseEther(value.toString()),
      },
      ownable: {
        transferOwnership: async () => effects.push("transferOwnership"),
      },
      etherscan: {
        verify: async (result: { name: string }) => {
          verified.push(result.name)
          effects.push(`verify:${result.name}`)
        },
      },
    },
    ethers: { provider },
    network: { name: "mainnet", tags: { etherscan: true, tenderly: true } },
    tenderly: { verify: async () => effects.push("tenderly") },
  } as unknown as HardhatRuntimeEnvironment

  return { mockHre, verified, effects, waiting, release, provider }
}

describe("external deployment confirmations", () => {
  scripts.forEach(([file, contracts, deployScript]) => {
    it(`${file} waits before verification on explorer-tagged networks`, async () => {
      const { mockHre, verified, effects, waiting, release } = createMockHre()
      const execution = deployScript(mockHre)
      try {
        await Promise.race([waiting, execution])
        expect(verified).to.be.empty
        expect(effects).not.to.include("tenderly")
        expect(effects[effects.length - 1]).to.equal(
          `wait:${ethers.id(contracts[contracts.length - 1])}`
        )
      } finally {
        release()
      }
      await execution
      expect(verified).to.deep.equal([...contracts])
      expect(effects.indexOf("confirmed")).to.be.lessThan(
        effects.indexOf(`verify:${contracts[0]}`)
      )
      expect(effects[effects.length - 1]).to.equal("tenderly")
    })

    it(`${file} skips the confirmation lookup without the explorer tag`, async () => {
      const { mockHre, verified, effects, release } = createMockHre()
      mockHre.network.tags.etherscan = false
      release()
      await deployScript(mockHre)
      expect(verified).to.be.empty
      expect(
        effects.some((effect) => effect.startsWith("getTransaction:"))
      ).to.equal(false)
      expect(effects).not.to.include("confirmed")
      expect(effects[effects.length - 1]).to.equal("tenderly")
    })
  })

  it("stops before verification when the deployment hash is missing", async () => {
    const { mockHre, verified, effects } = createMockHre(true)
    await expect(deployReimbursementPool(mockHre)).to.be.rejectedWith(
      "Deployment transaction hash is missing"
    )
    expect(verified).to.be.empty
    expect(effects).not.to.include("tenderly")
  })

  it("stops before verification when the saved transaction cannot be found", async () => {
    const { mockHre, verified, effects, provider } = createMockHre()
    provider.getTransaction = async () => null
    await expect(deployReimbursementPool(mockHre)).to.be.rejectedWith(
      `Deployment transaction ${ethers.id("ReimbursementPool")} was not found`
    )
    expect(verified).to.be.empty
    expect(effects).not.to.include("tenderly")
  })

  it("propagates RPC lookup errors before verification", async () => {
    const { mockHre, verified, effects, provider } = createMockHre()
    const failure = new Error("RPC unavailable")
    provider.getTransaction = async () => {
      throw failure
    }
    await expect(deployReimbursementPool(mockHre)).to.be.rejectedWith(failure)
    expect(verified).to.be.empty
    expect(effects).not.to.include("tenderly")
  })

  it("propagates confirmation timeouts before verification", async () => {
    const { mockHre, verified, effects, provider } = createMockHre()
    const failure = new Error("wait for transaction timeout")
    provider.getTransaction = async () => ({
      wait: async () => {
        throw failure
      },
    })
    await expect(deployReimbursementPool(mockHre)).to.be.rejectedWith(failure)
    expect(verified).to.be.empty
    expect(effects).not.to.include("tenderly")
  })

  it("rejects an empty confirmation result before verification", async () => {
    const { mockHre, verified, effects, provider } = createMockHre()
    provider.getTransaction = async () => ({ wait: async () => null })
    await expect(deployReimbursementPool(mockHre)).to.be.rejectedWith(
      `Deployment transaction ${ethers.id(
        "ReimbursementPool"
      )} is not confirmed`
    )
    expect(verified).to.be.empty
    expect(effects).not.to.include("tenderly")
  })

  it("uses the v6 provider to time out at one confirmation and accept two", async () => {
    const snapshot = await takeSnapshot()
    try {
      const [sender, receiver] = await ethers.getSigners()
      const tx = await sender.sendTransaction({
        to: receiver.address,
        value: 0,
      })
      await tx.wait()
      await expect(
        waitForConfirmations(ethers.provider, tx.hash, 2, 25)
      ).to.be.rejectedWith("wait for transaction timeout")
      await mine()
      const receipt = await waitForConfirmations(
        ethers.provider,
        tx.hash,
        2,
        1000
      )
      expect(receipt.hash).to.equal(tx.hash)
      expect(await receipt.confirmations()).to.be.gte(2)
    } finally {
      await snapshot.restore()
    }
  })
})
