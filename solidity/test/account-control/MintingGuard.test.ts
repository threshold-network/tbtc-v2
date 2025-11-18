import { ethers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"

import type { MintingGuard } from "../typechain"

describe("MintingGuard", () => {
  let owner: SignerWithAddress
  let controller: SignerWithAddress
  let thirdParty: SignerWithAddress

  let guard: MintingGuard

  before(async () => {
    const signers = await ethers.getSigners()
    ;[owner, controller, thirdParty] = signers

    const MintingGuardFactory = await ethers.getContractFactory("MintingGuard")
    guard = (await MintingGuardFactory.deploy(
      owner.address,
      controller.address
    )) as MintingGuard
    await guard.deployed()
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
      await expect(
        guard.connect(thirdParty).increaseTotalMinted(1)
      ).to.be.revertedWithCustomError(guard, "NotController")

      await expect(
        guard.connect(thirdParty).decreaseTotalMinted(1)
      ).to.be.revertedWithCustomError(guard, "NotController")
    })

    it("should enforce global mint cap", async () => {
      await guard.connect(owner).setGlobalMintCap(200)

      await guard.connect(controller).increaseTotalMinted(150)
      expect(await guard.totalMinted()).to.equal(150)

      await expect(
        guard.connect(controller).increaseTotalMinted(100)
      ).to.be.revertedWithCustomError(guard, "GlobalMintCapExceeded")
    })

    it("should enforce minting pause", async () => {
      await guard.connect(owner).setMintingPaused(true)

      await expect(
        guard.connect(controller).increaseTotalMinted(1)
      ).to.be.revertedWithCustomError(guard, "MintingPausedError")

      await guard.connect(owner).setMintingPaused(false)

      await guard.connect(controller).increaseTotalMinted(10)
      expect(await guard.totalMinted()).to.equal(160) // 150 + 10
    })

    it("should prevent underflow on decrease", async () => {
      const current = await guard.totalMinted()
      await expect(
        guard.connect(controller).decreaseTotalMinted(current.add(1))
      ).to.be.revertedWith("MintingGuard: underflow")
    })
  })
})
