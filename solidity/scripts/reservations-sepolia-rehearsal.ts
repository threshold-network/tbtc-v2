/*
 * UTXO-reservations deploy for Sepolia, from
 * docs/RESERVATION_SEPOLIA_DEPLOYMENT.md. One script, two modes.
 *
 * Phases (runbook step numbers):
 *   PHASE=prepare   steps 1-6 and 10: deploy the vault, libraries, Bridge
 *                   implementation, router and new governance; upgrade the
 *                   proxy; swap governance; set the router; stage and
 *                   finalize caps and parameters; fee reserve 0. Then it
 *                   stops and prints the addresses keep-core needs.
 *                   Resumable: every step is checked against the chain and
 *                   skipped when already done.
 *   PHASE=activate ACTIVATION_BLOCK=<B>
 *                   steps 11-12: refuses to run if the current block is
 *                   below B or anything staged differs from the runbook,
 *                   then setVaultStatus and the post-activation checks.
 *                   Deployed addresses come from the prepare artifact.
 *
 * Mode follows the hardhat network:
 *   --network hardhat (fork of Sepolia, FORKING_URL + pinned FORKING_BLOCK):
 *     impersonates the deployer EOA, advances the clock with evm_*, mines
 *     to B. With no PHASE it runs both phases and logs the off-chain steps
 *     (npm publish, keep-core build) as SKIP.
 *   any other network (--network sepolia: CHAIN_API_URL +
 *     ACCOUNTS_PRIVATE_KEYS; or a local node): the signer is
 *     (await ethers.getSigners())[0] and must be the deployer EOA, else it
 *     aborts before any transaction. No hardhat_* or evm_* calls;
 *     governance delays are waited out in real time. PHASE is required.
 *
 * Fork run (from solidity/):
 *   FORKING_URL="$SEPOLIA_RPC_URL" FORKING_BLOCK=<pinned block> \
 *     npx hardhat run --network hardhat scripts/reservations-sepolia-rehearsal.ts
 * Live run:
 *   export CHAIN_API_URL="$SEPOLIA_RPC_URL"
 *   export ACCOUNTS_PRIVATE_KEYS="$SEPOLIA_PRIVATE_KEY"
 *   PHASE=prepare npx hardhat run --network sepolia scripts/reservations-sepolia-rehearsal.ts
 *   PHASE=activate ACTIVATION_BLOCK=<B> npx hardhat run --network sepolia scripts/reservations-sepolia-rehearsal.ts
 *
 * Values are the runbook's Sepolia values (caps 2000000/2000000/2/1, min
 * 10000, tx max fee 1000, term 7776000, dissolution 86400, max total
 * 4000000, max per wallet 1, action timeout 86400, renewal 86400) and are
 * checked against the live depositParameters before anything is staged.
 *
 * Artifacts in dryrun-artifacts/ (schemaVersion 2, written atomically):
 *   fork:     reservations-sepolia-rehearsal-<fork block>.json
 *   live:     reservations-sepolia-rehearsal-<network>-<start block>.json
 *   activate: reservations-sepolia-activation-<network>-<start block>.json
 *
 * Each artifact carries a `binding` block that ties it to the provider
 * chain id and the exact Bridge proxy address it was produced against.
 * On load we (a) parse the schema, (b) reject malformed/mismatched live
 * artifacts (no silent redeploy), (c) verify the binding against the
 * current provider and deployed Bridge before any send. Old JSON without
 * `binding` is rejected; the human regenerates by deleting the file and
 * re-running the matching PHASE. Writes are atomic (temp file + rename)
 * so an interrupted save leaves the old valid file in place, never a
 * half-written one.
 *
 * Network/chain gate (rejects before any signer/transaction):
 *   live + network "sepolia":  requires provider chain 11155111
 *   live + network "rehearsal": requires provider chain 31337 (local node,
 *                              REHEARSAL_UNLOCKED_DEPLOYER=1 unlocks the
 *                              deployer on the rehearsal node)
 *   any other live network:    rejected
 *   fork + network "hardhat":  in-memory hardhat fork with chain 31337
 *   any other network:         rejected
 */
import fs from "fs"
import path from "path"
import { ethers, artifacts, network } from "hardhat"
import {
  Contract,
  ContractFactory,
  Signer,
  TransactionReceipt,
  ContractTransactionResponse,
  ethers as eth,
} from "ethers"

import { assertReservedDepositsFeasible } from "../deploy/98_generate_reservation_mainnet_calldata"
import {
  SEPOLIA_CHAIN_ID,
  REHEARSAL_CHAIN_ID,
  prepareArtifactFilename,
  selectPrepareArtifact,
  bindingPreflight,
  bindingMismatch,
  chainPreflight,
  writePrepareArtifact,
  isAddressOrAbsent,
  type ParsedPrepareArtifact,
  type SelectionResult,
  type ExecContext,
} from "./prepare-artifact-guard"

// Pinned fork block: latest Sepolia block read via SEPOLIA_RPC_URL on
// 2026-10-10 was 11883878; pin to latest - 20 for a reproducible state.
// Pass FORKING_BLOCK=11883858 so hardhat.config.ts pins the fork here.
const FORKING_BLOCK = 11883858

// Activation block B rehearsed: current fork block plus one hour of
// Sepolia blocks (~720 at ~5 s/block), well after the 60-second
// governance windows. The real ceremony picks B at release time (runbook
// step 8); the rehearsal only proves the mine-to-B + activate path.
const ACTIVATION_BLOCK_OFFSET = 720

// Live Sepolia addresses (docs/RESERVATION_SEPOLIA_DEPLOYMENT.md,
// "Verified live state", read 2026-10-10 against SEPOLIA_RPC_URL).
const KNOWN_OLD_IMPL = "0xc9CEec54a8b25D7051B702322675ee3014bA4685"
const KNOWN_PROXY_ADMIN = "0x0E9bD483CC8Fb649636e0cd7a60BC48b6C040103"
// The Sepolia deployer EOA owns both the ProxyAdmin and the live
// BridgeGovernance; every ceremony actor in this rehearsal is this one
// address (on Sepolia all named accounts map to it).
const KNOWN_DEPLOYER = "0xb9B8a92677fcad86dc8d36fe947184283B03b3C8"
// The runbook's "governance" named account is index 0 of
// ACCOUNTS_PRIVATE_KEYS on Sepolia, i.e. the same deployer EOA.
const GOVERNANCE_DELAY_SECONDS = 60

