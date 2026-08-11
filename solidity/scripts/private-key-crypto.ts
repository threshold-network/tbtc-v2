import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
} from "crypto"

const PRIVATE_KEY_PATTERN = /^[0-9a-fA-F]{64}$/
const FORMAT_VERSION = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const SCRYPT_OPTIONS = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
}
const ASSOCIATED_DATA = Buffer.from(
  "threshold-network:encrypted-private-key:v1",
  "utf8"
)
const LEGACY_OPENSSL_HEADER = Buffer.from("Salted__", "ascii")

interface EncryptedPrivateKeyV1 {
  version: typeof FORMAT_VERSION
  kdf: "scrypt"
  cipher: "aes-256-gcm"
  salt: string
  iv: string
  authTag: string
  ciphertext: string
}

function normalizePrivateKey(privateKey: string): string {
  const normalized = privateKey.startsWith("0x")
    ? privateKey.slice(2)
    : privateKey

  if (!PRIVATE_KEY_PATTERN.test(normalized)) {
    throw new Error("Invalid private key")
  }

  return normalized
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (!password) {
    throw new Error("Password must not be empty")
  }

  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) {
        reject(error)
        return
      }

      resolve(Buffer.from(derivedKey))
    })
  })
}

function decodeBase64(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== "string") {
    throw new Error("Invalid encrypted private key")
  }

  const decoded = Buffer.from(value, "base64")
  if (
    decoded.toString("base64") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    throw new Error("Invalid encrypted private key")
  }

  return decoded
}

function parseEnvelope(encryptedData: string): EncryptedPrivateKeyV1 {
  const parsed: unknown = JSON.parse(encryptedData)

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid encrypted private key")
  }

  const candidate = parsed as Record<string, unknown>
  if (
    candidate.version !== FORMAT_VERSION ||
    candidate.kdf !== "scrypt" ||
    candidate.cipher !== "aes-256-gcm"
  ) {
    throw new Error("Invalid encrypted private key")
  }

  decodeBase64(candidate.salt, SALT_LENGTH)
  decodeBase64(candidate.iv, IV_LENGTH)
  decodeBase64(candidate.authTag, AUTH_TAG_LENGTH)
  decodeBase64(candidate.ciphertext)

  return candidate as unknown as EncryptedPrivateKeyV1
}

// CryptoJS passphrase ciphertext uses OpenSSL's EVP_BytesToKey derivation.
// MD5 remains here only to read existing files; new writes use scrypt and GCM.
function deriveLegacyCryptoJsKey(
  password: string,
  salt: Buffer
): { key: Buffer; iv: Buffer } {
  let block = Buffer.alloc(0)
  let derived = Buffer.alloc(0)
  const passwordBytes = Buffer.from(password, "utf8")

  while (derived.length < KEY_LENGTH + 16) {
    const hash = createHash("md5")
    hash.update(block)
    hash.update(passwordBytes)
    hash.update(salt)
    block = hash.digest()
    derived = Buffer.concat([derived, block])
  }

  return {
    key: derived.subarray(0, KEY_LENGTH),
    iv: derived.subarray(KEY_LENGTH, KEY_LENGTH + 16),
  }
}

function decryptLegacyCryptoJs(
  encryptedData: string,
  password: string
): string {
  const payload = Buffer.from(encryptedData, "base64")

  if (
    payload.length <= LEGACY_OPENSSL_HEADER.length + 8 ||
    !payload
      .subarray(0, LEGACY_OPENSSL_HEADER.length)
      .equals(LEGACY_OPENSSL_HEADER)
  ) {
    throw new Error("Invalid encrypted private key")
  }

  const salt = payload.subarray(LEGACY_OPENSSL_HEADER.length, 16)
  const ciphertext = payload.subarray(16)
  const { key, iv } = deriveLegacyCryptoJsKey(password, salt)

  try {
    const decipher = createDecipheriv("aes-256-cbc", key, iv)
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")
  } finally {
    key.fill(0)
    iv.fill(0)
  }
}

export async function encryptPrivateKey(
  privateKey: string,
  password: string
): Promise<string> {
  const normalizedPrivateKey = normalizePrivateKey(privateKey)
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(password, salt)

  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    })
    cipher.setAAD(ASSOCIATED_DATA)
    const ciphertext = Buffer.concat([
      cipher.update(normalizedPrivateKey, "utf8"),
      cipher.final(),
    ])

    const envelope: EncryptedPrivateKeyV1 = {
      version: FORMAT_VERSION,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }

    return JSON.stringify(envelope)
  } finally {
    key.fill(0)
  }
}

export async function decryptPrivateKey(
  encryptedData: string,
  password: string
): Promise<string> {
  const trimmedEncryptedData = encryptedData.trim()

  if (!trimmedEncryptedData.startsWith("{")) {
    return normalizePrivateKey(
      decryptLegacyCryptoJs(trimmedEncryptedData, password)
    )
  }

  const envelope = parseEnvelope(trimmedEncryptedData)
  const salt = decodeBase64(envelope.salt, SALT_LENGTH)
  const iv = decodeBase64(envelope.iv, IV_LENGTH)
  const authTag = decodeBase64(envelope.authTag, AUTH_TAG_LENGTH)
  const ciphertext = decodeBase64(envelope.ciphertext)
  const key = await deriveKey(password, salt)

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    })
    decipher.setAAD(ASSOCIATED_DATA)
    decipher.setAuthTag(authTag)
    const privateKey = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")

    return normalizePrivateKey(privateKey)
  } finally {
    key.fill(0)
  }
}
