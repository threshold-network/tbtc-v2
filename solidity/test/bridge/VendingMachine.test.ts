import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import type { BigNumber, Signer } from "ethers"
import { constants } from "../fixtures"
import type { TestERC20, TBTC, VendingMachine } from "../../typechain"

import {
  to1e18,
  to1ePrecision,
  getBlockTime,
} from "../helpers/contract-test-helpers"
import bridgeFixture from "../fixtures/bridge"
import { loadFixture } from "../helpers/fixture"

const ZERO_ADDRESS = ethers.constants.AddressZero

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("VendingMachine", () => {
  let tbtcV1: TestERC20
  let tbtcV2: TBTC
  let vendingMachine: VendingMachine

  let deployer: Signer
  let keepCommunityMultiSig: Signer
  let unmintFeeUpdateInitiator: Signer
  let vendingMachineUpgradeInitiator: Signer
  let tokenHolder: Signer
  let thirdParty: Signer

  const initialBalance = to1e18(5) // 5 TBTC v1

  before(async () => {
    let keepTechnicalWalletTeam: Signer
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, keepCommunityMultiSig, keepTechnicalWalletTeam } =
      await helpers.signers.getNamedSigners())

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[
      unmintFeeUpdateInitiator,
      vendingMachineUpgradeInitiator,
      tokenHolder,
      thirdParty,
    ] = await helpers.signers.getUnnamedSigners()

    await loadFixture(bridgeFixture)
    tbtcV1 = await helpers.contracts.getContract("TBTCToken")
    tbtcV2 = await helpers.contracts.getContract("TBTC")
    vendingMachine = await helpers.contracts.getContract("VendingMachine")

    // TBTC token ownership transfer is not performed in deployment scripts.
    // Check TransferTBTCOwnership deployment step for more information.
    await tbtcV2.connect(deployer).transferOwnership(vendingMachine.address)

    await tbtcV1
      .connect(deployer)
      .mint(await tokenHolder.getAddress(), initialBalance)

    await vendingMachine
      .connect(keepTechnicalWalletTeam)
      .transferUnmintFeeUpdateInitiatorRole(
        await unmintFeeUpdateInitiator.getAddress()
      )
    await vendingMachine
      .connect(keepTechnicalWalletTeam)
      .transferVendingMachineUpgradeInitiatorRole(
        await vendingMachineUpgradeInitiator.getAddress()
      )

    await tbtcV1
      .connect(tokenHolder)
      .approve(vendingMachine.address, initialBalance)

    await vendingMachine
      .connect(unmintFeeUpdateInitiator)
      .initiateUnmintFeeUpdate(constants.unmintFee)
    await helpers.time.increaseTime(604800) // +7 days contract governance delay
    await vendingMachine
      .connect(keepCommunityMultiSig)
      .finalizeUnmintFeeUpdate()
  })

  describe("mint", () => {
    context("when TBTC v1 owner has not enough tokens", () => {
      it("should revert", async () => {
        const amount = initialBalance.add(1)
        await tbtcV1
          .connect(tokenHolder)
          .approve(vendingMachine.address, amount)
        await expect(
          vendingMachine.connect(tokenHolder).mint(amount)
        ).to.be.revertedWith("Transfer amount exceeds balance")
      })
    })

    context("when TBTC v1 owner has enough tokens", () => {
      let tx

      context("when minting entire allowance", () => {
        const amount = initialBalance

        before(async () => {
          await createSnapshot()

          tx = await vendingMachine.connect(tokenHolder).mint(amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should mint the same amount of TBTC v2", async () => {
          expect(
            await tbtcV2.balanceOf(await tokenHolder.getAddress())
          ).is.equal(amount)
        })

        it("should transfer TBTC v1 tokens to the VendingMachine", async () => {
          expect(await tbtcV1.balanceOf(vendingMachine.address)).is.equal(
            amount
          )
        })

        it("should emit Minted event", async () => {
          await expect(tx)
            .to.emit(vendingMachine, "Minted")
            .withArgs(await tokenHolder.getAddress(), amount)
        })
      })

      context("when minting part of the allowance", () => {
        const amount = initialBalance.sub(to1e18(1))

        before(async () => {
          await createSnapshot()

          tx = await vendingMachine.connect(tokenHolder).mint(amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should mint the same amount of TBTC v2", async () => {
          expect(
            await tbtcV2.balanceOf(await tokenHolder.getAddress())
          ).is.equal(amount)
        })

        it("should transfer TBTC v1 tokens to the VendingMachine", async () => {
          expect(await tbtcV1.balanceOf(vendingMachine.address)).is.equal(
            amount
          )
        })

        it("should emit Minted event", async () => {
          await expect(tx)
            .to.emit(vendingMachine, "Minted")
            .withArgs(await tokenHolder.getAddress(), amount)
        })
      })
    })
  })

  describe("receiveApproval", () => {
    context("when called directly", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(tokenHolder)
            .receiveApproval(
              await tokenHolder.getAddress(),
              initialBalance,
              tbtcV1.address,
              []
            )
        ).to.be.revertedWith("Only TBTC v1 caller allowed")
      })
    })

    context("when called not for TBTC v1 token", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(tokenHolder)
            .receiveApproval(
              await tokenHolder.getAddress(),
              initialBalance,
              tbtcV2.address,
              []
            )
        ).to.be.revertedWith("Token is not TBTC v1")
      })
    })

    context("when called via approveAndCall", () => {
      const amount = to1e18(2)
      let tx

      before(async () => {
        await createSnapshot()

        tx = await tbtcV1
          .connect(tokenHolder)
          .approveAndCall(vendingMachine.address, amount, [])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should mint TBTC v2 to the caller", async () => {
        expect(await tbtcV2.balanceOf(await tokenHolder.getAddress())).is.equal(
          amount
        )
      })

      it("should transfer TBTC v1 tokens to the VendingMachine", async () => {
        expect(await tbtcV1.balanceOf(vendingMachine.address)).is.equal(amount)
      })

      it("should emit Minted event", async () => {
        await expect(tx)
          .to.emit(vendingMachine, "Minted")
          .withArgs(await tokenHolder.getAddress(), amount)
      })
    })
  })

  describe("unmint", () => {
    before(async () => {
      await createSnapshot()

      await vendingMachine.connect(tokenHolder).mint(initialBalance)
      await tbtcV2
        .connect(tokenHolder)
        .approve(vendingMachine.address, initialBalance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when unmint fee is zero", () => {
      before(async () => {
        await createSnapshot()

        await vendingMachine
          .connect(unmintFeeUpdateInitiator)
          .initiateUnmintFeeUpdate(0)
        await helpers.time.increaseTime(604800) // +7 days contract governance delay
        await vendingMachine
          .connect(keepCommunityMultiSig)
          .finalizeUnmintFeeUpdate()
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when TBTC v2 owner has not enough tokens", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine.connect(tokenHolder).unmint(initialBalance.add(1))
          ).to.be.revertedWith("Amount + fee exceeds TBTC v2 balance")
        })
      })

      context("when TBTC v2 owner has enough tokens", () => {
        context("when unminting entire TBTC v2 balance", () => {
          const unmintAmount = initialBalance
          let v1StartBalance
          let v2StartBalance
          let tx

          before(async () => {
            await createSnapshot()

            v1StartBalance = await tbtcV1.balanceOf(
              await tokenHolder.getAddress()
            )
            v2StartBalance = await tbtcV2.balanceOf(
              await tokenHolder.getAddress()
            )
            tx = await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should transfer no TBTC v2 to the VendingMachine", async () => {
            expect(await tbtcV2.balanceOf(vendingMachine.address)).to.equal(0)
          })

          it("should burn unminted TBTC v2 tokens", async () => {
            expect(
              await tbtcV2.balanceOf(await tokenHolder.getAddress())
            ).to.equal(v2StartBalance.sub(unmintAmount))
            expect(await tbtcV2.totalSupply()).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
          })

          it("should transfer unminted TBTC v1 tokens back to the owner", async () => {
            expect(
              await tbtcV1.balanceOf(await tokenHolder.getAddress())
            ).to.equal(v1StartBalance.add(unmintAmount))
          })

          it("should emit the Unminted event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "Unminted")
              .withArgs(await tokenHolder.getAddress(), unmintAmount, 0)
          })
        })

        context("when unminting part of TBTC v2 balance", () => {
          const unmintAmount = to1e18(1)
          let v1StartBalance
          let v2StartBalance
          let tx

          before(async () => {
            await createSnapshot()

            v1StartBalance = await tbtcV1.balanceOf(
              await tokenHolder.getAddress()
            )
            v2StartBalance = await tbtcV2.balanceOf(
              await tokenHolder.getAddress()
            )
            tx = await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should transfer no TBTC v2 to the VendingMachine", async () => {
            expect(await tbtcV2.balanceOf(vendingMachine.address)).to.equal(0)
          })

          it("should burn unminted TBTC v2 tokens", async () => {
            expect(
              await tbtcV2.balanceOf(await tokenHolder.getAddress())
            ).to.equal(v2StartBalance.sub(unmintAmount))
            expect(await tbtcV2.totalSupply()).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
          })

          it("should transfer unminted TBTC v1 tokens back to the owner", async () => {
            expect(
              await tbtcV1.balanceOf(await tokenHolder.getAddress())
            ).to.equal(v1StartBalance.add(unmintAmount))
          })

          it("should emit the Unminted event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "Unminted")
              .withArgs(await tokenHolder.getAddress(), unmintAmount, 0)
          })
        })
      })
    })

    context("when unmint fee is non-zero", () => {
      context("when TBTC v2 owner has not enough tokens", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine.connect(tokenHolder).unmint(initialBalance.add(1))
          ).to.be.revertedWith("Amount + fee exceeds TBTC v2 balance")
        })
      })

      context("when TBTC v2 owner has enough tokens", () => {
        context("when unminting entire TBTC v2 balance", () => {
          // 1e18 * balance / (1e18 + unmintFee)
          const unmintAmount = initialBalance
            .mul(to1e18(1))
            .div(to1e18(1).add(constants.unmintFee))

          let fee
          let v1StartBalance
          let v2StartBalance
          let tx

          before(async () => {
            await createSnapshot()

            v1StartBalance = await tbtcV1.balanceOf(
              await tokenHolder.getAddress()
            )
            v2StartBalance = await tbtcV2.balanceOf(
              await tokenHolder.getAddress()
            )
            fee = await vendingMachine.unmintFeeFor(unmintAmount)
            tx = await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should transfer TBTC v2 fee to the VendingMachine", async () => {
            expect(await tbtcV2.balanceOf(vendingMachine.address)).to.equal(fee)
          })

          it("should burn unminted TBTC v2 tokens", async () => {
            expect(
              await tbtcV2.balanceOf(await tokenHolder.getAddress())
            ).to.equal(v2StartBalance.sub(unmintAmount).sub(fee))
            expect(await tbtcV2.totalSupply()).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
          })

          it("should transfer unminted TBTC v1 tokens back to the owner", async () => {
            expect(
              await tbtcV1.balanceOf(await tokenHolder.getAddress())
            ).to.equal(v1StartBalance.add(unmintAmount))
          })

          it("should emit the Unminted event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "Unminted")
              .withArgs(await tokenHolder.getAddress(), unmintAmount, fee)
          })
        })

        context("when unminting part of TBTC v2 balance", () => {
          const unmintAmount = to1e18(1)

          let fee
          let v1StartBalance
          let v2StartBalance
          let tx

          before(async () => {
            await createSnapshot()

            v1StartBalance = await tbtcV1.balanceOf(
              await tokenHolder.getAddress()
            )
            v2StartBalance = await tbtcV2.balanceOf(
              await tokenHolder.getAddress()
            )
            fee = await vendingMachine.unmintFeeFor(unmintAmount)
            tx = await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should transfer TBTC v2 fee to the VendingMachine", async () => {
            expect(await tbtcV2.balanceOf(vendingMachine.address)).to.equal(fee)
          })

          it("should burn unminted TBTC v2 tokens", async () => {
            expect(
              await tbtcV2.balanceOf(await tokenHolder.getAddress())
            ).to.equal(v2StartBalance.sub(unmintAmount).sub(fee))
            expect(await tbtcV2.totalSupply()).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
          })

          it("should transfer unminted TBTC v1 tokens back to the owner", async () => {
            expect(
              await tbtcV1.balanceOf(await tokenHolder.getAddress())
            ).to.equal(v1StartBalance.add(unmintAmount))
          })

          it("should emit the Unminted event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "Unminted")
              .withArgs(await tokenHolder.getAddress(), unmintAmount, fee)
          })
        })
      })
    })
  })

  describe("withdrawFees", () => {
    const unmintAmount = to1e18(4)
    let unmintFee: BigNumber

    before(async () => {
      await createSnapshot()

      await vendingMachine.connect(tokenHolder).mint(initialBalance)
      await tbtcV2
        .connect(tokenHolder)
        .approve(vendingMachine.address, initialBalance)
      unmintFee = await vendingMachine.unmintFeeFor(unmintAmount)
      await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(thirdParty)
            .withdrawFees(await thirdParty.getAddress(), unmintFee)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the owner", () => {
      let withdrawnFee: BigNumber

      before(async () => {
        await createSnapshot()

        withdrawnFee = unmintFee.sub(1)

        await vendingMachine
          .connect(keepCommunityMultiSig)
          .withdrawFees(await thirdParty.getAddress(), withdrawnFee)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should withdraw the provided amount of fees", async () => {
        expect(await tbtcV2.balanceOf(await thirdParty.getAddress())).is.equal(
          withdrawnFee
        )
      })

      it("should leave the rest of fees in VendingMachine", async () => {
        expect(await tbtcV2.balanceOf(vendingMachine.address)).is.equal(
          unmintFee.sub(withdrawnFee)
        )
      })
    })
  })

  describe("initiateUnmintFeeUpdate", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine.connect(thirdParty).initiateUnmintFeeUpdate(1)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the contract owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(keepCommunityMultiSig)
            .initiateUnmintFeeUpdate(1)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the update initiator", () => {
      const newUnmintFee = 191111

      let tx

      before(async () => {
        await createSnapshot()

        tx = await vendingMachine
          .connect(unmintFeeUpdateInitiator)
          .initiateUnmintFeeUpdate(newUnmintFee)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not update the unmint fee", async () => {
        expect(await vendingMachine.unmintFee()).to.equal(constants.unmintFee)
      })

      it("should start the update initiation time", async () => {
        expect(
          await vendingMachine.unmintFeeUpdateInitiatedTimestamp()
        ).to.equal(await getBlockTime(tx.blockNumber))
      })

      it("should set the pending new unmint fee", async () => {
        expect(await vendingMachine.newUnmintFee()).to.equal(newUnmintFee)
      })

      it("should start the governance delay timer", async () => {
        expect(await vendingMachine.getRemainingUnmintFeeUpdateTime()).to.equal(
          604800 // 7 days contract governance delay
        )
      })

      it("should emit UnmintFeeUpdateInitiated event", async () => {
        await expect(tx)
          .to.emit(vendingMachine, "UnmintFeeUpdateInitiated")
          .withArgs(newUnmintFee, await getBlockTime(tx.blockNumber))
      })
    })
  })

  describe("finalizeUnmintFeeUpdate", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine.connect(thirdParty).finalizeUnmintFeeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the update initiator", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(unmintFeeUpdateInitiator)
            .finalizeUnmintFeeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the owner", () => {
      context("when update process is not initialized", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine
              .connect(keepCommunityMultiSig)
              .finalizeUnmintFeeUpdate()
          ).to.be.revertedWith("Change not initiated")
        })
      })

      context("when update process is initialized", () => {
        const newUnmintFee = 151511

        before(async () => {
          await createSnapshot()

          await vendingMachine
            .connect(unmintFeeUpdateInitiator)
            .initiateUnmintFeeUpdate(newUnmintFee)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when governance delay has not passed", () => {
          it("should revert", async () => {
            await helpers.time.increaseTime(601200) // +7 days 23 hours
            await expect(
              vendingMachine
                .connect(keepCommunityMultiSig)
                .finalizeUnmintFeeUpdate()
            ).to.be.revertedWith("Governance delay has not elapsed")
          })
        })

        context("when governance delay passed", () => {
          let tx

          before(async () => {
            await createSnapshot()

            await helpers.time.increaseTime(604800) // +7 days contract governance delay
            tx = await vendingMachine
              .connect(keepCommunityMultiSig)
              .finalizeUnmintFeeUpdate()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the unmint fee", async () => {
            expect(await vendingMachine.unmintFee()).to.equal(newUnmintFee)
          })

          it("should emit UnmintFeeUpdated event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "UnmintFeeUpdated")
              .withArgs(newUnmintFee)
          })

          it("should reset the governance delay timer", async () => {
            await expect(
              vendingMachine.getRemainingUnmintFeeUpdateTime()
            ).to.be.revertedWith("Change not initiated")
          })

          it("should reset the pending new unmint fee", async () => {
            expect(await vendingMachine.newUnmintFee()).to.equal(0)
          })

          it("should reset the unmint fee update initiated timestamp", async () => {
            expect(
              await vendingMachine.unmintFeeUpdateInitiatedTimestamp()
            ).to.equal(0)
          })
        })
      })
    })
  })

  describe("initiateVendingMachineUpgrade", () => {
    let newVendingMachine

    before(async () => {
      await createSnapshot()

      const VendingMachine = await ethers.getContractFactory("VendingMachine")
      newVendingMachine = await VendingMachine.deploy(
        tbtcV1.address,
        tbtcV2.address,
        constants.unmintFee
      )
      await newVendingMachine.deployed()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(thirdParty)
            .initiateVendingMachineUpgrade(newVendingMachine.address)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the contract owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(keepCommunityMultiSig)
            .initiateVendingMachineUpgrade(newVendingMachine.address)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the upgrade initiator", () => {
      context("when new vending machine address is zero", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine
              .connect(vendingMachineUpgradeInitiator)
              .initiateVendingMachineUpgrade(ZERO_ADDRESS)
          ).to.be.revertedWith("New VendingMachine cannot be zero address")
        })
      })

      context("when new vending machine address is non-zero", () => {
        let tx

        before(async () => {
          await createSnapshot()

          tx = await vendingMachine
            .connect(vendingMachineUpgradeInitiator)
            .initiateVendingMachineUpgrade(newVendingMachine.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should not transfer token ownership", async () => {
          expect(await tbtcV2.owner()).is.equal(vendingMachine.address)
        })

        it("should start the upgrade initiation time", async () => {
          expect(
            await vendingMachine.vendingMachineUpgradeInitiatedTimestamp()
          ).to.equal(await getBlockTime(tx.blockNumber))
        })

        it("should set the pending new vending machine address", async () => {
          expect(await vendingMachine.newVendingMachine()).to.equal(
            newVendingMachine.address
          )
        })

        it("should start the governance delay timer", async () => {
          expect(
            await vendingMachine.getRemainingVendingMachineUpgradeTime()
          ).to.equal(
            604800 // 7 days contract governance delay
          )
        })

        it("should emit VendingMachineUpgradeInitiated event", async () => {
          await expect(tx)
            .to.emit(vendingMachine, "VendingMachineUpgradeInitiated")
            .withArgs(
              newVendingMachine.address,
              await getBlockTime(tx.blockNumber)
            )
        })
      })
    })
  })

  describe("finalizeVendingMachineUpgrade", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine.connect(thirdParty).finalizeVendingMachineUpgrade()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the upgrade initiator", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(vendingMachineUpgradeInitiator)
            .finalizeVendingMachineUpgrade()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the owner", () => {
      context("when upgrade process is not initialized", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine
              .connect(keepCommunityMultiSig)
              .finalizeVendingMachineUpgrade()
          ).to.be.revertedWith("Change not initiated")
        })
      })

      context("when upgrade process is initialized", () => {
        const tbtcV1Amount = to1e18(3)
        let newVendingMachine

        before(async () => {
          await createSnapshot()

          const VendingMachine = await ethers.getContractFactory(
            "VendingMachine"
          )
          newVendingMachine = await VendingMachine.deploy(
            tbtcV1.address,
            tbtcV2.address,
            constants.unmintFee
          )
          await newVendingMachine.deployed()

          await tbtcV1
            .connect(tokenHolder)
            .approve(vendingMachine.address, tbtcV1Amount)
          await vendingMachine.connect(tokenHolder).mint(tbtcV1Amount)

          await vendingMachine
            .connect(vendingMachineUpgradeInitiator)
            .initiateVendingMachineUpgrade(newVendingMachine.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when governance delay has not passed", () => {
          it("should revert", async () => {
            await helpers.time.increaseTime(601200) // +7days 23 hours
            await expect(
              vendingMachine
                .connect(keepCommunityMultiSig)
                .finalizeVendingMachineUpgrade()
            ).to.be.revertedWith("Governance delay has not elapsed")
          })
        })

        context("when governance delay passed", () => {
          let tx

          before(async () => {
            await createSnapshot()

            await helpers.time.increaseTime(604800) // +7 days contract governance delay
            tx = await vendingMachine
              .connect(keepCommunityMultiSig)
              .finalizeVendingMachineUpgrade()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should transfer token ownership to the new VendingMachine", async () => {
            expect(await tbtcV2.owner()).to.equal(newVendingMachine.address)
          })

          it("should transfer all TBTC v1 to the new VendingMachine", async () => {
            expect(await tbtcV1.balanceOf(newVendingMachine.address)).to.equal(
              tbtcV1Amount
            )
          })

          it("should emit VendingMachineUpgraded event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "VendingMachineUpgraded")
              .withArgs(newVendingMachine.address)
          })

          it("should reset the governance delay timer", async () => {
            await expect(
              vendingMachine.getRemainingVendingMachineUpgradeTime()
            ).to.be.revertedWith("Change not initiated")
          })

          it("should reset the pending new vending machine address", async () => {
            expect(await vendingMachine.newVendingMachine()).to.equal(
              ZERO_ADDRESS
            )
          })

          it("should reset the vending machine update initiated timestamp", async () => {
            expect(
              await vendingMachine.vendingMachineUpgradeInitiatedTimestamp()
            ).to.equal(0)
          })
        })
      })
    })
  })

  describe("transferUnmintFeeUpdateInitiatorRole", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when caller is the owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(keepCommunityMultiSig)
            .transferUnmintFeeUpdateInitiatorRole(await thirdParty.getAddress())
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(thirdParty)
            .transferUnmintFeeUpdateInitiatorRole(await thirdParty.getAddress())
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the update initiator", () => {
      context("when new initiator is a valid address", () => {
        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer the role", async () => {
          await vendingMachine
            .connect(unmintFeeUpdateInitiator)
            .transferUnmintFeeUpdateInitiatorRole(await thirdParty.getAddress())
          expect(await vendingMachine.unmintFeeUpdateInitiator()).to.equal(
            await thirdParty.getAddress()
          )
        })
      })

      context("when new initiator is zero address", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine
              .connect(unmintFeeUpdateInitiator)
              .transferUnmintFeeUpdateInitiatorRole(ZERO_ADDRESS)
          ).to.be.revertedWith("New initiator must not be zero address")
        })
      })
    })
  })

  describe("transferVendingMachineUpgradeInitiatorRole", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when caller is the owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(keepCommunityMultiSig)
            .transferVendingMachineUpgradeInitiatorRole(
              await thirdParty.getAddress()
            )
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(thirdParty)
            .transferVendingMachineUpgradeInitiatorRole(
              await thirdParty.getAddress()
            )
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the update initiator", () => {
      context("when new initiator is a valid address", () => {
        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer the role", async () => {
          await vendingMachine
            .connect(vendingMachineUpgradeInitiator)
            .transferVendingMachineUpgradeInitiatorRole(
              await thirdParty.getAddress()
            )
          expect(
            await vendingMachine.vendingMachineUpgradeInitiator()
          ).to.equal(await thirdParty.getAddress())
        })
      })

      context("when new initiator is zero address", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine
              .connect(vendingMachineUpgradeInitiator)
              .transferVendingMachineUpgradeInitiatorRole(ZERO_ADDRESS)
          ).to.be.revertedWith("New initiator must not be zero address")
        })
      })
    })
  })

  describe("unmintFeeFor", () => {
    const unmintAmount = to1e18(2)

    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when unmint fee is non-zero", async () => {
      it("should return a correct portion of the amount to unmint", async () => {
        // 0.001 * 2 = 0.002
        await expect(await vendingMachine.unmintFeeFor(unmintAmount)).to.equal(
          to1ePrecision(2, 15)
        )
      })
    })

    context("when unmint fee is zero", async () => {
      before(async () => {
        await createSnapshot()

        await vendingMachine
          .connect(unmintFeeUpdateInitiator)
          .initiateUnmintFeeUpdate(0)
        await helpers.time.increaseTime(604800) // +7 days contract governance delay
        await vendingMachine
          .connect(keepCommunityMultiSig)
          .finalizeUnmintFeeUpdate()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return zero", async () => {
        // 0.001 * 0 = 0
        await expect(await vendingMachine.unmintFeeFor(unmintAmount)).to.equal(
          0
        )
      })
    })
  })
})
