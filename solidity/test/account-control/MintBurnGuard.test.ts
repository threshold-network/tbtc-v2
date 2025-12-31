import { BigNumber } from "ethers"
import { ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"

import type {
  MintBurnGuard,
  MockBridgeController,
  MockBurnBank,
  MockBurnVault,
  MockTBTC,
} from "../typechain"

describe("MintBurnGuard", () => {
  const SATOSHI_MULTIPLIER = BigNumber.from("10000000000")

  let owner: SignerWithAddress
  let controller: SignerWithAddress
  let thirdParty: SignerWithAddress

  let guard: MintBurnGuard
  let bridge: MockBridgeController
  let bank: MockBurnBank
  let vault: MockBurnVault
  let tbtcToken: MockTBTC

  before(async () => {
    const signers = await ethers.getSigners()
    ;[owner, controller, thirdParty] = signers

    const MockBridgeFactory = await ethers.getContractFactory(
      "MockBridgeController"
    )
    bridge = (await MockBridgeFactory.deploy(
      owner.address
    )) as MockBridgeController
    await bridge.deployed()

    const MockBankFactory = await ethers.getContractFactory("MockBurnBank")
    bank = (await MockBankFactory.deploy()) as MockBurnBank
    await bank.deployed()

    const MockVaultFactory = await ethers.getContractFactory("MockBurnVault")
    vault = (await MockVaultFactory.deploy(
      bank.address,
      bridge.address
    )) as MockBurnVault
    await vault.deployed()

    const tbtcTokenAddress = await vault.tbtcToken()
    tbtcToken = await ethers.getContractAt("MockTBTC", tbtcTokenAddress)

    const MintBurnGuardFactory = await ethers.getContractFactory(
      "MintBurnGuard"
    )
    guard = (await MintBurnGuardFactory.deploy(
      owner.address,
      controller.address,
      vault.address
    )) as MintBurnGuard
    await guard.deployed()

    await bridge.connect(owner).setMintingController(guard.address)
  })

  describe("initialization", () => {
    it("should set owner and operator", async () => {
      expect(await guard.owner()).to.equal(owner.address)
      expect(await guard.operator()).to.equal(controller.address)
    })

    it("should allow owner to change operator", async () => {
      const newOperator = thirdParty

      // Change operator
      await expect(guard.connect(owner).setOperator(newOperator.address))
        .to.emit(guard, "OperatorUpdated")
        .withArgs(controller.address, newOperator.address)

      expect(await guard.operator()).to.equal(newOperator.address)

      // Old operator can no longer call functions
      await expect(guard.connect(controller).mintToBank(controller.address, 1))
        .to.be.reverted

      // New operator can call functions
      await guard.connect(owner).setMintingPaused(false)
      await expect(
        guard.connect(newOperator).mintToBank(newOperator.address, 1)
      ).to.not.be.reverted

      expect(await guard.totalMinted()).to.equal(1)

      // Change back to original operator for other tests
      await guard.connect(owner).setOperator(controller.address)
    })

    it("should not allow non-owner to change operator", async () => {
      await expect(
        guard.connect(controller).setOperator(thirdParty.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(
        guard.connect(thirdParty).setOperator(thirdParty.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should not allow setting operator to zero address", async () => {
      await expect(
        guard.connect(owner).setOperator(ethers.constants.AddressZero)
      ).to.be.reverted
    })
  })

  describe("minting accounting", () => {
    beforeEach(async () => {
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(0)
    })

    it("allows only owner to set total with cap enforcement", async () => {
      await guard.connect(owner).setGlobalMintCap(200)

      await expect(guard.connect(owner).setTotalMinted(150))
        .to.emit(guard, "TotalMintedIncreased")
        .withArgs(150, 150)

      await expect(guard.connect(owner).setTotalMinted(201)).to.be.reverted

      await expect(
        guard.connect(controller).setTotalMinted(100)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(guard.connect(owner).setTotalMinted(75))
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(75, 75)
    })

    it("should enforce global mint cap", async () => {
      await guard.connect(owner).setGlobalMintCap(200)

      await guard.connect(controller).mintToBank(controller.address, 150)
      expect(await guard.totalMinted()).to.equal(150)

      await expect(
        guard.connect(controller).mintToBank(controller.address, 100)
      ).to.be.reverted

      // Ensure failed mint did not change exposure.
      expect(await guard.totalMinted()).to.equal(150)
    })

    it("should enforce minting pause", async () => {
      await guard.connect(owner).setMintingPaused(true)

      await expect(guard.connect(controller).mintToBank(controller.address, 1))
        .to.be.reverted

      await guard.connect(owner).setMintingPaused(false)

      await guard.connect(controller).mintToBank(controller.address, 10)
      expect(await guard.totalMinted()).to.equal(10)
    })

    it("requires non-controller calls to revert", async () => {
      await expect(guard.connect(thirdParty).mintToBank(thirdParty.address, 1))
        .to.be.reverted
      await expect(
        guard.connect(thirdParty).unmintAndBurnFrom(thirdParty.address, 1)
      ).to.be.reverted
      await expect(guard.connect(thirdParty).burnFrom(thirdParty.address, 1)).to
        .be.reverted
    })

    it("should prevent underflow on decrease", async () => {
      await guard.connect(owner).setTotalMinted(50)
      const current = await guard.totalMinted()
      await expect(
        guard
          .connect(controller)
          .unmintAndBurnFrom(controller.address, current.add(1))
      ).to.be.reverted
    })

    it("mints via bridge and updates exposure", async () => {
      const amount = 1_000n

      // Ensure caps and pause do not interfere with this happy-path test.
      await guard.connect(owner).setMintingPaused(false)

      const previousTotal = await guard.totalMinted()
      await expect(
        guard.connect(controller).mintToBank(controller.address, amount)
      )
        .to.emit(guard, "TotalMintedIncreased")
        .withArgs(amount, previousTotal.add(amount))

      expect(await guard.totalMinted()).to.equal(previousTotal.add(amount))
      // Bridge is a mock; as long as it does not revert, we rely on its own
      // tests to verify forwarding to Bank.
    })

    it("unmints and burns via vault and updates exposure", async () => {
      const burnAmount = BigNumber.from(50)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)

      await guard.connect(owner).setTotalMinted(burnAmount)
      const current = await guard.totalMinted()

      // Mint TBTC tokens to controller for testing
      await tbtcToken.mint(controller.address, tbtcAmount)

      // Controller approves guard to spend TBTC
      await tbtcToken.connect(controller).approve(guard.address, tbtcAmount)

      await expect(
        guard
          .connect(controller)
          .unmintAndBurnFrom(controller.address, burnAmount)
      )
        .to.emit(guard, "UnmintAndBurnExecuted")
        .withArgs(
          controller.address,
          controller.address,
          burnAmount,
          current.sub(burnAmount)
        )
        .and.to.emit(guard, "TotalMintedDecreased")
        .withArgs(burnAmount, current.sub(burnAmount))

      expect(await guard.totalMinted()).to.equal(current.sub(burnAmount))
      expect(await vault.lastUnmintAmount()).to.equal(tbtcAmount)
      expect(await bank.lastBurnAmount()).to.equal(tbtcAmount)
    })

    it("burns from bank balance and updates exposure", async () => {
      const burnAmount = BigNumber.from(100)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)

      await guard.connect(owner).setTotalMinted(burnAmount)
      const current = await guard.totalMinted()

      // Set up bank balance for controller
      await bank.setBalance(controller.address, tbtcAmount)

      // Controller approves guard to transfer bank balance
      await bank.connect(controller).approve(guard.address, burnAmount)

      await expect(
        guard.connect(controller).burnFrom(controller.address, burnAmount)
      )
        .to.emit(guard, "BurnExecuted")
        .withArgs(
          controller.address,
          controller.address,
          burnAmount,
          current.sub(burnAmount)
        )
        .and.to.emit(guard, "TotalMintedDecreased")
        .withArgs(burnAmount, current.sub(burnAmount))

      expect(await guard.totalMinted()).to.equal(current.sub(burnAmount))
      expect(await bank.lastBurnAmount()).to.equal(tbtcAmount)
      expect(await bank.lastTransferFrom()).to.equal(controller.address)
      expect(await bank.lastTransferTo()).to.equal(guard.address)
    })
  })

  describe("rate limiting", () => {
    beforeEach(async () => {
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(0)
    })

    it("validates cap against rate limit", async () => {
      await guard.connect(owner).setMintRateLimit(500, 60)
      await expect(guard.connect(owner).setGlobalMintCap(400)).to.be.reverted
      await expect(guard.connect(owner).setGlobalMintCap(500)).to.not.be
        .reverted
    })

    it("validates rate limit params", async () => {
      await expect(guard.connect(owner).setMintRateLimit(1, 0)).to.be.reverted
      await guard.connect(owner).setGlobalMintCap(100)
      await expect(guard.connect(owner).setMintRateLimit(101, 60)).to.be
        .reverted
      await expect(guard.connect(owner).setMintRateLimit(100, 60)).to.not.be
        .reverted
    })

    it("enforces the configured limit within a window", async () => {
      await guard.connect(owner).setMintRateLimit(500, 60)

      await guard.connect(controller).mintToBank(controller.address, 200)
      await guard.connect(controller).mintToBank(controller.address, 300)

      const totalBeforeRevert = await guard.totalMinted()

      await expect(guard.connect(controller).mintToBank(controller.address, 1))
        .to.be.reverted

      expect(await guard.totalMinted()).to.equal(totalBeforeRevert)
      expect(await guard.mintRateWindowAmount()).to.equal(500)
    })

    it("resets the rate window after the configured duration", async () => {
      const windowSeconds = 60
      await guard.connect(owner).setMintRateLimit(200, windowSeconds)

      await guard.connect(controller).mintToBank(controller.address, 200)

      await ethers.provider.send("evm_increaseTime", [windowSeconds + 1])
      await ethers.provider.send("evm_mine", [])

      await guard.connect(controller).mintToBank(controller.address, 100)
      expect(await guard.mintRateWindowAmount()).to.equal(100)
    })

    it("allows disabling the rate limit via zero configuration", async () => {
      await guard.connect(owner).setMintRateLimit(300, 120)

      await guard.connect(controller).mintToBank(controller.address, 300)
      const totalBeforeRevert = await guard.totalMinted()

      await expect(guard.connect(controller).mintToBank(controller.address, 1))
        .to.be.reverted

      expect(await guard.totalMinted()).to.equal(totalBeforeRevert)
      expect(await guard.mintRateWindowAmount()).to.equal(300)

      await guard.connect(owner).setMintRateLimit(0, 0)

      await guard.connect(controller).mintToBank(controller.address, 1)
    })

    it("resets rate window on total override", async () => {
      await guard.connect(owner).setMintRateLimit(300, 120)
      await guard.connect(controller).mintToBank(controller.address, 200)
      await guard.connect(owner).setTotalMinted(50)
      expect(await guard.mintRateWindowStart()).to.equal(0)
      expect(await guard.mintRateWindowAmount()).to.equal(0)
    })
  })

  describe("approval requirements", () => {
    beforeEach(async () => {
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(100)
    })

    it("unmintAndBurnFrom requires TBTC token approval", async () => {
      const burnAmount = BigNumber.from(50)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)

      // Mint TBTC to third party
      await tbtcToken.mint(thirdParty.address, tbtcAmount)

      // Try to unmint and burn without approval - should fail
      await expect(
        guard
          .connect(controller)
          .unmintAndBurnFrom(thirdParty.address, burnAmount)
      ).to.be.revertedWith("ERC20: insufficient allowance")

      // Approve guard to spend TBTC
      await tbtcToken.connect(thirdParty).approve(guard.address, tbtcAmount)

      // Now it should work
      await expect(
        guard
          .connect(controller)
          .unmintAndBurnFrom(thirdParty.address, burnAmount)
      ).to.not.be.reverted

      expect(await guard.totalMinted()).to.equal(50)
    })

    it("burnFrom requires Bank balance approval", async () => {
      const burnAmount = BigNumber.from(50)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)

      // Set up bank balance for third party
      await bank.setBalance(thirdParty.address, tbtcAmount)

      // Try to burn without approval - should fail
      await expect(
        guard.connect(controller).burnFrom(thirdParty.address, burnAmount)
      ).to.be.revertedWith("MockBurnBank: insufficient allowance")

      // Approve guard to transfer bank balance
      await bank.connect(thirdParty).approve(guard.address, burnAmount)

      // Now it should work
      await expect(
        guard.connect(controller).burnFrom(thirdParty.address, burnAmount)
      ).to.not.be.reverted

      expect(await guard.totalMinted()).to.equal(50)
    })

    it("unmintAndBurnFrom fails with insufficient TBTC balance", async () => {
      const burnAmount = BigNumber.from(50)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)

      // Mint less than required
      await tbtcToken.mint(thirdParty.address, tbtcAmount.div(2))

      // Approve guard to spend TBTC
      await tbtcToken.connect(thirdParty).approve(guard.address, tbtcAmount)

      // Should fail due to insufficient balance
      await expect(
        guard
          .connect(controller)
          .unmintAndBurnFrom(thirdParty.address, burnAmount)
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance")
    })
  })

  describe("exposure modification tracking", () => {
    beforeEach(async () => {
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(0)
    })

    it("tracks exposure correctly through mint operations", async () => {
      expect(await guard.totalMinted()).to.equal(0)

      await guard.connect(controller).mintToBank(controller.address, 100)
      expect(await guard.totalMinted()).to.equal(100)

      await guard.connect(controller).mintToBank(controller.address, 50)
      expect(await guard.totalMinted()).to.equal(150)

      await guard.connect(controller).mintToBank(controller.address, 25)
      expect(await guard.totalMinted()).to.equal(175)
    })

    it("tracks exposure correctly through unmintAndBurnFrom operations", async () => {
      // Start with some minted exposure
      await guard.connect(owner).setTotalMinted(200)
      expect(await guard.totalMinted()).to.equal(200)

      const burnAmount1 = BigNumber.from(50)
      const tbtcAmount1 = burnAmount1.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(controller.address, tbtcAmount1)
      await tbtcToken.connect(controller).approve(guard.address, tbtcAmount1)

      await guard
        .connect(controller)
        .unmintAndBurnFrom(controller.address, burnAmount1)
      expect(await guard.totalMinted()).to.equal(150)

      const burnAmount2 = BigNumber.from(75)
      const tbtcAmount2 = burnAmount2.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(controller.address, tbtcAmount2)
      await tbtcToken.connect(controller).approve(guard.address, tbtcAmount2)

      await guard
        .connect(controller)
        .unmintAndBurnFrom(controller.address, burnAmount2)
      expect(await guard.totalMinted()).to.equal(75)
    })

    it("tracks exposure correctly through burnFrom operations", async () => {
      // Start with some minted exposure
      await guard.connect(owner).setTotalMinted(300)
      expect(await guard.totalMinted()).to.equal(300)

      const burnAmount1 = BigNumber.from(100)
      const tbtcAmount1 = burnAmount1.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(controller.address, tbtcAmount1)
      await bank.connect(controller).approve(guard.address, burnAmount1)

      await guard.connect(controller).burnFrom(controller.address, burnAmount1)
      expect(await guard.totalMinted()).to.equal(200)

      const burnAmount2 = BigNumber.from(50)
      const tbtcAmount2 = burnAmount2.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(controller.address, tbtcAmount2)
      await bank.connect(controller).approve(guard.address, burnAmount2)

      await guard.connect(controller).burnFrom(controller.address, burnAmount2)
      expect(await guard.totalMinted()).to.equal(150)
    })

    it("tracks exposure correctly through mixed operations", async () => {
      expect(await guard.totalMinted()).to.equal(0)

      // Mint
      await guard.connect(controller).mintToBank(controller.address, 100)
      expect(await guard.totalMinted()).to.equal(100)

      // Mint more
      await guard.connect(controller).mintToBank(controller.address, 50)
      expect(await guard.totalMinted()).to.equal(150)

      // Unmint and burn
      const unmintAmount = BigNumber.from(30)
      const tbtcAmount = unmintAmount.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(controller.address, tbtcAmount)
      await tbtcToken.connect(controller).approve(guard.address, tbtcAmount)
      await guard
        .connect(controller)
        .unmintAndBurnFrom(controller.address, unmintAmount)
      expect(await guard.totalMinted()).to.equal(120)

      // Burn from bank
      const burnAmount = BigNumber.from(20)
      const tbtcAmount2 = burnAmount.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(controller.address, tbtcAmount2)
      await bank.connect(controller).approve(guard.address, burnAmount)
      await guard.connect(controller).burnFrom(controller.address, burnAmount)
      expect(await guard.totalMinted()).to.equal(100)

      // Mint again
      await guard.connect(controller).mintToBank(controller.address, 75)
      expect(await guard.totalMinted()).to.equal(175)
    })

    it("emits correct events for exposure changes", async () => {
      // Test mint event
      await expect(
        guard.connect(controller).mintToBank(controller.address, 100)
      )
        .to.emit(guard, "BankMintExecuted")
        .withArgs(controller.address, controller.address, 100, 100)
        .and.to.emit(guard, "TotalMintedIncreased")
        .withArgs(100, 100)

      // Test unmintAndBurnFrom event
      const unmintAmount = BigNumber.from(30)
      const tbtcAmount = unmintAmount.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(controller.address, tbtcAmount)
      await tbtcToken.connect(controller).approve(guard.address, tbtcAmount)

      await expect(
        guard
          .connect(controller)
          .unmintAndBurnFrom(controller.address, unmintAmount)
      )
        .to.emit(guard, "UnmintAndBurnExecuted")
        .withArgs(controller.address, controller.address, 30, 70)
        .and.to.emit(guard, "TotalMintedDecreased")
        .withArgs(30, 70)

      // Test burnFrom event
      const burnAmount = BigNumber.from(20)
      const tbtcAmount2 = burnAmount.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(controller.address, tbtcAmount2)
      await bank.connect(controller).approve(guard.address, burnAmount)

      await expect(
        guard.connect(controller).burnFrom(controller.address, burnAmount)
      )
        .to.emit(guard, "BurnExecuted")
        .withArgs(controller.address, controller.address, 20, 50)
        .and.to.emit(guard, "TotalMintedDecreased")
        .withArgs(20, 50)
    })

    it("prevents exposure underflow on unmintAndBurnFrom", async () => {
      await guard.connect(owner).setTotalMinted(50)

      const burnAmount = BigNumber.from(100)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(controller.address, tbtcAmount)
      await tbtcToken.connect(controller).approve(guard.address, tbtcAmount)

      await expect(
        guard
          .connect(controller)
          .unmintAndBurnFrom(controller.address, burnAmount)
      ).to.be.reverted

      expect(await guard.totalMinted()).to.equal(50)
    })

    it("prevents exposure underflow on burnFrom", async () => {
      await guard.connect(owner).setTotalMinted(50)

      const burnAmount = BigNumber.from(100)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(controller.address, tbtcAmount)
      await bank.connect(controller).approve(guard.address, burnAmount)

      await expect(
        guard.connect(controller).burnFrom(controller.address, burnAmount)
      ).to.be.reverted

      expect(await guard.totalMinted()).to.equal(50)
    })
  })

  describe("wiring", () => {
    it("reverts on zero addresses", async () => {
      await expect(guard.connect(owner).setVault(ethers.constants.AddressZero))
        .to.be.reverted
    })
  })
})
