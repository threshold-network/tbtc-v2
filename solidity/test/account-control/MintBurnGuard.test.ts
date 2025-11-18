import { ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"

import type {
  MintBurnGuard,
  MockBridgeMintingAuthorization,
  MockBurnBank,
  MockBurnVault,
} from "../typechain"

describe("MintBurnGuard", () => {
  let owner: SignerWithAddress
  let controller: SignerWithAddress
  let thirdParty: SignerWithAddress

  let guard: MintBurnGuard
  let bridge: MockBridgeMintingAuthorization
  let bank: MockBurnBank
  let vault: MockBurnVault

  before(async () => {
    const signers = await ethers.getSigners()
    ;[owner, controller, thirdParty] = signers

    const MockBridgeFactory = await ethers.getContractFactory(
      "MockBridgeMintingAuthorization"
    )
    bridge = (await MockBridgeFactory.deploy(
      owner.address
    )) as MockBridgeMintingAuthorization
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
    await bridge.connect(owner).setControllerBalanceIncreaser(guard.address)
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
    it("should allow controller to increase and decrease totalMinted", async () => {
      const amount = 100
      await expect(guard.connect(controller).increaseTotalMinted(amount))
        .to.emit(guard, "TotalMintedIncreased")
        .withArgs(amount, amount)

      expect(await guard.totalMinted()).to.equal(amount)

      await expect(guard.connect(controller).decreaseTotalMinted(amount))
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(amount, 0)

      expect(await guard.totalMinted()).to.equal(0)
    })

    it("should revert when non-controller tries to mutate totals", async () => {
      await expect(guard.connect(thirdParty).increaseTotalMinted(1)).to.be
        .reverted

      await expect(guard.connect(thirdParty).decreaseTotalMinted(1)).to.be
        .reverted
    })

    it("should enforce global mint cap", async () => {
      await guard.connect(owner).setGlobalMintCap(200)

      await guard.connect(controller).increaseTotalMinted(150)
      expect(await guard.totalMinted()).to.equal(150)

      await expect(guard.connect(controller).increaseTotalMinted(100)).to.be
        .reverted

      // Ensure failed mint did not change exposure.
      expect(await guard.totalMinted()).to.equal(150)
    })

    it("should enforce minting pause", async () => {
      await guard.connect(owner).setMintingPaused(true)

      await expect(guard.connect(controller).increaseTotalMinted(1)).to.be
        .reverted

      await guard.connect(owner).setMintingPaused(false)

      await guard.connect(controller).increaseTotalMinted(10)
      expect(await guard.totalMinted()).to.equal(160) // 150 + 10
    })

    it("should prevent underflow on decrease", async () => {
      const current = await guard.totalMinted()
      await expect(
        guard.connect(controller).decreaseTotalMinted(current.add(1))
      ).to.be.revertedWith("MintBurnGuard: underflow")
    })

    it("mints via bridge and updates exposure", async () => {
      const amount = 1_000n

      // Ensure caps and pause do not interfere with this happy-path test.
      await guard.connect(owner).setMintingPaused(false)
      await guard.connect(owner).setGlobalMintCap(0)

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

    it("reduces exposure without affecting external state", async () => {
      const current = await guard.totalMinted()
      const burnAmount = current.div(2)

      await expect(
        guard
          .connect(controller)
          .reduceExposureAndBurn(controller.address, burnAmount)
      )
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(burnAmount, current.sub(burnAmount))

      expect(await guard.totalMinted()).to.equal(current.sub(burnAmount))
    })

    it("burns via bank and updates exposure", async () => {
      const burnAmount = 50n

      const current = await guard.totalMinted()
      await expect(
        guard.connect(controller).burnFromBank(controller.address, burnAmount)
      )
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(burnAmount, current.sub(burnAmount))

      expect(await guard.totalMinted()).to.equal(current.sub(burnAmount))
      expect(await bank.lastBurnAmount()).to.equal(burnAmount)
    })

    it("unmints via vault and updates exposure", async () => {
      const current = await guard.totalMinted()
      const unmintAmount = current.div(4)

      await expect(guard.connect(controller).unmintFromVault(unmintAmount))
        .to.emit(guard, "TotalMintedDecreased")
        .withArgs(unmintAmount, current.sub(unmintAmount))

      expect(await guard.totalMinted()).to.equal(current.sub(unmintAmount))
      expect(await vault.lastUnmintAmount()).to.equal(unmintAmount)
    })
  })

  describe("rate limiting", () => {
    it("enforces the configured limit within a window", async () => {
      await guard.connect(owner).setMintRateLimit(500, 60)

      await guard.connect(controller).increaseTotalMinted(200)
      await guard.connect(controller).increaseTotalMinted(300)

      const totalBeforeRevert = await guard.totalMinted()

      await expect(guard.connect(controller).increaseTotalMinted(1)).to.be
        .reverted

      expect(await guard.totalMinted()).to.equal(totalBeforeRevert)
      expect(await guard.mintRateWindowAmount()).to.equal(500)
    })

    it("resets the rate window after the configured duration", async () => {
      const windowSeconds = 60
      await guard.connect(owner).setMintRateLimit(200, windowSeconds)

      await guard.connect(controller).increaseTotalMinted(200)

      await ethers.provider.send("evm_increaseTime", [windowSeconds + 1])
      await ethers.provider.send("evm_mine", [])

      await guard.connect(controller).increaseTotalMinted(100)
      expect(await guard.mintRateWindowAmount()).to.equal(100)
    })

    it("allows disabling the rate limit via zero configuration", async () => {
      await guard.connect(owner).setMintRateLimit(300, 120)

      await guard.connect(controller).increaseTotalMinted(300)
      const totalBeforeRevert = await guard.totalMinted()

      await expect(guard.connect(controller).increaseTotalMinted(1)).to.be
        .reverted

      expect(await guard.totalMinted()).to.equal(totalBeforeRevert)
      expect(await guard.mintRateWindowAmount()).to.equal(300)

      await guard.connect(owner).setMintRateLimit(0, 0)

      await guard.connect(controller).increaseTotalMinted(1)
    })
  })
})
