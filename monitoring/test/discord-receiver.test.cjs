const assert = require("node:assert/strict")
const { test } = require("node:test")
const { createServer } = require("node:http")
// Receiver tests do not need chain access or deployment environment variables.
require.cache[require.resolve("../dist/blocks")] = { exports: { blocks: {} } }
const { DiscordReceiver } = require("../dist/discord-receiver")

const event = {
  title: "Deposit detected",
  type: "informational",
  data: { deposit: "123" },
  block: 1234,
}

async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

test("sends the existing embed payload and accepts Discord's empty 204", async () => {
  let received
  await withServer(
    (request, response) => {
      assert.equal(request.method, "POST")
      assert.equal(request.headers["content-type"], "application/json")
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        received = JSON.parse(body)
        response.writeHead(204)
        response.end()
      })
    },
    async (url) => {
      const result = await new DiscordReceiver(url).receive(event)
      assert.equal(result.status, "handled")
    }
  )
  assert.deepEqual(received, {
    embeds: [
      {
        title: event.title,
        color: 0x003399,
        fields: [
          { name: "deposit", value: "123" },
          { name: "block", value: "1234" },
        ],
      },
    ],
  })
})

test("rejects non-2xx responses without disclosing webhook URLs", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(429)
      response.end("rate limited")
    },
    async (url) => {
      await assert.rejects(new DiscordReceiver(url).handle(event), {
        message: "Discord webhook failed with status 429",
      })
    }
  )
})

test("does not follow webhook redirects", async () => {
  let requests = 0
  await withServer(
    (_request, response) => {
      requests++
      response.writeHead(307, { Location: "/other" })
      response.end()
    },
    async (url) => assert.rejects(new DiscordReceiver(url).handle(event))
  )
  assert.equal(requests, 1)
})

test("cancels unused response bodies without buffering them", async (t) => {
  let cancelled = false
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        })
      )
  )
  await new DiscordReceiver("https://example.test/webhook").handle(event)
  assert.equal(cancelled, true)
})

test("aborts webhook requests after the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(
    globalThis,
    "fetch",
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new Error("request aborted"))
        )
      })
  )
  const request = new DiscordReceiver("https://example.test/webhook").handle(
    event
  )
  const rejection = assert.rejects(request, /request aborted/)
  t.mock.timers.tick(30000)
  await rejection
})
