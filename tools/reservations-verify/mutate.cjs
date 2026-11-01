// Manual mutation harness for the new reservation logic.
// usage: node mutate.cjs <worktree> <shardIndex> <shardCount> <outJson>
//        node mutate.cjs <worktree> --self-test
//        node mutate.cjs --classify <saved-run.log>
// env: KILLSET (test files, relative to solidity/), ONLY (comma list of mutant ids), RES_INDENT (12 or 16)
const fs = require("fs")
const cp = require("child_process")
const crypto = require("crypto")
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
const killset =
  process.env.KILLSET ||
  fs.readFileSync(`${__dirname}/killset.txt`, "utf8").trim()
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
const count = (out, word) => {
  const m = new RegExp(`^\\s+(\\d+) ${word}`, "m").exec(out)
  return m ? Number(m[1]) : 0
}
// A failure block that names a hook (or an uncaught error with no test) is a setup failure: the
// suite never reached the tests it guards.
const SETUP_FAILURE =
  /"(?:before|after) (?:all|each)" hook|Uncaught error outside test suite/
// Mocha prints every element of a failed title path on one line each and closes the path with a
// colon, so a hook under five describes is six lines. Only the blocks that follow the "N failing"
// summary carry that path: the numbered markers printed beside the running suite carry no path.
const failureBlocks = (out) => {
  const lines = out.split("\n")
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s+\d+ failing\b/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return null
  const blocks = []
  let cur = null
  for (let i = start + 1; i < lines.length; i++) {
    const header = /^\s{2,}(\d+)\) (\S.*)$/.exec(lines[i])
    if (header) {
      cur = { number: Number(header[1]), lines: [header[2].trim()] }
      blocks.push(cur)
      continue
    }
    if (!cur) continue
    const text = lines[i].trim()
    if (text !== "") cur.lines.push(text)
  }
  for (const block of blocks) {
    // The path ends at the deepest line that carries the trailing colon; what follows is the
    // thrown error and its stack. A block with no such line has no title we can trust.
    let end = -1
    for (let i = block.lines.length - 1; i >= 0; i--) {
      if (block.lines[i].endsWith(":")) {
        end = i
        break
      }
    }
    block.title =
      end < 0
        ? ""
        : block.lines
            .slice(0, end + 1)
            .join(" ")
            .trim()
  }
  return blocks
}

// Score one run. A kill needs both halves of the experiment: tests that still pass, and at least
// one positively identified, named failing test that is not a setup hook. A run that dies in a
// hook, one where nothing passed, and one whose failure detail cannot be read in full are
// NOT_VIABLE: they say nothing about the mutant, and none of them may borrow a kill.
const classify = (out, r) => {
  const passing = count(out, "passing")
  const failing = count(out, "failing")
  const blocks = failing > 0 ? failureBlocks(out) : []
  const setup = (blocks || []).filter((b) => SETUP_FAILURE.test(b.title))
  const base = { passing, failing, hookFailures: setup.length }
  if (
    /HH600|Compilation failed|CompilerError|TypeError:|DeclarationError|ParserError/.test(
      out
    ) &&
    !passing
  )
    return {
      ...base,
      verdict: "NOT_VIABLE",
      note: `did not compile: ${
        (out.match(/(Error|TypeError|DeclarationError)[^\n]{0,120}/) || [""])[0]
      }`,
    }
  if (failing > 0 && passing === 0)
    return {
      ...base,
      verdict: "NOT_VIABLE",
      note: `no test passed (${failing} failing; first: ${
        (blocks && blocks[0] && blocks[0].title) || "unnamed"
      })`,
    }
  if (failing > 0) {
    if (!blocks)
      return {
        ...base,
        verdict: "NOT_VIABLE",
        note: `${failing} failing and no failure detail in the output, so a test failure cannot be told from a setup hook`,
      }
    const untitled = blocks.filter((b) => b.title === "")
    if (blocks.length !== failing || untitled.length > 0)
      return {
        ...base,
        verdict: "NOT_VIABLE",
        note: `could not read ${failing} failure(s) in full: ${blocks.length} block(s) found, ${untitled.length} with no complete title`,
      }
    const tests = blocks.filter((b) => !SETUP_FAILURE.test(b.title))
    if (tests.length === 0)
      return {
        ...base,
        verdict: "NOT_VIABLE",
        note: `setup failed, no assertion ran (${passing} passing, ${failing} failing; first: ${blocks[0].title})`,
      }
    return {
      ...base,
      verdict: "KILLED",
      note: `${failing} failing; first: ${tests[0].title}`,
    }
  }
  if (passing > 0 && r.status === 0)
    return { ...base, verdict: "SURVIVED", note: `${passing} passing` }
  return {
    ...base,
    verdict: r.error ? "TIMEOUT" : "ERROR",
    note: `status ${r.status}`,
  }
}

