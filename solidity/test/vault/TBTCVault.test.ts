import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, getUnnamedAccounts, helpers } from "hardhat"
import { loadFixture } from "../helpers/fixture"
import { expect } from "chai"
import { ContractTransaction } from "ethers"
import { constants } from "../fixtures"
import { toSatoshis } from "../helpers/contract-test-helpers"

import type {
  Bank,
  Bridge,
  TBTC,
  TBTCVault,
  TestERC20,
  TestERC721,
} from "../../typechain"
import { createMock } from "../helpers/mock"
import type { Mock } from "../helpers/mock"

const { to1e18 } = helpers.number
const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime, lastBlockTime } = helpers.time

const ZERO_ADDRESS = ethers.constants.AddressZero

const fixture = async () => {
  const [deployer, governance] = await ethers.getSigners()

  const bridge = await createMock<Bridge>("Bridge")
  // Fund the `bridge` account so it's possible to mock sending requests
  // from it.
  await deployer.sendTransaction({
    to: bridge.address,
    value: ethers.utils.parseEther("100"),
  })

  const Bank = await ethers.getContractFactory("Bank")
  const bank = await Bank.deploy()
  await bank.deployed()

  await bank.connect(deployer).updateBridge(bridge.address)

  const TBTC = await ethers.getContractFactory("TBTC")
  const tbtc = await TBTC.deploy()
  await tbtc.deployed()

  const TBTCVault = await ethers.getContractFactory("TBTCVault")
  const vault = await TBTCVault.deploy(
    bank.address,
    tbtc.address,
    bridge.address
  )
  await vault.deployed()

  await tbtc.connect(deployer).transferOwnership(vault.address)
  await vault.connect(deployer).transferOwnership(governance.address)

  return {
    bridge,
    governance,
    bank,
    vault,
    tbtc,
  }
}

