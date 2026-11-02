import { strict as assert } from "assert"
import { createServer, Server, RequestListener } from "http"
import { AddressInfo } from "net"
import { gzipSync } from "zlib"
import { JsonHttpError, postJson } from "../../../src/lib/utils/json-http"

describe("bounded JSON HTTP transport", () => {
  let server: Server
  let url: string
  let handler: RequestListener

  beforeEach(async () => {
    server = createServer((request, response) => handler(request, response))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("POSTs JSON and preserves response status and Unicode data", async () => {
    let received = ""
    handler = (request, response) => {
      assert.equal(request.method, "POST")
      assert.equal(request.headers["content-type"], "application/json")
      request.on("data", (chunk) => (received += chunk))
      request.on("end", () => {
        response.writeHead(201, { "Content-Type": "application/json" })
        const bytes = Buffer.from(JSON.stringify({ receipt: "⚡" }))
        response.write(bytes.subarray(0, bytes.length - 3))
        response.end(bytes.subarray(bytes.length - 3))
      })
    }
    assert.deepEqual(await postJson(url, { deposit: 123 }), {
      status: 201,
      data: { receipt: "⚡" },
    })
    assert.deepEqual(JSON.parse(received), { deposit: 123 })
  })

  it("preserves conflict response data used to recover an existing deposit", async () => {
    handler = (_request, response) => {
      response.writeHead(409)
      response.end(JSON.stringify({ success: false, depositId: "123" }))
    }
    await assert.rejects(postJson(url, {}), (error: JsonHttpError) => {
      assert.equal(error.isJsonHttpError, true)
      assert.deepEqual(error.response, {
        status: 409,
        data: { success: false, depositId: "123" },
      })
      return true
    })
  })

  it("keeps a non-JSON server error as an HTTP error", async () => {
    handler = (_request, response) => {
      response.writeHead(503)
      response.end("Unavailable")
    }
    await assert.rejects(postJson(url, {}), (error: JsonHttpError) => {
      assert.equal(error.response?.status, 503)
      assert.equal(error.response?.data, "Unavailable")
      return true
    })
  })

  it("rejects malformed JSON on a successful response", async () => {
    handler = (_request, response) => response.end("{malformed")
    await assert.rejects(postJson(url, {}), { code: "ERR_BAD_RESPONSE" })
  })

  it("accepts an empty successful response", async () => {
    handler = (_request, response) => {
      response.writeHead(204)
      response.end()
    }
    assert.deepEqual(await postJson(url, {}), { status: 204, data: "" })
  })

  it("does not replay deposit requests through redirects", async () => {
    let requests = 0
    handler = (_request, response) => {
      requests++
      response.writeHead(307, { Location: `${url}/other` })
      response.end()
    }
    await assert.rejects(postJson(url, {}))
    assert.equal(requests, 1)
  })

  it("bounds streamed bodies even without Content-Length", async () => {
    handler = (_request, response) => {
      response.write("x".repeat(80))
      response.end("x".repeat(80))
    }
    await assert.rejects(postJson(url, {}, { maxResponseBytes: 100 }), {
      code: "ERR_RESPONSE_TOO_LARGE",
    })
  })

  it("bounds decompressed bytes rather than compressed wire size", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Encoding": "gzip" })
      response.end(gzipSync(JSON.stringify({ data: "x".repeat(10000) })))
    }
    await assert.rejects(postJson(url, {}, { maxResponseBytes: 100 }), {
      code: "ERR_RESPONSE_TOO_LARGE",
    })
  })

  it("aborts a response stalled after headers and keeps the retry timeout code", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.write('{"unfinished":')
    }
    await assert.rejects(postJson(url, {}, { timeout: 50 }), {
      code: "ECONNABORTED",
    })
  })

  it("rejects non-HTTP endpoint schemes before a request", async () => {
    await assert.rejects(postJson("file:///tmp/example", {}), /HTTP\(S\)/)
  })

  it("preserves native connection failure codes used by relayer retries", async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const code of [
        "ECONNREFUSED",
        "ENOTFOUND",
        "UND_ERR_CONNECT_TIMEOUT",
      ]) {
        globalThis.fetch = async () => {
          const failure = new Error("fetch failed") as Error & {
            cause: { code: string }
          }
          failure.cause = { code }
          throw failure
        }
        await assert.rejects(postJson(url, {}), {
          code: code === "UND_ERR_CONNECT_TIMEOUT" ? "ECONNABORTED" : code,
        })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
