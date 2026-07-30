/* eslint-disable no-underscore-dangle */
import { ethers, helpers } from "hardhat"
import { expect } from "chai"

import type { FakeContract } from "@defi-wonderland/smock"
import type {
  BigNumber,
  BigNumberish,
  BytesLike,
  ContractTransaction,
} from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import type {
  Bridge,
  BridgeStub,
  FrostWalletRegistryStub,
  IRelay,
} from "../../typechain"

import { fixture } from "./utils/fixture"
import { walletState } from "../fixtures"
import { ecdsaWalletTestData } from "../data/ecdsa"
import { loadFixture } from "../helpers/fixture"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

// This integration test exercises the CROSS-SCHEME ECDSA -> FROST moving-funds
// migration: a legacy ECDSA wallet draining its funds into a new FROST /
// Taproot (P2TR) wallet through `submitMovingFundsProof`. It is the core
// mechanism of the ECDSA -> Schnorr migration.
//
// The suite is skipped by default (matching the repo's integration-test
// convention where `WalletCreation`, `FullFlow` and `Slashing` are
// `describe.skip`), and is enabled by setting `RUN_ECDSA_TO_FROST_MF=true`.
// It must run with `TEST_USE_STUBS_TBTC=true` so the deploy chain wires the
// `BridgeStub` (its test-only setters `setWallet` / `setWalletMainUtxo` /
// `resetFrostWalletRegistryForTest` / `resetLifecycleRouterForTest` are used
// below to place the two wallets into the pre-migration state).
const describeFn =
  process.env.RUN_ECDSA_TO_FROST_MF === "true" ? describe : describe.skip

// A representative 32-byte x-only Taproot output key for the FROST target
// wallet. The high 12 bytes are deliberately non-zero so the native-shape
// guard in `Wallets.registerNewFrostWallet` (`bytes12 != 0`) passes; this
// matches a real FROST DKG output key.
const frostXOnlyOutputKey =
  "0xb1de1afa17e1cbb20d8a4f8e54f8a55fbf5c8d2da9e1c6c4d1f0c7b3a2e5d4c8"

// -----------------------------------------------------------------------------
// Fabricated Bitcoin moving-funds transaction + SPV proof builder.
//
// WHAT IS REAL vs. FABRICATED here:
//   - The transaction bytes, its txid, the Bitcoin merkle tree, the coinbase
//     preimage, and the 80-byte block header are all built with the EXACT
//     serialization / double-SHA256 / merkle rules the on-chain
//     `BitcoinTx.validateProof` + `@keep-network/bitcoin-spv-sol` enforce.
//     The contract genuinely recomputes the txid, verifies the merkle proof
//     of the tx AND of the coinbase against the header's merkle root, and
//     checks the header proof-of-work (`hash256(header) <= target`). None of
//     that is stubbed.
//   - The ONLY simplifications, both unavoidable and both identical to what
//     every existing bridge moving-funds test already does:
//       (a) The relay difficulty oracle is a smock fake (as in the whole
//           bridge suite). We mine a genuine block header at the minimum
//           possible target (compact bits 0x207fffff) so its proof-of-work is
//           trivially grindable in-process; its `calculateDifficulty()` is 0,
//           and the fake relay is told the epoch difficulty is 0, so the
//           accumulated-work check `observedDiff >= requestedDiff * factor`
//           (0 >= 0) passes. We cannot mine a real difficulty-1 header
//           (~2^32 work) at test time.
//       (b) The block contains exactly the coinbase + this one moving-funds
//           tx (a real, minimal 2-leaf Bitcoin merkle tree).
//
// Crucially, the moving-funds transaction's single output is a REAL P2TR
// script (`0x5120 || xOnlyKey`) locking funds to the FROST wallet, so the
// migration-specific path is fully exercised: `processMovingFundsTxOutputs`
// -> `extractWalletPubKeyHash` -> P2TR branch -> `walletPubKeyHashByWalletID`
// resolution -> `MovedFundsSweepRequest` creation for the FROST wallet.
// -----------------------------------------------------------------------------

/// Bitcoin hash256 (double SHA-256) over 0x-prefixed hex bytes.
function hash256(hexData: BytesLike): string {
  return ethers.utils.sha256(ethers.utils.sha256(hexData))
}

/// 4-byte little-endian encoding of a uint32.
function uint32LE(value: number): string {
  const buf = new Uint8Array(4)
  buf[0] = value & 0xff
  buf[1] = (value >>> 8) & 0xff
  buf[2] = (value >>> 16) & 0xff
  buf[3] = (value >>> 24) & 0xff
  return ethers.utils.hexlify(buf)
}

