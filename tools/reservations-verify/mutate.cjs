// Manual mutation harness for the new reservation logic.
// usage: node mutate.cjs <worktree> <shardIndex> <shardCount> <outJson>
//        node mutate.cjs <worktree> --self-test
//        node mutate.cjs --classify <saved-report.json>
// env: KILLSET (test files, relative to solidity/), ONLY (comma list of mutant ids), RES_INDENT (12 or 16)
//
// Each test run goes through hardhat.mutation.config.ts, which swaps Mocha's reporter for
// mocha-json-report.cjs, so the verdict is read from the run's own JSON report rather than from
// text on stdout.
const fs = require("fs")
const cp = require("child_process")
const crypto = require("crypto")
const os = require("os")
const args = process.argv.slice(2)
const value = (flag) => {
  const i = args.indexOf(flag)
  return i < 0 ? null : args[i + 1] || null
}
const classifyLog = value("--classify")
const [wt, shardIndexArg, shardCountArg, outPath] = args.filter(
  (a) => !a.startsWith("--") && a !== classifyLog
)
const shardIndex = Number(shardIndexArg)
const shardCount = Number(shardCountArg)
const sol = `${wt}/solidity`
// Read on first use: --self-test and --classify do not need the list.
const killset = () =>
  process.env.KILLSET ||
  fs.readFileSync(`${__dirname}/killset.txt`, "utf8").trim()
// Each run writes its report to a fresh file here; runShard copies the interesting ones next to
// the results. The directory is made on first use so --self-test and --classify never create one.
const REPORT_CONFIG = `${__dirname}/hardhat.mutation.config.ts`
let reportDir = null
let runSeq = 0
const nextReportFile = () => {
  reportDir = reportDir || fs.mkdtempSync(`${os.tmpdir()}/mutation-report-`)
  runSeq += 1
  return `${reportDir}/report-${runSeq}.json`
}
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null
const RES = "contracts/bridge/Reservation.sol"
const PRF = "contracts/bridge/ReservationProofs.sol"
const RTR = "contracts/bridge/ReservationRouter.sol"

