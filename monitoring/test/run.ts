import { runTests } from "./test-runner"

process.env.ENVIRONMENT = process.env.ENVIRONMENT ?? "testnet"
process.env.ETHEREUM_URL = process.env.ETHEREUM_URL ?? "http://localhost:8545"
process.env.ELECTRUM_URL = process.env.ELECTRUM_URL ?? "tcp://localhost:50001"

async function main() {
  await import("./sentry-receiver.test")
  await import("./system-event-manager.test")
  await import("./receiver-isolation.test")
  await import("./redemption-chain.test")
  await import("./redemption-lifecycle-monitor.test")

  await runTests()
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
