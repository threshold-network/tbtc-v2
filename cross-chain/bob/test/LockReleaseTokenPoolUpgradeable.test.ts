import { expect } from "chai"
import { ethers, upgrades } from "hardhat"
import { Contract, ContractFactory, BigNumber } from "ethers"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

describe("LockReleaseTokenPoolUpgradeable", function () {
  let LockReleaseTokenPoolUpgradeable: ContractFactory
  let MockERC20: ContractFactory
  let mockToken: Contract
  let lockReleasePool: Contract
  let owner: SignerWithAddress
  let user1: SignerWithAddress
  let user2: SignerWithAddress
  let router: SignerWithAddress
  let rmnProxy: SignerWithAddress
  let rebalancer: SignerWithAddress

  const INITIAL_SUPPLY = ethers.utils.parseEther("1000000")
  const LOCK_AMOUNT = ethers.utils.parseEther("100")
  const RELEASE_AMOUNT = ethers.utils.parseEther("50")

  beforeEach(async function () {
    ;[owner, user1, user2, router, rmnProxy, rebalancer] =
      await ethers.getSigners()

    // Deploy mock ERC20 token
    MockERC20 = await ethers.getContractFactory("ERC20Mock")
    mockToken = await MockERC20.deploy(
      "Mock Token",
      "MTK",
      owner.address,
      INITIAL_SUPPLY
    )
    await mockToken.deployed()

    // Deploy LockReleaseTokenPoolUpgradeable
    LockReleaseTokenPoolUpgradeable = await ethers.getContractFactory(
      "LockReleaseTokenPoolUpgradeable"
    )
    lockReleasePool = await upgrades.deployProxy(
      LockReleaseTokenPoolUpgradeable,
      [
        mockToken.address,
        18, // tokenDecimals
        [], // allowlist
        rmnProxy.address,
        true, // acceptLiquidity
        router.address,
      ]
    )
    await lockReleasePool.deployed()

    // Transfer some tokens to users
    await mockToken.transfer(user1.address, ethers.utils.parseEther("1000"))
    await mockToken.transfer(user2.address, ethers.utils.parseEther("1000"))
  })

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await lockReleasePool.getToken()).to.equal(mockToken.address)
      expect(await lockReleasePool.canAcceptLiquidity()).to.be.true
      expect(await lockReleasePool.getRouter()).to.equal(router.address)
      expect(await lockReleasePool.getRmnProxy()).to.equal(rmnProxy.address)
      expect(await lockReleasePool.owner()).to.equal(owner.address)
      expect(await lockReleasePool.getTokenDecimals()).to.equal(18)
    })

    it("Should revert if initialized with zero addresses", async function () {
      const newPool = await ethers.getContractFactory(
        "LockReleaseTokenPoolUpgradeable"
      )
      await expect(
        upgrades.deployProxy(newPool, [
          ethers.constants.AddressZero,
          18,
          [],
          rmnProxy.address,
          true,
          router.address,
        ])
      ).to.be.revertedWith("ZeroAddressNotAllowed")
    })

    it("Should initialize with allowlist when provided", async function () {
      const allowlistPool = await ethers.getContractFactory(
        "LockReleaseTokenPoolUpgradeable"
      )
      const poolWithAllowlist = await upgrades.deployProxy(allowlistPool, [
        mockToken.address,
        18,
        [user1.address, user2.address], // allowlist
        rmnProxy.address,
        true,
        router.address,
      ])

      // Just check that it deployed successfully
      expect(await poolWithAllowlist.getToken()).to.equal(mockToken.address)
    })
  })

  describe("Token Support", function () {
    it("Should support the correct token", async function () {
      expect(await lockReleasePool.isSupportedToken(mockToken.address)).to.be
        .true
      expect(
        await lockReleasePool.isSupportedToken(ethers.constants.AddressZero)
      ).to.be.false
    })

    it("Should have correct token decimals", async function () {
      expect(await lockReleasePool.getTokenDecimals()).to.equal(18)
    })
  })

  describe("Core Operations", function () {
    it("Should lock tokens", async function () {
      const lockAmount = ethers.utils.parseEther("100")
      await mockToken
        .connect(user1)
        .approve(lockReleasePool.address, lockAmount)

      await expect(lockReleasePool.connect(user1).lockOrBurn(lockAmount))
        .to.emit(lockReleasePool, "Locked")
        .withArgs(user1.address, lockAmount)

      expect(await mockToken.balanceOf(lockReleasePool.address)).to.equal(
        lockAmount
      )
    })

    it("Should release tokens", async function () {
      // First lock some tokens
      const lockAmount = ethers.utils.parseEther("100")
      await mockToken
        .connect(user1)
        .approve(lockReleasePool.address, lockAmount)
      await lockReleasePool.connect(user1).lockOrBurn(lockAmount)

      // Then release tokens
      const releaseAmount = ethers.utils.parseEther("50")
      const initialBalance = await mockToken.balanceOf(user2.address)

      await expect(
        lockReleasePool
          .connect(owner)
          .releaseOrMint(user2.address, releaseAmount)
      )
        .to.emit(lockReleasePool, "Released")
        .withArgs(owner.address, user2.address, releaseAmount)

      expect(await mockToken.balanceOf(user2.address)).to.equal(
        initialBalance.add(releaseAmount)
      )
    })

    it("Should revert lock with zero amount", async function () {
      await expect(
        lockReleasePool.connect(user1).lockOrBurn(0)
      ).to.be.revertedWith("Amount must be greater than 0")
    })

    it("Should revert release with zero amount", async function () {
      await expect(
        lockReleasePool.connect(owner).releaseOrMint(user2.address, 0)
      ).to.be.revertedWith("Amount must be greater than 0")
    })

    it("Should revert release to zero address", async function () {
      await expect(
        lockReleasePool
          .connect(owner)
          .releaseOrMint(ethers.constants.AddressZero, 100)
      ).to.be.revertedWith("ZeroAddressNotAllowed")
    })
  })

  describe("Router Management", function () {
    it("Should set router", async function () {
      await expect(lockReleasePool.connect(owner).setRouter(user2.address))
        .to.emit(lockReleasePool, "RouterUpdated")
        .withArgs(router.address, user2.address)

      expect(await lockReleasePool.getRouter()).to.equal(user2.address)
    })

    it("Should revert setting router to zero address", async function () {
      await expect(
        lockReleasePool.connect(owner).setRouter(ethers.constants.AddressZero)
      ).to.be.revertedWith("ZeroAddressNotAllowed")
    })
  })

  describe("Rebalancer Management", function () {
    it("Should set rebalancer", async function () {
      await expect(
        lockReleasePool.connect(owner).setRebalancer(rebalancer.address)
      )
        .to.emit(lockReleasePool, "RebalancerSet")
        .withArgs(rebalancer.address)

      expect(await lockReleasePool.getRebalancer()).to.equal(rebalancer.address)
    })
  })

  describe("Liquidity Management", function () {
    it("Should allow providing liquidity when enabled", async function () {
      const liquidityAmount = ethers.utils.parseEther("100")
      await mockToken
        .connect(user1)
        .approve(lockReleasePool.address, liquidityAmount)

      await expect(
        lockReleasePool.connect(user1).provideLiquidity(liquidityAmount)
      )
        .to.emit(lockReleasePool, "LiquidityAdded")
        .withArgs(user1.address, liquidityAmount)

      expect(await mockToken.balanceOf(lockReleasePool.address)).to.equal(
        liquidityAmount
      )
    })

    it("Should allow withdrawing liquidity", async function () {
      // First provide liquidity
      const liquidityAmount = ethers.utils.parseEther("100")
      await mockToken
        .connect(user1)
        .approve(lockReleasePool.address, liquidityAmount)
      await lockReleasePool.connect(user1).provideLiquidity(liquidityAmount)

      // Then withdraw
      const withdrawAmount = ethers.utils.parseEther("50")
      await expect(
        lockReleasePool.connect(user1).withdrawLiquidity(withdrawAmount)
      )
        .to.emit(lockReleasePool, "LiquidityRemoved")
        .withArgs(user1.address, withdrawAmount)

      expect(await mockToken.balanceOf(lockReleasePool.address)).to.equal(
        liquidityAmount.sub(withdrawAmount)
      )
    })

    it("Should transfer liquidity from old pool", async function () {
      // Deploy old pool
      const oldPool = await ethers.getContractFactory(
        "LockReleaseTokenPoolUpgradeable"
      )
      const oldPoolInstance = await upgrades.deployProxy(oldPool, [
        mockToken.address,
        18,
        [],
        rmnProxy.address,
        true,
        router.address,
      ])

      // Add liquidity to old pool
      const liquidityAmount = ethers.utils.parseEther("100")
      await mockToken
        .connect(user1)
        .approve(oldPoolInstance.address, liquidityAmount)
      await oldPoolInstance.connect(user1).provideLiquidity(liquidityAmount)

      // Set new pool as rebalancer in old pool
      await oldPoolInstance
        .connect(owner)
        .setRebalancer(lockReleasePool.address)

      // Transfer liquidity
      await expect(
        lockReleasePool
          .connect(owner)
          .transferLiquidity(oldPoolInstance.address, liquidityAmount)
      )
        .to.emit(lockReleasePool, "LiquidityTransferred")
        .withArgs(oldPoolInstance.address, liquidityAmount)
    })
  })

  describe("Utility Functions", function () {
    it("Should return correct version", async function () {
      expect(await lockReleasePool.version()).to.equal("2.0.0-upgradeable")
    })

    it("Should return correct type and version", async function () {
      expect(await lockReleasePool.typeAndVersion()).to.equal(
        "LockReleaseTokenPoolUpgradeable 2.0.0"
      )
    })
  })

  describe("Upgradeability", function () {
    it("Should be upgradeable", async function () {
      // Deploy new implementation
      const LockReleaseTokenPoolUpgradeableV2 = await ethers.getContractFactory(
        "LockReleaseTokenPoolUpgradeable"
      )

      await expect(
        upgrades.upgradeProxy(
          lockReleasePool.address,
          LockReleaseTokenPoolUpgradeableV2
        )
      ).to.not.be.reverted

      // Verify the contract still works after upgrade
      expect(await lockReleasePool.getToken()).to.equal(mockToken.address)
      expect(await lockReleasePool.getRouter()).to.equal(router.address)
    })
  })

  describe("Error Handling", function () {
    it("Should revert unauthorized operations", async function () {
      await expect(
        lockReleasePool.connect(user1).setRouter(user2.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("Should revert insufficient liquidity", async function () {
      await expect(
        lockReleasePool
          .connect(user1)
          .withdrawLiquidity(ethers.utils.parseEther("1000"))
      ).to.be.revertedWith("InsufficientLiquidity")
    })

    it("Should revert when liquidity not accepted", async function () {
      // Deploy pool with liquidity disabled
      const disabledPool = await ethers.getContractFactory(
        "LockReleaseTokenPoolUpgradeable"
      )
      const poolWithoutLiquidity = await upgrades.deployProxy(disabledPool, [
        mockToken.address,
        18,
        [],
        rmnProxy.address,
        false, // acceptLiquidity = false
        router.address,
      ])

      const liquidityAmount = ethers.utils.parseEther("100")
      await mockToken
        .connect(user1)
        .approve(poolWithoutLiquidity.address, liquidityAmount)

      await expect(
        poolWithoutLiquidity.connect(user1).provideLiquidity(liquidityAmount)
      ).to.be.revertedWith("LiquidityNotAccepted")
    })
  })
})