const ind = (n) => " ".repeat(n)
// The indent of the continuation lines in `isPrivileged`: 12 before the repository Prettier pass, 16 after it.
const RES_INDENT = Number(process.env.RES_INDENT || 12)
const mutants = [
  // acceptance floor
  [
    "R01 floor: 2*txMaxFee -> 1*txMaxFee",
    RES,
    "uint256(minAmount) + 2 * uint256(txMaxFee)",
    "uint256(minAmount) + uint256(txMaxFee)",
  ],
  [
    "R02 floor: > -> >=",
    RES,
    `uint256(deposit.amount) >\n${ind(
      16
    )}uint256(minAmount) + 2 * uint256(txMaxFee)`,
    `uint256(deposit.amount) >=\n${ind(
      16
    )}uint256(minAmount) + 2 * uint256(txMaxFee)`,
  ],
  // re-anchor floor
  [
    "R03 reanchor floor: > -> >=",
    RES,
    "anchorAmount > txMaxFee + minAmount,",
    "anchorAmount >= txMaxFee + minAmount,",
  ],
  [
    "R04 reanchor floor: drops minAmount",
    RES,
    "anchorAmount > txMaxFee + minAmount,",
    "anchorAmount > txMaxFee,",
  ],
  // skipTargetCaps
  [
    "R05 skip: isPrivileged only (Live source also skips)",
    RES,
    "isPrivileged && sourceState != Wallets.WalletState.Live;",
    "isPrivileged;",
  ],
  [
    "R06 skip: non-Live source only (third party skips)",
    RES,
    "isPrivileged && sourceState != Wallets.WalletState.Live;",
    "sourceState != Wallets.WalletState.Live;",
  ],
  [
    "R07 skip: || instead of &&",
    RES,
    "isPrivileged && sourceState != Wallets.WalletState.Live;",
    "isPrivileged || sourceState != Wallets.WalletState.Live;",
  ],
  [
    "R08 skip: count cap never skipped",
    RES,
    `if (!skipTargetCaps) {\n${ind(20)}require(\n${ind(24)}targetCount`,
    `if (true) {\n${ind(20)}require(\n${ind(24)}targetCount`,
  ],
  [
    "R09 skip: amount cap never skipped",
    RES,
    `if (!skipTargetCaps) {\n${ind(20)}require(\n${ind(
      24
    )}self.maxReservationsAmountPerWallet == 0 ||`,
    `if (true) {\n${ind(20)}require(\n${ind(
      24
    )}self.maxReservationsAmountPerWallet == 0 ||`,
  ],
  [
    "R10 count cap: <= -> <",
    RES,
    "targetCount <= self.maxReservationsPerWallet",
    "targetCount < self.maxReservationsPerWallet",
  ],
  [
    "R11 amount cap: <= -> <",
    RES,
    "targetAmount <= self.maxReservationsAmountPerWallet",
    "targetAmount < self.maxReservationsAmountPerWallet",
  ],
  // privilege computation
  [
    "R12 privilege: governance not privileged",
    RES,
    `privileged ||\n${ind(RES_INDENT)}reservation.owner == msg.sender ||`,
    `false ||\n${ind(RES_INDENT)}reservation.owner == msg.sender ||`,
  ],
  [
    "R13 privilege: owner not privileged",
    RES,
    `reservation.owner == msg.sender ||\n${ind(
      RES_INDENT
    )}self.isSpvMaintainer[msg.sender] ||`,
    `false ||\n${ind(RES_INDENT)}self.isSpvMaintainer[msg.sender] ||`,
  ],
  [
    "R14 privilege: maintainer not privileged",
    RES,
    `self.isSpvMaintainer[msg.sender] ||\n${ind(
      RES_INDENT
    )}walletMembersIDs.length > 0;`,
    `false ||\n${ind(RES_INDENT)}walletMembersIDs.length > 0;`,
  ],
  [
    "R15 privilege: member not privileged",
    RES,
    "walletMembersIDs.length > 0;",
    "false;",
  ],
  [
    "R16 member proof failure does not revert",
    RES,
    `if (!isSourceMember) {\n${ind(16)}revert(`,
    `if (false) {\n${ind(16)}revert(`,
  ],
  [
    "R17 Live source: any caller may rotate",
    RES,
    `require(\n${ind(20)}privileged,\n${ind(
      20
    )}"Only governance can rotate a Live wallet's anchor"`,
    `require(\n${ind(20)}true,\n${ind(
      20
    )}"Only governance can rotate a Live wallet's anchor"`,
  ],
  [
    "R18 cooldown applies to nobody",
    RES,
    `if (!isPrivileged) {\n${ind(12)}require(\n${ind(
      16
    )}block.timestamp >= reservation.reanchorCooldownUntil`,
    `if (false) {\n${ind(12)}require(\n${ind(
      16
    )}block.timestamp >= reservation.reanchorCooldownUntil`,
  ],
  [
    "R19 source state: Closing refused",
    RES,
    `sourceState == Wallets.WalletState.MovingFunds ||\n${ind(
      24
    )}sourceState == Wallets.WalletState.Closing,`,
    `sourceState == Wallets.WalletState.MovingFunds,`,
  ],
  // hand-off reserve gate
  [
    "R20 reserve: <= -> <",
    RES,
    "activeAfterThis <= remaining * self.maxReservationsPerWallet",
    "activeAfterThis < remaining * self.maxReservationsPerWallet",
  ],
  [
    "R21 reserve: ignores per-wallet cap",
    RES,
    "activeAfterThis <= remaining * self.maxReservationsPerWallet",
    "activeAfterThis <= remaining",
  ],
  [
    "R22 reserve: > -> >=",
    RES,
    "liveWalletsCount > handoffReserveWallets\n",
    "liveWalletsCount >= handoffReserveWallets\n",
  ],
  [
    "R23 reserve: does not subtract the reserve",
    RES,
    "? liveWalletsCount - handoffReserveWallets",
    "? liveWalletsCount",
  ],
  [
    "R24 caps: zero reserve accepted",
    RES,
    "handoffReserveWallets > 0,",
    "true,",
  ],
  [
    "R25 caps: reserve not stored",
    RES,
    "self.handoffReserveWallets = handoffReserveWallets;",
    "",
  ],
  // anchored custody
  [
    "R26 custody add: count += 2",
    RES,
    "self.walletAnchoredInfo[walletPubKeyHash].count += 1;",
    "self.walletAnchoredInfo[walletPubKeyHash].count += 2;",
  ],
  [
    "R27 custody add: amount not added",
    RES,
    "self.walletAnchoredInfo[walletPubKeyHash].amount += anchorAmount;",
    "",
  ],
  [
    "R28 custody remove: count not reduced",
    RES,
    "self.walletAnchoredInfo[walletPubKeyHash].count -= 1;",
    "",
  ],
  [
    "R29 custody remove: amount not reduced",
    RES,
    "self.walletAnchoredInfo[walletPubKeyHash].amount -= anchorAmount;",
    "",
  ],
  // proofs
  [
    "P01 acceptance settle: custody not added",
    PRF,
    `Reservation.addAnchoredCustody(\n${ind(12)}self,\n${ind(
      12
    )}reservation.walletPubKeyHash,\n${ind(12)}reservation.anchorAmount\n${ind(
      8
    )});`,
    "",
  ],
  [
    "P02 late/first settle: target custody not added",
    PRF,
    `Reservation.addAnchoredCustody(\n${ind(12)}self,\n${ind(
      12
    )}targetWalletPubKeyHash,\n${ind(12)}anchorAmount\n${ind(8)});`,
    "",
  ],
  [
    "P03 reanchor settle: old custody not removed",
    PRF,
    `Reservation.removeAnchoredCustody(\n${ind(12)}self,\n${ind(
      12
    )}oldWalletPubKeyHash,\n${ind(12)}oldAnchorAmount\n${ind(8)});`,
    "",
  ],
  [
    "P04 reanchor settle: new custody not added",
    PRF,
    `Reservation.addAnchoredCustody(\n${ind(12)}self,\n${ind(
      12
    )}newWalletPubKeyHash,\n${ind(12)}newAnchorAmount\n${ind(8)});`,
    "",
  ],
  [
    "P05 settle: Closing wallet strands at once",
    PRF,
    `walletState == Wallets.WalletState.Closed ||\n${ind(
      12
    )}walletState == Wallets.WalletState.Terminated`,
    `walletState == Wallets.WalletState.Closing ||\n${ind(
      12
    )}walletState == Wallets.WalletState.Closed ||\n${ind(
      12
    )}walletState == Wallets.WalletState.Terminated`,
  ],
  [
    "P06 settle: Terminated wallet not stranded",
    PRF,
    `walletState == Wallets.WalletState.Closed ||\n${ind(
      12
    )}walletState == Wallets.WalletState.Terminated`,
    `walletState == Wallets.WalletState.Closed`,
  ],
  [
    "P07 settle: Closed wallet not stranded",
    PRF,
    `walletState == Wallets.WalletState.Closed ||\n${ind(
      12
    )}walletState == Wallets.WalletState.Terminated`,
    `walletState == Wallets.WalletState.Terminated`,
  ],
  // router funding-proof wrapper
  [
    "W01 wrapper: no proof validation",
    RTR,
    `bytes32 fundingTxHash = BitcoinTx.validateProof(\n${ind(12)}self,\n${ind(
      12
    )}fundingTx,\n${ind(12)}fundingProof\n${ind(8)});`,
    `bytes32 fundingTxHash = sha256(\n${ind(12)}abi.encodePacked(\n${ind(
      16
    )}sha256(\n${ind(20)}abi.encodePacked(\n${ind(24)}fundingTx.version,\n${ind(
      24
    )}fundingTx.inputVector,\n${ind(24)}fundingTx.outputVector,\n${ind(
      24
    )}fundingTx.locktime\n${ind(20)})\n${ind(16)})\n${ind(12)})\n${ind(
      8
    )});\n${ind(8)}fundingProof;`,
  ],
  [
    "W02 wrapper: output index ignored in key",
    RTR,
    "abi.encodePacked(fundingTxHash, fundingOutputIndex)",
    "abi.encodePacked(fundingTxHash, uint32(0))",
  ],
  [
    "W03 wrapper: key is the bare hash",
    RTR,
    "abi.encodePacked(fundingTxHash, fundingOutputIndex)",
    "abi.encodePacked(fundingTxHash)",
  ],
]

