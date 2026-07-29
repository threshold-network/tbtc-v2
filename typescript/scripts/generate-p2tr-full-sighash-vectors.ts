/* eslint-disable no-console */
// Generates the full multi-mode BIP-341 key-path sighash vector corpus used by
// both the Solidity and the SDK P2TR signature-fraud tests.
//
// INDEPENDENCE: every `expectedBip341SighashHex` is produced by bitcoinjs-lib's
// `Transaction.prototype.hashForWitnessV1(inIndex, prevOutScripts, values,
// hashType, leafHash?, annex?)` -- an independent BIP-341 reference
// implementation. The sighashes are NOT derived from the tBTC Solidity verifier
// or from the SDK's own `computeP2TRKeyPathSighash` (which would be circular);
// the Solidity and SDK tests assert equality against these bitcoinjs values.
//
// Each vector's Schnorr signature is a real BIP-340 signature over the bitcoinjs
// sighash produced with @noble/curves, so `checkKeyPathSignature` passes
// end-to-end. `expectedBridgeChallengeIdentityHex` is produced by the SDK's
// `computeP2TRSignatureFraudBridgeChallengeIdentity` so the Solidity and SDK
// challenge-identity encoders are held to the same value (SDK<->Solidity
// parity); the security-critical field it commits to (the sighash) still comes
// from bitcoinjs.
//
// Run: `npx ts-node --files ./scripts/generate-p2tr-full-sighash-vectors.ts`

import fs from "fs"
import path from "path"

import { Transaction } from "bitcoinjs-lib"
import { schnorr } from "@noble/curves/secp256k1"

import {
  P2TR_SIGHASH_DEFAULT,
  P2TR_SIGHASH_ALL,
  P2TR_SIGHASH_NONE,
  P2TR_SIGHASH_SINGLE,
  P2TR_SIGHASH_ANYONECANPAY_ALL,
  P2TR_SIGHASH_ANYONECANPAY_NONE,
  P2TR_SIGHASH_ANYONECANPAY_SINGLE,
  computeP2TRSignatureFraudBridgeChallengeIdentity,
  P2TRSupportedSighashType,
} from "../src/services/maintenance/p2tr-signature-fraud"

const toHex = (buffer: Buffer | Uint8Array): string =>
  Buffer.from(buffer).toString("hex")

const p2trScript = (xOnlyKeyHex: string): Buffer =>
  Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(xOnlyKeyHex, "hex")])

// Wallet key. The x-only public key is the canonical wallet ID and the P2TR
// output key (tBTC FROST wallets spend key-path with the untweaked group key).
const privateKey = Buffer.from(
  "00000000000000000000000000000000000000000000000000000000000000aa",
  "hex"
)
const walletID = toHex(schnorr.getPublicKey(privateKey))

type PrevoutSpec = {
  txidHex: string
  vout: number
  valueSats: number
  scriptPubKeyHex: string
}

type OutputSpec = { valueSats: number; scriptPubKeyHex: string }

// A three-input, three-output transaction so per-input ANYONECANPAY and
// per-index SIGHASH_SINGLE are actually exercised over distinct positions.
const inputs = [
  {
    hash: Buffer.from("11".repeat(32), "hex"),
    index: 0,
    sequence: 0xfffffffd,
  },
  {
    hash: Buffer.from("22".repeat(32), "hex"),
    index: 2,
    sequence: 0xffffffff,
  },
  {
    hash: Buffer.from("33".repeat(32), "hex"),
    index: 1,
    sequence: 0xfffffffe,
  },
]

const prevoutValues = [600000000, 900000000, 250000000]

const outputs: OutputSpec[] = [
  {
    valueSats: 700000000,
    scriptPubKeyHex: p2trScript("44".repeat(32)).toString("hex"),
  },
  {
    valueSats: 550000000,
    scriptPubKeyHex: p2trScript("55".repeat(32)).toString("hex"),
  },
  {
    valueSats: 480000000,
    scriptPubKeyHex: p2trScript("66".repeat(32)).toString("hex"),
  },
]

const buildUnsignedTransaction = (): Transaction => {
  const tx = new Transaction()
  tx.version = 2
  tx.locktime = 500000
  inputs.forEach((input) =>
    tx.addInput(input.hash, input.index, input.sequence)
  )
  outputs.forEach((output) =>
    tx.addOutput(Buffer.from(output.scriptPubKeyHex, "hex"), output.valueSats)
  )
  return tx
}

const prevOutScripts = prevoutValues.map(() => p2trScript(walletID))

const prevouts: PrevoutSpec[] = inputs.map((input, i) => ({
  txidHex: toHex(input.hash),
  vout: input.index,
  valueSats: prevoutValues[i],
  scriptPubKeyHex: p2trScript(walletID).toString("hex"),
}))

type Mode = {
  id: string
  sighashType: P2TRSupportedSighashType
  signedInputIndex: number
  annexHex?: string
}

