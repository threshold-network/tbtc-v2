import { randomBytes } from "crypto"
import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import type { ContractTransaction } from "ethers"
import type { ISeatAllocator, SignerRegistry } from "../../typechain"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime } = helpers.time

const ZERO_ADDRESS = ethers.constants.AddressZero

const GOVERNANCE_DELAY = 172800 // 48 hours
const COMMISSION_NOTICE_PERIOD = 2592000 // 30 days
const MAX_COMMISSION_BPS = 2500
const MAX_COMMISSION_STEP_BPS = 500

const OperatorStatus = {
  None: 0,
  Active: 1,
  Deactivating: 2,
  Ejected: 3,
}

describe("SignerRegistry", () => {
  let deployer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let provider1: SignerWithAddress
  let provider2: SignerWithAddress
  let nodeOperator1: SignerWithAddress
  let nodeOperator2: SignerWithAddress
  let beneficiary1: SignerWithAddress
  let beneficiary2: SignerWithAddress

  let signerRegistry: SignerRegistry
  let seatAllocator: FakeContract<ISeatAllocator>

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[
      deployer,
      thirdParty,
      provider1,
      provider2,
      nodeOperator1,
      nodeOperator2,
      beneficiary1,
      beneficiary2,
    ] = await ethers.getSigners()

    // hardhat-deploy persists proxy deployments by name across test
    // processes; a random suffix keeps re-runs collision-free (same idiom
    // as the sibling staking suites).
    const [registry] = await helpers.upgrades.deployProxy(
      `SignerRegistry_${randomBytes(8).toString("hex")}`,
      {
        contractName: "SignerRegistry",
        initializerArgs: [
          GOVERNANCE_DELAY,
          COMMISSION_NOTICE_PERIOD,
          MAX_COMMISSION_BPS,
          MAX_COMMISSION_STEP_BPS,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    signerRegistry = registry as SignerRegistry

    seatAllocator = await smock.fake<ISeatAllocator>("ISeatAllocator")
  })

  async function addActiveOperator(
    stakingProvider: string,
    nodeOperator: string,
    beneficiary: string,
    commissionBps: number
  ): Promise<void> {
    await signerRegistry
      .connect(deployer)
      .beginOperatorAddition(
        stakingProvider,
        nodeOperator,
        beneficiary,
        commissionBps
      )
    await increaseTime(GOVERNANCE_DELAY)
    await signerRegistry
      .connect(deployer)
      .finalizeOperatorAddition(stakingProvider)
  }

  describe("initialization", () => {
    it("should set the governed parameters", async () => {
      expect(await signerRegistry.governanceDelay()).to.equal(GOVERNANCE_DELAY)
      expect(await signerRegistry.commissionNoticePeriod()).to.equal(
        COMMISSION_NOTICE_PERIOD
      )
      expect(await signerRegistry.maxCommissionBps()).to.equal(
        MAX_COMMISSION_BPS
      )
      expect(await signerRegistry.maxCommissionStepBps()).to.equal(
        MAX_COMMISSION_STEP_BPS
      )
    })

    it("should set the owner to the deployer", async () => {
      expect(await signerRegistry.owner()).to.equal(deployer.address)
    })

    it("should leave the seat allocator unset", async () => {
      expect(await signerRegistry.seatAllocator()).to.equal(ZERO_ADDRESS)
    })

    it("should report unknown providers as None and inactive", async () => {
      expect(await signerRegistry.operatorStatus(thirdParty.address)).to.equal(
        OperatorStatus.None
      )
      expect(await signerRegistry.isActive(thirdParty.address)).to.be.false
      expect(await signerRegistry.nodeOperatorOf(thirdParty.address)).to.equal(
        ZERO_ADDRESS
      )
      expect(
        await signerRegistry.stakingProviderOf(thirdParty.address)
      ).to.equal(ZERO_ADDRESS)
      expect(await signerRegistry.commissionBpsOf(thirdParty.address)).to.equal(
        0
      )
    })
  })

  describe("beginOperatorAddition", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry
            .connect(thirdParty)
            .beginOperatorAddition(
              provider1.address,
              nodeOperator1.address,
              beneficiary1.address,
              1000
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when an address parameter is zero", () => {
      it("should revert for a zero staking provider", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              ZERO_ADDRESS,
              nodeOperator1.address,
              beneficiary1.address,
              1000
            )
        ).to.be.revertedWith("ZeroAddress")
      })

      it("should revert for a zero node operator", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider1.address,
              ZERO_ADDRESS,
              beneficiary1.address,
              1000
            )
        ).to.be.revertedWith("ZeroAddress")
      })

      it("should revert for a zero beneficiary", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider1.address,
              nodeOperator1.address,
              ZERO_ADDRESS,
              1000
            )
        ).to.be.revertedWith("ZeroAddress")
      })
    })

    context("when the commission exceeds the maximum", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider1.address,
              nodeOperator1.address,
              beneficiary1.address,
              MAX_COMMISSION_BPS + 1
            )
        ).to.be.revertedWith("CommissionExceedsMax")
      })
    })

    context("when called with valid parameters", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await signerRegistry
          .connect(deployer)
          .beginOperatorAddition(
            provider1.address,
            nodeOperator1.address,
            beneficiary1.address,
            1000
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit OperatorAdditionBegan", async () => {
        await expect(tx)
          .to.emit(signerRegistry, "OperatorAdditionBegan")
          .withArgs(
            provider1.address,
            nodeOperator1.address,
            beneficiary1.address,
            1000
          )
      })

      it("should record the pending operator data without activating", async () => {
        const operator = await signerRegistry.operators(provider1.address)
        expect(operator.status).to.equal(OperatorStatus.None)
        expect(operator.nodeOperator).to.equal(nodeOperator1.address)
        expect(operator.beneficiary).to.equal(beneficiary1.address)
        expect(operator.commissionBps).to.equal(1000)
        expect(operator.statusChangeInitiated).to.be.gt(0)

        expect(await signerRegistry.isActive(provider1.address)).to.be.false
        // Reverse mapping is claimed only at finalization.
        expect(
          await signerRegistry.stakingProviderOf(nodeOperator1.address)
        ).to.equal(ZERO_ADDRESS)
      })

      it("should allow overwriting the pending addition", async () => {
        await signerRegistry
          .connect(deployer)
          .beginOperatorAddition(
            provider1.address,
            nodeOperator2.address,
            beneficiary2.address,
            500
          )

        const operator = await signerRegistry.operators(provider1.address)
        expect(operator.nodeOperator).to.equal(nodeOperator2.address)
        expect(operator.beneficiary).to.equal(beneficiary2.address)
        expect(operator.commissionBps).to.equal(500)
      })
    })

    context("when the operator already exists", () => {
      before(async () => {
        await createSnapshot()
        await addActiveOperator(
          provider1.address,
          nodeOperator1.address,
          beneficiary1.address,
          1000
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider1.address,
              nodeOperator2.address,
              beneficiary1.address,
              1000
            )
        ).to.be.revertedWith("OperatorAlreadyExists")
      })

      it("should revert for a duplicate node operator", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider2.address,
              nodeOperator1.address,
              beneficiary2.address,
              1000
            )
        ).to.be.revertedWith("NodeOperatorAlreadyUsed")
      })
    })
  })

  describe("finalizeOperatorAddition", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when no addition is pending", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .finalizeOperatorAddition(provider1.address)
        ).to.be.revertedWith("NoPendingAddition")
      })
    })

    context("when an addition is pending", () => {
      before(async () => {
        await createSnapshot()
        await signerRegistry
          .connect(deployer)
          .beginOperatorAddition(
            provider1.address,
            nodeOperator1.address,
            beneficiary1.address,
            1000
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when called not by the owner", () => {
        it("should revert", async () => {
          await expect(
            signerRegistry
              .connect(thirdParty)
              .finalizeOperatorAddition(provider1.address)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("before the governance delay elapsed", () => {
        it("should revert", async () => {
          await increaseTime(GOVERNANCE_DELAY - 60)
          await expect(
            signerRegistry
              .connect(deployer)
              .finalizeOperatorAddition(provider1.address)
          ).to.be.revertedWith("Governance delay has not elapsed")
        })
      })

      context("after the governance delay elapsed", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          await increaseTime(GOVERNANCE_DELAY)
          seatAllocator.refreshAuthorization.reset()
          tx = await signerRegistry
            .connect(deployer)
            .finalizeOperatorAddition(provider1.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should activate the operator", async () => {
          expect(
            await signerRegistry.operatorStatus(provider1.address)
          ).to.equal(OperatorStatus.Active)
          expect(await signerRegistry.isActive(provider1.address)).to.be.true
        })

        it("should expose the operator data through the views", async () => {
          expect(
            await signerRegistry.nodeOperatorOf(provider1.address)
          ).to.equal(nodeOperator1.address)
          expect(
            await signerRegistry.stakingProviderOf(nodeOperator1.address)
          ).to.equal(provider1.address)
          expect(
            await signerRegistry.beneficiaryOf(provider1.address)
          ).to.equal(beneficiary1.address)
          expect(
            await signerRegistry.commissionBpsOf(provider1.address)
          ).to.equal(1000)
        })

        it("should clear the status change timestamp", async () => {
          const operator = await signerRegistry.operators(provider1.address)
          expect(operator.statusChangeInitiated).to.equal(0)
        })

        it("should emit OperatorAdded", async () => {
          await expect(tx)
            .to.emit(signerRegistry, "OperatorAdded")
            .withArgs(
              provider1.address,
              nodeOperator1.address,
              beneficiary1.address,
              1000
            )
        })

        it("should tolerate an unset seat allocator", async () => {
          // The allocator was not wired for this deployment; the finalization
          // above succeeded and no call reached the fake.
          expect(seatAllocator.refreshAuthorization).to.have.callCount(0)
        })

        it("should not allow finalizing deactivation right away", async () => {
          // The addition cleared `statusChangeInitiated`; the deactivation
          // finalizer must not reuse the stale addition timestamp.
          await expect(
            signerRegistry
              .connect(deployer)
              .finalizeDeactivation(provider1.address)
          ).to.be.revertedWith("NoPendingDeactivation")
        })
      })
    })

    context("when the seat allocator is wired", () => {
      before(async () => {
        await createSnapshot()
        await signerRegistry
          .connect(deployer)
          .setSeatAllocator(seatAllocator.address)
        seatAllocator.refreshAuthorization.reset()
        await addActiveOperator(
          provider1.address,
          nodeOperator1.address,
          beneficiary1.address,
          1000
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should refresh the operator's authorization", async () => {
        expect(seatAllocator.refreshAuthorization).to.have.been.calledOnceWith(
          provider1.address
        )
      })
    })

    context(
      "when another pending addition claimed the node operator first",
      () => {
        before(async () => {
          await createSnapshot()
          await signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider1.address,
              nodeOperator1.address,
              beneficiary1.address,
              1000
            )
          await signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider2.address,
              nodeOperator1.address,
              beneficiary2.address,
              1000
            )
          await increaseTime(GOVERNANCE_DELAY)
          await signerRegistry
            .connect(deployer)
            .finalizeOperatorAddition(provider1.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert finalization of the second addition", async () => {
          await expect(
            signerRegistry
              .connect(deployer)
              .finalizeOperatorAddition(provider2.address)
          ).to.be.revertedWith("NodeOperatorAlreadyUsed")
        })
      }
    )
  })

  describe("beginDeactivation and finalizeDeactivation", () => {
    before(async () => {
      await createSnapshot()
      await addActiveOperator(
        provider1.address,
        nodeOperator1.address,
        beneficiary1.address,
        1000
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry
            .connect(thirdParty)
            .beginDeactivation(provider1.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
        await expect(
          signerRegistry
            .connect(thirdParty)
            .finalizeDeactivation(provider1.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the operator is not active", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry.connect(deployer).beginDeactivation(provider2.address)
        ).to.be.revertedWith("NotActiveOperator")
        await expect(
          signerRegistry
            .connect(deployer)
            .finalizeDeactivation(provider2.address)
        ).to.be.revertedWith("NotActiveOperator")
      })
    })

    context("when no deactivation was begun", () => {
      it("should revert finalization", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .finalizeDeactivation(provider1.address)
        ).to.be.revertedWith("NoPendingDeactivation")
      })
    })

    context("when a deactivation was begun", () => {
      let beginTx: ContractTransaction

      before(async () => {
        await createSnapshot()
        beginTx = await signerRegistry
          .connect(deployer)
          .beginDeactivation(provider1.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit OperatorDeactivationBegan", async () => {
        await expect(beginTx)
          .to.emit(signerRegistry, "OperatorDeactivationBegan")
          .withArgs(provider1.address)
      })

      it("should keep the operator active until finalization", async () => {
        expect(await signerRegistry.isActive(provider1.address)).to.be.true
      })

      context("before the governance delay elapsed", () => {
        it("should revert finalization", async () => {
          await increaseTime(GOVERNANCE_DELAY - 60)
          await expect(
            signerRegistry
              .connect(deployer)
              .finalizeDeactivation(provider1.address)
          ).to.be.revertedWith("Governance delay has not elapsed")
        })
      })

      context("after the governance delay elapsed", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          await signerRegistry
            .connect(deployer)
            .setSeatAllocator(seatAllocator.address)
          seatAllocator.refreshAuthorization.reset()
          await increaseTime(GOVERNANCE_DELAY)
          tx = await signerRegistry
            .connect(deployer)
            .finalizeDeactivation(provider1.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should mark the operator Deactivating and inactive", async () => {
          expect(
            await signerRegistry.operatorStatus(provider1.address)
          ).to.equal(OperatorStatus.Deactivating)
          expect(await signerRegistry.isActive(provider1.address)).to.be.false
        })

        it("should emit OperatorDeactivated", async () => {
          await expect(tx)
            .to.emit(signerRegistry, "OperatorDeactivated")
            .withArgs(provider1.address)
        })

        it("should refresh the operator's authorization", async () => {
          expect(
            seatAllocator.refreshAuthorization
          ).to.have.been.calledOnceWith(provider1.address)
        })

        it("should not allow beginning deactivation again", async () => {
          await expect(
            signerRegistry
              .connect(deployer)
              .beginDeactivation(provider1.address)
          ).to.be.revertedWith("NotActiveOperator")
        })
      })
    })
  })

  describe("ejectOperator", () => {
    before(async () => {
      await createSnapshot()
      await addActiveOperator(
        provider1.address,
        nodeOperator1.address,
        beneficiary1.address,
        1000
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry.connect(thirdParty).ejectOperator(provider1.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the operator is unknown", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry.connect(deployer).ejectOperator(provider2.address)
        ).to.be.revertedWith("OperatorNotEjectable")
      })
    })

    context("when the addition is still pending", () => {
      before(async () => {
        await createSnapshot()
        await signerRegistry
          .connect(deployer)
          .beginOperatorAddition(
            provider2.address,
            nodeOperator2.address,
            beneficiary2.address,
            1000
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          signerRegistry.connect(deployer).ejectOperator(provider2.address)
        ).to.be.revertedWith("OperatorNotEjectable")
      })
    })

    context("when the operator is active", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        await signerRegistry
          .connect(deployer)
          .setSeatAllocator(seatAllocator.address)
        seatAllocator.refreshAuthorization.reset()
        tx = await signerRegistry
          .connect(deployer)
          .ejectOperator(provider1.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should eject instantly, with no governance delay", async () => {
        expect(await signerRegistry.operatorStatus(provider1.address)).to.equal(
          OperatorStatus.Ejected
        )
        expect(await signerRegistry.isActive(provider1.address)).to.be.false
      })

      it("should emit OperatorEjected", async () => {
        await expect(tx)
          .to.emit(signerRegistry, "OperatorEjected")
          .withArgs(provider1.address)
      })

      it("should refresh the operator's authorization", async () => {
        expect(seatAllocator.refreshAuthorization).to.have.been.calledOnceWith(
          provider1.address
        )
      })

      it("should not allow ejecting again", async () => {
        await expect(
          signerRegistry.connect(deployer).ejectOperator(provider1.address)
        ).to.be.revertedWith("OperatorNotEjectable")
      })

      it("should not allow re-adding the ejected provider", async () => {
        await expect(
          signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider1.address,
              nodeOperator2.address,
              beneficiary1.address,
              1000
            )
        ).to.be.revertedWith("OperatorAlreadyExists")
      })

      it("should keep the node operator address claimed", async () => {
        expect(
          await signerRegistry.stakingProviderOf(nodeOperator1.address)
        ).to.equal(provider1.address)
        await expect(
          signerRegistry
            .connect(deployer)
            .beginOperatorAddition(
              provider2.address,
              nodeOperator1.address,
              beneficiary2.address,
              1000
            )
        ).to.be.revertedWith("NodeOperatorAlreadyUsed")
      })
    })

    context("when the operator is deactivating", () => {
      before(async () => {
        await createSnapshot()
        await signerRegistry
          .connect(deployer)
          .beginDeactivation(provider1.address)
        await increaseTime(GOVERNANCE_DELAY)
        await signerRegistry
          .connect(deployer)
          .finalizeDeactivation(provider1.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should eject", async () => {
        await signerRegistry.connect(deployer).ejectOperator(provider1.address)
        expect(await signerRegistry.operatorStatus(provider1.address)).to.equal(
          OperatorStatus.Ejected
        )
      })
    })
  })

  describe("declareCommission", () => {
    before(async () => {
      await createSnapshot()
      await addActiveOperator(
        provider1.address,
        nodeOperator1.address,
        beneficiary1.address,
        1000
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not an active staking provider", () => {
      it("should revert for an unknown caller", async () => {
        await expect(
          signerRegistry.connect(thirdParty).declareCommission(1000)
        ).to.be.revertedWith("NotActiveOperator")
      })

      it("should revert for a deactivating provider", async () => {
        await createSnapshot()
        await signerRegistry
          .connect(deployer)
          .beginDeactivation(provider1.address)
        await increaseTime(GOVERNANCE_DELAY)
        await signerRegistry
          .connect(deployer)
          .finalizeDeactivation(provider1.address)

        await expect(
          signerRegistry.connect(provider1).declareCommission(1100)
        ).to.be.revertedWith("NotActiveOperator")
        await restoreSnapshot()
      })
    })

    context("when the commission exceeds the maximum", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry
            .connect(provider1)
            .declareCommission(MAX_COMMISSION_BPS + 1)
        ).to.be.revertedWith("CommissionExceedsMax")
      })
    })

    context("when the increase exceeds the maximum step", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry
            .connect(provider1)
            .declareCommission(1000 + MAX_COMMISSION_STEP_BPS + 1)
        ).to.be.revertedWith("CommissionStepTooBig")
      })
    })

    context("when increasing by exactly the maximum step", () => {
      let tx: ContractTransaction
      let effectiveAt: number

      before(async () => {
        await createSnapshot()
        tx = await signerRegistry
          .connect(provider1)
          .declareCommission(1000 + MAX_COMMISSION_STEP_BPS)
        const block = await ethers.provider.getBlock(tx.blockNumber)
        effectiveAt = block.timestamp + COMMISSION_NOTICE_PERIOD
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit CommissionDeclared with the effective time", async () => {
        await expect(tx)
          .to.emit(signerRegistry, "CommissionDeclared")
          .withArgs(provider1.address, 1500, effectiveAt)
      })

      it("should keep the old commission during the notice period", async () => {
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(1000)
        await increaseTime(COMMISSION_NOTICE_PERIOD - 60)
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(1000)
      })

      it("should return the new commission after the notice period", async () => {
        await increaseTime(60)
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(1500)
      })

      it("should allow chaining another maximum step from the matured value", async () => {
        // Effective commission is now 1500; the next step is measured
        // against it.
        await expect(
          signerRegistry.connect(provider1).declareCommission(2001)
        ).to.be.revertedWith("CommissionStepTooBig")

        await signerRegistry.connect(provider1).declareCommission(2000)

        // The matured 1500 stays effective during the new notice period;
        // declaring must not have lost it.
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(1500)
        await increaseTime(COMMISSION_NOTICE_PERIOD)
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(2000)
      })
    })

    context("when decreasing the commission", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not be limited by the maximum step", async () => {
        await signerRegistry.connect(provider1).declareCommission(0)
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(1000)
        await increaseTime(COMMISSION_NOTICE_PERIOD)
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(0)
      })
    })

    context("when re-declaring before the notice period matured", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should overwrite the pending value and restart the notice", async () => {
        await signerRegistry.connect(provider1).declareCommission(1500)
        await increaseTime(COMMISSION_NOTICE_PERIOD - 3600)

        // Still within the first notice; overwrite with a different value.
        // The step is measured against the effective commission (1000).
        await expect(
          signerRegistry.connect(provider1).declareCommission(1501)
        ).to.be.revertedWith("CommissionStepTooBig")
        await signerRegistry.connect(provider1).declareCommission(1400)

        // The first declaration never becomes effective, even after its
        // original effective time passes.
        await increaseTime(3600)
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(1000)

        await increaseTime(COMMISSION_NOTICE_PERIOD)
        expect(
          await signerRegistry.commissionBpsOf(provider1.address)
        ).to.equal(1400)
      })
    })

    context("when the seat allocator is wired", () => {
      before(async () => {
        await createSnapshot()
        await signerRegistry
          .connect(deployer)
          .setSeatAllocator(seatAllocator.address)
        seatAllocator.checkpointRewards.reset()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should checkpoint rewards before replacing the schedule", async () => {
        await signerRegistry.connect(provider1).declareCommission(1500)
        expect(seatAllocator.checkpointRewards).to.have.been.calledOnceWith(
          provider1.address
        )
      })
    })
  })

  describe("setSeatAllocator", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry
            .connect(thirdParty)
            .setSeatAllocator(seatAllocator.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called with the zero address", () => {
      it("should revert", async () => {
        await expect(
          signerRegistry.connect(deployer).setSeatAllocator(ZERO_ADDRESS)
        ).to.be.revertedWith("ZeroAddress")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await signerRegistry
          .connect(deployer)
          .setSeatAllocator(seatAllocator.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the seat allocator", async () => {
        expect(await signerRegistry.seatAllocator()).to.equal(
          seatAllocator.address
        )
      })

      it("should emit SeatAllocatorSet", async () => {
        await expect(tx)
          .to.emit(signerRegistry, "SeatAllocatorSet")
          .withArgs(seatAllocator.address)
      })

      it("should not allow setting it again", async () => {
        await expect(
          signerRegistry.connect(deployer).setSeatAllocator(thirdParty.address)
        ).to.be.revertedWith("SeatAllocatorAlreadySet")
      })
    })
  })
})
