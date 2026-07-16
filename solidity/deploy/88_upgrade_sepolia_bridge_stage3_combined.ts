import fs from "fs"
import path from "path"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { BigNumber, providers, utils } from "ethers"

import {
  EIP_1967_ADMIN_SLOT,
  EIP_1967_IMPLEMENTATION_SLOT,
} from "./85_deploy_tip109_governance_upgrade"
import {
  computeOpenFraudChallengeEscrow,
  computeWalletRegistrationOrder,
} from "./86_deploy_tip109_hotfix"
// Reuse the gated Etherscan V2 verification from script 87 so the seven
// libraries + implementation are each verified with their OWN build-info
// (correct optimizer runs, full compiler version, and — for the linked Bridge —
// the deployed library addresses) and any failure aborts the upgrade.
import { verifyDeployedContractOrThrow } from "./87_deploy_covenant_spend_authorization"

// Two-mode upgrade of the live Sepolia Bridge proxy to the combined
// implementation that carries BOTH the reconstructed account-control
// controller-mint surface (already live at implementation 0xa14a9607…) AND the
// reviewed PR covenant/migration surface, wired atomically by the version-6
// reinitializer. Preparation mode (default) deploys and verifies the new
// artifacts, computes reference calldata, and records a summary WITHOUT touching
// the proxy. Execution mode (EXECUTE_STAGE3_COMBINED_UPGRADE=true) re-runs every
// preflight and re-derives every mutable input immediately before sending
// ProxyAdmin.upgradeAndCall, then asserts the full post-upgrade surface.
//
// Sepolia-only. Mainnet has no controller extension and must use the ordinary
// reviewed PR implementation and its separate governance migration path.

// ---- Pinned constants (all verified against live Sepolia) ----
const CHAIN_ID = 11155111
const BRIDGE_PROXY = "0x9b1a7fE5a16A15F2f9475C5B231750598b113403"
const EXPECTED_OLD_IMPLEMENTATION = "0xa14a9607DeDE925C7f7aCfB27Ce192771F8F6FA0"
const EXPECTED_OLD_RUNTIME_HASH =
  "0x64c50435e159ab50ba1f2d4a8d32d14ed255128247d5195cac9827a6f1ee0e80"
const PROXY_ADMIN = "0x39f60B25C4598Caf7e922d6fC063E9002db45845"
const PROXY_ADMIN_OWNER = "0x68ad60CC5e8f3B7cC53beaB321cf0e6036962dBc"
const BRIDGE_GOVERNANCE = "0x5F491868637fA298c5ee2BFcA557C02C083A4b4b"
const EXPECTED_MINTING_CONTROLLER = "0x1433e4f7a1FD121a0988d12A2323Bb95E2D54A0E"
const BANK = "0x4918fD33a22e7E2948B7444CbDd68efAa9E6a087"
// Bridge proxy deployment block; migration scans start here.
const BRIDGE_DEPLOY_BLOCK = 4553028

// Absolute Bridge storage slots (self begins at absolute slot 51).
const SLOT_INITIALIZER_VERSION = 50
const SLOT_MINTING_CONTROLLER = 81
// Packed slot 130: fraudChallengeEscrowSeeded (bit 0), walletRegistrationOrder-
// Seeded (bit 8), covenantSpendAuthorization (>> 16).
const SLOT_PACKED_FLAGS_REGISTRY = 130

// WalletState.Unknown ordinal; any scanned wallet must resolve to a higher state.
const WALLET_STATE_UNKNOWN = 0

// Custom-error selector `FraudChallengeEscrowNotSeeded()`; a post-upgrade
// submitFraudChallenge static call must NOT revert with this selector.
const FRAUD_ESCROW_NOT_SEEDED_SELECTOR = "0x5f4214d3"
const UNAUTHORIZED_CONTROLLER_REVERT = "Caller is not the authorized controller"

// Selectors the OLD (controller-mint) implementation MUST expose.
const CONTROLLER_SELECTORS: Record<string, string> = {
  "mintingController()": "0x09878d8c",
  "getMintingController()": "0xf56cb897",
  "controllerIncreaseBalance(address,uint256)": "0xa5f7eaf8",
  "controllerIncreaseBalances(address[],uint256[])": "0x5182a65f",
  "setMintingController(address)": "0xbbbfb5fd",
}
// Selectors the OLD implementation MUST NOT expose (they arrive only with the
// combined implementation).
const PR_SELECTORS: Record<string, string> = {
  "defeatFraudChallengeWithCovenantSpend(bytes,bytes)": "0xc3382e7a",
  "setCovenantSpendAuthorization(address)": "0xf0536b99",
  "migrationDebtVault()": "0x6803f2ed",
}

// The seven Bridge libraries, deployed fresh under Stage-3 names. Keys are the
// canonical linker names; `contract` is the real library source; `source` is the
// fully-qualified source unit used for verification and library linking.
const STAGE3_LIBRARIES: Array<{
  key: string
  name: string
  contract: string
  source: string
}> = [
  {
    key: "Deposit",
    name: "DepositStage3Combined",
    contract: "Deposit",
    source: "contracts/bridge/Deposit.sol",
  },
  {
    key: "DepositSweep",
    name: "DepositSweepStage3Combined",
    contract: "DepositSweep",
    source: "contracts/bridge/DepositSweep.sol",
  },
  {
    key: "Redemption",
    name: "RedemptionStage3Combined",
    contract: "Redemption",
    source: "contracts/bridge/Redemption.sol",
  },
  {
    key: "Wallets",
    name: "WalletsStage3Combined",
    contract: "contracts/bridge/Wallets.sol:Wallets",
    source: "contracts/bridge/Wallets.sol",
  },
  {
    key: "Fraud",
    name: "FraudStage3Combined",
    contract: "Fraud",
    source: "contracts/bridge/Fraud.sol",
  },
  {
    key: "MovingFunds",
    name: "MovingFundsStage3Combined",
    contract: "MovingFunds",
    source: "contracts/bridge/MovingFunds.sol",
  },
  {
    key: "VaultManagement",
    name: "VaultManagementStage3Combined",
    contract: "VaultManagement",
    source: "contracts/bridge/VaultManagement.sol",
  },
]

