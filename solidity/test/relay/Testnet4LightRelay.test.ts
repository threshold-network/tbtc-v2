/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"

import type { Testnet4LightRelayStub } from "../../typechain"

import { concatenateHexStrings } from "../helpers/contract-test-helpers"

import headers from "./headersWithRetarget.json"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const genesisBlock = headers.oldPeriodStart
const genesisHeader = genesisBlock.hex
const genesisHeight = genesisBlock.height // 552384

const proofLength = 4

// Bitcoin difficulty 1 (compact bits `0x1d00ffff`).
const MIN_DIFFICULTY_BITS = "0x1d00ffff"
const MIN_DIFFICULTY_TARGET = BigInt(
  "0xffff0000000000000000000000000000000000000000000000000000"
)

function hexToBuffer(hex: string): Buffer {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
  return Buffer.from(normalized, "hex")
}

function bufferToHex(buf: Buffer): string {
  return `0x${buf.toString("hex")}`
}

function setHeaderCompactBits(headerHex: string, bitsCompactHexBE: string) {
  const headerBytes = hexToBuffer(headerHex)
  if (headerBytes.length !== 80) {
    throw new Error(
      `Expected 80-byte header, got ${headerBytes.length} bytes: ${headerHex}`
    )
  }

  const bitsBE = hexToBuffer(bitsCompactHexBE)
  if (bitsBE.length !== 4) {
    throw new Error(`Invalid compact bits: ${bitsCompactHexBE}`)
  }

  // Convert compact bits from big-endian to little-endian on the wire.
  const [be0, be1, be2, be3] = bitsBE
  headerBytes[72] = be3
  headerBytes[73] = be2
  headerBytes[74] = be1
  headerBytes[75] = be0

  return bufferToHex(headerBytes)
}

const fixture = async () => {
  const [deployer, governance, thirdParty] = await ethers.getSigners()

  const Relay = await ethers.getContractFactory("Testnet4LightRelayStub")
  const relay = (await Relay.deploy()) as Testnet4LightRelayStub
  await relay.deployed()

  await relay.connect(deployer).transferOwnership(governance.address)

  return {
    deployer,
    governance,
    thirdParty,
    relay,
  }
}

describe("Testnet4LightRelay", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let relay: Testnet4LightRelayStub

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, relay } = await waffle.loadFixture(fixture))
  })

  //
  // _isTolerableTarget
  //
  describe("_isTolerableTarget", () => {
    it("returns true for the DIFF1 target (0x1d00ffff)", async () => {
      expect(await relay.isTolerableTarget(MIN_DIFFICULTY_TARGET)).to.be.true
    })

    it("returns false for a target that is not DIFF1", async () => {
      const nonDiff1 = BigInt(
        "0x00000000000000000001234500000000000000000000000000000000"
      )
      expect(await relay.isTolerableTarget(nonDiff1)).to.be.false
    })

    it("returns false for zero", async () => {
      expect(await relay.isTolerableTarget(0)).to.be.false
    })

    it("returns false for a target one above DIFF1", async () => {
      expect(await relay.isTolerableTarget(MIN_DIFFICULTY_TARGET + 1n)).to.be
        .false
    })

    it("returns false for a target one below DIFF1", async () => {
      expect(await relay.isTolerableTarget(MIN_DIFFICULTY_TARGET - 1n)).to.be
        .false
    })
  })

  //
  // retarget
  //
  describe("retarget", () => {
    const { chain } = headers
    const headerHex = chain.map((header: { hex: string }) => header.hex)

    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("after genesis (epoch 274)", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      // NOTE: A full positive acceptance test for DIFF1 blocks in the pre- or
      // post-retarget window requires real testnet4 block headers whose hash
      // satisfies the DIFF1 PoW target (hash <= 0x00000000ffff0000...).
      // Such headers can be sourced from a testnet4 node or block explorer and
      // added as fixture data. The tests below cover what is verifiable without
      // real testnet4 fixture data.

      context(
        "with DIFF1 nbits on first post-retarget header (C3: must be rejected)",
        () => {
          // The first header of the new epoch MUST carry the retargeted epoch
          // target so the relay can record it. A DIFF1 first post-retarget header
          // fails the masking check ("Invalid target in new epoch"), but
          // validateHeader's PoW check runs before the target check, so the error
          // seen is "Invalid work" when the nonce does not satisfy DIFF1.
          let retargetHeaders: string

          before(async () => {
            await createSnapshot()

            const baseRetargetHeaders = headerHex.slice(5, 13)
            // Patch the FIRST post-retarget header (index 4 in the 8-header window).
            const diff1FirstPostRetarget = setHeaderCompactBits(
              baseRetargetHeaders[4],
              MIN_DIFFICULTY_BITS
            )

            const modifiedHeaders = [
              ...baseRetargetHeaders.slice(0, 4),
              diff1FirstPostRetarget,
              ...baseRetargetHeaders.slice(5),
            ]
            retargetHeaders = concatenateHexStrings(modifiedHeaders)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert (PoW check rejects modified header)", async () => {
            // The first post-retarget header's hash changes when its nbits
            // field is modified, and almost certainly won't satisfy DIFF1 PoW.
            await expect(
              relay.connect(thirdParty).retarget(retargetHeaders)
            ).to.be.revertedWith("Invalid work")
          })
        }
      )

      context("with DIFF1 nbits on a later post-retarget header", () => {
        // Modifying any post-retarget header (after the first) to DIFF1 nbits
        // changes its hash, which almost certainly won't satisfy DIFF1 PoW.
        // The PoW check in validateHeader fires before the _isTolerableTarget
        // check, so the relay still rejects these fake headers.
        let retargetHeaders: string

        before(async () => {
          await createSnapshot()

          const baseRetargetHeaders = headerHex.slice(5, 13)
          const diff1LastHeader = setHeaderCompactBits(
            baseRetargetHeaders[7],
            MIN_DIFFICULTY_BITS
          )

          const modifiedHeaders = [
            ...baseRetargetHeaders.slice(0, 7),
            diff1LastHeader,
          ]
          retargetHeaders = concatenateHexStrings(modifiedHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert with Invalid work (PoW enforced before target check)", async () => {
          await expect(
            relay.connect(thirdParty).retarget(retargetHeaders)
          ).to.be.revertedWith("Invalid work")
        })
      })

      context(
        "with a non-DIFF1 unexpected target in post-retarget window",
        () => {
          // Testnet4LightRelay should still reject arbitrary wrong targets.
          let retargetHeaders: string

          before(async () => {
            await createSnapshot()

            const baseRetargetHeaders = headerHex.slice(5, 13)
            const altLastHeader = setHeaderCompactBits(
              baseRetargetHeaders[7],
              "0x2100ffff"
            )

            const modifiedHeaders = [
              ...baseRetargetHeaders.slice(0, 7),
              altLastHeader,
            ]
            retargetHeaders = concatenateHexStrings(modifiedHeaders)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert with Unexpected target change after retarget", async () => {
            await expect(
              relay.connect(thirdParty).retarget(retargetHeaders)
            ).to.be.revertedWith("Unexpected target change after retarget")
          })
        }
      )
    })
  })
})