/// 8-byte little-endian encoding of a uint64 (Bitcoin output value).
function uint64LE(value: BigNumberish): string {
  const be = ethers.BigNumber.from(value)
    .toHexString()
    .slice(2)
    .padStart(16, "0")
  const bytes = (be.match(/../g) as string[]).reverse()
  return `0x${bytes.join("")}`
}

interface MovingFundsArtifacts {
  movingFundsTx: {
    version: string
    inputVector: string
    outputVector: string
    locktime: string
  }
  movingFundsProof: {
    merkleProof: string
    txIndexInBlock: number
    bitcoinHeaders: string
    coinbasePreimage: string
    coinbaseProof: string
  }
  txHash: string
}

/// Builds a moving-funds Bitcoin transaction that spends `mainUtxo` with a
/// single P2TR output locking `outputValue` satoshi to `xOnlyKey`, plus a
/// valid SPV proof for a fabricated minimum-difficulty block. See the
/// module comment for exactly what is real vs. simplified.
function buildFrostMovingFundsArtifacts(
  mainUtxo: { txHash: BytesLike; txOutputIndex: number },
  xOnlyKey: BytesLike,
  outputValue: BigNumberish
): MovingFundsArtifacts {
  const version = "0x01000000"
  const locktime = "0x00000000"

  // Single input pointing at the source wallet's main UTXO:
  //   count(0x01) | outpointTxHash(32, internal order) | outpointIndex(4 LE) |
  //   scriptSigLen(0x00) | sequence(0xffffffff)
  const inputVector = ethers.utils.hexConcat([
    "0x01",
    mainUtxo.txHash,
    uint32LE(mainUtxo.txOutputIndex),
    "0x00",
    "0xffffffff",
  ])

  // Single P2TR output to the FROST wallet:
  //   count(0x01) | value(8 LE) | scriptLen(0x22) | 0x5120 | xOnlyKey(32)
  // (`0x225120 || xOnlyKey` is exactly `BitcoinTx.makeP2TRScript(xOnlyKey)`.)
  const p2trScriptWithLen = ethers.utils.hexConcat(["0x225120", xOnlyKey])
  const outputVector = ethers.utils.hexConcat([
    "0x01",
    uint64LE(outputValue),
    p2trScriptWithLen,
  ])

  const txBytes = ethers.utils.hexConcat([
    version,
    inputVector,
    outputVector,
    locktime,
  ])
  const txHash = hash256(txBytes)

  // Coinbase transaction. Its raw bytes are never parsed on-chain; only its
  // txid participates in the merkle tree, recomputed from `coinbasePreimage`
  // as `sha256(coinbasePreimage)`. So `coinbasePreimage = sha256(coinbaseTx)`
  // yields `coinbaseTxId = hash256(coinbaseTx)`.
  const coinbaseTxBytes = `0x${"00".repeat(60)}`
  const coinbasePreimage = ethers.utils.sha256(coinbaseTxBytes)
  const coinbaseTxId = ethers.utils.sha256(coinbasePreimage)

  // Minimal real merkle tree: [coinbase (index 0), movingFundsTx (index 1)].
  // root = hash256(coinbaseTxId || movingFundsTxId).
  const merkleRoot = hash256(ethers.utils.hexConcat([coinbaseTxId, txHash]))
  // Proof for the moving-funds tx at index 1 is the coinbase txid; proof for
  // the coinbase at index 0 is the moving-funds txid. Equal length (32 bytes)
  // to satisfy `merkleProof.length == coinbaseProof.length`.
  const merkleProof = coinbaseTxId
  const coinbaseProof = txHash
  const txIndexInBlock = 1

  // 80-byte header: version(4) | prevBlock(32) | merkleRoot(32, LE) |
  //   timestamp(4 LE) | bits(4 LE) | nonce(4 LE).
  // bits = compact 0x207fffff serialized little-endian -> 0xffff7f20; its
  // decoded target is ~2^255, so a valid PoW nonce is found in a couple tries.
  const headerVersion = "0x20000000"
  const prevBlock = `0x${"00".repeat(32)}`
  const timestamp = uint32LE(1700000000)
  const bitsLE = "0xffff7f20"
  // target = 0x7fffff * 2^232. Header PoW passes when the big-endian block
  // hash <= target, i.e. the last byte of the little-endian hash256(header)
  // is < 0x7f.
  let nonce = 0
  let bitcoinHeaders = ""
  for (;;) {
    bitcoinHeaders = ethers.utils.hexConcat([
      headerVersion,
      prevBlock,
      merkleRoot,
      timestamp,
      bitsLE,
      uint32LE(nonce),
    ])
    const digest = hash256(bitcoinHeaders)
    const lastByte = parseInt(digest.slice(-2), 16)
    if (lastByte < 0x7f) {
      break
    }
    nonce += 1
    if (nonce > 1_000_000) {
      throw new Error("could not grind a valid minimum-difficulty header")
    }
  }

  return {
    movingFundsTx: { version, inputVector, outputVector, locktime },
    movingFundsProof: {
      merkleProof,
      txIndexInBlock,
      bitcoinHeaders,
      coinbasePreimage,
      coinbaseProof,
    },
    txHash,
  }
}