const sha = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
// A saved run is the JSON report the reporter wrote. A file that is missing or does not parse is a
// run that never reached the reporter, which is what a compile failure looks like from here.
const readReport = (file) => {
  if (!file) return { report: null, text: null }
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return { report: null, text: null }
  }
  try {
    return { report: JSON.parse(text), text }
  } catch {
    return { report: null, text }
  }
}

// Score one run from its report. A kill needs both halves of the experiment: tests that still pass,
// and at least one failure Mocha marks as a test rather than as a setup hook. A run that died in a
// hook, one where nothing passed, one with no report and one whose report does not parse are
// NOT_VIABLE: they say nothing about the mutant, and none of them may borrow a kill.
const classify = (run) => {
  const text = run.out || ""
  const report = run.report
  if (!report) {
    const stopped =
      /(HH\d{3}:|Compilation failed|CompilerError|DeclarationError|ParserError)/.exec(
        text
      )
    return {
      verdict: "NOT_VIABLE",
      passing: 0,
      failing: 0,
      hookFailures: 0,
      note: stopped
        ? `no report, the run did not compile or start: ${stopped[0]}`
        : `no JSON report from the run (status ${run.r && run.r.status})`,
    }
  }
  const passes = Array.isArray(report.passes) ? report.passes : []
  const failures = Array.isArray(report.failures) ? report.failures : []
  const hooks = failures.filter((f) => f.type === "hook")
  const tests = failures.filter((f) => f.type === "test")
  const untyped = failures.filter((f) => f.type !== "hook" && f.type !== "test")
  const base = {
    passing: passes.length,
    failing: failures.length,
    hookFailures: hooks.length,
  }
  if (untyped.length > 0)
    return {
      ...base,
      verdict: "NOT_VIABLE",
      note: `${untyped.length} failure(s) in the report carry no runnable type, so a test failure cannot be told from a setup hook`,
    }
  if (passes.length === 0)
    return {
      ...base,
      verdict: "NOT_VIABLE",
      note: `no test passed (${failures.length} failing${
        hooks.length ? `, ${hooks.length} in setup hooks` : ""
      })`,
    }
  if (failures.length === 0)
    return { ...base, verdict: "SURVIVED", note: `${passes.length} passing` }
  if (tests.length === 0)
    return {
      ...base,
      verdict: "NOT_VIABLE",
      note: `setup failed, no test failed (${
        hooks.length
      } hook failure(s); first: ${hooks[0].fullTitle || hooks[0].hook})`,
    }
  return {
    ...base,
    verdict: "KILLED",
    note: `${failures.length} failing; first: ${tests[0].fullTitle}`,
  }
}

