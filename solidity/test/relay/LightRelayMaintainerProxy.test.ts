/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, deployments, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ContractTransaction, BigNumber } from "ethers"
import type {
  LightRelay,
  LightRelayMaintainerProxy,
  ReimbursementPool,
} from "../../typechain"
import { concatenateHexStrings } from "../helpers/contract-test-helpers"
import longHeaders from "./longHeaders.json"
import { loadFixture } from "../helpers/fixture"

const { provider } = ethers

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const ZERO_ADDRESS = ethers.constants.AddressZero

const fixture = async () => {
  await deployments.fixture()

  const { deployer, governance } = await helpers.signers.getNamedSigners()
  const [thirdParty, maintainer] = await helpers.signers.getUnnamedSigners()

  const reimbursementPool: ReimbursementPool =
    await helpers.contracts.getContract("ReimbursementPool")

  const lightRelayMaintainerProxy: LightRelayMaintainerProxy =
    await helpers.contracts.getContract("LightRelayMaintainerProxy")

  const lightRelay: LightRelay = await helpers.contracts.getContract(
    "LightRelay"
  )

  await lightRelay.connect(deployer).setAuthorizationStatus(true)

  return {
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
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let maintainer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let reimbursementPool: ReimbursementPool
  let lightRelayMaintainerProxy: LightRelayMaintainerProxy
  let lightRelay: LightRelay

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      maintainer,
      thirdParty,
      reimbursementPool,
      lightRelayMaintainerProxy,
      lightRelay,
    } = await loadFixture(fixture))

    await deployer.sendTransaction({
      to: reimbursementPool.address,
      value: ethers.utils.parseEther("100"),
    })
  })

  describe("authorize", () => {
    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expect(
          lightRelayMaintainerProxy
            .connect(thirdParty)
            .authorize(maintainer.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when the maintainer is already authorized", () => {
        before(async () => {
          await createSnapshot()

          // Authorize the maintainer to see if the next attempt reverts.
          await lightRelayMaintainerProxy
            .connect(governance)
            .authorize(maintainer.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            lightRelayMaintainerProxy
              .connect(governance)
              .authorize(maintainer.address)
          ).to.be.revertedWith("Maintainer is already authorized")
        })
      })

      context("when the maintainer is not authorized yet", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await lightRelayMaintainerProxy
            .connect(governance)
            .authorize(maintainer.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should authorize the address", async () => {
          expect(
            await lightRelayMaintainerProxy.isAuthorized(maintainer.address)
          ).to.be.true
        })

        it("should emit the MaintainerAuthorized event", async () => {
          await expect(tx)
            .to.emit(lightRelayMaintainerProxy, "MaintainerAuthorized")
            .withArgs(maintainer.address)
        })
      })
    })
  })

  describe("deauthorize", () => {
    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expect(
          lightRelayMaintainerProxy
            .connect(thirdParty)
            .deauthorize(maintainer.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
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
          await expect(
            lightRelayMaintainerProxy
              .connect(governance)
              .deauthorize(maintainer.address)
          ).to.be.revertedWith("Maintainer is not authorized")
        })
      })

      context("when the maintainer is authorized", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          // Authorize the maintainer first
          await lightRelayMaintainerProxy
            .connect(governance)
            .authorize(maintainer.address)

          tx = await lightRelayMaintainerProxy
            .connect(governance)
            .deauthorize(maintainer.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should deauthorize the address", async () => {
          expect(
            await lightRelayMaintainerProxy.isAuthorized(maintainer.address)
          ).to.be.false
        })

        it("should emit the MaintainerDeauthorized event", async () => {
          await expect(tx)
            .to.emit(lightRelayMaintainerProxy, "MaintainerDeauthorized")
            .withArgs(maintainer.address)
        })
      })
    })
  })

  describe("updateLightRelay", () => {
    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expect(
          lightRelayMaintainerProxy
            .connect(thirdParty)
            .updateLightRelay(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when called with zero address", () => {
        it("should revert", async () => {
          await expect(
            lightRelayMaintainerProxy
              .connect(governance)
              .updateLightRelay(ZERO_ADDRESS)
          ).to.be.revertedWith("New light relay must not be zero address")
        })
      })

      context("when called with a non-zero address", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await lightRelayMaintainerProxy
            .connect(governance)
            .updateLightRelay(thirdParty.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the light relay address", async () => {
          expect(await lightRelayMaintainerProxy.lightRelay()).to.be.equal(
            thirdParty.address
          )
        })

        it("should emit the LightRelayUpdated event", async () => {
          await expect(tx)
            .to.emit(lightRelayMaintainerProxy, "LightRelayUpdated")
            .withArgs(thirdParty.address)
        })
      })
    })
  })

  describe("updateReimbursementPool", () => {
    context("when called by non-owner", () => {
      it("should revert", async () => {
        await expect(
          lightRelayMaintainerProxy
            .connect(thirdParty)
            .updateReimbursementPool(thirdParty.address)
        ).to.be.revertedWith("Caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await lightRelayMaintainerProxy
          .connect(governance)
          .updateReimbursementPool(thirdParty.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit the ReimbursementPoolUpdated event", async () => {
        await expect(tx)
          .to.emit(lightRelayMaintainerProxy, "ReimbursementPoolUpdated")
          .withArgs(thirdParty.address)
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
        await expect(
          lightRelayMaintainerProxy
            .connect(thirdParty)
            .updateRetargetGasOffset(123456)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await lightRelayMaintainerProxy
          .connect(governance)
          .updateRetargetGasOffset(123456)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit the RetargetGasOffsetUpdated event", async () => {
        await expect(tx)
          .to.emit(lightRelayMaintainerProxy, "RetargetGasOffsetUpdated")
          .withArgs(123456)
      })

      it("should update retargetGasOffset", async () => {
        const updatedOffset =
          await lightRelayMaintainerProxy.retargetGasOffset()
        expect(updatedOffset).to.be.equal(123456)
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
      const retargetHeaders = concatenateHexStrings(headerHex.slice(85, 105))

      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        const tx = lightRelayMaintainerProxy
          .connect(thirdParty)
          .retarget(retargetHeaders)

        await expect(tx).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when called by an authorized maintainer", () => {
      context("when the proof length is 10 headers", () => {
        const genesis = longHeaders.epochStart
        const headerHex = longHeaders.chain.map((h) => h.hex)
        const retargetHeaders = concatenateHexStrings(headerHex.slice(85, 105))
        const genesisProofLength = 10

        let initialMaintainerBalance: BigNumber
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await lightRelay
            .connect(deployer)
            .genesis(genesis.hex, genesis.height, genesisProofLength)

          await lightRelayMaintainerProxy
            .connect(governance)
            .authorize(maintainer.address)

          // Since the default retarget gas offset parameter is set to a value
          // appropriate for the proof length of 20, set it to a lower value.
          await lightRelayMaintainerProxy
            .connect(governance)
            .updateRetargetGasOffset(30000)

          initialMaintainerBalance = await provider.getBalance(
            maintainer.address
          )
          tx = await lightRelayMaintainerProxy
            .connect(maintainer)
            .retarget(retargetHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Retarget event", async () => {
          await expect(tx).to.emit(lightRelay, "Retarget")
        })

        it("should refund ETH", async () => {
          const postMaintainerBalance = await provider.getBalance(
            maintainer.address
          )
          const diff = postMaintainerBalance.sub(initialMaintainerBalance)

          expect(diff).to.be.gt(0)
          expect(diff).to.be.lt(
            ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
          )
        })
      })

      context("when the proof length is 20 headers", () => {
        const genesis = longHeaders.epochStart
        const headerHex = longHeaders.chain.map((h) => h.hex)
        const retargetHeaders = concatenateHexStrings(headerHex.slice(75, 115))
        const genesisProofLength = 20

        let initialMaintainerBalance: BigNumber
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await lightRelay
            .connect(deployer)
            .genesis(genesis.hex, genesis.height, genesisProofLength)

          await lightRelayMaintainerProxy
            .connect(governance)
            .authorize(maintainer.address)

          initialMaintainerBalance = await provider.getBalance(
            maintainer.address
          )

          // Do not change the retarget gas offset parameter. The default value
          // should be appropriate for the proof length of 20.
          tx = await lightRelayMaintainerProxy
            .connect(maintainer)
            .retarget(retargetHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Retarget event", async () => {
          await expect(tx).to.emit(lightRelay, "Retarget")
        })

        it("should refund ETH", async () => {
          const postMaintainerBalance = await provider.getBalance(
            maintainer.address
          )
          const diff = postMaintainerBalance.sub(initialMaintainerBalance)

          expect(diff).to.be.gt(0)
          expect(diff).to.be.lt(
            ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
          )
        })
      })

      context("when the proof length is 50 headers", () => {
        const genesis = longHeaders.epochStart
        const headerHex = longHeaders.chain.map((h) => h.hex)
        const retargetHeaders = concatenateHexStrings(headerHex.slice(45, 145))
        const genesisProofLength = 50

        let initialMaintainerBalance: BigNumber
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await lightRelay
            .connect(deployer)
            .genesis(genesis.hex, genesis.height, genesisProofLength)

          await lightRelayMaintainerProxy
            .connect(governance)
            .authorize(maintainer.address)

          // Since the default retarget gas offset parameter is set to a value
          // appropriate for the proof length of 20, set it to a higher value.
          await lightRelayMaintainerProxy
            .connect(governance)
            .updateRetargetGasOffset(120000)

          initialMaintainerBalance = await provider.getBalance(
            maintainer.address
          )

          tx = await lightRelayMaintainerProxy
            .connect(maintainer)
            .retarget(retargetHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Retarget event", async () => {
          await expect(tx).to.emit(lightRelay, "Retarget")
        })

        it("should refund ETH", async () => {
          const postMaintainerBalance = await provider.getBalance(
            maintainer.address
          )
          const diff = postMaintainerBalance.sub(initialMaintainerBalance)

          expect(diff).to.be.gt(0)
          expect(diff).to.be.lt(
            ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
          )
        })
      })
    })
  })
})
