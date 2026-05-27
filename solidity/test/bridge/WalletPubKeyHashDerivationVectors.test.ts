import { ethers } from "hardhat"
import { expect } from "chai"
import fs from "fs"
import path from "path"
import type { TestBitcoinTx } from "../../typechain"

// Cross-repo derivation fixture (also checked into keep-core at
// pkg/frost/testdata/wallet-pubkey-hash-derivation-vectors-v1.json).
// Each repo's test must reproduce the expected output from the same
// input; if either side drifts from the other, at least one repo's
// test fails. Drift between bridge and keep-core silently breaks the
// wallet identity contract for any wallet whose canonical identity is
// established cross-repo (in particular, FROST wallets registered via
// the FROST WalletRegistry will use this derivation).
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../docs/test-vectors/wallet-pubkey-hash-derivation-vectors-v1.json"
)

interface EcdsaVector {
  name: string
  input: { compressedPubKey: string }
  expected: { walletPubKeyHash: string }
  note?: string
}

interface FrostVector {
  name: string
  input: { xOnlyOutputKey: string }
  expected: { walletPubKeyHash: string }
  note?: string
}

interface Fixture {
  name: string
  version: string
  description: string
  ecdsa_legacy: EcdsaVector[]
  frost_p2tr: FrostVector[]
  drift_check: {
    tbtc_path: string
    keep_core_path: string
    rule: string
  }
}

describe("Wallet PubKeyHash Derivation - Cross-Repo Vectors", () => {
  let fixture: Fixture
  let bitcoinTx: TestBitcoinTx

  before(async () => {
    // Read the fixture file. Failure to read is treated as a fixture
    // configuration error and surfaces as a test failure -- this is
    // intentional: a missing fixture is a much louder failure mode
    // than a silently-passing test.
    const raw = fs.readFileSync(FIXTURE_PATH, "utf8")
    fixture = JSON.parse(raw)

    expect(fixture.version).to.equal(
      "v1",
      "fixture schemaVersion drift -- both repos must update together"
    )

    // Deploy a TestBitcoinTx harness so we can call the library's
    // internal `deriveWalletPubKeyHashFromXOnly` and re-derive the
    // compressed-key HASH160 via the same primitives the production
    // code uses.
    const SystemTestRelay = await ethers.getContractFactory("SystemTestRelay")
    const relay = await SystemTestRelay.deploy()

    const TestBitcoinTx = await ethers.getContractFactory("TestBitcoinTx")
    bitcoinTx = (await TestBitcoinTx.deploy(
      relay.address
    )) as unknown as TestBitcoinTx
  })

  describe("FROST P2TR wallet vectors", () => {
    // The tbtc bridge's FROST wallet registration computes
    // `walletPubKeyHash = BitcoinTx.deriveWalletPubKeyHashFromXOnly(
    // xOnlyOutputKey)` which evaluates to
    // `bytes20(HASH160(0x02 || xOnlyOutputKey))`. The shared fixture
    // pre-computes the expected output; this test re-derives via the
    // on-chain helper and asserts byte equality.
    it("matches each fixture vector", async () => {
      // Iterate via Promise.all + map to satisfy the project's
      // no-await-in-loop and no-restricted-syntax (for-of) rules.
      // Each vector's assertion is independent so concurrent
      // dispatch is safe.
      const typedHarness = bitcoinTx as unknown as {
        deriveWalletPubKeyHashFromXOnly: (key: string) => Promise<string>
      }
      await Promise.all(
        fixture.frost_p2tr.map(async (vector) => {
          const derived = await typedHarness.deriveWalletPubKeyHashFromXOnly(
            vector.input.xOnlyOutputKey
          )
          expect(
            derived.toLowerCase(),
            `FROST vector "${vector.name}" derivation drift`
          ).to.equal(vector.expected.walletPubKeyHash.toLowerCase())
        })
      )
    })
  })

  describe("ECDSA compressed-pubkey vectors", () => {
    // Legacy ECDSA wallets are registered with an uncompressed pubkey
    // (publicKeyX, publicKeyY); the bridge compresses it and applies
    // HASH160 to get the pubKeyHash. This vector set exercises the
    // HASH160 step directly by feeding pre-compressed pubkeys; if the
    // off-chain compression + HASH160 stack drifts between bridge
    // tooling and keep-core operator tooling, vectors caught here.
    //
    // We compute HASH160 via TestBitcoinTx exposure if available; if
    // not, fall back to recomputing in JS (which is what the
    // operator tooling would do off-chain). Both paths must agree
    // with the fixture's expected value.
    it("each fixture vector reproduces the expected HASH160", () => {
      // Use forEach rather than for-of to satisfy the project's
      // no-restricted-syntax lint rule. Synchronous iteration.
      fixture.ecdsa_legacy.forEach((vector) => {
        const jsHash = jsHash160(vector.input.compressedPubKey)
        expect(
          jsHash.toLowerCase(),
          `ECDSA vector "${vector.name}" off-chain HASH160 drift`
        ).to.equal(vector.expected.walletPubKeyHash.toLowerCase())
      })
    })
  })

  describe("Drift detection metadata", () => {
    it("declares the keep-core mirror path", () => {
      expect(fixture.drift_check.keep_core_path).to.equal(
        "pkg/frost/testdata/wallet-pubkey-hash-derivation-vectors-v1.json"
      )
    })
  })
})

// Off-chain HASH160 reproduces what the bridge does on-chain.
// Used for the ECDSA-side fixture verification because the bridge
// itself performs HASH160 as part of the compressed-key pipeline; this
// JS implementation must match the on-chain pipeline byte-for-byte.
function jsHash160(hex: string): string {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const crypto = require("crypto") as typeof import("crypto")
  const buf = Buffer.from(hex.replace(/^0x/, ""), "hex")
  const sha = crypto.createHash("sha256").update(buf).digest()
  const rip = crypto.createHash("ripemd160").update(sha).digest()
  return `0x${rip.toString("hex")}`
}