// EIP-1967 admin slot (TransparentProxy), used to discover the ProxyAdmin.
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
// EIP-1967 implementation slot.
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

// Absolute Bridge storage slots (OpenZeppelin 4.8.1 bases: Governable slots
// 0-49, OZ Initializable slot 50, then the BridgeState struct from slot 51).
const SLOTS = {
  governance: 0,
  initialized: 50,
  ecdsaWalletRegistry: 53,
  depositParameters: 57,
  liveWalletsCount: 68,
  rebateStaking: 80,
  reservationVault: 81,
  reservationRouter: 83,
} as const

// Minimal ABI fragments present on BOTH the old live implementation and
// the new implementation, for before/after state comparison without ABI
// drift.
const OLD_BRIDGE_FRAGMENTS = [
  "function activeWalletPubKeyHash() view returns (bytes20)",
  "function depositParameters() view returns (uint64, uint64, uint64, uint32)",
  "function liveWalletsCount() view returns (uint32)",
  "function wallets(bytes20) view returns (tuple(bytes32 ecdsaWalletID, bytes32 mainUtxoHash, uint64 pendingRedemptionsValue, uint32 createdAt, uint32 movingFundsRequestedAt, uint32 closingStartedAt, uint32 pendingMovedFundsSweepRequestsCount, uint8 state, bytes32 movingFundsTargetWalletsCommitmentHash))",
]

// Standalone external libraries (none links another), deployed before the
// implementation contracts that consume them. Qualified with their source
// file so the name is unambiguous against external packages.
const LIBS: { name: string; artifact: string }[] = [
  { name: "EcdsaLib", artifact: "contracts/bridge/EcdsaLib.sol:EcdsaLib" },
  { name: "Deposit", artifact: "contracts/bridge/Deposit.sol:Deposit" },
  {
    name: "DepositSweep",
    artifact: "contracts/bridge/DepositSweep.sol:DepositSweep",
  },
  { name: "Fraud", artifact: "contracts/bridge/Fraud.sol:Fraud" },
  {
    name: "MovingFunds",
    artifact: "contracts/bridge/MovingFunds.sol:MovingFunds",
  },
  {
    name: "Redemption",
    artifact: "contracts/bridge/Redemption.sol:Redemption",
  },
  {
    name: "Wallets",
    artifact: "contracts/bridge/Wallets.sol:Wallets",
  },
  {
    name: "Reservation",
    artifact: "contracts/bridge/Reservation.sol:Reservation",
  },
  {
    name: "ReservationProofs",
    artifact: "contracts/bridge/ReservationProofs.sol:ReservationProofs",
  },
  {
    name: "BridgeGovernanceParameters",
    artifact:
      "contracts/bridge/BridgeGovernanceParameters.sol:BridgeGovernanceParameters",
  },
]

// Consumer contracts that link the libraries above (per the compiled
// artifacts' linkReferences).
const BRIDGE_ARTIFACT = "contracts/bridge/Bridge.sol:Bridge"
const ROUTER_ARTIFACT =
  "contracts/bridge/ReservationRouter.sol:ReservationRouter"
const GOV_ARTIFACT = "contracts/bridge/BridgeGovernance.sol:BridgeGovernance"
const VAULT_ARTIFACT = "contracts/vault/ReservationVault.sol:ReservationVault"

// The runbook's Sepolia values (docs/RESERVATION_SEPOLIA_DEPLOYMENT.md
// pre-flight check 1, sized 2026-10-10 against the live deposit
// parameters). maxActive stays 2 below the 4 Live wallet slots so that
// retiring wallets can hand off their anchors.
const SEPOLIA_VALUES = {
  perWalletCap: 2_000_000n,
  singleAmountCap: 2_000_000n,
  maxActive: 2,
  maxThirdPartyReanchorHolds: 1,
  minAmount: 10_000n,
  txMaxFee: 1_000n,
  termSeconds: 7_776_000,
  dissolutionDelay: 86_400,
  maxTotalAmount: 4_000_000n,
  maxReservationsPerWallet: 1,
  actionTimeout: 86_400,
  renewalWindowSeconds: 86_400,
  feeReserveTarget: 0, // recorded decision: zero reserve on Sepolia
} as const

interface Step {
  name: string
  status: "PASS" | "FAIL" | "SKIP"
  txHash?: string
  gasUsed?: number | null
  values?: Record<string, unknown>
  error?: string
}

interface RunState {
  steps: Step[]
  bridge: string
  oldGov: string
  proxyAdmin: string
  deployer: string
  oldImpl: string
  newImpl: string
  router: string
  vault: string
  newGov: string
  bank: string
  tbtcVault: string
  activationBlock: number
  live: boolean
  phase: string
  networkName: string
  startBlock: number
  chainId: number
  libs?: Record<string, string>
  snapshotBefore?: Record<string, string>
  snapshotAfter?: Record<string, string>
}

function record(state: RunState, step: Step): void {
  state.steps.push(step)
  const mark =
    step.status === "PASS"
      ? "PASS"
      : step.status === "FAIL"
        ? "FAIL (!)"
        : "SKIP"
  console.log(
    `  [${mark}] ${step.name}` +
      (step.txHash
        ? ` tx=${step.txHash.slice(0, 18)}… gas=${step.gasUsed}`
        : "") +
      (step.error ? `\n          ${String(step.error).slice(0, 400)}` : "")
  )
}

/**
 * This hardhat-ethers build returns receipts keyed by `hash` rather than
 * the standard `transactionHash`, so read whichever field is present.
 */
function txHashOf(receipt: {
  transactionHash?: string
  hash?: string
}): string | undefined {
  return receipt.transactionHash ?? receipt.hash
}

