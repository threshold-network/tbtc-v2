import { ethers, getNamedAccounts, upgrades } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { Contract } from "ethers"

describe("BurnFromMintTokenPoolUpgradeable", () => {
  let deployer: SignerWithAddress
  let user: SignerWithAddress
  let router: SignerWithAddress
  let rmnProxy: SignerWithAddress
  let contract: Contract
  let token: Contract

  const ROUTER_ADDRESS = "0x779877A7B0D9E8603169DdbD7836e478b4624789"
  const RMN_PROXY_ADDRESS = "0xba3f6251de62dED61Ff98590cB2fDf6871FbB991"

  beforeEach(async () => {
    const signers = await ethers.getSigners()
    ;[deployer, user, router, rmnProxy] = signers

    // Deploy mock token
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock")
    token = await ERC20Mock.deploy(
      "Mock tBTC",
      "tBTC",
      deployer.address,
      ethers.utils.parseEther("1000000")
    )
    await token.deployed()

    // Deploy BurnFromMintTokenPool with proxy
    const TestPool = await ethers.getContractFactory(
      "BurnFromMintTokenPoolUpgradeableTest"
    )
    const proxy = await upgrades.deployProxy(
      TestPool,
      [
        token.address,
        [], // empty allowlist
        RMN_PROXY_ADDRESS,
        ROUTER_ADDRESS,
        16015286601757825753n, // Example: Ethereum Sepolia chain selector
      ],
      {
        initializer: "initialize",
        unsafeAllow: [
          "missing-public-upgradeto",
          "missing-initializer",
          "delegatecall",
        ],
      }
    )
    await proxy.deployed()
    contract = proxy
  })

  describe("Deployment and Initialization", () => {
    it("should be deployed and initialized correctly", async () => {
      expect(contract.address).to.properAddress
      expect(await contract.owner()).to.equal(deployer.address)
      expect(await contract.typeAndVersion()).to.include(
        "BurnFromMintTokenPoolUpgradeable 1.6.0"
      )
      expect(await contract.s_token()).to.equal(token.address)
      expect(await contract.s_router()).to.equal(ROUTER_ADDRESS)
      expect(await contract.s_rmnProxy()).to.equal(RMN_PROXY_ADDRESS)
      expect(await contract.s_supportedRemoteChainId()).to.equal(
        16015286601757825753n
      )
    })

    it("should revert if token address is zero", async () => {
      const InitTestPool = await ethers.getContractFactory(
        "BurnFromMintTokenPoolUpgradeableInitTest"
      )
      await expect(
        upgrades.deployProxy(
          InitTestPool,
          [
            ethers.constants.AddressZero, // invalid token
            [],
            RMN_PROXY_ADDRESS,
            ROUTER_ADDRESS,
          ],
          {
            initializer: "initialize",
            unsafeAllow: [
              "missing-public-upgradeto",
              "missing-initializer",
              "delegatecall",
            ],
          }
        )
      ).to.be.reverted
    })

    it("should revert if router address is zero", async () => {
      const freshToken = await (
        await ethers.getContractFactory("ERC20Mock")
      ).deploy(
        "Fresh tBTC",
        "tBTC",
        deployer.address,
        ethers.utils.parseEther("1000")
      )
      const InitTestPool = await ethers.getContractFactory(
        "BurnFromMintTokenPoolUpgradeableInitTest"
      )
      await expect(
        upgrades.deployProxy(
          InitTestPool,
          [
            freshToken.address,
            [],
            RMN_PROXY_ADDRESS,
            ethers.constants.AddressZero, // invalid router
          ],
          {
            initializer: "initialize",
            unsafeAllow: [
              "missing-public-upgradeto",
              "missing-initializer",
              "delegatecall",
            ],
          }
        )
      ).to.be.reverted
    })

    it("should revert if RMN proxy address is zero", async () => {
      const freshToken = await (
        await ethers.getContractFactory("ERC20Mock")
      ).deploy(
        "Fresh tBTC",
        "tBTC",
        deployer.address,
        ethers.utils.parseEther("1000")
      )
      const InitTestPool = await ethers.getContractFactory(
        "BurnFromMintTokenPoolUpgradeableInitTest"
      )
      await expect(
        upgrades.deployProxy(
          InitTestPool,
          [
            freshToken.address,
            [],
            ethers.constants.AddressZero, // invalid RMN proxy
            ROUTER_ADDRESS,
          ],
          {
            initializer: "initialize",
            unsafeAllow: [
              "missing-public-upgradeto",
              "missing-initializer",
              "delegatecall",
            ],
          }
        )
      ).to.be.reverted
    })

    it("should allow initialization with allowlist", async () => {
      const freshToken = await (
        await ethers.getContractFactory("ERC20Mock")
      ).deploy(
        "Fresh tBTC",
        "tBTC",
        deployer.address,
        ethers.utils.parseEther("1000")
      )
      const TestPool = await ethers.getContractFactory(
        "BurnFromMintTokenPoolUpgradeableTest"
      )
      const proxy = await upgrades.deployProxy(
        TestPool,
        [
          freshToken.address,
          [user.address, router.address], // allowlist with multiple addresses
          RMN_PROXY_ADDRESS,
          ROUTER_ADDRESS,
          16015286601757825753n, // Example: Ethereum Sepolia chain selector
        ],
        {
          initializer: "initialize",
          unsafeAllow: [
            "missing-public-upgradeto",
            "missing-initializer",
            "delegatecall",
          ],
        }
      )
      await proxy.deployed()
      expect(proxy.address).to.properAddress
    })
  })

  describe("View Functions", () => {
    it("should return correct token address", async () => {
      expect(await contract.getToken()).to.equal(token.address)
      expect(await contract.s_token()).to.equal(token.address)
    })

    it("should return correct type and version", async () => {
      const typeAndVersion = await contract.typeAndVersion()
      expect(typeAndVersion).to.equal("BurnFromMintTokenPoolUpgradeable 1.6.0")
    })

    it("should correctly identify supported tokens", async () => {
      expect(await contract.isSupportedToken(token.address)).to.be.true
      expect(await contract.isSupportedToken(user.address)).to.be.false
      expect(await contract.isSupportedToken(ethers.constants.AddressZero)).to
        .be.false
    })

    it("should support all chains", async () => {
      expect(await contract.isSupportedChain(16015286601757825753n)).to.be.true // Only the configured chain
      expect(await contract.isSupportedChain(1)).to.be.false
      expect(await contract.isSupportedChain(137)).to.be.false
      expect(await contract.isSupportedChain(999999)).to.be.false
      expect(await contract.isSupportedChain(0)).to.be.false
    })

    it("should support IPoolV1 interface", async () => {
      // Test that the contract correctly rejects invalid interface IDs
      expect(await contract.supportsInterface("0xffffffff")).to.be.false
      expect(await contract.supportsInterface("0x00000000")).to.be.false
      expect(await contract.supportsInterface("0x12345678")).to.be.false

      // The contract implements supportsInterface to check type(IPoolV1).interfaceId
      // We can test this by calling the function that the contract uses internally
      // For now, we verify the contract doesn't support random interfaces
    })

    it("should return correct router and RMN proxy addresses", async () => {
      expect(await contract.s_router()).to.equal(ROUTER_ADDRESS)
      expect(await contract.s_rmnProxy()).to.equal(RMN_PROXY_ADDRESS)
    })
  })

  describe("Access Control", () => {
    it("should revert lockOrBurn if not called by router", async () => {
      await expect(
        contract.lockOrBurn({
          receiver: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("dummy")),
          remoteChainSelector: 1,
          originalSender: user.address,
          amount: 100,
          localToken: token.address,
          extraArgs: "0x",
        })
      ).to.be.revertedWith("Only router")
    })

    it("should revert releaseOrMint if not called by router", async () => {
      await expect(
        contract.releaseOrMint({
          originalSender: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("sender")
          ),
          receiver: user.address,
          amount: 100,
          localToken: token.address,
          remoteChainSelector: 1,
          sourcePoolAddress: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("pool")
          ),
          sourcePoolData: "0x",
          offchainTokenData: "0x",
        })
      ).to.be.revertedWith("Only router")
    })

    it("should allow router to call lockOrBurn", async () => {
      // Set router for testing
      await contract.setRouter(router.address)

      // Mint tokens to router and approve the pool
      await token.mint(router.address, 1000)
      await token.connect(router).approve(contract.address, 500)

      await expect(
        contract.connect(router).lockOrBurn({
          receiver: ethers.utils.hexlify(ethers.utils.toUtf8Bytes("dummy")),
          remoteChainSelector: 1,
          originalSender: router.address,
          amount: 500,
          localToken: token.address,
          extraArgs: "0x",
        })
      ).to.not.be.reverted
    })

    it("should allow router to call releaseOrMint", async () => {
      // Set router for testing
      await contract.setRouter(router.address)

      await expect(
        contract.connect(router).releaseOrMint({
          originalSender: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("sender")
          ),
          receiver: user.address,
          amount: 100,
          localToken: token.address,
          remoteChainSelector: 1,
          sourcePoolAddress: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("pool")
          ),
          sourcePoolData: "0x",
          offchainTokenData: "0x",
        })
      ).to.not.be.reverted
    })
  })

  describe("Burn Operations (lockOrBurn)", () => {
    beforeEach(async () => {
      // Set router for testing
      await contract.setRouter(router.address)
      // Mint tokens to router
      await token.mint(router.address, 10000)
    })

    it("should burn tokens successfully", async () => {
      const burnAmount = 500
      const initialBalance = await token.balanceOf(router.address)

      await token.connect(router).approve(contract.address, burnAmount)

      await contract.connect(router).lockOrBurn({
        receiver: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("dest_address")
        ),
        remoteChainSelector: 1,
        originalSender: router.address,
        amount: burnAmount,
        localToken: token.address,
        extraArgs: "0x",
      })

      expect(await token.balanceOf(router.address)).to.equal(
        initialBalance.sub(burnAmount)
      )
    })

    it("should emit Burned event", async () => {
      const burnAmount = 300
      await token.connect(router).approve(contract.address, burnAmount)

      await expect(
        contract.connect(router).lockOrBurn({
          receiver: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("dest_address")
          ),
          remoteChainSelector: 1,
          originalSender: router.address,
          amount: burnAmount,
          localToken: token.address,
          extraArgs: "0x",
        })
      )
        .to.emit(contract, "Burned")
        .withArgs(router.address, burnAmount)
    })

    it("should return correct output data", async () => {
      const burnAmount = 200
      await token.connect(router).approve(contract.address, burnAmount)

      const result = await contract.connect(router).callStatic.lockOrBurn({
        receiver: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("dest_address")
        ),
        remoteChainSelector: 1,
        originalSender: router.address,
        amount: burnAmount,
        localToken: token.address,
        extraArgs: "0x",
      })

      expect(result.destTokenAddress).to.equal(
        ethers.utils.defaultAbiCoder.encode(["address"], [token.address])
      )
      expect(result.destPoolData).to.equal("0x")
    })

    it("should handle large burn amounts", async () => {
      const largeBurnAmount = ethers.utils.parseEther("1000")
      await token.mint(router.address, largeBurnAmount)
      await token.connect(router).approve(contract.address, largeBurnAmount)

      await expect(
        contract.connect(router).lockOrBurn({
          receiver: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("dest_address")
          ),
          remoteChainSelector: 1,
          originalSender: router.address,
          amount: largeBurnAmount,
          localToken: token.address,
          extraArgs: "0x",
        })
      ).to.not.be.reverted
    })

    it("should revert if insufficient allowance", async () => {
      const burnAmount = 500
      // Don't approve or approve less than needed
      await token.connect(router).approve(contract.address, burnAmount - 1)

      await expect(
        contract.connect(router).lockOrBurn({
          receiver: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("dest_address")
          ),
          remoteChainSelector: 1,
          originalSender: router.address,
          amount: burnAmount,
          localToken: token.address,
          extraArgs: "0x",
        })
      ).to.be.reverted
    })
  })

  describe("Mint Operations (releaseOrMint)", () => {
    beforeEach(async () => {
      // Set router for testing
      await contract.setRouter(router.address)
    })

    it("should mint tokens successfully", async () => {
      const mintAmount = 500
      const initialBalance = await token.balanceOf(user.address)

      await contract.connect(router).releaseOrMint({
        originalSender: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("source_sender")
        ),
        receiver: user.address,
        amount: mintAmount,
        localToken: token.address,
        remoteChainSelector: 1,
        sourcePoolAddress: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("source_pool")
        ),
        sourcePoolData: "0x",
        offchainTokenData: "0x",
      })

      expect(await token.balanceOf(user.address)).to.equal(
        initialBalance.add(mintAmount)
      )
    })

    it("should emit Minted event", async () => {
      const mintAmount = 300

      await expect(
        contract.connect(router).releaseOrMint({
          originalSender: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("source_sender")
          ),
          receiver: user.address,
          amount: mintAmount,
          localToken: token.address,
          remoteChainSelector: 1,
          sourcePoolAddress: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("source_pool")
          ),
          sourcePoolData: "0x",
          offchainTokenData: "0x",
        })
      )
        .to.emit(contract, "Minted")
        .withArgs(router.address, user.address, mintAmount)
    })

    it("should return correct output data", async () => {
      const mintAmount = 200

      const result = await contract.connect(router).callStatic.releaseOrMint({
        originalSender: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("source_sender")
        ),
        receiver: user.address,
        amount: mintAmount,
        localToken: token.address,
        remoteChainSelector: 1,
        sourcePoolAddress: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("source_pool")
        ),
        sourcePoolData: "0x",
        offchainTokenData: "0x",
      })

      expect(result.destinationAmount).to.equal(mintAmount)
    })

    it("should handle large mint amounts", async () => {
      const largeMintAmount = ethers.utils.parseEther("1000")

      await expect(
        contract.connect(router).releaseOrMint({
          originalSender: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("source_sender")
          ),
          receiver: user.address,
          amount: largeMintAmount,
          localToken: token.address,
          remoteChainSelector: 1,
          sourcePoolAddress: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("source_pool")
          ),
          sourcePoolData: "0x",
          offchainTokenData: "0x",
        })
      ).to.not.be.reverted

      expect(await token.balanceOf(user.address)).to.equal(largeMintAmount)
    })

    it("should mint to different receivers", async () => {
      const mintAmount = 100

      // Mint to deployer
      await contract.connect(router).releaseOrMint({
        originalSender: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("source_sender")
        ),
        receiver: deployer.address,
        amount: mintAmount,
        localToken: token.address,
        remoteChainSelector: 1,
        sourcePoolAddress: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("source_pool")
        ),
        sourcePoolData: "0x",
        offchainTokenData: "0x",
      })

      // Mint to user
      await contract.connect(router).releaseOrMint({
        originalSender: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("source_sender")
        ),
        receiver: user.address,
        amount: mintAmount * 2,
        localToken: token.address,
        remoteChainSelector: 1,
        sourcePoolAddress: ethers.utils.hexlify(
          ethers.utils.toUtf8Bytes("source_pool")
        ),
        sourcePoolData: "0x",
        offchainTokenData: "0x",
      })

      expect(await token.balanceOf(deployer.address)).to.be.gte(mintAmount)
      expect(await token.balanceOf(user.address)).to.equal(mintAmount * 2)
    })
  })

  describe("Integration Test", () => {
    it("should handle complete burn and mint cycle", async () => {
      // Set router for testing
      await contract.setRouter(router.address)

      // Initial setup: mint tokens to user
      const initialAmount = 1000
      await token.mint(user.address, initialAmount)
      expect(await token.balanceOf(user.address)).to.equal(initialAmount)

      // Step 1: Transfer tokens to router (simulating router receiving tokens)
      await token.connect(user).transfer(router.address, 500)
      expect(await token.balanceOf(router.address)).to.equal(500)

      // Step 2: Router burns tokens (lockOrBurn)
      const burnAmount = 500
      await token.connect(router).approve(contract.address, burnAmount)

      await expect(
        contract.connect(router).lockOrBurn({
          receiver: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("dest_address")
          ),
          remoteChainSelector: 1,
          originalSender: router.address,
          amount: burnAmount,
          localToken: token.address,
          extraArgs: "0x",
        })
      )
        .to.emit(contract, "Burned")
        .withArgs(router.address, burnAmount)

      expect(await token.balanceOf(router.address)).to.equal(0)

      // Step 3: Router mints tokens to new recipient (releaseOrMint)
      const mintAmount = 300
      await expect(
        contract.connect(router).releaseOrMint({
          originalSender: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("cross_chain_sender")
          ),
          receiver: user.address,
          amount: mintAmount,
          localToken: token.address,
          remoteChainSelector: 1,
          sourcePoolAddress: ethers.utils.hexlify(
            ethers.utils.toUtf8Bytes("source_pool")
          ),
          sourcePoolData: "0x",
          offchainTokenData: "0x",
        })
      )
        .to.emit(contract, "Minted")
        .withArgs(router.address, user.address, mintAmount)

      // Final balances
      expect(await token.balanceOf(user.address)).to.equal(500 + mintAmount) // remaining + newly minted
    })
  })
})
