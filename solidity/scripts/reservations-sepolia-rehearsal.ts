/*
 * Sepolia-fork rehearsal of the UTXO-reservations ACTIVATION sequence from
 * docs/RESERVATION_SEPOLIA_DEPLOYMENT.md.
 *
 * Runs the runbook's on-chain steps (in the new order: the client-release
 * steps are off-chain and recorded as SKIP) against a FORK of live Sepolia,
 * impersonating the Sepolia deployer EOA, which owns both the Bridge
 * ProxyAdmin and the live BridgeGovernance. Mirrors the helper shape of
 * scripts/reservations-fork-dryrun.ts (that script is on a separate
 * branch, so its helpers are copied here rather than imported).
 *
 * Order rehearsed:
 *   0. read & record live Sepolia governance state,
 *   1. impersonate the deployer EOA,
 *   2. deploy linked libraries, the new Bridge implementation,
 *      ReservationRouter, ReservationVault, and the new BridgeGovernance,
 *      and transfer vault ownership to the governance EOA (the same
 *      address on Sepolia),
 *   3. upgrade the Bridge proxy via ProxyAdmin and verify the
 *      pre-existing state is preserved,
 *   4. transfer Bridge governance old-gov -> new-gov (60 s delay
 *      advanced on the fork),
 *   5. setReservationRouter + reserved-deposit feasibility check +
 *      caps/params begin/finalize (60 s delays advanced),
 *   6. updateFeeReserveTarget(0) (recorded decision),
 *   7. npm publish + keep-core build/release: off-chain steps, logged as
 *      SKIP,
 *   8. mine to the chosen activation block B, setVaultStatus,
 *   9. post-activation checks, including one negative check that proves
 *      the new router ABI is reachable through the Bridge fallback.
 *
 * Run (from solidity/):
 *   FORKING_URL="$SEPOLIA_RPC_URL" FORKING_BLOCK=<pinned block> \
 *     npx hardhat run --network hardhat scripts/reservations-sepolia-rehearsal.ts
 *
 * The values rehearsed are the runbook's Sepolia values: caps
 * (2000000, 2000000, 4, 1), min amount 10000, tx max fee 1000, term
 * 7776000 (90 days), dissolution delay 86400, max total 8000000,
 * max per wallet 1, action timeout 86400, renewal window 86400. They
 * are asserted feasible against the forked live `depositParameters`
 * (dust threshold 1,000,000 sats, reveal-ahead period 1,296,000 s on
 * 2026-10-10) before anything is staged.
 *
 * Writes dryrun-artifacts/reservations-sepolia-rehearsal-<block>.json.
 */
import fs from "fs"
import path from "path"
import { ethers, artifacts, network } from "hardhat"
import {
  Contract,
  ContractFactory,
  Signer,
  TransactionReceipt,
  ethers as eth,
} from "ethers"

