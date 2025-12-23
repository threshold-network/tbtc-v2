import { BigNumber } from "ethers"
import { ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"

import type {
  MintBurnGuard,
  MockBridgeController,
  MockBurnBank,
  MockBurnVault,
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

    const MintBurnGuardFactory = await ethers.getContractFactory(
      "MintBurnGuard"
    )
    guard = (await MintBurnGuardFactory.deploy(
      owner.address,
      controller.address
    )) as MintBurnGuard
    await guard.deployed()

    const MockBankFactory = await ethers.getContractFactory("MockBurnBank")
    bank = (await MockBankFactory.deploy()) as MockBurnBank
    await bank.deployed()

    const MockVaultFactory = await ethers.getContractFactory("MockBurnVault")
    vault = (await MockVaultFactory.deploy()) as MockBurnVault
    await vault.deployed()

    await guard.connect(owner).setBridge(bridge.address)
    await bridge.connect(owner).setMintingController(guard.address)
    await guard.connect(owner).setBank(bank.address)
    await guard.connect(owner).setVault(vault.address)
  })

  describe("initialization", () => {
    it("should set owner and controller", async () => {
      expect(await guard.owner()).to.equal(owner.address)
      expect(await guard.controller()).to.equal(controller.address)
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
        guard.connect(thirdParty).burnFromBank(thirdParty.address, 1)
      ).to.be.reverted
      await expect(guard.connect(thirdParty).unmintFromVault(1)).to.be.reverted
    })

    it("should prevent underflow on decrease", async () => {
      await guard.connect(owner).setTotalMinted(50)
      const current = await guard.totalMinted()
      await expect(
        guard
          .connect(controller)
          .burnFromBank(controller.address, current.add(1))
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

    it("burns via bank and updates exposure", async () => {
      const burnAmount = BigNumber.from(50)

      await guard.connect(owner).setTotalMinted(burnAmount)
      const current = await guard.totalMinted()
      await expect(
        guard.connect(controller).burnFromBank(controller.address, burnAmount)
      )
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(burnAmount, current.sub(burnAmount))

      expect(await guard.totalMinted()).to.equal(current.sub(burnAmount))
      expect(await bank.lastBurnAmount()).to.equal(
        burnAmount.mul(SATOSHI_MULTIPLIER)
      )
    })

    it("unmints via vault and updates exposure", async () => {
      await guard.connect(owner).setTotalMinted(100)
      const current = await guard.totalMinted()
      const unmintAmount = current.div(4)

      await expect(guard.connect(controller).unmintFromVault(unmintAmount))
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(unmintAmount, current.sub(unmintAmount))

      expect(await guard.totalMinted()).to.equal(current.sub(unmintAmount))
      expect(await vault.lastUnmintAmount()).to.equal(
        unmintAmount.mul(SATOSHI_MULTIPLIER)
      )
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

  describe("wiring", () => {
    it("reverts on zero addresses", async () => {
      await expect(guard.connect(owner).setBridge(ethers.constants.AddressZero))
        .to.be.reverted
      await expect(guard.connect(owner).setBank(ethers.constants.AddressZero))
        .to.be.reverted
      await expect(guard.connect(owner).setVault(ethers.constants.AddressZero))
        .to.be.reverted
      await expect(
        guard
          .connect(owner)
          .configureExecutionTargets(
            ethers.constants.AddressZero,
            bank.address,
            vault.address
          )
      ).to.be.reverted
    })
  })
})
