import { expect } from "chai"
import { createCipheriv, randomBytes, scryptSync } from "crypto"
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
  })

  it("decrypts existing CryptoJS ciphertext", async () => {
    expect(
      await decryptPrivateKey(legacyCryptoJsCiphertext, password)
    ).to.equal(privateKey)
  })

  it("rejects an incorrect password for the authenticated format", async () => {
    const encrypted = await encryptPrivateKey(privateKey, password)
    let error: unknown

    try {
      await decryptPrivateKey(encrypted, "incorrect password")
    } catch (caughtError) {
      error = caughtError
    }

    expect(error).to.be.instanceOf(Error)
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
  })

  it("rejects an incorrect password", async () => {
    let error: unknown

    try {
      await decryptPrivateKey(legacyCryptoJsCiphertext, "incorrect password")
    } catch (caughtError) {
      error = caughtError
    }

    expect(error).to.be.instanceOf(Error)
  })

  it("rejects an envelope with a wrong version, kdf, or cipher", async () => {
    const encrypted = await encryptPrivateKey(privateKey, password)
    const mutations: Array<Record<string, unknown>> = [
      { version: 2 },
      { kdf: "pbkdf2" },
      { cipher: "aes-256-cbc" },
    ]

    await Promise.all(
      mutations.map(async (mutation) => {
        const envelope = { ...JSON.parse(encrypted), ...mutation }
        let error: unknown

        try {
          await decryptPrivateKey(JSON.stringify(envelope), password)
        } catch (caughtError) {
          error = caughtError
        }

        expect(error, JSON.stringify(mutation)).to.be.instanceOf(Error)
      })
    )
  })

  it("rejects an envelope with a wrong-length salt, iv, or authTag", async () => {
    const encrypted = await encryptPrivateKey(privateKey, password)
    const fields = ["salt", "iv", "authTag"] as const

    await Promise.all(
      fields.map(async (field) => {
        const envelope = JSON.parse(encrypted) as Record<string, string>
        envelope[field] = Buffer.alloc(3).toString("base64")
        let error: unknown

        try {
          await decryptPrivateKey(JSON.stringify(envelope), password)
        } catch (caughtError) {
          error = caughtError
        }

        expect(error, field).to.be.instanceOf(Error)
      })
    )
  })

  it("rejects a ciphertext encrypted with a different associated-data value", async () => {
    // Independently reconstructs a validly-shaped v1 envelope using the same
    // scrypt cost parameters and AES-256-GCM cipher as the module under test,
    // but a different AAD string. If decryptPrivateKey's setAAD call were
    // ever dropped, this ciphertext would decrypt successfully instead of
    // failing GCM authentication.
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const key = scryptSync(password, salt, 32, {
      N: 2 ** 17,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    })
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: 16,
    })
    cipher.setAAD(Buffer.from("some-other-associated-data", "utf8"))
    const ciphertext = Buffer.concat([
      cipher.update(privateKey, "utf8"),
      cipher.final(),
    ])
    const envelope = JSON.stringify({
      version: 1,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    })
    let error: unknown

    try {
      await decryptPrivateKey(envelope, password)
    } catch (caughtError) {
      error = caughtError
    }

    expect(error).to.be.instanceOf(Error)
  })

  it("rejects an empty password on encrypt and decrypt", async () => {
    let encryptError: unknown
    try {
      await encryptPrivateKey(privateKey, "")
    } catch (caughtError) {
      encryptError = caughtError
    }
    expect(encryptError).to.be.instanceOf(Error)

    const encrypted = await encryptPrivateKey(privateKey, password)
    let decryptError: unknown
    try {
      await decryptPrivateKey(encrypted, "")
    } catch (caughtError) {
      decryptError = caughtError
    }
    expect(decryptError).to.be.instanceOf(Error)
  })

  it("rejects malformed JSON that starts with '{'", async () => {
    let error: unknown

    try {
      await decryptPrivateKey("{not valid json", password)
    } catch (caughtError) {
      error = caughtError
    }

    expect(error).to.be.instanceOf(Error)
  })

  it("rejects an envelope field with non-canonical base64", async () => {
    const encrypted = await encryptPrivateKey(privateKey, password)
    const envelope = JSON.parse(encrypted) as Record<string, string>
    envelope.salt += " "
    let error: unknown

    try {
      await decryptPrivateKey(JSON.stringify(envelope), password)
    } catch (caughtError) {
      error = caughtError
    }

    expect(error).to.be.instanceOf(Error)
  })

  it("rejects a legacy ciphertext that is not block-aligned", async () => {
    const payload = Buffer.from(legacyCryptoJsCiphertext, "base64")
    const truncated = payload.subarray(0, payload.length - 1)
    let error: unknown

    try {
      await decryptPrivateKey(truncated.toString("base64"), password)
    } catch (caughtError) {
      error = caughtError
    }

    expect(error).to.be.instanceOf(Error)
  })
})
