import fs from "fs"
import path from "path"
import https from "https"
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

// [NEW-STAGE3] Two-mode upgrade of the live Sepolia Bridge proxy to the combined
// implementation that carries BOTH the reconstructed account-control
// controller-mint surface (already live at implementation 0xa14a9607…) AND the
// reviewed PR covenant/migration surface, wired atomically by the version-6
// reinitializer. Preparation mode (default) deploys and verifies the new
// artifacts, computes reference calldata, and records a summary WITHOUT touching
// the proxy. Execution mode (EXECUTE_STAGE3_COMBINED_UPGRADE=true) re-derives
// every mutable input immediately before sending ProxyAdmin.upgradeAndCall.
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
// canonical linker names; `contract` is the real library source.
const STAGE3_LIBRARIES: Array<{ key: string; name: string; contract: string }> =
  [
    { key: "Deposit", name: "DepositStage3Combined", contract: "Deposit" },
    {
      key: "DepositSweep",
      name: "DepositSweepStage3Combined",
      contract: "DepositSweep",
    },
    {
      key: "Redemption",
      name: "RedemptionStage3Combined",
      contract: "Redemption",
    },
    {
      key: "Wallets",
      name: "WalletsStage3Combined",
      contract: "contracts/bridge/Wallets.sol:Wallets",
    },
    { key: "Fraud", name: "FraudStage3Combined", contract: "Fraud" },
    {
      key: "MovingFunds",
      name: "MovingFundsStage3Combined",
      contract: "MovingFunds",
    },
    {
      key: "VaultManagement",
      name: "VaultManagementStage3Combined",
      contract: "VaultManagement",
    },
  ]

const BRIDGE_IMPL_DEPLOYMENT = "BridgeStage3CombinedImplementation"

const EIP170_LIMIT = 24576
const PREFERRED_MARGIN = 128
const ETHERSCAN_V2_HOST = "api.etherscan.io"

// Minimal ABIs for the live-state reads and the upgrade call.
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
  "function initializeV6_Stage3Combined(address expectedMintingController, address covenantSpendAuthorization_, uint256 preUpgradeOpenFraudChallengeEscrow, bytes20[] preUpgradeWallets)",
]
const G1_ABI = [
  "function bridge() view returns (address)",
  "function bank() view returns (address)",
  "function mintingPaused() view returns (bool)",
]
const REGISTRY_ABI = ["function owner() view returns (address)"]

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

