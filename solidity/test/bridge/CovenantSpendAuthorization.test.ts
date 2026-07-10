import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { Contract } from "ethers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("CovenantSpendAuthorization", () => {
  let owner: SignerWithAddress
  let thirdParty: SignerWithAddress
  let authorization: Contract

  const fundingTxHash = `0x${"11".repeat(31)}01`
  const fundingOutputIndex = 3
  const walletPubKeyHash = `0x${"ab".repeat(20)}`
  const value = 1000000
  const outputsHash = ethers.utils.sha256("0xc0ffee")

  // Mirrors the on-chain key derivation:
  // keccak256(abi.encodePacked(fundingTxHash, fundingOutputIndex)).
  const utxoKey = ethers.BigNumber.from(
    ethers.utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [fundingTxHash, fundingOutputIndex]
    )
  )

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[owner, thirdParty] = await ethers.getSigners()

    const CovenantSpendAuthorization = await ethers.getContractFactory(
      "CovenantSpendAuthorization"
    )
    authorization = await CovenantSpendAuthorization.connect(owner).deploy()
  })

  describe("authorizeCovenantSpend", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          authorization
            .connect(thirdParty)
            .authorizeCovenantSpend(
              fundingTxHash,
              fundingOutputIndex,
              walletPubKeyHash,
              value,
              outputsHash
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the wallet public key hash is zero", () => {
      it("should revert", async () => {
        await expect(
          authorization
            .connect(owner)
            .authorizeCovenantSpend(
              fundingTxHash,
              fundingOutputIndex,
              `0x${"00".repeat(20)}`,
              value,
              outputsHash
            )
        ).to.be.revertedWith("Wallet public key hash must not be zero")
      })
    })

    context("when the value is zero", () => {
      it("should revert", async () => {
        await expect(
          authorization
            .connect(owner)
            .authorizeCovenantSpend(
              fundingTxHash,
              fundingOutputIndex,
              walletPubKeyHash,
              0,
              outputsHash
            )
        ).to.be.revertedWith("Value must be positive")
      })
    })

    context("when called by the owner with valid parameters", () => {
      before(async () => {
        await createSnapshot()

        await authorization
          .connect(owner)
          .authorizeCovenantSpend(
            fundingTxHash,
            fundingOutputIndex,
            walletPubKeyHash,
            value,
            outputsHash
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should store the authorization", async () => {
        const stored = await authorization.authorizations(utxoKey)
        expect(stored.walletPubKeyHash).to.equal(walletPubKeyHash)
        expect(stored.value).to.equal(value)
        expect(stored.active).to.equal(true)
        expect(stored.outputsHash).to.equal(outputsHash)
      })

      it("should authorize the exact bindings", async () => {
        expect(
          await authorization.isAuthorized(
            utxoKey,
            walletPubKeyHash,
            value,
            outputsHash
          )
        ).to.equal(true)
      })

      it("should not authorize a different wallet", async () => {
        expect(
          await authorization.isAuthorized(
            utxoKey,
            `0x${"cd".repeat(20)}`,
            value,
            outputsHash
          )
        ).to.equal(false)
      })

      it("should not authorize a different value", async () => {
        expect(
          await authorization.isAuthorized(
            utxoKey,
            walletPubKeyHash,
            value + 1,
            outputsHash
          )
        ).to.equal(false)
      })

      it("should not authorize a different outputs hash", async () => {
        expect(
          await authorization.isAuthorized(
            utxoKey,
            walletPubKeyHash,
            value,
            ethers.utils.sha256("0xbeef")
          )
        ).to.equal(false)
      })

      it("should reject re-authorizing the same outpoint", async () => {
        // The outpoint is already authorized by the before hook. A second
        // authorization — even a different wallet/value/outputs — must revert,
        // so an authorization can never be overwritten.
        await expect(
          authorization
            .connect(owner)
            .authorizeCovenantSpend(
              fundingTxHash,
              fundingOutputIndex,
              `0x${"cd".repeat(20)}`,
              value + 1,
              ethers.utils.sha256("0xbeef")
            )
        ).to.be.revertedWith("Covenant spend already authorized")
      })
    })

    context("when authorizing a fresh outpoint", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit CovenantSpendAuthorized", async () => {
        await expect(
          authorization
            .connect(owner)
            .authorizeCovenantSpend(
              fundingTxHash,
              fundingOutputIndex,
              walletPubKeyHash,
              value,
              outputsHash
            )
        )
          .to.emit(authorization, "CovenantSpendAuthorized")
          .withArgs(utxoKey, walletPubKeyHash, value, outputsHash)
      })
    })
  })
})
