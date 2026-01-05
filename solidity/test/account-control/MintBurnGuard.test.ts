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
  MockAccountControl,
} from "../typechain"

describe("MintBurnGuard", () => {
  const SATOSHI_MULTIPLIER = BigNumber.from("10000000000")

  let owner: SignerWithAddress
  let operator: SignerWithAddress
  let thirdParty: SignerWithAddress
  let reserve: SignerWithAddress
  let user: SignerWithAddress

  let guard: MintBurnGuard
  let bridge: MockBridgeController
  let bank: MockBurnBank
  let vault: MockBurnVault
  let tbtcToken: MockTBTC
  let accountControl: MockAccountControl

  before(async () => {
    const signers = await ethers.getSigners()
    ;[owner, operator, thirdParty, reserve, user] = signers

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
      operator.address,
      vault.address
    )) as MintBurnGuard
    await guard.deployed()

    await bridge.connect(owner).setMintingController(guard.address)
  })

  describe("initialization", () => {
    it("should set owner and operator", async () => {
      expect(await guard.owner()).to.equal(owner.address)
      expect(await guard.operator()).to.equal(operator.address)
    })

    it("should allow owner to change operator", async () => {
      const newOperator = thirdParty

      // Change operator
      await expect(guard.connect(owner).setOperator(newOperator.address))
        .to.emit(guard, "OperatorUpdated")
        .withArgs(operator.address, newOperator.address)

      expect(await guard.operator()).to.equal(newOperator.address)

      // Old operator can no longer call functions
      await expect(guard.connect(operator).mintToBank(operator.address, 1)).to
        .be.reverted

      // New operator can call functions
      await guard.connect(owner).setMintingPaused(false)
      await expect(
        guard.connect(newOperator).mintToBank(newOperator.address, 1)
      ).to.not.be.reverted

      expect(await guard.totalMinted()).to.equal(1)

      // Change back to original operator for other tests
      await guard.connect(owner).setOperator(operator.address)
    })

    it("should not allow non-owner to change operator", async () => {
      await expect(
        guard.connect(operator).setOperator(thirdParty.address)
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
        guard.connect(operator).setTotalMinted(100)
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(guard.connect(owner).setTotalMinted(75))
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(75, 75)
    })

    it("should enforce global mint cap", async () => {
      await guard.connect(owner).setGlobalMintCap(200)

      await guard.connect(operator).mintToBank(operator.address, 150)
      expect(await guard.totalMinted()).to.equal(150)

      await expect(guard.connect(operator).mintToBank(operator.address, 100)).to
        .be.reverted

      // Ensure failed mint did not change exposure.
      expect(await guard.totalMinted()).to.equal(150)
    })

    it("should enforce minting pause", async () => {
      await guard.connect(owner).setMintingPaused(true)

      await expect(guard.connect(operator).mintToBank(operator.address, 1)).to
        .be.reverted

      await guard.connect(owner).setMintingPaused(false)

      await guard.connect(operator).mintToBank(operator.address, 10)
      expect(await guard.totalMinted()).to.equal(10)
    })

    it("requires non-operator calls to revert", async () => {
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
          .connect(operator)
          .unmintAndBurnFrom(operator.address, current.add(1))
      ).to.be.reverted
    })

    it("mints via bridge and updates exposure", async () => {
      const amount = 1_000n

      // Ensure caps and pause do not interfere with this happy-path test.
      await guard.connect(owner).setMintingPaused(false)

      const previousTotal = await guard.totalMinted()
      await expect(guard.connect(operator).mintToBank(operator.address, amount))
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

      // Mint TBTC tokens to operator for testing
      await tbtcToken.mint(operator.address, tbtcAmount)

      // Operator approves guard to spend TBTC
      await tbtcToken.connect(operator).approve(guard.address, tbtcAmount)

      await expect(
        guard.connect(operator).unmintAndBurnFrom(operator.address, burnAmount)
      )
        .to.emit(guard, "UnmintAndBurnExecuted")
        .withArgs(
          operator.address,
          operator.address,
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

      // Set up bank balance for operator
      await bank.setBalance(operator.address, tbtcAmount)

      // Operator approves guard to transfer bank balance
      await bank.connect(operator).approve(guard.address, burnAmount)

      await expect(
        guard.connect(operator).burnFrom(operator.address, burnAmount)
      )
        .to.emit(guard, "BurnExecuted")
        .withArgs(
          operator.address,
          operator.address,
          burnAmount,
          current.sub(burnAmount)
        )
        .and.to.emit(guard, "TotalMintedDecreased")
        .withArgs(burnAmount, current.sub(burnAmount))

      expect(await guard.totalMinted()).to.equal(current.sub(burnAmount))
      expect(await bank.lastBurnAmount()).to.equal(tbtcAmount)
      expect(await bank.lastTransferFrom()).to.equal(operator.address)
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

      await guard.connect(operator).mintToBank(operator.address, 200)
      await guard.connect(operator).mintToBank(operator.address, 300)

      const totalBeforeRevert = await guard.totalMinted()

      await expect(guard.connect(operator).mintToBank(operator.address, 1)).to
        .be.reverted

      expect(await guard.totalMinted()).to.equal(totalBeforeRevert)
      expect(await guard.mintRateWindowAmount()).to.equal(500)
    })

    it("resets the rate window after the configured duration", async () => {
      const windowSeconds = 60
      await guard.connect(owner).setMintRateLimit(200, windowSeconds)

      await guard.connect(operator).mintToBank(operator.address, 200)

      await ethers.provider.send("evm_increaseTime", [windowSeconds + 1])
      await ethers.provider.send("evm_mine", [])

      await guard.connect(operator).mintToBank(operator.address, 100)
      expect(await guard.mintRateWindowAmount()).to.equal(100)
    })

    it("allows disabling the rate limit via zero configuration", async () => {
      await guard.connect(owner).setMintRateLimit(300, 120)

      await guard.connect(operator).mintToBank(operator.address, 300)
      const totalBeforeRevert = await guard.totalMinted()

      await expect(guard.connect(operator).mintToBank(operator.address, 1)).to
        .be.reverted

      expect(await guard.totalMinted()).to.equal(totalBeforeRevert)
      expect(await guard.mintRateWindowAmount()).to.equal(300)

      await guard.connect(owner).setMintRateLimit(0, 0)

      await guard.connect(operator).mintToBank(operator.address, 1)
    })

    it("resets rate window on total override", async () => {
      await guard.connect(owner).setMintRateLimit(300, 120)
      await guard.connect(operator).mintToBank(operator.address, 200)
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
          .connect(operator)
          .unmintAndBurnFrom(thirdParty.address, burnAmount)
      ).to.be.revertedWith("ERC20: insufficient allowance")

      // Approve guard to spend TBTC
      await tbtcToken.connect(thirdParty).approve(guard.address, tbtcAmount)

      // Now it should work
      await expect(
        guard
          .connect(operator)
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
        guard.connect(operator).burnFrom(thirdParty.address, burnAmount)
      ).to.be.revertedWith("MockBurnBank: insufficient allowance")

      // Approve guard to transfer bank balance
      await bank.connect(thirdParty).approve(guard.address, burnAmount)

      // Now it should work
      await expect(
        guard.connect(operator).burnFrom(thirdParty.address, burnAmount)
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
          .connect(operator)
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

      await guard.connect(operator).mintToBank(operator.address, 100)
      expect(await guard.totalMinted()).to.equal(100)

      await guard.connect(operator).mintToBank(operator.address, 50)
      expect(await guard.totalMinted()).to.equal(150)

      await guard.connect(operator).mintToBank(operator.address, 25)
      expect(await guard.totalMinted()).to.equal(175)
    })

    it("tracks exposure correctly through unmintAndBurnFrom operations", async () => {
      // Start with some minted exposure
      await guard.connect(owner).setTotalMinted(200)
      expect(await guard.totalMinted()).to.equal(200)

      const burnAmount1 = BigNumber.from(50)
      const tbtcAmount1 = burnAmount1.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(operator.address, tbtcAmount1)
      await tbtcToken.connect(operator).approve(guard.address, tbtcAmount1)

      await guard
        .connect(operator)
        .unmintAndBurnFrom(operator.address, burnAmount1)
      expect(await guard.totalMinted()).to.equal(150)

      const burnAmount2 = BigNumber.from(75)
      const tbtcAmount2 = burnAmount2.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(operator.address, tbtcAmount2)
      await tbtcToken.connect(operator).approve(guard.address, tbtcAmount2)

      await guard
        .connect(operator)
        .unmintAndBurnFrom(operator.address, burnAmount2)
      expect(await guard.totalMinted()).to.equal(75)
    })

    it("tracks exposure correctly through burnFrom operations", async () => {
      // Start with some minted exposure
      await guard.connect(owner).setTotalMinted(300)
      expect(await guard.totalMinted()).to.equal(300)

      const burnAmount1 = BigNumber.from(100)
      const tbtcAmount1 = burnAmount1.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(operator.address, tbtcAmount1)
      await bank.connect(operator).approve(guard.address, burnAmount1)

      await guard.connect(operator).burnFrom(operator.address, burnAmount1)
      expect(await guard.totalMinted()).to.equal(200)

      const burnAmount2 = BigNumber.from(50)
      const tbtcAmount2 = burnAmount2.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(operator.address, tbtcAmount2)
      await bank.connect(operator).approve(guard.address, burnAmount2)

      await guard.connect(operator).burnFrom(operator.address, burnAmount2)
      expect(await guard.totalMinted()).to.equal(150)
    })

    it("tracks exposure correctly through mixed operations", async () => {
      expect(await guard.totalMinted()).to.equal(0)

      // Mint
      await guard.connect(operator).mintToBank(operator.address, 100)
      expect(await guard.totalMinted()).to.equal(100)

      // Mint more
      await guard.connect(operator).mintToBank(operator.address, 50)
      expect(await guard.totalMinted()).to.equal(150)

      // Unmint and burn
      const unmintAmount = BigNumber.from(30)
      const tbtcAmount = unmintAmount.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(operator.address, tbtcAmount)
      await tbtcToken.connect(operator).approve(guard.address, tbtcAmount)
      await guard
        .connect(operator)
        .unmintAndBurnFrom(operator.address, unmintAmount)
      expect(await guard.totalMinted()).to.equal(120)

      // Burn from bank
      const burnAmount = BigNumber.from(20)
      const tbtcAmount2 = burnAmount.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(operator.address, tbtcAmount2)
      await bank.connect(operator).approve(guard.address, burnAmount)
      await guard.connect(operator).burnFrom(operator.address, burnAmount)
      expect(await guard.totalMinted()).to.equal(100)

      // Mint again
      await guard.connect(operator).mintToBank(operator.address, 75)
      expect(await guard.totalMinted()).to.equal(175)
    })

    it("emits correct events for exposure changes", async () => {
      // Test mint event
      await expect(guard.connect(operator).mintToBank(operator.address, 100))
        .to.emit(guard, "BankMintExecuted")
        .withArgs(operator.address, operator.address, 100, 100)
        .and.to.emit(guard, "TotalMintedIncreased")
        .withArgs(100, 100)

      // Test unmintAndBurnFrom event
      const unmintAmount = BigNumber.from(30)
      const tbtcAmount = unmintAmount.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(operator.address, tbtcAmount)
      await tbtcToken.connect(operator).approve(guard.address, tbtcAmount)

      await expect(
        guard
          .connect(operator)
          .unmintAndBurnFrom(operator.address, unmintAmount)
      )
        .to.emit(guard, "UnmintAndBurnExecuted")
        .withArgs(operator.address, operator.address, 30, 70)
        .and.to.emit(guard, "TotalMintedDecreased")
        .withArgs(30, 70)

      // Test burnFrom event
      const burnAmount = BigNumber.from(20)
      const tbtcAmount2 = burnAmount.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(operator.address, tbtcAmount2)
      await bank.connect(operator).approve(guard.address, burnAmount)

      await expect(
        guard.connect(operator).burnFrom(operator.address, burnAmount)
      )
        .to.emit(guard, "BurnExecuted")
        .withArgs(operator.address, operator.address, 20, 50)
        .and.to.emit(guard, "TotalMintedDecreased")
        .withArgs(20, 50)
    })

    it("prevents exposure underflow on unmintAndBurnFrom", async () => {
      await guard.connect(owner).setTotalMinted(50)

      const burnAmount = BigNumber.from(100)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)
      await tbtcToken.mint(operator.address, tbtcAmount)
      await tbtcToken.connect(operator).approve(guard.address, tbtcAmount)

      await expect(
        guard.connect(operator).unmintAndBurnFrom(operator.address, burnAmount)
      ).to.be.reverted

      expect(await guard.totalMinted()).to.equal(50)
    })

    it("prevents exposure underflow on burnFrom", async () => {
      await guard.connect(owner).setTotalMinted(50)

      const burnAmount = BigNumber.from(100)
      const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)
      await bank.setBalance(operator.address, tbtcAmount)
      await bank.connect(operator).approve(guard.address, burnAmount)

      await expect(
        guard.connect(operator).burnFrom(operator.address, burnAmount)
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

  describe("integration with AccountControl operator", () => {
    before(async () => {
      const MockAccountControlFactory = await ethers.getContractFactory(
        "MockAccountControl"
      )
      accountControl = (await MockAccountControlFactory.deploy(
        guard.address,
        vault.address
      )) as MockAccountControl
      await accountControl.deployed()

      // Set AccountControl as the operator
      await guard.connect(owner).setOperator(accountControl.address)
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)
      await guard.connect(owner).setMintRateLimit(0, 0)
      await guard.connect(owner).setTotalMinted(0)
    })

    describe("mintTBTC flow", () => {
      beforeEach(async () => {
        await guard.connect(owner).setTotalMinted(0)
      })

      it("should allow AccountControl to mint TBTC via mintToBank", async () => {
        const mintAmount = 1000

        await expect(
          accountControl.mintTBTC(reserve.address, user.address, mintAmount)
        )
          .to.emit(guard, "BankMintExecuted")
          .withArgs(
            accountControl.address,
            user.address,
            mintAmount,
            mintAmount
          )
          .and.to.emit(guard, "TotalMintedIncreased")
          .withArgs(mintAmount, mintAmount)
          .and.to.emit(accountControl, "MintExecuted")
          .withArgs(reserve.address, user.address, mintAmount)

        expect(await guard.totalMinted()).to.equal(mintAmount)
      })

      it("should enforce global mint cap through AccountControl", async () => {
        await guard.connect(owner).setGlobalMintCap(500)

        await accountControl.mintTBTC(reserve.address, user.address, 300)
        expect(await guard.totalMinted()).to.equal(300)

        await expect(
          accountControl.mintTBTC(reserve.address, user.address, 300)
        ).to.be.reverted

        expect(await guard.totalMinted()).to.equal(300)
      })

      it("should enforce minting pause through AccountControl", async () => {
        await guard.connect(owner).setMintingPaused(true)

        await expect(
          accountControl.mintTBTC(reserve.address, user.address, 100)
        ).to.be.reverted

        await guard.connect(owner).setMintingPaused(false)

        await expect(
          accountControl.mintTBTC(reserve.address, user.address, 100)
        ).to.not.be.reverted
      })
    })

    describe("returnTBTC flow", () => {
      beforeEach(async () => {
        await guard.connect(owner).setGlobalMintCap(0)
        await guard.connect(owner).setTotalMinted(1000)
      })

      it("should allow reserve to return TBTC via AccountControl", async () => {
        const returnAmount = BigNumber.from(500)
        const tbtcAmount = returnAmount.mul(SATOSHI_MULTIPLIER)

        // Mint TBTC tokens to reserve
        await tbtcToken.mint(reserve.address, tbtcAmount)

        // Reserve approves guard to spend TBTC
        await tbtcToken.connect(reserve).approve(guard.address, tbtcAmount)

        const totalBefore = await guard.totalMinted()

        await expect(accountControl.returnTBTC(reserve.address, returnAmount))
          .to.emit(guard, "UnmintAndBurnExecuted")
          .withArgs(
            accountControl.address,
            reserve.address,
            returnAmount,
            totalBefore.sub(returnAmount)
          )
          .and.to.emit(guard, "TotalMintedDecreased")
          .withArgs(returnAmount, totalBefore.sub(returnAmount))
          .and.to.emit(accountControl, "ReturnExecuted")
          .withArgs(reserve.address, returnAmount)

        expect(await guard.totalMinted()).to.equal(
          totalBefore.sub(returnAmount)
        )
        expect(await vault.lastUnmintAmount()).to.equal(tbtcAmount)
        expect(await bank.lastBurnAmount()).to.equal(tbtcAmount)
      })

      it("should fail if reserve has not approved TBTC to guard", async () => {
        const returnAmount = BigNumber.from(200)
        const tbtcAmount = returnAmount.mul(SATOSHI_MULTIPLIER)

        await tbtcToken.mint(reserve.address, tbtcAmount)

        await expect(
          accountControl.returnTBTC(reserve.address, returnAmount)
        ).to.be.revertedWith("ERC20: insufficient allowance")
      })

      it("should prevent exposure underflow on return", async () => {
        await guard.connect(owner).setTotalMinted(100)

        const returnAmount = BigNumber.from(200)
        const tbtcAmount = returnAmount.mul(SATOSHI_MULTIPLIER)

        await tbtcToken.mint(reserve.address, tbtcAmount)
        await tbtcToken.connect(reserve).approve(guard.address, tbtcAmount)

        await expect(accountControl.returnTBTC(reserve.address, returnAmount))
          .to.be.reverted

        expect(await guard.totalMinted()).to.equal(100)
      })
    })

    describe("notifyRedemption flow", () => {
      beforeEach(async () => {
        await guard.connect(owner).setGlobalMintCap(0)
        await guard.connect(owner).setTotalMinted(2000)
      })

      it("should allow burning user's bank balance via AccountControl", async () => {
        const burnAmount = BigNumber.from(300)
        const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)

        // Set up bank balance for user
        await bank.setBalance(user.address, tbtcAmount)

        // User approves guard to transfer bank balance
        await bank.connect(user).approve(guard.address, burnAmount)

        const totalBefore = await guard.totalMinted()

        await expect(
          accountControl.notifyRedemption(
            reserve.address,
            user.address,
            burnAmount
          )
        )
          .to.emit(guard, "BurnExecuted")
          .withArgs(
            accountControl.address,
            user.address,
            burnAmount,
            totalBefore.sub(burnAmount)
          )
          .and.to.emit(guard, "TotalMintedDecreased")
          .withArgs(burnAmount, totalBefore.sub(burnAmount))
          .and.to.emit(accountControl, "RedemptionExecuted")
          .withArgs(reserve.address, user.address, burnAmount)

        expect(await guard.totalMinted()).to.equal(totalBefore.sub(burnAmount))
        expect(await bank.lastBurnAmount()).to.equal(tbtcAmount)
        expect(await bank.lastTransferFrom()).to.equal(user.address)
        expect(await bank.lastTransferTo()).to.equal(guard.address)
      })

      it("should fail if user has not approved bank balance to guard", async () => {
        const burnAmount = BigNumber.from(200)
        const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)

        await bank.setBalance(user.address, tbtcAmount)

        await expect(
          accountControl.notifyRedemption(
            reserve.address,
            user.address,
            burnAmount
          )
        ).to.be.revertedWith("MockBurnBank: insufficient allowance")
      })

      it("should prevent exposure underflow on redemption", async () => {
        await guard.connect(owner).setTotalMinted(100)

        const burnAmount = BigNumber.from(200)
        const tbtcAmount = burnAmount.mul(SATOSHI_MULTIPLIER)

        await bank.setBalance(user.address, tbtcAmount)
        await bank.connect(user).approve(guard.address, burnAmount)

        await expect(
          accountControl.notifyRedemption(
            reserve.address,
            user.address,
            burnAmount
          )
        ).to.be.reverted

        expect(await guard.totalMinted()).to.equal(100)
      })
    })

    describe("complete reserve lifecycle", () => {
      it("should handle full mint -> return cycle", async () => {
        await guard.connect(owner).setGlobalMintCap(0)
        await guard.connect(owner).setTotalMinted(0)

        // 1. Mint via AccountControl
        const mintAmount = 1000
        await accountControl.mintTBTC(reserve.address, user.address, mintAmount)
        expect(await guard.totalMinted()).to.equal(mintAmount)

        // 2. Reserve returns TBTC
        const returnAmount = BigNumber.from(1000)
        const tbtcAmount = returnAmount.mul(SATOSHI_MULTIPLIER)
        await tbtcToken.mint(reserve.address, tbtcAmount)
        await tbtcToken.connect(reserve).approve(guard.address, tbtcAmount)

        await accountControl.returnTBTC(reserve.address, returnAmount)
        expect(await guard.totalMinted()).to.equal(0)
      })

      it("should handle full mint -> redemption cycle", async () => {
        await guard.connect(owner).setGlobalMintCap(0)
        await guard.connect(owner).setTotalMinted(0)

        // 1. Mint via AccountControl
        const mintAmount = 1000
        await accountControl.mintTBTC(reserve.address, user.address, mintAmount)
        expect(await guard.totalMinted()).to.equal(mintAmount)

        // 2. User redeems
        const redeemAmount = BigNumber.from(1000)
        const tbtcAmount = redeemAmount.mul(SATOSHI_MULTIPLIER)
        await bank.setBalance(user.address, tbtcAmount)
        await bank.connect(user).approve(guard.address, redeemAmount)

        await accountControl.notifyRedemption(
          reserve.address,
          user.address,
          redeemAmount
        )
        expect(await guard.totalMinted()).to.equal(0)
      })

      it("should handle multiple reserves through same AccountControl", async () => {
        await guard.connect(owner).setGlobalMintCap(0)
        await guard.connect(owner).setTotalMinted(0)

        const allSigners = await ethers.getSigners()
        const reserve1 = allSigners[6]
        const reserve2 = allSigners[7]
        const user1 = allSigners[8]
        const user2 = allSigners[9]

        // Reserve 1 mints
        await accountControl.mintTBTC(reserve1.address, user1.address, 500)
        expect(await guard.totalMinted()).to.equal(500)

        // Reserve 2 mints
        await accountControl.mintTBTC(reserve2.address, user2.address, 300)
        expect(await guard.totalMinted()).to.equal(800)

        // Reserve 1 partial redemption
        const redeem1 = BigNumber.from(200)
        const tbtcAmount1 = redeem1.mul(SATOSHI_MULTIPLIER)
        await bank.setBalance(user1.address, tbtcAmount1)
        await bank.connect(user1).approve(guard.address, redeem1)
        await accountControl.notifyRedemption(
          reserve1.address,
          user1.address,
          redeem1
        )
        expect(await guard.totalMinted()).to.equal(600)

        // Reserve 2 returns all
        const return2 = BigNumber.from(300)
        const tbtcAmount2 = return2.mul(SATOSHI_MULTIPLIER)
        await tbtcToken.mint(reserve2.address, tbtcAmount2)
        await tbtcToken.connect(reserve2).approve(guard.address, tbtcAmount2)
        await accountControl.returnTBTC(reserve2.address, return2)
        expect(await guard.totalMinted()).to.equal(300)
      })

      it("should enforce rate limits across all reserves", async () => {
        await guard.connect(owner).setGlobalMintCap(0)
        await guard.connect(owner).setTotalMinted(0)
        await guard.connect(owner).setMintRateLimit(1000, 3600)

        const allSigners = await ethers.getSigners()
        const reserve1 = allSigners[6]
        const reserve2 = allSigners[7]

        // Reserve 1 mints 600
        await accountControl.mintTBTC(reserve1.address, user.address, 600)
        expect(await guard.totalMinted()).to.equal(600)

        // Reserve 2 can only mint 400 more (rate limit = 1000)
        await accountControl.mintTBTC(reserve2.address, user.address, 400)
        expect(await guard.totalMinted()).to.equal(1000)

        // Both reserves hit the rate limit
        await expect(accountControl.mintTBTC(reserve1.address, user.address, 1))
          .to.be.reverted

        await expect(accountControl.mintTBTC(reserve2.address, user.address, 1))
          .to.be.reverted
      })
    })
  })
})