function readSepoliaDeploymentAddress(file: string): string {
  const p = path.join(__dirname, "..", "deployments", "sepolia", file)
  const json = JSON.parse(fs.readFileSync(p, "utf8"))
  if (!json.address || json.address.startsWith("0x0")) {
    throw new Error(`No usable address in deployments/sepolia/${file}`)
  }
  return json.address
}

/**
 * Deploys an implementation contract whose external libraries are already
 * linked in, without going through hardhat-deploy so no deployment cache
 * is written. `libAddresses` maps plain library name -> deployed address;
 * the consumer artifact's own `linkReferences` select the subset it
 * actually needs.
 */
async function deployLinked(
  artifactName: string,
  signer: Signer,
  libAddresses: Record<string, string>,
  args: unknown[] = []
): Promise<{ contract: Contract; receipt: TransactionReceipt }> {
  const artifact = await artifacts.readArtifact(artifactName)
  // Manual library linking. This ethers build (v6.17) does not export the
  // `Linker` helper, so patch the creation-code link placeholders directly
  // using the solc `linkReferences` (byte offsets of the 20-byte address
  // slots) from `artifact.linkReferences`.
  let linkedContent = artifact.bytecode.slice(2) // strip 0x
  for (const libs of Object.values(artifact.linkReferences)) {
    for (const [libName, refs] of Object.entries(libs)) {
      const addr = libAddresses[libName]
      if (!addr) continue
      const hexAddr = addr.toLowerCase().replace(/^0x/, "")
      for (const ref of refs) {
        const s = ref.start * 2
        const e = s + ref.length * 2
        linkedContent =
          linkedContent.slice(0, s) + hexAddr + linkedContent.slice(e)
      }
    }
  }
  const linked = "0x" + linkedContent
  const factory = new ContractFactory(artifact.abi, linked, signer)
  const contract = await factory.deploy(...(args as []))
  await contract.waitForDeployment()
  const pending = await contract.deploymentTransaction()
  if (pending === undefined) {
    throw new Error(`No deployment receipt for ${artifactName}`)
  }
  const receipt = await pending.wait()
  return { contract, receipt }
}

async function advanceTime(seconds: number): Promise<void> {
  await network.provider.send("evm_increaseTime", [seconds])
  await network.provider.send("evm_mine", [])
}

/**
 * Snapshot of Bridge on-chain state for the preservation check: stable view
 * results plus raw absolute slots whose values must not move during a
 * plain upgrade().
 */
async function snapshotBridge(
  state: RunState
): Promise<Record<string, string>> {
  const oldBridge = await ethers.getContractAt(
    OLD_BRIDGE_FRAGMENTS,
    state.bridge
  )
  const pk = (await oldBridge.activeWalletPubKeyHash()) as string
  const wallet = await oldBridge.wallets(pk)
  const depositParameters = await oldBridge.depositParameters()
  const liveWalletsCount = await oldBridge.liveWalletsCount()
  const out: Record<string, string> = {
    knownPk: pk,
    knownWallet: `${wallet.ecdsaWalletID}|${wallet.mainUtxoHash}|${wallet.state}`,
    liveWalletsCount: liveWalletsCount.toString(),
    depositParameters: depositParameters.map(String).join(","),
  }
  for (const field of [
    "governance",
    "initialized",
    "ecdsaWalletRegistry",
    "rebateStaking",
    "reservationVault",
    "reservationRouter",
  ] as const) {
    out[field] = await ethers.provider.getStorage(state.bridge, SLOTS[field])
  }
  return out
}

async function mineToBlock(blockNumber: number): Promise<void> {
  let current = (await ethers.provider.getBlock("latest")).number
  while (current < blockNumber) {
    await network.provider.send("evm_mine", [])
    current += 1
  }
}
const V = SEPOLIA_VALUES

function artifactDir(): string {
  return path.join(__dirname, "..", "dryrun-artifacts")
}

function artifactFile(state: RunState): string {
  const kind = state.phase === "activate" ? "activation" : "rehearsal"
  const base = state.live
    ? `${state.networkName}-${state.startBlock}`
    : `${FORKING_BLOCK}`
  return path.join(artifactDir(), `reservations-sepolia-${kind}-${base}.json`)
}

/**
 * Returns true when the artifact's binding metadata is complete enough to
 * write a schema-valid file. For live runs the chain id and Bridge
 * address must be known; for fork runs the binding is always complete.
 * The address fields must be either null or valid checksummed addresses —
 * initial state uses empty strings, which are not valid.
 */
function bindingComplete(state: RunState): boolean {
  if (!state.live) {
    if (state.bridge !== "" && !isAddressOrAbsent(state.bridge)) return false
  } else {
    if (state.chainId === 0 || state.bridge === "") return false
  }
  for (const key of [
    "bridge",
    "oldGov",
    "oldImpl",
    "newImpl",
    "newGov",
    "router",
    "vault",
    "proxyAdmin",
    "deployer",
  ]) {
    const v = (state as unknown as Record<string, unknown>)[key]
    if (v !== null && v !== undefined && v !== "" && !isAddressOrAbsent(v)) return false
  }
  return true
}

function loadPrepareArtifact(state: RunState): SelectionResult {
  const ctx: ExecContext = {
    live: state.live,
    networkName: state.networkName,
    chainId: state.chainId,
    forkBlock: FORKING_BLOCK,
    bridge: "",
  }
  return selectPrepareArtifact(artifactDir(), ctx, {
    requireComplete: state.phase === "activate",
  })
}

