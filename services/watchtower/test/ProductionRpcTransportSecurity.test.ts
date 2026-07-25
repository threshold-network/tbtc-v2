import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HttpP2TRBitcoinCoreRpc } from "../src/BitcoinCoreP2TRCanonicalBlockSource.js"
import { HttpP2TREthereumJsonRpc } from "../src/HttpP2TREthereumJsonRpc.js"
import { HttpP2TRProductionSignedHandshakeProvider } from "../src/HttpP2TRProductionSignedHandshakeProvider.js"
import {
  NodePinnedSpkiP2TRHttpsTransport,
  type P2TRAuthenticatedHttpsTransport,
} from "../src/P2TRAuthenticatedHttpTransport.js"

describe("production RPC transport security", () => {
  it("derives the peer policy from a canonical SPKI pin", () => {
    const pin = Buffer.alloc(32, 7).toString("base64")
    const transport = new NodePinnedSpkiP2TRHttpsTransport({
      expectedSpkiSha256: pin,
      minVersion: "TLSv1.3",
    })
    assert.equal(
      transport.authenticatedPeerPolicyIdentity,
      `spki-sha256:${pin}`
    )
    assert.throws(
      () =>
        new NodePinnedSpkiP2TRHttpsTransport({
          expectedSpkiSha256: "caller-claimed-policy",
        }),
      /SPKI pin is malformed/
    )
  })

  it("rejects remote HTTPS backed only by fetch or a claimed pin", () => {
    assert.throws(
      () =>
        new HttpP2TREthereumJsonRpc({
          url: "https://ethereum.example/rpc",
          tlsServerIdentity: "spki-sha256:expected",
        }),
      /authenticated peer-policy transport/
    )
    assert.throws(
      () =>
        new HttpP2TRBitcoinCoreRpc({
          url: "https://bitcoin.example/rpc",
          username: "rpc",
          password: "secret",
          tlsServerIdentity: "spki-sha256:expected",
        }),
      /authenticated peer-policy transport/
    )
    assert.throws(
      () =>
        new HttpP2TRProductionSignedHandshakeProvider({
          url: "https://signer.example/activation",
          trustDomainID: "frost-signer-a",
          operatorIdentity: "operator-a",
          tlsServerIdentity: "spki-sha256:expected",
        }),
      /authenticated peer-policy transport/
    )
    assert.throws(
      () =>
        new HttpP2TREthereumJsonRpc({
          url: "https://ethereum.example/rpc",
          tlsServerIdentity: "spki-sha256:expected",
          fetchFn: fetch,
          authenticatedHttpsTransport: authenticatedTransport(
            "adapter-a",
            "spki-sha256:expected"
          ),
        }),
      /unauthenticated fetch override/
    )
  })

  it("checks the peer policy on every HTTPS response", async () => {
    const expected = "spki-sha256:expected"
    const wrong = authenticatedTransport("adapter-a", "spki-sha256:wrong")
    const ethereum = new HttpP2TREthereumJsonRpc({
      url: "https://ethereum.example/rpc",
      tlsServerIdentity: expected,
      authenticatedHttpsTransport: wrong,
    })
    await assert.rejects(
      ethereum.call("eth_chainId"),
      /peer-policy authentication failed/
    )

    const bitcoin = new HttpP2TRBitcoinCoreRpc({
      url: "https://bitcoin.example/rpc",
      username: "rpc",
      password: "secret",
      tlsServerIdentity: expected,
      authenticatedHttpsTransport: wrong,
      maxAttempts: 1,
    })
    await assert.rejects(
      bitcoin.call("getblockchaininfo"),
      /peer-policy authentication failed/
    )

    const handshake = new HttpP2TRProductionSignedHandshakeProvider({
      url: "https://signer.example/activation",
      trustDomainID: "frost-signer-a",
      operatorIdentity: "operator-a",
      tlsServerIdentity: expected,
      authenticatedHttpsTransport: wrong,
    })
    await assert.rejects(
      handshake.attestActivationChallenge({
        nonce: `0x${"01".repeat(32)}`,
        manifestHash: `0x${"02".repeat(32)}`,
        ethereumPoint: {
          blockNumber: 1,
          blockHash: `0x${"03".repeat(32)}`,
        },
      }),
      /peer-policy authentication failed/
    )
  })

  it("binds the concrete authenticated adapter identity", () => {
    const common = {
      url: "https://ethereum.example/rpc",
      tlsServerIdentity: "spki-sha256:expected",
    }
    const left = new HttpP2TREthereumJsonRpc({
      ...common,
      authenticatedHttpsTransport: authenticatedTransport(
        "adapter-a",
        common.tlsServerIdentity
      ),
    })
    const right = new HttpP2TREthereumJsonRpc({
      ...common,
      authenticatedHttpsTransport: authenticatedTransport(
        "adapter-b",
        common.tlsServerIdentity
      ),
    })
    assert.notEqual(left.endpointFingerprint, right.endpointFingerprint)
  })

  it("rejects plaintext remote and DNS-named HTTP endpoints", () => {
    for (const url of [
      "http://example.com:8545",
      "http://localhost:8545",
      "http://10.0.0.1:8545",
    ]) {
      assert.throws(
        () => new HttpP2TREthereumJsonRpc({ url }),
        /HTTPS or a numeric loopback/
      )
      assert.throws(
        () =>
          new HttpP2TRProductionSignedHandshakeProvider({
            url,
            trustDomainID: "frost-signer-a",
            operatorIdentity: "operator-a",
          }),
        /numeric loopback/
      )
      assert.throws(
        () =>
          new HttpP2TRBitcoinCoreRpc({
            url,
            username: "rpc",
            password: "secret",
          }),
        /HTTPS or a numeric loopback/
      )
    }
  })

  it("rejects redirected responses even when a fetch implementation follows them", async () => {
    const redirectedFetch = async () =>
      ({
        redirected: true,
        url: "https://attacker.invalid/",
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
      } as Response)
    const ethereum = new HttpP2TREthereumJsonRpc({
      url: "http://127.0.0.1:8545",
      fetchFn: redirectedFetch,
    })
    await assert.rejects(ethereum.call("eth_chainId"), /response URL changed/)

    const bitcoin = new HttpP2TRBitcoinCoreRpc({
      url: "http://127.0.0.1:8332",
      username: "rpc",
      password: "secret",
      fetchFn: redirectedFetch,
    })
    await assert.rejects(
      bitcoin.call("getblockchaininfo"),
      /response URL changed/
    )

    const handshake = new HttpP2TRProductionSignedHandshakeProvider({
      url: "http://127.0.0.1:9443/activation",
      trustDomainID: "frost-signer-a",
      operatorIdentity: "operator-a",
      fetchFn: redirectedFetch,
    })
    await assert.rejects(
      handshake.attestActivationChallenge({
        nonce: `0x${"01".repeat(32)}`,
        manifestHash: `0x${"02".repeat(32)}`,
        ethereumPoint: {
          blockNumber: 1,
          blockHash: `0x${"03".repeat(32)}`,
        },
      }),
      /response URL changed/
    )
  })

  it("posts the exact manifest-bound handshake challenge with bounded transport", async () => {
    let request: RequestInit | undefined
    const responsePayload = {
      payload: {
        kind: "frost-signer",
        nonce: `0x${"01".repeat(32)}`,
        manifestHash: `0x${"02".repeat(32)}`,
        ethereumPoint: {
          blockNumber: 1,
          blockHash: `0x${"03".repeat(32)}`,
        },
        state: { healthy: true },
      },
      signerPublicKeySpki: "AA==",
      signature: "AA==",
    }
    const fetchFn = async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      request = init
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const provider = new HttpP2TRProductionSignedHandshakeProvider({
      url: "http://127.0.0.1:9443/activation",
      trustDomainID: "frost-signer-a",
      operatorIdentity: "operator-a",
      fetchFn,
      maxResponseBytes: 4096,
    })
    const response = await provider.attestActivationChallenge({
      nonce: `0x${"01".repeat(32)}`,
      manifestHash: `0x${"02".repeat(32)}`,
      ethereumPoint: {
        blockNumber: 1,
        blockHash: `0x${"03".repeat(32)}`,
      },
    })
    assert.deepEqual(response, responsePayload)
    assert.equal(request?.redirect, "error")
    assert.deepEqual(JSON.parse(String(request?.body)), {
      schema: "tbtc-p2tr-production-activation-handshake/v1",
      challenge: {
        nonce: `0x${"01".repeat(32)}`,
        manifestHash: `0x${"02".repeat(32)}`,
        ethereumPoint: {
          blockNumber: 1,
          blockHash: `0x${"03".repeat(32)}`,
        },
      },
    })
  })
})

function authenticatedTransport(
  implementation: string,
  authenticatedPeerPolicyIdentity: string
): P2TRAuthenticatedHttpsTransport {
  return {
    profile: "p2tr-authenticated-https-peer-policy/v1",
    transportIdentity: { implementation, configurationGeneration: 1 },
    request: async () => ({
      response: new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      authenticatedPeerPolicyIdentity,
    }),
  }
}
