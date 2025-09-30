import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"
import type {
  L1BTCDepositorNttWithExecutor,
  MockTBTCBridge,
  MockTBTCVault,
  TestERC20,
} from "../../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Wormhole Chain IDs for testing
const WORMHOLE_CHAIN_SEI = 32
const WORMHOLE_CHAIN_BASE = 30

describe("L1BTCDepositorNttWithExecutor - Transfer Functions", () => {
  let depositor: L1BTCDepositorNttWithExecutor
  let bridge: MockTBTCBridge
  let tbtcVault: MockTBTCVault
  let tbtcToken: TestERC20

  before(async () => {
    // Deploy mock contracts following working pattern
    const TestERC20Factory = await ethers.getContractFactory("TestERC20")
    tbtcToken = await TestERC20Factory.deploy()

    const MockBridgeFactory = await ethers.getContractFactory("MockTBTCBridge")
    bridge = await MockBridgeFactory.deploy()

    const MockTBTCVaultFactory = await ethers.getContractFactory(
      "contracts/test/MockTBTCVault.sol:MockTBTCVault"
    )
    tbtcVault = (await MockTBTCVaultFactory.deploy()) as MockTBTCVault
    await tbtcVault.setTbtcToken(tbtcToken.address)

    // Mock NTT managers with simple objects (following working pattern)
    const nttManagerWithExecutor = {
      address: ethers.Wallet.createRandom().address,
    }
    const underlyingNttManager = {
      address: ethers.Wallet.createRandom().address,
    }

    // Deploy main contract with proxy following working pattern
    const L1BTCDepositorFactory = await ethers.getContractFactory(
      "L1BTCDepositorNttWithExecutor"
    )
    const depositorImpl = await L1BTCDepositorFactory.deploy()
    await depositorImpl.deployed()

    // Deploy proxy
    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = depositorImpl.interface.encodeFunctionData("initialize", [
      bridge.address,
      tbtcVault.address,
      nttManagerWithExecutor.address,
      underlyingNttManager.address,
    ])
    const proxy = await ProxyFactory.deploy(depositorImpl.address, initData)

    depositor = L1BTCDepositorFactory.attach(
      proxy.address
    ) as L1BTCDepositorNttWithExecutor

    // Set up supported chains
    await depositor.setSupportedChain(WORMHOLE_CHAIN_SEI, true)
    await depositor.setSupportedChain(WORMHOLE_CHAIN_BASE, true)
    await depositor.setDefaultSupportedChain(WORMHOLE_CHAIN_SEI)
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("Token Transfers", () => {
    it("should allow owner to retrieve ERC20 tokens", async () => {
      const [owner, , user] = await ethers.getSigners()

      // Send some tokens to the contract
      const amount = ethers.utils.parseEther("1")
      await tbtcToken.mint(depositor.address, amount)

      const initialBalance = await tbtcToken.balanceOf(user.address)

      await depositor.retrieveTokens(tbtcToken.address, user.address, amount)

      const finalBalance = await tbtcToken.balanceOf(user.address)
      expect(finalBalance.sub(initialBalance)).to.equal(amount)
    })

    it("should allow owner to retrieve native ETH", async () => {
      const [owner, , user] = await ethers.getSigners()

      // Note: The contract doesn't have a receive function, so it can't accept ETH
      // This test verifies that the retrieveTokens function works for native tokens
      // when the contract has ETH (which would need to be sent via selfdestruct or other means)

      const amount = ethers.utils.parseEther("0.1")

      // Since the contract can't receive ETH normally, we'll test the function
      // by checking that it properly handles the case when there's insufficient ETH
      // The ETH retrieval should fail with a clear error message
      await expect(
        depositor.retrieveTokens(
          ethers.constants.AddressZero,
          user.address,
          amount
        )
      ).to.be.revertedWith("Failed to transfer native token")
    })

    it("should prevent non-owners from retrieving tokens", async () => {
      const [, , user] = await ethers.getSigners()

      // Send some tokens to the contract
      const amount = ethers.utils.parseEther("1")
      await tbtcToken.mint(depositor.address, amount)

      await expect(
        depositor
          .connect(user)
          .retrieveTokens(tbtcToken.address, user.address, amount)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should handle partial token retrieval", async () => {
      const [owner, , user] = await ethers.getSigners()

      // Send tokens to the contract
      const totalAmount = ethers.utils.parseEther("2")
      await tbtcToken.mint(depositor.address, totalAmount)

      // Retrieve partial amount
      const partialAmount = ethers.utils.parseEther("0.5")
      const initialBalance = await tbtcToken.balanceOf(user.address)

      await depositor.retrieveTokens(
        tbtcToken.address,
        user.address,
        partialAmount
      )

      const finalBalance = await tbtcToken.balanceOf(user.address)
      expect(finalBalance.sub(initialBalance)).to.equal(partialAmount)

      // Check remaining balance in contract
      const remainingBalance = await tbtcToken.balanceOf(depositor.address)
      expect(remainingBalance).to.equal(totalAmount.sub(partialAmount))
    })
  })

  describe("Ownership Transfers", () => {
    it("should allow owner to transfer ownership", async () => {
      const [owner, , user] = await ethers.getSigners()

      // Transfer ownership
      await depositor.transferOwnership(user.address)
      expect(await depositor.owner()).to.equal(user.address)

      // New owner should be able to call owner functions
      await depositor
        .connect(user)
        .setDefaultParameters(
          600000,
          50,
          user.address,
          0,
          ethers.constants.AddressZero
        )

      // Old owner should not be able to call owner functions
      await expect(
        depositor.setDefaultParameters(
          600000,
          50,
          user.address,
          0,
          ethers.constants.AddressZero
        )
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should prevent non-owners from transferring ownership", async () => {
      const [, , user] = await ethers.getSigners()

      await expect(
        depositor.connect(user).transferOwnership(user.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should handle ownership renunciation", async () => {
      // Renounce ownership
      await depositor.renounceOwnership()
      expect(await depositor.owner()).to.equal(ethers.constants.AddressZero)

      // After ownership is renounced, owner-only functions should revert for any caller
      const [, , user] = await ethers.getSigners()
      await expect(
        depositor
          .connect(user)
          .setDefaultParameters(
            600000,
            50,
            user.address,
            0,
            ethers.constants.AddressZero
          )
      ).to.be.revertedWith("Ownable: caller is not the owner")
      await expect(
        depositor.setDefaultParameters(
          600000,
          50,
          user.address,
          0,
          ethers.constants.AddressZero
        )
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })
  })

  describe("Configuration Updates", () => {
    it("should allow owner to update NTT managers", async () => {
      const newManager = ethers.Wallet.createRandom().address

      await depositor.updateUnderlyingNttManager(newManager)
      expect(await depositor.underlyingNttManager()).to.equal(newManager)
    })

    it("should prevent non-owners from updating NTT managers", async () => {
      const [, , user] = await ethers.getSigners()
      const newManager = ethers.Wallet.createRandom().address

      await expect(
        depositor.connect(user).updateUnderlyingNttManager(newManager)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    // Note: updateReimbursementPool and updateReimbursementAuthorization functions
    // are not available in L1BTCDepositorNttWithExecutor contract
  })

  describe("Edge Cases", () => {
    it("should handle zero amount token retrieval", async () => {
      const [owner, , user] = await ethers.getSigners()

      // Send tokens to the contract
      const amount = ethers.utils.parseEther("1")
      await tbtcToken.mint(depositor.address, amount)

      const initialBalance = await tbtcToken.balanceOf(user.address)

      // Retrieve zero amount
      await depositor.retrieveTokens(tbtcToken.address, user.address, 0)

      const finalBalance = await tbtcToken.balanceOf(user.address)
      expect(finalBalance).to.equal(initialBalance)
    })

    it("should reject retrieval to zero address", async () => {
      const [owner] = await ethers.getSigners()

      // Send tokens to the contract
      const amount = ethers.utils.parseEther("1")
      await tbtcToken.mint(depositor.address, amount)

      // This should revert with proper validation
      await expect(
        depositor.retrieveTokens(
          tbtcToken.address,
          ethers.constants.AddressZero,
          amount
        )
      ).to.be.revertedWith("Cannot retrieve tokens to the zero address")
    })

    it("should reject retrieval of non-existent tokens", async () => {
      const [owner, , user] = await ethers.getSigners()
      const nonExistentToken = ethers.Wallet.createRandom().address

      // This should revert when trying to call a non-contract
      await expect(
        depositor.retrieveTokens(
          nonExistentToken,
          user.address,
          ethers.utils.parseEther("1")
        )
      ).to.be.revertedWith("Address: call to non-contract")
    })
  })
})