const runTests = (files) => {
  const reportFile = nextReportFile()
  const r = cp.spawnSync(
    "bash",
    [
      "-c",
      `cd ${sol} && env -u FORKING_URL -u FORKING_BLOCK TEST_USE_STUBS_TBTC=true USE_EXTERNAL_DEPLOY=true NODE_OPTIONS=--max-old-space-size=4096 MUTATION_JSON=${reportFile} npx hardhat --config ${REPORT_CONFIG} test ${files}`,
    ],
    { encoding: "utf8", maxBuffer: 1 << 28, timeout: 40 * 60 * 1000 }
  )
  const out = (r.stdout || "") + (r.stderr || "")
  const { report, text } = readReport(reportFile)
  fs.rmSync(reportFile, { force: true })
  return { r, out, report, reportText: text }
}

const runShard = () => {
  const results = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, "utf8"))
    : {}
  const mine = mutants.filter(
    (m, i) =>
      i % shardCount === shardIndex && (!only || only.has(m[0].split(" ")[0]))
  )

  // An unmutated run first. If it is not green with at least one passing test, every mutant
  // would score KILLED for the wrong reason, so stop here.
  if (mine.length > 0) {
    const base = runTests(killset())
    const scored = classify(base)
    fs.writeFileSync(`${outPath}.baseline.json`, base.reportText || "")
    fs.writeFileSync(`${outPath}.baseline.log`, base.out)
    if (scored.verdict !== "SURVIVED") {
      console.error(
        `baseline kill set is not green (${scored.verdict}: ${scored.note}); no mutant was run`
      )
      process.exit(3)
    }
    console.log(`baseline green: ${scored.passing} passing`)
  }
  for (const [name, file, find, replace] of mine) {
    const id = name.split(" ")[0]
    if (results[id]) continue
    const path = `${sol}/${file}`
    const original = fs.readFileSync(path, "utf8")
    const before = sha(path)
    const first = original.indexOf(find)
    if (first < 0 || original.indexOf(find, first + 1) >= 0) {
      results[id] = {
        name,
        verdict: first < 0 ? "PATTERN_NOT_FOUND" : "PATTERN_NOT_UNIQUE",
      }
      fs.writeFileSync(outPath, JSON.stringify(results, null, 1))
      continue
    }
    const start = Date.now()
    let scored
    try {
      fs.writeFileSync(
        path,
        original.slice(0, first) + replace + original.slice(first + find.length)
      )
      const run = runTests(killset())
      scored = classify(run)
      // The report the verdict was read from, so it can be re-checked without a test run.
      fs.writeFileSync(`${outPath}.${id}.json`, run.reportText || "")
      // The process output too, for a run that never reached the reporter.
      fs.writeFileSync(`${outPath}.${id}.log`, run.out)
    } finally {
      fs.writeFileSync(path, original)
    }
    if (sha(path) !== before) throw new Error(`restore failed for ${file}`)
    results[id] = {
      name,
      verdict: scored.verdict,
      note: scored.note,
      passing: scored.passing,
      failing: scored.failing,
      hookFailures: scored.hookFailures,
      seconds: Math.round((Date.now() - start) / 1000),
    }
    fs.writeFileSync(outPath, JSON.stringify(results, null, 1))
    console.log(id, scored.verdict, scored.note)
  }
  console.log("shard done")
}

