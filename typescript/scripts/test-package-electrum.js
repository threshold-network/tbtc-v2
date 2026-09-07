const assert = require("assert/strict")
const { createRequire } = require("module")
const { resolve } = require("path")
const { test } = require("node:test")

// Resolve through the installed SDK, even though this test script is in the
// repository. This also selects the right copy when dependencies are nested.
const consumerRequire = createRequire(resolve(process.cwd(), "package.json"))
const sdkRequire = createRequire(consumerRequire.resolve(process.argv[2]))
const ElectrumClient = sdkRequire("electrum-client-js")

test("installed Electrum negotiates its version before requesting a banner", async (t) => {
  const client = new ElectrumClient("localhost", 50001, "tcp")
  t.after(() => client.client.close())

  // Keep the real handshake, with the transport and server responses stubbed.
  client.client.connect = async () => {}
  client.keepAlive = () => {}
  const requests = []
  client.request = async (method) => {
    requests.push(method)
    return method === "server.version"
      ? ["test-electrum", "1.4"]
      : "Test server"
  }

  await client.connect("tbtc-sdk-consumer", "1.4")

  assert.deepEqual(requests, ["server.version", "server.banner"])
})

test("installed Electrum delivers subscription notifications", (t) => {
  const client = new ElectrumClient("localhost", 50001, "tcp")
  t.after(() => client.client.close())

  const method = "blockchain.headers.subscribe"
  const params = [{ height: 42, hex: "00" }]
  let notification
  client.events.once(method, (value) => {
    notification = value
  })

  client.onMessage(JSON.stringify({ method, params }))

  assert.deepEqual(notification, params)
})
