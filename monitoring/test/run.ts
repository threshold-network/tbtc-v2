import "./environment.js"
import { runTests } from "./test-runner"
import "./sentry-receiver.test.js"
import "./system-event-manager.test.js"
import "./receiver-isolation.test.js"
import "./redemption-chain.test.js"
import "./reservation-keeper-monitor.test.js"
import "./redemption-lifecycle-monitor.test.js"
import "./supply-monitor.test.js"

runTests().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
