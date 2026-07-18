import { createHash } from "node:crypto"
import type {
  P2TRProductionEthereumPoint,
  P2TRProductionSignedHandshake,
  P2TRProductionSignedHandshakeProvider,
} from "./P2TRProductionActivation.js"
import {
  bindP2TRHttpTransport,
  type P2TRAuthenticatedHttpsTransport,
  type P2TRBoundHttpTransport,
} from "./P2TRAuthenticatedHttpTransport.js"

export type HttpP2TRProductionSignedHandshakeProviderOptions = {
  url: string
  trustDomainID: string
  /** Stable audited operator identity; hashed locally, never accepted as a hash. */
  operatorIdentity: string
  headers?: Readonly<Record<string, string>>
  fetchFn?: typeof fetch
  requestTimeoutMs?: number
  maxResponseBytes?: number
  /** Deployment-pinned CA bundle/SPKI policy identifier for HTTPS endpoints. */
  tlsServerIdentity?: string
  authenticatedHttpsTransport?: P2TRAuthenticatedHttpsTransport
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * Concrete bounded transport for the live outbox and FROST signer activation
 * attestations. Signature/key validation and exact state comparison remain in
 * P2TRProductionActivationGate; this adapter makes the endpoint identity and
 * transport behavior non-optional.
 */
export class HttpP2TRProductionSignedHandshakeProvider<State>
  implements P2TRProductionSignedHandshakeProvider<State>
{
  readonly trustDomainID: string
  readonly providerIdentity: object
  readonly endpointFingerprint: string
  readonly operatorFingerprint: string
  private readonly url: string
  private readonly headers: Readonly<Record<string, string>>
  private readonly transport: P2TRBoundHttpTransport
  private readonly requestTimeoutMs: number
  private readonly maxResponseBytes: number

  constructor(options: HttpP2TRProductionSignedHandshakeProviderOptions) {
    const url = new URL(options.url)
    assertSecureURL(url)
    this.url = url.toString()
    this.trustDomainID = boundedString(
      options.trustDomainID,
      128,
      "handshake trust domain"
    )
    this.headers = normalizeHeaders(options.headers)
    this.transport = bindP2TRHttpTransport({
      url,
      label: "Production handshake",
      tlsServerIdentity: options.tlsServerIdentity,
      authenticatedHttpsTransport: options.authenticatedHttpsTransport,
      loopbackFetchFn: options.fetchFn,
    })
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "handshake request timeout"
    )
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "handshake response byte bound"
    )
    this.operatorFingerprint = hashOperatorIdentity(options.operatorIdentity)
    const headerCommitments = Object.entries(this.headers)
      .map(([name, value]) => ({
        name,
        valueHash: createHash("sha256").update(value, "utf8").digest("hex"),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    const transportIdentity = Object.freeze({
      schema: "tbtc-p2tr-production-handshake-transport/v1",
      url: this.url,
      transportIdentity: this.transport.identity,
      headerCommitments,
    })
    this.providerIdentity = transportIdentity
    this.endpointFingerprint = `0x${createHash("sha256")
      .update(JSON.stringify(transportIdentity), "utf8")
      .digest("hex")}`
  }

  async attestActivationChallenge(challenge: {
    nonce: string
    manifestHash: string
    ethereumPoint: P2TRProductionEthereumPoint
  }): Promise<P2TRProductionSignedHandshake<State>> {
    const body = JSON.stringify({
      schema: "tbtc-p2tr-production-activation-handshake/v1",
      challenge: {
        nonce: bytes32(challenge.nonce, "handshake nonce"),
        manifestHash: bytes32(
          challenge.manifestHash,
          "handshake manifest hash"
        ),
        ethereumPoint: {
          blockNumber: nonNegativeInteger(
            challenge.ethereumPoint.blockNumber,
            "handshake Ethereum block"
          ),
          blockHash: bytes32(
            challenge.ethereumPoint.blockHash,
            "handshake Ethereum block hash"
          ),
        },
      },
    })
    const response = await this.transport.request(this.url, {
      method: "POST",
      headers: this.headers,
      body,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      redirect: "error",
    })
    if (
      response.redirected ||
      (response.url.length > 0 && new URL(response.url).toString() !== this.url)
    ) {
      throw new Error("Production handshake response URL changed")
    }
    const contentLength = response.headers.get("content-length")
    if (
      contentLength !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(contentLength) ||
        Number(contentLength) > this.maxResponseBytes)
    ) {
      throw new Error("Production handshake response exceeds its byte bound")
    }
    const bytes = await readBoundedBody(response, this.maxResponseBytes)
    if (!response.ok) {
      throw new Error(`Production handshake HTTP status ${response.status}`)
    }
    const contentType = response.headers.get("content-type")
    if (
      contentType !== null &&
      !/^application\/json(?:\s*;|$)/i.test(contentType)
    ) {
      throw new Error("Production handshake response is not JSON")
    }
    let value: unknown
    try {
      value = JSON.parse(bytes.toString("utf8"))
    } catch {
      throw new Error("Production handshake response is not JSON")
    }
    if (!isPlainObject(value)) {
      throw new Error("Production handshake response is malformed")
    }
    return value as P2TRProductionSignedHandshake<State>
  }
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = { "content-type": "application/json" }
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase()
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
      name === "host" ||
      name === "content-length" ||
      name === "connection" ||
      name === "transfer-encoding" ||
      name === "content-type" ||
      typeof rawValue !== "string" ||
      rawValue.length === 0 ||
      rawValue.length > 8192 ||
      /[\r\n]/.test(rawValue) ||
      normalized[name] !== undefined
    ) {
      throw new Error("Production handshake HTTP headers are unsafe")
    }
    normalized[name] = rawValue
  }
  return Object.freeze(normalized)
}

async function readBoundedBody(
  response: Response,
  maximum: number
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maximum) {
        await reader.cancel("response too large")
        throw new Error("Production handshake response exceeds its byte bound")
      }
      chunks.push(Buffer.from(result.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function assertSecureURL(url: URL): void {
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  ) {
    throw new Error("Production handshake URL is unsafe")
  }
  if (url.protocol === "https:") {
    return
  }
  if (!isNumericLoopback(url.hostname)) {
    throw new Error("Plaintext production handshake requires numeric loopback")
  }
}

function isNumericLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (normalized === "::1") return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
    normalized
  )
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127
}

function hashOperatorIdentity(value: string): string {
  const normalized = boundedString(
    value.trim().normalize("NFKC"),
    512,
    "handshake operator identity"
  )
  return `0x${createHash("sha256")
    .update("tbtc-production-operator-identity/v1\u0000", "utf8")
    .update(normalized, "utf8")
    .digest("hex")}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return `0x${normalized}`
}

function boundedString(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}
