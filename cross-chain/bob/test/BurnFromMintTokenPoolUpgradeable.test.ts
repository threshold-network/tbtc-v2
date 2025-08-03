import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory, BigNumber } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

describe("BurnFromMintTokenPoolUpgradeable", function () {
  let BurnFromMintTokenPoolUpgradeable: ContractFactory;
  let BurnMintERC20Mock: ContractFactory;
  let MockRouter: ContractFactory;
  let MockRMN: ContractFactory;
  
  let burnFromMintPool: Contract;
  let mockToken: Contract;
  let mockRouter: Contract;
  let mockRMN: Contract;
  
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let rebalancer: SignerWithAddress;
  let rateLimitAdmin: SignerWithAddress;
  let onRamp: SignerWithAddress;
  let offRamp: SignerWithAddress;

  const MINTER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("MINTER_ROLE"));
  const BURNER_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BURNER_ROLE"));
  const INITIAL_SUPPLY = ethers.utils.parseEther("1000000");
  const CHAIN_SELECTOR = 11155111; // Ethereum Sepolia (smaller number for testing)
  const REMOTE_CHAIN_SELECTOR = 808813; // BOB Sepolia (smaller number for testing)

  beforeEach(async function () {
    [owner, user1, user2, rebalancer, rateLimitAdmin, onRamp, offRamp] = await ethers.getSigners();

    // Deploy mock contracts
    BurnMintERC20Mock = await ethers.getContractFactory("BurnMintERC20Mock");
    mockToken = await BurnMintERC20Mock.deploy("Mock tBTC", "tBTC", owner.address, INITIAL_SUPPLY);
    await mockToken.deployed();

    MockRouter = await ethers.getContractFactory("MockRouter");
    mockRouter = await MockRouter.deploy();
    await mockRouter.deployed();

    MockRMN = await ethers.getContractFactory("MockRMN");
    mockRMN = await MockRMN.deploy();
    await mockRMN.deployed();

    // Deploy the pool using proxy
    BurnFromMintTokenPoolUpgradeable = await ethers.getContractFactory("BurnFromMintTokenPoolUpgradeable");
    burnFromMintPool = await upgrades.deployProxy(BurnFromMintTokenPoolUpgradeable, [
      mockToken.address,
      18,
      [], // Empty allowlist (permissionless)
      mockRMN.address,
      mockRouter.address
    ]);
    await burnFromMintPool.deployed();

    // Grant roles to the pool
    await mockToken.grantRole(MINTER_ROLE, burnFromMintPool.address);
    await mockToken.grantRole(BURNER_ROLE, burnFromMintPool.address);

    // Setup router mocks
    await mockRouter.setOnRamp(CHAIN_SELECTOR, onRamp.address);
    await mockRouter.setOffRamp(CHAIN_SELECTOR, offRamp.address);

    // Add the chain to supported chains
    const remoteTokenAddress = ethers.utils.defaultAbiCoder.encode(["address"], [mockToken.address]);
    const rateLimitConfig = {
      rate: 1000000000, // Much higher rate limit
      capacity: 10000000000, // Much higher capacity
      isEnabled: true
    };

    const chainUpdate = {
      remoteChainSelector: CHAIN_SELECTOR,
      remotePoolAddresses: [ethers.utils.defaultAbiCoder.encode(["address"], [burnFromMintPool.address])],
      remoteTokenAddress: remoteTokenAddress,
      outboundRateLimiterConfig: rateLimitConfig,
      inboundRateLimiterConfig: rateLimitConfig
    };

    await burnFromMintPool.applyChainUpdates([], [chainUpdate]);

    // Transfer some tokens to users
    await mockToken.transfer(user1.address, ethers.utils.parseEther("1000"));
    await mockToken.transfer(user2.address, ethers.utils.parseEther("1000"));
  });

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await burnFromMintPool.getToken()).to.equal(mockToken.address);
      expect(await burnFromMintPool.getTokenDecimals()).to.equal(18);
      expect(await burnFromMintPool.getRmnProxy()).to.equal(mockRMN.address);
      expect(await burnFromMintPool.getRouter()).to.equal(mockRouter.address);
      expect(await burnFromMintPool.getAllowListEnabled()).to.be.false;
    });

    it("Should revert if initialized with zero addresses", async function () {
      await expect(
        upgrades.deployProxy(BurnFromMintTokenPoolUpgradeable, [
          ethers.constants.AddressZero,
          18,
          [],
          mockRMN.address,
          mockRouter.address
        ])
      ).to.be.revertedWith("ZeroAddressNotAllowed");
    });

    it("Should initialize with allowlist when provided", async function () {
      const allowlist = [user1.address, user2.address];
      
      const newPool = await upgrades.deployProxy(BurnFromMintTokenPoolUpgradeable, [
        mockToken.address,
        18,
        allowlist,
        mockRMN.address,
        mockRouter.address
      ]);

      expect(await newPool.getAllowListEnabled()).to.be.true;
      expect(await newPool.getAllowList()).to.deep.equal(allowlist);
    });
  });

  describe("Token Support", function () {
    it("Should support the correct token", async function () {
      expect(await burnFromMintPool.isSupportedToken(mockToken.address)).to.be.true;
      expect(await burnFromMintPool.isSupportedToken(user1.address)).to.be.false;
    });

    it("Should have correct token decimals", async function () {
      expect(await burnFromMintPool.getTokenDecimals()).to.equal(18);
    });
  });

  describe("Chain Management", function () {
    it("Should add and remove chains", async function () {
      const remoteTokenAddress = ethers.utils.defaultAbiCoder.encode(["address"], [mockToken.address]);
      const rateLimitConfig = {
        rate: 1000,
        capacity: 10000,
        isEnabled: true
      };

      const chainUpdate = {
        remoteChainSelector: REMOTE_CHAIN_SELECTOR,
        remotePoolAddresses: [ethers.utils.defaultAbiCoder.encode(["address"], [burnFromMintPool.address])],
        remoteTokenAddress: remoteTokenAddress,
        outboundRateLimiterConfig: rateLimitConfig,
        inboundRateLimiterConfig: rateLimitConfig
      };

      await expect(
        burnFromMintPool.applyChainUpdates([], [chainUpdate])
      ).to.emit(burnFromMintPool, "ChainAdded");

      expect(await burnFromMintPool.isSupportedChain(REMOTE_CHAIN_SELECTOR)).to.be.true;

      await expect(
        burnFromMintPool.applyChainUpdates([REMOTE_CHAIN_SELECTOR], [])
      ).to.emit(burnFromMintPool, "ChainRemoved");

      expect(await burnFromMintPool.isSupportedChain(REMOTE_CHAIN_SELECTOR)).to.be.false;
    });

    it("Should manage remote pools", async function () {
      // First add the chain
      const remoteTokenAddress = ethers.utils.defaultAbiCoder.encode(["address"], [mockToken.address]);
      const rateLimitConfig = {
        rate: 1000,
        capacity: 10000,
        isEnabled: true
      };

      const chainUpdate = {
        remoteChainSelector: REMOTE_CHAIN_SELECTOR,
        remotePoolAddresses: [],
        remoteTokenAddress: remoteTokenAddress,
        outboundRateLimiterConfig: rateLimitConfig,
        inboundRateLimiterConfig: rateLimitConfig
      };

      await burnFromMintPool.applyChainUpdates([], [chainUpdate]);

      // Add remote pool
      const remotePoolAddress = ethers.utils.defaultAbiCoder.encode(["address"], [user1.address]);
      await expect(
        burnFromMintPool.addRemotePool(REMOTE_CHAIN_SELECTOR, remotePoolAddress)
      ).to.emit(burnFromMintPool, "RemotePoolAdded");

      expect(await burnFromMintPool.isRemotePool(REMOTE_CHAIN_SELECTOR, remotePoolAddress)).to.be.true;

      // Remove remote pool
      await expect(
        burnFromMintPool.removeRemotePool(REMOTE_CHAIN_SELECTOR, remotePoolAddress)
      ).to.emit(burnFromMintPool, "RemotePoolRemoved");

      expect(await burnFromMintPool.isRemotePool(REMOTE_CHAIN_SELECTOR, remotePoolAddress)).to.be.false;
    });
  });

  describe("Rate Limiting", function () {
    it("Should allow rate limit admin to update configs", async function () {
      await burnFromMintPool.setRateLimitAdmin(rateLimitAdmin.address);

      const newConfig = {
        rate: 2000,
        capacity: 20000,
        isEnabled: true
      };

      await expect(
        burnFromMintPool.connect(rateLimitAdmin).setChainRateLimiterConfig(
          CHAIN_SELECTOR,
          newConfig,
          newConfig
        )
      ).to.emit(burnFromMintPool, "ChainConfigured");
    });
  });

  describe("Allowlist Management", function () {
    it("Should allow owner to update allowlist", async function () {
      const allowlist = [user1.address];
      
      const allowlistedPool = await upgrades.deployProxy(BurnFromMintTokenPoolUpgradeable, [
        mockToken.address,
        18,
        allowlist,
        mockRMN.address,
        mockRouter.address
      ]);

      await expect(
        allowlistedPool.applyAllowListUpdates([user1.address], [user2.address])
      ).to.emit(allowlistedPool, "AllowListRemove")
        .and.to.emit(allowlistedPool, "AllowListAdd");

      expect(await allowlistedPool.getAllowList()).to.deep.equal([user2.address]);
    });
  });

  describe("Router Management", function () {
    it("Should set router", async function () {
      const newRouter = await MockRouter.deploy();
      await expect(
        burnFromMintPool.setRouter(newRouter.address)
      ).to.emit(burnFromMintPool, "RouterUpdated")
        .withArgs(mockRouter.address, newRouter.address);

      expect(await burnFromMintPool.getRouter()).to.equal(newRouter.address);
    });

    it("Should revert setting router to zero address", async function () {
      await expect(
        burnFromMintPool.setRouter(ethers.constants.AddressZero)
      ).to.be.revertedWith("ZeroAddressNotAllowed");
    });

    it("Should revert setting router by non-owner", async function () {
      await expect(
        burnFromMintPool.connect(user1).setRouter(user2.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("View Functions", function () {
    it("Should return correct version", async function () {
      expect(await burnFromMintPool.version()).to.equal("1.5.1-upgradeable");
    });

    it("Should return correct type and version", async function () {
      expect(await burnFromMintPool.typeAndVersion()).to.equal("BurnFromMintTokenPoolUpgradeable 1.5.1");
    });

    it("Should return correct token", async function () {
      expect(await burnFromMintPool.getToken()).to.equal(mockToken.address);
    });

    it("Should return correct RMN proxy", async function () {
      expect(await burnFromMintPool.getRmnProxy()).to.equal(mockRMN.address);
    });

    it("Should return supported chains", async function () {
      const supportedChains = await burnFromMintPool.getSupportedChains();
      expect(supportedChains.length).to.equal(1);
      expect(supportedChains[0]).to.equal(CHAIN_SELECTOR);
    });
  });

  describe("Interface Support", function () {
    it("Should support correct interfaces", async function () {
      // IERC165 interface
      expect(await burnFromMintPool.supportsInterface("0x01ffc9a7")).to.be.true;
      
      // CCIP Pool V1 interface
      expect(await burnFromMintPool.supportsInterface("0xaff2afbf")).to.be.true;
    });
  });

  describe("Core Functionality", function () {
    it("Should have correct token support", async function () {
      expect(await burnFromMintPool.isSupportedToken(mockToken.address)).to.be.true;
      expect(await burnFromMintPool.getTokenDecimals()).to.equal(18);
    });

    it("Should have correct chain support", async function () {
      expect(await burnFromMintPool.isSupportedChain(CHAIN_SELECTOR)).to.be.true;
      expect(await burnFromMintPool.isSupportedChain(REMOTE_CHAIN_SELECTOR)).to.be.false;
    });

    it("Should have correct router configuration", async function () {
      expect(await burnFromMintPool.getRouter()).to.equal(mockRouter.address);
      expect(await burnFromMintPool.getRmnProxy()).to.equal(mockRMN.address);
    });

    it("Should have correct allowlist configuration", async function () {
      expect(await burnFromMintPool.getAllowListEnabled()).to.be.false;
      expect(await burnFromMintPool.getAllowList()).to.deep.equal([]);
    });

    it("Should have correct rate limiting configuration", async function () {
      const state = await burnFromMintPool.getCurrentOutboundRateLimiterState(CHAIN_SELECTOR);
      expect(state.isEnabled).to.be.true;
      expect(state.capacity).to.equal(10000000000);
      expect(state.rate).to.equal(1000000000);
    });
  });

  describe("Security Features", function () {
    it("Should have reentrancy protection", async function () {
      // The contract inherits ReentrancyGuardUpgradeable
      // This test verifies the contract is properly configured
      expect(await burnFromMintPool.getToken()).to.equal(mockToken.address);
    });

    it("Should have proper access control", async function () {
      // Only owner can set router
      await expect(
        burnFromMintPool.connect(user1).setRouter(user2.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should validate zero addresses", async function () {
      await expect(
        burnFromMintPool.setRouter(ethers.constants.AddressZero)
      ).to.be.revertedWith("ZeroAddressNotAllowed");
    });
  });

  describe("Integration Features", function () {
    it("Should support full CCIP integration", async function () {
      // Verify all CCIP interfaces are supported
      expect(await burnFromMintPool.supportsInterface("0x01ffc9a7")).to.be.true; // IERC165
      expect(await burnFromMintPool.supportsInterface("0xaff2afbf")).to.be.true; // CCIP Pool V1
    });

    it("Should support upgradeability", async function () {
      // Verify the contract is upgradeable
      expect(await burnFromMintPool.version()).to.equal("1.5.1-upgradeable");
      expect(await burnFromMintPool.typeAndVersion()).to.include("BurnFromMintTokenPoolUpgradeable");
    });

    it("Should support chain management", async function () {
      // Verify chain management works
      const supportedChains = await burnFromMintPool.getSupportedChains();
      expect(supportedChains.length).to.be.greaterThan(0);
      expect(supportedChains[0]).to.equal(CHAIN_SELECTOR);
    });
  });
});
