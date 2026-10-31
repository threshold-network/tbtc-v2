import { ethers, helpers } from "hardhat"
import { expect } from "chai"

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import type { Bridge, BridgeStub } from "../../typechain"

import bridgeFixture from "../fixtures/bridge"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { ZeroAddress, ZeroHash } = ethers

const spvMaintainerRevert = "Caller is not SPV maintainer"
const governanceRevert = "Caller is not the governance"
const routerNotSetRevert = "Reservation router not set"

// The SPV maintainer check runs in a modifier, before any argument is looked
// at, so structurally empty proof data is enough to reach it.
const emptyTxInfo = {
  version: "0x00000000",
  inputVector: "0x",
  outputVector: "0x",
  locktime: "0x00000000",
}
const emptyTxProof = {
  merkleProof: "0x",
  txIndexInBlock: 0,
  bitcoinHeaders: "0x",
  coinbasePreimage: ZeroHash,
  coinbaseProof: "0x",
}
const emptyUtxo = {
  txHash: ZeroHash,
  txOutputIndex: 0,
  txOutputValue: 0,
}
const zeroWalletPubKeyHash = "0x0000000000000000000000000000000000000000"

describe("Bridge - access control on the Bridge address", () => {
  let governance: HardhatEthersSigner
  let spvMaintainer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let bridge: Bridge & BridgeStub
  let deployBridge: (
    txProofDifficultyFactor: number
  ) => Promise<[Bridge & BridgeStub]>

  before(async () => {
    ;({ governance, spvMaintainer, thirdParty, bridge, deployBridge } =
      await bridgeFixture())
  })

  describe("SPV maintainer only proof submission", () => {
    const submissions: {
      name: string
      call: (caller: HardhatEthersSigner) => Promise<unknown>
    }[] = [
      {
        name: "submitDepositSweepProof",
        call: (caller) =>
          bridge
            .connect(caller)
            .submitDepositSweepProof(
              emptyTxInfo,
              emptyTxProof,
              emptyUtxo,
              ZeroAddress
            ),
      },
      {
        name: "submitRedemptionProof",
        call: (caller) =>
          bridge
            .connect(caller)
            .submitRedemptionProof(
              emptyTxInfo,
              emptyTxProof,
              emptyUtxo,
              zeroWalletPubKeyHash
            ),
      },
      {
        name: "submitMovingFundsProof",
        call: (caller) =>
          bridge
            .connect(caller)
            .submitMovingFundsProof(
              emptyTxInfo,
              emptyTxProof,
              emptyUtxo,
              zeroWalletPubKeyHash
            ),
      },
      {
        name: "submitMovedFundsSweepProof",
        call: (caller) =>
          bridge
            .connect(caller)
            .submitMovedFundsSweepProof(emptyTxInfo, emptyTxProof, emptyUtxo),
      },
    ]

    submissions.forEach(({ name, call }) => {
      describe(name, () => {
        context(
          "when called by an address that is not an SPV maintainer",
          () => {
            it("should revert", async () => {
              await expect(call(thirdParty)).to.be.revertedWith(
                spvMaintainerRevert
              )
            })
          }
        )

        context("when called by the governance EOA", () => {
          it("should revert", async () => {
            // Governance is a different role: being governance does not
            // grant the SPV maintainer permission.
            await expect(call(governance)).to.be.revertedWith(
              spvMaintainerRevert
            )
          })
        })

        context("when called by an SPV maintainer", () => {
          it("should pass the SPV maintainer check", async () => {
            // The empty proof data is rejected further down, with a
            // different reason. This is the control that keeps the revert
            // tests above from passing because every call reverts.
            await expect(call(spvMaintainer)).to.not.be.revertedWith(
              spvMaintainerRevert
            )
          })
        })
      })
    })
  })

  describe("governance only parameter updates called directly on the Bridge", () => {
    // Governance of the Bridge is the BridgeGovernance contract, so even the
    // governance EOA is rejected when it bypasses BridgeGovernance.
    describe("setSpvMaintainerStatus", () => {
      it("should revert when called directly by the governance EOA", async () => {
        await expect(
          bridge
            .connect(governance)
            .setSpvMaintainerStatus(thirdParty.address, true)
        ).to.be.revertedWith(governanceRevert)
      })
    })

    describe("updateDepositParameters", () => {
      it("should revert when called directly by the governance EOA", async () => {
        await expect(
          bridge
            .connect(governance)
            .updateDepositParameters(1000000, 2000, 100000, 1296000)
        ).to.be.revertedWith(governanceRevert)
      })
    })

    describe("updateRedemptionParameters", () => {
      it("should revert when called directly by the governance EOA", async () => {
        await expect(
          bridge
            .connect(governance)
            .updateRedemptionParameters(
              1000000,
              2000,
              100000,
              1000000,
              432000,
              100n * 10n ** 18n,
              100
            )
        ).to.be.revertedWith(governanceRevert)
      })
    })
  })

  describe("reservation router fallback", () => {
    // A selector no Bridge function and no router function declares.
    const unknownSelectorCall = "0xdeadbeef"

    context("when no reservation router has been set", () => {
      let freshBridge: BridgeStub

      before(async () => {
        await createSnapshot()

        ;[freshBridge] = await deployBridge(1)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should have no router configured", async () => {
        expect(await freshBridge.getReservationRouter()).to.equal(ZeroAddress)
      })

      it("should revert an unknown selector with the router-not-set reason", async () => {
        await expect(
          thirdParty.sendTransaction({
            to: freshBridge.target,
            data: unknownSelectorCall,
          })
        ).to.be.revertedWith(routerNotSetRevert)
      })
    })

    context("when a reservation router has been set", () => {
      let freshBridge: BridgeStub

      before(async () => {
        await createSnapshot()

        ;[freshBridge] = await deployBridge(1)
        // Any contract works as the router: the Bank has no fallback, so the
        // delegatecall fails with empty return data.
        await freshBridge.setReservationRouter(
          (await bridge.contractReferences()).bank
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should not revert with the router-not-set reason", async () => {
        await expect(
          thirdParty.sendTransaction({
            to: freshBridge.target,
            data: unknownSelectorCall,
          })
        ).to.not.be.revertedWith(routerNotSetRevert)
      })
    })
  })
})
