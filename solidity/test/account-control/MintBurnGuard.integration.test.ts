/* eslint-disable no-await-in-loop */

import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { BigNumber } from "ethers"

import type {
  MintBurnGuard,
  MockAccountControl,
  TBTC,
  Bridge,
  Bank,
  TBTCVault,
  BridgeGovernance,
} from "../../typechain"
import { constants } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Integration tests that verify the contract interactions
// MockAccountControl <-> MintBurnGuard <-> Bridge <-> Bank <-> TBTCVault <-> TBTC
describe("MintBurnGuard - Integration Tests", () => {
  const SATOSHI_MULTIPLIER = BigNumber.from(constants.satoshiMultiplier)

  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let owner: SignerWithAddress
  let user: SignerWithAddress
  let thirdParty: SignerWithAddress
  let reserve: SignerWithAddress

  let guard: MintBurnGuard
  let accountControl: MockAccountControl
  let tbtc: TBTC
  let bridge: Bridge
  let bridgeGovernance: BridgeGovernance
  let bank: Bank
  let tbtcVault: TBTCVault

  // Use waffle.loadFixture for proper snapshot management across test files
  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      tbtc,
      bridge,
      bridgeGovernance,
      bank,
      tbtcVault,
    } = await waffle.loadFixture(bridgeFixture))

    const signers = await ethers.getSigners()
    const [, , ownerSigner, , userSigner, thirdPartySigner, reserveSigner] =
      signers

    owner = ownerSigner
    user = userSigner
    thirdParty = thirdPartySigner
    reserve = reserveSigner

    // Transfer TBTC ownership to vault if not already done
    const tbtcOwner = await tbtc.owner()
    if (tbtcOwner !== tbtcVault.address) {
      await tbtc.connect(deployer).transferOwnership(tbtcVault.address)
    }

    // Deploy MintBurnGuard with proxy pattern
    const MintBurnGuardFactory = await ethers.getContractFactory(
      "MintBurnGuard"
    )
    const guardImpl = await MintBurnGuardFactory.deploy()
    await guardImpl.deployed()

    // Deploy MockAccountControl first (we'll set it as operator)
    // But we need to deploy guard first to pass to MockAccountControl
    // So we use a temporary operator address, then update it
    const ERC1967ProxyFactory = await ethers.getContractFactory("ERC1967Proxy")
    const initData = MintBurnGuardFactory.interface.encodeFunctionData(
      "initialize",
      [owner.address, owner.address, tbtcVault.address] // Temporary: owner as operator
    )
    const proxy = await ERC1967ProxyFactory.deploy(guardImpl.address, initData)
    await proxy.deployed()

    guard = MintBurnGuardFactory.attach(proxy.address) as MintBurnGuard

    // Now deploy MockAccountControl with the guard address
    const MockAccountControlFactory = await ethers.getContractFactory(
      "MockAccountControl"
    )
    accountControl = (await MockAccountControlFactory.deploy(
      guard.address,
      tbtcVault.address
    )) as MockAccountControl

    // Update the operator to be MockAccountControl
    await guard.connect(owner).setOperator(accountControl.address)

    // Set MintBurnGuard as the minting controller via governance
    await bridgeGovernance
      .connect(governance)
      .setMintingController(guard.address)
  })

  describe("Contract wiring verification", () => {
    it("should have MintBurnGuard set as minting controller on Bridge", async () => {
      expect(await bridge.mintingController()).to.equal(guard.address)
    })

    it("should have MockAccountControl as operator", async () => {
      expect(await guard.operator()).to.equal(accountControl.address)
    })

    it("should have correct vault reference", async () => {
      expect(await guard.vault()).to.equal(tbtcVault.address)
    })

    it("should have correct bridge reference from vault", async () => {
      expect(await guard.bridge()).to.equal(bridge.address)
    })

    it("should have correct bank reference from vault", async () => {
      expect(await guard.bank()).to.equal(bank.address)
    })

    it("should have correct tbtcToken reference from vault", async () => {
      expect(await guard.tbtcToken()).to.equal(tbtc.address)
    })

    it("should have TBTCVault as TBTC token owner", async () => {
      expect(await tbtc.owner()).to.equal(tbtcVault.address)
    })
  })

  describe("mintTBTC via AccountControl - Contract Flow", () => {
    before(async () => {
      await createSnapshot()
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should mint bank balance via AccountControl.mintTBTC", async () => {
      const mintAmount = BigNumber.from(100_000) // 100,000 satoshis = 0.001 BTC

      const userBankBalanceBefore = await bank.balanceOf(user.address)
      const totalMintedBefore = await guard.totalMinted()

      await expect(
        accountControl.mintTBTC(reserve.address, user.address, mintAmount)
      )
        .to.emit(guard, "BankMintExecuted")
        .withArgs(
          accountControl.address,
          user.address,
          mintAmount,
          totalMintedBefore.add(mintAmount)
        )
        .and.to.emit(accountControl, "MintExecuted")
        .withArgs(reserve.address, user.address, mintAmount)

      // Verify Bank balance increased
      const userBankBalanceAfter = await bank.balanceOf(user.address)
      expect(userBankBalanceAfter.sub(userBankBalanceBefore)).to.equal(
        mintAmount
      )

      // Verify totalMinted tracking
      expect(await guard.totalMinted()).to.equal(
        totalMintedBefore.add(mintAmount)
      )
    })

    it("should allow multiple mints and track cumulative exposure", async () => {
      const totalMintedBefore = await guard.totalMinted()

      // First mint
      await accountControl.mintTBTC(reserve.address, user.address, 50_000)
      expect(await guard.totalMinted()).to.equal(totalMintedBefore.add(50_000))

      // Second mint to different recipient
      await accountControl.mintTBTC(reserve.address, thirdParty.address, 30_000)
      expect(await guard.totalMinted()).to.equal(totalMintedBefore.add(80_000))

      // Third mint
      await accountControl.mintTBTC(reserve.address, user.address, 20_000)
      expect(await guard.totalMinted()).to.equal(totalMintedBefore.add(100_000))
    })

    it("should reject minting from non-operator (direct guard call)", async () => {
      await expect(guard.connect(thirdParty).mintToBank(user.address, 1000)).to
        .be.reverted
    })

    it("should respect global mint cap", async () => {
      await guard.connect(owner).setTotalMinted(0)
      await guard.connect(owner).setGlobalMintCap(50_000)

      await accountControl.mintTBTC(reserve.address, user.address, 30_000)
      expect(await guard.totalMinted()).to.equal(30_000)

      // Should fail when exceeding cap
      await expect(
        accountControl.mintTBTC(reserve.address, user.address, 30_000)
      ).to.be.reverted

      // Verify totalMinted didn't change on failure
      expect(await guard.totalMinted()).to.equal(30_000)
    })

    it("should respect minting pause", async () => {
      await guard.connect(owner).setGlobalMintCap(0) // Reset cap from previous test
      await guard.connect(owner).setMintingPaused(true)

      await expect(accountControl.mintTBTC(reserve.address, user.address, 1000))
        .to.be.reverted

      await guard.connect(owner).setMintingPaused(false)
    })

    it("should enforce rate limiting", async () => {
      await guard.connect(owner).setTotalMinted(0)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(100_000, 3600) // 100k per hour

      await accountControl.mintTBTC(reserve.address, user.address, 60_000)
      await accountControl.mintTBTC(reserve.address, user.address, 40_000)

      // Should hit rate limit
      await expect(accountControl.mintTBTC(reserve.address, user.address, 1)).to
        .be.reverted

      expect(await guard.mintRateWindowAmount()).to.equal(100_000)
    })
  })

  describe("returnTBTC via AccountControl - TBTC Token Flow", () => {
    const mintAmount = BigNumber.from(100_000) // satoshis
    const tbtcMintAmount = mintAmount.mul(SATOSHI_MULTIPLIER) // TBTC base units

    before(async () => {
      await createSnapshot()
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(mintAmount) // Pre-set exposure
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should complete full return flow with TBTC tokens via AccountControl", async () => {
      // Step 1: Mint bank balance to reserve via guard
      await guard.connect(owner).setTotalMinted(0)
      await accountControl.mintTBTC(
        reserve.address,
        reserve.address,
        mintAmount
      )

      // Step 2: Reserve mints TBTC from Bank balance via Vault
      await bank
        .connect(reserve)
        .increaseBalanceAllowance(tbtcVault.address, mintAmount)
      await tbtcVault.connect(reserve).mint(tbtcMintAmount)

      // Verify reserve has TBTC tokens
      const reserveTbtcBalance = await tbtc.balanceOf(reserve.address)
      expect(reserveTbtcBalance).to.equal(tbtcMintAmount)

      // Step 3: Reserve approves guard to spend TBTC
      await tbtc.connect(reserve).approve(guard.address, tbtcMintAmount)

      // Step 4: AccountControl calls returnTBTC
      const totalMintedBefore = await guard.totalMinted()

      await expect(accountControl.returnTBTC(reserve.address, mintAmount))
        .to.emit(guard, "UnmintAndBurnExecuted")
        .withArgs(
          accountControl.address,
          reserve.address,
          mintAmount,
          totalMintedBefore.sub(mintAmount)
        )
        .and.to.emit(accountControl, "ReturnExecuted")
        .withArgs(reserve.address, mintAmount)

      // Verify TBTC tokens were burned
      expect(await tbtc.balanceOf(reserve.address)).to.equal(0)

      // Verify totalMinted decreased
      expect(await guard.totalMinted()).to.equal(0)
    })

    it("should fail without TBTC approval", async () => {
      // Setup: mint bank balance and TBTC for thirdParty
      await guard.connect(owner).setTotalMinted(0)
      await accountControl.mintTBTC(
        reserve.address,
        thirdParty.address,
        mintAmount
      )
      await bank
        .connect(thirdParty)
        .increaseBalanceAllowance(tbtcVault.address, mintAmount)
      await tbtcVault.connect(thirdParty).mint(tbtcMintAmount)

      // Update totalMinted to allow the burn
      await guard.connect(owner).setTotalMinted(mintAmount)

      // Don't approve guard to spend TBTC
      await expect(accountControl.returnTBTC(thirdParty.address, mintAmount)).to
        .be.reverted
    })

    it("should fail with insufficient TBTC balance", async () => {
      // Setup: user has no TBTC but approves anyway
      await tbtc.connect(user).approve(guard.address, tbtcMintAmount)

      await guard.connect(owner).setTotalMinted(mintAmount)

      await expect(accountControl.returnTBTC(user.address, mintAmount)).to.be
        .reverted
    })

    it("should prevent exposure underflow", async () => {
      // Setup: mint some TBTC for user
      await guard.connect(owner).setTotalMinted(0)
      await accountControl.mintTBTC(reserve.address, user.address, 50_000)
      await bank
        .connect(user)
        .increaseBalanceAllowance(tbtcVault.address, 50_000)
      await tbtcVault
        .connect(user)
        .mint(BigNumber.from(50_000).mul(SATOSHI_MULTIPLIER))
      await tbtc
        .connect(user)
        .approve(guard.address, BigNumber.from(100_000).mul(SATOSHI_MULTIPLIER))

      // Try to burn more than totalMinted
      await expect(accountControl.returnTBTC(user.address, 100_000)).to.be
        .reverted
    })
  })

  describe("notifyRedemption via AccountControl - Bank Balance Flow", () => {
    const mintAmount = BigNumber.from(100_000)

    before(async () => {
      await createSnapshot()
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should burn bank balance via AccountControl.notifyRedemption", async () => {
      // Setup: Mint bank balance to user
      await guard.connect(owner).setTotalMinted(0)
      await accountControl.mintTBTC(reserve.address, user.address, mintAmount)

      // User approves guard to transfer their bank balance
      await bank
        .connect(user)
        .increaseBalanceAllowance(guard.address, mintAmount)

      const userBankBalanceBefore = await bank.balanceOf(user.address)
      const totalMintedBefore = await guard.totalMinted()

      // AccountControl burns user's bank balance
      await expect(
        accountControl.notifyRedemption(
          reserve.address,
          user.address,
          mintAmount
        )
      )
        .to.emit(guard, "BurnExecuted")
        .withArgs(
          accountControl.address,
          user.address,
          mintAmount,
          totalMintedBefore.sub(mintAmount)
        )
        .and.to.emit(accountControl, "RedemptionExecuted")
        .withArgs(reserve.address, user.address, mintAmount)

      // Verify bank balance was burned
      const userBankBalanceAfter = await bank.balanceOf(user.address)
      expect(userBankBalanceBefore.sub(userBankBalanceAfter)).to.equal(
        mintAmount
      )

      // Verify totalMinted decreased
      expect(await guard.totalMinted()).to.equal(0)
    })

    it("should fail without bank balance approval", async () => {
      // Setup: mint bank balance
      await guard.connect(owner).setTotalMinted(0)
      await accountControl.mintTBTC(
        reserve.address,
        thirdParty.address,
        mintAmount
      )
      await guard.connect(owner).setTotalMinted(mintAmount)

      // Don't approve guard
      await expect(
        accountControl.notifyRedemption(
          reserve.address,
          thirdParty.address,
          mintAmount
        )
      ).to.be.reverted
    })

    it("should allow partial burns", async () => {
      // Setup
      await guard.connect(owner).setTotalMinted(0)
      await accountControl.mintTBTC(reserve.address, user.address, mintAmount)
      await bank
        .connect(user)
        .increaseBalanceAllowance(guard.address, mintAmount)

      // Partial burn
      const partialAmount = BigNumber.from(40_000)
      await accountControl.notifyRedemption(
        reserve.address,
        user.address,
        partialAmount
      )
      expect(await guard.totalMinted()).to.equal(mintAmount.sub(partialAmount))

      // Another partial burn
      const remainingAmount = mintAmount.sub(partialAmount)
      await accountControl.notifyRedemption(
        reserve.address,
        user.address,
        remainingAmount
      )
      expect(await guard.totalMinted()).to.equal(0)
    })
  })

  describe("Full Lifecycle Integration via AccountControl", () => {
    before(async () => {
      await createSnapshot()
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should handle complete mint -> TBTC mint -> return cycle", async () => {
      const amount = BigNumber.from(50_000)
      const tbtcAmount = amount.mul(SATOSHI_MULTIPLIER)

      // Phase 1: Mint to Bank via AccountControl
      expect(await guard.totalMinted()).to.equal(0)
      await accountControl.mintTBTC(reserve.address, reserve.address, amount)
      expect(await guard.totalMinted()).to.equal(amount)
      expect(await bank.balanceOf(reserve.address)).to.equal(amount)

      // Phase 2: Reserve mints TBTC tokens from Bank balance
      await bank
        .connect(reserve)
        .increaseBalanceAllowance(tbtcVault.address, amount)
      await tbtcVault.connect(reserve).mint(tbtcAmount)
      expect(await tbtc.balanceOf(reserve.address)).to.equal(tbtcAmount)
      expect(await bank.balanceOf(reserve.address)).to.equal(0)

      // Phase 3: Reserve returns TBTC via AccountControl
      await tbtc.connect(reserve).approve(guard.address, tbtcAmount)
      await accountControl.returnTBTC(reserve.address, amount)

      // Final state verification
      expect(await guard.totalMinted()).to.equal(0)
      expect(await tbtc.balanceOf(reserve.address)).to.equal(0)
    })

    it("should handle complete mint -> notifyRedemption cycle (without TBTC tokens)", async () => {
      const amount = BigNumber.from(75_000)

      // Phase 1: Mint to Bank via AccountControl
      await accountControl.mintTBTC(reserve.address, user.address, amount)
      expect(await guard.totalMinted()).to.equal(amount)
      expect(await bank.balanceOf(user.address)).to.equal(amount)

      // Phase 2: Burn directly from Bank balance via notifyRedemption
      await bank.connect(user).increaseBalanceAllowance(guard.address, amount)
      await accountControl.notifyRedemption(
        reserve.address,
        user.address,
        amount
      )

      // Final state verification
      expect(await guard.totalMinted()).to.equal(0)
      expect(await bank.balanceOf(user.address)).to.equal(0)
    })

    it("should handle mixed operations across multiple users", async () => {
      // User1 mints via AccountControl
      await accountControl.mintTBTC(reserve.address, user.address, 100_000)
      expect(await guard.totalMinted()).to.equal(100_000)

      // User2 (thirdParty) mints via AccountControl
      await accountControl.mintTBTC(reserve.address, thirdParty.address, 50_000)
      expect(await guard.totalMinted()).to.equal(150_000)

      // User1 redeems via notifyRedemption
      await bank.connect(user).increaseBalanceAllowance(guard.address, 30_000)
      await accountControl.notifyRedemption(
        reserve.address,
        user.address,
        30_000
      )
      expect(await guard.totalMinted()).to.equal(120_000)

      // User2 converts to TBTC and returns via returnTBTC
      const tbtcAmount = BigNumber.from(50_000).mul(SATOSHI_MULTIPLIER)
      await bank
        .connect(thirdParty)
        .increaseBalanceAllowance(tbtcVault.address, 50_000)
      await tbtcVault.connect(thirdParty).mint(tbtcAmount)
      await tbtc.connect(thirdParty).approve(guard.address, tbtcAmount)
      await accountControl.returnTBTC(thirdParty.address, 50_000)
      expect(await guard.totalMinted()).to.equal(70_000)

      // User1 redeems remaining bank balance
      await bank.connect(user).increaseBalanceAllowance(guard.address, 70_000)
      await accountControl.notifyRedemption(
        reserve.address,
        user.address,
        70_000
      )
      expect(await guard.totalMinted()).to.equal(0)
    })
  })

  describe("Governance and Configuration Integration", () => {
    before(async () => {
      await createSnapshot()
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should allow owner to change vault reference", async () => {
      const currentVault = await guard.vault()

      // Deploy a new mock vault for testing
      const MockVaultFactory = await ethers.getContractFactory("MockBurnVault")
      const mockBank = await ethers.getContractFactory("MockBurnBank")
      const newBank = await mockBank.deploy()
      const MockBridgeFactory = await ethers.getContractFactory(
        "MockBridgeController"
      )
      const newBridge = await MockBridgeFactory.deploy(owner.address)
      const newVault = await MockVaultFactory.deploy(
        newBank.address,
        newBridge.address
      )

      await expect(guard.connect(owner).setVault(newVault.address))
        .to.emit(guard, "VaultUpdated")
        .withArgs(currentVault, newVault.address)

      expect(await guard.vault()).to.equal(newVault.address)

      // Restore original vault
      await guard.connect(owner).setVault(currentVault)
    })

    it("should allow owner to change operator", async () => {
      const currentOperator = await guard.operator()

      await expect(guard.connect(owner).setOperator(thirdParty.address))
        .to.emit(guard, "OperatorUpdated")
        .withArgs(currentOperator, thirdParty.address)

      // Old operator (AccountControl) can no longer mint
      await expect(accountControl.mintTBTC(reserve.address, user.address, 1000))
        .to.be.reverted

      // New operator can mint directly
      await expect(guard.connect(thirdParty).mintToBank(user.address, 1000)).to
        .not.be.reverted

      // Restore original operator
      await guard.connect(owner).setOperator(currentOperator)
    })

    it("should properly enforce cap relative to rate limit", async () => {
      await guard.connect(owner).setMintRateLimit(500, 60)

      // Cap cannot be below rate limit
      await expect(guard.connect(owner).setGlobalMintCap(400)).to.be.reverted

      // Cap at rate limit is allowed
      await expect(guard.connect(owner).setGlobalMintCap(500)).to.not.be
        .reverted

      // Reset
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
    })

    it("should allow owner to override totalMinted for accounting corrections", async () => {
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setTotalMinted(0)

      // Restore AccountControl as operator if needed
      const currentOperator = await guard.operator()
      if (currentOperator !== accountControl.address) {
        await guard.connect(owner).setOperator(accountControl.address)
      }

      // Simulate a situation where totalMinted needs correction
      await accountControl.mintTBTC(reserve.address, user.address, 100_000)
      expect(await guard.totalMinted()).to.equal(100_000)

      // Owner corrects the value
      await expect(guard.connect(owner).setTotalMinted(50_000))
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(50_000, 50_000)

      expect(await guard.totalMinted()).to.equal(50_000)

      // Can also increase
      await expect(guard.connect(owner).setTotalMinted(75_000))
        .to.emit(guard, "TotalMintedIncreased")
        .withArgs(25_000, 75_000)
    })
  })

  describe("Edge Cases and Error Handling", () => {
    before(async () => {
      await createSnapshot()
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should handle zero amount operations gracefully", async () => {
      // Zero amount mint should be no-op
      const totalBefore = await guard.totalMinted()
      await accountControl.mintTBTC(reserve.address, user.address, 0)
      expect(await guard.totalMinted()).to.equal(totalBefore)
    })

    it("should not allow non-owner to change critical parameters", async () => {
      await expect(
        guard.connect(thirdParty).setGlobalMintCap(1000)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(
        guard.connect(thirdParty).setMintingPaused(true)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(
        guard.connect(thirdParty).setTotalMinted(0)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(
        guard.connect(thirdParty).setOperator(thirdParty.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should reject setting vault to zero address", async () => {
      await expect(guard.connect(owner).setVault(ethers.constants.AddressZero))
        .to.be.reverted
    })

    it("should reject setting operator to zero address", async () => {
      await expect(
        guard.connect(owner).setOperator(ethers.constants.AddressZero)
      ).to.be.reverted
    })

    it("should handle rate limit window reset after time passes", async () => {
      const windowSeconds = 60
      await guard.connect(owner).setMintRateLimit(100_000, windowSeconds)
      await guard.connect(owner).setTotalMinted(0)

      // Fill the rate limit
      await accountControl.mintTBTC(reserve.address, user.address, 100_000)
      expect(await guard.mintRateWindowAmount()).to.equal(100_000)

      // Should fail within window
      await expect(accountControl.mintTBTC(reserve.address, user.address, 1)).to
        .be.reverted

      // Advance time beyond window
      await ethers.provider.send("evm_increaseTime", [windowSeconds + 1])
      await ethers.provider.send("evm_mine", [])

      // Should work after window reset
      await accountControl.mintTBTC(reserve.address, user.address, 50_000)
      expect(await guard.mintRateWindowAmount()).to.equal(50_000)
    })
  })

  describe("State Consistency", () => {
    before(async () => {
      await createSnapshot()
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(0)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should maintain consistency between guard totalMinted and actual minted balances", async () => {
      // Track all mints and burns
      const mints: BigNumber[] = []
      const burns: BigNumber[] = []

      // Perform multiple operations via AccountControl
      const mint1 = BigNumber.from(100_000)
      await accountControl.mintTBTC(reserve.address, user.address, mint1)
      mints.push(mint1)

      const mint2 = BigNumber.from(50_000)
      await accountControl.mintTBTC(reserve.address, thirdParty.address, mint2)
      mints.push(mint2)

      // Burn via notifyRedemption
      const burn1 = BigNumber.from(30_000)
      await bank.connect(user).increaseBalanceAllowance(guard.address, burn1)
      await accountControl.notifyRedemption(
        reserve.address,
        user.address,
        burn1
      )
      burns.push(burn1)

      // Calculate expected total
      const expectedTotal = mints
        .reduce((a, b) => a.add(b), BigNumber.from(0))
        .sub(burns.reduce((a, b) => a.add(b), BigNumber.from(0)))

      expect(await guard.totalMinted()).to.equal(expectedTotal)
    })

    it("should verify bridge controller reference is correctly set", async () => {
      // The guard should be recognized as the minting controller
      const controller = await bridge.mintingController()
      expect(controller).to.equal(guard.address)

      // Verify guard can call controllerIncreaseBalance through AccountControl
      const balanceBefore = await bank.balanceOf(user.address)
      await accountControl.mintTBTC(reserve.address, user.address, 10_000)
      expect(await bank.balanceOf(user.address)).to.equal(
        balanceBefore.add(10_000)
      )
    })
  })
})
