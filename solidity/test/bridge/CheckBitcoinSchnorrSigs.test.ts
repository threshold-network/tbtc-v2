import { expect } from "chai"
import { createECDH, createHash, randomBytes } from "crypto"
import { ethers } from "hardhat"
import { TestCheckBitcoinSchnorrSigs } from "../../typechain"

const secp256k1N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
)

function bigIntToBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0")
  return Buffer.from(hex, "hex")
}

function bytesToBigInt(value: Buffer): bigint {
  return BigInt(`0x${value.toString("hex")}`)
}

function randomScalar(): bigint {
  let candidate = 0n
  while (candidate === 0n || candidate >= secp256k1N) {
    candidate = bytesToBigInt(randomBytes(32))
  }
  return candidate
}

function publicKeyFromPrivateKey(privateKey: bigint) {
  const ecdh = createECDH("secp256k1")
  ecdh.setPrivateKey(bigIntToBytes32(privateKey))

  const compressed = ecdh.getPublicKey(undefined, "compressed")
  const uncompressed = ecdh.getPublicKey(undefined, "uncompressed")

  return { compressed, uncompressed }
}

function ethereumAddressFromPublicKey(uncompressedPublicKey: Buffer): string {
  const hash = ethers.utils.keccak256(
    `0x${uncompressedPublicKey.slice(1).toString("hex")}`
  )
  return ethers.utils.getAddress(`0x${hash.slice(-40)}`)
}

type PrototypeSignature = {
  pubKeyX: string
  pubKeyYParity: number
  message: string
  challenge: string
  signature: string
}

function signPrototype(message: Buffer): PrototypeSignature {
  const privateKey = randomScalar()
  const nonce = randomScalar()

  const { compressed: publicKey } = publicKeyFromPrivateKey(privateKey)
  const { uncompressed: noncePublicKey } = publicKeyFromPrivateKey(nonce)

  const pubKeyYParity = publicKey[0] - 2 + 27
  const pubKeyX = `0x${publicKey.slice(1).toString("hex")}`
  const messageHex = `0x${message.toString("hex")}`
  const nonceAddress = ethereumAddressFromPublicKey(noncePublicKey)

  const challenge = ethers.utils.solidityKeccak256(
    ["address", "uint8", "bytes32", "bytes32"],
    [nonceAddress, pubKeyYParity, pubKeyX, messageHex]
  )

  const challengeBigInt = BigInt(challenge)
  const signature = (nonce + privateKey * challengeBigInt) % secp256k1N

  if (signature === 0n) {
    return signPrototype(message)
  }

  return {
    pubKeyX,
    pubKeyYParity,
    message: messageHex,
    challenge,
    signature: `0x${bigIntToBytes32(signature).toString("hex")}`,
  }
}

function flipFirstBit(bytes32Hex: string): string {
  const bytes = Buffer.from(bytes32Hex.slice(2), "hex")
  bytes[0] = bytes[0] >= 0x80 ? bytes[0] - 0x80 : bytes[0] + 0x80
  return `0x${bytes.toString("hex")}`
}

function computeTaggedChallengeReference(
  nonceX: Buffer,
  pubKeyX: Buffer,
  message: Buffer
): string {
  const tagHash = createHash("sha256").update("BIP0340/challenge").digest()
  const digest = createHash("sha256")
    .update(Buffer.concat([tagHash, tagHash, nonceX, pubKeyX, message]))
    .digest("hex")

  return `0x${digest}`
}

function evenYPrivateKey(privateKey: bigint): bigint {
  const { compressed } = publicKeyFromPrivateKey(privateKey)

  return compressed[0] === 0x02 ? privateKey : secp256k1N - privateKey
}