const BRIDGE_IMPL_DEPLOYMENT = "BridgeStage3CombinedImplementation"
const BRIDGE_FQ_NAME = "contracts/bridge/Bridge.sol:Bridge"

const EIP170_LIMIT = 24576
const PREFERRED_MARGIN = 128

// Minimal ABIs for the live-state reads, the upgrade call, and the post-upgrade
// surface assertions.
const PROXY_ADMIN_ABI = [
  "function owner() view returns (address)",
  "function upgradeAndCall(address proxy, address implementation, bytes data) payable",
]
const BRIDGE_READ_ABI = [
  "function governance() view returns (address)",
  "function mintingController() view returns (address)",
  "function getMintingController() view returns (address)",
  "function migrationDebtVault() view returns (address)",
  "function activeWalletPubKeyHash() view returns (bytes20)",
  "function liveWalletsCount() view returns (uint32)",
  "function wallets(bytes20) view returns (bytes32 ecdsaWalletID, bytes32 mainUtxoHash, uint64 pendingRedemptionsValue, uint32 createdAt, uint32 movingFundsRequestedAt, uint32 closingStartedAt, uint32 pendingMovedFundsSweepRequestsCount, uint8 state, bytes32 movingFundsTargetWalletsCommitmentHash)",
  "function controllerIncreaseBalance(address recipient, uint256 amount)",
  "function submitFraudChallenge(bytes walletPublicKey, bytes preimageSha256, (bytes32 r, bytes32 s, uint8 v) signature) payable",
  "function initializeV6_Stage3Combined(address expectedMintingController, address covenantSpendAuthorization_, uint256 preUpgradeOpenFraudChallengeEscrow, bytes20[] preUpgradeWallets)",
  "event MintingControllerSet(address mintingController)",
  "event CovenantSpendAuthorizationUpdated(address indexed covenantSpendAuthorization)",
  "event Initialized(uint8 version)",
]
const G1_ABI = [
  "function bridge() view returns (address)",
  "function bank() view returns (address)",
  "function mintingPaused() view returns (bool)",
]
const REGISTRY_ABI = [
  "function owner() view returns (address)",
  "function isAuthorized(uint256 utxoKey, bytes20 walletPubKeyHash, uint64 value, bytes32 outputsHash) view returns (bool)",
]

const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)
const bridgeInterface = new utils.Interface(BRIDGE_READ_ABI)
const g1Interface = new utils.Interface(G1_ABI)
const registryInterface = new utils.Interface(REGISTRY_ABI)

// Reads a left-padded address from a 32-byte storage word.
function addressFromSlot(word: string): string {
  return utils.getAddress(`0x${word.slice(-40)}`)
}

// Reads and decodes a single view function on `to`.
async function readCall(
  provider: providers.Provider,
  iface: utils.Interface,
  to: string,
  fn: string,
  args: unknown[] = []
): Promise<unknown> {
  const raw = await provider.call({
    to,
    data: iface.encodeFunctionData(fn, args),
  })
  return iface.decodeFunctionResult(fn, raw)[0]
}

// Reads the WalletState ordinal for a wallet public-key hash from the Bridge's
// `wallets(bytes20)` getter (index 7 of the returned struct).
async function readWalletState(
  provider: providers.Provider,
  walletHash: string
): Promise<number> {
  const raw = await provider.call({
    to: BRIDGE_PROXY,
    data: bridgeInterface.encodeFunctionData("wallets", [walletHash]),
  })
  const decoded = bridgeInterface.decodeFunctionResult("wallets", raw)
  return Number(decoded.state)
}

// Confirms every selector in `selectors` is (present ? found : absent) in the
// runtime bytecode. A selector's PUSH4 sequence appears in the dispatcher.
function assertSelectors(
  runtime: string,
  selectors: Record<string, string>,
  present: boolean
): void {
  const code = runtime.toLowerCase()
  // eslint-disable-next-line no-restricted-syntax
  for (const [sig, selector] of Object.entries(selectors)) {
    const needle = `63${selector.slice(2).toLowerCase()}` // PUSH4 <selector>
    const found = code.includes(needle) || code.includes(selector.slice(2))
    if (present && !found) {
      throw new Error(
        `Old implementation is missing expected selector ${selector} (${sig}).`
      )
    }
    if (!present && found) {
      throw new Error(
        `Old implementation unexpectedly exposes selector ${selector} (${sig}); ` +
          "it should only appear in the combined implementation."
      )
    }
  }
}

// Extracts a revert reason and raw revert data from a thrown provider.call error,
// tolerating the several shapes ethers/nodes use.
function extractRevert(err: unknown): { reason?: string; data?: string } {
  const anyErr = err as {
    reason?: string
    data?: string
    error?: { data?: string; message?: string }
    message?: string
  }
  const data =
    (typeof anyErr?.data === "string" && anyErr.data) ||
    (typeof anyErr?.error?.data === "string" && anyErr.error.data) ||
    undefined
  let reason = anyErr?.reason
  if (!reason && data && data.startsWith("0x08c379a0")) {
    try {
      reason = utils.defaultAbiCoder.decode(
        ["string"],
        `0x${data.slice(10)}`
      )[0] as string
    } catch {
      // leave reason undefined
    }
  }
  return { reason, data }
}