function saveArtifact(state: RunState): void {
  if (!bindingComplete(state)) {
    // Don't persist an artifact without a complete binding; the next run
    // would reject the set as malformed. The chain remains the source of
    // truth until readState succeeds and assigns the Bridge address.
    return
  }
  fs.mkdirSync(artifactDir(), { recursive: true })
  const failures = state.steps.filter((s) => s.status === "FAIL")
  const artifact = {
    mode: state.live ? "live" : "fork",
    network: state.networkName,
    phase: state.phase || "full",
    startBlock: state.startBlock,
    forkBlock: state.live ? null : FORKING_BLOCK,
    activationBlock: state.activationBlock,
    runAt: new Date().toISOString(),
    binding: {
      chainId: state.live ? state.chainId : null,
      bridge: state.live ? state.bridge : null,
      forkBlock: state.live ? null : FORKING_BLOCK,
    },
    addresses: {
      bridge: state.bridge,
      oldGov: state.oldGov,
      oldImpl: state.oldImpl || null,
      newImpl: state.newImpl || null,
      newGov: state.newGov || null,
      router: state.router || null,
      vault: state.vault || null,
      proxyAdmin: state.proxyAdmin || null,
      deployer: state.deployer,
    },
    summary: {
      total: state.steps.length,
      pass: state.steps.filter((s) => s.status === "PASS").length,
      fail: failures.length,
      skip: state.steps.filter((s) => s.status === "SKIP").length,
    },
    steps: state.steps,
  }
  writePrepareArtifact(artifactFile(state), artifact, {
    summary: artifact.summary,
    steps: artifact.steps,
  })
}

function finish(state: RunState): void {
  saveArtifact(state)
  const failed = state.steps.filter((s) => s.status === "FAIL")
  console.log(`\nArtifact written to ${artifactFile(state)}`)
  console.log(
    `Summary: ${state.steps.filter((s) => s.status === "PASS").length} pass / ` +
      `${failed.length} fail / ${state.steps.filter((s) => s.status === "SKIP").length} skip`
  )
  for (const f of failed) {
    console.log(`  - ${f.name}: ${String(f.error).slice(0, 300)}`)
  }
  if (failed.length > 0) process.exitCode = 1
}

// Records a step and persists the artifact, so a killed run leaves a
// resumable partial artifact behind.
function done(state: RunState, step: Step): void {
  record(state, step)
  saveArtifact(state)
}

function skip(state: RunState, name: string, reason: string): void {
  done(state, { name, status: "SKIP", values: { reason } })
}

async function sendStep(
  state: RunState,
  name: string,
  send: () => Promise<ContractTransactionResponse>,
  values?: Record<string, unknown>
): Promise<TransactionReceipt> {
  const receipt = await (await send()).wait()
  if (receipt === null) throw new Error(`${name}: no receipt`)
  done(state, {
    name,
    status: "PASS",
    txHash: txHashOf(receipt),
    gasUsed: Number(receipt.gasUsed),
    values,
  })
  return receipt
}

// Fork: jump the clock. Live: wait out the delay in real time by polling
// the chain timestamp (no evm_* calls).
async function waitDelay(
  state: RunState,
  beginBlock: number,
  seconds: number
): Promise<void> {
  if (!state.live) {
    await advanceTime(seconds)
    return
  }
  const begin = (await ethers.provider.getBlock(beginBlock)).timestamp
  for (;;) {
    const now = (await ethers.provider.getBlock("latest")).timestamp
    if (now >= begin + seconds) return
    console.log(
      `    waiting for governance delay: chain time ${now}/${begin + seconds}`
    )
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 5000)
    await promise
  }
}

async function hasCode(addr?: string | null): Promise<boolean> {
  return !!addr && (await ethers.provider.getCode(addr)) !== "0x"
}

async function slotAddress(state: RunState, slot: string | number) {
  const raw = await ethers.provider.getStorage(state.bridge, slot)
  return eth.getAddress(`0x${raw.slice(26)}`)
}

async function routerView(state: RunState, name: string): Promise<eth.Result> {
  const abi = (await artifacts.readArtifact(ROUTER_ARTIFACT)).abi
  const iface = new eth.Interface(abi)
  const data = iface.encodeFunctionData(name, [])
  const res = await ethers.provider.call({ to: state.bridge, data })
  return iface.decodeFunctionResult(name, res)
}

async function capsApplied(state: RunState): Promise<boolean> {
  try {
    const r = await routerView(state, "reservationCaps")
    return (
      r[0] === V.perWalletCap &&
      r[1] === V.singleAmountCap &&
      Number(r[2]) === V.maxActive &&
      Number(r[3]) === V.maxThirdPartyReanchorHolds
    )
  } catch {
    return false
  }
}

async function paramsApplied(state: RunState): Promise<boolean> {
  try {
    const r = await routerView(state, "reservationParameters")
    return (
      r[0].toLowerCase() === state.vault.toLowerCase() &&
      r[1] === V.minAmount &&
      r[2] === V.txMaxFee &&
      Number(r[3]) === V.termSeconds &&
      Number(r[4]) === V.dissolutionDelay &&
      r[5] === V.maxTotalAmount &&
      Number(r[7]) === V.maxReservationsPerWallet &&
      Number(r[8]) === V.actionTimeout &&
      Number(r[9]) === V.renewalWindowSeconds
    )
  } catch {
    return false
  }
}

async function routerWired(state: RunState): Promise<boolean> {
  try {
    const bridge = await ethers.getContractAt(BRIDGE_ARTIFACT, state.bridge)
    const addr = await bridge.getReservationRouter()
    return addr.toLowerCase() === state.router.toLowerCase()
  } catch {
    return false
  }
}

