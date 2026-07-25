/**
 * HTTPS is production-safe only when an audited adapter reports the peer
 * policy it actually authenticated (for example a pinned SPKI/CA policy).
 * A caller-provided string beside ordinary `fetch` is not authentication.
 */
export type P2TRAuthenticatedHttpsTransport = {
  readonly profile: "p2tr-authenticated-https-peer-policy/v1"
  /** Stable, JSON-only identity of the concrete TLS implementation/config. */
  readonly transportIdentity: Readonly<Record<string, unknown>>
  request(
    url: string,
    init: RequestInit
  ): Promise<{
    response: Response
    /** Peer policy verified by this request's TLS session. */
    authenticatedPeerPolicyIdentity: string
  }>
}

export type P2TRBoundHttpTransport = {
  readonly identity: Readonly<Record<string, unknown>>
  request(url: string, init: RequestInit): Promise<Response>
}

export type NodePinnedSpkiP2TRHttpsTransportOptions = {
  /** Canonical base64 SHA-256 digest of the server leaf certificate SPKI. */
  expectedSpkiSha256: string
  /** Optional private CA roots; absent means Node's system roots. */
  ca?: string | Buffer | readonly (string | Buffer)[]
  minVersion?: "TLSv1.2" | "TLSv1.3"
}

/** Concrete HTTPS adapter with normal PKIX/hostname checks plus a leaf-SPKI pin. */
export class NodePinnedSpkiP2TRHttpsTransport
  implements P2TRAuthenticatedHttpsTransport
{
  readonly profile = "p2tr-authenticated-https-peer-policy/v1" as const
  readonly transportIdentity: Readonly<Record<string, unknown>>
  readonly authenticatedPeerPolicyIdentity: string
  private readonly expectedSpkiSha256: string
  private readonly ca?: string | Buffer | readonly (string | Buffer)[]
  private readonly minVersion: "TLSv1.2" | "TLSv1.3"

  constructor(options: NodePinnedSpkiP2TRHttpsTransportOptions) {
    this.expectedSpkiSha256 = canonicalSha256Base64(
      options.expectedSpkiSha256,
      "HTTPS server SPKI pin"
    )
    this.authenticatedPeerPolicyIdentity = `spki-sha256:${this.expectedSpkiSha256}`
    this.ca = options.ca
    this.minVersion = options.minVersion ?? "TLSv1.3"
    this.transportIdentity = Object.freeze({
      implementation: "node-https-pkix-leaf-spki/v1",
      expectedPeerPolicy: this.authenticatedPeerPolicyIdentity,
      minVersion: this.minVersion,
      caBundleSha256: hashCaBundle(options.ca),
    })
  }

  async request(
    rawUrl: string,
    init: RequestInit
  ): Promise<{
    response: Response
    authenticatedPeerPolicyIdentity: string
  }> {
    const url = new URL(rawUrl)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("Pinned HTTPS transport received an unsafe URL")
    }
    if (init.redirect !== undefined && init.redirect !== "error") {
      throw new Error("Pinned HTTPS transport forbids redirect following")
    }
    const body = requestBody(init.body)
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: init.method ?? "GET",
          headers,
          signal: init.signal ?? undefined,
          rejectUnauthorized: true,
          ca: this.ca as string | Buffer | Array<string | Buffer> | undefined,
          minVersion: this.minVersion,
          checkServerIdentity: (hostname, certificate) => {
            const standardError = checkServerIdentity(hostname, certificate)
            if (standardError !== undefined) return standardError
            try {
              const actual = createHash("sha256")
                .update(
                  new X509Certificate(certificate.raw).publicKey.export({
                    type: "spki",
                    format: "der",
                  })
                )
                .digest("base64")
              return actual === this.expectedSpkiSha256
                ? undefined
                : new Error("HTTPS server SPKI pin mismatch")
            } catch {
              return new Error("HTTPS server certificate SPKI is unavailable")
            }
          },
        },
        (incoming) => {
          try {
            const responseHeaders = new Headers()
            for (
              let index = 0;
              index < incoming.rawHeaders.length;
              index += 2
            ) {
              responseHeaders.append(
                incoming.rawHeaders[index],
                incoming.rawHeaders[index + 1]
              )
            }
            const response = new Response(
              Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              {
                status: incoming.statusCode ?? 500,
                statusText: incoming.statusMessage ?? "",
                headers: responseHeaders,
              }
            )
            resolve({
              response,
              authenticatedPeerPolicyIdentity:
                this.authenticatedPeerPolicyIdentity,
            })
          } catch (error) {
            incoming.destroy()
            reject(error)
          }
        }
      )
      request.once("error", reject)
      if (body !== undefined) request.write(body)
      request.end()
    })
  }
}