const runTests = (files) => {
  const r = cp.spawnSync(
    "bash",
    [
      "-c",
      `cd ${sol} && env -u FORKING_URL -u FORKING_BLOCK TEST_USE_STUBS_TBTC=true USE_EXTERNAL_DEPLOY=true NODE_OPTIONS=--max-old-space-size=4096 npx hardhat test ${files}`,
    ],
    { encoding: "utf8", maxBuffer: 1 << 28, timeout: 40 * 60 * 1000 }
  )
  return { r, out: (r.stdout || "") + (r.stderr || "") }
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
    const base = runTests(killset)
    fs.writeFileSync(`${outPath}.baseline.log`, base.out)
    const p = count(base.out, "passing")
    const f = count(base.out, "failing")
    if (p === 0 || f !== 0 || base.r.status !== 0) {
      console.error(
        `baseline kill set is not green (${p} passing, ${f} failing, status ${base.r.status}); no mutant was run`
      )
      process.exit(3)
    }
    console.log(`baseline green: ${p} passing`)
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
      const { r, out } = runTests(killset)
      scored = classify(out, r)
      // The whole output, so a verdict can be recomputed from the log alone.
      fs.writeFileSync(`${outPath}.${id}.log`, out)
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
const SELF_TEST_CASES = [
  [
    "broken before() hook with one passing test",
    `  mutation harness self-test
    OK passes
  1 passing
  1 failing

  1) mutation harness self-test
       "before all" hook for "fails":
     Error: planted setup failure`,
    "NOT_VIABLE",
  ],
  [
    "assertion failure with one passing test",
    `  1 passing
  1 failing

  1) suite
       reverts when the cap is zero:
     AssertionError: expected 1 to equal 2`,
    "KILLED",
  ],
  [
    "assertion failure and a broken hook",
    `  1 passing
  2 failing

  1) suite
       reverts when the cap is zero:
     AssertionError: expected 1 to equal 2

  2) suite
       "after all" hook for "reverts when the cap is zero":
     Error: teardown`,
    "KILLED",
  ],
  [
    "every test fails, none passes",
    `  3 failing

  1) suite
       reverts when the cap is zero:
     AssertionError: expected 1 to equal 2`,
    "NOT_VIABLE",
  ],
  [
    "hook under five describes",
    `  1 passing
  1 failing

  1) level one
       level two
         level three
           level four
             level five
               "before all" hook for "is never reached":
     Error: planted deep setup failure`,
    "NOT_VIABLE",
  ],
  [
    "failure count with no failure detail",
    `  4 passing
  1 failing`,
    "NOT_VIABLE",
  ],
  [
    "failure block with no title",
    `  1 passing
  1 failing

  1) level one
     Error: something with no title line`,
    "NOT_VIABLE",
  ],
  [
    "compile error",
    `An unexpected error occurred:

Error HH600: Compilation failed`,
    "NOT_VIABLE",
  ],
  ["green run", `  306 passing`, "SURVIVED"],
]

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

// Planted by mutate.cjs --self-test: the before() hook throws five describes down, so Mocha
// prints its title path as six lines.
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
]

const selfTest = () => {
  let failed = 0
  const report = (ok, label, detail) => {
    if (!ok) failed++
    console.log(
      `${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`
    )
  }
  for (const [label, out, want] of SELF_TEST_CASES) {
    const got = classify(out, { status: out.includes("passing") ? 0 : 1 })
    report(
      got.verdict === want,
      `parser: ${label}`,
      `${got.verdict}, want ${want}: ${got.note}`
    )
  }
  const dir = `${sol}/test/bridge`
  for (const [file, body, want] of SELF_TEST_PLANTS) {
    const path = `${dir}/${file}`
    let got
    try {
      fs.writeFileSync(path, body)
      const { r, out } = runTests(`test/bridge/${file}`)
      got = classify(out, r)
      if (got.verdict !== want) console.log(out.slice(-3000))
    } finally {
      fs.rmSync(path, { force: true })
    }
    report(
      got.verdict === want,
      `plant: ${file} -> ${want}`,
      `${got.verdict}, ${got.passing} passing, ${got.failing} failing, ${got.hookFailures} hook failure(s): ${got.note}`
    )
  }
  console.log(
    `self-test: ${
      SELF_TEST_CASES.length + SELF_TEST_PLANTS.length - failed
    } passed, ${failed} failed`
  )
  process.exit(failed === 0 ? 0 : 1)
}

// Recompute a verdict from a saved run's log, so a result can be re-checked without a test run.
// The exit status is not in the log, so SURVIVED and ERROR are what the log alone can say.
const reportLog = (file) => {
  const scored = classify(fs.readFileSync(file, "utf8"), { status: 0 })
  console.log(scored.verdict, scored.note)
  console.log(
    `passing ${scored.passing} failing ${scored.failing} hookFailures ${scored.hookFailures}`
  )
}

if (args.includes("--self-test")) selfTest()
else if (classifyLog) reportLog(classifyLog)
else runShard()
