/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber } from "ethers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Bitcoin minimum-difficulty target: compact bits 0x1d00ffff.
// Matches the constant in SepoliaLightRelay.sol and BitcoinTx.sol.
const MIN_DIFFICULTY_TARGET = BigNumber.from(
  "0xffff0000000000000000000000000000000000000000000000000000"
)

// Arbitrary non-minimum target used to represent a real epoch target.
const SOME_TARGET = BigNumber.from(12345)

// 80-byte synthetic header whose nBits (LE bytes 72-75) = ff ff 00 1d,
// producing MIN_DIFFICULTY_TARGET and difficulty = 1.
const DIFF1_HEADER = `0x${"00".repeat(72)}ffff001d00000000`

// First 80 bytes of the mainnet headers from BitcoinTx.test.ts.
// nBits LE = a1 19 28 17 -> difficulty 7019199231177.
const NORMAL_HEADER =
  "0x" +
  "0000002073bd2184edd9c4fc76642ea6754ee401" +
  "36970efc10c4190000000000000000000296ef12" +
  "3ea96da5cf695f22bf7d94be87d49db1ad7ac371" +
  "ac43c4da4161c8c216349c5ba11928170d38782b"

const NORMAL_DIFFICULTY = 7019199231177

describe("SepoliaLightRelay", () => {
  let governance: SignerWithAddress
  let other: SignerWithAddress
  let relay: any

  before(async () => {
    const [g, o] = await ethers.getSigners()
    governance = g
    other = o
    const Factory = await ethers.getContractFactory("TestSepoliaLightRelay")
    relay = await Factory.deploy()
    await relay.deployed()
    await relay.transferOwnership(governance.address)
  })

  describe("setDifficultyFromHeaders", () => {
    context("when called by the owner with a DIFF1 header", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).setDifficultyFromHeaders(DIFF1_HEADER)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("sets the current epoch difficulty to 1", async () => {
        expect(await relay.getCurrentEpochDifficulty()).to.equal(1)
      })

      it("sets the previous epoch difficulty to 1", async () => {
        expect(await relay.getPrevEpochDifficulty()).to.equal(1)
      })
    })

    context("when called by the owner with a normal-difficulty header", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).setDifficultyFromHeaders(NORMAL_HEADER)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("sets the current epoch difficulty from the header nBits", async () => {
        expect(await relay.getCurrentEpochDifficulty()).to.equal(
          NORMAL_DIFFICULTY
        )
      })

      it("sets the previous epoch difficulty from the header nBits", async () => {
        expect(await relay.getPrevEpochDifficulty()).to.equal(NORMAL_DIFFICULTY)
      })
    })

    context("when called by a non-owner", () => {
      it("reverts", async () => {
        await expect(
          relay.connect(other).setDifficultyFromHeaders(DIFF1_HEADER)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })
  })

  describe("isValidPreRetargetTarget", () => {
    context("when the header target equals the old target", () => {
      it("returns true", async () => {
        expect(
          await relay.isValidPreRetargetTargetPublic(SOME_TARGET, SOME_TARGET)
        ).to.be.true
      })
    })

    context("when the header target is MIN_DIFFICULTY_TARGET", () => {
      it("returns true regardless of the old target", async () => {
        expect(
          await relay.isValidPreRetargetTargetPublic(
            MIN_DIFFICULTY_TARGET,
            SOME_TARGET
          )
        ).to.be.true
      })
    })

    context(
      "when the header target differs from the old target and is not MIN_DIFFICULTY_TARGET",
      () => {
        it("returns false", async () => {
          expect(
            await relay.isValidPreRetargetTargetPublic(
              SOME_TARGET,
              SOME_TARGET.add(1)
            )
          ).to.be.false
        })
      }
    )
  })

  describe("isValidPostRetargetTarget", () => {
    context("when the header target equals the mined target", () => {
      it("returns true", async () => {
        expect(
          await relay.isValidPostRetargetTargetPublic(SOME_TARGET, SOME_TARGET)
        ).to.be.true
      })
    })

    context("when the header target is MIN_DIFFICULTY_TARGET", () => {
      it("returns true regardless of the mined target", async () => {
        expect(
          await relay.isValidPostRetargetTargetPublic(
            MIN_DIFFICULTY_TARGET,
            SOME_TARGET
          )
        ).to.be.true
      })
    })

    context(
      "when the header target differs from the mined target and is not MIN_DIFFICULTY_TARGET",
      () => {
        it("returns false", async () => {
          expect(
            await relay.isValidPostRetargetTargetPublic(
              SOME_TARGET,
              SOME_TARGET.add(1)
            )
          ).to.be.false
        })
      }
    )
  })
})