// Step 0 of the runbook: read and check live state. `allowedImpls` lists the
// implementations the proxy may point to (old one, or the new one when
// resuming/activating).
async function readState(
  state: RunState,
  allowedImpls: (string | null | undefined)[]
): Promise<boolean> {
  console.log("\n=== Step 0: read Sepolia state ===")
  try {
    state.bridge = readSepoliaDeploymentAddress("Bridge.json")
    state.oldGov = readSepoliaDeploymentAddress("BridgeGovernance.json")
    state.bank = readSepoliaDeploymentAddress("Bank.json")
    state.tbtcVault = readSepoliaDeploymentAddress("TBTCVault.json")
    state.proxyAdmin = await slotAddress(state, EIP1967_ADMIN_SLOT)
    if (state.proxyAdmin.toLowerCase() !== KNOWN_PROXY_ADMIN.toLowerCase()) {
      throw new Error(
        `ProxyAdmin ${state.proxyAdmin} != runbook ${KNOWN_PROXY_ADMIN}`
      )
    }
    const impl = await slotAddress(state, EIP1967_IMPL_SLOT)
    if (
      !allowedImpls.some((a) => a && a.toLowerCase() === impl.toLowerCase())
    ) {
      throw new Error(
        `Bridge implementation ${impl} is not one of ${allowedImpls.join(", ")}`
      )
    }
    state.oldImpl = KNOWN_OLD_IMPL
    const owner = async (addr: string) =>
      (await (
        await ethers.getContractAt(
          ["function owner() view returns (address)"],
          addr
        )
      ).owner()) as string
    const adminOwner = await owner(state.proxyAdmin)
    const govOwner = await owner(state.oldGov)
    for (const [what, o] of [
      ["ProxyAdmin", adminOwner],
      ["BridgeGovernance", govOwner],
    ]) {
      if (o.toLowerCase() !== KNOWN_DEPLOYER.toLowerCase()) {
        throw new Error(`${what} owner ${o} != deployer EOA ${KNOWN_DEPLOYER}`)
      }
    }
    const oldGov = await ethers.getContractAt(
      ["function governanceDelays(uint256) view returns (uint256)"],
      state.oldGov
    )
    const delay = await oldGov.governanceDelays(0)
    if (delay !== BigInt(GOVERNANCE_DELAY_SECONDS)) {
      throw new Error(
        `Live governance delay ${delay}s != runbook ${GOVERNANCE_DELAY_SECONDS}s`
      )
    }
    state.snapshotBefore = await snapshotBridge(state)
    done(state, {
      name: "00-read-sepolia-state",
      status: "PASS",
      values: {
        bridge: state.bridge,
        oldGov: state.oldGov,
        implementation: impl,
        proxyAdmin: state.proxyAdmin,
        governanceDelay: delay.toString(),
        liveWalletsCount: state.snapshotBefore["liveWalletsCount"],
        depositParameters: state.snapshotBefore["depositParameters"],
      },
    })
    return true
  } catch (e) {
    done(state, {
      name: "00-read-sepolia-state",
      status: "FAIL",
      error: String(e),
    })
    return false
  }
}

async function getSigner(state: RunState): Promise<Signer | null> {
  if (!state.live) {
    await network.provider.send("hardhat_impersonateAccount", [state.deployer])
    await network.provider.send("hardhat_setBalance", [
      state.deployer,
      "0x8AC7230489E80000",
    ])
    done(state, {
      name: "01-impersonate-deployer",
      status: "PASS",
      values: { deployer: state.deployer },
    })
    return ethers.getSigner(state.deployer)
  }
  // Rehearsal-only: on the local `rehearsal` node the deployer EOA has no
  // key here, so the one-off RPC setup unlocks it on the node and it signs
  // through the node. Limited to the `rehearsal` network and chain 31337;
  // never applies to any other network.
  if (
    network.name === "rehearsal" &&
    state.chainId === REHEARSAL_CHAIN_ID &&
    process.env.REHEARSAL_UNLOCKED_DEPLOYER === "1"
  ) {
    done(state, {
      name: "01-live-signer-check",
      status: "PASS",
      values: {
        signer: KNOWN_DEPLOYER,
        note: "rehearsal node: deployer unlocked via one-off RPC setup",
      },
    })
    return ethers.provider.getSigner(KNOWN_DEPLOYER)
  }
  const signer = (await ethers.getSigners())[0]
  if (
    !signer ||
    signer.address.toLowerCase() !== KNOWN_DEPLOYER.toLowerCase()
  ) {
    done(state, {
      name: "01-live-signer-check",
      status: "FAIL",
      error:
        `signer[0] is ${signer ? signer.address : "missing"}, expected the deployer EOA ` +
        `${KNOWN_DEPLOYER} (set ACCOUNTS_PRIVATE_KEYS to its key); no transaction was sent`,
    })
    return null
  }
  done(state, {
    name: "01-live-signer-check",
    status: "PASS",
    values: { signer: signer.address },
  })
  return signer
}

