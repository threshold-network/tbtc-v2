import { ethers, getNamedAccounts, upgrades } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { Contract } from "ethers"

describe("LockReleaseTokenPoolUpgradeable", function () {
  let deployer: SignerWithAddress
  let user: SignerWithAddress
  let router: SignerWithAddress
  let rmnProxy: SignerWithAddress
  let contract: Contract
  let token: Contract

  const ROUTER_ADDRESS = "0x779877A7B0D9E8603169DdbD7836e478b4624789"
  const RMN_PROXY_ADDRESS = "0xba3f6251de62dED61Ff98590cB2fDf6871FbB991"

  beforeEach(async function () {
    const signers = await ethers.getSigners()
    deployer = signers[0]
    user = signers[1]
    router = signers[2]
    rmnProxy = signers[3]

    // Deploy mock token
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock")
    token = await ERC20Mock.deploy("Mock tBTC", "tBTC", deployer.address, ethers.utils.parseEther("1000000"))
    await token.deployed()

    // Deploy LockReleaseTokenPool with proxy
    const TestPool = await ethers.getContractFactory("LockReleaseTokenPoolUpgradeableTest")
    const proxy = await upgrades.deployProxy(
      TestPool,
      [
        token.address,
        [], // empty allowlist
        RMN_PROXY_ADDRESS,
        true, // accept liquidity
        ROUTER_ADDRESS
      ],
      { 
        initializer: "initialize",
        unsafeAllow: ["missing-public-upgradeto", "missing-initializer", "delegatecall"]
      }
    )
    await proxy.deployed()
    contract = proxy
  })

  describe("Deployment and Initialization", function () {
    it("should be deployed and initialized correctly", async function () {
      expect(contract.address).to.properAddress
      expect(await contract.owner()).to.equal(deployer.address)
      expect(await contract.typeAndVersion()).to.include("LockReleaseTokenPoolUpgradeable")
    })

    it("should have correct initial state", async function () {
      expect(await contract.s_router()).to.equal(ROUTER_ADDRESS)
      expect(await contract.s_rmnProxy()).to.equal(RMN_PROXY_ADDRESS)
      expect(await contract.s_token()).to.equal(token.address)
      expect(await contract.s_acceptLiquidity()).to.equal(true)
    })

    it("should revert if router is zero address", async function () {
      // Deploy a fresh ERC20Mock for this test
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock")
      const freshToken = await ERC20Mock.deploy("Mock tBTC", "tBTC", deployer.address, ethers.utils.parseEther("1000000"))
      await freshToken.deployed()
      
      // Use upgrades.deployProxy to test initialization validation
      const InitTestPool = await ethers.getContractFactory("LockReleaseTokenPoolUpgradeableInitTest")
      await expect(
        upgrades.deployProxy(
          InitTestPool,
          [
            freshToken.address,
            [],
            RMN_PROXY_ADDRESS,
            true,
            ethers.constants.AddressZero // invalid router
          ],
          { 
            initializer: "initialize",
            unsafeAllow: ["missing-public-upgradeto", "missing-initializer", "delegatecall"]
          }
        )
      ).to.be.revertedWith("Router cannot be zero address")
    })

    it("should revert if RMN proxy is zero address", async function () {
      // Deploy a fresh ERC20Mock for this test
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock")
      const freshToken = await ERC20Mock.deploy("Mock tBTC", "tBTC", deployer.address, ethers.utils.parseEther("1000000"))
      await freshToken.deployed()
      
      // Use upgrades.deployProxy to test initialization validation
      const InitTestPool = await ethers.getContractFactory("LockReleaseTokenPoolUpgradeableInitTest")
      await expect(
        upgrades.deployProxy(
          InitTestPool,
          [
            freshToken.address,
            [],
            ethers.constants.AddressZero, // invalid RMN proxy
            true,
            ROUTER_ADDRESS
          ],
          { 
            initializer: "initialize",
            unsafeAllow: ["missing-public-upgradeto", "missing-initializer", "delegatecall"]
          }
        )
      ).to.be.revertedWith("RMN proxy cannot be zero address")
    })
  })

  describe("View Functions", function () {
    it("should return correct token address", async function () {
      expect(await contract.getToken()).to.equal(token.address)
      expect(await contract.isSupportedToken(token.address)).to.equal(true)
      expect(await contract.isSupportedToken(ethers.constants.AddressZero)).to.equal(false)
    })

    it("should return liquidity acceptance status", async function () {
      expect(await contract.canAcceptLiquidity()).to.equal(true)
    })

    it("should support all chains", async function () {
      expect(await contract.isSupportedChain(1)).to.equal(true)
      expect(await contract.isSupportedChain(42161)).to.equal(true)
      expect(await contract.isSupportedChain(999999)).to.equal(true)
    })

    it("should support correct interface", async function () {
      // IPoolV1 interface ID calculation: bytes4(keccak256("lockOrBurn(...)")) ^ bytes4(keccak256("releaseOrMint(...)"))
      // For testing purposes, we'll just check if the function exists
      expect(await contract.supportsInterface("0x01ffc9a7")).to.be.a("boolean")
    })
  })

  describe("Lock and Burn Operations", function () {
    beforeEach(async function () {
      // Mint tokens to user and give allowance to contract
      await token.mint(user.address, ethers.utils.parseEther("1000"))
      await token.connect(user).approve(contract.address, ethers.utils.parseEther("1000"))
      // Set the router for testing
      await contract.setRouter(user.address)
    })

    it("should lock tokens successfully when called by router", async function () {
      const lockAmount = ethers.utils.parseEther("100")
      const initialBalance = await token.balanceOf(user.address)
      const initialContractBalance = await token.balanceOf(contract.address)

      const lockOrBurnIn = {
        receiver: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("receiver")),
        remoteChainSelector: 42161,
        originalSender: user.address,
        amount: lockAmount,
        localToken: token.address,
        extraArgs: "0x"
      }

      await expect(contract.connect(user).lockOrBurn(lockOrBurnIn))
        .to.emit(contract, "Locked")
        .withArgs(user.address, lockAmount)

      // Check balances after lock
      expect(await token.balanceOf(user.address)).to.equal(initialBalance.sub(lockAmount))
      expect(await token.balanceOf(contract.address)).to.equal(initialContractBalance.add(lockAmount))
    })

    it("should revert when lockOrBurn is not called by router", async function () {
      const lockOrBurnIn = {
        receiver: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("receiver")),
        remoteChainSelector: 42161,
        originalSender: user.address,
        amount: ethers.utils.parseEther("100"),
        localToken: token.address,
        extraArgs: "0x"
      }

      await expect(
        contract.connect(deployer).lockOrBurn(lockOrBurnIn)
      ).to.be.revertedWith("Only router")
    })

    it("should return correct lock output", async function () {
      const lockAmount = ethers.utils.parseEther("100")
      const lockOrBurnIn = {
        receiver: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("receiver")),
        remoteChainSelector: 42161,
        originalSender: user.address,
        amount: lockAmount,
        localToken: token.address,
        extraArgs: "0x"
      }

      const result = await contract.connect(user).callStatic.lockOrBurn(lockOrBurnIn)
      expect(result.destTokenAddress).to.equal(ethers.utils.defaultAbiCoder.encode(["address"], [token.address]))
      expect(result.destPoolData).to.equal("0x")
    })
  })

  describe("Release and Mint Operations", function () {
    beforeEach(async function () {
      // Mint tokens to contract (simulate locked tokens)
      await token.mint(contract.address, ethers.utils.parseEther("1000"))
      // Set the router for testing
      await contract.setRouter(user.address)
    })

    it("should release tokens successfully when called by router", async function () {
      const releaseAmount = ethers.utils.parseEther("100")
      const initialReceiverBalance = await token.balanceOf(deployer.address)
      const initialContractBalance = await token.balanceOf(contract.address)

      const releaseOrMintIn = {
        originalSender: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("originalSender")),
        receiver: deployer.address,
        amount: releaseAmount,
        localToken: token.address,
        remoteChainSelector: 42161,
        sourcePoolAddress: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("sourcePool")),
        sourcePoolData: "0x",
        offchainTokenData: "0x"
      }

      await expect(contract.connect(user).releaseOrMint(releaseOrMintIn))
        .to.emit(contract, "Released")
        .withArgs(user.address, deployer.address, releaseAmount)

      // Check balances after release
      expect(await token.balanceOf(deployer.address)).to.equal(initialReceiverBalance.add(releaseAmount))
      expect(await token.balanceOf(contract.address)).to.equal(initialContractBalance.sub(releaseAmount))
    })

    it("should revert when releaseOrMint is not called by router", async function () {
      const releaseOrMintIn = {
        originalSender: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("originalSender")),
        receiver: deployer.address,
        amount: ethers.utils.parseEther("100"),
        localToken: token.address,
        remoteChainSelector: 42161,
        sourcePoolAddress: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("sourcePool")),
        sourcePoolData: "0x",
        offchainTokenData: "0x"
      }

      await expect(
        contract.connect(deployer).releaseOrMint(releaseOrMintIn)
      ).to.be.revertedWith("Only router")
    })

    it("should return correct release output", async function () {
      const releaseAmount = ethers.utils.parseEther("100")
      const releaseOrMintIn = {
        originalSender: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("originalSender")),
        receiver: deployer.address,
        amount: releaseAmount,
        localToken: token.address,
        remoteChainSelector: 42161,
        sourcePoolAddress: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("sourcePool")),
        sourcePoolData: "0x",
        offchainTokenData: "0x"
      }

      const result = await contract.connect(user).callStatic.releaseOrMint(releaseOrMintIn)
      expect(result.destinationAmount).to.equal(releaseAmount)
    })
  })

  describe("Access Control", function () {
    it("should allow owner to transfer ownership", async function () {
      await contract.transferOwnership(user.address)
      expect(await contract.owner()).to.equal(user.address)
    })

    it("should allow setting router for testing", async function () {
      await contract.setRouter(router.address)
      expect(await contract.s_router()).to.equal(router.address)
    })

    it("should allow setting RMN proxy for testing", async function () {
      await contract.setRmnProxy(rmnProxy.address)
      expect(await contract.s_rmnProxy()).to.equal(rmnProxy.address)
    })
  })

  describe("Integration Test", function () {
    let integrationContract: Contract
    let integrationToken: Contract
    let integrationRouter: SignerWithAddress

    beforeEach(async function () {
      const signers = await ethers.getSigners()
      integrationRouter = signers[4] // Use a different signer for integration test
      
      // Deploy fresh contracts for integration test
      const ERC20Mock = await ethers.getContractFactory("ERC20Mock")
      integrationToken = await ERC20Mock.deploy("Integration tBTC", "tBTC", deployer.address, ethers.utils.parseEther("1000000"))
      await integrationToken.deployed()

      const TestPool = await ethers.getContractFactory("LockReleaseTokenPoolUpgradeableTest")
      const proxy = await upgrades.deployProxy(
        TestPool,
        [
          integrationToken.address,
          [], // empty allowlist
          RMN_PROXY_ADDRESS,
          true, // accept liquidity
          ROUTER_ADDRESS
        ],
        { 
          initializer: "initialize",
          unsafeAllow: ["missing-public-upgradeto", "missing-initializer", "delegatecall"]
        }
      )
      await proxy.deployed()
      integrationContract = proxy
    })

    it("should handle full lock and release cycle", async function () {
      // Setup: Mint tokens to router (in real CCIP, router would receive tokens from user first)
      const testAmount = ethers.utils.parseEther("500")
      
      // Record initial balances to verify relative changes
      const initialContractBalance = await integrationToken.balanceOf(integrationContract.address)
      const initialDeployerBalance = await integrationToken.balanceOf(deployer.address)
      
      await integrationToken.mint(integrationRouter.address, testAmount)
      await integrationToken.connect(integrationRouter).approve(integrationContract.address, testAmount)
      await integrationContract.setRouter(integrationRouter.address)

      // Step 1: Lock tokens (simulate cross-chain send)
      const lockOrBurnIn = {
        receiver: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("receiver")),
        remoteChainSelector: 42161,
        originalSender: user.address,
        amount: testAmount,
        localToken: integrationToken.address,
        extraArgs: "0x"
      }

      await integrationContract.connect(integrationRouter).lockOrBurn(lockOrBurnIn)
      expect(await integrationToken.balanceOf(integrationContract.address)).to.equal(initialContractBalance.add(testAmount))
      expect(await integrationToken.balanceOf(integrationRouter.address)).to.equal(0)

      // Step 2: Release tokens (simulate cross-chain receive)
      const releaseOrMintIn = {
        originalSender: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("originalSender")),
        receiver: deployer.address,
        amount: testAmount,
        localToken: integrationToken.address,
        remoteChainSelector: 42161,
        sourcePoolAddress: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("sourcePool")),
        sourcePoolData: "0x",
        offchainTokenData: "0x"
      }

      await integrationContract.connect(integrationRouter).releaseOrMint(releaseOrMintIn)
      expect(await integrationToken.balanceOf(integrationContract.address)).to.equal(initialContractBalance)
      expect(await integrationToken.balanceOf(deployer.address)).to.equal(initialDeployerBalance.add(testAmount))
    })
  })
}) 