import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { randomBytes } from "crypto"
import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { expect } from "chai"
import { ContractTransaction, Wallet } from "ethers"
import { to1e18 } from "../helpers/contract-test-helpers"

import type { L2TBTC, TestERC20, TestERC721 } from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const ZERO_ADDRESS = ethers.constants.AddressZero

// Only the functions defined in L2TBTC are fully covered with tests.
// L2TBTC contract inherits from OpenZeppelin contracts and we do not want
// to test the framework. The basic tests for functions defined in the
// OpenZeppelin contracts ensure all expected OpenZeppelin extensions are
// inherited in L2TBTC contract and that they are properly initialized.
describe("L2TBTC", () => {
  const fixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const accounts = await getUnnamedAccounts()
    const minter = await ethers.getSigner(accounts[1])
    const guardian = await ethers.getSigner(accounts[2])
    const thirdParty = await ethers.getSigner(accounts[3])
    const tokenHolder = await ethers.getSigner(accounts[4])

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `L2TBTC_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2TBTC",
        initializerArgs: ["Arbitrum TBTC", "ArbTBTC"],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    token = deployment[0] as L2TBTC

    await token.connect(deployer).transferOwnership(governance.address)

    return {
      governance,
      minter,
      guardian,
      thirdParty,
      tokenHolder,
      token,
    }
  }

  // default Hardhat's networks blockchain, see https://hardhat.org/config/
  const hardhatNetworkId = 31337

  let token: L2TBTC

  let governance: SignerWithAddress
  let minter: SignerWithAddress
  let guardian: SignerWithAddress
  let thirdParty: SignerWithAddress
  let tokenHolder: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, minter, guardian, thirdParty, tokenHolder, token } =
      await waffle.loadFixture(fixture))
  })

  describe("addMinter", () => {
    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          token.connect(thirdParty).addMinter(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when address is a new minter", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await token.connect(governance).addMinter(minter.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should add address as a minter", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await token.isMinter(minter.address)).to.be.true
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(token, "MinterAdded")
            .withArgs(minter.address)
        })
      })

      context("when address is already a minter", () => {
        before(async () => {
          await createSnapshot()

          await token.connect(governance).addMinter(minter.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            token.connect(governance).addMinter(minter.address)
          ).to.be.revertedWith("This address is already a minter")
        })
      })

      context("when there are multiple minters", () => {
        const minters = [
          "0x54DeA8194aaF652Cd296B162A2809dd95529f775",
          "0x575E6d8802e7b6A7E8F940640804385D8Bbe2ce0",
          "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
        ]

        before(async () => {
          await createSnapshot()

          await token.connect(governance).addMinter(minters[0])
          await token.connect(governance).addMinter(minters[1])
          await token.connect(governance).addMinter(minters[2])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should add them into the list", async () => {
          expect(await token.getMinters()).to.deep.equal(minters)
        })
      })
    })
  })

  describe("removeMinter", () => {
    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          token.connect(thirdParty).removeMinter(minter.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when address is not a minter", () => {
        it("should revert", async () => {
          await expect(
            token.connect(governance).removeMinter(thirdParty.address)
          ).to.be.revertedWith("This address is not a minter")
        })
      })

      context("when a minter address is removed", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await token.connect(governance).addMinter(minter.address)
          tx = await token.connect(governance).removeMinter(minter.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should take minter role from the address", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await token.isMinter(minter.address)).to.be.false
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await token.getMinters()).is.empty
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(token, "MinterRemoved")
            .withArgs(minter.address)
        })
      })

      context("when there are multiple minters", () => {
        const minters = [
          "0x54DeA8194aaF652Cd296B162A2809dd95529f775",
          "0x575E6d8802e7b6A7E8F940640804385D8Bbe2ce0",
          "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
          "0xF844A3a4dA34fDDf51A0Ec7A0a89d1ed5A105e40",
        ]

        before(async () => {
          await createSnapshot()

          await token.connect(governance).addMinter(minters[0])
          await token.connect(governance).addMinter(minters[1])
          await token.connect(governance).addMinter(minters[2])
          await token.connect(governance).addMinter(minters[3])
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when deleting the first minter", () => {
          before(async () => {
            await createSnapshot()
            await token.connect(governance).removeMinter(minters[0])
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the minters list", async () => {
            expect(await token.getMinters()).to.deep.equal([
              "0xF844A3a4dA34fDDf51A0Ec7A0a89d1ed5A105e40",
              "0x575E6d8802e7b6A7E8F940640804385D8Bbe2ce0",
              "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
            ])
          })
        })

        context("when deleting the last minter", () => {
          before(async () => {
            await createSnapshot()
            await token.connect(governance).removeMinter(minters[3])
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the minters list", async () => {
            expect(await token.getMinters()).to.deep.equal([
              "0x54DeA8194aaF652Cd296B162A2809dd95529f775",
              "0x575E6d8802e7b6A7E8F940640804385D8Bbe2ce0",
              "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
            ])
          })
        })

        context("when deleting minter from the middle of the list", () => {
          before(async () => {
            await createSnapshot()
            await token.connect(governance).removeMinter(minters[1])
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the minters list", async () => {
            expect(await token.getMinters()).to.deep.equal([
              "0x54DeA8194aaF652Cd296B162A2809dd95529f775",
              "0xF844A3a4dA34fDDf51A0Ec7A0a89d1ed5A105e40",
              "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
            ])
          })
        })
      })
    })
  })

  describe("addGuardian", () => {
    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          token.connect(thirdParty).addGuardian(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when address is a new guardian", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await token.connect(governance).addGuardian(guardian.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should add address as a guardian", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await token.isGuardian(guardian.address)).to.be.true
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(token, "GuardianAdded")
            .withArgs(guardian.address)
        })
      })

      context("when address is already a guardian", () => {
        before(async () => {
          await createSnapshot()

          await token.connect(governance).addGuardian(guardian.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            token.connect(governance).addGuardian(guardian.address)
          ).to.be.revertedWith("This address is already a guardian")
        })
      })

      context("when there are multiple guardians", () => {
        const guardians = [
          "0x54DeA8194aaF652Cd296B162A2809dd95529f775",
          "0x575E6d8802e7b6A7E8F940640804385D8Bbe2ce0",
          "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
        ]

        before(async () => {
          await createSnapshot()

          await token.connect(governance).addGuardian(guardians[0])
          await token.connect(governance).addGuardian(guardians[1])
          await token.connect(governance).addGuardian(guardians[2])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should add them into the list", async () => {
          expect(await token.getGuardians()).to.deep.equal(guardians)
        })
      })
    })
  })

  describe("removeGuardian", () => {
    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          token.connect(thirdParty).removeGuardian(guardian.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      context("when address is not a guardian", () => {
        it("should revert", async () => {
          await expect(
            token.connect(governance).removeGuardian(thirdParty.address)
          ).to.be.revertedWith("This address is not a guardian")
        })
      })

      context("when a guardian address is removed", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await token.connect(governance).addGuardian(guardian.address)
          tx = await token.connect(governance).removeGuardian(guardian.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should take guardian role from the address", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await token.isGuardian(guardian.address)).to.be.false
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await token.getGuardians()).to.be.empty
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(token, "GuardianRemoved")
            .withArgs(guardian.address)
        })
      })

      context("when there are multiple guardians", () => {
        const guardians = [
          "0x54DeA8194aaF652Cd296B162A2809dd95529f775",
          "0x575E6d8802e7b6A7E8F940640804385D8Bbe2ce0",
          "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
          "0xF844A3a4dA34fDDf51A0Ec7A0a89d1ed5A105e40",
        ]

        before(async () => {
          await createSnapshot()

          await token.connect(governance).addGuardian(guardians[0])
          await token.connect(governance).addGuardian(guardians[1])
          await token.connect(governance).addGuardian(guardians[2])
          await token.connect(governance).addGuardian(guardians[3])
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when deleting the first guardian", () => {
          before(async () => {
            await createSnapshot()
            await token.connect(governance).removeGuardian(guardians[0])
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the guardians list", async () => {
            expect(await token.getGuardians()).to.deep.equal([
              "0xF844A3a4dA34fDDf51A0Ec7A0a89d1ed5A105e40",
              "0x575E6d8802e7b6A7E8F940640804385D8Bbe2ce0",
              "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
            ])
          })
        })

        context("when deleting the last guardian", () => {
          before(async () => {
            await createSnapshot()
            await token.connect(governance).removeGuardian(guardians[3])
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the guardians list", async () => {
            expect(await token.getGuardians()).to.deep.equal([
              "0x54DeA8194aaF652Cd296B162A2809dd95529f775",
              "0x575E6d8802e7b6A7E8F940640804385D8Bbe2ce0",
              "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
            ])
          })
        })

        context("when deleting guardian from the middle of the list", () => {
          before(async () => {
            await createSnapshot()
            await token.connect(governance).removeGuardian(guardians[1])
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the guardians list", async () => {
            expect(await token.getGuardians()).to.deep.equal([
              "0x54DeA8194aaF652Cd296B162A2809dd95529f775",
              "0xF844A3a4dA34fDDf51A0Ec7A0a89d1ed5A105e40",
              "0x66ac131D339704902aECCaBDf55e15daAE8B238f",
            ])
          })
        })
      })
    })
  })

  describe("recoverERC20", () => {
    const amount = to1e18(725)

    let randomERC20: TestERC20

    before(async () => {
      await createSnapshot()

      const TestERC20 = await ethers.getContractFactory("TestERC20")
      randomERC20 = await TestERC20.deploy()
      await randomERC20.deployed()

      await randomERC20.mint(token.address, amount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          token
            .connect(thirdParty)
            .recoverERC20(randomERC20.address, thirdParty.address, amount)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the contract owner", () => {
      before(async () => {
        await createSnapshot()

        await token
          .connect(governance)
          .recoverERC20(randomERC20.address, thirdParty.address, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer tokens to the recipient", async () => {
        expect(await randomERC20.balanceOf(thirdParty.address)).to.equal(amount)
      })
    })
  })

  describe("recoverERC721", () => {
    const tokenId = 19112

    let randomERC721: TestERC721

    before(async () => {
      await createSnapshot()

      const TestERC721 = await ethers.getContractFactory("TestERC721")
      randomERC721 = await TestERC721.deploy()
      await randomERC721.deployed()

      await randomERC721.mint(token.address, tokenId)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(
          token
            .connect(thirdParty)
            .recoverERC721(
              randomERC721.address,
              thirdParty.address,
              tokenId,
              []
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      before(async () => {
        await createSnapshot()

        await token
          .connect(governance)
          .recoverERC721(randomERC721.address, thirdParty.address, tokenId, [])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("transfers token to the recipient", async () => {
        expect(await randomERC721.ownerOf(tokenId)).to.equal(thirdParty.address)
      })
    })
  })

  describe("pause", () => {
    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)
      await token.connect(governance).addGuardian(guardian.address)

      await token.connect(minter).mint(tokenHolder.address, to1e18(10))
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by a guardian", () => {
      it("should revert", async () => {
        await expect(token.connect(thirdParty).pause()).to.be.revertedWith(
          "Caller is not a guardian"
        )
        await expect(token.connect(minter).pause()).to.be.revertedWith(
          "Caller is not a guardian"
        )
        await expect(token.connect(governance).pause()).to.be.revertedWith(
          "Caller is not a guardian"
        )
      })
    })

    context("when called by a guardian", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await token.connect(guardian).pause()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit Paused event", async () => {
        await expect(tx).to.emit(token, "Paused").withArgs(guardian.address)
      })

      it("should pause mint functionality", async () => {
        await expect(
          token.connect(minter).mint(thirdParty.address, to1e18(1))
        ).to.be.revertedWith("Pausable: paused")
      })

      it("should pause burn functionality", async () => {
        await expect(
          token.connect(tokenHolder).burn(to1e18(1))
        ).to.be.revertedWith("Pausable: paused")
      })

      it("should pause burnFrom functionality", async () => {
        await expect(
          token.connect(thirdParty).burnFrom(tokenHolder.address, to1e18(1))
        ).to.be.revertedWith("Pausable: paused")
      })

      it("should not pause transfers", async () => {
        await expect(
          token.connect(tokenHolder).transfer(thirdParty.address, to1e18(1))
        ).to.not.be.reverted
      })
    })
  })

  describe("unpause", () => {
    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)
      await token.connect(governance).addGuardian(guardian.address)

      await token.connect(minter).mint(tokenHolder.address, to1e18(10))
      await token.connect(tokenHolder).approve(thirdParty.address, to1e18(10))

      await token.connect(guardian).pause()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by the owner", () => {
      it("should revert", async () => {
        await expect(token.connect(thirdParty).unpause()).to.be.revertedWith(
          "Ownable: caller is not the owner"
        )
        await expect(token.connect(minter).unpause()).to.be.revertedWith(
          "Ownable: caller is not the owner"
        )
        await expect(token.connect(guardian).unpause()).to.be.revertedWith(
          "Ownable: caller is not the owner"
        )
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await token.connect(governance).unpause()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit Unpaused event", async () => {
        await expect(tx).to.emit(token, "Unpaused").withArgs(governance.address)
      })

      it("should unpause mint functionality", async () => {
        await expect(token.connect(minter).mint(thirdParty.address, to1e18(1)))
          .to.not.be.reverted
      })

      it("should unpause burn functionality", async () => {
        await expect(token.connect(tokenHolder).burn(to1e18(1))).to.not.be
          .reverted
      })

      it("should unpause burnFrom functionality", async () => {
        await expect(
          token.connect(thirdParty).burnFrom(tokenHolder.address, to1e18(1))
        ).to.not.be.reverted
      })
    })
  })

  describe("mint", () => {
    const amount = to1e18(50)

    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called not by a minter", () => {
      it("should revert", async () => {
        await expect(
          token.connect(thirdParty).mint(thirdParty.address, amount)
        ).to.be.revertedWith("Caller is not a minter")
      })
    })

    context("when called by a minter", () => {
      context("for a zero account", () => {
        it("should revert", async () => {
          await expect(
            token.connect(minter).mint(ZERO_ADDRESS, amount)
          ).to.be.revertedWith("ERC20: mint to the zero address")
        })
      })

      context("for a non-zero account", () => {
        let mintTx: ContractTransaction

        before(async () => {
          await createSnapshot()
          mintTx = await token.connect(minter).mint(tokenHolder.address, amount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should increment totalSupply", async () => {
          expect(await token.totalSupply()).to.equal(amount)
        })

        it("should increment recipient balance", async () => {
          expect(await token.balanceOf(tokenHolder.address)).to.equal(amount)
        })

        it("should emit Transfer event", async () => {
          await expect(mintTx)
            .to.emit(token, "Transfer")
            .withArgs(ZERO_ADDRESS, tokenHolder.address, amount)
        })
      })
    })
  })

  //
  // The tests below are just very basic tests for ERC20 functionality.
  // L2TBTC contract inherits from OpenZeppelin contracts and we do not want
  // to test the framework. The basic tests ensure all expected OpenZeppelin
  // extensions are inherited in L2TBTC contract and that they are properly
  // initialized.
  //

  it("should have a name", async () => {
    expect(await token.name()).to.equal("Arbitrum TBTC")
  })

  it("should have a symbol", async () => {
    expect(await token.symbol()).to.equal("ArbTBTC")
  })

  it("should have 18 decimals", async () => {
    expect(await token.decimals()).to.equal(18)
  })

  describe("totalSupply", () => {
    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)

      await token.connect(minter).mint(thirdParty.address, to1e18(1))
      await token.connect(minter).mint(tokenHolder.address, to1e18(3))
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should return the total amount of tokens", async () => {
      expect(await token.totalSupply()).to.equal(to1e18(4)) // 1+3
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
            keccak256(toUtf8Bytes("Arbitrum TBTC")),
            keccak256(toUtf8Bytes("1")),
            hardhatNetworkId,
            token.address,
          ]
        )
      )
      expect(await token.DOMAIN_SEPARATOR()).to.equal(expected)
    })
  })

  describe("balanceOf", () => {
    const balance = to1e18(7)

    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)
      await token.connect(minter).mint(tokenHolder.address, balance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should return the total amount of tokens", async () => {
      expect(await token.balanceOf(tokenHolder.address)).to.equal(balance)
    })
  })

  describe("transfer", () => {
    const initialHolderBalance = to1e18(70)
    const transferAmount = to1e18(5)
    let tx: ContractTransaction

    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)
      await token
        .connect(minter)
        .mint(tokenHolder.address, initialHolderBalance)

      tx = await token
        .connect(tokenHolder)
        .transfer(thirdParty.address, transferAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should transfer the requested amount", async () => {
      expect(await token.balanceOf(tokenHolder.address)).to.equal(
        initialHolderBalance.sub(transferAmount)
      )

      expect(await token.balanceOf(thirdParty.address)).to.equal(transferAmount)
    })

    it("should emit a transfer event", async () => {
      await expect(tx)
        .to.emit(token, "Transfer")
        .withArgs(tokenHolder.address, thirdParty.address, transferAmount)
    })
  })

  describe("transferFrom", () => {
    const initialHolderBalance = to1e18(70)
    const transferAmount = to1e18(9)
    let tx: ContractTransaction

    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)
      await token
        .connect(minter)
        .mint(tokenHolder.address, initialHolderBalance)

      await token
        .connect(tokenHolder)
        .approve(thirdParty.address, transferAmount)
      tx = await token
        .connect(thirdParty)
        .transferFrom(tokenHolder.address, thirdParty.address, transferAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should transfer the requested amount", async () => {
      expect(await token.balanceOf(tokenHolder.address)).to.equal(
        initialHolderBalance.sub(transferAmount)
      )

      expect(await token.balanceOf(thirdParty.address)).to.equal(transferAmount)
    })

    it("should emit a transfer event", async () => {
      await expect(tx)
        .to.emit(token, "Transfer")
        .withArgs(tokenHolder.address, thirdParty.address, transferAmount)
    })
  })

  describe("approve", () => {
    let tx: ContractTransaction
    const allowance = to1e18(888)

    before(async () => {
      await createSnapshot()

      tx = await token
        .connect(tokenHolder)
        .approve(thirdParty.address, allowance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should approve the requested amount", async () => {
      expect(
        await token.allowance(tokenHolder.address, thirdParty.address)
      ).to.equal(allowance)
    })

    it("should emit an approval event", async () => {
      await expect(tx)
        .to.emit(token, "Approval")
        .withArgs(tokenHolder.address, thirdParty.address, allowance)
    })
  })

  describe("burn", () => {
    const initialBalance = to1e18(18)
    const burnedAmount = to1e18(5)

    let burnTx: ContractTransaction

    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)
      await token.connect(minter).mint(tokenHolder.address, initialBalance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    before(async () => {
      await createSnapshot()
      burnTx = await token.connect(tokenHolder).burn(burnedAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should decrement account's balance", async () => {
      const expectedBalance = initialBalance.sub(burnedAmount)
      expect(await token.balanceOf(tokenHolder.address)).to.equal(
        expectedBalance
      )
    })

    it("should emit Transfer event", async () => {
      await expect(burnTx)
        .to.emit(token, "Transfer")
        .withArgs(tokenHolder.address, ZERO_ADDRESS, burnedAmount)
    })
  })

  describe("burnFrom", () => {
    const initialBalance = to1e18(18)
    const burnedAmount = to1e18(9)

    let burnTx: ContractTransaction

    before(async () => {
      await createSnapshot()
      await token.connect(governance).addMinter(minter.address)
      await token.connect(minter).mint(tokenHolder.address, initialBalance)
    })

    after(async () => {
      await restoreSnapshot()
    })

    before(async () => {
      await createSnapshot()
      await token.connect(tokenHolder).approve(thirdParty.address, burnedAmount)
      burnTx = await token
        .connect(thirdParty)
        .burnFrom(tokenHolder.address, burnedAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should decrement account's balance", async () => {
      const expectedBalance = initialBalance.sub(burnedAmount)
      expect(await token.balanceOf(tokenHolder.address)).to.equal(
        expectedBalance
      )
    })

    it("should decrement allowance", async () => {
      const allowance = await token.allowance(
        tokenHolder.address,
        thirdParty.address
      )

      expect(allowance).to.equal(0)
    })

    it("should emit Transfer event", async () => {
      await expect(burnTx)
        .to.emit(token, "Transfer")
        .withArgs(tokenHolder.address, ZERO_ADDRESS, burnedAmount)
    })
  })

  describe("permit", () => {
    const initialHolderBalance = to1e18(70)
    let permittingHolder: Wallet

    let deadline: number

    let tx: ContractTransaction

    const getApproval = async (amount, spender) => {
      // We use ethers.utils.SigningKey for a Wallet instead of
      // Signer.signMessage to do not add '\x19Ethereum Signed Message:\n'
      // prefix to the signed message. The '\x19` protection (see EIP191 for
      // more details on '\x19' rationale and format) is already included in
      // EIP2612 permit signed message and '\x19Ethereum Signed Message:\n'
      // should not be used there.
      const signingKey = new ethers.utils.SigningKey(
        permittingHolder.privateKey
      )

      const domainSeparator = await token.DOMAIN_SEPARATOR()
      const permitTypehash = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(
          "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        )
      )
      const nonce = await token.nonces(permittingHolder.address)

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
                  permittingHolder.address,
                  spender,
                  amount,
                  nonce,
                  deadline,
                ]
              )
            ),
          ]
        )
      )

      return ethers.utils.splitSignature(
        await signingKey.signDigest(approvalDigest)
      )
    }

    before(async () => {
      await createSnapshot()

      permittingHolder = await ethers.Wallet.createRandom()

      await token.connect(governance).addMinter(minter.address)
      await token
        .connect(minter)
        .mint(permittingHolder.address, initialHolderBalance)

      const lastBlockTimestamp = await helpers.time.lastBlockTime()
      deadline = lastBlockTimestamp + 86400 // +1 day

      const signature = await getApproval(
        initialHolderBalance,
        thirdParty.address
      )

      tx = await token
        .connect(thirdParty)
        .permit(
          permittingHolder.address,
          thirdParty.address,
          initialHolderBalance,
          deadline,
          signature.v,
          signature.r,
          signature.s
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should emit an approval event", async () => {
      await expect(tx)
        .to.emit(token, "Approval")
        .withArgs(
          permittingHolder.address,
          thirdParty.address,
          initialHolderBalance
        )
    })

    it("should approve the requested amount", async () => {
      expect(
        await token.allowance(permittingHolder.address, thirdParty.address)
      ).to.equal(initialHolderBalance)
    })
  })
})