function signBip340TaggedChallenge(message: Buffer): PrototypeSignature {
  const privateKey = evenYPrivateKey(randomScalar())
  const nonce = evenYPrivateKey(randomScalar())

  const { compressed: publicKey } = publicKeyFromPrivateKey(privateKey)
  const { compressed: noncePublicKey } = publicKeyFromPrivateKey(nonce)

  const pubKeyYParity = publicKey[0] - 2 + 27
  const pubKeyX = publicKey.slice(1)
  const nonceX = noncePublicKey.slice(1)
  const messageHex = `0x${message.toString("hex")}`

  const challenge = computeTaggedChallengeReference(nonceX, pubKeyX, message)
  const challengeBigInt = BigInt(challenge)
  const signature = (nonce + privateKey * challengeBigInt) % secp256k1N

  if (signature === 0n) {
    return signBip340TaggedChallenge(message)
  }

  return {
    pubKeyX: `0x${pubKeyX.toString("hex")}`,
    pubKeyYParity,
    message: messageHex,
    challenge,
    signature: `0x${bigIntToBytes32(signature).toString("hex")}`,
  }
}

describe("CheckBitcoinSchnorrSigs", () => {
  let testSchnorr: TestCheckBitcoinSchnorrSigs

  before(async () => {
    const TestCheckBitcoinSchnorrSigs = await ethers.getContractFactory(
      "TestCheckBitcoinSchnorrSigs"
    )
    testSchnorr = await TestCheckBitcoinSchnorrSigs.deploy()
  })

  it("verifies valid prototype Schnorr signatures", async () => {
    const checks = Array.from({ length: 3 }, async () => {
      const sig = signPrototype(randomBytes(32))

      expect(
        await testSchnorr.checkSig(
          sig.pubKeyX,
          sig.pubKeyYParity,
          sig.message,
          sig.challenge,
          sig.signature
        )
      ).to.be.true
    })

    await Promise.all(checks)
  })

  it("rejects signatures with tampered challenge", async () => {
    const sig = signPrototype(randomBytes(32))

    expect(
      await testSchnorr.checkSig(
        sig.pubKeyX,
        sig.pubKeyYParity,
        sig.message,
        flipFirstBit(sig.challenge),
        sig.signature
      )
    ).to.be.false
  })

  it("reverts for invalid public key parity", async () => {
    const sig = signPrototype(randomBytes(32))

    await expect(
      testSchnorr.checkSig(
        sig.pubKeyX,
        29,
        sig.message,
        sig.challenge,
        sig.signature
      )
    ).to.be.revertedWith("Public key parity must be 27 or 28")
  })

  it("stays below 50k gas for the verify path", async () => {
    const sig = signPrototype(randomBytes(32))

    const gas = await testSchnorr.estimateGas.checkSig(
      sig.pubKeyX,
      sig.pubKeyYParity,
      sig.message,
      sig.challenge,
      sig.signature
    )

    expect(gas.toNumber()).to.be.lessThan(50000)
  })

  it("matches BIP340 tagged challenge reference hash", async () => {
    const nonceX = randomBytes(32)
    const pubKeyX = randomBytes(32)
    const message = randomBytes(32)

    const expected = computeTaggedChallengeReference(nonceX, pubKeyX, message)

    expect(
      await testSchnorr.computeBIP340TaggedChallenge(
        `0x${nonceX.toString("hex")}`,
        `0x${pubKeyX.toString("hex")}`,
        `0x${message.toString("hex")}`
      )
    ).to.equal(expected)
  })

  it("does not treat BIP340 tagged challenges as prototype signatures", async () => {
    const sig = signBip340TaggedChallenge(randomBytes(32))

    expect(
      await testSchnorr.checkSig(
        sig.pubKeyX,
        sig.pubKeyYParity,
        sig.message,
        sig.challenge,
        sig.signature
      )
    ).to.be.false
  })

  it("stays below 30k gas for BIP340 tagged challenge hashing", async () => {
    const nonceX = randomBytes(32)
    const pubKeyX = randomBytes(32)
    const message = randomBytes(32)

    const gas = await testSchnorr.estimateGas.computeBIP340TaggedChallenge(
      `0x${nonceX.toString("hex")}`,
      `0x${pubKeyX.toString("hex")}`,
      `0x${message.toString("hex")}`
    )

    // eslint-disable-next-line no-console
    console.log(`phase1_bip340_tagged_challenge_gas=${gas.toString()}`)

    expect(gas.toNumber()).to.be.lessThan(30000)
  })
})
