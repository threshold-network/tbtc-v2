// Coverage configuration for the tbtc-v2 solidity project.
//
// Every production contract under contracts/ is instrumented so the
// reservation surface (Reservation, ReservationProofs, ReservationRouter,
// ReservationVault, and the bridge's reservation entry points) is covered.
// The in-contract test harnesses and mocks live under contracts/test/ and
// exist only to drive the real contracts, so they are skipped and not
// reported on.
//
// Note: the coverage network is created by solidity-coverage with unlimited
// contract size, which is what lets the instrumented (oversized) Bridge
// deploy. The production size limit is preserved for normal builds/tests.
module.exports = {
  // Paths are relative to the contracts directory (solidity/contracts).
  skipFiles: ["test/"],
  // Emit machine-readable summaries in addition to the text report. The
  // lcov + json outputs live in istanbulFolder below.
  istanbulReporter: ["lcov", "json", "text"],
  istanbulFolder: "coverage",
}