// Result of the 16 identity preflight checks (re-run immediately before the
// upgrade in execution mode).
interface PreflightResult {
  chainId: number
  deployer: string
  oldImpl: string
  oldImplRuntimeHash: string
  admin: string
  proxyAdminOwner: string
  governance: string
  registryAddress: string
  registryOwner: string
  g1Bank: string
}

// Runs all 16 immutable/mutable identity checks against live state and returns
// the derived values. Called once up front and, in execution mode, AGAIN
// immediately before sending `upgradeAndCall` so a state drift (implementation,
// admin, governance, controller, registry, or G1 wiring) between preparation and
// send aborts the upgrade instead of proceeding on stale assumptions.
async function runPreflight(
  hre: HardhatRuntimeEnvironment
): Promise<PreflightResult> {
  const { deployments, getNamedAccounts } = hre
  const { get } = deployments
  const { deployer } = await getNamedAccounts()
  const { provider } = hre.ethers

  // 1. Chain is exactly Sepolia.
  const chainId = Number(await hre.getChainId())
  if (chainId !== CHAIN_ID) {
    throw new Error(
      `Refusing Stage-3 combined upgrade: chain ${chainId} is not Sepolia ` +
        `(${CHAIN_ID}). This combined artifact is Sepolia-only.`
    )
  }

  // 2. The named deployer/signer is exactly the ProxyAdmin owner.
  if (utils.getAddress(deployer) !== utils.getAddress(PROXY_ADMIN_OWNER)) {
    throw new Error(
      `Refusing Stage-3 combined upgrade: deployer ${deployer} is not the ` +
        `ProxyAdmin owner ${PROXY_ADMIN_OWNER}.`
    )
  }

  // 3. Bridge proxy code exists.
  const bridgeCode = await provider.getCode(BRIDGE_PROXY)
  if (bridgeCode === "0x" || bridgeCode === "0x0") {
    throw new Error(`Bridge proxy ${BRIDGE_PROXY} has no code.`)
  }

  // 4. EIP-1967 implementation equals the pinned old implementation.
  const implSlot = await provider.getStorageAt(
    BRIDGE_PROXY,
    EIP_1967_IMPLEMENTATION_SLOT
  )
  const oldImpl = addressFromSlot(implSlot)
  if (oldImpl !== utils.getAddress(EXPECTED_OLD_IMPLEMENTATION)) {
    throw new Error(
      `EIP-1967 implementation ${oldImpl} is not the pinned old implementation ` +
        `${EXPECTED_OLD_IMPLEMENTATION}.`
    )
  }

  // 5. Old implementation runtime hash matches the pinned hash.
  const oldImplRuntime = await provider.getCode(oldImpl)
  const oldImplRuntimeHash = utils.keccak256(oldImplRuntime)
  if (oldImplRuntimeHash !== EXPECTED_OLD_RUNTIME_HASH) {
    throw new Error(
      `Old implementation runtime hash ${oldImplRuntimeHash} does not match the ` +
        `pinned hash ${EXPECTED_OLD_RUNTIME_HASH}.`
    )
  }

  // 6. EIP-1967 admin equals the pinned ProxyAdmin.
  const adminSlot = await provider.getStorageAt(
    BRIDGE_PROXY,
    EIP_1967_ADMIN_SLOT
  )
  const admin = addressFromSlot(adminSlot)
  if (admin !== utils.getAddress(PROXY_ADMIN)) {
    throw new Error(
      `EIP-1967 admin ${admin} is not the pinned ProxyAdmin ${PROXY_ADMIN}.`
    )
  }

  // 7. ProxyAdmin.owner() equals the pinned owner.
  const proxyAdminOwner = utils.getAddress(
    (await readCall(
      provider,
      proxyAdminInterface,
      PROXY_ADMIN,
      "owner"
    )) as string
  )
  if (proxyAdminOwner !== utils.getAddress(PROXY_ADMIN_OWNER)) {
    throw new Error(
      `ProxyAdmin.owner() ${proxyAdminOwner} is not the pinned owner ${PROXY_ADMIN_OWNER}.`
    )
  }

  // 8. Bridge.governance() equals the live BridgeGovernance.
  const governance = utils.getAddress(
    (await readCall(
      provider,
      bridgeInterface,
      BRIDGE_PROXY,
      "governance"
    )) as string
  )
  if (governance !== utils.getAddress(BRIDGE_GOVERNANCE)) {
    throw new Error(
      `Bridge.governance() ${governance} is not the pinned BridgeGovernance ` +
        `${BRIDGE_GOVERNANCE}.`
    )
  }

  // 9. Initializer slot 50 has low byte 5.
  const initSlot = await provider.getStorageAt(
    BRIDGE_PROXY,
    SLOT_INITIALIZER_VERSION
  )
  const initVersion = BigNumber.from(initSlot).and(0xff).toNumber()
  if (initVersion !== 5) {
    throw new Error(
      `Bridge initializer version is ${initVersion}, expected 5 before the ` +
        "version-6 combined upgrade."
    )
  }

  // 10. Both controller getters return G1.
  const mintingController = utils.getAddress(
    (await readCall(
      provider,
      bridgeInterface,
      BRIDGE_PROXY,
      "mintingController"
    )) as string
  )
  const getMintingController = utils.getAddress(
    (await readCall(
      provider,
      bridgeInterface,
      BRIDGE_PROXY,
      "getMintingController"
    )) as string
  )
  if (
    mintingController !== utils.getAddress(EXPECTED_MINTING_CONTROLLER) ||
    getMintingController !== utils.getAddress(EXPECTED_MINTING_CONTROLLER)
  ) {
    throw new Error(
      `Controller getters returned (${mintingController}, ${getMintingController}); ` +
        `expected both to be ${EXPECTED_MINTING_CONTROLLER}.`
    )
  }

  // 11. Raw absolute slot 81 contains G1.
  const slot81 = await provider.getStorageAt(
    BRIDGE_PROXY,
    SLOT_MINTING_CONTROLLER
  )
  if (
    addressFromSlot(slot81) !== utils.getAddress(EXPECTED_MINTING_CONTROLLER)
  ) {
    throw new Error(
      `Raw slot 81 holds ${addressFromSlot(slot81)}, expected the controller ` +
        `${EXPECTED_MINTING_CONTROLLER}.`
    )
  }

  // 12/13. Old implementation exposes all controller selectors and none of the
  // PR covenant/migration selectors.
  assertSelectors(oldImplRuntime, CONTROLLER_SELECTORS, true)
  assertSelectors(oldImplRuntime, PR_SELECTORS, false)

  // 14. G1 reports bridge/bank/mintingPaused as expected.
  const g1Bridge = utils.getAddress(
    (await readCall(
      provider,
      g1Interface,
      EXPECTED_MINTING_CONTROLLER,
      "bridge"
    )) as string
  )
  const g1Bank = utils.getAddress(
    (await readCall(
      provider,
      g1Interface,
      EXPECTED_MINTING_CONTROLLER,
      "bank"
    )) as string
  )
  const g1Paused = (await readCall(
    provider,
    g1Interface,
    EXPECTED_MINTING_CONTROLLER,
    "mintingPaused"
  )) as boolean
  if (
    g1Bridge !== utils.getAddress(BRIDGE_PROXY) ||
    g1Bank !== utils.getAddress(BANK) ||
    g1Paused !== false
  ) {
    throw new Error(
      `G1 wiring unexpected: bridge=${g1Bridge}, bank=${g1Bank}, paused=${g1Paused}.`
    )
  }

  // 15. Registry code exists and runtime hash matches the local artifact.
  let registryAddress: string
  try {
    registryAddress = (await get("CovenantSpendAuthorization")).address
  } catch {
    if (process.env.COVENANT_SPEND_AUTHORIZATION) {
      registryAddress = utils.getAddress(
        process.env.COVENANT_SPEND_AUTHORIZATION
      )
    } else {
      throw new Error(
        "CovenantSpendAuthorization deployment not found. Run script 87 first, " +
          "or set COVENANT_SPEND_AUTHORIZATION to its address."
      )
    }
  }
  const registryRuntime = await provider.getCode(registryAddress)
  if (registryRuntime === "0x" || registryRuntime === "0x0") {
    throw new Error(
      `CovenantSpendAuthorization ${registryAddress} has no runtime code.`
    )
  }
  const registryArtifact = await hre.artifacts.readArtifact(
    "contracts/bridge/CovenantSpendAuthorization.sol:CovenantSpendAuthorization"
  )
  if (
    utils.keccak256(registryRuntime) !==
    utils.keccak256(registryArtifact.deployedBytecode)
  ) {
    throw new Error(
      "Deployed CovenantSpendAuthorization runtime does not match the compiled " +
        "artifact; verify script 87 deployed the current source."
    )
  }

  // 16. Registry owner matches the requested owner.
  const requestedOwnerRaw = process.env.COVENANT_SPEND_AUTHORIZATION_OWNER
  if (!requestedOwnerRaw) {
    throw new Error(
      "COVENANT_SPEND_AUTHORIZATION_OWNER must be set so the registry owner can " +
        "be confirmed before the upgrade wires the registry."
    )
  }
  const registryOwner = utils.getAddress(
    (await readCall(
      provider,
      registryInterface,
      registryAddress,
      "owner"
    )) as string
  )
  if (registryOwner !== utils.getAddress(requestedOwnerRaw)) {
    throw new Error(
      `CovenantSpendAuthorization owner ${registryOwner} does not match the ` +
        `requested owner ${utils.getAddress(requestedOwnerRaw)}.`
    )
  }

  return {
    chainId,
    deployer,
    oldImpl,
    oldImplRuntimeHash,
    admin,
    proxyAdminOwner,
    governance,
    registryAddress,
    registryOwner,
    g1Bank,
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, artifacts } = hre
  const { deploy, get, save } = deployments
  const { ethers } = hre
  const { provider } = ethers

  const executeMode = process.env.EXECUTE_STAGE3_COMBINED_UPGRADE === "true"
  // Etherscan verification only makes sense on a real network; on a local/fork
  // network (used by the execution-mode unit test) there is no explorer.
  const isLiveNetwork =
    hre.network.name !== "hardhat" && hre.network.name !== "localhost"
  const etherscanApiKey = process.env.ETHERSCAN_API_KEY

  console.log(
    `\nStage-3 combined Bridge upgrade — ${
      executeMode ? "EXECUTION" : "PREPARATION"
    } mode`
  )

  // Fail fast: a live execution run must be able to verify the freshly deployed
  // libraries and implementation before the proxy is upgraded.
  if (executeMode && isLiveNetwork && !etherscanApiKey) {
    throw new Error(
      "Refusing EXECUTE mode on a live network without ETHERSCAN_API_KEY: the " +
        "seven libraries and the combined implementation must be Etherscan-" +
        "verified before the proxy is upgraded. Set ETHERSCAN_API_KEY and re-run."
    )
  }

  // =================================================================
  // PREFLIGHT (16 identity checks; run in both modes)
  // =================================================================
  const pre = await runPreflight(hre)
  const { deployer, registryAddress } = pre
  console.log("  preflight: all 16 identity checks passed")

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  // =================================================================
  // DEPLOY: seven fresh libraries + combined implementation
  // =================================================================
  const bridgeLibraries: Record<string, string> = {}
  // eslint-disable-next-line no-restricted-syntax
  for (const lib of STAGE3_LIBRARIES) {
    // eslint-disable-next-line no-await-in-loop
    const deployed = await deploy(lib.name, {
      ...deployOptions,
      contract: lib.contract,
      skipIfAlreadyDeployed: false,
    })
    bridgeLibraries[lib.key] = deployed.address
  }
  console.log("  deployed 7 fresh Stage-3 libraries")

  const bridgeImpl = await deploy(BRIDGE_IMPL_DEPLOYMENT, {
    ...deployOptions,
    contract: "Bridge",
    skipIfAlreadyDeployed: false,
    libraries: bridgeLibraries,
  })

  // ---- Size gate (measured from the actual deployed runtime) ----
  const implRuntime = await provider.getCode(bridgeImpl.address)
  if (implRuntime.includes("__$") || implRuntime.includes("__")) {
    throw new Error(
      "Combined implementation runtime contains an unresolved library placeholder."
    )
  }
  const implRuntimeSize = (implRuntime.length - 2) / 2
  if (implRuntimeSize >= EIP170_LIMIT) {
    throw new Error(
      `Combined implementation runtime is ${implRuntimeSize} bytes, at or above ` +
        `the EIP-170 limit ${EIP170_LIMIT}. Lower the Bridge optimizer-run ` +
        "override further; do not cut any controller/migration surface."
    )
  }
  const margin = EIP170_LIMIT - implRuntimeSize
  console.log(
    `  combined implementation runtime: ${implRuntimeSize} bytes (${margin} below limit)`
  )
  if (margin < PREFERRED_MARGIN) {
    console.log(
      `  WARNING: margin ${margin} is below the preferred ${PREFERRED_MARGIN} bytes.`
    )
  }

  // Runtime hashes for the summary / operator cross-checks.
  const libraryRuntimeHashes: Record<string, string> = {}
  // eslint-disable-next-line no-restricted-syntax
  for (const lib of STAGE3_LIBRARIES) {
    // eslint-disable-next-line no-await-in-loop
    const runtime = await provider.getCode(bridgeLibraries[lib.key])
    libraryRuntimeHashes[lib.key] = utils.keccak256(runtime)
  }
  const implRuntimeHash = utils.keccak256(implRuntime)

  // =================================================================
  // MIGRATION-INPUT SCANS (reuse the tested script-86 scanners)
  // =================================================================
  // Each computation re-reads the latest block and re-scans, so execution never
  // reuses a block/scan captured before deployment.
  async function computeMigrationInputs(): Promise<{
    openEscrow: BigNumber
    walletOrder: string[]
    scanToBlock: number
  }> {
    const scanToBlock = await provider.getBlockNumber()
    const openEscrow = await computeOpenFraudChallengeEscrow(
      provider,
      BRIDGE_PROXY,
      BRIDGE_DEPLOY_BLOCK,
      scanToBlock
    )
    const walletOrder = await computeWalletRegistrationOrder(
      provider,
      BRIDGE_PROXY,
      BRIDGE_DEPLOY_BLOCK,
      scanToBlock
    )
    // Reject duplicate public-key hashes.
    const seen = new Set<string>()
    // eslint-disable-next-line no-restricted-syntax
    for (const w of walletOrder) {
      const key = w.toLowerCase()
      if (seen.has(key)) {
        throw new Error(`Duplicate wallet public-key hash in scan: ${w}.`)
      }
      seen.add(key)
    }
    // Every scanned wallet must resolve to a real (non-Unknown) wallet; a hash
    // that does not is a scan/state mismatch that would seed a bogus order.
    // eslint-disable-next-line no-restricted-syntax
    for (const w of walletOrder) {
      // eslint-disable-next-line no-await-in-loop
      const state = await readWalletState(provider, w)
      if (state === WALLET_STATE_UNKNOWN) {
        throw new Error(
          `Scanned wallet ${w} resolves to an Unknown wallet state; the ` +
            "registration scan and on-chain wallet state disagree — re-run."
        )
      }
    }
    // Bridge ETH balance must be at least the computed open escrow. Surplus
    // (e.g. a post-scan deposit or forced/unattributed ETH) is allowed: the
    // on-chain migration conservatively seeds the full live balance, not this
    // lower-bound argument, so a balance above openEscrow cannot under-seed
    // the escrow accounting.
    const bridgeBalance = await provider.getBalance(BRIDGE_PROXY)
    if (bridgeBalance.lt(openEscrow)) {
      throw new Error(
        `Bridge ETH balance ${bridgeBalance.toString()} is below computed ` +
          `open escrow ${openEscrow.toString()}; a fraud challenge changed state ` +
          "mid-flight — re-run."
      )
    }
    // The list's final element must equal the active wallet (or, if empty, no
    // active wallet).
    const activeWallet = (await readCall(
      provider,
      bridgeInterface,
      BRIDGE_PROXY,
      "activeWalletPubKeyHash"
    )) as string
    if (walletOrder.length === 0) {
      if (BigNumber.from(activeWallet).gt(0)) {
        throw new Error(
          "Empty wallet-registration scan but the Bridge has an active wallet."
        )
      }
    } else if (
      walletOrder[walletOrder.length - 1].toLowerCase() !==
      activeWallet.toLowerCase()
    ) {
      throw new Error(
        `Wallet scan tail ${
          walletOrder[walletOrder.length - 1]
        } does not equal the active wallet ${activeWallet}; re-run.`
      )
    }
    return { openEscrow, walletOrder, scanToBlock }
  }

  const { openEscrow, walletOrder, scanToBlock } =
    await computeMigrationInputs()
  console.log(
    `  migration inputs: openEscrow=${openEscrow.toString()} wei, ` +
      `${walletOrder.length} wallets (scanned through block ${scanToBlock})`
  )

  // Reference initializer + upgrade calldata (for the summary / dry run).
  const referenceInitializerCalldata = bridgeInterface.encodeFunctionData(
    "initializeV6_Stage3Combined",
    [EXPECTED_MINTING_CONTROLLER, registryAddress, openEscrow, walletOrder]
  )
  const referenceUpgradeCalldata = proxyAdminInterface.encodeFunctionData(
    "upgradeAndCall",
    [BRIDGE_PROXY, bridgeImpl.address, referenceInitializerCalldata]
  )

  // ---- Etherscan V2 verification of the 7 libraries + implementation ----
  // A real gate on a live network with a key: each contract is verified against
  // its OWN build-info (correct runs/version) and the Bridge input carries the
  // deployed library addresses. Any failure throws and aborts before the upgrade.
  if (isLiveNetwork && etherscanApiKey) {
    const bridgeLinkLibraries: Record<string, Record<string, string>> = {}
    // eslint-disable-next-line no-restricted-syntax
    for (const lib of STAGE3_LIBRARIES) {
      bridgeLinkLibraries[lib.source] = {
        ...(bridgeLinkLibraries[lib.source] || {}),
        [lib.contract.includes(":")
          ? lib.contract.split(":")[1]
          : lib.contract]: bridgeLibraries[lib.key],
      }
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const lib of STAGE3_LIBRARIES) {
      const fqName = lib.contract.includes(":")
        ? lib.contract
        : `${lib.source}:${lib.contract}`
      console.log(`  verifying ${fqName} at ${bridgeLibraries[lib.key]} ...`)
      // eslint-disable-next-line no-await-in-loop
      await verifyDeployedContractOrThrow(hre, etherscanApiKey, pre.chainId, {
        address: bridgeLibraries[lib.key],
        fqName,
      })
    }
    console.log(`  verifying ${BRIDGE_FQ_NAME} at ${bridgeImpl.address} ...`)
    await verifyDeployedContractOrThrow(hre, etherscanApiKey, pre.chainId, {
      address: bridgeImpl.address,
      fqName: BRIDGE_FQ_NAME,
      libraries: bridgeLinkLibraries,
    })
    console.log("  Etherscan verification confirmed for all 8 contracts")
  } else if (isLiveNetwork) {
    console.log(
      "  ETHERSCAN_API_KEY not set; skipping verification (preparation only — " +
        "set it and verify before EXECUTE)."
    )
  }

  // =================================================================
  // SUMMARY (written in both modes)
  // =================================================================
  const summary: Record<string, unknown> = {
    network: hre.network.name,
    mode: executeMode ? "execution" : "preparation",
    timestamp: new Date().toISOString(),
    deployer,
    chainId: pre.chainId,
    bridgeProxy: BRIDGE_PROXY,
    oldImplementation: pre.oldImpl,
    oldImplementationRuntimeHash: pre.oldImplRuntimeHash,
    proxyAdmin: PROXY_ADMIN,
    proxyAdminOwner: pre.proxyAdminOwner,
    bridgeGovernance: pre.governance,
    mintingController: EXPECTED_MINTING_CONTROLLER,
    bank: pre.g1Bank,
    covenantSpendAuthorization: registryAddress,
    covenantSpendAuthorizationOwner: pre.registryOwner,
    libraries: bridgeLibraries,
    libraryRuntimeHashes,
    newImplementation: bridgeImpl.address,
    newImplementationRuntimeHash: implRuntimeHash,
    newImplementationRuntimeSize: implRuntimeSize,
    newImplementationMargin: margin,
    scan: {
      fromBlock: BRIDGE_DEPLOY_BLOCK,
      toBlock: scanToBlock,
      openFraudChallengeEscrowWei: openEscrow.toString(),
      walletRegistrationOrder: walletOrder,
    },
    initializerArgs: {
      expectedMintingController: EXPECTED_MINTING_CONTROLLER,
      covenantSpendAuthorization: registryAddress,
      preUpgradeOpenFraudChallengeEscrow: openEscrow.toString(),
      preUpgradeWallets: walletOrder,
    },
    referenceInitializerCalldata,
    referenceUpgradeCalldata,
  }

  if (!executeMode) {
    // Preparation mode ends here: everything is deployed and verified, but the
    // proxy is untouched. Do NOT persist executable calldata as the source of
    // truth for a later execution run — execution recomputes it.
    console.log(
      "\nPREPARATION complete. Re-run with EXECUTE_STAGE3_COMBINED_UPGRADE=true " +
        "to perform the atomic upgrade (preflights and inputs are recomputed)."
    )
    writeSummary(hre, summary)
    return
  }

  // =================================================================
  // EXECUTION: re-run preflight + recompute inputs, upgrade, assert post-state
  // =================================================================
  console.log(
    "\nEXECUTION: re-running all 16 preflights immediately before send"
  )
  const preSend = await runPreflight(hre)
  if (
    preSend.registryAddress.toLowerCase() !== registryAddress.toLowerCase() ||
    preSend.oldImpl.toLowerCase() !== pre.oldImpl.toLowerCase()
  ) {
    throw new Error(
      "Preflight drift between preparation and send: registry or old " +
        "implementation changed. Aborting the upgrade."
    )
  }
  console.log("  pre-send preflight: all 16 identity checks passed")

  console.log("  recomputing migration inputs immediately before send")
  const fresh = await computeMigrationInputs()
  const initializerCalldata = bridgeInterface.encodeFunctionData(
    "initializeV6_Stage3Combined",
    [
      EXPECTED_MINTING_CONTROLLER,
      preSend.registryAddress,
      fresh.openEscrow,
      fresh.walletOrder,
    ]
  )

  const proxyAdmin = new ethers.Contract(
    PROXY_ADMIN,
    PROXY_ADMIN_ABI,
    await ethers.getSigner(deployer)
  )
  console.log("  sending ProxyAdmin.upgradeAndCall ...")
  const tx = await proxyAdmin.upgradeAndCall(
    BRIDGE_PROXY,
    bridgeImpl.address,
    initializerCalldata
  )
  const receipt = await tx.wait(1)
  console.log(`  upgraded in tx ${receipt.transactionHash}`)

  // ---- Post-upgrade assertions (spec section 6) ----
  const newImplSlot = addressFromSlot(
    await provider.getStorageAt(BRIDGE_PROXY, EIP_1967_IMPLEMENTATION_SLOT)
  )
  if (newImplSlot !== utils.getAddress(bridgeImpl.address)) {
    throw new Error("Post-upgrade implementation slot mismatch.")
  }
  const newAdminSlot = addressFromSlot(
    await provider.getStorageAt(BRIDGE_PROXY, EIP_1967_ADMIN_SLOT)
  )
  if (newAdminSlot !== utils.getAddress(PROXY_ADMIN)) {
    throw new Error("Post-upgrade admin slot changed.")
  }
  const newInitVersion = BigNumber.from(
    await provider.getStorageAt(BRIDGE_PROXY, SLOT_INITIALIZER_VERSION)
  )
    .and(0xff)
    .toNumber()
  if (newInitVersion !== 6) {
    throw new Error(
      `Post-upgrade initializer version is ${newInitVersion}, expected 6.`
    )
  }
  // Governance unchanged.
  const postGovernance = utils.getAddress(
    (await readCall(
      provider,
      bridgeInterface,
      BRIDGE_PROXY,
      "governance"
    )) as string
  )
  if (postGovernance !== utils.getAddress(BRIDGE_GOVERNANCE)) {
    throw new Error(
      `Post-upgrade governance ${postGovernance} changed from ${BRIDGE_GOVERNANCE}.`
    )
  }
  // Both controller getters still return G1; raw slot 81 unchanged.
  const postSlot81 = addressFromSlot(
    await provider.getStorageAt(BRIDGE_PROXY, SLOT_MINTING_CONTROLLER)
  )
  const postMintingController = utils.getAddress(
    (await readCall(
      provider,
      bridgeInterface,
      BRIDGE_PROXY,
      "mintingController"
    )) as string
  )
  const postGetMintingController = utils.getAddress(
    (await readCall(
      provider,
      bridgeInterface,
      BRIDGE_PROXY,
      "getMintingController"
    )) as string
  )
  if (
    postSlot81 !== utils.getAddress(EXPECTED_MINTING_CONTROLLER) ||
    postMintingController !== utils.getAddress(EXPECTED_MINTING_CONTROLLER) ||
    postGetMintingController !== utils.getAddress(EXPECTED_MINTING_CONTROLLER)
  ) {
    throw new Error("Post-upgrade slot 81 / controller getters changed.")
  }
  // migrationDebtVault stays zero.
  const postMigrationDebtVault = (await readCall(
    provider,
    bridgeInterface,
    BRIDGE_PROXY,
    "migrationDebtVault"
  )) as string
  if (BigNumber.from(postMigrationDebtVault).gt(0)) {
    throw new Error(
      "Post-upgrade migrationDebtVault() is nonzero — layout regression."
    )
  }
  // Packed slot 130 == (uint160(registry) << 16) | flags(0x0101).
  const postSlot130 = BigNumber.from(
    await provider.getStorageAt(BRIDGE_PROXY, SLOT_PACKED_FLAGS_REGISTRY)
  )
  const expectedSlot130 = BigNumber.from(preSend.registryAddress)
    .shl(16)
    .or(0x0101)
  if (!postSlot130.eq(expectedSlot130)) {
    throw new Error(
      `Post-upgrade packed slot 130 is ${postSlot130.toHexString()}, expected ` +
        `${expectedSlot130.toHexString()} (registry << 16 | 0x0101).`
    )
  }
  // Events: only logs emitted BY THE BRIDGE PROXY count. A same-topic log from a
  // different address must never satisfy these assertions, so every check is
  // restricted to `address == BRIDGE_PROXY` and the indexed/data arguments are
  // ABI-decoded and matched exactly.
  const logs: Array<{ address?: string; topics?: string[]; data?: string }> =
    receipt.logs || []
  const bridgeLogs = logs.filter(
    (l) =>
      typeof l.address === "string" &&
      l.address.toLowerCase() === BRIDGE_PROXY.toLowerCase()
  )
  const covenantTopic = bridgeInterface.getEventTopic(
    "CovenantSpendAuthorizationUpdated"
  )
  const initializedTopic = bridgeInterface.getEventTopic("Initialized")
  const mintingControllerSetTopic = bridgeInterface.getEventTopic(
    "MintingControllerSet"
  )
  // CovenantSpendAuthorizationUpdated: emitted by the Bridge and carrying the
  // EXACT registry address that was sent to the reinitializer (not merely any
  // log with the same topic 0).
  const covenantLog = bridgeLogs.find((l) => l.topics?.[0] === covenantTopic)
  if (!covenantLog) {
    throw new Error(
      "Post-upgrade CovenantSpendAuthorizationUpdated not emitted by the Bridge proxy."
    )
  }
  const parsedCovenant = bridgeInterface.parseLog({
    topics: covenantLog.topics as string[],
    data: covenantLog.data ?? "0x",
  })
  const emittedRegistry = utils.getAddress(
    parsedCovenant.args.covenantSpendAuthorization as string
  )
  if (emittedRegistry !== utils.getAddress(preSend.registryAddress)) {
    throw new Error(
      `Post-upgrade CovenantSpendAuthorizationUpdated carried registry ${emittedRegistry}, ` +
        `expected the reinitialized registry ${utils.getAddress(
          preSend.registryAddress
        )}.`
    )
  }
  // Initialized: emitted by the Bridge with version EXACTLY 6.
  const initializedLog = bridgeLogs.find(
    (l) => l.topics?.[0] === initializedTopic
  )
  if (!initializedLog) {
    throw new Error("Post-upgrade Initialized not emitted by the Bridge proxy.")
  }
  const parsedInitialized = bridgeInterface.parseLog({
    topics: initializedLog.topics as string[],
    data: initializedLog.data ?? "0x",
  })
  if (BigNumber.from(parsedInitialized.args.version).toNumber() !== 6) {
    throw new Error(
      `Post-upgrade Initialized emitted version ${parsedInitialized.args.version}, expected 6.`
    )
  }
  // MintingControllerSet must NOT be emitted by the Bridge — the reinitializer
  // asserts the controller, it never re-sets it. Checked against Bridge logs
  // specifically, not the whole receipt.
  if (bridgeLogs.some((l) => l.topics?.[0] === mintingControllerSetTopic)) {
    throw new Error(
      "Post-upgrade MintingControllerSet was emitted by the Bridge — the " +
        "reinitializer must assert the controller, never re-set it."
    )
  }
  // Unauthorized controller call still reverts with the exact live message.
  try {
    await provider.call({
      to: BRIDGE_PROXY,
      data: bridgeInterface.encodeFunctionData("controllerIncreaseBalance", [
        EXPECTED_MINTING_CONTROLLER,
        1,
      ]),
    })
    throw new Error(
      "Post-upgrade unauthorized controllerIncreaseBalance did not revert."
    )
  } catch (err) {
    const { reason } = extractRevert(err)
    if (
      reason !== UNAUTHORIZED_CONTROLLER_REVERT &&
      !(err as Error).message?.includes(UNAUTHORIZED_CONTROLLER_REVERT)
    ) {
      throw new Error(
        "Post-upgrade unauthorized controller call reverted with an unexpected " +
          `reason: ${reason ?? (err as Error).message}.`
      )
    }
  }
  // Registry authorization/read path is callable and clean.
  const isAuthorizedForZero = (await readCall(
    provider,
    registryInterface,
    preSend.registryAddress,
    "isAuthorized",
    [
      0,
      "0x0000000000000000000000000000000000000000",
      0,
      utils.hexZeroPad("0x00", 32),
    ]
  )) as boolean
  if (isAuthorizedForZero !== false) {
    throw new Error(
      "Post-upgrade registry isAuthorized(empty) returned true; expected false."
    )
  }
  // The Bridge can accept a new fraud challenge: a static submitFraudChallenge
  // must NOT revert with FraudChallengeEscrowNotSeeded(), proving escrow seeding
  // enabled it. (It may still revert later on the dummy signature/deposit.)
  try {
    await provider.call({
      to: BRIDGE_PROXY,
      data: bridgeInterface.encodeFunctionData("submitFraudChallenge", [
        `0x${"11".repeat(64)}`,
        utils.hexZeroPad("0x00", 32),
        {
          r: utils.hexZeroPad("0x01", 32),
          s: utils.hexZeroPad("0x01", 32),
          v: 27,
        },
      ]),
    })
  } catch (err) {
    const { data } = extractRevert(err)
    if (
      typeof data === "string" &&
      data.toLowerCase().startsWith(FRAUD_ESCROW_NOT_SEEDED_SELECTOR)
    ) {
      throw new Error(
        "Post-upgrade submitFraudChallenge reverted with " +
          "FraudChallengeEscrowNotSeeded(); escrow seeding did not take effect."
      )
    }
  }
  console.log("  post-upgrade assertions passed")

  // Save the proxy artifact with the new ABI + implementation ONLY now.
  const bridgeArtifact = artifacts.readArtifactSync("Bridge")
  const existingBridge = await get("Bridge")
  await save("Bridge", {
    ...existingBridge,
    abi: bridgeArtifact.abi,
    implementation: bridgeImpl.address,
  })

  summary.upgradeTxHash = receipt.transactionHash
  summary.receiptBlock = receipt.blockNumber
  summary.executionScanToBlock = fresh.scanToBlock
  summary.postState = {
    implementation: newImplSlot,
    admin: newAdminSlot,
    initializerVersion: newInitVersion,
    governance: postGovernance,
    slot81Controller: postSlot81,
    migrationDebtVault: postMigrationDebtVault,
    packedSlot130: postSlot130.toHexString(),
  }
  writeSummary(hre, summary)
  console.log("\nEXECUTION complete.")
}

function writeSummary(
  hre: HardhatRuntimeEnvironment,
  summary: Record<string, unknown>
): void {
  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `stage3-combined-upgrade-${summary.mode}-${Date.now()}.json`
  )
  try {
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
    console.log(`Summary saved to: ${summaryPath}`)
  } catch (error) {
    console.log(`WARNING: failed to write summary: ${(error as Error).message}`)
  }
}

export default func

func.tags = ["UpgradeSepoliaBridgeStage3Combined"]
// Explicit opt-in to even PREPARE. A second flag
// (EXECUTE_STAGE3_COMBINED_UPGRADE=true) is required to actually upgrade.
func.skip = async () => process.env.DEPLOY_STAGE3_COMBINED_UPGRADE !== "true"
