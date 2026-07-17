// @ts-nocheck
import { deployments, helpers, ethers } from "hardhat"
import { expect } from "chai"

import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import type {
  OptimismMintableUpgradableTBTC,
  OptimismMintableUpgradableERC20,
  ITransparentUpgradeableProxy,
} from "../typechain"

describe("BOBTBTC - Manual Upgrade Test", async () => {
  let deployer: SignerWithAddress
  let user: SignerWithAddress
  let admin: SignerWithAddress
  let bridge: SignerWithAddress
  let guardian: SignerWithAddress
  let newMinter: SignerWithAddress
  let recipient: SignerWithAddress

  before(async () => {
    ;[deployer, user, admin, bridge, guardian, newMinter, recipient] =
      await ethers.getSigners()
  })

  describe("Manual proxy upgrade flow", () => {
    let proxy: ITransparentUpgradeableProxy
    let implementation: OptimismMintableUpgradableERC20
    let newImplementation: OptimismMintableUpgradableTBTC
    let proxyAsV1: OptimismMintableUpgradableERC20
    let proxyAsV2: OptimismMintableUpgradableTBTC

    // Test values
    const L2_BRIDGE = "0x9fc3da866e7df3a1c57ade1a97c9f00a70f010c8"
    const L1_TBTC = "0x3151c5547d1dbcd52076bd3cbe56c79abd55b42f"
    const TOKEN_NAME = "BOB tBTC v2"
    const TOKEN_SYMBOL = "tBTC"
    const DECIMALS = 18

    // State tracking
    let totalSupplyBeforeUpgrade: any
    let userBalanceBeforeUpgrade: any
    let recipientBalanceBeforeUpgrade: any

    before(async () => {
      // 1. Deploy V1 implementation
      const OptimismMintableUpgradableERC20Factory =
        await ethers.getContractFactory(
          "OptimismMintableUpgradableERC20",
          deployer
        )
      implementation = await OptimismMintableUpgradableERC20Factory.deploy()
      await implementation.deployed()
      console.log("V1 Implementation deployed at:", implementation.address)

      // 2. Deploy TransparentUpgradeableProxy
      const TransparentUpgradeableProxyFactory =
        await ethers.getContractFactory("TransparentUpgradeableProxy", deployer)

      // Encode the initialize function call
      const initializeData = implementation.interface.encodeFunctionData(
        "initialize",
        [bridge.address, L1_TBTC, TOKEN_NAME, TOKEN_SYMBOL, DECIMALS] // Use bridge signer address
      )

      const proxyContract = await TransparentUpgradeableProxyFactory.deploy(
        implementation.address,
        admin.address,
        initializeData
      )
      await proxyContract.deployed()
      console.log("Proxy deployed at:", proxyContract.address)

      proxy = (await ethers.getContractAt(
        "ITransparentUpgradeableProxy",
        proxyContract.address
      )) as ITransparentUpgradeableProxy

      // 3. Get proxy as V1 contract
      proxyAsV1 = (await ethers.getContractAt(
        "OptimismMintableUpgradableERC20",
        proxy.address,
        user
      )) as OptimismMintableUpgradableERC20

      // Verify initialization worked
      expect(await proxyAsV1.name()).to.equal(TOKEN_NAME)
      expect(await proxyAsV1.symbol()).to.equal(TOKEN_SYMBOL)
      expect(await proxyAsV1.decimals()).to.equal(DECIMALS)
      expect((await proxyAsV1.l1Token()).toLowerCase()).to.equal(
        L1_TBTC.toLowerCase()
      )
      expect((await proxyAsV1.bridge()).toLowerCase()).to.equal(
        bridge.address.toLowerCase()
      )
    })

    describe("V1 functionality before upgrade", () => {
      it("should have zero total supply initially", async () => {
        expect(await proxyAsV1.totalSupply()).to.equal(0)
      })

      it("should allow bridge to mint tokens", async () => {
        const mintAmount = ethers.utils.parseEther("100")

        // Connect as bridge to mint
        const proxyAsBridge = proxyAsV1.connect(bridge)
        await expect(proxyAsBridge.mint(user.address, mintAmount))
          .to.emit(proxyAsV1, "Mint")
          .withArgs(user.address, mintAmount)

        expect(await proxyAsV1.balanceOf(user.address)).to.equal(mintAmount)
        expect(await proxyAsV1.totalSupply()).to.equal(mintAmount)
      })

      it("should not allow non-bridge to mint", async () => {
        const mintAmount = ethers.utils.parseEther("50")
        await expect(
          proxyAsV1.connect(deployer).mint(recipient.address, mintAmount)
        ).to.be.revertedWith(
          "OptimismMintableERC20: only bridge can mint and burn"
        )
      })

      it("should allow bridge to burn tokens", async () => {
        const burnAmount = ethers.utils.parseEther("25")

        // Connect as bridge to burn
        const proxyAsBridge = proxyAsV1.connect(bridge)
        await expect(proxyAsBridge.burn(user.address, burnAmount))
          .to.emit(proxyAsV1, "Burn")
          .withArgs(user.address, burnAmount)

        expect(await proxyAsV1.balanceOf(user.address)).to.equal(
          ethers.utils.parseEther("75")
        )
        expect(await proxyAsV1.totalSupply()).to.equal(
          ethers.utils.parseEther("75")
        )
      })

      it("should not allow non-bridge to burn", async () => {
        const burnAmount = ethers.utils.parseEther("10")
        await expect(
          proxyAsV1.connect(deployer).burn(user.address, burnAmount)
        ).to.be.revertedWith(
          "OptimismMintableERC20: only bridge can mint and burn"
        )
      })

      it("should mint more tokens to recipient", async () => {
        const mintAmount = ethers.utils.parseEther("50")

        const proxyAsBridge = proxyAsV1.connect(bridge)
        await proxyAsBridge.mint(recipient.address, mintAmount)

        expect(await proxyAsV1.balanceOf(recipient.address)).to.equal(
          mintAmount
        )
        expect(await proxyAsV1.totalSupply()).to.equal(
          ethers.utils.parseEther("125")
        )
      })

      it("should record state before upgrade", async () => {
        totalSupplyBeforeUpgrade = await proxyAsV1.totalSupply()
        userBalanceBeforeUpgrade = await proxyAsV1.balanceOf(user.address)
        recipientBalanceBeforeUpgrade = await proxyAsV1.balanceOf(
          recipient.address
        )

        console.log(
          "Total supply before upgrade:",
          ethers.utils.formatEther(totalSupplyBeforeUpgrade)
        )
        console.log(
          "User balance before upgrade:",
          ethers.utils.formatEther(userBalanceBeforeUpgrade)
        )
        console.log(
          "Recipient balance before upgrade:",
          ethers.utils.formatEther(recipientBalanceBeforeUpgrade)
        )
      })
    })

    describe("Upgrading to V2", () => {
      before(async () => {
        // 1. Deploy new implementation
        const OptimismMintableUpgradableTBTCFactory =
          await ethers.getContractFactory(
            "OptimismMintableUpgradableTBTC",
            deployer
          )
        newImplementation = await OptimismMintableUpgradableTBTCFactory.deploy()
        await newImplementation.deployed()
        console.log("V2 Implementation deployed at:", newImplementation.address)

        // 2. Perform the upgrade directly on the proxy using admin account
        await proxy.connect(admin).upgradeTo(newImplementation.address)
        console.log("Proxy upgraded to new implementation")

        // 3. Get proxy as V2 contract, connected as deployer
        proxyAsV2 = (await ethers.getContractAt(
          "OptimismMintableUpgradableTBTC",
          proxy.address,
          deployer
        )) as OptimismMintableUpgradableTBTC

        // 4. Call initializeV2. This makes deployer the owner.
        await proxyAsV2.initializeV2()
        console.log("InitializeV2 called successfully")
      })

      describe("State preservation", () => {
        it("should preserve name", async () => {
          expect(await proxyAsV2.name()).to.equal(TOKEN_NAME)
        })

        it("should preserve symbol", async () => {
          expect(await proxyAsV2.symbol()).to.equal(TOKEN_SYMBOL)
        })

        it("should preserve decimals", async () => {
          expect(await proxyAsV2.decimals()).to.equal(DECIMALS)
        })

        it("should preserve l1Token", async () => {
          expect((await proxyAsV2.l1Token()).toLowerCase()).to.equal(
            L1_TBTC.toLowerCase()
          )
        })

        it("should preserve bridge", async () => {
          expect((await proxyAsV2.bridge()).toLowerCase()).to.equal(
            bridge.address.toLowerCase()
          )
        })

        it("should preserve total supply", async () => {
          const totalSupply = await proxyAsV2.totalSupply()
          expect(totalSupply).to.equal(totalSupplyBeforeUpgrade)
        })

        it("should preserve user balances", async () => {
          expect(await proxyAsV2.balanceOf(user.address)).to.equal(
            userBalanceBeforeUpgrade
          )
          expect(await proxyAsV2.balanceOf(recipient.address)).to.equal(
            recipientBalanceBeforeUpgrade
          )
        })
      })

      describe("New V2 functionality", () => {
        it("should have correct owner", async () => {
          expect(await proxyAsV2.owner()).to.equal(deployer.address)
        })

        it("should not be paused", async () => {
          expect(await proxyAsV2.paused()).to.equal(false)
        })

        it("should have legacyCapRemaining equal to totalSupply", async () => {
          const legacyCap = await proxyAsV2.getLegacyCapRemaining()
          const totalSupply = await proxyAsV2.totalSupply()
          expect(legacyCap).to.equal(totalSupply)
          expect(legacyCap).to.equal(totalSupplyBeforeUpgrade)
        })

        it("should have bridge added as a minter", async () => {
          expect(await proxyAsV2.isMinter(bridge.address)).to.be.true

          const minters = await proxyAsV2.getMinters()
          expect(minters).to.include(bridge.address)
          expect(minters.length).to.equal(1)
        })

        describe("Guardian functionality", () => {
          it("should add a guardian", async () => {
            await expect(proxyAsV2.addGuardian(guardian.address))
              .to.emit(proxyAsV2, "GuardianAdded")
              .withArgs(guardian.address)

            expect(await proxyAsV2.isGuardian(guardian.address)).to.be.true
          })

          it("should not add same guardian twice", async () => {
            await expect(
              proxyAsV2.addGuardian(guardian.address)
            ).to.be.revertedWith("This address is already a guardian")
          })

          it("should get the list of guardians", async () => {
            const guardians = await proxyAsV2.getGuardians()
            expect(guardians).to.include(guardian.address)
            expect(guardians.length).to.equal(1)
          })

          it("guardian should be able to pause", async () => {
            await expect(proxyAsV2.connect(guardian).pause())
              .to.emit(proxyAsV2, "Paused")
              .withArgs(guardian.address)

            expect(await proxyAsV2.paused()).to.be.true
          })

          it("should not allow non-guardian to pause", async () => {
            // First unpause
            await proxyAsV2.unpause()

            await expect(proxyAsV2.connect(user).pause()).to.be.revertedWith(
              "Caller is not a guardian"
            )
          })

          it("owner should be able to unpause", async () => {
            // First pause
            await proxyAsV2.connect(guardian).pause()

            await expect(proxyAsV2.unpause())
              .to.emit(proxyAsV2, "Unpaused")
              .withArgs(deployer.address)

            expect(await proxyAsV2.paused()).to.be.false
          })

          it("should not allow non-owner to unpause", async () => {
            // First pause
            await proxyAsV2.connect(guardian).pause()

            await expect(proxyAsV2.connect(user).unpause()).to.be.revertedWith(
              "Ownable: caller is not the owner"
            )

            // Unpause for next tests
            await proxyAsV2.unpause()
          })

          it("should remove guardian", async () => {
            await expect(proxyAsV2.removeGuardian(guardian.address))
              .to.emit(proxyAsV2, "GuardianRemoved")
              .withArgs(guardian.address)

            expect(await proxyAsV2.isGuardian(guardian.address)).to.be.false

            const guardians = await proxyAsV2.getGuardians()
            expect(guardians.length).to.equal(0)
          })

          it("should not remove non-existent guardian", async () => {
            await expect(
              proxyAsV2.removeGuardian(guardian.address)
            ).to.be.revertedWith("This address is not a guardian")
          })
        })

        describe("Bridge minting with legacy cap", () => {
          let initialLegacyCap: any

          before(async () => {
            initialLegacyCap = await proxyAsV2.getLegacyCapRemaining()
          })

          it("bridge should mint and increase legacy cap", async () => {
            const mintAmount = ethers.utils.parseEther("30")

            await expect(
              proxyAsV2.connect(bridge).mint(user.address, mintAmount)
            )
              .to.emit(proxyAsV2, "Mint")
              .withArgs(user.address, mintAmount)
              .to.emit(proxyAsV2, "Transfer")
              .withArgs(ethers.constants.AddressZero, user.address, mintAmount)

            const newLegacyCap = await proxyAsV2.getLegacyCapRemaining()
            expect(newLegacyCap).to.equal(initialLegacyCap.add(mintAmount))
          })

          it("bridge should burn using legacy burn function and decrease legacy cap", async () => {
            const burnAmount = ethers.utils.parseEther("20")
            const legacyCapBefore = await proxyAsV2.getLegacyCapRemaining()

            await expect(
              proxyAsV2
                .connect(bridge)
                ["burn(address,uint256)"](user.address, burnAmount)
            )
              .to.emit(proxyAsV2, "Burn")
              .withArgs(user.address, burnAmount)
              .to.emit(proxyAsV2, "Transfer")
              .withArgs(user.address, ethers.constants.AddressZero, burnAmount)

            const newLegacyCap = await proxyAsV2.getLegacyCapRemaining()
            expect(newLegacyCap).to.equal(legacyCapBefore.sub(burnAmount))
          })

          it("should not allow bridge burn more than legacy cap", async () => {
            const legacyCap = await proxyAsV2.getLegacyCapRemaining()
            const excessAmount = legacyCap.add(ethers.utils.parseEther("1"))

            await expect(
              proxyAsV2
                .connect(bridge)
                ["burn(address,uint256)"](user.address, excessAmount)
            ).to.be.revertedWith("Amount exceeds legacy cap remaining")
          })

          it("should not allow non-bridge to use legacy burn", async () => {
            await expect(
              proxyAsV2
                .connect(user)
                ["burn(address,uint256)"](
                  user.address,
                  ethers.utils.parseEther("1")
                )
            ).to.be.revertedWith(
              "OptimismMintableERC20: only bridge can mint and burn"
            )
          })
        })

        describe("New minter functionality", () => {
          it("should add a new minter", async () => {
            await expect(proxyAsV2.addMinter(newMinter.address))
              .to.emit(proxyAsV2, "MinterAdded")
              .withArgs(newMinter.address)

            expect(await proxyAsV2.isMinter(newMinter.address)).to.be.true
          })

          it("should not add same minter twice", async () => {
            await expect(
              proxyAsV2.addMinter(newMinter.address)
            ).to.be.revertedWith("This address is already a minter")
          })

          it("should get the list of minters", async () => {
            const minters = await proxyAsV2.getMinters()
            expect(minters).to.include(bridge.address)
            expect(minters).to.include(newMinter.address)
            expect(minters.length).to.equal(2)
          })

          it("new minter should mint without affecting legacy cap", async () => {
            const mintAmount = ethers.utils.parseEther("40")
            const legacyCapBefore = await proxyAsV2.getLegacyCapRemaining()

            await expect(
              proxyAsV2.connect(newMinter).mint(recipient.address, mintAmount)
            )
              .to.emit(proxyAsV2, "Mint")
              .withArgs(recipient.address, mintAmount)

            // Legacy cap should not change
            expect(await proxyAsV2.getLegacyCapRemaining()).to.equal(
              legacyCapBefore
            )
          })

          it("should not allow non-minter to mint", async () => {
            await expect(
              proxyAsV2
                .connect(user)
                .mint(user.address, ethers.utils.parseEther("10"))
            ).to.be.revertedWith("Caller is not a minter")
          })

          it("should remove minter", async () => {
            await expect(proxyAsV2.removeMinter(newMinter.address))
              .to.emit(proxyAsV2, "MinterRemoved")
              .withArgs(newMinter.address)

            expect(await proxyAsV2.isMinter(newMinter.address)).to.be.false

            const minters = await proxyAsV2.getMinters()
            expect(minters).to.not.include(newMinter.address)
            expect(minters.length).to.equal(1)
          })

          it("should not remove non-existent minter", async () => {
            await expect(
              proxyAsV2.removeMinter(newMinter.address)
            ).to.be.revertedWith("This address is not a minter")
          })
        })

        describe("User burn functionality", () => {
          it("user should burn their own tokens", async () => {
            const burnAmount = ethers.utils.parseEther("5")
            const balanceBefore = await proxyAsV2.balanceOf(user.address)

            await expect(proxyAsV2.connect(user)["burn(uint256)"](burnAmount))
              .to.emit(proxyAsV2, "Burn")
              .withArgs(user.address, burnAmount)
              .to.emit(proxyAsV2, "Transfer")
              .withArgs(user.address, ethers.constants.AddressZero, burnAmount)

            expect(await proxyAsV2.balanceOf(user.address)).to.equal(
              balanceBefore.sub(burnAmount)
            )
          })

          it("should not burn more than balance", async () => {
            const balance = await proxyAsV2.balanceOf(user.address)
            const excessAmount = balance.add(ethers.utils.parseEther("1"))

            await expect(
              proxyAsV2.connect(user)["burn(uint256)"](excessAmount)
            ).to.be.revertedWith("ERC20: burn amount exceeds balance")
          })
        })

        describe("Allowance and burnFrom functionality", () => {
          it("should approve allowance", async () => {
            const allowanceAmount = ethers.utils.parseEther("25")

            await expect(
              proxyAsV2
                .connect(recipient)
                .approve(deployer.address, allowanceAmount)
            )
              .to.emit(proxyAsV2, "Approval")
              .withArgs(recipient.address, deployer.address, allowanceAmount)

            expect(
              await proxyAsV2.allowance(recipient.address, deployer.address)
            ).to.equal(allowanceAmount)
          })

          it("should burnFrom with allowance when legacy cap is zero", async () => {
            // First, exhaust the legacy cap by burning all existing balances through bridge
            let legacyCap = await proxyAsV2.getLegacyCapRemaining()

            while (legacyCap.gt(0)) {
              // Get current balances
              const userBalance = await proxyAsV2.balanceOf(user.address)
              const recipientBalance = await proxyAsV2.balanceOf(
                recipient.address
              )

              // Burn user balance if any (up to legacy cap)
              if (userBalance.gt(0) && legacyCap.gt(0)) {
                const burnAmount = userBalance.lte(legacyCap)
                  ? userBalance
                  : legacyCap
                await proxyAsV2
                  .connect(bridge)
                  ["burn(address,uint256)"](user.address, burnAmount)
                legacyCap = await proxyAsV2.getLegacyCapRemaining()
              }

              // Burn recipient balance if any (up to legacy cap)
              if (recipientBalance.gt(0) && legacyCap.gt(0)) {
                const burnAmount = recipientBalance.lte(legacyCap)
                  ? recipientBalance
                  : legacyCap
                await proxyAsV2
                  .connect(bridge)
                  ["burn(address,uint256)"](recipient.address, burnAmount)
                legacyCap = await proxyAsV2.getLegacyCapRemaining()
              }

              // If we can't burn anymore, break
              if (userBalance.eq(0) && recipientBalance.eq(0)) {
                break
              }
            }

            expect(await proxyAsV2.getLegacyCapRemaining()).to.equal(0)

            // Now mint some tokens to recipient without affecting legacy cap (using non-bridge minter)
            await proxyAsV2.addMinter(deployer.address)
            await proxyAsV2
              .connect(deployer)
              .mint(recipient.address, ethers.utils.parseEther("20"))

            // Now test burnFrom
            const burnAmount = ethers.utils.parseEther("10")
            const recipientBalanceBefore = await proxyAsV2.balanceOf(
              recipient.address
            )
            const allowanceBefore = await proxyAsV2.allowance(
              recipient.address,
              deployer.address
            )

            await expect(
              proxyAsV2
                .connect(deployer)
                .burnFrom(recipient.address, burnAmount)
            )
              .to.emit(proxyAsV2, "Burn")
              .withArgs(recipient.address, burnAmount)
              .to.emit(proxyAsV2, "Transfer")
              .withArgs(
                recipient.address,
                ethers.constants.AddressZero,
                burnAmount
              )

            expect(await proxyAsV2.balanceOf(recipient.address)).to.equal(
              recipientBalanceBefore.sub(burnAmount)
            )
            expect(
              await proxyAsV2.allowance(recipient.address, deployer.address)
            ).to.equal(allowanceBefore.sub(burnAmount))
          })

          it("should not burnFrom more than allowance", async () => {
            // Ensure legacy cap is still 0
            expect(await proxyAsV2.getLegacyCapRemaining()).to.equal(0)

            const allowance = await proxyAsV2.allowance(
              recipient.address,
              deployer.address
            )
            const excessAmount = allowance.add(ethers.utils.parseEther("1"))

            // Since legacy cap is 0 now, anyone can burnFrom
            await expect(
              proxyAsV2
                .connect(deployer)
                .burnFrom(recipient.address, excessAmount)
            ).to.be.revertedWith("ERC20: insufficient allowance")
          })
        })

        describe("Bridge burnFrom with legacy cap", () => {
          it("should restore legacy cap for bridge burnFrom test", async () => {
            // Mint some tokens via bridge to restore legacy cap
            await proxyAsV2
              .connect(bridge)
              .mint(user.address, ethers.utils.parseEther("50"))
            expect(await proxyAsV2.getLegacyCapRemaining()).to.be.gt(0)
          })

          it("bridge should burnFrom when legacy cap > 0", async () => {
            const burnAmount = ethers.utils.parseEther("5")
            const legacyCapBefore = await proxyAsV2.getLegacyCapRemaining()

            // User approves bridge
            await proxyAsV2.connect(user).approve(bridge.address, burnAmount)

            await expect(
              proxyAsV2.connect(bridge).burnFrom(user.address, burnAmount)
            )
              .to.emit(proxyAsV2, "Burn")
              .withArgs(user.address, burnAmount)

            expect(await proxyAsV2.getLegacyCapRemaining()).to.equal(
              legacyCapBefore.sub(burnAmount)
            )
          })

          it("non-bridge should not burnFrom when legacy cap > 0", async () => {
            const burnAmount = ethers.utils.parseEther("1")

            // User approves deployer
            await proxyAsV2.connect(user).approve(deployer.address, burnAmount)

            await expect(
              proxyAsV2.connect(deployer).burnFrom(user.address, burnAmount)
            ).to.be.revertedWith(
              "Only bridge can burn while legacy cap remains"
            )
          })

          it("bridge should not burnFrom more than legacy cap", async () => {
            const legacyCap = await proxyAsV2.getLegacyCapRemaining()
            const excessAmount = legacyCap.add(ethers.utils.parseEther("1"))

            // User approves bridge for excess amount
            await proxyAsV2.connect(user).approve(bridge.address, excessAmount)

            await expect(
              proxyAsV2.connect(bridge).burnFrom(user.address, excessAmount)
            ).to.be.revertedWith("Amount exceeds legacy cap remaining")
          })
        })

        describe("Pause functionality", () => {
          before(async () => {
            // Add guardian back for pause tests
            await proxyAsV2.addGuardian(guardian.address)
          })

          it("should not mint when paused", async () => {
            await proxyAsV2.connect(guardian).pause()

            await expect(
              proxyAsV2
                .connect(bridge)
                .mint(user.address, ethers.utils.parseEther("1"))
            ).to.be.revertedWith("Pausable: paused")

            await proxyAsV2.unpause()
          })

          it("should not burn when paused", async () => {
            await proxyAsV2.connect(guardian).pause()

            await expect(
              proxyAsV2
                .connect(user)
                ["burn(uint256)"](ethers.utils.parseEther("1"))
            ).to.be.revertedWith("Pausable: paused")

            await proxyAsV2.unpause()
          })

          it("should not burnFrom when paused", async () => {
            await proxyAsV2.connect(guardian).pause()

            // First approve
            await proxyAsV2.unpause() // Unpause to approve
            await proxyAsV2
              .connect(user)
              .approve(deployer.address, ethers.utils.parseEther("1"))
            await proxyAsV2.connect(guardian).pause() // Pause again

            await expect(
              proxyAsV2
                .connect(deployer)
                .burnFrom(user.address, ethers.utils.parseEther("1"))
            ).to.be.revertedWith("Pausable: paused")

            await proxyAsV2.unpause()
          })

          it("should not use legacy burn when paused", async () => {
            await proxyAsV2.connect(guardian).pause()

            await expect(
              proxyAsV2
                .connect(bridge)
                ["burn(address,uint256)"](
                  user.address,
                  ethers.utils.parseEther("1")
                )
            ).to.be.revertedWith("Pausable: paused")

            await proxyAsV2.unpause()
          })
        })

        describe("Recovery functions", () => {
          let testERC20: any
          let testERC721: any

          before(async () => {
            // Deploy a test ERC20
            const TestERC20 = await ethers.getContractFactory(
              "ERC20Mock",
              deployer
            )
            testERC20 = await TestERC20.deploy(
              "Test Token",
              "TEST",
              deployer.address,
              ethers.utils.parseEther("1000")
            )
            await testERC20.deployed()

            // Deploy a test ERC721
            const TestERC721 = await ethers.getContractFactory(
              "ERC721Mock",
              deployer
            )
            testERC721 = await TestERC721.deploy("Test NFT", "TNFT")
            await testERC721.deployed()
          })

          it("should recover ERC20 tokens", async () => {
            const amount = ethers.utils.parseEther("100")

            // Send test tokens to the contract
            await testERC20.transfer(proxyAsV2.address, amount)
            expect(await testERC20.balanceOf(proxyAsV2.address)).to.equal(
              amount
            )

            // Recover tokens
            await proxyAsV2.recoverERC20(
              testERC20.address,
              recipient.address,
              amount
            )

            expect(await testERC20.balanceOf(proxyAsV2.address)).to.equal(0)
            expect(await testERC20.balanceOf(recipient.address)).to.equal(
              amount
            )
          })

          it("should not allow non-owner to recover ERC20", async () => {
            await expect(
              proxyAsV2
                .connect(user)
                .recoverERC20(
                  testERC20.address,
                  user.address,
                  ethers.utils.parseEther("1")
                )
            ).to.be.revertedWith("Ownable: caller is not the owner")
          })

          it("should recover ERC721 tokens", async () => {
            const tokenId = 1

            // Mint NFT to the contract
            await testERC721.mint(proxyAsV2.address, tokenId)
            expect(await testERC721.ownerOf(tokenId)).to.equal(
              proxyAsV2.address
            )

            // Recover NFT
            await proxyAsV2.recoverERC721(
              testERC721.address,
              recipient.address,
              tokenId,
              "0x"
            )

            expect(await testERC721.ownerOf(tokenId)).to.equal(
              recipient.address
            )
          })

          it("should not allow non-owner to recover ERC721", async () => {
            await expect(
              proxyAsV2
                .connect(user)
                .recoverERC721(testERC721.address, user.address, 1, "0x")
            ).to.be.revertedWith("Ownable: caller is not the owner")
          })
        })

        describe("Edge cases and final checks", () => {
          it("should handle multiple guardians", async () => {
            // Ensure we're not paused
            if (await proxyAsV2.paused()) {
              await proxyAsV2.unpause()
            }

            await proxyAsV2.addGuardian(user.address)
            const guardians = await proxyAsV2.getGuardians()
            expect(guardians.length).to.equal(2)

            // Either guardian can pause
            await proxyAsV2.connect(user).pause()
            expect(await proxyAsV2.paused()).to.be.true

            await proxyAsV2.unpause()
          })

          it("should handle multiple minters", async () => {
            // Ensure we're not paused
            if (await proxyAsV2.paused()) {
              await proxyAsV2.unpause()
            }

            // Check if deployer is already a minter before adding
            if (!(await proxyAsV2.isMinter(deployer.address))) {
              await proxyAsV2.addMinter(deployer.address)
            }

            // Check if newMinter is already a minter before adding
            if (!(await proxyAsV2.isMinter(newMinter.address))) {
              await proxyAsV2.addMinter(newMinter.address)
            }

            const minters = await proxyAsV2.getMinters()
            expect(minters.length).to.be.gte(3) // at least bridge + deployer + newMinter

            // All minters can mint
            await proxyAsV2
              .connect(deployer)
              .mint(user.address, ethers.utils.parseEther("1"))
            await proxyAsV2
              .connect(newMinter)
              .mint(user.address, ethers.utils.parseEther("1"))
          })

          it("should verify final state consistency", async () => {
            const totalSupply = await proxyAsV2.totalSupply()
            const userBalance = await proxyAsV2.balanceOf(user.address)
            const recipientBalance = await proxyAsV2.balanceOf(
              recipient.address
            )

            // Total supply should equal sum of all balances
            expect(totalSupply).to.equal(userBalance.add(recipientBalance))

            console.log(
              "Final total supply:",
              ethers.utils.formatEther(totalSupply)
            )
            console.log(
              "Final user balance:",
              ethers.utils.formatEther(userBalance)
            )
            console.log(
              "Final recipient balance:",
              ethers.utils.formatEther(recipientBalance)
            )
            console.log(
              "Final legacy cap remaining:",
              ethers.utils.formatEther(await proxyAsV2.getLegacyCapRemaining())
            )
          })
        })
      })

      describe("Re-initialization checks", () => {
        it("should not allow re-initialization with V1 initialize", async () => {
          await expect(
            proxyAsV2.initialize(L2_BRIDGE, L1_TBTC, "New Name", "NEW", 18)
          ).to.be.revertedWith("Initializable: contract is already initialized")
        })

        it("should not allow re-initialization with V2 initializeV2", async () => {
          await expect(proxyAsV2.initializeV2()).to.be.revertedWith(
            "Initializable: contract is already initialized"
          )
        })
      })

      describe("Storage layout verification", () => {
        it("should have the implementation slot pointing to V2", async () => {
          const IMPLEMENTATION_SLOT =
            "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
          const implementationStorage = await ethers.provider.getStorageAt(
            proxy.address,
            IMPLEMENTATION_SLOT
          )
          const implementationAddress = "0x" + implementationStorage.slice(26) // Remove padding

          expect(implementationAddress.toLowerCase()).to.equal(
            newImplementation.address.toLowerCase()
          )
          console.log(
            "Verified implementation slot points to V2:",
            implementationAddress
          )
        })
      })
    })
  })
})
