import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { fake, matchers } from "../helpers/mockFactory"

import { ContractTransaction, Signature, Wallet } from "ethers"
import type { Bank, IVault } from "../../typechain"
import { to1e18, toSatoshis } from "../helpers/contract-test-helpers"

chai.use(matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const ZERO_ADDRESS = ethers.constants.AddressZero
const MAX_UINT256 = ethers.constants.MaxUint256

const fixture = async () => {
  const [deployer, governance, bridge, thirdParty] = await ethers.getSigners()

  const Bank = await ethers.getContractFactory("Bank")
  const bank = await Bank.deploy()
  await bank.deployed()

  await bank.connect(deployer).updateBridge(bridge.address)
  await bank.connect(deployer).transferOwnership(governance.address)

  return {
    deployer,
    governance,
    bridge,
    thirdParty,
    bank,
  }
}

describe("Bank", () => {
  // default Hardhat's networks blockchain, see https://hardhat.org/config/
  const hardhatNetworkId = 31337

  let deployer: SignerWithAddress

  let governance: SignerWithAddress
  let bridge: SignerWithAddress
  let thirdParty: SignerWithAddress

  let bank: Bank

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, bridge, thirdParty, bank } =
      await waffle.loadFixture(fixture))
  })

  describe("PERMIT_TYPEHASH", () => {
    it("should be keccak256 of EIP2612 Permit message", async () => {
      const expected = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(
          "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        )
      )
      expect(await bank.PERMIT_TYPEHASH()).to.equal(expected)
      // double-checking...
      expect(await bank.PERMIT_TYPEHASH()).to.equal(
        "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9"
      )
    })
  })

  describe("updateBridge", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(thirdParty).updateBridge(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called with 0-address bridge", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(governance).updateBridge(ZERO_ADDRESS)
        ).to.be.revertedWith("Bridge address must not be 0x0")
      })
    })

    context("when called by the governance", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bank.connect(governance).updateBridge(thirdParty.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the bridge", async () => {
        expect(await bank.bridge()).to.equal(thirdParty.address)
      })

      it("should emit the BridgeUpdated event", async () => {
        await expect(tx)
          .to.emit(bank, "BridgeUpdated")
          .withArgs(thirdParty.address)
      })
    })
  })

  describe("transferBalance", () => {
    const initialBalance = toSatoshis(500)

    let spender: SignerWithAddress
    let recipient: string

    before(async () => {
      await createSnapshot()

      const accounts = await getUnnamedAccounts()
      spender = await ethers.getSigner(accounts[0])
      // eslint-disable-next-line prefer-destructuring
      recipient = accounts[1]

      await bank
        .connect(bridge)
        .increaseBalance(spender.address, initialBalance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the recipient is the zero address", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(spender).transferBalance(ZERO_ADDRESS, initialBalance)
        ).to.be.revertedWith("Can not transfer to the zero address")
      })
    })

    context("when the recipient is the bank address", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(spender).transferBalance(bank.address, initialBalance)
        ).to.be.revertedWith("Can not transfer to the Bank address")
      })
    })

    context("when the spender has not enough balance", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(spender)
            .transferBalance(recipient, initialBalance.add(1))
        ).to.be.revertedWith("Transfer amount exceeds balance")
      })
    })

    context("when the spender transfers part of their balance", () => {
      const amount = toSatoshis(21)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bank.connect(spender).transferBalance(recipient, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer the requested amount", async () => {
        expect(await bank.balanceOf(spender.address)).to.equal(
          initialBalance.sub(amount)
        )
        expect(await bank.balanceOf(recipient)).to.equal(amount)
      })

      it("should emit the BalanceTransferred event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceTransferred")
          .withArgs(spender.address, recipient, amount)
      })
    })

    context(
      "when the spender transfers part of their balance in two transactions",
      () => {
        const amount1 = toSatoshis(21)
        const amount2 = toSatoshis(12)

        before(async () => {
          await createSnapshot()
          await bank.connect(spender).transferBalance(recipient, amount1)
          await bank.connect(spender).transferBalance(recipient, amount2)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer the requested amount", async () => {
          expect(await bank.balanceOf(spender.address)).to.equal(
            initialBalance.sub(amount1).sub(amount2)
          )
          expect(await bank.balanceOf(recipient)).to.equal(amount1.add(amount2))
        })
      }
    )

    context("when the spender transfers their entire balance", () => {
      const amount = initialBalance
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bank.connect(spender).transferBalance(recipient, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer the entire balance", async () => {
        expect(await bank.balanceOf(spender.address)).to.equal(0)
        expect(await bank.balanceOf(recipient)).to.equal(amount)
      })

      it("should emit the BalanceTransferred event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceTransferred")
          .withArgs(spender.address, recipient, amount)
      })
    })

    context("when the spender transfers 0 balance", () => {
      const amount = 0
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bank.connect(spender).transferBalance(recipient, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer no balance", async () => {
        expect(await bank.balanceOf(spender.address)).to.equal(initialBalance)
        expect(await bank.balanceOf(recipient)).to.equal(0)
      })

      it("should emit the BalanceTransferred event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceTransferred")
          .withArgs(spender.address, recipient, 0)
      })
    })
  })

  describe("approveBalanceAndCall", () => {
    const amount = toSatoshis(11)

    let owner: SignerWithAddress

    let mockVault: any

    before(async () => {
      const accounts = await getUnnamedAccounts()
      owner = await ethers.getSigner(accounts[0])
      mockVault = await fake<IVault>("IVault")
    })

    context("when the spender is the zero address", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(owner).approveBalanceAndCall(ZERO_ADDRESS, amount, [])
        ).to.be.revertedWith("Can not approve to the zero address")
      })
    })

    context("when the spender callback reverted", () => {
      before(async () => {
        await mockVault.receiveBalanceApproval.reverts()
      })

      after(async () => {
        mockVault.receiveBalanceApproval.reset()
      })

      it("should revert", async () => {
        await expect(
          bank
            .connect(owner)
            .approveBalanceAndCall(mockVault.address, amount, [])
        ).to.be.reverted
      })
    })

    context("when the spender had no approved balance before", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bank
          .connect(owner)
          .approveBalanceAndCall(mockVault.address, amount, "0x11")
      })

      after(async () => {
        await restoreSnapshot()
        mockVault.receiveBalanceApproval.reset()
      })

      it("should approve the requested amount", async () => {
        expect(await bank.allowance(owner.address, mockVault.address)).to.equal(
          amount
        )
      })

      it("should emit the BalanceApproved event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceApproved")
          .withArgs(owner.address, mockVault.address, amount)
      })

      it("should call receiveBalanceApproval", async () => {
        expect(mockVault.receiveBalanceApproval).to.have.been.calledOnceWith(
          owner.address,
          amount,
          "0x11"
        )
      })
    })

    context("when the spender had an approved balance before", () => {
      before(async () => {
        await createSnapshot()

        await bank
          .connect(owner)
          .approveBalance(mockVault.address, toSatoshis(1337))
        await bank
          .connect(owner)
          .approveBalanceAndCall(mockVault.address, amount, "0x02")
      })

      after(async () => {
        await restoreSnapshot()
        mockVault.receiveBalanceApproval.reset()
      })

      it("should replace the previous allowance", async () => {
        expect(await bank.allowance(owner.address, mockVault.address)).to.equal(
          amount
        )
      })

      it("should call receiveBalanceApproval", async () => {
        expect(mockVault.receiveBalanceApproval).to.have.been.calledOnceWith(
          owner.address,
          amount,
          "0x02"
        )
      })
    })
  })

  describe("approveBalance", () => {
    const amount = toSatoshis(10)

    let owner: SignerWithAddress
    let spender: string

    before(async () => {
      const accounts = await getUnnamedAccounts()
      owner = await ethers.getSigner(accounts[0])
      // eslint-disable-next-line prefer-destructuring
      spender = accounts[1]
    })

    context("when the spender is the zero address", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(owner).approveBalance(ZERO_ADDRESS, amount)
        ).to.be.revertedWith("Can not approve to the zero address")
      })
    })

    context("when the spender had no approved balance before", () => {
      let tx: ContractTransaction

      context("when setting approval to non-zero amount", () => {
        before(async () => {
          await createSnapshot()

          tx = await bank.connect(owner).approveBalance(spender, amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should approve the requested amount", async () => {
          expect(await bank.allowance(owner.address, spender)).to.equal(amount)
        })

        it("should emit the BalanceApproved event", async () => {
          await expect(tx)
            .to.emit(bank, "BalanceApproved")
            .withArgs(owner.address, spender, amount)
        })
      })

      // This case should not happen in a real-world because setting approval
      // to 0 when it's already 0 does not really make sense. However, we want
      // to make sure nothing unexpected happens in this scenario.
      context("when setting approval to zero", () => {
        before(async () => {
          await createSnapshot()

          tx = await bank.connect(owner).approveBalance(spender, 0)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should not change the zero approval", async () => {
          expect(await bank.allowance(owner.address, spender)).to.equal(0)
        })

        it("should emit the BalanceApproved event", async () => {
          await expect(tx)
            .to.emit(bank, "BalanceApproved")
            .withArgs(owner.address, spender, 0)
        })
      })
    })

    context("when the spender had an approved balance before", () => {
      before(async () => {
        await createSnapshot()
        await bank.connect(owner).approveBalance(spender, toSatoshis(1337))
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when setting approval back to zero", () => {
        before(async () => {
          await createSnapshot()
          await bank.connect(owner).approveBalance(spender, 0)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should replace the previous allowance with zero", async () => {
          expect(await bank.allowance(owner.address, spender)).to.equal(0)
        })
      })

      context("when trying to overwrite with a non-zero value", () => {
        it("should revert", async () => {
          await expect(
            bank.connect(owner).approveBalance(spender, 1)
          ).to.be.revertedWith("Non-atomic allowance change not allowed")
        })
      })
    })
  })

  describe("increaseBalanceAllowance", () => {
    const amount = toSatoshis(12)

    let owner: SignerWithAddress
    let spender: string

    before(async () => {
      await createSnapshot()

      const accounts = await getUnnamedAccounts()
      owner = await ethers.getSigner(accounts[0])
      // eslint-disable-next-line prefer-destructuring
      spender = accounts[1]
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the spender is the zero address", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(owner).increaseBalanceAllowance(ZERO_ADDRESS, amount)
        ).to.be.revertedWith("Can not approve")
      })
    })

    context("when the spender had no approved balance before", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bank.connect(owner).increaseBalanceAllowance(spender, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should approve the requested amount", async () => {
        expect(await bank.allowance(owner.address, spender)).to.equal(amount)
      })

      it("should emit the BalanceApproved event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceApproved")
          .withArgs(owner.address, spender, amount)
      })
    })

    context("when the spender had an approved balance before", () => {
      before(async () => {
        await createSnapshot()
        await bank.connect(owner).approveBalance(spender, toSatoshis(1337))
        await bank.connect(owner).increaseBalanceAllowance(spender, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should increase the previous allowance", async () => {
        expect(await bank.allowance(owner.address, spender)).to.equal(
          toSatoshis(1337).add(amount)
        )
      })
    })

    context("when the spender has a maximum allowance", () => {
      before(async () => {
        await createSnapshot()
        await bank.connect(owner).approveBalance(spender, MAX_UINT256)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bank.connect(owner).increaseBalanceAllowance(spender, toSatoshis(1))
        ).to.be.reverted
      })
    })
  })

  describe("decreaseBalanceAllowance", () => {
    const approvedAmount = toSatoshis(99)

    let owner: SignerWithAddress
    let spender: string

    before(async () => {
      await createSnapshot()

      const accounts = await getUnnamedAccounts()
      owner = await ethers.getSigner(accounts[0])
      // eslint-disable-next-line prefer-destructuring
      spender = accounts[1]
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the spender is the zero address", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(owner)
            .decreaseBalanceAllowance(ZERO_ADDRESS, toSatoshis(1))
        ).to.be.revertedWith("Can not decrease balance allowance below zero")
      })
    })

    context("when the spender had no approved balance before", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(owner).decreaseBalanceAllowance(spender, toSatoshis(1))
        ).to.be.revertedWith("Can not decrease balance allowance below zero")
      })
    })

    context("when the spender had an approved balance before", () => {
      const decreaseBy = toSatoshis(3)

      before(async () => {
        await createSnapshot()

        await bank.connect(owner).approveBalance(spender, approvedAmount)
        await bank.connect(owner).decreaseBalanceAllowance(spender, decreaseBy)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should decrease the previous allowance", async () => {
        expect(await bank.allowance(owner.address, spender)).to.equal(
          approvedAmount.sub(decreaseBy)
        )
      })
    })
  })

  describe("transferBalanceFrom", () => {
    const initialBalance = toSatoshis(500)
    const approvedBalance = toSatoshis(45)

    let owner: SignerWithAddress
    let spender: SignerWithAddress
    let recipient: string

    before(async () => {
      await createSnapshot()

      const accounts = await getUnnamedAccounts()
      owner = await ethers.getSigner(accounts[0])
      spender = await ethers.getSigner(accounts[1])
      // eslint-disable-next-line prefer-destructuring
      recipient = accounts[2]

      await bank.connect(bridge).increaseBalance(owner.address, initialBalance)
      await bank.connect(owner).approveBalance(spender.address, approvedBalance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the recipient is the zero address", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(spender)
            .transferBalanceFrom(owner.address, ZERO_ADDRESS, approvedBalance)
        ).to.be.revertedWith("Can not transfer to the zero address")
      })
    })

    context("when the recipient is the bank address", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(spender)
            .transferBalanceFrom(owner.address, bank.address, approvedBalance)
        ).to.be.revertedWith("Can not transfer to the Bank address")
      })
    })

    context("when the spender has not enough balance approved", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(spender)
            .transferBalanceFrom(
              owner.address,
              recipient,
              approvedBalance.add(1)
            )
        ).to.be.revertedWith("Transfer amount exceeds allowance")
      })
    })

    context("when the owner has not enough balance", () => {
      const amount = initialBalance.add(1)

      before(async () => {
        await createSnapshot()
        // the initial approval was done in the `before` setup for
        // `transferBalanceFrom`'s describe; we need to set back to 0
        // before approving again
        await bank.connect(owner).approveBalance(spender.address, 0)
        await bank.connect(owner).approveBalance(spender.address, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bank
            .connect(spender)
            .transferBalanceFrom(owner.address, recipient, amount)
        ).to.be.revertedWith("Transfer amount exceeds balance")
      })
    })

    context("when the spender transfers part of the approved balance", () => {
      const amount = toSatoshis(2)
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await bank
          .connect(spender)
          .transferBalanceFrom(owner.address, recipient, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer the requested amount", async () => {
        expect(await bank.balanceOf(owner.address)).to.equal(
          initialBalance.sub(amount)
        )
        expect(await bank.balanceOf(recipient)).to.equal(amount)
      })

      it("should emit the BalanceTransferred event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceTransferred")
          .withArgs(owner.address, recipient, amount)
      })

      it("should reduce the spender allowance", async () => {
        expect(await bank.allowance(owner.address, spender.address)).to.equal(
          approvedBalance.sub(amount)
        )
      })
    })

    context(
      "when the spender transfers part of the approved balance in two transactions",
      () => {
        const amount1 = toSatoshis(1)
        const amount2 = toSatoshis(3)

        let tx1: ContractTransaction
        let tx2: ContractTransaction

        before(async () => {
          await createSnapshot()
          tx1 = await bank
            .connect(spender)
            .transferBalanceFrom(owner.address, recipient, amount1)
          tx2 = await bank
            .connect(spender)
            .transferBalanceFrom(owner.address, recipient, amount2)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer the requested amount", async () => {
          expect(await bank.balanceOf(owner.address)).to.equal(
            initialBalance.sub(amount1).sub(amount2)
          )
          expect(await bank.balanceOf(recipient)).to.equal(amount1.add(amount2))
        })

        it("should emit BalanceTransferred events", async () => {
          await expect(tx1)
            .to.emit(bank, "BalanceTransferred")
            .withArgs(owner.address, recipient, amount1)
          await expect(tx2)
            .to.emit(bank, "BalanceTransferred")
            .withArgs(owner.address, recipient, amount2)
        })

        it("should reduce the spender allowance", async () => {
          expect(await bank.allowance(owner.address, spender.address)).to.equal(
            approvedBalance.sub(amount1).sub(amount2)
          )
        })
      }
    )

    context(
      "when the spender transfers the entire approved balance",
      async () => {
        const amount = approvedBalance

        before(async () => {
          await createSnapshot()
          await bank
            .connect(spender)
            .transferBalanceFrom(owner.address, recipient, amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should transfer the requested amount", async () => {
          expect(await bank.balanceOf(owner.address)).to.equal(
            initialBalance.sub(amount)
          )
          expect(await bank.balanceOf(recipient)).to.equal(amount)
        })

        it("should reduce the spender allowance to zero", async () => {
          expect(await bank.allowance(owner.address, spender.address)).to.equal(
            0
          )
        })
      }
    )

    context("when the spender transfers the entire balance", async () => {
      const amount = initialBalance

      before(async () => {
        await createSnapshot()
        // the initial approval was done in the `before` setup for
        // `transferBalanceFrom`'s describe; we need to set back to 0
        // before approving again
        await bank.connect(owner).approveBalance(spender.address, 0)
        await bank.connect(owner).approveBalance(spender.address, amount)
        await bank
          .connect(spender)
          .transferBalanceFrom(owner.address, recipient, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer the requested amount", async () => {
        expect(await bank.balanceOf(owner.address)).to.equal(0)
        expect(await bank.balanceOf(recipient)).to.equal(amount)
      })

      it("should reduce the spender allowance to zero", async () => {
        expect(await bank.allowance(owner.address, spender.address)).to.equal(0)
      })
    })

    context("when given the maximum allowance", () => {
      const allowance = MAX_UINT256
      const amount = toSatoshis(21)

      before(async () => {
        await createSnapshot()
        // the initial approval was done in the `before` setup for
        // `transferBalanceFrom`'s describe; we need to set back to 0
        // before approving again
        await bank.connect(owner).approveBalance(spender.address, 0)
        await bank.connect(owner).approveBalance(spender.address, allowance)
        await bank
          .connect(spender)
          .transferBalanceFrom(owner.address, recipient, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not reduce the spender allowance", async () => {
        expect(await bank.allowance(owner.address, spender.address)).to.equal(
          allowance
        )
      })
    })
  })

  describe("permit", () => {
    const initialBalance = toSatoshis(1231)
    const permittedBalance = toSatoshis(45)

    let owner: Wallet
    let spender: string

    let yesterday: number
    let tomorrow: number

    before(async () => {
      await createSnapshot()

      owner = ethers.Wallet.createRandom()
      await bank.connect(bridge).increaseBalance(owner.address, initialBalance)

      const accounts = await getUnnamedAccounts()
      // eslint-disable-next-line prefer-destructuring
      spender = accounts[1]

      const lastBlockTimestamp = await helpers.time.lastBlockTime()
      yesterday = lastBlockTimestamp - 86400 // -1 day
      tomorrow = lastBlockTimestamp + 86400 // +1 day
    })

    after(async () => {
      await restoreSnapshot()
    })

    const getApproval = async (amount, spenderAddress, deadline) => {
      // We use ethers.utils.SigningKey for a Wallet instead of
      // Signer.signMessage to do not add '\x19Ethereum Signed Message:\n'
      // prefix to the signed message. The '\x19` protection (see EIP191 for
      // more details on '\x19' rationale and format) is already included in
      // EIP2612 permit signed message and '\x19Ethereum Signed Message:\n'
      // should not be used there.
      const signingKey = new ethers.utils.SigningKey(owner.privateKey)

      const domainSeparator = await bank.DOMAIN_SEPARATOR()
      const permitTypehash = await bank.PERMIT_TYPEHASH()
      const nonce = await bank.nonces(owner.address)

      const approvalDigest = ethers.utils.keccak256(
        ethers.utils.solidityPack(
          ["bytes1", "bytes1", "bytes32", "bytes32"],
          [
            "0x19",
            "0x01",
            domainSeparator,
            ethers.utils.keccak256(
              ethers.utils.defaultAbiCoder.encode(
                [
                  "bytes32",
                  "address",
                  "address",
                  "uint256",
                  "uint256",
                  "uint256",
                ],
                [
                  permitTypehash,
                  owner.address,
                  spenderAddress,
                  amount,
                  nonce,
                  deadline,
                ]
              )
            ),
          ]
        )
      )

      return ethers.utils.splitSignature(signingKey.signDigest(approvalDigest))
    }

    context("when permission expired", () => {
      it("should revert", async () => {
        const deadline = yesterday
        const signature = await getApproval(permittedBalance, spender, deadline)

        await expect(
          bank
            .connect(thirdParty)
            .permit(
              owner.address,
              spender,
              permittedBalance,
              deadline,
              signature.v,
              signature.r,
              signature.s
            )
        ).to.be.revertedWith("Permission expired")
      })
    })

    context("when permission has an invalid signature", () => {
      context("when owner does not match the permitting one", () => {
        it("should revert", async () => {
          const deadline = tomorrow
          const signature = await getApproval(
            permittedBalance,
            spender,
            deadline
          )

          await expect(
            bank.connect(thirdParty).permit(
              thirdParty.address, // does not match the signature
              spender,
              permittedBalance,
              deadline,
              signature.v,
              signature.r,
              signature.s
            )
          ).to.be.revertedWith("Invalid signature")
        })
      })

      context("when spender does not match the signature", () => {
        it("should revert", async () => {
          const deadline = tomorrow
          const signature = await getApproval(
            permittedBalance,
            spender,
            deadline
          )

          await expect(
            bank.connect(thirdParty).permit(
              owner.address,
              thirdParty.address, // does not match the signature
              permittedBalance,
              deadline,
              signature.v,
              signature.r,
              signature.s
            )
          ).to.be.revertedWith("Invalid signature")
        })
      })

      context("when permitted balance does not match the signature", () => {
        it("should revert", async () => {
          const deadline = tomorrow
          const signature = await getApproval(
            permittedBalance,
            spender,
            deadline
          )

          await expect(
            bank.connect(thirdParty).permit(
              owner.address,
              spender,
              permittedBalance.add(1), // does not match the signature
              deadline,
              signature.v,
              signature.r,
              signature.s
            )
          ).to.be.revertedWith("Invalid signature")
        })
      })

      context("when permitted deadline does not match the signature", () => {
        it("should revert", async () => {
          const deadline = tomorrow
          const signature = await getApproval(
            permittedBalance,
            spender,
            deadline
          )

          await expect(
            bank.connect(thirdParty).permit(
              owner.address,
              spender,
              permittedBalance,
              deadline + 1, // does not match the signature
              signature.v,
              signature.r,
              signature.s
            )
          ).to.be.revertedWith("Invalid signature")
        })
      })
    })

    context("when the spender is the zero address", () => {
      it("should revert", async () => {
        const deadline = tomorrow
        const signature = await getApproval(
          permittedBalance,
          ZERO_ADDRESS,
          deadline
        )

        await expect(
          bank
            .connect(thirdParty)
            .permit(
              owner.address,
              ZERO_ADDRESS,
              permittedBalance,
              deadline,
              signature.v,
              signature.r,
              signature.s
            )
        ).to.be.revertedWith("Can not approve to the zero address")
      })
    })

    context("when the spender had no permitted balance before", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        const deadline = tomorrow
        const signature = await getApproval(permittedBalance, spender, deadline)

        tx = await bank
          .connect(thirdParty)
          .permit(
            owner.address,
            spender,
            permittedBalance,
            deadline,
            signature.v,
            signature.r,
            signature.s
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should approve the requested amount", async () => {
        expect(await bank.allowance(owner.address, spender)).to.equal(
          permittedBalance
        )
      })

      it("should emit the BalanceApproved event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceApproved")
          .withArgs(owner.address, spender, permittedBalance)
      })

      it("should increment the nonce for the permitting owner", async () => {
        expect(await bank.nonces(owner.address)).to.equal(1)
        expect(await bank.nonces(spender)).to.equal(0)
      })
    })

    context("when the spender had a permitted balance before", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        const deadline = tomorrow

        let signature = await getApproval(toSatoshis(1337), spender, deadline)
        await bank
          .connect(thirdParty)
          .permit(
            owner.address,
            spender,
            toSatoshis(1337),
            deadline,
            signature.v,
            signature.r,
            signature.s
          )

        signature = await getApproval(permittedBalance, spender, deadline)
        tx = await bank
          .connect(thirdParty)
          .permit(
            owner.address,
            spender,
            permittedBalance,
            deadline,
            signature.v,
            signature.r,
            signature.s
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should replace the previous approval", async () => {
        expect(await bank.allowance(owner.address, spender)).to.equal(
          permittedBalance
        )
      })

      it("should emit the BalanceApproved event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceApproved")
          .withArgs(owner.address, spender, permittedBalance)
      })

      it("should increment the nonce for the permitting owner", async () => {
        expect(await bank.nonces(owner.address)).to.equal(2)
        expect(await bank.nonces(spender)).to.equal(0)
      })
    })

    context("when given never expiring permit", () => {
      const deadline = MAX_UINT256
      let signature: Signature

      before(async () => {
        await createSnapshot()

        signature = await getApproval(permittedBalance, spender, deadline)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should be accepted at any moment", async () => {
        await helpers.time.increaseTime(63113904) // +2 years

        await bank
          .connect(thirdParty)
          .permit(
            owner.address,
            spender,
            permittedBalance,
            deadline,
            signature.v,
            signature.r,
            signature.s
          )

        expect(await bank.allowance(owner.address, spender)).to.equal(
          permittedBalance
        )
      })
    })
  })

  describe("increaseBalance", () => {
    const amount = toSatoshis(10)
    let recipient: string

    before(async () => {
      await createSnapshot()
      recipient = thirdParty.address
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          bank.connect(thirdParty).increaseBalance(recipient, amount)
        ).to.be.revertedWith("Caller is not the bridge")
      })
    })

    context("when called by the bridge", () => {
      context("when increasing balance for the Bank", () => {
        it("should revert", async () => {
          await expect(
            bank.connect(bridge).increaseBalance(bank.address, amount)
          ).to.be.revertedWith("Can not increase balance for Bank")
        })
      })

      context("when called for a valid recipient", () => {
        let tx

        before(async () => {
          await createSnapshot()
          tx = await bank.connect(bridge).increaseBalance(recipient, amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should increase recipient's balance", async () => {
          expect(await bank.balanceOf(recipient)).to.equal(amount)
        })

        it("should emit the BalanceIncreased event", async () => {
          await expect(tx)
            .to.emit(bank, "BalanceIncreased")
            .withArgs(recipient, amount)
        })
      })
    })
  })

  describe("increaseBalances", () => {
    const amount1 = toSatoshis(12)
    const amount2 = toSatoshis(15)
    const amount3 = toSatoshis(17)

    let recipient1: string
    let recipient2: string
    let recipient3: string

    before(async () => {
      await createSnapshot()
      ;[recipient1, recipient2, recipient3] = await getUnnamedAccounts()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(thirdParty)
            .increaseBalances(
              [recipient1, recipient2, recipient3],
              [amount1, amount2, amount3]
            )
        ).to.be.revertedWith("Caller is not the bridge")
      })
    })

    context("when called by the bridge", () => {
      context("when increasing balance for the bank", () => {
        it("should revert", async () => {
          await expect(
            bank
              .connect(bridge)
              .increaseBalances(
                [recipient1, bank.address, recipient3],
                [amount1, amount2, amount3]
              )
          ).to.be.revertedWith("Can not increase balance for Bank")
        })
      })

      context("when there is more recipients than amounts", () => {
        it("should revert", async () => {
          await expect(
            bank
              .connect(bridge)
              .increaseBalances([recipient1, recipient2], [amount1])
          ).to.be.revertedWith("Arrays must have the same length")
        })
      })

      context("when there is more amounts than recipients", () => {
        it("should revert", async () => {
          await expect(
            bank
              .connect(bridge)
              .increaseBalances(
                [recipient1, recipient2],
                [amount1, amount2, amount3]
              )
          ).to.be.revertedWith("Arrays must have the same length")
        })
      })

      context("when called for a valid recipient", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          tx = await bank
            .connect(bridge)
            .increaseBalances(
              [recipient1, recipient2, recipient3],
              [amount1, amount2, amount3]
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should increase recipients' balances", async () => {
          expect(await bank.balanceOf(recipient1)).to.equal(amount1)
          expect(await bank.balanceOf(recipient2)).to.equal(amount2)
          expect(await bank.balanceOf(recipient3)).to.equal(amount3)
        })

        it("should emit BalanceIncreased events", async () => {
          await expect(tx)
            .to.emit(bank, "BalanceIncreased")
            .withArgs(recipient1, amount1)
          await expect(tx)
            .to.emit(bank, "BalanceIncreased")
            .withArgs(recipient2, amount2)
          await expect(tx)
            .to.emit(bank, "BalanceIncreased")
            .withArgs(recipient3, amount3)
        })
      })
    })
  })

  describe("increaseBalanceAndCall", () => {
    const depositor1 = "0x30c371E0651B2Ff6062158ca1D95b07C7531c719"
    const depositor2 = "0xb3464806d680722dBc678996F1670D19A42eA3e9"

    const depositedAmount1 = toSatoshis(19)
    const depositedAmount2 = toSatoshis(11)
    const totalDepositedAmount = toSatoshis(30) // 19 + 11

    let vault
    let tbtc

    before(async () => {
      await createSnapshot()

      const TBTC = await ethers.getContractFactory("TBTC")
      tbtc = await TBTC.deploy()
      await tbtc.deployed()

      const Vault = await ethers.getContractFactory("TBTCVault")
      vault = await Vault.deploy(bank.address, tbtc.address, bridge.address)
      await vault.deployed()

      await tbtc.connect(deployer).transferOwnership(vault.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          bank
            .connect(thirdParty)
            .increaseBalanceAndCall(
              vault.address,
              [depositor1, depositor2],
              [depositedAmount1, depositedAmount2]
            )
        ).to.be.revertedWith("Caller is not the bridge")
      })
    })

    context("when called by the bridge", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await bank
          .connect(bridge)
          .increaseBalanceAndCall(
            vault.address,
            [depositor1, depositor2],
            [depositedAmount1, depositedAmount2]
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context(
        "when depositors array has greater length than deposited amounts array",
        () => {
          it("should revert", async () => {
            await expect(
              bank
                .connect(bridge)
                .increaseBalanceAndCall(
                  vault.address,
                  [depositor1, depositor2],
                  [depositedAmount1]
                )
            ).to.be.revertedWith("Arrays must have the same length")
          })
        }
      )

      context(
        "when deposited amounts array has greater length than depositors array",
        () => {
          it("should revert", async () => {
            await expect(
              bank
                .connect(bridge)
                .increaseBalanceAndCall(
                  vault.address,
                  [depositor1],
                  [depositedAmount1, depositedAmount2]
                )
            ).to.be.revertedWith("Arrays must have the same length")
          })
        }
      )

      it("should increase vault's balance", async () => {
        expect(await bank.balanceOf(vault.address)).to.equal(
          totalDepositedAmount
        )
      })

      it("should emit BalanceIncreased event", async () => {
        await expect(tx)
          .to.emit(bank, "BalanceIncreased")
          .withArgs(vault.address, totalDepositedAmount)
      })

      it("should call the vault", async () => {
        expect(await tbtc.balanceOf(depositor1)).to.equal(to1e18(19))
        expect(await tbtc.balanceOf(depositor2)).to.equal(to1e18(11))
        expect(await tbtc.totalSupply()).to.equal(to1e18(30)) // 19 + 11
      })
    })
  })

  describe("decreaseBalance", () => {
    const initialBalance = toSatoshis(21)
    const amount = toSatoshis(10)

    let tx: ContractTransaction

    before(async () => {
      await createSnapshot()
      // first increase so that there is something to decrease from
      await bank
        .connect(bridge)
        .increaseBalance(thirdParty.address, initialBalance)

      tx = await bank.connect(thirdParty).decreaseBalance(amount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should decrease caller's balance", async () => {
      expect(await bank.balanceOf(thirdParty.address)).to.equal(
        initialBalance.sub(amount)
      )
    })

    it("should emit the BalanceDecreased event", async () => {
      await expect(tx)
        .to.emit(bank, "BalanceDecreased")
        .withArgs(thirdParty.address, amount)
    })
  })

  describe("DOMAIN_SEPARATOR", () => {
    it("should be keccak256 of EIP712 domain struct", async () => {
      const { keccak256 } = ethers.utils
      const { defaultAbiCoder } = ethers.utils
      const { toUtf8Bytes } = ethers.utils

      const expected = keccak256(
        defaultAbiCoder.encode(
          ["bytes32", "bytes32", "bytes32", "uint256", "address"],
          [
            keccak256(
              toUtf8Bytes(
                "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
              )
            ),
            keccak256(toUtf8Bytes("TBTC Bank")),
            keccak256(toUtf8Bytes("1")),
            hardhatNetworkId,
            bank.address,
          ]
        )
      )
      expect(await bank.DOMAIN_SEPARATOR()).to.equal(expected)
    })
  })
})
