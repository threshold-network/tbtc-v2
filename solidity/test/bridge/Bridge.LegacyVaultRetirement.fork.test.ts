/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai"
import hre, { ethers, helpers } from "hardhat"
import type { Contract, Signer } from "ethers"

import { scanPendingOptimisticMints } from "../../deploy/86_deploy_tip109_hotfix"
import consumedSweepProof from "../data/legacy-vault-consumed-sweep-proof.json"

// ---------------------------------------------------------------------------
// Section 6.5 — mainnet-fork integration for the legacy-vault optimistic-minting
// retirement.
//
// STATUS: real, executable bodies. SKIPPED in the default (non-forked) CI — they
// require a mainnet archive RPC and are gated on `FORKING_URL`. They are NOT
// faked to pass. To run them against an archive endpoint:
//
//   FORKING_URL=<archive RPC>  FORKING_BLOCK=25502458 \
//   TEST_USE_STUBS_TBTC=true \
//   npx hardhat test test/bridge/Bridge.LegacyVaultRetirement.fork.test.ts
//
// (`USE_EXTERNAL_DEPLOY` is NOT needed — the suite deploys its own contracts
// inline and reads live mainnet contracts directly.) The `hardhat` network
// enables forking only when `FORKING_URL` is set (see hardhat.config.ts), so
// without it the fork state below is unavailable and the whole suite is skipped.
// The identity/state cases and the consumed-deposit replay have been executed and
// pass on a real mainnet fork pinned at block 25502458. The two danger branches
// are additionally proven HEADLESS — executed in the default CI — in
// `Bridge.LegacyVaultRetirement.SweepBranches.test.ts`, which drives the same
// callback-brick and untrusted-double-mint mechanics on the real `Bank` and
// `TBTC` token without a fork.
//
// Two section-6.5 post-conditions the earlier draft omitted are now asserted:
// (a) the cutover moves the ENTIRE legacy Bank balance to the successor — the
// atomic-cutover suite snapshots both balances before finalization and asserts
// the exact successor delta equals the pre-cutover legacy balance (a nonzero
// pre-balance is required so the check is non-vacuous), not merely that the
// legacy balance reached zero; and (b) NO consumed deposit can be swept again —
// a real archived mainnet sweep proof
// (`test/data/legacy-vault-consumed-sweep-proof.json`, tx
// 0x2d391f20…4ac7479c at block 25502239, one sweep before the pinned evidence
// block) is re-submitted and rejected with no state change.
//
// ENDPOINT NOTES (empirically confirmed on this host, 2026-07-13):
//   - Some archive RPCs omit the post-merge `totalDifficulty` field and/or reject
//     JSON-RPC batch arrays, which Hardhat 2.12.5's fork adapter needs; and
//     `@keep-network/hardhat-local-networks-config` deep-merges the Map-valued
//     `networks.hardhat.chains` into `{}`, breaking fork init. Both are worked
//     around out-of-band (a pass-through RPC proxy and a wrapper config) when the
//     configured endpoint has those gaps; they are NOT part of this repo.
//   - The atomic-cutover before-hook runs two full pinned scans over ~16k
//     historical events; over a slow/proxied archive endpoint this can approach
//     the (generous) per-hook timeout below. A direct fast archive endpoint
//     completes it comfortably.
// The per-deposit dangerous-set predicate exercised in case 1 is the same exported
// `scanPendingOptimisticMints` that the deploy unit suite covers headless, so its
// logic is independently validated.
// ---------------------------------------------------------------------------

const LEGACY_MAINNET_TBTC_VAULT = "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD"
const LEGACY_MAINNET_TBTC_VAULT_CODE_HASH =
  "0x549c4b627e40d0e38e6d874c56066ad033004f3f5e26ffba9b15806064f6f0df"
