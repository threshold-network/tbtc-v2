import { expect } from "chai"
import { ContractTransaction } from "ethers"
import { helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import bridgeFixture from "../fixtures/bridge"
import type { Bridge, BridgeStub, BridgeGovernance } from "../../typechain"
import { loadFixture } from "../helpers/fixture"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Bridge - Vaults", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, bridge, bridgeGovernance } = await loadFixture(
      bridgeFixture
    ))
  })

  describe("isVaultTrusted", () => {
    const vault = "0x2553E09f832c9f5C656808bb7A24793818877732"

    it("should not trust a vault by default", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await bridge.isVaultTrusted(vault)).to.be.false
    })
  })

  describe("setVaultStatus", () => {
    const vault = "0x2553E09f832c9f5C656808bb7A24793818877732"

    describe("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          bridgeGovernance.connect(thirdParty).setVaultStatus(vault, true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert", async () => {
        await expect(
          bridge.connect(governance).setVaultStatus(vault, true)
        ).to.be.revertedWith("Caller is not the governance")
      })
    })

    describe("when called by the governance", () => {
      let tx: ContractTransaction

      describe("when setting vault status as trusted", () => {
        before(async () => {
          await createSnapshot()
          tx = await bridgeGovernance
            .connect(governance)
            .setVaultStatus(vault, true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should correctly update vault status", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await bridge.isVaultTrusted(vault)).to.be.true
        })

        it("should emit VaultStatusUpdated event", async () => {
          await expect(tx)
            .to.emit(bridge, "VaultStatusUpdated")
            .withArgs(vault, true)
        })
      })

      describe("when setting vault status as no longer trusted", () => {
        before(async () => {
          await createSnapshot()
          await bridgeGovernance.connect(governance).setVaultStatus(vault, true)
          tx = await bridgeGovernance
            .connect(governance)
            .setVaultStatus(vault, false)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should correctly update vault status", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await bridge.isVaultTrusted(vault)).to.be.false
        })

        it("should emit VaultStatusUpdated event", async () => {
          await expect(tx)
            .to.emit(bridge, "VaultStatusUpdated")
            .withArgs(vault, false)
        })
      })
    })
  })
})