import { assertReservedDepositsFeasible } from "../deploy/98_generate_reservation_mainnet_calldata"

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
// parameters).
const SEPOLIA_VALUES = {
  perWalletCap: 2_000_000n,
  singleAmountCap: 2_000_000n,
  maxActive: 4,
  maxThirdPartyReanchorHolds: 1,
  minAmount: 10_000n,
  txMaxFee: 1_000n,
  termSeconds: 7_776_000,
  dissolutionDelay: 86_400,
  maxTotalAmount: 8_000_000n,
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

async function main(): Promise<void> {
  const block = await ethers.provider.getBlock("latest")
  if (block.number !== FORKING_BLOCK) {
    throw new Error(
      `Fork block is ${block.number}, expected pinned ${FORKING_BLOCK} — ` +
        `re-run with FORKING_BLOCK=${FORKING_BLOCK}`
    )
  }

  const state: RunState = {
    steps: [],
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
    activationBlock: FORKING_BLOCK + ACTIVATION_BLOCK_OFFSET,
  }

  // =========================================================================
  // 0. Read live Sepolia state
  // =========================================================================
  console.log("\n=== Step 0: read live Sepolia state ===")
  try {
    state.bridge = readSepoliaDeploymentAddress("Bridge.json")
    state.oldGov = readSepoliaDeploymentAddress("BridgeGovernance.json")
    state.bank = readSepoliaDeploymentAddress("Bank.json")
    state.tbtcVault = readSepoliaDeploymentAddress("TBTCVault.json")

    const adminSlot = await ethers.provider.getStorage(
      state.bridge,
      EIP1967_ADMIN_SLOT
    )
    state.proxyAdmin = eth.getAddress(`0x${adminSlot.slice(26)}`)
    if (state.proxyAdmin.toLowerCase() !== KNOWN_PROXY_ADMIN.toLowerCase()) {
      throw new Error(
        `On-chain ProxyAdmin ${state.proxyAdmin} != runbook ${KNOWN_PROXY_ADMIN}`
      )
    }

    const implSlot = await ethers.provider.getStorage(
      state.bridge,
      EIP1967_IMPL_SLOT
    )
    state.oldImpl = eth.getAddress(`0x${implSlot.slice(26)}`)
    if (state.oldImpl.toLowerCase() !== KNOWN_OLD_IMPL.toLowerCase()) {
      throw new Error(
        `On-chain Bridge implementation ${state.oldImpl} != runbook ` +
          `${KNOWN_OLD_IMPL}`
      )
    }

    const proxyAdmin = await ethers.getContractAt(
      ["function owner() view returns (address)"],
      state.proxyAdmin
    )
    const proxyAdminOwner = await proxyAdmin.owner()
    if (proxyAdminOwner.toLowerCase() !== KNOWN_DEPLOYER.toLowerCase()) {
      throw new Error(
        `ProxyAdmin owner ${proxyAdminOwner} != deployer EOA ${KNOWN_DEPLOYER}`
      )
    }

    const oldGov = await ethers.getContractAt(
      [
        "function owner() view returns (address)",
        "function governanceDelays(uint256) view returns (uint256)",
        "function beginBridgeGovernanceTransfer(address)",
        "function finalizeBridgeGovernanceTransfer()",
      ],
      state.oldGov
    )
    const oldGovOwner = await oldGov.owner()
    if (oldGovOwner.toLowerCase() !== KNOWN_DEPLOYER.toLowerCase()) {
      throw new Error(
        `BridgeGovernance owner ${oldGovOwner} != deployer EOA ${KNOWN_DEPLOYER}`
      )
    }
    const oldGovDelay = await oldGov.governanceDelays(0)
    if (oldGovDelay !== BigInt(GOVERNANCE_DELAY_SECONDS)) {
      throw new Error(
        `Live governance delay ${oldGovDelay}s != runbook ` +
          `${GOVERNANCE_DELAY_SECONDS}s — re-check the ceremony waits`
      )
    }

    state.snapshotBefore = await snapshotBridge(state)

    record(state, {
      name: "00-read-sepolia-state",
      status: "PASS",
      values: {
        bridge: state.bridge,
        oldGov: state.oldGov,
        oldImpl: state.oldImpl,
        proxyAdmin: state.proxyAdmin,
        proxyAdminOwner,
        oldGovOwner,
        governanceDelay: oldGovDelay.toString(),
        initialized: state.snapshotBefore["initialized"],
        knownPk: state.snapshotBefore["knownPk"],
        knownWallet: state.snapshotBefore["knownWallet"],
        liveWalletsCount: state.snapshotBefore["liveWalletsCount"],
        depositParameters: state.snapshotBefore["depositParameters"],
      },
    })
  } catch (e) {
    record(state, {
      name: "00-read-sepolia-state",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(state)
  }

  // =========================================================================
  // 1. Impersonate the deployer EOA
  // =========================================================================
  console.log("\n=== Step 1: impersonate the deployer EOA ===")
  const FUND = "0x8AC7230489E80000" // 10 ETH
  try {
    await network.provider.send("hardhat_impersonateAccount", [state.deployer])
    await network.provider.send("hardhat_setBalance", [state.deployer, FUND])
    record(state, {
      name: "01-impersonate-deployer",
      status: "PASS",
      values: { deployer: state.deployer },
    })
  } catch (e) {
    record(state, {
      name: "01-impersonate-deployer",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(state)
  }
  const deployer = await ethers.getSigner(state.deployer)

  // =========================================================================
  // 2. Deploy on the fork (runbook steps 1–3)
  // =========================================================================
  console.log("\n=== Step 2: deploy contracts on the fork ===")
  try {
    const libAddresses: Record<string, string> = {}
    for (const { name, artifact } of LIBS) {
      const { contract } = await deployLinked(artifact, deployer, {})
      libAddresses[name] = contract.target
    }
    record(state, {
      name: "02a-deploy-shared-libraries",
      status: "PASS",
      values: libAddresses,
    })

    const bridgeImpl = await deployLinked(
      BRIDGE_ARTIFACT,
      deployer,
      libAddresses,
      []
    )
    state.newImpl = bridgeImpl.contract.target
    record(state, {
      name: "02b-deploy-bridge-implementation",
      status: "PASS",
      txHash: txHashOf(bridgeImpl.receipt),
      gasUsed: Number(bridgeImpl.receipt.gasUsed),
      values: { implementation: state.newImpl },
    })

    const router = await deployLinked(
      ROUTER_ARTIFACT,
      deployer,
      libAddresses,
      []
    )
    state.router = router.contract.target
    record(state, {
      name: "02c-deploy-reservation-router",
      status: "PASS",
      txHash: txHashOf(router.receipt),
      gasUsed: Number(router.receipt.gasUsed),
      values: { router: state.router },
    })

    const vault = await deployLinked(VAULT_ARTIFACT, deployer, libAddresses, [
      state.bank,
      state.tbtcVault,
      state.bridge,
    ])
    state.vault = vault.contract.target
    record(state, {
      name: "02d-deploy-reservation-vault",
      status: "PASS",
      txHash: txHashOf(vault.receipt),
      gasUsed: Number(vault.receipt.gasUsed),
      values: { vault: state.vault },
    })

    // Runbook step 2: vault ownership deployer -> governance. On Sepolia
    // both named accounts are the same deployer EOA, so this is a
    // self-transfer that documents the owner chain: the governance EOA
    // (== deployer EOA) holds the vault before activation.
    const vaultContract = (
      await ethers.getContractAt(VAULT_ARTIFACT, state.vault)
    ).connect(deployer)
    const vaultTransfer = await vaultContract.transferOwnership(KNOWN_DEPLOYER)
    const vaultTransferReceipt = await vaultTransfer.wait()
    const vaultOwner = await vaultContract.owner()
    if (vaultOwner.toLowerCase() !== KNOWN_DEPLOYER.toLowerCase()) {
      throw new Error(`vault owner after transfer: ${vaultOwner}`)
    }
    record(state, {
      name: "02e-transfer-reservation-vault-ownership-to-governance",
      status: "PASS",
      txHash: txHashOf(vaultTransferReceipt),
      gasUsed: Number(vaultTransferReceipt.gasUsed),
      values: {
        vaultOwner,
        note: "governance EOA == deployer EOA on Sepolia (index 0)",
      },
    })

    const newGov = await deployLinked(GOV_ARTIFACT, deployer, libAddresses, [
      state.bridge,
      BigInt(GOVERNANCE_DELAY_SECONDS),
    ])
    state.newGov = newGov.contract.target
    record(state, {
      name: "02f-deploy-new-bridge-governance",
      status: "PASS",
      txHash: txHashOf(newGov.receipt),
      gasUsed: Number(newGov.receipt.gasUsed),
      values: {
        newGov: state.newGov,
        governanceDelay: GOVERNANCE_DELAY_SECONDS,
      },
    })
  } catch (e) {
    record(state, {
      name: "02-deploy-contracts",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(state)
  }

  // =========================================================================
  // 3. Upgrade the Bridge proxy + state-preservation check (runbook step 4)
  // =========================================================================
  console.log("\n=== Step 3: proxy upgrade ===")
  try {
    const proxyAdmin = await ethers.getContractAt(
      [
        "function upgrade(address, address)",
        "function upgradeAndCall(address, address, bytes)",
      ],
      state.proxyAdmin
    )
    const upgrade = await proxyAdmin
      .connect(deployer)
      .upgrade(state.bridge, state.newImpl)
    const upgradeReceipt = await upgrade.wait()
    record(state, {
      name: "03-proxy-upgrade",
      status: "PASS",
      txHash: txHashOf(upgradeReceipt),
      gasUsed: Number(upgradeReceipt.gasUsed),
      values: { newImpl: state.newImpl },
    })
  } catch (e) {
    record(state, {
      name: "03-proxy-upgrade",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(state)
  }

  // State-preservation check (runbook step 4, fork dry-run step 4 model):
  // no reinitializer is invoked on this branch; the new impl's max
  // reinitializer is reinitializer(5), same as the old live impl, so a
  // plain upgrade() is correct.
  try {
    state.snapshotAfter = await snapshotBridge(state)
    const before = state.snapshotBefore
    const after = state.snapshotAfter
    for (const field of [
      "ecdsaWalletRegistry",
      "governance",
      "initialized",
      "rebateStaking",
      "reservationVault",
      "reservationRouter",
    ]) {
      if (before[field] !== after[field]) {
        throw new Error(
          `storage ${field} changed on upgrade: ${before[field]} -> ${after[field]}`
        )
      }
    }
    if (before["knownPk"] !== after["knownPk"]) {
      throw new Error("knownPk changed on upgrade")
    }
    if (before["knownWallet"] !== after["knownWallet"]) {
      throw new Error(
        `wallets(pk) entry changed: ${before["knownWallet"]} -> ${after["knownWallet"]}`
      )
    }
    if (before["liveWalletsCount"] !== after["liveWalletsCount"]) {
      throw new Error("liveWalletsCount changed on upgrade")
    }
    if (before["depositParameters"] !== after["depositParameters"]) {
      throw new Error("depositParameters changed on upgrade")
    }
    record(state, {
      name: "04-state-preservation",
      status: "PASS",
      values: {
        ecdsaWalletRegistry: after["ecdsaWalletRegistry"],
        governanceSlotUnchanged: true,
        knownWalletUnchanged: true,
        liveWalletsCountUnchanged: true,
        depositParametersUnchanged: true,
        initialized: after["initialized"],
      },
    })
  } catch (e) {
    record(state, {
      name: "04-state-preservation",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(state)
  }

  // =========================================================================
  // 4. Governance swap + router + caps/params (runbook steps 5–6)
  // =========================================================================
  console.log("\n=== Step 4: governance actions ===")
  try {
    const oldGov = await ethers.getContractAt(
      [
        "function beginBridgeGovernanceTransfer(address)",
        "function finalizeBridgeGovernanceTransfer()",
      ],
      state.oldGov
    )
    const begin = await oldGov
      .connect(deployer)
      .beginBridgeGovernanceTransfer(state.newGov)
    const beginReceipt = await begin.wait()
    record(state, {
      name: "05-governance-transfer-begin",
      status: "PASS",
      txHash: txHashOf(beginReceipt),
      gasUsed: Number(beginReceipt.gasUsed),
      values: { newGov: state.newGov },
    })

    await advanceTime(GOVERNANCE_DELAY_SECONDS)

    const finalize = await oldGov
      .connect(deployer)
      .finalizeBridgeGovernanceTransfer()
    const finalizeReceipt = await finalize.wait()
    const governanceAfter = await ethers.provider.getStorage(
      state.bridge,
      SLOTS.governance
    )
    const expectedSlot =
      "0x" + "0".repeat(24) + state.newGov.toLowerCase().slice(2)
    if (governanceAfter.toLowerCase() !== expectedSlot.toLowerCase()) {
      throw new Error(
        `Bridge governance slot ${governanceAfter} != new gov ${state.newGov}`
      )
    }
    record(state, {
      name: "06-governance-transfer-finalize",
      status: "PASS",
      txHash: txHashOf(finalizeReceipt),
      gasUsed: Number(finalizeReceipt.gasUsed),
      values: { bridgeGovernanceSlot: governanceAfter },
    })

    const newGov = await ethers.getContractAt(GOV_ARTIFACT, state.newGov)

    // setReservationRouter MUST be the first reservation action.
    const routerTx = await newGov
      .connect(deployer)
      .setReservationRouter(state.router)
    const routerReceipt = await routerTx.wait()
    record(state, {
      name: "07-set-reservation-router",
      status: "PASS",
      txHash: txHashOf(routerReceipt),
      gasUsed: Number(routerReceipt.gasUsed),
      values: { router: state.router },
    })

    // Reserved-deposit feasibility against the forked live deposit
    // parameters, before anything is staged (runbook step 6 / pre-flight
    // check 1). Nothing on-chain checks this, so it must run here.
    const [dust, , , revealAhead] = String(
      state.snapshotBefore?.["depositParameters"]
    ).split(",")
    assertReservedDepositsFeasible({
      depositDustThreshold: BigInt(dust),
      depositRevealAheadPeriod: Number(revealAhead),
      termSeconds: SEPOLIA_VALUES.termSeconds,
      singleAmountCap: SEPOLIA_VALUES.singleAmountCap,
      perWalletCap: SEPOLIA_VALUES.perWalletCap,
      maxTotalAmount: SEPOLIA_VALUES.maxTotalAmount,
    })
    record(state, {
      name: "08-assert-reserved-deposits-feasible",
      status: "PASS",
      values: {
        depositDustThreshold: dust,
        depositRevealAheadPeriod: revealAhead,
        termSeconds: String(SEPOLIA_VALUES.termSeconds),
        singleAmountCap: SEPOLIA_VALUES.singleAmountCap.toString(),
        perWalletCap: SEPOLIA_VALUES.perWalletCap.toString(),
        maxTotalAmount: SEPOLIA_VALUES.maxTotalAmount.toString(),
      },
    })

    // Staged pairs: caps first (finalizes must precede the parameters
    // finalize), then parameters. Both begins batch at one timestamp;
    // one delay advance covers both finalizes.
    const beginCaps = await newGov
      .connect(deployer)
      .beginReservationCapsUpdate(
        SEPOLIA_VALUES.perWalletCap,
        SEPOLIA_VALUES.singleAmountCap,
        SEPOLIA_VALUES.maxActive,
        SEPOLIA_VALUES.maxThirdPartyReanchorHolds
      )
    const beginCapsReceipt = await beginCaps.wait()
    record(state, {
      name: "09-begin-reservation-caps",
      status: "PASS",
      txHash: txHashOf(beginCapsReceipt),
      gasUsed: Number(beginCapsReceipt.gasUsed),
      values: {
        perWalletCap: SEPOLIA_VALUES.perWalletCap.toString(),
        singleAmountCap: SEPOLIA_VALUES.singleAmountCap.toString(),
        maxActive: SEPOLIA_VALUES.maxActive,
        maxThirdPartyReanchorHolds: SEPOLIA_VALUES.maxThirdPartyReanchorHolds,
      },
    })

    const beginParams = await newGov
      .connect(deployer)
      .beginReservationParametersUpdate(
        state.vault,
        SEPOLIA_VALUES.minAmount,
        SEPOLIA_VALUES.txMaxFee,
        SEPOLIA_VALUES.termSeconds,
        SEPOLIA_VALUES.dissolutionDelay,
        SEPOLIA_VALUES.maxTotalAmount,
        SEPOLIA_VALUES.maxReservationsPerWallet,
        SEPOLIA_VALUES.actionTimeout,
        SEPOLIA_VALUES.renewalWindowSeconds
      )
    const beginParamsReceipt = await beginParams.wait()
    record(state, {
      name: "10-begin-reservation-parameters",
      status: "PASS",
      txHash: txHashOf(beginParamsReceipt),
      gasUsed: Number(beginParamsReceipt.gasUsed),
      values: {
        vault: state.vault,
        minAmount: SEPOLIA_VALUES.minAmount.toString(),
        txMaxFee: SEPOLIA_VALUES.txMaxFee.toString(),
        termSeconds: SEPOLIA_VALUES.termSeconds,
        dissolutionDelay: SEPOLIA_VALUES.dissolutionDelay,
        maxTotalAmount: SEPOLIA_VALUES.maxTotalAmount.toString(),
        maxPerWallet: SEPOLIA_VALUES.maxReservationsPerWallet,
        actionTimeout: SEPOLIA_VALUES.actionTimeout,
        renewalWindowSeconds: SEPOLIA_VALUES.renewalWindowSeconds,
      },
    })

    await advanceTime(GOVERNANCE_DELAY_SECONDS)

    const finalizeCaps = await newGov
      .connect(deployer)
      .finalizeReservationCapsUpdate()
    const finalizeCapsReceipt = await finalizeCaps.wait()
    record(state, {
      name: "11-finalize-reservation-caps",
      status: "PASS",
      txHash: txHashOf(finalizeCapsReceipt),
      gasUsed: Number(finalizeCapsReceipt.gasUsed),
    })

    const finalizeParams = await newGov
      .connect(deployer)
      .finalizeReservationParametersUpdate()
    const finalizeParamsReceipt = await finalizeParams.wait()
    record(state, {
      name: "12-finalize-reservation-parameters",
      status: "PASS",
      txHash: txHashOf(finalizeParamsReceipt),
      gasUsed: Number(finalizeParamsReceipt.gasUsed),
    })

    // Fee-reserve target, recorded decision: zero on Sepolia.
    const vaultContract = (
      await ethers.getContractAt(VAULT_ARTIFACT, state.vault)
    ).connect(deployer)
    const feeReserveTx = await vaultContract.updateFeeReserveTarget(
      BigInt(SEPOLIA_VALUES.feeReserveTarget)
    )
    const feeReserveReceipt = await feeReserveTx.wait()
    const feeReserveTarget = await vaultContract.feeReserveTarget()
    if (feeReserveTarget !== BigInt(SEPOLIA_VALUES.feeReserveTarget)) {
      throw new Error(`feeReserveTarget ${feeReserveTarget} != decided value 0`)
    }
    record(state, {
      name: "13-update-fee-reserve-target",
      status: "PASS",
      txHash: txHashOf(feeReserveReceipt),
      gasUsed: Number(feeReserveReceipt.gasUsed),
      values: { feeReserveTarget: feeReserveTarget.toString() },
    })
  } catch (e) {
    record(state, {
      name: "05-governance-action-sequence",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(state)
  }

  // =========================================================================
  // 5. Off-chain steps: npm publish + keep-core build (runbook steps 7–9)
  // =========================================================================
  console.log("\n=== Step 5: off-chain client steps (logged, not run) ===")
  record(state, {
    name: "14-npm-publish-sepolia-package",
    status: "SKIP",
    values: { reason: "off-chain step" },
  })
  record(state, {
    name: "15-keep-core-build-and-release-with-activation-block",
    status: "SKIP",
    values: { reason: "off-chain step" },
  })

  // =========================================================================
  // 6. Mine to the activation block, activate the vault (runbook step 11)
  // =========================================================================
  console.log(`\n=== Step 6: activate at block ${state.activationBlock} ===`)
  try {
    await mineToBlock(state.activationBlock)
    const minedBlock = (await ethers.provider.getBlock("latest")).number
    if (minedBlock < state.activationBlock) {
      throw new Error(
        `Fork is at block ${minedBlock}, below activation block ` +
          `${state.activationBlock}`
      )
    }
    record(state, {
      name: "16-mine-to-activation-block",
      status: "PASS",
      values: {
        activationBlock: state.activationBlock,
        note: `B = FORKING_BLOCK + ${ACTIVATION_BLOCK_OFFSET} (runbook step 8 margin)`,
      },
    })

    const newGov = await ethers.getContractAt(GOV_ARTIFACT, state.newGov)
    const activate = await newGov
      .connect(deployer)
      .setVaultStatus(state.vault, true)
    const activateReceipt = await activate.wait()
    const trusted = await ethers
      .getContractAt(BRIDGE_ARTIFACT, state.bridge)
      .then((b) => b.isVaultTrusted(state.vault))
    if (trusted !== true) {
      throw new Error("vault not trusted after setVaultStatus")
    }
    record(state, {
      name: "17-set-vault-status",
      status: "PASS",
      txHash: txHashOf(activateReceipt),
      gasUsed: Number(activateReceipt.gasUsed),
      values: { vault: state.vault, isTrusted: true },
    })
  } catch (e) {
    record(state, {
      name: "17-activate-vault",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(state)
  }

  // =========================================================================
  // 7. Post-activation verification (runbook step 12)
  // =========================================================================
  console.log("\n=== Step 7: verify activation ===")
  try {
    // Router-only views are reached through the Bridge fallback, so encode
    // with the router's ABI and call the Bridge proxy address directly.
    const routerArtifact = await artifacts.readArtifact(ROUTER_ARTIFACT)
    const routerIface = new eth.Interface(routerArtifact.abi)
    const callRouterView = async (
      name: string,
      args: unknown[]
    ): Promise<eth.Result> => {
      const data = routerIface.encodeFunctionData(name, args)
      const result = await ethers.provider.call({ to: state.bridge, data })
      return routerIface.decodeFunctionResult(name, result)
    }

    const caps = await callRouterView("reservationCaps", [])
    const [capPerWallet, capSingle, capMaxActive, capThirdPartyHolds] =
      caps as [bigint, bigint, bigint, bigint]
    if (capPerWallet !== SEPOLIA_VALUES.perWalletCap)
      throw new Error("capPerWallet mismatch")
    if (capSingle !== SEPOLIA_VALUES.singleAmountCap)
      throw new Error("capSingle mismatch")
    if (Number(capMaxActive) !== SEPOLIA_VALUES.maxActive)
      throw new Error("capMaxActive mismatch")
    if (
      Number(capThirdPartyHolds) !== SEPOLIA_VALUES.maxThirdPartyReanchorHolds
    )
      throw new Error("capThirdPartyHolds mismatch")

    const params = await callRouterView("reservationParameters", [])
    const [
      pVault,
      pMin,
      pTxMaxFee,
      pTerm,
      pDissolution,
      pMaxTotal,
      pTotal,
      pPerWallet,
      pActionTimeout,
      pRenewal,
    ] = params as [
      string,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ]
    if ((pVault as string).toLowerCase() !== state.vault.toLowerCase())
      throw new Error(`reservationParameters.vault ${pVault} != ${state.vault}`)
    if (pMin !== SEPOLIA_VALUES.minAmount) throw new Error("minAmount mismatch")
    if (pTxMaxFee !== SEPOLIA_VALUES.txMaxFee)
      throw new Error("txMaxFee mismatch")
    if (Number(pTerm) !== SEPOLIA_VALUES.termSeconds)
      throw new Error("termSeconds mismatch")
    if (Number(pDissolution) !== SEPOLIA_VALUES.dissolutionDelay)
      throw new Error("dissolutionDelay mismatch")
    if (pMaxTotal !== SEPOLIA_VALUES.maxTotalAmount)
      throw new Error("maxTotalAmount mismatch")
    if (pTotal !== 0n)
      throw new Error(`reservationTotalAmount ${pTotal} != 0 (fresh vault)`)
    if (Number(pPerWallet) !== SEPOLIA_VALUES.maxReservationsPerWallet)
      throw new Error("maxPerWallet mismatch")
    if (Number(pActionTimeout) !== SEPOLIA_VALUES.actionTimeout)
      throw new Error("actionTimeout mismatch")
    if (Number(pRenewal) !== SEPOLIA_VALUES.renewalWindowSeconds)
      throw new Error("renewalWindow mismatch")

    const bridgeNew = await ethers.getContractAt(BRIDGE_ARTIFACT, state.bridge)
    const routerAddr = await bridgeNew.getReservationRouter()
    if (routerAddr.toLowerCase() !== state.router.toLowerCase())
      throw new Error(`router ${routerAddr} != ${state.router}`)

    record(state, {
      name: "18-verify-activation",
      status: "PASS",
      values: {
        reservationCaps: [
          capPerWallet.toString(),
          capSingle.toString(),
          capMaxActive.toString(),
          capThirdPartyHolds.toString(),
        ],
        reservationVault: pVault,
        reservationMinAmount: String(pMin),
        reservationParameters: [
          pMin.toString(),
          pTxMaxFee.toString(),
          pTerm.toString(),
          pDissolution.toString(),
          pMaxTotal.toString(),
          pTotal.toString(),
          pPerWallet.toString(),
          pActionTimeout.toString(),
          pRenewal.toString(),
        ],
        router: routerAddr,
        vaultTrusted: true,
        feeReserveTarget: SEPOLIA_VALUES.feeReserveTarget.toString(),
      },
    })
  } catch (e) {
    record(state, {
      name: "18-verify-activation",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(state)
  }

  // 19: negative check — a third party hitting a nonexistent reservation
  // proves the router's ABI is live through the Bridge fallback.
  try {
    const routerArtifact = await artifacts.readArtifact(ROUTER_ARTIFACT)
    const routerIface = new eth.Interface(routerArtifact.abi)
    const bogusKey = 1234567890123456789n
    const data = routerIface.encodeFunctionData("requestReservationReanchor", [
      bogusKey,
      state.snapshotBefore?.["knownPk"] ?? "0x" + "0".repeat(40),
      [],
      0,
    ])
    const thirdParty = (await ethers.getSigners())[5]
    let reverted = false
    let revertReason = ""
    try {
      // eth_call is a gas-free simulation; the caller needs no balance.
      await ethers.provider.send("eth_call", [
        { to: state.bridge, data, from: thirdParty.address },
        "latest",
      ])
    } catch (e) {
      reverted = true
      revertReason = String(e)
    }
    if (!reverted) {
      throw new Error(
        "requestReservationReanchor did NOT revert — unexpectedly permissive"
      )
    }
    if (!revertReason.includes("Reservation is not active")) {
      throw new Error(
        `expected revert "Reservation is not active", got: ${revertReason.slice(0, 200)}`
      )
    }
    record(state, {
      name: "19-negative-third-party-reanchor",
      status: "PASS",
      values: {
        reverted: true,
        revertReason: "Reservation is not active",
        reservationKey: bogusKey.toString(),
        via: "Bridge fallback -> router delegatecall (new ABI reachable)",
      },
    })
  } catch (e) {
    record(state, {
      name: "19-negative-third-party-reanchor",
      status: "FAIL",
      error: String(e),
    })
  }

  return writeArtifact(state)
}

function writeArtifact(state: RunState): void {
  const outDir = path.join(__dirname, "..", "dryrun-artifacts")
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(
    outDir,
    `reservations-sepolia-rehearsal-${FORKING_BLOCK}.json`
  )
  const failures = state.steps.filter((s) => s.status === "FAIL")
  const artifact = {
    forkBlock: FORKING_BLOCK,
    activationBlock: state.activationBlock,
    runAt: new Date().toISOString(),
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
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      artifact,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    ) + "\n"
  )
  console.log(`\nArtifact written to ${outFile}`)
  console.log(
    `Summary: ${artifact.summary.pass} pass / ${artifact.summary.fail} fail / ${artifact.summary.skip} skip`
  )
  for (const f of failures) {
    console.log(`  - ${f.name}: ${String(f.error).slice(0, 200)}`)
  }
  if (failures.length > 0) {
    process.exitCode = 1
  }
}

// Under `hardhat run` on a node-22 native-ESM TS loader the module's
// default export is never auto-invoked, so drive `main()` at top level.
void main().catch((error: unknown) => {
  console.error("Reservations Sepolia rehearsal FAILED:", error)
  process.exitCode = 1
})