// Runbook steps 1-6 and 10. Every step is checked against the chain first
// and skipped when the chain already shows it done, so a rerun after a
// failure resumes where it stopped.
async function prepare(
  state: RunState,
  signer: Signer,
  prev: Record<string, string | null>
): Promise<boolean> {
  console.log("\n=== Prepare: runbook steps 1-6 and 10 ===")
  const gov = KNOWN_DEPLOYER
  try {
    const have = {
      impl: await hasCode(prev.newImpl),
      router: await hasCode(prev.router),
      vault: await hasCode(prev.vault),
      gov: await hasCode(prev.newGov),
    }
    if (have.impl && have.router && have.vault && have.gov) {
      skip(
        state,
        "02a-deploy-shared-libraries",
        "all consumers already deployed (verified on-chain)"
      )
    } else {
      const libs: Record<string, string> = {}
      for (const { name, artifact } of LIBS) {
        libs[name] = (await deployLinked(artifact, signer, {})).contract.target
      }
      state.libs = libs
      done(state, {
        name: "02a-deploy-shared-libraries",
        status: "PASS",
        values: libs,
      })
    }
    const libs = state.libs ?? {}
    const deploy = async (
      key: "newImpl" | "router" | "vault" | "newGov",
      exists: boolean,
      name: string,
      artifact: string,
      args: unknown[]
    ) => {
      if (exists) {
        state[key] = prev[key] as string
        skip(
          state,
          name,
          `already deployed at ${prev[key]} (code verified on-chain)`
        )
        return
      }
      const d = await deployLinked(artifact, signer, libs, args)
      state[key] = d.contract.target
      done(state, {
        name,
        status: "PASS",
        txHash: txHashOf(d.receipt),
        gasUsed: Number(d.receipt.gasUsed),
        values: { address: d.contract.target },
      })
    }
    await deploy(
      "newImpl",
      have.impl,
      "02b-deploy-bridge-implementation",
      BRIDGE_ARTIFACT,
      []
    )
    await deploy(
      "router",
      have.router,
      "02c-deploy-reservation-router",
      ROUTER_ARTIFACT,
      []
    )
    await deploy(
      "vault",
      have.vault,
      "02d-deploy-reservation-vault",
      VAULT_ARTIFACT,
      [state.bank, state.tbtcVault, state.bridge]
    )
    const vault = (
      await ethers.getContractAt(VAULT_ARTIFACT, state.vault)
    ).connect(signer) as Contract
    if (have.vault) {
      skip(
        state,
        "02e-transfer-reservation-vault-ownership-to-governance",
        "vault already deployed; owner verified on-chain"
      )
    } else {
      await sendStep(
        state,
        "02e-transfer-reservation-vault-ownership-to-governance",
        () => vault.transferOwnership(gov),
        {
          note: "governance EOA == deployer EOA on Sepolia (index 0)",
        }
      )
    }
    if ((await vault.owner()).toLowerCase() !== gov.toLowerCase()) {
      throw new Error("vault owner is not the governance EOA")
    }
    await deploy(
      "newGov",
      have.gov,
      "02f-deploy-new-bridge-governance",
      GOV_ARTIFACT,
      [state.bridge, BigInt(GOVERNANCE_DELAY_SECONDS)]
    )

    // 03/04: proxy upgrade + state preservation
    if (
      (await slotAddress(state, EIP1967_IMPL_SLOT)).toLowerCase() ===
      state.newImpl.toLowerCase()
    ) {
      skip(
        state,
        "03-proxy-upgrade",
        "implementation slot already points at the new implementation"
      )
      skip(state, "04-state-preservation", "checked in the run that upgraded")
    } else {
      const proxyAdmin = await ethers.getContractAt(
        ["function upgrade(address, address)"],
        state.proxyAdmin
      )
      await sendStep(
        state,
        "03-proxy-upgrade",
        () => proxyAdmin.connect(signer).upgrade(state.bridge, state.newImpl),
        { newImpl: state.newImpl }
      )
      const before = state.snapshotBefore!
      const after = await snapshotBridge(state)
      for (const k of Object.keys(before)) {
        if (before[k] !== after[k])
          throw new Error(
            `${k} changed on upgrade: ${before[k]} -> ${after[k]}`
          )
      }
      done(state, {
        name: "04-state-preservation",
        status: "PASS",
        values: { unchanged: Object.keys(before) },
      })
    }

    // 05/06: governance swap old -> new
    if (
      (await slotAddress(state, SLOTS.governance)).toLowerCase() ===
      state.newGov.toLowerCase()
    ) {
      skip(
        state,
        "05-governance-transfer-begin",
        "Bridge governance already points at the new governance"
      )
      skip(
        state,
        "06-governance-transfer-finalize",
        "Bridge governance already points at the new governance"
      )
    } else {
      const oldGov = (
        await ethers.getContractAt(
          [
            "function beginBridgeGovernanceTransfer(address)",
            "function finalizeBridgeGovernanceTransfer()",
          ],
          state.oldGov
        )
      ).connect(signer) as Contract
      const r = await sendStep(
        state,
        "05-governance-transfer-begin",
        () => oldGov.beginBridgeGovernanceTransfer(state.newGov),
        { newGov: state.newGov }
      )
      await waitDelay(state, r.blockNumber, GOVERNANCE_DELAY_SECONDS)
      await sendStep(state, "06-governance-transfer-finalize", () =>
        oldGov.finalizeBridgeGovernanceTransfer()
      )
      if (
        (await slotAddress(state, SLOTS.governance)).toLowerCase() !==
        state.newGov.toLowerCase()
      ) {
        throw new Error(
          "Bridge governance slot != new governance after finalize"
        )
      }
    }

    const newGov = (
      await ethers.getContractAt(GOV_ARTIFACT, state.newGov)
    ).connect(signer) as Contract
    if (await routerWired(state)) {
      skip(
        state,
        "07-set-reservation-router",
        "router already wired (verified on-chain)"
      )
    } else {
      await sendStep(
        state,
        "07-set-reservation-router",
        () => newGov.setReservationRouter(state.router),
        { router: state.router }
      )
    }

    const [dust, , , revealAhead] = String(
      state.snapshotBefore?.["depositParameters"]
    ).split(",")
    assertReservedDepositsFeasible({
      depositDustThreshold: BigInt(dust),
      depositRevealAheadPeriod: Number(revealAhead),
      termSeconds: V.termSeconds,
      singleAmountCap: V.singleAmountCap,
      perWalletCap: V.perWalletCap,
      maxTotalAmount: V.maxTotalAmount,
    })
    done(state, {
      name: "08-assert-reserved-deposits-feasible",
      status: "PASS",
      values: { dust, revealAhead, term: V.termSeconds },
    })

    if ((await capsApplied(state)) && (await paramsApplied(state))) {
      for (const n of [
        "09-begin-reservation-caps",
        "10-begin-reservation-parameters",
        "11-finalize-reservation-caps",
        "12-finalize-reservation-parameters",
      ]) {
        skip(
          state,
          n,
          "caps and parameters already finalized (verified on-chain)"
        )
      }
    } else {
      await sendStep(state, "09-begin-reservation-caps", () =>
        newGov.beginReservationCapsUpdate(
          V.perWalletCap,
          V.singleAmountCap,
          V.maxActive,
          V.maxThirdPartyReanchorHolds
        )
      )
      const r = await sendStep(state, "10-begin-reservation-parameters", () =>
        newGov.beginReservationParametersUpdate(
          state.vault,
          V.minAmount,
          V.txMaxFee,
          V.termSeconds,
          V.dissolutionDelay,
          V.maxTotalAmount,
          V.maxReservationsPerWallet,
          V.actionTimeout,
          V.renewalWindowSeconds
        )
      )
      await waitDelay(state, r.blockNumber, GOVERNANCE_DELAY_SECONDS)
      await sendStep(state, "11-finalize-reservation-caps", () =>
        newGov.finalizeReservationCapsUpdate()
      )
      await sendStep(state, "12-finalize-reservation-parameters", () =>
        newGov.finalizeReservationParametersUpdate()
      )
    }

    if ((await vault.feeReserveTarget()) === BigInt(V.feeReserveTarget)) {
      skip(
        state,
        "13-update-fee-reserve-target",
        "fee reserve target already at the decided value 0"
      )
    } else {
      await sendStep(
        state,
        "13-update-fee-reserve-target",
        () => vault.updateFeeReserveTarget(BigInt(V.feeReserveTarget)),
        { feeReserveTarget: V.feeReserveTarget }
      )
    }
    return true
  } catch (e) {
    done(state, { name: "prepare", status: "FAIL", error: String(e) })
    return false
  }
}

