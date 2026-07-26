/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import {
  deployments,
  getNamedAccounts,
  getUnnamedAccounts,
  helpers,
  viem,
} from "hardhat"
import { expect } from "chai"
import { getAddress, parseEther, parseGwei, zeroAddress } from "viem"
import type { Hash } from "viem"
// The client types have to come from the plugin rather than from viem: viem's
// own `WalletClient` leaves `account` optional, while every client the plugin
// hands back has one, and `strict` mode rejects the difference at each use.
import type {
  PublicClient,
  WalletClient,
} from "@nomicfoundation/hardhat-viem/types"
// The stand-in for a typechain import. `ContractTypesMap` is declaration
// merged into `hardhat/types/artifacts` by the `.d.ts` files hardhat-viem
// emits next to the artifacts, so `paths.artifacts` has to be inside the
// tsconfig `include` for these names to resolve.
import type { ContractTypesMap } from "hardhat/types/artifacts"
import { concatenateHexStrings } from "../helpers/contract-test-helpers"
import { expectEvent, expectRevert } from "../helpers/viem"
import longHeaders from "./longHeaders.json"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

/** The fixtures and `concatenateHexStrings` predate viem's `0x`-prefixed hex type. */
const asHex = (value: string) => value as `0x${string}`

type LightRelay = ContractTypesMap["LightRelay"]
type LightRelayMaintainerProxy = ContractTypesMap["LightRelayMaintainerProxy"]
type ReimbursementPool = ContractTypesMap["ReimbursementPool"]

const fixture = async () => {
  await deployments.fixture()

  const publicClient = await viem.getPublicClient()

  const named = await getNamedAccounts()
  const unnamed = await getUnnamedAccounts()

  const deployer = await viem.getWalletClient(getAddress(named.deployer))
  const governance = await viem.getWalletClient(getAddress(named.governance))
  const thirdParty = await viem.getWalletClient(getAddress(unnamed[0]))
  const maintainer = await viem.getWalletClient(getAddress(unnamed[1]))

  // `helpers.contracts.getContract` hands back an ethers contract, so a viem
  // test has to go to the deployment itself for the address and then bind the
  // locally compiled artifact to it. The artifact name has to be a literal at
  // each call site — `getContractAt` derives the contract type from it, so
  // routing these through a `(name: string) => ...` helper would erase every
  // read and write back to an untyped index signature.
  const addressOf = async (name: string) =>
    getAddress((await deployments.get(name)).address)

  const reimbursementPool = await viem.getContractAt(
    "ReimbursementPool",
    await addressOf("ReimbursementPool")
  )
  const lightRelayMaintainerProxy = await viem.getContractAt(
    "LightRelayMaintainerProxy",
    await addressOf("LightRelayMaintainerProxy")
  )
  const lightRelay = await viem.getContractAt(
    "LightRelay",
    await addressOf("LightRelay")
  )

  await lightRelay.write.setAuthorizationStatus([true], {
    account: deployer.account,
  })

  return {
    publicClient,
    deployer,
    governance,
    maintainer,
    thirdParty,
    reimbursementPool,
    lightRelayMaintainerProxy,
    lightRelay,
  }
}