describeFn(
  "Integration Test - ECDSA to FROST cross-scheme moving funds",
  () => {
    let spvMaintainer: SignerWithAddress
    let deployer: SignerWithAddress
    let bridge: Bridge & BridgeStub
    let relay: FakeContract<IRelay>
    let frostRegistry: FrostWalletRegistryStub

    // The legacy ECDSA source wallet (predates the migration). A non-zero
    // `ecdsaWalletID` is what marks a wallet as ECDSA on-chain.
    const sourceWalletPubKeyHash = ecdsaWalletTestData.pubKeyHash160
    const sourceEcdsaWalletID = ecdsaWalletTestData.walletID

    // Source wallet main UTXO (its BTC funds) being drained by moving funds.
    const sourceMainUtxo = {
      txHash: `0x${"ab".repeat(32)}`,
      txOutputIndex: 0,
      txOutputValue: 2_000_000, // 0.02 BTC
    }
    // Moving-funds fee well under `movingFundsTxMaxTotalFee` (100000 sat).
    const movingFundsFee = 10_000
    const movedValue = sourceMainUtxo.txOutputValue - movingFundsFee

    // Populated in `before`, once the FROST wallet is registered on-chain.
    let frostWalletPubKeyHash: string

    before(async () => {
      const loaded = await loadFixture(fixture)
      relay = loaded.relay
      spvMaintainer = loaded.spvMaintainer
      deployer = loaded.deployer
      // The deploy wires `BridgeStub` under TEST_USE_STUBS_TBTC=true; attach
      // its ABI so the test-only state setters are available.
      bridge = (await ethers.getContractAt(
        "BridgeStub",
        loaded.bridge.address
      )) as Bridge & BridgeStub

      // --- Register a real FROST wallet as Live in the Bridge --------------
      // Deploy the FROST registry stub and repoint the Bridge at it (the
      // canonical registry was wired by the production deploy chain; the
      // one-time setter is bypassed via the stub-only reset). Wire the
      // lifecycle router/owner so `registerNewFrostWallet` reaches the
      // wallet-creation write. This is the same mechanism the
      // `Bridge.FrostWalletRegistration` unit suite uses to genuinely
      // populate `walletPubKeyHashByWalletID` / `walletIDByWalletPubKeyHash`
      // for an x-only key.
      const FrostRegistryStubFactory = await ethers.getContractFactory(
        "FrostWalletRegistryStub"
      )
      frostRegistry =
        (await FrostRegistryStubFactory.deploy()) as FrostWalletRegistryStub
      await frostRegistry.deployed()

      await bridge.resetFrostWalletRegistryForTest(frostRegistry.address)
      await bridge.resetLifecycleRouterForTest(deployer.address)
      await frostRegistry.setLifecycleOwner(deployer.address)

      await frostRegistry.callBridgeFrostWalletCreatedCallback(
        bridge.address,
        frostXOnlyOutputKey
      )

      // The FROST wallet's 20-byte compatibility PKH is derived on-chain via
      // HASH160(0x02 || xOnlyKey); read it from the mapping the registration
      // populated rather than recomputing it in TypeScript.
      frostWalletPubKeyHash = await bridge.walletPubKeyHashForWalletID(
        frostXOnlyOutputKey
      )
    })

    describe("when an ECDSA wallet moves its funds to a FROST P2TR wallet", () => {
      let tx: ContractTransaction
      let artifacts: MovingFundsArtifacts
      let sweepRequestKey: string

      before(async () => {
        await createSnapshot()

        // Sanity: the FROST target must be Live with the x-only <-> PKH
        // mappings populated, and must differ from the ECDSA source.
        expect((await bridge.wallets(frostWalletPubKeyHash)).state).to.equal(
          walletState.Live
        )
        expect(await bridge.walletID(frostWalletPubKeyHash)).to.equal(
          frostXOnlyOutputKey
        )
        expect(frostWalletPubKeyHash.toLowerCase()).to.not.equal(
          (sourceWalletPubKeyHash as string).toLowerCase()
        )

        // --- Place the legacy ECDSA source wallet into MovingFunds ---------
        // with a target-wallets commitment to the FROST wallet's compat PKH.
        //
        // NOTE (documented simplification): the commitment is injected via the
        // BridgeStub `setWallet` helper (exactly as the canonical
        // `Bridge.MovingFunds` unit suite does) rather than by calling
        // `submitMovingFundsCommitment`. On this branch a real ECDSA wallet
        // can no longer be DKG-created (`requestNewWallet` now routes to the
        // FROST registry, which is why `Slashing`/`WalletCreation` are
        // skipped), and `submitMovingFundsCommitment` validates membership
        // against the real ECDSA `WalletRegistry` — which has no such wallet.
        // The commitment PRECONDITION is nonetheless genuinely enforced by the
        // contract: `submitMovingFundsProof` -> `notifyWalletFundsMoved`
        // reverts unless the target-wallets hash derived from the actual tx
        // outputs equals this committed hash.
        const targetWalletsCommitmentHash = ethers.utils.solidityKeccak256(
          ["bytes20[]"],
          [[frostWalletPubKeyHash]]
        )

        await bridge.setWallet(sourceWalletPubKeyHash, {
          ecdsaWalletID: sourceEcdsaWalletID,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: await lastBlockTime(),
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.MovingFunds,
          movingFundsTargetWalletsCommitmentHash: targetWalletsCommitmentHash,
        })
        await bridge.setWalletMainUtxo(sourceWalletPubKeyHash, sourceMainUtxo)

        // --- Build the P2TR moving-funds tx + SPV proof --------------------
        artifacts = buildFrostMovingFundsArtifacts(
          sourceMainUtxo,
          frostXOnlyOutputKey,
          movedValue
        )

        // Fake relay reports epoch difficulty 0, matching the fabricated
        // minimum-difficulty header (see builder comment).
        relay.getCurrentEpochDifficulty.returns(0)
        relay.getPrevEpochDifficulty.returns(0)

        // --- Prove the moving funds on-chain -------------------------------
        tx = await bridge
          .connect(spvMaintainer)
          .submitMovingFundsProof(
            artifacts.movingFundsTx,
            artifacts.movingFundsProof,
            sourceMainUtxo,
            sourceWalletPubKeyHash
          )

        sweepRequestKey = ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [artifacts.txHash, 0]
        )
      })

      after(async () => {
        relay.getCurrentEpochDifficulty.reset()
        relay.getPrevEpochDifficulty.reset()
        await restoreSnapshot()
      })

      it("should accept the SPV proof and complete the moving funds", async () => {
        await expect(tx)
          .to.emit(bridge, "MovingFundsCompleted")
          .withArgs(sourceWalletPubKeyHash, artifacts.txHash)
      })

      // LOAD-BEARING ASSERTION: the P2TR output was resolved through the
      // x-only -> compat-PKH mapping to the FROST wallet, and a moved-funds
      // sweep request was created FOR THE FROST WALLET. This is what proves an
      // ECDSA wallet can drain to a FROST/Taproot target.
      it("should create a MovedFundsSweepRequest for the FROST wallet", async () => {
        const request = await bridge.movedFundsSweepRequests(sweepRequestKey)
        expect(request.walletPubKeyHash).to.equal(frostWalletPubKeyHash)
        expect(request.value).to.equal(movedValue)
        // 1 == MovedFundsSweepRequestState.Pending
        expect(request.state).to.equal(1)
      })

      it("should increment the FROST wallet's pending sweep request counter", async () => {
        expect(
          (await bridge.wallets(frostWalletPubKeyHash))
            .pendingMovedFundsSweepRequestsCount
        ).to.equal(1)
      })

      it("should transition the source ECDSA wallet to Closing", async () => {
        expect((await bridge.wallets(sourceWalletPubKeyHash)).state).to.equal(
          walletState.Closing
        )
      })

      it("should unset the source ECDSA wallet main UTXO", async () => {
        expect(
          (await bridge.wallets(sourceWalletPubKeyHash)).mainUtxoHash
        ).to.equal(ethers.constants.HashZero)
      })

      it("should mark the source wallet main UTXO as spent", async () => {
        const spentKey = ethers.utils.solidityKeccak256(
          ["bytes32", "uint32"],
          [sourceMainUtxo.txHash, sourceMainUtxo.txOutputIndex]
        )
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(await bridge.spentMainUTXOs(spentKey)).to.be.true
      })
    })
  }
)