const BRIDGE_PROXY = "0x5e4861a80B55f035D899f66772117F00FA0E8e7B"
const TBTC_TOKEN = "0x18084fbA666a33d37592fA2633fD49a74DD93a88"
const BANK = "0x65Fbae61ad2C8836fFbFB502A0dA41b0789D9Fc6"
const OLD_BRIDGE_GOVERNANCE = "0xcBCFA3eb5E067173b262ACe62f9dD87f1D2Cc0Cf"
const PROXY_ADMIN = "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706"
const TIMELOCK = "0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D"
// Production SPV MaintainerProxy that submitted the archived sweep in the
// consumed-deposit fixture; a registered SPV maintainer on the Bridge.
const MAINTAINER_PROXY = "0x535e01f948458e0b64f9db2a01da6f32e240140f"
const COUNCIL_SAFE = ethers.utils.getAddress(
  "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f"
)

// Verified live snapshot (spec sections 1.4 and 6.5).
const EVIDENCE_BLOCK = 25502458
const EXPECTED_FINALIZED_EVENTS = 16298
const EXPECTED_RESIDUAL_DEBTORS = 3796
const EXPECTED_RESIDUAL_DEBT_WEI = "514963660000000000"
const DELAY_24H = 24 * 60 * 60
// Must match `SNAPSHOT_CONFIRMATIONS` in `86_deploy_tip109_hotfix.ts`: the
// scanner refuses to snapshot a block newer than `latest - SNAPSHOT_CONFIRMATIONS`
// so that a reorg cannot orphan the retirement evidence. When the fork is pinned
// exactly at the evidence block, the evidence block is the tip and thus
// unfinalized; the suite mines this many blocks so the evidence-block snapshot
// falls at or below the finalized boundary.
const SNAPSHOT_CONFIRMATIONS = 64

const { increaseTime } = helpers.time

// Run only against a mainnet fork; otherwise skip without faking a pass.
const forkAvailable = !!process.env.FORKING_URL
const describeFork = forkAvailable ? describe : describe.skip

// Impersonates `address` with a funded balance and returns its signer.
async function impersonate(address: string): Promise<Signer> {
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  })
  await hre.network.provider.send("hardhat_setBalance", [
    address,
    "0x3635C9ADC5DEA00000", // 1000 ETH
  ])
  return ethers.provider.getSigner(address)
}

// Mines `count` real blocks in chunks of at most five. `hardhat_mine` with a
// large count reserves a sparse block range that shares the previous block's
// state root (the reservation kicks in only once the remaining-block count
// exceeds a small threshold); a later historical `eth_call` (the pinned scan
// reads state at the finalized boundary, i.e. below the tip) then fails inside
// Hardhat 2.12.5's fork adapter with "restoreForkBlockContext called when
// checkpointed". A five-block call stays on the real-mining path, so every block
// is materialized and historical reads restore cleanly.
async function mineRealBlocks(count: number): Promise<void> {
  let remaining = count
  // eslint-disable-next-line no-restricted-syntax
  while (remaining > 0) {
    const chunk = Math.min(5, remaining)
    // eslint-disable-next-line no-await-in-loop
    await hre.network.provider.send("hardhat_mine", [
      ethers.utils.hexValue(chunk),
    ])
    remaining -= chunk
  }
}

async function deploy(
  name: string,
  args: unknown[] = [],
  opts: Record<string, unknown> = {}
): Promise<Contract> {
  const factory = await ethers.getContractFactory(name, opts)
  const contract = await factory.deploy(...args)
  await contract.deployed()
  return contract
}