function printAddresses(state: RunState): void {
  console.log("\n--- Prepare complete. Addresses keep-core needs ---")
  console.log(`  Bridge proxy:        ${state.bridge}`)
  console.log(`  Bridge implementation: ${state.newImpl}`)
  console.log(`  BridgeGovernance:    ${state.newGov}`)
  console.log(`  ReservationRouter:   ${state.router}`)
  console.log(`  ReservationVault:    ${state.vault}`)
  console.log(
    "Next: runbook steps 7-9 (npm publish, keep-core build with block B, operator rollout),"
  )
  console.log(
    "then PHASE=activate ACTIVATION_BLOCK=<B> once the chain is at or past B."
  )
}

// Runbook steps 11-12. Refuses to run on any precondition mismatch.
async function activate(state: RunState, signer: Signer): Promise<boolean> {
  console.log(
    `\n=== Activate at block >= ${state.activationBlock}: runbook steps 11-12 ===`
  )
  try {
    const bad: string[] = []
    for (const [k, a] of [
      ["newImpl", state.newImpl],
      ["router", state.router],
      ["vault", state.vault],
      ["newGov", state.newGov],
    ]) {
      if (!(await hasCode(a))) bad.push(`${k} ${a} has no code`)
    }
    if (
      (await slotAddress(state, EIP1967_IMPL_SLOT)).toLowerCase() !==
      state.newImpl.toLowerCase()
    )
      bad.push("implementation slot != new implementation")
    if (
      (await slotAddress(state, SLOTS.governance)).toLowerCase() !==
      state.newGov.toLowerCase()
    )
      bad.push("Bridge governance != new governance")
    if (!(await routerWired(state))) bad.push("router not wired")
    if (!(await capsApplied(state)))
      bad.push("reservation caps differ from the runbook")
    if (!(await paramsApplied(state)))
      bad.push("reservation parameters differ from the runbook")
    const vault = (
      await ethers.getContractAt(VAULT_ARTIFACT, state.vault)
    ).connect(signer) as Contract
    if ((await vault.feeReserveTarget()) !== BigInt(V.feeReserveTarget))
      bad.push("fee reserve target != 0")
    const [dust, , , revealAhead] = String(
      state.snapshotBefore?.["depositParameters"]
    ).split(",")
    try {
      assertReservedDepositsFeasible({
        depositDustThreshold: BigInt(dust),
        depositRevealAheadPeriod: Number(revealAhead),
        termSeconds: V.termSeconds,
        singleAmountCap: V.singleAmountCap,
        perWalletCap: V.perWalletCap,
        maxTotalAmount: V.maxTotalAmount,
      })
    } catch (e) {
      bad.push(`feasibility: ${String(e).slice(0, 120)}`)
    }
    const current = (await ethers.provider.getBlock("latest")).number
    if (state.live && current < state.activationBlock) {
      bad.push(
        `current block ${current} is below activation block ${state.activationBlock}`
      )
    }
    if (bad.length > 0) {
      done(state, {
        name: "15a-activation-preconditions",
        status: "FAIL",
        error: `refusing to activate: ${bad.join("; ")}`,
      })
      return false
    }
    done(state, {
      name: "15a-activation-preconditions",
      status: "PASS",
      values: { currentBlock: current, activationBlock: state.activationBlock },
    })

    if (!state.live) {
      await mineToBlock(state.activationBlock)
      done(state, {
        name: "16-mine-to-activation-block",
        status: "PASS",
        values: { activationBlock: state.activationBlock },
      })
    }

    const newGov = (
      await ethers.getContractAt(GOV_ARTIFACT, state.newGov)
    ).connect(signer) as Contract
    const bridge = await ethers.getContractAt(BRIDGE_ARTIFACT, state.bridge)
    if (await bridge.isVaultTrusted(state.vault)) {
      skip(state, "17-set-vault-status", "vault already trusted")
    } else {
      const r = await sendStep(
        state,
        "17-set-vault-status",
        () => newGov.setVaultStatus(state.vault, true),
        { vault: state.vault }
      )
      if (r.blockNumber < state.activationBlock)
        throw new Error("setVaultStatus mined below the activation block")
    }

    // Step 12: post-activation checks
    const caps = await routerView(state, "reservationCaps")
    const params = await routerView(state, "reservationParameters")
    if (!(await bridge.isVaultTrusted(state.vault)))
      throw new Error("vault not trusted")
    if (params[6] !== 0n)
      throw new Error(`reservationTotalAmount ${params[6]} != 0`)
    done(state, {
      name: "18-verify-activation",
      status: "PASS",
      values: {
        reservationCaps: caps.map(String),
        reservationParameters: params.map(String),
        router: state.router,
        vaultTrusted: true,
        feeReserveTarget: V.feeReserveTarget,
      },
    })

    const iface = new eth.Interface(
      (await artifacts.readArtifact(ROUTER_ARTIFACT)).abi
    )
    const data = iface.encodeFunctionData("requestReservationReanchor", [
      1234567890123456789n,
      state.snapshotBefore?.["knownPk"] ?? "0x" + "0".repeat(40),
      [],
      0,
    ])
    const from = state.live
      ? KNOWN_DEPLOYER
      : (await ethers.getSigners())[5].address
    let reason = ""
    try {
      await ethers.provider.send("eth_call", [
        { to: state.bridge, data, from },
        "latest",
      ])
    } catch (e) {
      reason = String(e)
    }
    if (!reason.includes("Reservation is not active")) {
      throw new Error(
        `expected revert "Reservation is not active", got: ${reason.slice(0, 200) || "no revert"}`
      )
    }
    done(state, {
      name: "19-negative-third-party-reanchor",
      status: "PASS",
      values: { revertReason: "Reservation is not active" },
    })
    return true
  } catch (e) {
    done(state, { name: "activate", status: "FAIL", error: String(e) })
    return false
  }
}

