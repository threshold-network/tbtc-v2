import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const { BigNumber, constants, utils } = require("ethers")
const directory = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.resolve(
  directory,
  "../../../docs/test-vectors/p2tr-signature-fraud-full-sighash-v0.json"
)
const outputPath = path.resolve(
  directory,
  "../../../docs/test-vectors/p2tr-complete-v2-challenge-evidence-v1.json"
)

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8")).cases
const chainId = "1"
const bridge = "0x1111111111111111111111111111111111111111"
const tweakedWalletID =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const identityDomain = "tbtc-p2tr-signature-fraud-authorization-v3"
const evidenceAbiTypes = [
  "bytes32",
  "bytes32",
  "bytes32",
  "uint32",
  "bytes32",
  "bytes32",
  "bytes32",
]

const hex = (value) => `0x${value}`
const challengeIdentity = (walletID, signingKey, sighash) =>
  utils.sha256(
    utils.solidityPack(
      ["string", "uint256", "address", "bytes32", "bytes32", "bytes32"],
      [identityDomain, chainId, bridge, walletID, signingKey, sighash]
    )
  )
const depositKey = (txHash, outputIndex) =>
  BigNumber.from(
    utils.keccak256(
      utils.solidityPack(["bytes32", "uint32"], [txHash, outputIndex])
    )
  ).toString()
const bindingCommitment = (walletID, signingKey) =>
  utils.keccak256(
    utils.solidityPack(["bytes32", "bytes32"], [walletID, signingKey])
  )
const evidence = (
  walletID,
  signingKey,
  bindingTxHash,
  bindingOutputIndex,
  sighash,
  nonceX,
  signatureScalar
) => {
  const encodedEvidence = utils.defaultAbiCoder.encode(evidenceAbiTypes, [
    walletID,
    signingKey,
    bindingTxHash,
    bindingOutputIndex,
    sighash,
    nonceX,
    signatureScalar,
  ])
  if (utils.arrayify(encodedEvidence).length !== 224) {
    throw new Error("COMPLETE_V2 evidence encoding is not 224 bytes")
  }
  return {
    walletID,
    signingKey,
    bindingTxHash,
    bindingOutputIndex,
    sighash,
    nonceX,
    signatureScalar,
    encodedEvidence,
    challengeIdentity: challengeIdentity(walletID, signingKey, sighash),
  }
}

const cases = source.map((vector) => {
  const signingKey = hex(vector.walletIDHex)
  const sighash = hex(vector.expectedBip341SighashHex)
  const signature = hex(vector.witnessSignatureHex.slice(0, 128))
  const nonceX = utils.hexDataSlice(signature, 0, 32)
  const signatureScalar = utils.hexDataSlice(signature, 32, 64)
  const prevout = vector.prevouts[vector.signedInputIndex]
  const bindingTxHash = hex(prevout.txidHex)
  const walletKey = evidence(
    signingKey,
    signingKey,
    constants.HashZero,
    0,
    sighash,
    nonceX,
    signatureScalar
  )
  const tweakedDepositKey = {
    ...evidence(
      tweakedWalletID,
      signingKey,
      bindingTxHash,
      prevout.vout,
      sighash,
      nonceX,
      signatureScalar
    ),
    depositKey: depositKey(bindingTxHash, prevout.vout),
    bindingCommitment: bindingCommitment(tweakedWalletID, signingKey),
  }
  return {
    id: vector.id,
    sighashType:
      vector.witnessSignatureHex.length === 128
        ? "DEFAULT"
        : hex(vector.witnessSignatureHex.slice(-2)),
    walletKey,
    tweakedDepositKey,
  }
})

const first = cases[0]
const document = {
  schemaVersion: "tbtc/complete-p2tr-challenge-evidence-v1",
  sourceVectors: path.basename(sourcePath),
  evidenceAbiTypes,
  encodedEvidenceBytes: 224,
  selectors: {
    directSubmit: utils
      .id(
        "submitP2TRSignatureFraudChallenge((bytes32,bytes32,bytes32,uint32,bytes32,bytes32,bytes32))"
      )
      .slice(0, 10),
    dispatcher: utils
      .id("processP2TRSignatureFraudChallenge(uint8,bytes,uint32[])")
      .slice(0, 10),
  },
  challengeIdentity: {
    domain: identityDomain,
    formula:
      "sha256(abi.encodePacked(domain,uint256 domainChainID,address bridge,bytes32 walletID,bytes32 signingKey,bytes32 sighash))",
    challengeKeyFormula: "uint256(challengeIdentity)",
    referenceDomain: { chainId, bridge },
  },
  depositBinding: {
    depositKeyFormula:
      "uint256(keccak256(abi.encodePacked(bytes32 bindingTxHash,uint32 bindingOutputIndex)))",
    commitmentFormula:
      "keccak256(abi.encodePacked(bytes32 walletID,bytes32 signingKey))",
  },
  cases,
  rejectionCases: [
    {
      id: "base-wallet-key-nonzero-tx-binding",
      expectedReason: "Base wallet key must not have deposit binding",
      evidence: {
        ...first.walletKey,
        bindingTxHash: first.tweakedDepositKey.bindingTxHash,
      },
    },
    {
      id: "base-wallet-key-nonzero-index-binding",
      expectedReason: "Base wallet key must not have deposit binding",
      evidence: { ...first.walletKey, bindingOutputIndex: 1 },
    },
    {
      id: "tweaked-key-missing-outpoint",
      expectedReason: "Taproot deposit wallet binding not found",
      evidence: {
        ...first.tweakedDepositKey,
        bindingTxHash: constants.HashZero,
        bindingOutputIndex: 0,
      },
    },
    {
      id: "tweaked-key-wrong-wallet-binding",
      expectedReason: "Taproot deposit wallet binding mismatch",
      evidence: {
        ...first.tweakedDepositKey,
        walletID:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
    {
      id: "truncated-dispatch-evidence",
      expectedReason: "Invalid challenge evidence length",
      encodedEvidence: utils.hexDataSlice(
        first.walletKey.encodedEvidence,
        0,
        223
      ),
    },
    {
      id: "extended-dispatch-evidence",
      expectedReason: "Invalid challenge evidence length",
      encodedEvidence: `${first.walletKey.encodedEvidence}00`,
    },
  ],
}

const rendered = `${JSON.stringify(document, null, 2)}\n`
if (process.argv.includes("--check")) {
  if (
    !fs.existsSync(outputPath) ||
    fs.readFileSync(outputPath, "utf8") !== rendered
  ) {
    throw new Error(
      "COMPLETE_V2 challenge vectors are stale; regenerate with this script"
    )
  }
} else {
  fs.writeFileSync(outputPath, rendered)
}
console.log(outputPath)