// Submits a Solidity standard-JSON-input verification to the Etherscan V2 API.
async function etherscanVerifyV2(
  apiKey: string,
  chainId: number,
  contractAddress: string,
  contractName: string,
  compilerVersion: string,
  solcInputJson: string
): Promise<string> {
  const postData = new URLSearchParams({
    apikey: apiKey,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: contractAddress,
    sourceCode: solcInputJson,
    codeformat: "solidity-standard-json-input",
    contractname: contractName,
    compilerversion: compilerVersion,
    optimizationUsed: "1",
    runs: "1",
  }).toString()

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: ETHERSCAN_V2_HOST,
        path: `/v2/api?chainid=${chainId}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk) => {
          data += chunk
        })
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.status === "1" && parsed.result) resolve(parsed.result)
            else
              reject(
                new Error(parsed.result || parsed.message || "Unknown error")
              )
          } catch {
            reject(new Error(`Invalid response: ${data.substring(0, 200)}`))
          }
        })
      }
    )
    req.on("error", reject)
    req.write(postData)
    req.end()
  })
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, artifacts } = hre
  const { deploy, get, save } = deployments
  const { deployer } = await getNamedAccounts()
  const { ethers } = hre
  const { provider } = ethers

  const executeMode = process.env.EXECUTE_STAGE3_COMBINED_UPGRADE === "true"

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  console.log(
    `\nStage-3 combined Bridge upgrade — ${
      executeMode ? "EXECUTION" : "PREPARATION"
    } mode`
  )

  // =================================================================
  // PREFLIGHT (immutable identity checks; run in both modes)
  // =================================================================

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
  const registryArtifact = await artifacts.readArtifact(
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

  console.log("  preflight: all 16 identity checks passed")

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

  // =================================================================
  // MIGRATION-INPUT SCANS (reuse the tested script-86 scanners)
  // =================================================================
  const scanToBlock = await provider.getBlockNumber()

  async function computeMigrationInputs(): Promise<{
    openEscrow: BigNumber
    walletOrder: string[]
  }> {
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
    // Bridge ETH balance must equal the computed open escrow.
    const bridgeBalance = await provider.getBalance(BRIDGE_PROXY)
    if (!bridgeBalance.eq(openEscrow)) {
      throw new Error(
        `Bridge ETH balance ${bridgeBalance.toString()} does not equal computed ` +
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
    return { openEscrow, walletOrder }
  }

  const { openEscrow, walletOrder } = await computeMigrationInputs()
  console.log(
    `  migration inputs: openEscrow=${openEscrow.toString()} wei, ` +
      `${walletOrder.length} wallets`
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
  if (hre.network.tags.etherscan && process.env.ETHERSCAN_API_KEY) {
    const apiKey = process.env.ETHERSCAN_API_KEY
    const buildInfoDir = path.join(__dirname, "..", "build", "build-info")
    let solcInput: string | null = null
    let compilerVersion = ""
    // eslint-disable-next-line no-restricted-syntax
    for (const biFile of fs
      .readdirSync(buildInfoDir)
      .filter((f) => f.endsWith(".json"))) {
      const bi = JSON.parse(
        fs.readFileSync(path.join(buildInfoDir, biFile), "utf-8")
      )
      if (bi.output?.contracts?.["contracts/bridge/Bridge.sol"]?.Bridge) {
        solcInput = JSON.stringify(bi.input)
        compilerVersion = `v${bi.solcVersion}`
        break
      }
    }
    if (solcInput) {
      const toVerify = [
        ...STAGE3_LIBRARIES.map((l) => ({
          address: bridgeLibraries[l.key],
          name:
            l.contract.includes(":") === true
              ? l.contract
              : `contracts/bridge/${l.contract}.sol:${l.contract}`,
        })),
        {
          address: bridgeImpl.address,
          name: "contracts/bridge/Bridge.sol:Bridge",
        },
      ]
      // eslint-disable-next-line no-restricted-syntax
      for (const c of toVerify) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const guid = await etherscanVerifyV2(
            apiKey,
            chainId,
            c.address,
            c.name,
            compilerVersion,
            solcInput
          )
          console.log(`  verification submitted for ${c.name}: ${guid}`)
        } catch (err) {
          console.log(
            `  verification failed for ${c.name}: ${(err as Error).message}`
          )
        }
      }
    }
  }

  // =================================================================
  // SUMMARY (written in both modes)
  // =================================================================
  const summary: Record<string, unknown> = {
    network: hre.network.name,
    mode: executeMode ? "execution" : "preparation",
    timestamp: new Date().toISOString(),
    deployer,
    chainId,
    bridgeProxy: BRIDGE_PROXY,
    oldImplementation: oldImpl,
    oldImplementationRuntimeHash: oldImplRuntimeHash,
    proxyAdmin: PROXY_ADMIN,
    proxyAdminOwner,
    bridgeGovernance: governance,
    mintingController: EXPECTED_MINTING_CONTROLLER,
    bank: g1Bank,
    covenantSpendAuthorization: registryAddress,
    covenantSpendAuthorizationOwner: registryOwner,
    libraries: bridgeLibraries,
    newImplementation: bridgeImpl.address,
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
        "to perform the atomic upgrade (inputs are recomputed at that time)."
    )
    writeSummary(hre, summary)
    return
  }

  // =================================================================
  // EXECUTION: recompute inputs, upgrade, assert post-state
  // =================================================================
  console.log(
    "\nEXECUTION: recomputing migration inputs immediately before send"
  )
  const fresh = await computeMigrationInputs()
  const initializerCalldata = bridgeInterface.encodeFunctionData(
    "initializeV6_Stage3Combined",
    [
      EXPECTED_MINTING_CONTROLLER,
      registryAddress,
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

  // ---- Post-upgrade assertions ----
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
  const postSlot81 = addressFromSlot(
    await provider.getStorageAt(BRIDGE_PROXY, SLOT_MINTING_CONTROLLER)
  )
  if (postSlot81 !== utils.getAddress(EXPECTED_MINTING_CONTROLLER)) {
    throw new Error("Post-upgrade slot 81 (controller) changed.")
  }
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
  summary.postState = {
    implementation: newImplSlot,
    admin: newAdminSlot,
    initializerVersion: newInitVersion,
    slot81Controller: postSlot81,
    migrationDebtVault: postMigrationDebtVault,
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
// [NEW-STAGE3] Explicit opt-in to even PREPARE. A second flag
// (EXECUTE_STAGE3_COMBINED_UPGRADE=true) is required to actually upgrade.
func.skip = async () => process.env.DEPLOY_STAGE3_COMBINED_UPGRADE !== "true"