describeFork("Bridge - Legacy vault retirement (mainnet fork)", function () {
  // Fork cases query mainnet archive state — the pinned optimistic-mint scan
  // reads the storage of ~16k historical finalized events sequentially over an
  // archive endpoint, and the cutover before-hook runs a second such scan — so
  // the default 2s/60s Mocha timeouts are far too small. A fast archive endpoint
  // finishes each hook in minutes; the thirty-minute default here is generous for
  // that. A slow or proxied endpoint can raise it via FORK_TEST_TIMEOUT_MS. (This
  // suite is gated behind FORKING_URL and is not part of the default CI.)
  this.timeout(Number(process.env.FORK_TEST_TIMEOUT_MS) || 1800000)

  before(async function () {
    // Guard: the pinned evidence-block assertions below only hold at or after
    // the recorded snapshot. Skip if the fork is not pinned near that block.
    const block = await ethers.provider.getBlockNumber()
    if (block < EVIDENCE_BLOCK) {
      this.skip()
    }
    // Mine forward so the evidence block sits at or below the scanner's
    // finalized boundary (latest - SNAPSHOT_CONFIRMATIONS). Without this, a fork
    // pinned exactly at the evidence block leaves it unfinalized and the scan is
    // (correctly) refused. Mined blocks carry no logs, so the archived event
    // counts read at the evidence-block override are unaffected.
    const finalizedTarget = EVIDENCE_BLOCK + SNAPSHOT_CONFIRMATIONS
    if (block < finalizedTarget) {
      await mineRealBlocks(finalizedTarget - block)
    }
  })

  it("recognizes the exact legacy vault identity on the forked chain", async () => {
    const code = await ethers.provider.getCode(LEGACY_MAINNET_TBTC_VAULT)
    expect(code).to.not.equal("0x")
    expect(ethers.utils.keccak256(code)).to.equal(
      LEGACY_MAINNET_TBTC_VAULT_CODE_HASH
    )
  })

  it("observes the paused, TBTC-owning legacy vault", async () => {
    const legacy = await ethers.getContractAt(
      [
        "function isOptimisticMintingPaused() view returns (bool)",
        "function owner() view returns (address)",
      ],
      LEGACY_MAINNET_TBTC_VAULT
    )
    expect(await legacy.isOptimisticMintingPaused()).to.equal(true)

    const tbtc = await ethers.getContractAt(
      ["function owner() view returns (address)"],
      TBTC_TOKEN
    )
    expect(await tbtc.owner()).to.equal(LEGACY_MAINNET_TBTC_VAULT)
  })

  // --- Case 1 --------------------------------------------------------------
  // The per-deposit predicate against the real archived mainnet state. This
  // uses the same exported scanner the deploy suite validates headless, so it
  // is correct-by-construction on any archive endpoint.
  it("reproduces zero unswept finalized optimistic mints at the evidence block", async () => {
    const result = await scanPendingOptimisticMints(ethers.provider, {
      chainId: 1,
      legacyVault: LEGACY_MAINNET_TBTC_VAULT,
      bridge: BRIDGE_PROXY,
      coordinator: ethers.constants.AddressZero, // unused when requireLockedState is false
      successorVault: ethers.constants.AddressZero,
      snapshotBlockNumberOverride: EVIDENCE_BLOCK,
      requireLockedState: false,
    })
    expect(result.finalizedEventCount).to.equal(EXPECTED_FINALIZED_EVENTS)
    // The dangerous set P is empty: every finalized optimistic mint is swept.
    expect(result.pending.length).to.equal(0)
    // Residual per-depositor mapping debt remains, but never gates retirement.
    expect(result.residualDebtorCount).to.equal(EXPECTED_RESIDUAL_DEBTORS)
    expect(result.residualDebtTotal).to.equal(EXPECTED_RESIDUAL_DEBT_WEI)
  })

  // --- Consumed-deposit replay --------------------------------------------
  // Section 6.5 requires proving that no consumed deposit can be swept again —
  // the guarantee that underwrites "the empty dangerous-set P holds", since a
  // deposit that could be re-swept could be optimistically credited twice. This
  // replays a REAL archived mainnet sweep proof whose deposit was consumed one
  // sweep before the pinned evidence block, and asserts the second submission is
  // rejected with no state change.
  it("rejects re-sweeping an already-consumed legacy-vault deposit (no double credit)", async () => {
    const f = consumedSweepProof
    const bridge = await ethers.getContractAt(
      [
        "function deposits(uint256) view returns (tuple(address depositor,uint64 amount,uint32 revealedAt,address vault,uint64 treasuryFee,uint32 sweptAt,bytes32 extraData))",
        "function wallets(bytes20) view returns (tuple(bytes32 ecdsaWalletID,bytes32 mainUtxoHash,uint64 pendingRedemptionsValue,uint32 createdAt,uint32 movingFundsRequestedAt,uint32 closingStartedAt,uint32 pendingMovedFundsSweepRequestsCount,uint8 state,bytes32 movingFundsTargetWalletsCommitmentHash))",
        "function submitDepositSweepProof((bytes4 version,bytes inputVector,bytes outputVector,bytes4 locktime) sweepTx,(bytes merkleProof,uint256 txIndexInBlock,bytes bitcoinHeaders,bytes32 coinbasePreimage,bytes coinbaseProof) sweepProof,(bytes32 txHash,uint32 txOutputIndex,uint64 txOutputValue) mainUtxo,address vault)",
      ],
      BRIDGE_PROXY
    )
    const bank = await ethers.getContractAt(
      ["function balanceOf(address) view returns (uint256)"],
      BANK
    )

    // Pre-state at the fork block: the fixture's deposit is a legacy-vault
    // deposit that has already been swept. This is the exact condition the
    // anti-replay guards protect against.
    const before = await bridge.deposits(f.consumedDepositKey)
    expect(before.vault).to.equal(LEGACY_MAINNET_TBTC_VAULT)
    expect(before.sweptAt).to.be.gt(0)

    // Snapshot exactly the state a SUCCESSFUL sweep on this path WOULD move, so
    // the "unchanged" checks below are meaningful. At the evidence block the
    // legacy vault is still trusted, so a successful sweep would (a) credit the
    // VAULT's Bank balance via `increaseBalanceAndCall` — not the depositor's —
    // and (b) advance the sweeping wallet's main UTXO hash. (The depositor's own
    // Bank balance is NOT the right signal: on the trusted path it is never
    // credited directly.)
    const legacyVaultBankBefore = await bank.balanceOf(
      LEGACY_MAINNET_TBTC_VAULT
    )
    const walletBefore = await bridge.wallets(f.walletPubKeyHash)

    // The archived sweep was submitted through the production SPV MaintainerProxy
    // (a registered SPV maintainer), so impersonating it clears
    // `onlySpvMaintainer` and the call reaches the deposit-sweep validation
    // itself rather than reverting on authorization. The submission is rejected
    // because the wallet main UTXO this proof spends was already consumed by the
    // real sweep and has since advanced; even had a caller reconstructed the
    // current main UTXO, `processDepositSweepTxInputs` independently rejects the
    // already-swept deposit ("Deposit already swept", covered headless in the
    // deposit-sweep unit suite).
    const maintainer = await impersonate(MAINTAINER_PROXY)
    await expect(
      bridge
        .connect(maintainer)
        .submitDepositSweepProof(f.sweepTx, f.sweepProof, f.mainUtxo, f.vault)
    ).to.be.revertedWith("Invalid main UTXO data")

    // No state moved (the revert rolls the whole tx back): the deposit stays
    // swept with the same timestamp, the legacy vault received no additional
    // Bank credit, and the wallet's main UTXO hash is unchanged.
    const after = await bridge.deposits(f.consumedDepositKey)
    expect(after.sweptAt).to.equal(before.sweptAt)
    expect(await bank.balanceOf(LEGACY_MAINNET_TBTC_VAULT)).to.equal(
      legacyVaultBankBefore
    )
    expect((await bridge.wallets(f.walletPubKeyHash)).mainUtxoHash).to.equal(
      walletBefore.mainUtxoHash
    )
  })

  // --- Cases 2-5: real atomic cutover --------------------------------------
  // Deploys the patched Bridge implementation, the new BridgeGovernance, a
  // successor TBTCVault, and the coordinator; upgrades the mainnet proxy and
  // hands it the new governance; performs the Council-driven preparation and the
  // single atomic cutover; then asserts every section-6.5 post-condition.
  describe("atomic cutover", () => {
    let bridge: Contract
    let legacy: Contract
    let tbtc: Contract
    let bank: Contract
    let newGov: Contract
    let successor: Contract
    let coordinator: Contract
    let council: Signer
    // Legacy and successor Bank balances captured immediately before the atomic
    // cutover, so the post-condition test can assert the exact transferred delta
    // rather than only that the legacy balance reached zero.
    let legacyBankBefore: ethers.BigNumber
    let successorBankBefore: ethers.BigNumber

    before(async () => {
      council = await impersonate(COUNCIL_SAFE)

      bridge = await ethers.getContractAt(
        [
          "function governance() view returns (address)",
          "function isVaultTrusted(address) view returns (bool)",
          "function migrationDebtVault() view returns (address)",
          "function legacyVaultOptimisticMintingDebtCoordinator(address) view returns (address)",
        ],
        BRIDGE_PROXY
      )
      legacy = await ethers.getContractAt(
        [
          "function owner() view returns (address)",
          "function isOptimisticMintingPaused() view returns (bool)",
          "function newVault() view returns (address)",
          "function transferOwnership(address)",
        ],
        LEGACY_MAINNET_TBTC_VAULT
      )
      tbtc = await ethers.getContractAt(
        ["function owner() view returns (address)"],
        TBTC_TOKEN
      )
      bank = await ethers.getContractAt(
        ["function balanceOf(address) view returns (uint256)"],
        BANK
      )

      // 1. Fresh linked libraries + patched Bridge implementation. `Wallets` is
      //    deployed by its fully-qualified name because @keep-network/ecdsa also
      //    ships a `Wallets` library, which makes the bare artifact name
      //    ambiguous; the Bridge links against the bridge-local one.
      const libNames = [
        "Deposit",
        "DepositSweep",
        "Redemption",
        "Fraud",
        "contracts/bridge/Wallets.sol:Wallets",
        "MovingFunds",
        "VaultManagement",
      ]
      const libraries: Record<string, string> = {}
      // eslint-disable-next-line no-restricted-syntax
      for (const name of libNames) {
        // eslint-disable-next-line no-await-in-loop
        libraries[name] = (await deploy(name)).address
      }
      const bridgeImpl = await deploy("Bridge", [], { libraries })

      // 2. New BridgeGovernance, successor TBTCVault, coordinator.
      const oldGov = await ethers.getContractAt(
        [
          "function governanceDelays(uint256) view returns (uint256)",
          "function beginBridgeGovernanceTransfer(address)",
          "function finalizeBridgeGovernanceTransfer()",
        ],
        OLD_BRIDGE_GOVERNANCE
      )
      const govDelay = await oldGov.governanceDelays(0)
      // BridgeGovernance links the BridgeGovernanceParameters library (see
      // deploy/09_deploy_bridge_governance.ts).
      const bridgeGovernanceParameters = await deploy(
        "BridgeGovernanceParameters"
      )
      newGov = await deploy("BridgeGovernance", [BRIDGE_PROXY, govDelay], {
        libraries: {
          BridgeGovernanceParameters: bridgeGovernanceParameters.address,
        },
      })
      successor = await deploy("TBTCVault", [BANK, TBTC_TOKEN, BRIDGE_PROXY])
      coordinator = await deploy("LegacyTBTCVaultMigrationCoordinator", [
        newGov.address,
        LEGACY_MAINNET_TBTC_VAULT,
        BRIDGE_PROXY,
      ])

      // 3. Upgrade the Bridge proxy to the patched implementation via the
      //    ProxyAdmin, impersonating its Timelock owner.
      const proxyAdmin = await ethers.getContractAt(
        ["function upgrade(address proxy, address implementation)"],
        PROXY_ADMIN
      )
      const timelock = await impersonate(TIMELOCK)
      await proxyAdmin
        .connect(timelock)
        .upgrade(BRIDGE_PROXY, bridgeImpl.address)

      // 4. Hand Bridge governance to the new BridgeGovernance (Council-owned old
      //    BridgeGovernance begins and, after the delay, finalizes the transfer).
      await oldGov
        .connect(council)
        .beginBridgeGovernanceTransfer(newGov.address)
      await increaseTime(Number(govDelay))
      await oldGov.connect(council).finalizeBridgeGovernanceTransfer()
      expect(await bridge.governance()).to.equal(newGov.address)

      // 5. Council owns the new governance and the successor vault.
      await newGov.transferOwnership(COUNCIL_SAFE)
      await successor.transferOwnership(COUNCIL_SAFE)

      // 6. Preparation: freeze the legacy vault under the coordinator and start
      //    its 24-hour delay. It is already paused on mainnet.
      expect(await legacy.isOptimisticMintingPaused()).to.equal(true)
      await legacy.connect(council).transferOwnership(coordinator.address)
      expect(await coordinator.migrationLocked()).to.equal(true)
      const govAsCouncil = await ethers.getContractAt(
        [
          "function initiateLegacyVaultUpgrade(address coordinator, address successorVault)",
          "function finalizeLegacyVaultMigration(address coordinator, uint256 snapshotBlockNumber, bytes32 snapshotBlockHash, bytes32 evidenceHash)",
        ],
        newGov.address
      )
      await govAsCouncil
        .connect(council)
        .initiateLegacyVaultUpgrade(coordinator.address, successor.address)
      expect(await legacy.newVault()).to.equal(successor.address)

      // 7. Wait out the 24h delay (plus a buffer), then mine past the finality
      //    window so the freeze is finalized. Run the pinned scan with
      //    requireLockedState:true so it exercises the PRODUCTION cutover
      //    assertions — paused, coordinator-owned, migration-locked, matching
      //    successor, and 24h elapsed — at a finalized POST-FREEZE snapshot, not
      //    the informational pre-freeze read the earlier draft used.
      await increaseTime(DELAY_24H + 3600)
      await hre.network.provider.send("hardhat_mine", ["0x1"])
      const freezeSnapshotBlock = await ethers.provider.getBlockNumber()
      // Advance SNAPSHOT_CONFIRMATIONS (64) blocks so freezeSnapshotBlock sits at
      // the scanner's finality boundary (latest - 64). Real blocks (not a
      // reserved range) so the post-freeze historical scan restores cleanly.
      await mineRealBlocks(SNAPSHOT_CONFIRMATIONS)
      const scan = await scanPendingOptimisticMints(ethers.provider, {
        chainId: 1,
        legacyVault: LEGACY_MAINNET_TBTC_VAULT,
        bridge: BRIDGE_PROXY,
        coordinator: coordinator.address,
        successorVault: successor.address,
        snapshotBlockNumberOverride: freezeSnapshotBlock,
        requireLockedState: true,
      })
      expect(scan.pending.length).to.equal(0)

      // Snapshot the Bank balances the cutover is expected to move: the entire
      // legacy vault balance must land on the successor. Captured here, one step
      // before finalization, so the post-condition test asserts the exact delta.
      legacyBankBefore = await bank.balanceOf(LEGACY_MAINNET_TBTC_VAULT)
      successorBankBefore = await bank.balanceOf(successor.address)
      // The delta assertion is only non-vacuous if the legacy vault actually held
      // a balance to move; at the pinned evidence block it does. Fail loudly on a
      // zero-balance fork rather than letting `0 == 0` pass silently.
      expect(legacyBankBefore).to.be.gt(0)

      await govAsCouncil
        .connect(council)
        .finalizeLegacyVaultMigration(
          coordinator.address,
          scan.snapshotBlockNumber,
          scan.snapshotBlockHash,
          scan.evidenceHash
        )
    })

    it("completes the atomic cutover while impersonating the Council", async () => {
      expect(await coordinator.finalized()).to.equal(true)
      expect(
        await bridge.legacyVaultOptimisticMintingDebtCoordinator(
          LEGACY_MAINNET_TBTC_VAULT
        )
      ).to.equal(coordinator.address)
    })

    it("moves TBTC ownership and the entire legacy Bank balance to the successor", async () => {
      expect(await tbtc.owner()).to.equal(successor.address)

      // The legacy vault is drained to exactly zero...
      expect(await bank.balanceOf(LEGACY_MAINNET_TBTC_VAULT)).to.equal(0)

      // ...and the successor's balance grew by precisely the legacy balance that
      // existed immediately before cutover. Asserting the exact delta (not just
      // "legacy is zero") proves the funds landed on the successor and nowhere
      // else, which is the section-6.5 "entire legacy Bank balance moved" bound.
      const successorBankAfter = await bank.balanceOf(successor.address)
      expect(successorBankAfter.sub(successorBankBefore)).to.equal(
        legacyBankBefore
      )
    })

    it("leaves the legacy vault untrusted, paused, coordinator-owned, and non-re-trustable", async () => {
      expect(await bridge.isVaultTrusted(LEGACY_MAINNET_TBTC_VAULT)).to.equal(
        false
      )
      expect(await legacy.isOptimisticMintingPaused()).to.equal(true)
      expect(await legacy.owner()).to.equal(coordinator.address)
      // Re-trusting the retired vault must revert (attestation still recorded).
      const govAsCouncil = await ethers.getContractAt(
        ["function setVaultStatus(address vault, bool isTrusted)"],
        newGov.address
      )
      await expect(
        govAsCouncil
          .connect(council)
          .setVaultStatus(LEGACY_MAINNET_TBTC_VAULT, true)
      ).to.be.reverted
    })

    // --- Case 6: the two original bad branches, in isolation -----------------
    // Both danger branches the remediation prevents, executed against the REAL
    // forked Bank + legacy vault + TBTC token by impersonating the Bridge (the
    // Bank's sole authorized caller). A full end-to-end reproduction would also
    // craft a BTC sweep proof; the load-bearing conditions — untrusted routing
    // skips optimistic-debt repayment, and a dead legacy vault bricks the mint
    // callback — are what these drive directly. The same mechanics are proven
    // HEADLESS (actually executed in CI) in the SweepBranches suite.
    it("keeps residual mapping debt nonzero and shows the untrusted-vault sweep credits value without repaying it", async () => {
      // The successor is trusted and canonical; residual per-depositor debt on
      // the retired legacy vault is abandoned but stays recorded.
      expect(await bridge.isVaultTrusted(successor.address)).to.equal(true)
      expect(await bridge.migrationDebtVault()).to.equal(successor.address)
      const KNOWN_RESIDUAL_DEBTOR = "0x1D50D75933b7b7C8AD94dbfb748B5756E3889C24"
      const legacyDebt = await ethers.getContractAt(
        ["function optimisticMintingDebt(address) view returns (uint256)"],
        LEGACY_MAINNET_TBTC_VAULT
      )
      const debtBefore = await legacyDebt.optimisticMintingDebt(
        KNOWN_RESIDUAL_DEBTOR
      )
      expect(debtBefore).to.be.gt(0)

      // Untrusted-double-mint branch: a sweep routed for an untrusted vault takes
      // `Bank.increaseBalances` (no vault callback), so no optimistic-minting
      // debt is repaid. Drive exactly that branch for a depositor who still
      // carries optimistic-minting debt: the credit lands while the debt is
      // untouched — the second realization the empty-P invariant (case 1)
      // prevents from ever reaching an unswept deposit.
      const bankWrite = await ethers.getContractAt(
        [
          "function balanceOf(address) view returns (uint256)",
          "function increaseBalances(address[] recipients, uint256[] amounts)",
        ],
        BANK
      )
      const bridgeSigner = await impersonate(BRIDGE_PROXY)
      const credited = ethers.BigNumber.from("1000")
      const bankBefore = await bankWrite.balanceOf(KNOWN_RESIDUAL_DEBTOR)
      await bankWrite
        .connect(bridgeSigner)
        .increaseBalances([KNOWN_RESIDUAL_DEBTOR], [credited])
      expect(await bankWrite.balanceOf(KNOWN_RESIDUAL_DEBTOR)).to.equal(
        bankBefore.add(credited)
      )
      // Debt unchanged: the untrusted path never repaid it.
      expect(
        await legacyDebt.optimisticMintingDebt(KNOWN_RESIDUAL_DEBTOR)
      ).to.equal(debtBefore)
    })

    it("bricks the sweep callback because the retired legacy vault no longer owns TBTC", async () => {
      // Callback-brick branch: after cutover moved TBTC ownership to the
      // successor, routing a sweep to the legacy vault through
      // `Bank.increaseBalanceAndCall` invokes its `receiveBalanceIncrease`, whose
      // owner-gated TBTC `mint` now reverts — reverting the whole proof tx (funds
      // not swept). This is why a dead legacy vault must be UNTRUSTED, not left
      // trusted.
      expect(await tbtc.owner()).to.equal(successor.address)
      const bankCall = await ethers.getContractAt(
        [
          "function increaseBalanceAndCall(address vault, address[] recipients, uint256[] amounts)",
        ],
        BANK
      )
      const bridgeSigner = await impersonate(BRIDGE_PROXY)
      const strangerDepositor = (await ethers.getSigners())[3].address
      await expect(
        bankCall
          .connect(bridgeSigner)
          .increaseBalanceAndCall(
            LEGACY_MAINNET_TBTC_VAULT,
            [strangerDepositor],
            [1000]
          )
      ).to.be.reverted
    })
  })
})