// A run that fails only in setup is the case the old criterion scored KILLED, so it is planted
// for real: a test file whose before() hook throws while another test passes. The parser cases
// pin the shapes a Mocha report takes.
const SELF_TEST_PLANTS = [
  [
    "MutationHarnessSelfTestHook.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: the before() hook throws, one test elsewhere passes.
describe("mutation harness self-test", () => {
  before(() => {
    throw new Error("planted setup failure")
  })

  it("is never reached", () => {
    expect(1).to.equal(1)
  })
})

describe("mutation harness self-test control", () => {
  it("passes so the run is not total red", () => {
    expect(1).to.equal(1)
  })
})
`,
    "NOT_VIABLE",
  ],
  [
    "MutationHarnessSelfTestDeepHook.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: the before() hook throws five describes down, where the
// spec reporter prints its title path as six lines.
describe("mutation harness self-test level 1", () => {
  describe("level 2", () => {
    describe("level 3", () => {
      describe("level 4", () => {
        describe("level 5", () => {
          before(() => {
            throw new Error("planted deep setup failure")
          })

          it("is never reached", () => {
            expect(1).to.equal(1)
          })
        })
      })
    })
  })
})

describe("mutation harness self-test deep control", () => {
  it("passes so the run is not total red", () => {
    expect(1).to.equal(1)
  })
})
`,
    "NOT_VIABLE",
  ],
  [
    "MutationHarnessSelfTestAssertion.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: a real assertion failure, which is what a kill must show.
describe("mutation harness self-test assertion", () => {
  it("passes", () => {
    expect(1).to.equal(1)
  })

  it("fails on an assertion", () => {
    expect(1).to.equal(2)
  })
})
`,
    "KILLED",
  ],
  [
    "MutationHarnessSelfTestHookAndAssertion.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: a broken hook and a real assertion failure in one run. The
// hook is not the only failure, so the run still shows a test catching the change.
describe("mutation harness self-test hook and assertion", () => {
  before(() => {
    throw new Error("planted setup failure")
  })

  it("is never reached", () => {
    expect(1).to.equal(1)
  })
})

describe("mutation harness self-test hook and assertion control", () => {
  it("passes so the run is not total red", () => {
    expect(1).to.equal(1)
  })

  it("fails on an assertion", () => {
    expect(1).to.equal(2)
  })
})
`,
    "KILLED",
  ],
  [
    "MutationHarnessSelfTestAllFail.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: every test fails, so nothing shows the suite still works.
describe("mutation harness self-test total red", () => {
  it("fails one", () => {
    expect(1).to.equal(2)
  })

  it("fails two", () => {
    expect(2).to.equal(3)
  })
})
`,
    "NOT_VIABLE",
  ],
  [
    "MutationHarnessSelfTestHookWordedMessage.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: a failing test whose message names a hook. The message is
// diagnostic text, the runnable is a test, so this is a kill.
describe("mutation harness self-test hook-worded message", () => {
  it("passes so the run is not total red", () => {
    expect(1).to.equal(1)
  })

  it("fails with a message that names a hook", () => {
    expect(1, 'bad "before all" hook: nothing was set up').to.equal(2)
  })
})
`,
    "KILLED",
  ],
  [
    "MutationHarnessSelfTestErrorNameTitle.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: a failing test whose own title starts with an error class
// name. The title is a title, so this is a kill.
describe("mutation harness self-test error-name title", () => {
  it("passes so the run is not total red", () => {
    expect(1).to.equal(1)
  })

  it("TypeError is rejected", () => {
    expect(1).to.equal(2)
  })
})
`,
    "KILLED",
  ],
  [
    "MutationHarnessSelfTestColonSuiteHook.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: the only failure is a broken before() hook, under a suite
// whose name ends in a colon and a suite whose name starts with an error class name. Nothing but
// a hook failed, so the run is not a kill.
describe("mutation harness self-test outer:", () => {
  describe("TypeError handling", () => {
    before(() => {
      throw new Error("planted setup failure")
    })

    it("is never reached", () => {
      expect(1).to.equal(1)
    })
  })
})

describe("mutation harness self-test outer control", () => {
  it("passes so the run is not total red", () => {
    expect(1).to.equal(1)
  })
})
`,
    "NOT_VIABLE",
  ],
  [
    "MutationHarnessSelfTestGreen.test.ts",
    `import { expect } from "chai"

// Planted by mutate.cjs --self-test: a green run, which is what a missed mutant looks like.
describe("mutation harness self-test green", () => {
  it("passes", () => {
    expect(1).to.equal(1)
  })
})
`,
    "SURVIVED",
  ],
  [
    "MutationHarnessSelfTestNoReport.test.ts",
    `import { expect } from "chai"
// Planted by mutate.cjs --self-test: the file does not load, so the run never reaches the reporter
// and writes no report. A compile failure looks the same from here.
import "./mutation-harness-self-test-missing-module"

describe("mutation harness self-test missing import", () => {
  it("never runs", () => {
    expect(1).to.equal(1)
  })
})
`,
    "NOT_VIABLE",
  ],
]

