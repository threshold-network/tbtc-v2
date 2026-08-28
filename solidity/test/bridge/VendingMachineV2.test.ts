import { ethers, waffle, helpers, getUnnamedAccounts } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ContractTransaction } from "ethers"
import bridgeFixture from "../fixtures/bridge"

import type { TestERC20, TBTC, VendingMachineV2 } from "../../typechain"

const { to1e18 } = helpers.number
const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("VendingMachineV2", () => {
  let tbtcV1: TestERC20
  let tbtcV2: TBTC
  let vendingMachineV2: VendingMachineV2

  let deployer: SignerWithAddress
  let v1Redeemer: SignerWithAddress
  let exchanger: SignerWithAddress
  let thirdParty: SignerWithAddress

  // 50 tBTC v2 deposited into the VendingMachineV2
  const initialV2Balance = to1e18(50)
  // 50 tBTC v1 owned by the exchanger
  const initialV1Balance = to1e18(51)

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer } = await bridgeFixture())
    tbtcV1 = await helpers.contracts.getContract("TBTCToken")
    tbtcV2 = await helpers.contracts.getContract("TBTC")
    vendingMachineV2 = await helpers.contracts.getContract("VendingMachineV2")

    const accounts = await getUnnamedAccounts()
    exchanger = await ethers.getSigner(accounts[1])
    thirdParty = await ethers.getSigner(accounts[2])
    ;({ v1Redeemer } = await helpers.signers.getNamedSigners())

    await tbtcV2
      .connect(deployer)
      .mint(vendingMachineV2.address, initialV2Balance)
    await tbtcV1.connect(deployer).mint(exchanger.address, initialV1Balance)
  })

  describe("exchange", () => {
    context("when tBTC v1 exchanger has not enough tokens", () => {
      before(async () => {
        await createSnapshot()
        // The main test `before` mints `initialV2Balance`. We mint more for
        // this test so that the VendingMachine has enough tokens to exchange
        // `initialV1Balance.add(1)` (see the test)
        await tbtcV2
          .connect(deployer)
          .mint(vendingMachineV2.address, initialV2Balance) // twice the original
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        const amount = initialV1Balance.add(1)
        await tbtcV1
          .connect(exchanger)
          .approve(vendingMachineV2.address, amount)
        await expect(
          vendingMachineV2.connect(exchanger).exchange(amount)
        ).to.be.revertedWith("Transfer amount exceeds balance")
      })
    })

    context("when not enough tBTC v2 was deposited", () => {
      it("should revert", async () => {
        const amount = initialV2Balance.add(1)
        await tbtcV1
          .connect(exchanger)
          .approve(vendingMachineV2.address, amount)
        await expect(
          vendingMachineV2.connect(exchanger).exchange(amount)
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
          .approve(vendingMachineV2.address, amount)
        tx = await vendingMachineV2.connect(exchanger).exchange(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should exchange the same amount of tBTC v2", async () => {
        expect(await tbtcV2.balanceOf(exchanger.address)).is.equal(amount)
      })

      it("should transfer tBTC v1 tokens to the VendingMachineV2", async () => {
        expect(await tbtcV1.balanceOf(vendingMachineV2.address)).is.equal(
          amount
        )
      })

      it("should emit Exchanged event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV2, "Exchanged")
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
          .approve(vendingMachineV2.address, amount.add(to1e18(1)))
        tx = await vendingMachineV2.connect(exchanger).exchange(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should exchange the same amount of tBTC v2", async () => {
        expect(await tbtcV2.balanceOf(exchanger.address)).is.equal(amount)
      })

      it("should transfer tBTC v1 tokens to the VendingMachineV2", async () => {
        expect(await tbtcV1.balanceOf(vendingMachineV2.address)).is.equal(
          amount
        )
      })

      it("should emit Exchanged event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV2, "Exchanged")
          .withArgs(exchanger.address, amount)
      })
    })
  })

  describe("receiveApproval", () => {
    context("when called directly", () => {
      it("should revert", async () => {
        await expect(
          vendingMachineV2
            .connect(exchanger)
            .receiveApproval(exchanger.address, to1e18(1), tbtcV1.address, [])
        ).to.be.revertedWith("Only tBTC v1 caller allowed")
      })
    })

    context("when called not for tBTC v1 token", () => {
      it("should revert", async () => {
        await expect(
          vendingMachineV2
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
          .approveAndCall(vendingMachineV2.address, amount, [])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should exchange tBTC v2 with the caller", async () => {
        expect(await tbtcV2.balanceOf(exchanger.address)).is.equal(amount)
      })

      it("should transfer tBTC v1 tokens to the VendingMachineV2", async () => {
        expect(await tbtcV1.balanceOf(vendingMachineV2.address)).is.equal(
          amount
        )
      })

      it("should emit Exchanged event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV2, "Exchanged")
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

        await tbtcV2.connect(deployer).mint(v1Redeemer.address, amount)
        await tbtcV2
          .connect(v1Redeemer)
          .approve(vendingMachineV2.address, amount)

        tx = await vendingMachineV2.connect(v1Redeemer).depositTbtcV2(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tBTC v2 to the VendingMachineV2", async () => {
        expect(await tbtcV2.balanceOf(vendingMachineV2.address)).is.equal(
          initialV2Balance.add(amount)
        )
      })

      it("should emit Deposited event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV2, "Deposited")
          .withArgs(v1Redeemer.address, amount)
      })
    })

    context("when depositing part of the allowance", () => {
      const amount = to1e18(21)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await tbtcV2.connect(deployer).mint(v1Redeemer.address, amount)
        await tbtcV2
          .connect(v1Redeemer)
          .approve(vendingMachineV2.address, amount.add(to1e18(1)))

        tx = await vendingMachineV2.connect(v1Redeemer).depositTbtcV2(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tBTC v2 to the VendingMachineV2", async () => {
        expect(await tbtcV2.balanceOf(vendingMachineV2.address)).is.equal(
          initialV2Balance.add(amount)
        )
      })

      it("should emit Deposited event", async () => {
        await expect(tx)
          .to.emit(vendingMachineV2, "Deposited")
          .withArgs(v1Redeemer.address, amount)
      })
    })
  })

  describe("withdrawFunds", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachineV2
            .connect(thirdParty)
            .withdrawFunds(tbtcV1.address, thirdParty.address, to1e18(1))
        ).to.be.revertedWith("Ownable: caller is not the owner")
        await expect(
          vendingMachineV2
            .connect(thirdParty)
            .withdrawFunds(tbtcV2.address, thirdParty.address, to1e18(1))
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when withdrawing tBTC v1 tokens", () => {
        const amount = to1e18(10)
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await tbtcV1.connect(deployer).mint(vendingMachineV2.address, amount)

          tx = await vendingMachineV2
            .connect(v1Redeemer)
            .withdrawFunds(tbtcV1.address, thirdParty.address, amount)
        })

        it("should transfer tokens to the recipient", async () => {
          expect(await tbtcV1.balanceOf(thirdParty.address)).is.equal(amount)
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(vendingMachineV2, "Withdrawn")
            .withArgs(tbtcV1.address, thirdParty.address, amount)
        })
      })

      context("when withdrawing tBTC v2 tokens", () => {
        const amount = to1e18(11)
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await tbtcV2.connect(deployer).mint(vendingMachineV2.address, amount)

          tx = await vendingMachineV2
            .connect(v1Redeemer)
            .withdrawFunds(tbtcV2.address, thirdParty.address, amount)
        })

        it("should transfer tokens to the recipient", async () => {
          expect(await tbtcV2.balanceOf(thirdParty.address)).is.equal(amount)
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(vendingMachineV2, "Withdrawn")
            .withArgs(tbtcV2.address, thirdParty.address, amount)
        })
      })
    })
  })
})