async function main(): Promise<void> {
  const live = network.name !== "hardhat"
  const phase = process.env.PHASE ?? ""
  if (!["", "prepare", "activate"].includes(phase)) {
    throw new Error(`PHASE must be prepare or activate, got "${phase}"`)
  }
  if (live && phase === "") {
    throw new Error(
      `On network "${network.name}" set PHASE=prepare, or PHASE=activate ACTIVATION_BLOCK=<B>`
    )
  }
  const startBlock = (await ethers.provider.getBlock("latest")).number
  if (!live && startBlock !== FORKING_BLOCK) {
    throw new Error(
      `Fork block is ${startBlock}, expected pinned ${FORKING_BLOCK} — re-run with FORKING_BLOCK=${FORKING_BLOCK}`
    )
  }
  let activationBlock = live ? 0 : FORKING_BLOCK + ACTIVATION_BLOCK_OFFSET
  if (phase === "activate") {
    activationBlock = Number(process.env.ACTIVATION_BLOCK)
    if (!Number.isInteger(activationBlock) || activationBlock <= 0) {
      throw new Error("PHASE=activate needs ACTIVATION_BLOCK=<block number>")
    }
  }
  const state: RunState = {
    steps: [],
    live,
    phase,
    networkName: network.name,
    startBlock,
    bridge: "",
    oldGov: "",
    proxyAdmin: "",
    deployer: KNOWN_DEPLOYER,
    oldImpl: "",
    newImpl: "",
    router: "",
    vault: "",
    newGov: "",
    bank: "",
    tbtcVault: "",
    activationBlock,
    chainId: 0,
  }

  // Chain preflight: rejects unsupported live networks and wrong chain ids
  // before any signing or transaction. Set on state for binding checks below.
  const providerNet = await ethers.provider.getNetwork()
  // ethers v6 returns chainId as bigint; convert to number for the guard
  // interfaces (which use plain number chain ids).
  state.chainId = Number(providerNet.chainId)
  const chainProblem = chainPreflight(network.name, state.chainId, live)
  if (chainProblem !== null) {
    record(state, { name: "00-chain-preflight", status: "FAIL", error: chainProblem })
    return finish(state)
  }

  // Select the prepare artifact, parse it, and verify the binding against
  // the execution context. Any malformed/mismatched live artifact is
  // rejected, never silently redeployed.
  const baseCtx: ExecContext = {
    live,
    networkName: network.name,
    chainId: state.chainId,
    forkBlock: FORKING_BLOCK,
    bridge: "",
  }
  const requireComplete = phase === "activate"
  const selection = selectPrepareArtifact(artifactDir(), baseCtx, { requireComplete })
  if (selection.kind === "rejected") {
    record(state, {
      name: "00-load-prepare-artifact",
      status: "FAIL",
      error: selection.reason,
    })
    return finish(state)
  }
  if (requireComplete && selection.kind === "none") {
    record(state, {
      name: "00-load-prepare-artifact",
      status: "FAIL",
      error:
        "no prepare artifact with all four deployed addresses found; run PHASE=prepare first",
    })
    return finish(state)
  }
  const prevArtifact =
    selection.kind === "selected" ? selection.candidate.artifact : undefined

  const allowed =
    phase === "activate"
      ? [prevArtifact?.addresses.newImpl]
      : [KNOWN_OLD_IMPL, prevArtifact?.addresses.newImpl]
  if (!(await readState(state, allowed))) return finish(state)

  // Full binding check after readState (needs the deployed Bridge address).
  if (prevArtifact !== undefined) {
    const fullCtx: ExecContext = {
      live,
      networkName: network.name,
      chainId: state.chainId,
      forkBlock: FORKING_BLOCK,
      bridge: state.bridge,
    }
    const mismatch = bindingMismatch(prevArtifact, fullCtx)
    if (mismatch !== null) {
      record(state, {
        name: "00-load-prepare-artifact",
        status: "FAIL",
        error: `${selection.kind === "selected" ? selection.candidate.file : ""}: ${mismatch}; no transaction was sent`,
      })
      return finish(state)
    }
    if (phase === "activate") {
      Object.assign(state, {
        newImpl: prevArtifact.addresses.newImpl,
        newGov: prevArtifact.addresses.newGov,
        router: prevArtifact.addresses.router,
        vault: prevArtifact.addresses.vault,
      })
    }
    record(state, {
      name: "00-load-prepare-artifact",
      status: "PASS",
      values: {
        file: selection.kind === "selected" ? selection.candidate.file : "",
        binding: prevArtifact.binding,
        addresses: prevArtifact.addresses,
      },
    })
  } else {
    record(state, {
      name: "00-load-prepare-artifact",
      status: "PASS",
      values: { note: "no prior prepare artifact; fresh prepare" },
    })
  }

  const signer = await getSigner(state)
  if (signer === null) return finish(state)

  if (phase !== "activate") {
    if (!(await prepare(state, signer, prevArtifact?.addresses ?? {}))) return finish(state)
    if (phase === "prepare") {
      printAddresses(state)
      return finish(state)
    }
    console.log("\n=== Off-chain client steps (logged, not run) ===")
    skip(state, "14-npm-publish-sepolia-package", "off-chain step")
    skip(
      state,
      "15-keep-core-build-and-release-with-activation-block",
      "off-chain step"
    )
  }
  await activate(state, signer)
  finish(state)
}

// Under `hardhat run` on a node-22 native-ESM TS loader the module's
// default export is never auto-invoked, so drive `main()` at top level.
void main().catch((error: unknown) => {
  console.error("Reservations Sepolia script FAILED:", error)
  process.exitCode = 1
})