// The saved report, read back the way --classify reads it.
const writeTmp = (text) => {
  const file = nextReportFile()
  fs.writeFileSync(file, text || "")
  const { report } = readReport(file)
  return report
}

const selfTest = () => {
  let failed = 0
  const report = (ok, label, detail) => {
    if (!ok) failed++
    console.log(
      `${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`
    )
  }
  const dir = `${sol}/test/bridge`
  for (const [file, body, want] of SELF_TEST_PLANTS) {
    const path = `${dir}/${file}`
    let got
    let saved
    try {
      fs.writeFileSync(path, body)
      const run = runTests(`test/bridge/${file}`)
      got = classify(run)
      if (got.verdict !== want) console.log(run.out.slice(-3000))
      // The same run read back the way --classify reads it: from the saved report alone.
      saved = classify({ report: writeTmp(run.reportText), r: {} })
    } finally {
      fs.rmSync(path, { force: true })
    }
    report(
      got.verdict === want,
      `plant: ${file} -> ${want}`,
      `${got.verdict}, ${got.passing} passing, ${got.failing} failing, ${got.hookFailures} hook failure(s): ${got.note}`
    )
    report(
      saved && saved.verdict === got.verdict,
      `classify from the saved report: ${file}`,
      `${saved && saved.verdict}, want ${got.verdict}`
    )
  }
  console.log(
    `self-test: ${
      SELF_TEST_PLANTS.length * 2 - failed
    } passed, ${failed} failed`
  )
  process.exit(failed === 0 ? 0 : 1)
}

// Recompute a verdict from a saved report, so a result can be re-checked without a test run.
const reportLog = (file) => {
  const scored = classify({ report: readReport(file).report, r: {} })
  console.log(scored.verdict, scored.note)
  console.log(
    `passing ${scored.passing} failing ${scored.failing} hookFailures ${scored.hookFailures}`
  )
}

if (args.includes("--self-test")) selfTest()
else if (classifyLog) reportLog(classifyLog)
else runShard()
