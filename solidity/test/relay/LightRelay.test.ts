/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ContractTransaction } from "ethers"

import type { LightRelayStub } from "../../typechain"

import { concatenateHexStrings } from "../helpers/contract-test-helpers"

import headers from "./headersWithRetarget.json"
import reorgHeaders from "./headersReorgAndRetarget.json"
import longHeaders from "./longHeaders.json"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const genesisBlock = headers.oldPeriodStart
const genesisHeader = genesisBlock.hex
const genesisHeight = genesisBlock.height // 552384
const genesisEpoch = genesisHeight / 2016 // 274

const nextEpochStart = headers.chain[9]
const nextStartHeader = nextEpochStart.hex
const nextEpochHeight = nextEpochStart.height // 554400
const nextEpoch = nextEpochHeight / 2016 // 275

const genesisDifficulty = 5646403851534
const nextDifficulty = 5106422924659

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

function compactBitsToTarget(bitsCompactHexBE: string): bigint {
  // Parse compact bits without bitwise operators (eslint-friendly).
  // Format: [exponent:1 byte][mantissa:3 bytes] (big-endian).
  const hex = bitsCompactHexBE.replace(/^0x/, "").toLowerCase()
  if (hex.length !== 8) {
    throw new Error(`Invalid compact bits hex: ${bitsCompactHexBE}`)
  }

  const exponent = parseInt(hex.slice(0, 2), 16)
  const mantissa = BigInt(`0x${hex.slice(2, 8)}`)

  // Matches BTCUtils.extractTargetAt in solidity:
  //   target = mantissa * 256**(exponent - 3)
  const shift = BigInt(exponent - 3)
  return mantissa * BigInt(256) ** shift
}

function extractTargetFromHeaderHex(headerHex: string): bigint {
  const headerBytes = hexToBuffer(headerHex)
  // `nbits` is stored in header as little-endian bytes [72..75].
  // We want the compact bits in big-endian form for `compactBitsToTarget`,
  // so we reverse the 4 bytes at offsets 72..75.
  const b0 = headerBytes[72]
  const b1 = headerBytes[73]
  const b2 = headerBytes[74]
  const b3 = headerBytes[75]
  const bitsBEHex = [b3, b2, b1, b0]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  return compactBitsToTarget(`0x${bitsBEHex}`)
}

function setHeaderCompactBits(headerHex: string, bitsCompactHexBE: string) {
  const headerBytes = hexToBuffer(headerHex)
  if (headerBytes.length !== 80) {
    throw new Error(
      `Expected 80-byte header, got ${headerBytes.length} bytes: ${headerHex}`
    )
  }

  // Set `nbits` bytes in header (little-endian on the wire).
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

  const Relay = await ethers.getContractFactory("LightRelayStub")
  const relay = await Relay.deploy()
  await relay.deployed()

  await relay.connect(deployer).transferOwnership(governance.address)

  return {
    deployer,
    governance,
    thirdParty,
    relay,
  }
}