const modes: Mode[] = [
  {
    id: "default-multi",
    sighashType: P2TR_SIGHASH_DEFAULT,
    signedInputIndex: 1,
  },
  { id: "all-multi", sighashType: P2TR_SIGHASH_ALL, signedInputIndex: 1 },
  { id: "none-multi", sighashType: P2TR_SIGHASH_NONE, signedInputIndex: 0 },
  { id: "single-multi", sighashType: P2TR_SIGHASH_SINGLE, signedInputIndex: 2 },
  {
    id: "anyonecanpay-all-multi",
    sighashType: P2TR_SIGHASH_ANYONECANPAY_ALL,
    signedInputIndex: 0,
  },
  {
    id: "anyonecanpay-none-multi",
    sighashType: P2TR_SIGHASH_ANYONECANPAY_NONE,
    signedInputIndex: 2,
  },
  {
    id: "anyonecanpay-single-multi",
    sighashType: P2TR_SIGHASH_ANYONECANPAY_SINGLE,
    signedInputIndex: 1,
  },
  {
    id: "default-with-annex",
    sighashType: P2TR_SIGHASH_DEFAULT,
    signedInputIndex: 1,
    annexHex: "50deadbeefcafe",
  },
  {
    id: "single-with-annex",
    sighashType: P2TR_SIGHASH_SINGLE,
    signedInputIndex: 2,
    annexHex: "50aabbccddeeff0011",
  },
]

const witnessSignatureHex = (
  sighashType: number,
  signatureHex: string
): string =>
  sighashType === P2TR_SIGHASH_DEFAULT
    ? signatureHex
    : `${signatureHex}${sighashType.toString(16).padStart(2, "0")}`

const cases = modes.map((mode) => {
  const tx = buildUnsignedTransaction()
  const annex = mode.annexHex ? Buffer.from(mode.annexHex, "hex") : undefined

  // Independent reference sighash.
  const sighash = Buffer.from(
    tx.hashForWitnessV1(
      mode.signedInputIndex,
      prevOutScripts,
      prevoutValues,
      mode.sighashType,
      undefined,
      annex
    )
  )

  // Real BIP-340 signature over the reference sighash.
  const signature = Buffer.from(schnorr.sign(sighash, privateKey))
  if (!schnorr.verify(signature, sighash, Buffer.from(walletID, "hex"))) {
    throw new Error(`Schnorr self-verify failed for ${mode.id}`)
  }

  const unsignedTransactionHex = tx.toHex()
  const signatureHex = toHex(signature)

  const bridgeChallengeIdentity =
    computeP2TRSignatureFraudBridgeChallengeIdentity({
      walletID,
      sighash: toHex(sighash),
      signature: signatureHex,
      sighashType: mode.sighashType,
      signedInputIndex: mode.signedInputIndex,
      unsignedTransaction: { transactionHex: unsignedTransactionHex },
      inputPrevouts: prevouts.map((prevout) => ({
        txid: prevout.txidHex,
        vout: prevout.vout,
        valueSats: prevout.valueSats,
        scriptPubKey: prevout.scriptPubKeyHex,
      })),
      annex: mode.annexHex ? `0x${mode.annexHex}` : undefined,
    })

  return {
    id: `bip341-keypath-${mode.id}`,
    walletIDHex: walletID,
    unsignedTransactionHex,
    signedInputIndex: mode.signedInputIndex,
    sighashType: mode.sighashType,
    annexHex: mode.annexHex ?? "",
    prevouts,
    outputs,
    expectedBip341SighashHex: toHex(sighash),
    bip340SignatureHex: signatureHex,
    witnessSignatureHex: witnessSignatureHex(mode.sighashType, signatureHex),
    // Signature with a flipped final byte -- must NOT verify.
    tamperedBip340SignatureHex: toHex(
      Buffer.concat([
        signature.subarray(0, 63),
        Buffer.from([signature[63] ^ 0x01]),
      ])
    ),
    expectedBridgeChallengeIdentityHex: bridgeChallengeIdentity.toString(),
  }
})

const corpus = {
  name: "p2tr-signature-fraud-full-sighash-v0",
  status: "draft",
  purpose:
    "Full multi-mode BIP-341 key-path sighash coverage (DEFAULT/ALL/NONE/SINGLE and ANYONECANPAY variants, plus annex) for the P2TR signature-fraud verifier.",
  reference:
    "Every expectedBip341SighashHex is bitcoinjs-lib Transaction.prototype.hashForWitnessV1(inIndex, prevOutScripts, values, hashType, undefined, annex) -- an independent BIP-341 reference. bip340SignatureHex is a real @noble/curves Schnorr signature over that sighash.",
  generatedWith: {
    "bitcoinjs-lib": "hashForWitnessV1 (BIP-341 reference sighash)",
    "@noble/curves": "schnorr.sign / schnorr.verify (BIP-340 signatures)",
  },
  cases,
}

const outPath = path.resolve(
  __dirname,
  "../../docs/test-vectors/p2tr-signature-fraud-full-sighash-v0.json"
)
fs.writeFileSync(outPath, `${JSON.stringify(corpus, null, 2)}\n`)
console.log(`Wrote ${cases.length} vectors to ${outPath}`)
console.log(`walletID: ${walletID}`)
