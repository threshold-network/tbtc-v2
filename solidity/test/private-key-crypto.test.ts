import { expect } from "chai"
import {
  decryptPrivateKey,
  encryptPrivateKey,
} from "../scripts/private-key-crypto"

describe("private key encryption", () => {
  const privateKey =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  const password = "correct horse battery staple"
  const legacyCryptoJsCiphertext =
    "U2FsdGVkX18AAQIDBAUGB4yWxL3JgjcD2A03PdGfBbUpi6EnzjRkVSLRPLpXKkYU5/YlnR+dUECD6HZigPFnhR+xN1QNSD76tRTPqNvwhNA4PRWnI+Qr1a/paibT3dMd"

  it("round-trips a private key with authenticated native encryption", async () => {
    const encrypted = await encryptPrivateKey(privateKey, password)

    expect(JSON.parse(encrypted)).to.include({
      version: 1,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
    })
    expect(await decryptPrivateKey(encrypted, password)).to.equal(privateKey)
  }).timeout(15_000)

  it("decrypts existing CryptoJS ciphertext", async () => {
    expect(
      await decryptPrivateKey(legacyCryptoJsCiphertext, password)
    ).to.equal(privateKey)
  })

  it("rejects tampered authenticated ciphertext", async () => {
    const encrypted = await encryptPrivateKey(privateKey, password)
    const envelope = JSON.parse(encrypted) as { authTag: string }
    envelope.authTag = Buffer.alloc(16).toString("base64")
    let error: unknown

    try {
      await decryptPrivateKey(JSON.stringify(envelope), password)
    } catch (caughtError) {
      error = caughtError
    }

    expect(error).to.be.instanceOf(Error)
  }).timeout(15_000)

  it("rejects an incorrect password", async () => {
    let error: unknown

    try {
      await decryptPrivateKey(legacyCryptoJsCiphertext, "incorrect password")
    } catch (caughtError) {
      error = caughtError
    }

    expect(error).to.be.instanceOf(Error)
  })
})
