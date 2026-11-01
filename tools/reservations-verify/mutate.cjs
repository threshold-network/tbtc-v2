// Manual mutation harness for the new reservation logic.
// usage: node mutate.cjs <worktree> <shardIndex> <shardCount> <outJson>
//        node mutate.cjs <worktree> --self-test
// env: KILLSET (test files, relative to solidity/), ONLY (comma list of mutant ids), RES_INDENT (12 or 16)
const fs = require("fs")
const cp = require("child_process")
const crypto = require("crypto")
const args = process.argv.slice(2)
const [wt, shardIndexArg, shardCountArg, outPath] = args.filter(
  (a) => !a.startsWith("--")
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
// A failure block that belongs to a hook means the suite never reached the tests it guards.
const HOOK_FAILURE = /"(?:before|after) (?:all|each)" hook/
// Every numbered failure block, as its header plus the title lines under it.
const failureBlocks = (out) => {
  const lines = out.split("\n")
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{2,}\d+\) (\S.*)$/.exec(lines[i])
    if (!m) continue
    const title = [m[1].trim()]
    for (let j = i + 1; j < lines.length && title.length < 4; j++) {
      const line = lines[j].trim()
      if (line === "") continue
      // The thrown error, its stack and the run summary end the title.
      if (
        /^[A-Za-z_$][\w.$]*(Error|Exception)\b/.test(line) ||
        line.startsWith("at ") ||
        /^[\u2714\u2717]/.test(line) ||
        /^\d+ (passing|failing|pending)\b/.test(line) ||
        /^\d+\) /.test(line)
      )
        break
      title.push(line)
    }
    blocks.push(title.join(" "))
  }
  return blocks
}
// The first failing test's name; a KILLED verdict has to cite one.
const firstFailingTest = (out) => {
  const m = /^\s+\d+ failing[\s\S]*?^\s+1\) ([^\n]+)\n\s*([^\n]*)/m.exec(out)
  return m ? `${m[1].trim()} ${m[2].trim()}`.trim().slice(0, 200) : ""
}

// Score one run. A kill needs both halves of the experiment: tests that still pass, and at
// least one test that fails on an assertion. A run that dies in a setup hook, or one where
// nothing passed, shows nothing about the mutant, so it is NOT_VIABLE and is counted apart
// from the mutants that the tests actually caught.
const classify = (out, r) => {
  const passing = count(out, "passing")
  const failing = count(out, "failing")
  const blocks = failureBlocks(out)
  const hooks = blocks.filter((b) => HOOK_FAILURE.test(b))
  const assertions = blocks.filter((b) => !HOOK_FAILURE.test(b))
  const base = { passing, failing, hookFailures: hooks.length }
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
        blocks[0] || "unnamed"
      })`,
    }
  if (
    failing > 0 &&
    hooks.length > 0 &&
    assertions.length === 0 &&
    blocks.length >= failing
  )
    return {
      ...base,
      verdict: "NOT_VIABLE",
      note: `setup failed, no assertion ran (${passing} passing, ${failing} failing; first: ${hooks[0]})`,
    }
  const failedTest = firstFailingTest(out)
  if (failing > 0 && failedTest)
    return {
      ...base,
      verdict: "KILLED",
      note: `${failing} failing; first: ${failedTest}`,
    }
  if (failing > 0)
    return {
      ...base,
      verdict: "UNCONFIRMED",
      note: `${failing} failing but no failing test name found in the output`,
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

if (args.includes("--self-test")) selfTest()
else runShard()