export function bindP2TRHttpTransport(options: {
  url: URL
  label: string
  tlsServerIdentity?: string
  authenticatedHttpsTransport?: P2TRAuthenticatedHttpsTransport
  loopbackFetchFn?: typeof fetch
}): P2TRBoundHttpTransport {
  if (options.url.protocol === "https:") {
    const expectedPeerPolicy = boundedString(
      options.tlsServerIdentity ?? "",
      512,
      `${options.label} TLS server identity`
    )
    if (options.loopbackFetchFn !== undefined) {
      throw new Error(
        `${options.label} HTTPS cannot use an unauthenticated fetch override`
      )
    }
    const adapter = options.authenticatedHttpsTransport
    if (
      adapter?.profile !== "p2tr-authenticated-https-peer-policy/v1" ||
      !isPlainObject(adapter.transportIdentity)
    ) {
      throw new Error(
        `${options.label} HTTPS requires an authenticated peer-policy transport`
      )
    }
    const adapterIdentity = normalizeJsonObject(
      adapter.transportIdentity,
      `${options.label} HTTPS transport identity`
    )
    return Object.freeze({
      identity: Object.freeze({
        mode: "authenticated-https",
        expectedPeerPolicy,
        adapterIdentity,
      }),
      request: async (url: string, init: RequestInit): Promise<Response> => {
        const result = await adapter.request(url, init)
        if (
          !isPlainObject(result) ||
          result.authenticatedPeerPolicyIdentity !== expectedPeerPolicy ||
          !isResponseLike(result.response)
        ) {
          throw new Error(
            `${options.label} HTTPS peer-policy authentication failed`
          )
        }
        return result.response
      },
    })
  }

  if (options.authenticatedHttpsTransport !== undefined) {
    throw new Error(
      `${options.label} loopback HTTP must not use an HTTPS transport adapter`
    )
  }
  return Object.freeze({
    identity: Object.freeze({ mode: "plaintext-numeric-loopback" }),
    request: options.loopbackFetchFn ?? fetch,
  })
}

function normalizeJsonObject(
  value: Readonly<Record<string, unknown>>,
  label: string
): Readonly<Record<string, unknown>> {
  let encoded: string
  try {
    encoded = canonicalJSON(value)
  } catch {
    throw new Error(`${label} must contain only bounded JSON data`)
  }
  if (Buffer.byteLength(encoded, "utf8") > 8192) {
    throw new Error(`${label} exceeds its byte bound`)
  }
  return Object.freeze(JSON.parse(encoded) as Record<string, unknown>)
}

function canonicalJSON(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("unsafe JSON number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`
  }
  throw new Error("non-JSON transport identity")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function isResponseLike(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Response).arrayBuffer === "function" &&
    typeof (value as Response).headers?.get === "function" &&
    typeof (value as Response).ok === "boolean"
  )
}

function boundedString(value: string, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function canonicalSha256Base64(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(`${label} is malformed`)
  }
  const decoded = Buffer.from(value, "base64")
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function hashCaBundle(
  ca: string | Buffer | readonly (string | Buffer)[] | undefined
): string {
  if (ca === undefined) return "system-roots"
  const values = Array.isArray(ca) ? ca : [ca]
  const hash = createHash("sha256").update(
    "tbtc-p2tr-https-ca-bundle/v1\u0000",
    "utf8"
  )
  for (const value of values) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8")
    hash.update(Buffer.from(bytes.length.toString(10), "utf8"))
    hash.update(Buffer.from([0]))
    hash.update(bytes)
  }
  return `0x${hash.digest("hex")}`
}

function requestBody(value: RequestInit["body"]): Buffer | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return Buffer.from(value, "utf8")
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  throw new Error(
    "Pinned HTTPS transport supports only bounded byte request bodies"
  )
}
import { X509Certificate, createHash } from "node:crypto"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"
import { checkServerIdentity } from "node:tls"
