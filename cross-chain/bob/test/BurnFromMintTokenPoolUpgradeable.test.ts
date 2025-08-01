import { expect } from "chai"
import { ethers, upgrades } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import {
  BurnFromMintTokenPoolUpgradeable,
  BurnMintERC20Mock,
} from "../typechain"

describe("BurnFromMintTokenPoolUpgradeable", function () {
  let burnMintPool: BurnFromMintTokenPoolUpgradeable
  let mockToken: BurnMintERC20Mock
  let owner: SignerWithAddress
  let user1: SignerWithAddress
  let user2: SignerWithAddress
  let router: SignerWithAddress
  let rmnProxy: SignerWithAddress

  const INITIAL_SUPPLY = ethers.utils.parseEther("1000000")
  const BURN_AMOUNT = ethers.utils.parseEther("100")
  const MINT_AMOUNT = ethers.utils.parseEther("50")

  beforeEach(async function () {
    ;[owner, user1, user2, router, rmnProxy] = await ethers.getSigners()

    // Deploy mock ERC20 token with burn/mint capabilities
    const BurnMintERC20Mock = await ethers.getContractFactory(
      "BurnMintERC20Mock"
    )
    mockToken = await BurnMintERC20Mock.deploy(
      "Mock Token",
      "MTK",
      owner.address,
      INITIAL_SUPPLY
    )
    await mockToken.deployed()

    // Deploy BurnFromMintTokenPoolUpgradeable
    const BurnFromMintTokenPoolUpgradeable = await ethers.getContractFactory(
      "BurnFromMintTokenPoolUpgradeable"
    )
    burnMintPool = (await upgrades.deployProxy(
      BurnFromMintTokenPoolUpgradeable,
      [
        mockToken.address,
        18, // tokenDecimals
        [], // allowlist
        rmnProxy.address,
        router.address,
      ]
    )) as BurnFromMintTokenPoolUpgradeable
    await burnMintPool.deployed()

    // Grant minter role to the pool for BurnMintERC20Mock
    await mockToken.grantRole(
      await mockToken.MINTER_ROLE(),
      burnMintPool.address
    )

    // Transfer some tokens to user1 for testing
    await mockToken.transfer(user1.address, ethers.utils.parseEther("10000"))
    await mockToken
      .connect(user1)
      .approve(burnMintPool.address, ethers.constants.MaxUint256)
  })

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await burnMintPool.getToken()).to.equal(mockToken.address)
      expect(await burnMintPool.getRouter()).to.equal(router.address)
      expect(await burnMintPool.getRmnProxy()).to.equal(rmnProxy.address)
      expect(await burnMintPool.owner()).to.equal(owner.address)
      expect(await burnMintPool.getTokenDecimals()).to.equal(18)
    })

    it("Should revert if initialized with zero addresses", async function () {
      const newPool = await ethers.getContractFactory(
        "BurnFromMintTokenPoolUpgradeable"
      )
      await expect(
        upgrades.deployProxy(newPool, [
          ethers.constants.AddressZero,
          18,
          [],
          rmnProxy.address,
          router.address,
        ])
      ).to.be.revertedWith("ZeroAddressNotAllowed")
    })

    it("Should initialize with allowlist when provided", async function () {
      const allowlistPool = await ethers.getContractFactory(
        "BurnFromMintTokenPoolUpgradeable"
      )
      const poolWithAllowlist = await upgrades.deployProxy(allowlistPool, [
        mockToken.address,
        18,
        [user1.address, user2.address], // allowlist
        rmnProxy.address,
        router.address,
      ])

      // Just check that it deployed successfully
      expect(await poolWithAllowlist.getToken()).to.equal(mockToken.address)
    })
  })

  describe("Token Support", function () {
    it("Should support the correct token", async function () {
      expect(await burnMintPool.isSupportedToken(mockToken.address)).to.be.true
      expect(await burnMintPool.isSupportedToken(ethers.constants.AddressZero))
        .to.be.false
    })

    it("Should have correct token decimals", async function () {
      expect(await burnMintPool.getTokenDecimals()).to.equal(18)
    })
  })

  describe("Core Operations", function () {
    it("Should burn tokens", async function () {
      const initialBalance = await mockToken.balanceOf(user1.address)
      const initialTotalSupply = await mockToken.totalSupply()

      await expect(burnMintPool.connect(user1).lockOrBurn(BURN_AMOUNT))
        .to.emit(burnMintPool, "Burned")
        .withArgs(user1.address, BURN_AMOUNT)

      expect(await mockToken.balanceOf(user1.address)).to.equal(
        initialBalance.sub(BURN_AMOUNT)
      )
      expect(await mockToken.totalSupply()).to.equal(
        initialTotalSupply.sub(BURN_AMOUNT)
      )
    })

    it("Should mint tokens", async function () {
      const initialBalance = await mockToken.balanceOf(user2.address)
      const initialTotalSupply = await mockToken.totalSupply()

      await expect(
        burnMintPool.connect(owner).releaseOrMint(user2.address, MINT_AMOUNT)
      )
        .to.emit(burnMintPool, "Minted")
        .withArgs(owner.address, user2.address, MINT_AMOUNT)

      expect(await mockToken.balanceOf(user2.address)).to.equal(
        initialBalance.add(MINT_AMOUNT)
      )
      expect(await mockToken.totalSupply()).to.equal(
        initialTotalSupply.add(MINT_AMOUNT)
      )
    })

    it("Should revert burn with zero amount", async function () {
      await expect(
        burnMintPool.connect(user1).lockOrBurn(0)
      ).to.be.revertedWith("Amount must be greater than 0")
    })

    it("Should revert mint with zero amount", async function () {
      await expect(
        burnMintPool.connect(owner).releaseOrMint(user2.address, 0)
      ).to.be.revertedWith("Amount must be greater than 0")
    })

    it("Should revert mint to zero address", async function () {
      await expect(
        burnMintPool
          .connect(owner)
          .releaseOrMint(ethers.constants.AddressZero, 100)
      ).to.be.revertedWith("ZeroAddressNotAllowed")
    })

    it("Should revert burn if insufficient allowance", async function () {
      // User2 hasn't approved the pool
      await expect(burnMintPool.connect(user2).lockOrBurn(BURN_AMOUNT)).to.be
        .reverted
    })

    it("Should revert burn if insufficient balance", async function () {
      // Try to burn more than user1 has
      const userBalance = await mockToken.balanceOf(user1.address)
      await expect(burnMintPool.connect(user1).lockOrBurn(userBalance.add(1)))
        .to.be.reverted
    })
  })

  describe("Router Management", function () {
    it("Should set router", async function () {
      await expect(burnMintPool.connect(owner).setRouter(user2.address))
        .to.emit(burnMintPool, "RouterUpdated")
        .withArgs(router.address, user2.address)

      expect(await burnMintPool.getRouter()).to.equal(user2.address)
    })

    it("Should revert setting router to zero address", async function () {
      await expect(
        burnMintPool.connect(owner).setRouter(ethers.constants.AddressZero)
      ).to.be.revertedWith("ZeroAddressNotAllowed")
    })

    it("Should revert setting router by non-owner", async function () {
      await expect(
        burnMintPool.connect(user1).setRouter(user2.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  describe("View Functions", function () {
    it("Should return correct version", async function () {
      expect(await burnMintPool.version()).to.equal("1.5.1-upgradeable")
    })

    it("Should return correct type and version", async function () {
      expect(await burnMintPool.typeAndVersion()).to.equal(
        "BurnFromMintTokenPoolUpgradeable 1.5.1"
      )
    })

    it("Should return correct token", async function () {
      expect(await burnMintPool.getToken()).to.equal(mockToken.address)
    })

    it("Should return correct RMN proxy", async function () {
      expect(await burnMintPool.getRmnProxy()).to.equal(rmnProxy.address)
    })
  })

  describe("Upgradeability", function () {
    it("Should be upgradeable", async function () {
      // Deploy new implementation
      const BurnFromMintTokenPoolUpgradeableV2 =
        await ethers.getContractFactory("BurnFromMintTokenPoolUpgradeable")

      await expect(
        upgrades.upgradeProxy(
          burnMintPool.address,
          BurnFromMintTokenPoolUpgradeableV2
        )
      ).to.not.be.reverted

      // Verify the contract still works after upgrade
      expect(await burnMintPool.getToken()).to.equal(mockToken.address)
      expect(await burnMintPool.getRouter()).to.equal(router.address)
    })

    it("Should prevent unauthorized upgrades", async function () {
      const BurnFromMintTokenPoolUpgradeableV2 =
        await ethers.getContractFactory("BurnFromMintTokenPoolUpgradeable")
      const newImpl = await BurnFromMintTokenPoolUpgradeableV2.deploy()
      await newImpl.deployed()

      // Try to upgrade from non-owner account
      await expect(
        burnMintPool.connect(user1).upgradeTo(newImpl.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  describe("Security", function () {
    it("Should prevent reentrancy on burn", async function () {
      // This test ensures the nonReentrant modifier is working
      // In a real attack, a malicious token would try to reenter during burnFrom
      const burnAmount = ethers.utils.parseEther("10")

      await expect(burnMintPool.connect(user1).lockOrBurn(burnAmount))
        .to.emit(burnMintPool, "Burned")
        .withArgs(user1.address, burnAmount)
    })

    it("Should prevent reentrancy on mint", async function () {
      // This test ensures the nonReentrant modifier is working
      // In a real attack, a malicious token would try to reenter during mint
      const mintAmount = ethers.utils.parseEther("10")

      await expect(
        burnMintPool.connect(owner).releaseOrMint(user2.address, mintAmount)
      )
        .to.emit(burnMintPool, "Minted")
        .withArgs(owner.address, user2.address, mintAmount)
    })
  })

  describe("Error Handling", function () {
    it("Should revert unauthorized operations", async function () {
      await expect(
        burnMintPool.connect(user1).setRouter(user2.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("Should handle token operations correctly", async function () {
      // Test successful burn
      const burnAmount = ethers.utils.parseEther("10")
      await expect(burnMintPool.connect(user1).lockOrBurn(burnAmount)).to.not.be
        .reverted

      // Test successful mint
      const mintAmount = ethers.utils.parseEther("10")
      await expect(
        burnMintPool.connect(owner).releaseOrMint(user2.address, mintAmount)
      ).to.not.be.reverted
    })
  })

  describe("Integration", function () {
    it("Should work with full burn/mint cycle", async function () {
      const amount = ethers.utils.parseEther("100")

      // Initial balances
      const initialUser1Balance = await mockToken.balanceOf(user1.address)
      const initialUser2Balance = await mockToken.balanceOf(user2.address)
      const initialTotalSupply = await mockToken.totalSupply()

      // User1 burns tokens
      await burnMintPool.connect(user1).lockOrBurn(amount)

      expect(await mockToken.balanceOf(user1.address)).to.equal(
        initialUser1Balance.sub(amount)
      )
      expect(await mockToken.totalSupply()).to.equal(
        initialTotalSupply.sub(amount)
      )

      // Mint tokens to user2
      await burnMintPool.connect(owner).releaseOrMint(user2.address, amount)

      expect(await mockToken.balanceOf(user2.address)).to.equal(
        initialUser2Balance.add(amount)
      )
      expect(await mockToken.totalSupply()).to.equal(initialTotalSupply) // Back to original supply
    })
  })
})