describe("TBTCVault", () => {
  let bridge: Mock<Bridge>
  let governance: SignerWithAddress
  let bank: Bank
  let vault: TBTCVault
  let tbtc: TBTC

  // 100 BTC initial balance in the Bank.
  // Bank balance is denominated in satoshi.
  const initialBalance = toSatoshis(100)

  let account1: SignerWithAddress
  let account2: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ bridge, governance, bank, vault, tbtc } = await loadFixture(fixture))

    const accounts = await getUnnamedAccounts()
    account1 = await ethers.getSigner(accounts[0])
    account2 = await ethers.getSigner(accounts[1])

    await bank
      .connect(bridge.wallet)
      .increaseBalance(account1.address, initialBalance)
    await bank
      .connect(bridge.wallet)
      .increaseBalance(account2.address, initialBalance)

    await bank.connect(account1).approveBalance(vault.address, initialBalance)
    await bank.connect(account2).approveBalance(vault.address, initialBalance)
  })

  describe("constructor", () => {
    context("when called with a 0-address bank", () => {
      it("should revert", async () => {
        const TBTCVault = await ethers.getContractFactory("TBTCVault")
        await expect(
          TBTCVault.deploy(ZERO_ADDRESS, tbtc.address, bridge.address)
        ).to.be.revertedWith("Bank can not be the zero address")
      })
    })

    context("when called with a 0-address TBTC token", () => {
      it("should revert", async () => {
        const TBTCVault = await ethers.getContractFactory("TBTCVault")
        await expect(
          TBTCVault.deploy(bank.address, ZERO_ADDRESS, bridge.address)
        ).to.be.revertedWith("TBTC token can not be the zero address")
      })
    })

    context("when called with a 0-address bridge", () => {
      it("should revert", async () => {
        const TBTCVault = await ethers.getContractFactory("TBTCVault")
        await expect(
          TBTCVault.deploy(bank.address, tbtc.address, ZERO_ADDRESS)
        ).to.be.revertedWith("Bridge can not be the zero address")
      })
    })

    context("when called with correct parameters", () => {
      it("should set the Bank field", async () => {
        expect(await vault.bank()).to.equal(bank.address)
      })

      it("should set the TBTC token field", async () => {
        expect(await vault.tbtcToken()).to.equal(tbtc.address)
      })
    })
  })

  describe("recoverERC20FromToken", () => {
    let testToken: TestERC20

    before(async () => {
      await createSnapshot()

      const TestToken = await ethers.getContractFactory("TestERC20")
      testToken = await TestToken.deploy()
      await testToken.deployed()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          vault.recoverERC20FromToken(
            testToken.address,
            account1.address,
            to1e18(800)
          )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called with correct parameters", () => {
      before(async () => {
        await createSnapshot()

        // Do the misfund.
        await testToken.mint(account1.address, to1e18(1000))
        await testToken.connect(account1).transfer(tbtc.address, to1e18(1000))

        await vault
          .connect(governance)
          .recoverERC20FromToken(
            testToken.address,
            account1.address,
            to1e18(800)
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should do a successful recovery", async () => {
        expect(await testToken.balanceOf(account1.address)).to.be.equal(
          to1e18(800)
        )
        expect(await testToken.balanceOf(tbtc.address)).to.be.equal(to1e18(200))
      })
    })
  })

  describe("recoverERC721FromToken", () => {
    let testToken: TestERC721

    before(async () => {
      await createSnapshot()

      const TestToken = await ethers.getContractFactory("TestERC721")
      testToken = await TestToken.deploy()
      await testToken.deployed()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          vault.recoverERC721FromToken(
            testToken.address,
            account1.address,
            1,
            "0x01"
          )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called with correct parameters", () => {
      before(async () => {
        await createSnapshot()

        await testToken.mint(account1.address, 1)
        await testToken
          .connect(account1)
          .transferFrom(account1.address, tbtc.address, 1)

        await vault
          .connect(governance)
          .recoverERC721FromToken(
            testToken.address,
            account1.address,
            1,
            "0x01"
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should do a successful recovery", async () => {
        expect(await testToken.ownerOf(1)).to.be.equal(account1.address)
      })
    })
  })

  describe("recoverERC20", () => {
    let testToken: TestERC20

    before(async () => {
      await createSnapshot()

      const TestToken = await ethers.getContractFactory("TestERC20")
      testToken = await TestToken.deploy()
      await testToken.deployed()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          vault.recoverERC20(testToken.address, account1.address, to1e18(800))
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called with correct parameters", () => {
      before(async () => {
        await createSnapshot()

        await testToken.mint(account1.address, to1e18(1000))
        await testToken.connect(account1).transfer(vault.address, to1e18(1000))

        await vault
          .connect(governance)
          .recoverERC20(testToken.address, account1.address, to1e18(800))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should do a successful recovery", async () => {
        expect(await testToken.balanceOf(account1.address)).to.be.equal(
          to1e18(800)
        )
        expect(await testToken.balanceOf(vault.address)).to.be.equal(
          to1e18(200)
        )
      })
    })
  })

  describe("recoverERC721", () => {
    let testToken: TestERC721

    before(async () => {
      await createSnapshot()

      const TestToken = await ethers.getContractFactory("TestERC721")
      testToken = await TestToken.deploy()
      await testToken.deployed()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          vault.recoverERC721(testToken.address, account1.address, 1, [])
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called with correct parameters", () => {
      before(async () => {
        await createSnapshot()

        await testToken.mint(account1.address, 1)
        await testToken
          .connect(account1)
          .transferFrom(account1.address, vault.address, 1)

        await vault
          .connect(governance)
          .recoverERC721(testToken.address, account1.address, 1, [])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should do a successful recovery", async () => {
        expect(await testToken.ownerOf(1)).to.be.equal(account1.address)
      })
    })
  })

  describe("mint", () => {
    context("when minter has not enough balance in the bank", () => {
      const amount = to1e18(101) // The initial Bank balance is 100 BTC.

      before(async () => {
        await createSnapshot()
        // the initial approval was done in the top-level `before` setup;
        // we need to set back to 0 before approving again
        await bank.connect(account1).approveBalance(vault.address, 0)
        await bank.connect(account1).approveBalance(vault.address, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(vault.connect(account1).mint(amount)).to.be.revertedWith(
          "Amount exceeds balance in the bank"
        )
      })
    })

    context("when there is a single minter", () => {
      const amount = to1e18(13) // 3 + 1 + 9

      const transactions: ContractTransaction[] = []

      before(async () => {
        await createSnapshot()

        transactions.push(await vault.connect(account1).mint(to1e18(3)))
        transactions.push(await vault.connect(account1).mint(to1e18(1)))
        transactions.push(await vault.connect(account1).mint(to1e18(9)))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer balance to the vault", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(toSatoshis(13))
        expect(await bank.balanceOf(account1.address)).to.equal(
          toSatoshis(87) // 100 - 13
        )
      })

      it("should mint TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(amount)
        expect(await tbtc.totalSupply()).to.equal(amount)
      })

      it("should emit Minted event", async () => {
        await expect(transactions[0])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(3))
        await expect(transactions[1])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(1))
        await expect(transactions[2])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(9))
      })
    })

    context("when amount is not fully convertible to satoshis", () => {
      // Amount is 2 Bitcoin in 1e18 precision plus 0.1 satoshi in 1e18 precision
      const amount = ethers.BigNumber.from("2000000001000000000")

      let transaction: ContractTransaction

      before(async () => {
        await createSnapshot()

        transaction = await vault.connect(account1).mint(amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      // minting 2 BTC, the remainder is ignored

      it("should transfer balance to the vault", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(toSatoshis(2))
        expect(await bank.balanceOf(account1.address)).to.equal(
          toSatoshis(98) // 100 - 2
        )
      })

      it("should mint TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(to1e18(2))
        expect(await tbtc.totalSupply()).to.equal(to1e18(2))
      })

      it("should emit Minted event", async () => {
        await expect(transaction)
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(2))
      })
    })

    context("when there are multiple minters", () => {
      const amount1 = to1e18(13) // 3 + 1 + 9
      const amount2 = to1e18(3) // 1 + 2

      const transactions: ContractTransaction[] = []

      before(async () => {
        await createSnapshot()

        transactions.push(await vault.connect(account1).mint(to1e18(3)))
        transactions.push(await vault.connect(account2).mint(to1e18(1)))
        transactions.push(await vault.connect(account1).mint(to1e18(1)))
        transactions.push(await vault.connect(account1).mint(to1e18(9)))
        transactions.push(await vault.connect(account2).mint(to1e18(2)))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer balances to the vault", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(
          toSatoshis(16) // 3 + 1 + 1 + 9 + 2
        )
        expect(await bank.balanceOf(account1.address)).to.equal(
          toSatoshis(87) // 100 - 3 - 1 - 9
        )
        expect(await bank.balanceOf(account2.address)).to.equal(
          toSatoshis(97) // 100 - 1 - 2
        )
      })

      it("should mint TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(amount1)
        expect(await tbtc.balanceOf(account2.address)).to.equal(amount2)
        expect(await tbtc.totalSupply()).to.equal(amount1.add(amount2))
      })

      it("should emit Minted event", async () => {
        await expect(transactions[0])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(3))
        await expect(transactions[1])
          .to.emit(vault, "Minted")
          .withArgs(account2.address, to1e18(1))
        await expect(transactions[2])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(1))
        await expect(transactions[3])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(9))
        await expect(transactions[4])
          .to.emit(vault, "Minted")
          .withArgs(account2.address, to1e18(2))
      })
    })
  })

  describe("unmint", () => {
    context("when the unminter has no TBTC", () => {
      const amount = to1e18(1)
      before(async () => {
        await createSnapshot()

        await tbtc.connect(account1).approve(vault.address, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          vault.connect(account1).unmint(to1e18(1))
        ).to.be.revertedWith("Burn amount exceeds balance")
      })
    })

    context("when the unminter has not enough TBTC", () => {
      const mintedAmount = to1e18(1)
      const unmintedAmount = mintedAmount.add(constants.satoshiMultiplier)

      before(async () => {
        await createSnapshot()

        await vault.connect(account1).mint(mintedAmount)
        await tbtc.connect(account1).approve(vault.address, unmintedAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          vault.connect(account1).unmint(unmintedAmount)
        ).to.be.revertedWith("Burn amount exceeds balance")
      })
    })

    context("when there is a single unminter", () => {
      const mintedAmount = to1e18(20)
      const unmintedAmount = to1e18(12) // 1 + 3 + 8
      const notUnmintedAmount = mintedAmount.sub(unmintedAmount) // 20 - 12

      const transactions: ContractTransaction[] = []

      before(async () => {
        await createSnapshot()

        await vault.connect(account1).mint(mintedAmount)
        await tbtc.connect(account1).approve(vault.address, unmintedAmount)
        transactions.push(await vault.connect(account1).unmint(to1e18(1)))
        transactions.push(await vault.connect(account1).unmint(to1e18(3)))
        transactions.push(await vault.connect(account1).unmint(to1e18(8)))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer balance to the unminter", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(toSatoshis(8)) // 20 - 12
        expect(await bank.balanceOf(account1.address)).to.equal(
          toSatoshis(92) // 100 - 8
        )
      })

      it("should burn TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          notUnmintedAmount
        )
        expect(await tbtc.totalSupply()).to.be.equal(notUnmintedAmount)
      })

      it("should emit Unminted events", async () => {
        await expect(transactions[0])
          .to.emit(vault, "Unminted")
          .withArgs(account1.address, to1e18(1))
        await expect(transactions[1])
          .to.emit(vault, "Unminted")
          .withArgs(account1.address, to1e18(3))
        await expect(transactions[2])
          .to.emit(vault, "Unminted")
          .withArgs(account1.address, to1e18(8))
      })
    })

    context("when amount is not fully convertible to satoshis", () => {
      const mintedAmount = to1e18(20)
      // Amount is 2 Bitcoin in 1e18 precision plus 0.1 satoshi in 1e18 precision
      const unmintedAmount = ethers.BigNumber.from("2000000001000000000")
      const notUnmintedAmount = to1e18(18) // 20 - 2; remainder should be ignored

      let transaction: ContractTransaction

      before(async () => {
        await createSnapshot()

        await vault.connect(account1).mint(mintedAmount)
        await tbtc.connect(account1).approve(vault.address, unmintedAmount)
        transaction = await vault.connect(account1).unmint(unmintedAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      // unminting 2 BTC, the remainder is ignored

      it("should transfer balance to the unminter", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(toSatoshis(18)) // 20 - 2
        expect(await bank.balanceOf(account1.address)).to.equal(
          toSatoshis(82) // 100 - 18
        )
      })

      it("should burn TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          notUnmintedAmount
        )
        expect(await tbtc.totalSupply()).to.be.equal(notUnmintedAmount)
      })

      it("should emit Unminted events", async () => {
        await expect(transaction)
          .to.emit(vault, "Unminted")
          .withArgs(account1.address, to1e18(2))
      })
    })

    context("when there are multiple unminters", () => {
      const mintedAmount1 = to1e18(20)
      const unmintedAmount1 = to1e18(12) // 1 + 3 + 8 = 12
      const notUnmintedAmount1 = mintedAmount1.sub(unmintedAmount1) // 20 - 12

      const mintedAmount2 = to1e18(41)
      const unmintedAmount2 = to1e18(30) // 20 + 10 = 30
      const notUnmintedAmount2 = mintedAmount2.sub(unmintedAmount2) // 41 - 30

      const transactions: ContractTransaction[] = []

      before(async () => {
        await createSnapshot()

        await vault.connect(account1).mint(mintedAmount1)
        await vault.connect(account2).mint(mintedAmount2)
        await tbtc.connect(account1).approve(vault.address, unmintedAmount1)
        await tbtc.connect(account2).approve(vault.address, unmintedAmount2)
        transactions.push(await vault.connect(account1).unmint(to1e18(1)))
        transactions.push(await vault.connect(account2).unmint(to1e18(20)))
        transactions.push(await vault.connect(account1).unmint(to1e18(3)))
        transactions.push(await vault.connect(account1).unmint(to1e18(8)))
        transactions.push(await vault.connect(account2).unmint(to1e18(10)))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer balances to unminters", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(
          toSatoshis(19) // 8 + 11
        )
        expect(await bank.balanceOf(account1.address)).to.equal(
          toSatoshis(92) // 100 - 8
        )
        expect(await bank.balanceOf(account2.address)).to.equal(
          toSatoshis(89) // 100 - 11
        )
      })

      it("should burn TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          notUnmintedAmount1
        )
        expect(await tbtc.balanceOf(account2.address)).to.equal(
          notUnmintedAmount2
        )
        expect(await tbtc.totalSupply()).to.be.equal(
          notUnmintedAmount1.add(notUnmintedAmount2)
        )
      })

      it("should emit Unminted events", async () => {
        await expect(transactions[0])
          .to.emit(vault, "Unminted")
          .withArgs(account1.address, to1e18(1))
        await expect(transactions[1])
          .to.emit(vault, "Unminted")
          .withArgs(account2.address, to1e18(20))
        await expect(transactions[2])
          .to.emit(vault, "Unminted")
          .withArgs(account1.address, to1e18(3))
        await expect(transactions[3])
          .to.emit(vault, "Unminted")
          .withArgs(account1.address, to1e18(8))
        await expect(transactions[4])
          .to.emit(vault, "Unminted")
          .withArgs(account2.address, to1e18(10))
      })
    })
  })

  describe("receiveApproval", () => {
    context("when called not for TBTC token", () => {
      it("should revert", async () => {
        await expect(
          vault
            .connect(account1)
            .receiveApproval(account1.address, to1e18(1), account1.address, [])
        ).to.be.revertedWith("Token is not TBTC")
      })
    })

    context("when called directly", () => {
      it("should revert", async () => {
        await expect(
          vault
            .connect(account1)
            .receiveApproval(account1.address, to1e18(1), tbtc.address, [])
        ).to.be.revertedWith("Only TBTC caller allowed")
      })
    })

    context("when called via approveAndCall", () => {
      context("when called with an empty extraData", () => {
        const mintedAmount = to1e18(10)
        const unmintedAmount = to1e18(4)
        const notUnmintedAmount = mintedAmount.sub(unmintedAmount) // 10 - 4 = 6

        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await vault.connect(account1).mint(mintedAmount)
          tx = await tbtc
            .connect(account1)
            .approveAndCall(vault.address, unmintedAmount, [])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer balance to the unminter", async () => {
          expect(await bank.balanceOf(vault.address)).to.equal(toSatoshis(6))
          expect(await bank.balanceOf(account1.address)).to.equal(
            toSatoshis(94) // 100 - 6
          )
        })

        it("should burn TBTC", async () => {
          expect(await tbtc.balanceOf(account1.address)).to.equal(
            notUnmintedAmount
          )
          expect(await tbtc.totalSupply()).to.be.equal(notUnmintedAmount)
        })

        it("should emit Unminted event", async () => {
          await expect(tx)
            .to.emit(vault, "Unminted")
            .withArgs(account1.address, unmintedAmount)
        })
      })

      context("when amount is not fully convertible to satoshis", () => {
        const mintedAmount = to1e18(20)
        // Amount is 3 Bitcoin in 1e18 precision plus 0.1 satoshi in 1e18 precision
        const unmintedAmount = ethers.BigNumber.from("3000000001000000000")
        const notUnmintedAmount = to1e18(17) // 20 - 3; remainder should be ignored

        let transaction: ContractTransaction

        before(async () => {
          await createSnapshot()

          await vault.connect(account1).mint(mintedAmount)
          transaction = await tbtc
            .connect(account1)
            .approveAndCall(vault.address, unmintedAmount, [])
        })

        after(async () => {
          await restoreSnapshot()
        })

        // unminting 3 BTC, the remainder is ignored

        it("should transfer balance to the unminter", async () => {
          expect(await bank.balanceOf(vault.address)).to.equal(toSatoshis(17)) // 20 - 3
          expect(await bank.balanceOf(account1.address)).to.equal(
            toSatoshis(83) // 100 - 17
          )
        })

        it("should burn TBTC", async () => {
          expect(await tbtc.balanceOf(account1.address)).to.equal(
            notUnmintedAmount
          )
          expect(await tbtc.totalSupply()).to.be.equal(notUnmintedAmount)
        })

        it("should emit Unminted events", async () => {
          await expect(transaction)
            .to.emit(vault, "Unminted")
            .withArgs(account1.address, to1e18(3))
        })
      })
    })
  })

  describe("receiveBalanceApproval", () => {
    context("when called not by the bank", () => {
      const amount = initialBalance

      it("should revert", async () => {
        await expect(
          vault
            .connect(bridge.wallet)
            .receiveBalanceApproval(account1.address, amount, [])
        ).to.be.revertedWith("Caller is not the Bank")
        await expect(
          vault
            .connect(account1)
            .receiveBalanceApproval(account1.address, amount, [])
        ).to.be.revertedWith("Caller is not the Bank")
      })
    })

    context("when caller has not enough balance in the bank", () => {
      const amount = initialBalance.add(1)

      it("should revert", async () => {
        await expect(
          bank
            .connect(account1)
            .approveBalanceAndCall(vault.address, amount, [])
        ).to.be.revertedWith("Amount exceeds balance in the bank")
      })
    })

    context("when there is a single caller", () => {
      const amount = toSatoshis(19) // 4 + 10 + 5

      const transactions: ContractTransaction[] = []

      before(async () => {
        await createSnapshot()

        transactions.push(
          await bank
            .connect(account1)
            .approveBalanceAndCall(vault.address, toSatoshis(4), [])
        )
        transactions.push(
          await bank
            .connect(account1)
            .approveBalanceAndCall(vault.address, toSatoshis(10), [])
        )
        transactions.push(
          await bank
            .connect(account1)
            .approveBalanceAndCall(vault.address, toSatoshis(5), [])
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer balance to the vault", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(amount)
        expect(await bank.balanceOf(account1.address)).to.equal(
          initialBalance.sub(amount)
        )
      })

      it("should mint TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(to1e18(19))
        expect(await tbtc.totalSupply()).to.equal(to1e18(19))
      })

      it("should emit Minted event", async () => {
        await expect(transactions[0])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(4))
        await expect(transactions[1])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(10))
        await expect(transactions[2])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(5))
      })
    })

    context("when there are multiple callers", () => {
      const amount1 = toSatoshis(4) // 2 + 1 + 1
      const amount2 = toSatoshis(5) // 4 + 1

      const transactions: ContractTransaction[] = []

      before(async () => {
        await createSnapshot()

        transactions.push(
          await bank
            .connect(account1)
            .approveBalanceAndCall(vault.address, toSatoshis(2), [])
        )
        transactions.push(
          await bank
            .connect(account2)
            .approveBalanceAndCall(vault.address, toSatoshis(4), [])
        )
        transactions.push(
          await bank
            .connect(account1)
            .approveBalanceAndCall(vault.address, toSatoshis(1), [])
        )
        transactions.push(
          await bank
            .connect(account1)
            .approveBalanceAndCall(vault.address, toSatoshis(1), [])
        )
        transactions.push(
          await bank
            .connect(account2)
            .approveBalanceAndCall(vault.address, toSatoshis(1), [])
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer balances to the vault", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(
          amount1.add(amount2)
        )
        expect(await bank.balanceOf(account1.address)).to.equal(
          initialBalance.sub(amount1)
        )
        expect(await bank.balanceOf(account2.address)).to.equal(
          initialBalance.sub(amount2)
        )
      })

      it("should mint TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(to1e18(4))
        expect(await tbtc.balanceOf(account2.address)).to.equal(to1e18(5))
        expect(await tbtc.totalSupply()).to.equal(to1e18(9)) // 4 + 5
      })

      it("should emit Minted event", async () => {
        await expect(transactions[0])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(2))
        await expect(transactions[1])
          .to.emit(vault, "Minted")
          .withArgs(account2.address, to1e18(4))
        await expect(transactions[2])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(1))
        await expect(transactions[3])
          .to.emit(vault, "Minted")
          .withArgs(account1.address, to1e18(1))
        await expect(transactions[4])
          .to.emit(vault, "Minted")
          .withArgs(account2.address, to1e18(1))
      })
    })
  })

  describe("receiveBalanceIncrease", () => {
    const depositor1 = "0x30c371E0651B2Ff6062158ca1D95b07C7531c719"
    const depositor2 = "0xb3464806d680722dBc678996F1670D19A42eA3e9"
    const depositor3 = "0x6B9925e04bc46569d1F7362eD7f11539234f0aEc"

    const depositedAmount1 = toSatoshis(19)
    const depositedAmount2 = toSatoshis(11)
    const depositedAmount3 = toSatoshis(301)

    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the bank", () => {
      it("should revert", async () => {
        await expect(
          vault
            .connect(bridge.wallet)
            .receiveBalanceIncrease([depositor1], [depositedAmount1])
        ).to.be.revertedWith("Caller is not the Bank")
      })
    })

    context("when called with no depositors", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(bridge.wallet)
            .increaseBalanceAndCall(vault.address, [], [])
        ).to.be.revertedWith("No depositors specified")
      })
    })

    context("with single depositor", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [depositor1],
            [depositedAmount1]
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should mint TBTC", async () => {
        expect(await tbtc.balanceOf(depositor1)).to.equal(to1e18(19))
        expect(await tbtc.totalSupply()).to.equal(to1e18(19))
      })

      it("should emit Minted event", async () => {
        await expect(tx)
          .to.emit(vault, "Minted")
          .withArgs(depositor1, to1e18(19))
      })
    })

    context("with multiple depositors", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bank
          .connect(bridge.wallet)
          .increaseBalanceAndCall(
            vault.address,
            [depositor1, depositor2, depositor3],
            [depositedAmount1, depositedAmount2, depositedAmount3]
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should mint TBTC", async () => {
        expect(await tbtc.balanceOf(depositor1)).to.equal(to1e18(19))
        expect(await tbtc.balanceOf(depositor2)).to.equal(to1e18(11))
        expect(await tbtc.balanceOf(depositor3)).to.equal(to1e18(301))
        expect(await tbtc.totalSupply()).to.equal(to1e18(331)) // 19 + 11 + 301
      })

      it("should emit Minted events", async () => {
        await expect(tx)
          .to.emit(vault, "Minted")
          .withArgs(depositor1, to1e18(19))
        await expect(tx)
          .to.emit(vault, "Minted")
          .withArgs(depositor2, to1e18(11))
        await expect(tx)
          .to.emit(vault, "Minted")
          .withArgs(depositor3, to1e18(301))
      })
    })
  })

  describe("initiateUpgrade", () => {
    const newVault = "0xE4d1514C79ae3967f4410Aaf861Bb59307b243a3"

    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          vault.connect(account1).initiateUpgrade(newVault)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      context("when called with a zero-address new vault", () => {
        it("should revert", async () => {
          await expect(
            vault.connect(governance).initiateUpgrade(ZERO_ADDRESS)
          ).to.be.revertedWith("New vault address cannot be zero")
        })
      })

      context("when called with a non-zero-address new vault", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          tx = await vault.connect(governance).initiateUpgrade(newVault)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should not transfer TBTC token ownership", async () => {
          expect(await tbtc.owner()).is.equal(vault.address)
        })

        it("should set the upgrade initiation time", async () => {
          expect(await vault.upgradeInitiatedTimestamp()).to.equal(
            await lastBlockTime()
          )
        })

        it("should set the new vault address", async () => {
          expect(await vault.newVault()).to.equal(newVault)
        })

        it("should emit UpgradeInitiated event", async () => {
          await expect(tx)
            .to.emit(vault, "UpgradeInitiated")
            .withArgs(newVault, await lastBlockTime())
        })
      })
    })
  })

  describe("finalizeUpgrade", () => {
    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          vault.connect(account1).finalizeUpgrade()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      context("when the upgrade process has not been initiated", () => {
        it("should revert", async () => {
          await expect(
            vault.connect(governance).finalizeUpgrade()
          ).to.be.revertedWith("Change not initiated")
        })
      })

      context("when the upgrade process has been initiated", () => {
        const newVault = "0x8C338c4222082bdFA5FeC478747Bb1e102A264D9"

        before(async () => {
          await createSnapshot()
          await vault.connect(governance).initiateUpgrade(newVault)

          // Mint some TBTC to increase the balance of TBTCVault
          await bank
            .connect(account1)
            .approveBalanceAndCall(vault.address, initialBalance, [])
          await bank
            .connect(account2)
            .approveBalanceAndCall(vault.address, initialBalance, [])
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when the governance delay has not passed", () => {
          before(async () => {
            await createSnapshot()
            await increaseTime(86400 - 60) // 24h - 1min
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              vault.connect(governance).finalizeUpgrade()
            ).to.be.revertedWith("Governance delay has not elapsed")
          })
        })

        context("when the governance delay passed", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()
            await increaseTime(86400) // 24h

            tx = await vault.connect(governance).finalizeUpgrade()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should transfer TBTC token ownership", async () => {
            expect(await tbtc.owner()).is.equal(newVault)
          })

          it("should transfer the entire bank balance", async () => {
            expect(await bank.balanceOf(vault.address)).to.equal(0)
            // In the setup, each account minted `initialBalance` of TBTC.
            expect(await bank.balanceOf(newVault)).to.equal(
              initialBalance.mul(2)
            )
          })

          it("should emit UpgradeFinalized event", async () => {
            await expect(tx)
              .to.emit(vault, "UpgradeFinalized")
              .withArgs(newVault)
          })

          it("should reset the upgrade initiation time", async () => {
            expect(await vault.upgradeInitiatedTimestamp()).to.equal(0)
          })

          it("should reset the new vault address", async () => {
            expect(await vault.newVault()).to.equal(ZERO_ADDRESS)
          })
        })
      })
    })
  })

  describe("amountToSatoshis", () => {
    context("when the amount is convertible with a remainder", () => {
      // 0.000000001 BTC = 0.1 satoshi
      // 1000000000 in 1e18 precision
      //
      // Amount is 1 Bitcoin in 1e18 precision plus 0.1 satoshi in 1e18 precision
      const amount = ethers.BigNumber.from("1000000001000000000")

      it("should calculate correct convertible amount", async () => {
        const { convertibleAmount } = await vault.amountToSatoshis(amount)
        expect(convertibleAmount).to.equal(
          ethers.BigNumber.from("1000000000000000000")
        )
      })

      it("should calculate correct remainder", async () => {
        const { remainder } = await vault.amountToSatoshis(amount)
        expect(remainder).to.equal(ethers.BigNumber.from("1000000000"))
      })

      it("should calculate correct satoshi amount", async () => {
        const { satoshis } = await vault.amountToSatoshis(amount)
        expect(satoshis).to.equal(ethers.BigNumber.from("100000000")) // 1 BTC in satoshi
      })
    })

    context("when the amount is convertible without a remainder", () => {
      // Amount is 1.1 Bitcoin in 1e18 precision
      const amount = ethers.BigNumber.from("1100000000000000000")

      it("should calculate correct convertible amount", async () => {
        const { convertibleAmount } = await vault.amountToSatoshis(amount)
        expect(convertibleAmount).to.equal(amount)
      })

      it("should calculate correct remainder", async () => {
        const { remainder } = await vault.amountToSatoshis(amount)
        expect(remainder).to.equal(0)
      })

      it("should calculate correct satoshi amount", async () => {
        const { satoshis } = await vault.amountToSatoshis(amount)
        expect(satoshis).to.equal(ethers.BigNumber.from("110000000")) // 1.1 BTC in satoshi
      })
    })
  })
})