describe("LightRelay", () => {
  let governance: SignerWithAddress

  let thirdParty: SignerWithAddress

  let relay: LightRelayStub

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, relay } = await waffle.loadFixture(fixture))
  })

  //
  // genesis
  //
  describe("genesis", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called with valid inputs", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await relay
          .connect(governance)
          .genesis(genesisHeader, genesisHeight, proofLength)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should record the relay as ready for use", async () => {
        expect(await relay.ready()).to.be.true
      })

      it("should emit the Genesis event", async () => {
        await expect(tx).to.emit(relay, "Genesis").withArgs(genesisHeight)
      })

      it("should record the genesis epoch difficulty correctly", async () => {
        expect(await relay.getEpochDifficulty(genesisEpoch)).to.equal(
          genesisDifficulty
        )
      })
    })

    context("when called with invalid block height", () => {
      it("should revert", async () => {
        await expect(
          relay
            .connect(governance)
            .genesis(genesisHeader, genesisHeight + 1, proofLength)
        ).to.be.revertedWith("Invalid height of relay genesis block")
      })
    })

    context("when called with invalid header data", () => {
      it("should revert", async () => {
        await expect(
          relay
            .connect(governance)
            .genesis("0xdeadbeef", genesisHeight, proofLength)
        ).to.be.revertedWith("Invalid genesis header length")
      })
    })

    context("when called with excessive proof length", () => {
      it("should revert", async () => {
        await expect(
          relay.connect(governance).genesis(genesisHeader, genesisHeight, 2016)
        ).to.be.revertedWith("Proof length excessive")
      })
    })

    context("when called with zero proof length", () => {
      it("should revert", async () => {
        await expect(
          relay.connect(governance).genesis(genesisHeader, genesisHeight, 0)
        ).to.be.revertedWith("Proof length may not be zero")
      })
    })

    context("when called by anyone other than governance", () => {
      it("should revert", async () => {
        await expect(
          relay
            .connect(thirdParty)
            .genesis(genesisHeader, genesisHeight, proofLength)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called more than once", () => {
      it("should revert", async () => {
        await relay
          .connect(governance)
          .genesis(genesisHeader, genesisHeight, proofLength)

        await expect(
          relay.connect(governance).genesis(genesisHeader, genesisHeight, 5)
        ).to.be.revertedWith("Genesis already performed")
      })
    })
  })
  //
  // end genesis
  //

  //
  // setProofLength
  //
  describe("setProofLength", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("before genesis", () => {
      it("should revert", async () => {
        await expect(
          relay.connect(governance).setProofLength(5)
        ).to.be.revertedWith("Relay is not ready for use")
      })
    })

    context("after genesis", () => {
      before(async () => {
        await createSnapshot()
        await relay
          .connect(governance)
          .genesis(genesisHeader, genesisHeight, proofLength)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when called correctly", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()
          tx = await relay.connect(governance).setProofLength(5)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should store the new proof length", async () => {
          expect(await relay.proofLength()).to.equal(5)
        })

        it("should emit the ProofLengthChanged event", async () => {
          await expect(tx).to.emit(relay, "ProofLengthChanged").withArgs(5)
        })
      })

      context("when called with excessive proof length", () => {
        it("should revert", async () => {
          await expect(
            relay.connect(governance).setProofLength(2016)
          ).to.be.revertedWith("Proof length excessive")
        })
      })

      context("when called with zero proof length", () => {
        it("should revert", async () => {
          await expect(
            relay.connect(governance).setProofLength(0)
          ).to.be.revertedWith("Proof length may not be zero")
        })
      })

      context("when called with unchanged proof length", () => {
        it("should revert", async () => {
          await expect(
            relay.connect(governance).setProofLength(proofLength)
          ).to.be.revertedWith("Proof length unchanged")
        })
      })

      context("when called by anyone other than governance", () => {
        it("should revert", async () => {
          await expect(
            relay.connect(thirdParty).setProofLength(5)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })
    })
  })
  //
  // end setProofLength
  //

  describe("authorizations", () => {
    before(async () => {
      await createSnapshot()
      await relay
        .connect(governance)
        .genesis(genesisHeader, genesisHeight, proofLength)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("authorization status", () => {
      it("should start at false", async () => {
        expect(await relay.authorizationRequired()).to.be.false
      })

      context("when set by governance", () => {
        let tx: ContractTransaction

        it("should be updated", async () => {
          await relay.connect(governance).setAuthorizationStatus(true)
          expect(await relay.authorizationRequired()).to.be.true
        })

        it("should emit an event", async () => {
          tx = await relay.connect(governance).setAuthorizationStatus(true)
          await expect(tx)
            .to.emit(relay, "AuthorizationRequirementChanged")
            .withArgs(true)
        })
      })

      context("when set by someone other than governance", () => {
        it("should revert", async () => {
          await expect(
            relay.connect(thirdParty).setAuthorizationStatus(true)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("when unset by governance", () => {
        before(async () => {
          await createSnapshot()
          await relay.connect(governance).setAuthorizationStatus(true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should be updated", async () => {
          await relay.connect(governance).setAuthorizationStatus(false)
          expect(await relay.authorizationRequired()).to.be.false
        })

        it("should emit an event", async () => {
          const tx = await relay
            .connect(governance)
            .setAuthorizationStatus(false)
          await expect(tx)
            .to.emit(relay, "AuthorizationRequirementChanged")
            .withArgs(false)
        })
      })
    })

    context("submitter authorization", () => {
      it("should start at false", async () => {
        expect(await relay.isAuthorized(thirdParty.address)).to.be.false
      })

      context("when set by governance", () => {
        it("should be updated", async () => {
          await relay.connect(governance).authorize(thirdParty.address)
          expect(await relay.isAuthorized(thirdParty.address)).to.be.true
        })

        it("should emit an event", async () => {
          const tx = await relay
            .connect(governance)
            .authorize(thirdParty.address)
          await expect(tx)
            .to.emit(relay, "SubmitterAuthorized")
            .withArgs(thirdParty.address)
        })
      })

      context("when set by someone other than governance", () => {
        it("should revert", async () => {
          await expect(
            relay.connect(thirdParty).authorize(thirdParty.address)
          ).to.be.revertedWith("Ownable: caller is not the owner")
        })
      })

      context("when unset by governance", () => {
        before(async () => {
          await createSnapshot()
          await relay.connect(governance).authorize(thirdParty.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should be updated", async () => {
          await relay.connect(governance).deauthorize(thirdParty.address)
          expect(await relay.isAuthorized(thirdParty.address)).to.be.false
        })

        it("should emit an event", async () => {
          const tx = await relay
            .connect(governance)
            .deauthorize(thirdParty.address)
          await expect(tx)
            .to.emit(relay, "SubmitterDeauthorized")
            .withArgs(thirdParty.address)
        })
      })
    })
  })

  //
  // retarget
  //
  describe("retarget", () => {
    const { chain } = headers
    const headerHex = chain.map((header) => header.hex)

    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called before genesis", () => {
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      it("should revert", async () => {
        await expect(relay.retarget(retargetHeaders)).to.be.revertedWith(
          "Relay is not ready for use"
        )
      })
    })

    context("after genesis (epoch 274)", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when called correctly", () => {
        let tx: ContractTransaction
        const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

        before(async () => {
          await createSnapshot()
          tx = await relay.connect(thirdParty).retarget(retargetHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should store the new difficulty", async () => {
          expect(await relay.getEpochDifficulty(genesisEpoch + 1)).to.equal(
            nextDifficulty
          )
        })

        it("should emit the Retarget event", async () => {
          await expect(tx)
            .to.emit(relay, "Retarget")
            .withArgs(genesisDifficulty, nextDifficulty)
        })
      })

      context("with MIN_DIFFICULTY_TARGET in post-retarget window", () => {
        let retargetHeaders: string

        before(async () => {
          await createSnapshot()

          const baseRetargetHeaders = headerHex.slice(5, 13) // 8 headers total
          const originalLastHeader = baseRetargetHeaders[7]

          // Use DIFF1 `nbits` but keep the nonce from the fixture header.
          // This will almost certainly fail the PoW check, which proves that
          // the MIN_DIFFICULTY_TARGET exception does not bypass PoW validation.
          const diff1LastHeader = setHeaderCompactBits(
            originalLastHeader,
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

        it("should revert with Invalid work", async () => {
          await expect(
            relay.connect(thirdParty).retarget(retargetHeaders)
          ).to.be.revertedWith("Invalid work")
        })
      })

      context("with an unexpected post-retarget target", () => {
        let retargetHeaders: string

        before(async () => {
          await createSnapshot()

          const baseRetargetHeaders = headerHex.slice(5, 13) // 8 headers total
          const originalLastHeader = baseRetargetHeaders[7]

          const minedTarget = extractTargetFromHeaderHex(baseRetargetHeaders[4])

          // Pick a very-easy compact bits value. We only mutate `nbits`
          // (keep nonce/timestamp/merkle root), so PoW should pass, and
          // the retarget logic should fail only at the post-retarget target
          // comparison.
          const altBits = "0x2100ffff"
          const altTarget = compactBitsToTarget(altBits)

          // Ensure the test meaning: it's neither the mined target nor DIFF1.
          expect(altTarget).to.not.equal(minedTarget)
          expect(altTarget).to.not.equal(MIN_DIFFICULTY_TARGET)

          const altLastHeader = setHeaderCompactBits(
            originalLastHeader,
            altBits
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
      })

      context("with incorrect number of headers", () => {
        const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 12))
        it("should revert", async () => {
          await expect(
            relay.connect(thirdParty).retarget(retargetHeaders)
          ).to.be.revertedWith("Invalid header length")
        })
      })

      context("with too few headers before retarget", () => {
        const retargetHeaders = concatenateHexStrings(headerHex.slice(6, 14))
        it("should revert", async () => {
          await expect(
            relay.connect(thirdParty).retarget(retargetHeaders)
          ).to.be.revertedWith("Invalid target in pre-retarget headers")
        })
      })

      context("with too few headers after retarget", () => {
        const retargetHeaders = concatenateHexStrings(headerHex.slice(4, 12))
        it("should revert", async () => {
          await expect(
            relay.connect(thirdParty).retarget(retargetHeaders)
          ).to.be.revertedWith("Invalid target in new epoch")
        })
      })

      context("with proof length 9", () => {
        let tx: ContractTransaction
        const retargetHeaders = concatenateHexStrings(headerHex)

        before(async () => {
          await createSnapshot()
          await relay.connect(governance).setProofLength(9)
          tx = await relay.connect(thirdParty).retarget(retargetHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should store the new difficulty", async () => {
          expect(await relay.getEpochDifficulty(genesisEpoch + 1)).to.equal(
            nextDifficulty
          )
        })

        it("should emit the Retarget event", async () => {
          await expect(tx)
            .to.emit(relay, "Retarget")
            .withArgs(genesisDifficulty, nextDifficulty)
        })
      })

      context("with appropriate authorisation", () => {
        let tx: ContractTransaction
        const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

        before(async () => {
          await createSnapshot()
          await relay.connect(governance).setAuthorizationStatus(true)
          await relay.connect(governance).authorize(thirdParty.address)
          tx = await relay.connect(thirdParty).retarget(retargetHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should store the new difficulty", async () => {
          expect(await relay.getEpochDifficulty(genesisEpoch + 1)).to.equal(
            nextDifficulty
          )
        })

        it("should emit the Retarget event", async () => {
          await expect(tx)
            .to.emit(relay, "Retarget")
            .withArgs(genesisDifficulty, nextDifficulty)
        })
      })

      context("without appropriate authorisation", () => {
        const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

        before(async () => {
          await createSnapshot()
          await relay.connect(governance).setAuthorizationStatus(true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            relay.connect(thirdParty).retarget(retargetHeaders)
          ).to.be.revertedWith("Submitter unauthorized")
        })
      })
    })

    context("after genesis (invalid)", () => {
      const badGenesisHeader = chain[0].hex
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay
          .connect(governance)
          .genesis(badGenesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should reject chains with invalid difficulty", async () => {
        await expect(
          relay.connect(thirdParty).retarget(retargetHeaders)
        ).to.be.revertedWith("Invalid target in new epoch")
      })
    })

    context("after genesis (long chain)", () => {
      const longGenesis = longHeaders.epochStart
      // const longGenesisBlock = 739872
      // const longRetargetBlock = 741888
      // const longHeaderStart = 741793
      const longHeaderHex = longHeaders.chain.map((h) => h.hex)
      const longGenesisEpoch = 367
      const longGenesisDifficulty = 30283293547736
      const longNextDifficulty = 29570168636357

      before(async () => {
        await createSnapshot()
        await relay
          .connect(governance)
          .genesis(longGenesis.hex, longGenesis.height, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("with proof length 6", () => {
        let tx: ContractTransaction
        const retargetHeaders = concatenateHexStrings(
          longHeaderHex.slice(89, 101)
        )

        before(async () => {
          await createSnapshot()
          await relay.connect(governance).setProofLength(6)
          tx = await relay.connect(thirdParty).retarget(retargetHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should store the new difficulty", async () => {
          expect(await relay.getEpochDifficulty(longGenesisEpoch + 1)).to.equal(
            longNextDifficulty
          )
        })

        it("should emit the Retarget event", async () => {
          await expect(tx)
            .to.emit(relay, "Retarget")
            .withArgs(longGenesisDifficulty, longNextDifficulty)
        })
      })

      context("with proof length 50", () => {
        let tx: ContractTransaction
        const retargetHeaders = concatenateHexStrings(
          longHeaderHex.slice(45, 145)
        )

        before(async () => {
          await createSnapshot()
          await relay.connect(governance).setProofLength(50)
          tx = await relay.connect(thirdParty).retarget(retargetHeaders)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should store the new difficulty", async () => {
          expect(await relay.getEpochDifficulty(longGenesisEpoch + 1)).to.equal(
            longNextDifficulty
          )
        })

        it("should emit the Retarget event", async () => {
          await expect(tx)
            .to.emit(relay, "Retarget")
            .withArgs(longGenesisDifficulty, longNextDifficulty)
        })
      })
    })
  })
  //
  // end retarget
  //

  //
  // validateChain
  //
  describe("validateChain", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called before genesis", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const proofHeaders = concatenateHexStrings(headerHex.slice(0, 4))

      it("should revert", async () => {
        await expect(relay.validateChain(proofHeaders)).to.be.revertedWith(
          "Cannot validate chains before relay genesis"
        )
      })
    })

    context("when called after genesis (epoch 274)", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should accept valid header chains", async () => {
        const proofHeaders = concatenateHexStrings(headerHex.slice(0, 4))
        const res = await relay.validateChain(proofHeaders)
        expect(res[0]).to.be.above(0)
      })

      it("should accept short header chains", async () => {
        const proofHeaders = concatenateHexStrings(headerHex.slice(0, 3))

        const res = await relay.validateChain(proofHeaders)
        expect(res[0]).to.be.above(0)
      })

      it("should accept long header chains", async () => {
        const proofHeaders = concatenateHexStrings(headerHex.slice(0, 9))

        const res = await relay.validateChain(proofHeaders)
        expect(res[0]).to.be.above(0)
      })

      it("should reject single headers", async () => {
        await expect(relay.validateChain(headerHex[0])).to.be.revertedWith(
          "Invalid number of headers"
        )
      })

      it("should reject header chains with an unknown retarget", async () => {
        const proofHeaders = concatenateHexStrings(headerHex.slice(6, 10))

        await expect(relay.validateChain(proofHeaders)).to.be.revertedWith(
          "Invalid target in header chain"
        )
      })

      it("should reject header chains in a future epoch", async () => {
        const proofHeaders = concatenateHexStrings(headerHex.slice(9, 13))

        await expect(relay.validateChain(proofHeaders)).to.be.revertedWith(
          "Invalid target in header chain"
        )
      })
    })

    context("when called after genesis (epoch 275)", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)

      before(async () => {
        await createSnapshot()
        await relay
          .connect(governance)
          .genesis(nextStartHeader, nextEpochHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should accept valid header chains", async () => {
        const proofHeaders = concatenateHexStrings(headerHex.slice(9, 13))
        const res = await relay.validateChain(proofHeaders)
        expect(res[0]).to.be.above(0)
      })

      it("should reject header chains partially in a past epoch", async () => {
        const proofHeaders = concatenateHexStrings(headerHex.slice(8, 12))

        await expect(relay.validateChain(proofHeaders)).to.be.revertedWith(
          "Cannot validate chains before relay genesis"
        )
      })

      it("should reject header chains fully in a past epoch", async () => {
        const proofHeaders = concatenateHexStrings(headerHex.slice(5, 9))

        await expect(relay.validateChain(proofHeaders)).to.be.revertedWith(
          "Cannot validate chains before relay genesis"
        )
      })
    })

    context("when called after a retarget", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
        await relay.connect(thirdParty).retarget(retargetHeaders)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("in the genesis epoch", () => {
        it("should accept valid header chains", async () => {
          const proofHeaders = concatenateHexStrings(headerHex.slice(0, 4))
          const res = await relay.validateChain(proofHeaders)
          expect(res[0]).to.be.above(0)
        })
      })

      context("over the retarget", () => {
        it("should accept valid header chains (3 before, 1 after)", async () => {
          const proofHeaders = concatenateHexStrings(headerHex.slice(6, 10))
          const res = await relay.validateChain(proofHeaders)
          expect(res[0]).to.be.above(0)
        })

        it("should accept valid header chains (2 before, 2 after)", async () => {
          const proofHeaders = concatenateHexStrings(headerHex.slice(7, 11))
          const res = await relay.validateChain(proofHeaders)
          expect(res[0]).to.be.above(0)
        })

        it("should accept valid header chains (1 before, 3 after)", async () => {
          const proofHeaders = concatenateHexStrings(headerHex.slice(8, 12))
          const res = await relay.validateChain(proofHeaders)
          expect(res[0]).to.be.above(0)
        })
      })

      context("in the new epoch", () => {
        it("should accept valid header chains", async () => {
          const proofHeaders = concatenateHexStrings(headerHex.slice(9, 13))
          const res = await relay.validateChain(proofHeaders)
          expect(res[0]).to.be.above(0)
        })
      })
    })

    context("with chain reorgs", () => {
      const { postRetargetChain } = reorgHeaders
      const reorgHex = postRetargetChain.map((header) => header.hex)

      const reorgGenesis = postRetargetChain[0]

      before(async () => {
        await createSnapshot()
        await relay
          .connect(governance)
          .genesis(reorgGenesis.hex, reorgGenesis.height, 8)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("valid chains", () => {
        it("should be accepted", async () => {
          const proofHeaders = concatenateHexStrings(reorgHex)
          const res = await relay.validateChain(proofHeaders)
          expect(res[0]).to.be.above(0)
        })
      })

      context("invalid chains", () => {
        it("should be rejected", async () => {
          const pre = concatenateHexStrings(reorgHex.slice(0, 6))
          const orphan = reorgHeaders.orphan_437478.hex
          const post = reorgHex[7]
          const proofHeaders = concatenateHexStrings([pre, orphan, post])
          await expect(relay.validateChain(proofHeaders)).to.be.revertedWith(
            "Invalid chain"
          )
        })
      })
    })

    context("gas costs", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
        await relay.connect(thirdParty).retarget(retargetHeaders)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("with proof length 6", () => {
        it("should accept valid header chains", async () => {
          const proofHeaders = concatenateHexStrings(headerHex.slice(5, 11))
          await relay.connect(governance).setProofLength(6)
          const tx = await relay.validateChainGasReport(proofHeaders)
          const txr = await tx.wait()

          expect(txr.status).to.equal(1)
        })
      })

      context("with proof length 18", () => {
        it("should accept valid header chains", async () => {
          const proofHeaders = concatenateHexStrings(headerHex)
          await relay.connect(governance).setProofLength(18)
          const tx = await relay.validateChainGasReport(proofHeaders)
          const txr = await tx.wait()

          expect(txr.status).to.equal(1)
        })
      })
    })
  })
  //
  // end validateChain
  //

  //
  // getBlockDifficulty
  //
  describe("getBlockDifficulty", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called before genesis", () => {
      it("should revert", async () => {
        await expect(relay.getBlockDifficulty(552384)).to.be.revertedWith(
          "Epoch is not proven to the relay yet"
        )
      })
    })

    context("when called after genesis", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the difficulty for the first block of the epoch", async () => {
        expect(await relay.getBlockDifficulty(552384)).to.equal(5646403851534)
      })

      it("should return the difficulty for the last block of the epoch", async () => {
        expect(await relay.getBlockDifficulty(554399)).to.equal(5646403851534)
      })

      it("should revert for blocks before genesis", async () => {
        await expect(relay.getBlockDifficulty(552383)).to.be.revertedWith(
          "Epoch is before relay genesis"
        )
      })

      it("should revert for blocks after the latest epoch", async () => {
        await expect(relay.getBlockDifficulty(554400)).to.be.revertedWith(
          "Epoch is not proven to the relay yet"
        )
      })
    })

    context("when called after a retarget", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
        await relay.connect(thirdParty).retarget(retargetHeaders)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the difficulty for the first block of the genesis epoch", async () => {
        expect(await relay.getBlockDifficulty(552384)).to.equal(
          genesisDifficulty
        )
      })

      it("should return the difficulty for the last block of the genesis epoch", async () => {
        expect(await relay.getBlockDifficulty(554399)).to.equal(
          genesisDifficulty
        )
      })

      it("should return the difficulty for the first block of the next epoch", async () => {
        expect(await relay.getBlockDifficulty(554400)).to.equal(nextDifficulty)
      })

      it("should return the difficulty for the last block of the next epoch", async () => {
        expect(await relay.getBlockDifficulty(556415)).to.equal(nextDifficulty)
      })

      it("should revert for blocks before genesis", async () => {
        await expect(relay.getBlockDifficulty(552383)).to.be.revertedWith(
          "Epoch is before relay genesis"
        )
      })

      it("should revert for blocks after the latest epoch", async () => {
        await expect(relay.getBlockDifficulty(556416)).to.be.revertedWith(
          "Epoch is not proven to the relay yet"
        )
      })
    })
  })
  //
  // end getBlockDifficulty
  //

  //
  // getEpochDifficulty
  //
  describe("getEpochDifficulty", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called before genesis", () => {
      it("should revert", async () => {
        await expect(relay.getEpochDifficulty(genesisEpoch)).to.be.revertedWith(
          "Epoch is not proven to the relay yet"
        )
      })
    })

    context("when called after genesis", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the difficulty for the genesis epoch", async () => {
        expect(await relay.getEpochDifficulty(genesisEpoch)).to.equal(
          genesisDifficulty
        )
      })

      it("should revert for epochs before genesis", async () => {
        await expect(
          relay.getEpochDifficulty(genesisEpoch - 1)
        ).to.be.revertedWith("Epoch is before relay genesis")
      })

      it("should revert for unproven epochs", async () => {
        await expect(
          relay.getEpochDifficulty(genesisEpoch + 1)
        ).to.be.revertedWith("Epoch is not proven to the relay yet")
      })
    })

    context("when called after a retarget", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
        await relay.connect(thirdParty).retarget(retargetHeaders)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the difficulty for the genesis epoch", async () => {
        expect(await relay.getEpochDifficulty(274)).to.equal(genesisDifficulty)
      })

      it("should return the difficulty for the next epoch", async () => {
        expect(await relay.getEpochDifficulty(275)).to.equal(nextDifficulty)
      })

      it("should revert for epochs before genesis", async () => {
        await expect(relay.getEpochDifficulty(273)).to.be.revertedWith(
          "Epoch is before relay genesis"
        )
      })

      it("should revert for unproven epochs", async () => {
        await expect(relay.getEpochDifficulty(276)).to.be.revertedWith(
          "Epoch is not proven to the relay yet"
        )
      })
    })
  })
  //
  // end getEpochDifficulty
  //

  //
  // getRelayRange
  //
  describe("getRelayRange", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called before genesis", () => {
      it("should return nonsense", async () => {
        const res = await relay.getRelayRange()
        expect(res[0]).to.equal(0)
        expect(res[1]).to.equal(2015)
      })
    })

    context("when called after genesis", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return a single epoch", async () => {
        const res = await relay.getRelayRange()
        expect(res[0]).to.equal(552384)
        expect(res[1]).to.equal(554399)
      })
    })

    context("when called after a retarget", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
        await relay.connect(thirdParty).retarget(retargetHeaders)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return two epochs", async () => {
        const res = await relay.getRelayRange()
        expect(res[0]).to.equal(552384)
        expect(res[1]).to.equal(556415)
      })
    })
  })
  //
  // end getRelayRange
  //

  //
  // getCurrentEpochDifficulty
  //
  describe("getCurrentEpochDifficulty", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called before genesis", () => {
      it("should return zero", async () => {
        expect(await relay.getCurrentEpochDifficulty()).to.equal(0)
      })
    })

    context("when called after genesis", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the difficulty for the genesis epoch", async () => {
        expect(await relay.getCurrentEpochDifficulty()).to.equal(
          genesisDifficulty
        )
      })
    })

    context("when called after a retarget", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
        await relay.connect(thirdParty).retarget(retargetHeaders)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the difficulty for the next epoch", async () => {
        expect(await relay.getCurrentEpochDifficulty()).to.equal(nextDifficulty)
      })
    })
  })
  //
  // end getCurrentEpochDifficulty
  //

  //
  // getPrevEpochDifficulty
  //
  describe("getPrevEpochDifficulty", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called before genesis", () => {
      it("should return zero", async () => {
        expect(await relay.getPrevEpochDifficulty()).to.equal(0)
      })
    })

    context("when called after genesis", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return zero", async () => {
        expect(await relay.getPrevEpochDifficulty()).to.equal(0)
      })
    })

    context("when called after a retarget", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
        await relay.connect(thirdParty).retarget(retargetHeaders)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the difficulty for the genesis epoch", async () => {
        expect(await relay.getPrevEpochDifficulty()).to.equal(genesisDifficulty)
      })
    })
  })
  //
  // end getPrevEpochDifficulty
  //

  //
  // getCurrentAndPrevEpochDifficulty
  //
  describe("getCurrentAndPrevEpochDifficulty", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called before genesis", () => {
      it("should return zero for both", async () => {
        const diffs = await relay.getCurrentAndPrevEpochDifficulty()
        const current = diffs[0]
        const prev = diffs[1]
        expect(current).to.equal(0)
        expect(prev).to.equal(0)
      })
    })

    context("when called after genesis", () => {
      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return current difficulty, and zero for previous", async () => {
        const diffs = await relay.getCurrentAndPrevEpochDifficulty()
        const current = diffs[0]
        const prev = diffs[1]
        expect(current).to.equal(genesisDifficulty)
        expect(prev).to.equal(0)
      })
    })

    context("when called after a retarget", () => {
      const { chain } = headers
      const headerHex = chain.map((header) => header.hex)
      const retargetHeaders = concatenateHexStrings(headerHex.slice(5, 13))

      before(async () => {
        await createSnapshot()
        await relay.connect(governance).genesis(genesisHeader, genesisHeight, 4)
        await relay.connect(thirdParty).retarget(retargetHeaders)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return current and previous difficulty", async () => {
        const diffs = await relay.getCurrentAndPrevEpochDifficulty()
        const current = diffs[0]
        const prev = diffs[1]
        expect(current).to.equal(nextDifficulty)
        expect(prev).to.equal(genesisDifficulty)
      })
    })
  })
  //
  // end getCurrentAndPrevEpochDifficulty
  //
})
