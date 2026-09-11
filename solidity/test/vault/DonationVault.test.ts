import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, helpers } from "hardhat"
import { expect } from "chai"

import { ContractTransaction } from "ethers"
import type { Bank, DonationVault } from "../../typechain"
import { loadFixture } from "../helpers/fixture"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const fixture = async () => {
  const [deployer, bridge, account1, account2] = await ethers.getSigners()

  const Bank = await ethers.getContractFactory("Bank")
  const bank = await Bank.deploy()
  await bank.deployed()

  await bank.connect(deployer).updateBridge(bridge.address)

  const DonationVault = await ethers.getContractFactory("DonationVault")
  const vault = await DonationVault.deploy(bank.address)
  await vault.deployed()

  return {
    bridge,
    account1,
    account2,
    bank,
    vault,
  }
}

describe("DonationVault", () => {
  let bridge: SignerWithAddress
  let account1: SignerWithAddress
  let account2: SignerWithAddress
  let bank: Bank
  let vault: DonationVault

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ bridge, account1, account2, bank, vault } = await loadFixture(fixture))
  })

  describe("constructor", () => {
    context("when called with a 0-address bank", () => {
      it("should revert", async () => {
        const DonationVault = await ethers.getContractFactory("DonationVault")
        await expect(
          DonationVault.deploy(ethers.constants.AddressZero)
        ).to.be.revertedWith("Bank can not be the zero address")
      })
    })

    context("when called with correct parameters", () => {
      it("should set the Bank field", async () => {
        expect(await vault.bank()).to.equal(bank.address)
      })
    })
  })

  describe("donate", () => {
    context("when caller has not enough balance in the bank", () => {
      before(async () => {
        await createSnapshot()

        await bank.connect(bridge).increaseBalance(account1.address, 999)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(vault.connect(account1).donate(1000)).to.be.revertedWith(
          "Amount exceeds balance in the bank"
        )
      })
    })

    context(
      "when vault does not have enough allowance for caller's balance",
      () => {
        before(async () => {
          await createSnapshot()

          await bank.connect(bridge).increaseBalance(account1.address, 1000)
          await bank
            .connect(account1)
            .increaseBalanceAllowance(vault.address, 999)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(vault.connect(account1).donate(1000)).to.be.revertedWith(
            "Transfer amount exceeds allowance"
          )
        })
      }
    )

    context("when called with correct parameters", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await bank.connect(bridge).increaseBalance(account1.address, 1100)
        await bank
          .connect(account1)
          .increaseBalanceAllowance(vault.address, 1100)

        tx = await vault.connect(account1).donate(1000)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should decrease donor's balance", async () => {
        expect(await bank.balanceOf(account1.address)).to.be.equal(100)
      })

      it("should not increase vault's balance", async () => {
        expect(await bank.balanceOf(vault.address)).to.be.equal(0)
      })

      it("should emit BalanceDecreased event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceDecreased")
          .withArgs(vault.address, 1000)
      })

      it("should emit DonationReceived event", async () => {
        await expect(tx)
          .to.emit(vault, "DonationReceived")
          .withArgs(account1.address, 1000)
      })
    })
  })

  describe("receiveBalanceApproval", () => {
    context("when called not by the bank", () => {
      it("should revert", async () => {
        await expect(
          vault
            .connect(bridge)
            .receiveBalanceApproval(account1.address, 1000, [])
        ).to.be.revertedWith("Caller is not the Bank")
      })
    })

    context("when caller has not enough balance in the bank", () => {
      before(async () => {
        await createSnapshot()

        await bank.connect(bridge).increaseBalance(account1.address, 999)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bank.connect(account1).approveBalanceAndCall(vault.address, 1000, [])
        ).to.be.revertedWith("Amount exceeds balance in the bank")
      })
    })

    context("when called with correct parameters", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await bank.connect(bridge).increaseBalance(account1.address, 1100)

        tx = await bank
          .connect(account1)
          .approveBalanceAndCall(vault.address, 1000, [])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should decrease donor's balance", async () => {
        expect(await bank.balanceOf(account1.address)).to.be.equal(100)
      })

      it("should not increase vault's balance", async () => {
        expect(await bank.balanceOf(vault.address)).to.be.equal(0)
      })

      it("should emit BalanceDecreased event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceDecreased")
          .withArgs(vault.address, 1000)
      })

      it("should emit DonationReceived event", async () => {
        await expect(tx)
          .to.emit(vault, "DonationReceived")
          .withArgs(account1.address, 1000)
      })
    })
  })

  describe("receiveBalanceIncrease", () => {
    context("when called not by the bank", () => {
      it("should revert", async () => {
        await expect(
          vault
            .connect(bridge)
            .receiveBalanceIncrease([account1.address], [1000])
        ).to.be.revertedWith("Caller is not the Bank")
      })
    })

    context("when called with no depositors", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(bridge).increaseBalanceAndCall(vault.address, [], [])
        ).to.be.revertedWith("No depositors specified")
      })
    })

    context("when called with correct parameters", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bank
          .connect(bridge)
          .increaseBalanceAndCall(
            vault.address,
            [account1.address, account2.address],
            [1000, 2000]
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not increase depositors' balances", async () => {
        expect(await bank.balanceOf(account1.address)).to.be.equal(0)
        expect(await bank.balanceOf(account2.address)).to.be.equal(0)
      })

      it("should not increase vault's balance", async () => {
        expect(await bank.balanceOf(vault.address)).to.be.equal(0)
      })

      it("should emit BalanceDecreased event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceDecreased")
          .withArgs(vault.address, 3000)
      })

      it("should emit DonationReceived event", async () => {
        await expect(tx)
          .to.emit(vault, "DonationReceived")
          .withArgs(account1.address, 1000)

        await expect(tx)
          .to.emit(vault, "DonationReceived")
          .withArgs(account2.address, 2000)
      })
    })
  })
})