describe("LightRelayMaintainerProxy", () => {
  let publicClient: PublicClient
  let deployer: WalletClient
  let governance: WalletClient
  let maintainer: WalletClient
  let thirdParty: WalletClient
  let reimbursementPool: ReimbursementPool
  let lightRelayMaintainerProxy: LightRelayMaintainerProxy
  let lightRelay: LightRelay

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      publicClient,
      deployer,
      governance,
      maintainer,
      thirdParty,
      reimbursementPool,
      lightRelayMaintainerProxy,
      lightRelay,
    } = await fixture())

    await deployer.sendTransaction({
      to: reimbursementPool.address,
      value: parseEther("100"),
    })
  })

  describe("authorize", () => {
    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expectRevert(
          lightRelayMaintainerProxy.write.authorize(
            [maintainer.account.address],
            { account: thirdParty.account }
          ),
          "Ownable: caller is not the owner"
        )
      })
    })

    context("when called by the owner", () => {
      context("when the maintainer is already authorized", () => {
        before(async () => {
          await createSnapshot()

          // Authorize the maintainer to see if the next attempt reverts.
          await lightRelayMaintainerProxy.write.authorize(
            [maintainer.account.address],
            { account: governance.account }
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expectRevert(
            lightRelayMaintainerProxy.write.authorize(
              [maintainer.account.address],
              { account: governance.account }
            ),
            "Maintainer is already authorized"
          )
        })
      })

      context("when the maintainer is not authorized yet", () => {
        let tx: Hash

        before(async () => {
          await createSnapshot()

          tx = await lightRelayMaintainerProxy.write.authorize(
            [maintainer.account.address],
            { account: governance.account }
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should authorize the address", async () => {
          expect(
            await lightRelayMaintainerProxy.read.isAuthorized([
              maintainer.account.address,
            ])
          ).to.be.true
        })

        it("should emit the MaintainerAuthorized event", async () => {
          await expectEvent(
            publicClient,
            tx,
            lightRelayMaintainerProxy,
            "MaintainerAuthorized",
            [maintainer.account.address]
          )
        })
      })
    })
  })

  describe("deauthorize", () => {
    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expectRevert(
          lightRelayMaintainerProxy.write.deauthorize(
            [maintainer.account.address],
            { account: thirdParty.account }
          ),
          "Ownable: caller is not the owner"
        )
      })
    })

    context("when called by the owner", () => {
      context("when the maintainer is not authorized", () => {
        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expectRevert(
            lightRelayMaintainerProxy.write.deauthorize(
              [maintainer.account.address],
              { account: governance.account }
            ),
            "Maintainer is not authorized"
          )
        })
      })

      context("when the maintainer is authorized", () => {
        let tx: Hash

        before(async () => {
          await createSnapshot()

          // Authorize the maintainer first
          await lightRelayMaintainerProxy.write.authorize(
            [maintainer.account.address],
            { account: governance.account }
          )

          tx = await lightRelayMaintainerProxy.write.deauthorize(
            [maintainer.account.address],
            { account: governance.account }
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should deauthorize the address", async () => {
          expect(
            await lightRelayMaintainerProxy.read.isAuthorized([
              maintainer.account.address,
            ])
          ).to.be.false
        })

        it("should emit the MaintainerDeauthorized event", async () => {
          await expectEvent(
            publicClient,
            tx,
            lightRelayMaintainerProxy,
            "MaintainerDeauthorized",
            [maintainer.account.address]
          )
        })
      })
    })
  })

  describe("updateLightRelay", () => {
    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expectRevert(
          lightRelayMaintainerProxy.write.updateLightRelay(
            [thirdParty.account.address],
            { account: thirdParty.account }
          ),
          "Ownable: caller is not the owner"
        )
      })
    })

    context("when called by the owner", () => {
      context("when called with zero address", () => {
        it("should revert", async () => {
          await expectRevert(
            lightRelayMaintainerProxy.write.updateLightRelay([zeroAddress], {
              account: governance.account,
            }),
            "New light relay must not be zero address"
          )
        })
      })

      context("when called with a non-zero address", () => {
        let tx: Hash

        before(async () => {
          await createSnapshot()

          tx = await lightRelayMaintainerProxy.write.updateLightRelay(
            [thirdParty.account.address],
            { account: governance.account }
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the light relay address", async () => {
          expect(await lightRelayMaintainerProxy.read.lightRelay()).to.be.equal(
            getAddress(thirdParty.account.address)
          )
        })

        it("should emit the LightRelayUpdated event", async () => {
          await expectEvent(
            publicClient,
            tx,
            lightRelayMaintainerProxy,
            "LightRelayUpdated",
            [thirdParty.account.address]
          )
        })
      })
    })
  })

  describe("updateReimbursementPool", () => {
    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expectRevert(
          lightRelayMaintainerProxy.write.updateReimbursementPool(
            [thirdParty.account.address],
            { account: thirdParty.account }
          ),
          "Caller is not the owner"
        )
      })
    })

    context("when called by the owner", () => {
      let tx: Hash

      before(async () => {
        await createSnapshot()
        tx = await lightRelayMaintainerProxy.write.updateReimbursementPool(
          [thirdParty.account.address],
          { account: governance.account }
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit the ReimbursementPoolUpdated event", async () => {
        await expectEvent(
          publicClient,
          tx,
          lightRelayMaintainerProxy,
          "ReimbursementPoolUpdated",
          [thirdParty.account.address]
        )
      })
    })
  })

  describe("updateRetargetGasOffset", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expectRevert(
          lightRelayMaintainerProxy.write.updateRetargetGasOffset(
            [BigInt(123456)],
            {
              account: thirdParty.account,
            }
          ),
          "Ownable: caller is not the owner"
        )
      })
    })

    context("when called by the owner", () => {
      let tx: Hash

      before(async () => {
        await createSnapshot()
        tx = await lightRelayMaintainerProxy.write.updateRetargetGasOffset(
          [BigInt(123456)],
          { account: governance.account }
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit the RetargetGasOffsetUpdated event", async () => {
        await expectEvent(
          publicClient,
          tx,
          lightRelayMaintainerProxy,
          "RetargetGasOffsetUpdated",
          [123456]
        )
      })

      it("should update retargetGasOffset", async () => {
        const updatedOffset =
          await lightRelayMaintainerProxy.read.retargetGasOffset()
        expect(updatedOffset).to.be.equal(BigInt(123456))
      })
    })
  })

  describe("retarget", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by an unauthorized address", () => {
      const headerHex = longHeaders.chain.map((h) => h.hex)
      const retargetHeaders = asHex(
        concatenateHexStrings(headerHex.slice(85, 105))
      )

      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        await expectRevert(
          lightRelayMaintainerProxy.write.retarget([retargetHeaders], {
            account: thirdParty.account,
          }),
          "Caller is not authorized"
        )
      })
    })

    context("when called by an authorized maintainer", () => {
      context("when the proof length is 10 headers", () => {
        const genesis = longHeaders.epochStart
        const headerHex = longHeaders.chain.map((h) => h.hex)
        const retargetHeaders = asHex(
          concatenateHexStrings(headerHex.slice(85, 105))
        )
        const genesisProofLength = 10

        let initialMaintainerBalance: bigint
        let tx: Hash

        before(async () => {
          await createSnapshot()

          await lightRelay.write.genesis(
            [
              asHex(genesis.hex),
              BigInt(genesis.height),
              BigInt(genesisProofLength),
            ],
            { account: deployer.account }
          )

          await lightRelayMaintainerProxy.write.authorize(
            [maintainer.account.address],
            { account: governance.account }
          )

          // Since the default retarget gas offset parameter is set to a value
          // appropriate for the proof length of 20, set it to a lower value.
          await lightRelayMaintainerProxy.write.updateRetargetGasOffset(
            [BigInt(30000)],
            { account: governance.account }
          )

          initialMaintainerBalance = await publicClient.getBalance({
            address: maintainer.account.address,
          })
          tx = await lightRelayMaintainerProxy.write.retarget(
            [retargetHeaders],
            { account: maintainer.account }
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Retarget event", async () => {
          await expectEvent(publicClient, tx, lightRelay, "Retarget")
        })

        it("should refund ETH", async () => {
          const postMaintainerBalance = await publicClient.getBalance({
            address: maintainer.account.address,
          })
          const diff = postMaintainerBalance - initialMaintainerBalance

          expect(diff > BigInt(0)).to.be.true
          expect(diff < parseGwei("1000000")).to.be.true // 0,001 ETH
        })
      })

      context("when the proof length is 20 headers", () => {
        const genesis = longHeaders.epochStart
        const headerHex = longHeaders.chain.map((h) => h.hex)
        const retargetHeaders = asHex(
          concatenateHexStrings(headerHex.slice(75, 115))
        )
        const genesisProofLength = 20

        let initialMaintainerBalance: bigint
        let tx: Hash

        before(async () => {
          await createSnapshot()

          await lightRelay.write.genesis(
            [
              asHex(genesis.hex),
              BigInt(genesis.height),
              BigInt(genesisProofLength),
            ],
            { account: deployer.account }
          )

          await lightRelayMaintainerProxy.write.authorize(
            [maintainer.account.address],
            { account: governance.account }
          )

          initialMaintainerBalance = await publicClient.getBalance({
            address: maintainer.account.address,
          })

          // Do not change the retarget gas offset parameter. The default value
          // should be appropriate for the proof length of 20.
          tx = await lightRelayMaintainerProxy.write.retarget(
            [retargetHeaders],
            { account: maintainer.account }
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Retarget event", async () => {
          await expectEvent(publicClient, tx, lightRelay, "Retarget")
        })

        it("should refund ETH", async () => {
          const postMaintainerBalance = await publicClient.getBalance({
            address: maintainer.account.address,
          })
          const diff = postMaintainerBalance - initialMaintainerBalance

          expect(diff > BigInt(0)).to.be.true
          expect(diff < parseGwei("1000000")).to.be.true // 0,001 ETH
        })
      })

      context("when the proof length is 50 headers", () => {
        const genesis = longHeaders.epochStart
        const headerHex = longHeaders.chain.map((h) => h.hex)
        const retargetHeaders = asHex(
          concatenateHexStrings(headerHex.slice(45, 145))
        )
        const genesisProofLength = 50

        let initialMaintainerBalance: bigint
        let tx: Hash

        before(async () => {
          await createSnapshot()

          await lightRelay.write.genesis(
            [
              asHex(genesis.hex),
              BigInt(genesis.height),
              BigInt(genesisProofLength),
            ],
            { account: deployer.account }
          )

          await lightRelayMaintainerProxy.write.authorize(
            [maintainer.account.address],
            { account: governance.account }
          )

          // Since the default retarget gas offset parameter is set to a value
          // appropriate for the proof length of 20, set it to a higher value.
          await lightRelayMaintainerProxy.write.updateRetargetGasOffset(
            [BigInt(120000)],
            { account: governance.account }
          )

          initialMaintainerBalance = await publicClient.getBalance({
            address: maintainer.account.address,
          })

          tx = await lightRelayMaintainerProxy.write.retarget(
            [retargetHeaders],
            { account: maintainer.account }
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Retarget event", async () => {
          await expectEvent(publicClient, tx, lightRelay, "Retarget")
        })

        it("should refund ETH", async () => {
          const postMaintainerBalance = await publicClient.getBalance({
            address: maintainer.account.address,
          })
          const diff = postMaintainerBalance - initialMaintainerBalance

          expect(diff > BigInt(0)).to.be.true
          expect(diff < parseGwei("1000000")).to.be.true // 0,001 ETH
        })
      })
    })
  })
})
