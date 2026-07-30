import { ethers, helpers, getUnnamedAccounts } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ContractTransaction } from "ethers"
import bridgeFixture from "../fixtures/bridge"

import type { TestERC20, TBTC, VendingMachineV3 } from "../../typechain"
import { loadFixture } from "../helpers/fixture"

const { to1e18 } = helpers.number
const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("VendingMachineV3", () => {
  let tbtcV1: TestERC20
  let tbtcV2: TBTC
  let vendingMachineV3: VendingMachineV3

  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let treasuryGuild: SignerWithAddress
  let exchanger: SignerWithAddress
  let thirdParty: SignerWithAddress

  // 50 tBTC v2 deposited into the VendingMachineV3
  const initialV2Balance = to1e18(50)
  // 50 tBTC v1 owned by the exchanger
  const initialV1Balance = to1e18(51)

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer } = await loadFixture(bridgeFixture))
    tbtcV1 = await helpers.contracts.getContract("TBTCToken")
    tbtcV2 = await helpers.contracts.getContract("TBTC")
    vendingMachineV3 = await helpers.contracts.getContract("VendingMachineV3")

    const accounts = await getUnnamedAccounts()
    treasuryGuild = await ethers.getSigner(accounts[0])
    exchanger = await ethers.getSigner(accounts[1])
    thirdParty = await ethers.getSigner(accounts[2])
    ;({ governance } = await helpers.signers.getNamedSigners())
  })

  describe("exchange", () => {
    before(async () => {
      await createSnapshot()
      await tbtcV2
        .connect(deployer)
        .mint(vendingMachineV3.address, initialV2Balance)
      await tbtcV1.connect(deployer).mint(exchanger.address, initialV1Balance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when tBTC v1 exchanger has not enough tokens", () => {
      before(async () => {
        await createSnapshot()
        // The main test `before` mints `initialV2Balance`. We mint more for
        // this test so that the VendingMachine has enough tokens to exchange
        // `initialV1Balance.add(1)` (see the test)
        await tbtcV2
          .connect(deployer)
          .mint(vendingMachineV3.address, initialV2Balance) // twice the original
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        const amount = initialV1Balance.add(1)
        await tbtcV1
          .connect(exchanger)
          .approve(vendingMachineV3.address, amount)
        await expect(
          vendingMachineV3.connect(exchanger).exchange(amount)
        ).to.be.revertedWith("Transfer amount exceeds balance")
      })
    })

    context("when not enough tBTC v2 was deposited", () => {
      it("should revert", async () => {
        const amount = initialV2Balance.add(1)
        await tbtcV1
          .connect(exchanger)
          .approve(vendingMachineV3.address, amount)
        await expect(
          vendingMachineV3.connect(exchanger).exchange(amount)
        ).to.be.revertedWith(
          "Not enough tBTC v2 available in the Vending Machine"
        )
      })
    })

    context("when exchanging entire allowance", () => {
      // initialV1Balance > initialV2Balance for the sake of the negative path
      // unit tests; we take v1 balance to not revert the TX with
      // "Not enough tBTC v2 available in the Vending Machine"
      const amount = initialV2Balance
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await tbtcV1
          .connect(exchanger)
          .approve(vendingMachineV3.address, amount)
        tx = await vendingMachineV3.connect(exchanger).exchange(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should exchange the same amount of tBTC v2", async () => {
        expect(await tbtcV2.balanceOf(exchanger.address)).is.equal(amount)
      })

      it("should transfer tBTC v1 tokens to the VendingMachineV3", async () => {
        expect(await tbtcV1.balanceOf(vendingMachineV3.address)).is.equal(
          amount
        )
      })

      it("should emit Exchanged event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV3, "Exchanged")
          .withArgs(exchanger.address, amount)
      })
    })

    context("when exchanging part of the allowance", () => {
      // initialV1Balance > initialV2Balance for the sake of the negative path
      // unit tests; we take v1 balance to not revert the TX with
      // "Not enough tBTC v2 available in the Vending Machine"
      const amount = initialV2Balance.sub(to1e18(1))
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await tbtcV1
          .connect(exchanger)
          .approve(vendingMachineV3.address, amount.add(to1e18(1)))
        tx = await vendingMachineV3.connect(exchanger).exchange(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should exchange the same amount of tBTC v2", async () => {
        expect(await tbtcV2.balanceOf(exchanger.address)).is.equal(amount)
      })

      it("should transfer tBTC v1 tokens to the VendingMachineV3", async () => {
        expect(await tbtcV1.balanceOf(vendingMachineV3.address)).is.equal(
          amount
        )
      })

      it("should emit Exchanged event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV3, "Exchanged")
          .withArgs(exchanger.address, amount)
      })
    })
  })

  describe("receiveApproval", () => {
    before(async () => {
      await createSnapshot()
      await tbtcV2
        .connect(deployer)
        .mint(vendingMachineV3.address, initialV2Balance)
      await tbtcV1.connect(deployer).mint(exchanger.address, initialV1Balance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called directly", () => {
      it("should revert", async () => {
        await expect(
          vendingMachineV3
            .connect(exchanger)
            .receiveApproval(exchanger.address, to1e18(1), tbtcV1.address, [])
        ).to.be.revertedWith("Only tBTC v1 caller allowed")
      })
    })

    context("when called not for tBTC v1 token", () => {
      it("should revert", async () => {
        await expect(
          vendingMachineV3
            .connect(exchanger)
            .receiveApproval(exchanger.address, to1e18(1), tbtcV2.address, [])
        ).to.be.revertedWith("Token is not tBTC v1")
      })
    })

    context("when called via approveAndCall", () => {
      const amount = to1e18(2)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await tbtcV2.connect(deployer).mint(thirdParty.address, amount)
        tx = await tbtcV1
          .connect(exchanger)
          .approveAndCall(vendingMachineV3.address, amount, [])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should exchange tBTC v2 with the caller", async () => {
        expect(await tbtcV2.balanceOf(exchanger.address)).is.equal(amount)
      })

      it("should transfer tBTC v1 tokens to the VendingMachineV3", async () => {
        expect(await tbtcV1.balanceOf(vendingMachineV3.address)).is.equal(
          amount
        )
      })

      it("should emit Exchanged event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV3, "Exchanged")
          .withArgs(exchanger.address, amount)
      })
    })
  })

  describe("depositTBTCV2", () => {
    context("when depositing entire allowance", () => {
      const amount = to1e18(21)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await tbtcV2.connect(deployer).mint(treasuryGuild.address, amount)
        await tbtcV2
          .connect(treasuryGuild)
          .approve(vendingMachineV3.address, amount)

        tx = await vendingMachineV3.connect(treasuryGuild).depositTbtcV2(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tBTC v2 to the VendingMachineV3", async () => {
        expect(await tbtcV2.balanceOf(vendingMachineV3.address)).is.equal(
          amount
        )
      })

      it("should emit Deposited event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV3, "Deposited")
          .withArgs(treasuryGuild.address, amount)
      })
    })

    context("when depositing part of the allowance", () => {
      const amount = to1e18(21)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await tbtcV2.connect(deployer).mint(treasuryGuild.address, amount)
        await tbtcV2
          .connect(treasuryGuild)
          .approve(vendingMachineV3.address, amount.add(to1e18(1)))

        tx = await vendingMachineV3.connect(treasuryGuild).depositTbtcV2(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tBTC v2 to the VendingMachineV3", async () => {
        expect(await tbtcV2.balanceOf(vendingMachineV3.address)).is.equal(
          amount
        )
      })

      it("should emit Deposited event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV3, "Deposited")
          .withArgs(treasuryGuild.address, amount)
      })
    })
  })

  describe("recoverFunds", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachineV3
            .connect(thirdParty)
            .recoverFunds(tbtcV1.address, thirdParty.address, to1e18(1))
        ).to.be.revertedWith("Ownable: caller is not the owner")
        await expect(
          vendingMachineV3
            .connect(thirdParty)
            .recoverFunds(tbtcV2.address, thirdParty.address, to1e18(1))
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when recovering tBTC v1 tokens", () => {
        const amount = to1e18(10)

        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          await tbtcV1.connect(deployer).mint(vendingMachineV3.address, amount)
          tx = await vendingMachineV3
            .connect(governance)
            .recoverFunds(tbtcV1.address, thirdParty.address, amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer tokens to the recipient", async () => {
          expect(await tbtcV1.balanceOf(thirdParty.address)).is.equal(amount)
        })

        it("should emit FundsRecovered event", async () => {
          await expect(tx)
            .to.emit(vendingMachineV3, "FundsRecovered")
            .withArgs(tbtcV1.address, thirdParty.address, amount)
        })
      })

      context("when recovering tBTC v2 tokens", () => {
        const amount = to1e18(10)

        before(async () => {
          await createSnapshot()
          await tbtcV2.connect(deployer).mint(vendingMachineV3.address, amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            vendingMachineV3
              .connect(governance)
              .recoverFunds(tbtcV2.address, thirdParty.address, amount)
          ).to.be.revertedWith(
            "tBTC v2 tokens can not be recovered, use withdrawTbtcV2 instead"
          )
        })
      })

      context("when recovering other tokens", () => {
        let randomERC20: TestERC20
        const amount = to1e18(10)

        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          const TestERC20 = await ethers.getContractFactory("TestERC20")
          randomERC20 = await TestERC20.deploy()
          await randomERC20.deployed()

          await randomERC20.mint(vendingMachineV3.address, amount)

          tx = await vendingMachineV3
            .connect(governance)
            .recoverFunds(randomERC20.address, thirdParty.address, amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer tokens to the recipient", async () => {
          expect(await randomERC20.balanceOf(thirdParty.address)).is.equal(
            amount
          )
        })

        it("should emit FundsRecovered event", async () => {
          await expect(tx)
            .to.emit(vendingMachineV3, "FundsRecovered")
            .withArgs(randomERC20.address, thirdParty.address, amount)
        })
      })
    })
  })

  describe("withdrawTbtcV2", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachineV3
            .connect(thirdParty)
            .withdrawTbtcV2(thirdParty.address, to1e18(1))
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      const v1Amount = to1e18(10)
      const v2Amount = to1e18(12)

      before(async () => {
        await createSnapshot()
        await tbtcV1.connect(deployer).mint(vendingMachineV3.address, v1Amount)
        await tbtcV2.connect(deployer).mint(vendingMachineV3.address, v2Amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when some tBTC v1 would be unbacked", () => {
        const amount = to1e18(2).add(1)
        it("should revert", async () => {
          await expect(
            vendingMachineV3
              .connect(governance)
              .withdrawTbtcV2(thirdParty.address, amount)
          ).to.be.revertedWith("tBTC v1 must not be left unbacked")
        })
      })

      context("when all tBTC v1 would be still backed", () => {
        const amount = to1e18(2)

        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await vendingMachineV3
            .connect(governance)
            .withdrawTbtcV2(thirdParty.address, amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer tokens to the recipient", async () => {
          expect(await tbtcV2.balanceOf(thirdParty.address)).is.equal(amount)
        })

        it("should emit TbtcV2Withdrawn event", async () => {
          await expect(tx)
            .to.emit(vendingMachineV3, "TbtcV2Withdrawn")
            .withArgs(thirdParty.address, amount)
        })
      })
    })
  })
})
