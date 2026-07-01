import fs from "fs"
import path from "path"
import https from "https"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { BigNumber, providers, utils } from "ethers"

import {
  EIP_1967_ADMIN_SLOT,
  KNOWN_PROXY_ADMIN,
  KNOWN_TIMELOCK,
  KNOWN_COUNCIL_SAFE,
} from "./85_deploy_tip109_governance_upgrade"

const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
]

const BRIDGE_GOVERNANCE_ABI = [
  "function seedFraudChallengeEscrow(uint256 preUpgradeOpenEscrow)",
  "function beginBridgeGovernanceTransfer(address newBridgeGovernance)",
  "function finalizeBridgeGovernanceTransfer()",
  "function transferOwnership(address newOwner)",
  "function setVaultStatus(address vault, bool isTrusted)",
  "function setMigrationDebtVault(address vault)",
]

const TBTC_VAULT_ABI = [
  "function initiateUpgrade(address newVault)",
  "function finalizeUpgrade()",
  "function transferOwnership(address newOwner)",
]

// Read-only ABI for reconstructing the legacy TBTCVault's outstanding
// optimistic minting debt. The legacy mainnet vault predates the aggregate
// `hasOutstandingOptimisticMintingDebt()` selector and exposes only the
// per-depositor mapping, so the runbook derives the aggregate by scanning
// `OptimisticMintingFinalized` events for candidate depositors and reading the
// live per-depositor balance for each.
const TBTC_VAULT_OM_ABI = [
  "function optimisticMintingDebt(address depositor) view returns (uint256)",
  "event OptimisticMintingFinalized(address indexed minter, uint256 indexed depositKey, address indexed depositor, uint256 optimisticMintingDebt)",
]

const BRIDGE_EVENT_ABI = [
  "event FraudChallengeSubmitted(bytes20 indexed walletPubKeyHash, bytes32 sighash, uint8 v, bytes32 r, bytes32 s)",
  "event FraudChallengeDefeated(bytes20 indexed walletPubKeyHash, bytes32 sighash)",
  "event FraudChallengeDefeatTimedOut(bytes20 indexed walletPubKeyHash, bytes32 sighash)",
]

const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)
const bridgeGovernanceInterface = new utils.Interface(BRIDGE_GOVERNANCE_ABI)
const tbtcVaultInterface = new utils.Interface(TBTC_VAULT_ABI)
const tbtcVaultOmInterface = new utils.Interface(TBTC_VAULT_OM_ABI)
const bridgeEventInterface = new utils.Interface(BRIDGE_EVENT_ABI)
const FRAUD_LOG_SCAN_CHUNK_SIZE = 100000

function encodeUpgrade(proxy: string, newImpl: string): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [proxy, newImpl])
}

function encodeSeedFraudChallengeEscrow(
  preUpgradeOpenEscrow: BigNumber
): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "seedFraudChallengeEscrow",
    [preUpgradeOpenEscrow]
  )
}

function encodeBeginBridgeGovernanceTransfer(
  newBridgeGovernance: string
): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "beginBridgeGovernanceTransfer",
    [newBridgeGovernance]
  )
}

function encodeFinalizeBridgeGovernanceTransfer(): string {
  return bridgeGovernanceInterface.encodeFunctionData(
    "finalizeBridgeGovernanceTransfer",
    []
  )
}

function encodeTransferOwnership(newOwner: string): string {
  return bridgeGovernanceInterface.encodeFunctionData("transferOwnership", [
    newOwner,
  ])
}

function encodeSetVaultStatus(vault: string, isTrusted: boolean): string {
  return bridgeGovernanceInterface.encodeFunctionData("setVaultStatus", [
    vault,
    isTrusted,
  ])
}

function encodeSetMigrationDebtVault(vault: string): string {
  return bridgeGovernanceInterface.encodeFunctionData("setMigrationDebtVault", [
    vault,
  ])
}

function encodeInitiateVaultUpgrade(newVault: string): string {
  return tbtcVaultInterface.encodeFunctionData("initiateUpgrade", [newVault])
}

function encodeFinalizeVaultUpgrade(): string {
  return tbtcVaultInterface.encodeFunctionData("finalizeUpgrade", [])
}

function encodeTransferVaultOwnership(newOwner: string): string {
  return tbtcVaultInterface.encodeFunctionData("transferOwnership", [newOwner])
}

async function getFraudChallengeLogs(
  provider: providers.Provider,
  bridgeAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<providers.Log[]> {
  const topics = [
    [
      bridgeEventInterface.getEventTopic("FraudChallengeSubmitted"),
      bridgeEventInterface.getEventTopic("FraudChallengeDefeated"),
      bridgeEventInterface.getEventTopic("FraudChallengeDefeatTimedOut"),
    ],
  ]

  const logs: providers.Log[] = []

  for (let startBlock = fromBlock; startBlock <= toBlock; ) {
    const endBlock = Math.min(
      startBlock + FRAUD_LOG_SCAN_CHUNK_SIZE - 1,
      toBlock
    )

    // eslint-disable-next-line no-await-in-loop
    const chunk = await provider.getLogs({
      address: bridgeAddress,
      topics,
      fromBlock: startBlock,
      toBlock: endBlock,
    })
    logs.push(...chunk)

    startBlock = endBlock + 1
  }

  return logs.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber - right.blockNumber
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex
    }
    return left.logIndex - right.logIndex
  })
}

/**
 * Reconstructs the set of depositors that still carry nonzero optimistic
 * minting debt on the given (legacy) TBTCVault. The legacy mainnet vault is an
 * immutable, non-proxy contract that predates the aggregate
 * `hasOutstandingOptimisticMintingDebt()` selector and exposes only the
 * per-depositor `optimisticMintingDebt(address)` mapping. The aggregate signal
 * is rebuilt in two steps: scan `OptimisticMintingFinalized` events to
 * enumerate every depositor ever assigned optimistic minting debt, then read
 * the live per-depositor balance for each and keep the ones that are still
 * nonzero. Repaid debt is captured implicitly because the mapping read
 * reflects current on-chain state; the event scan only bounds the candidate
 * depositor set.
 */
async function computeOutstandingOptimisticMintingDebt(
  provider: providers.Provider,
  vaultAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<{ depositor: string; debt: BigNumber }[]> {
  const topics = [
    tbtcVaultOmInterface.getEventTopic("OptimisticMintingFinalized"),
  ]

  const logs: providers.Log[] = []

  for (let startBlock = fromBlock; startBlock <= toBlock; ) {
    const endBlock = Math.min(
      startBlock + FRAUD_LOG_SCAN_CHUNK_SIZE - 1,
      toBlock
    )

    // eslint-disable-next-line no-await-in-loop
    const chunk = await provider.getLogs({
      address: vaultAddress,
      topics,
      fromBlock: startBlock,
      toBlock: endBlock,
    })
    logs.push(...chunk)

    startBlock = endBlock + 1
  }

  const depositors = new Set<string>()
  // eslint-disable-next-line no-restricted-syntax
  for (const log of logs) {
    const parsed = tbtcVaultOmInterface.parseLog(log)
    depositors.add(utils.getAddress(String(parsed.args.depositor)))
  }

  const outstanding: { depositor: string; debt: BigNumber }[] = []
  // eslint-disable-next-line no-restricted-syntax
  for (const depositor of depositors) {
    const callData = tbtcVaultOmInterface.encodeFunctionData(
      "optimisticMintingDebt",
      [depositor]
    )
    // eslint-disable-next-line no-await-in-loop
    const raw = await provider.call({ to: vaultAddress, data: callData })
    const [debt] = tbtcVaultOmInterface.decodeFunctionResult(
      "optimisticMintingDebt",
      raw
    ) as [BigNumber]
    if (debt.gt(0)) {
      outstanding.push({ depositor, debt })
    }
  }

  return outstanding
}

async function computeOpenFraudChallengeEscrow(
  provider: providers.Provider,
  bridgeAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<BigNumber> {
  const logs = await getFraudChallengeLogs(
    provider,
    bridgeAddress,
    fromBlock,
    toBlock
  )
  const openChallenges = new Map<string, BigNumber>()
  const txValues = new Map<string, BigNumber>()
  let openEscrow = BigNumber.from(0)

  // eslint-disable-next-line no-restricted-syntax
  for (const log of logs) {
    const parsed = bridgeEventInterface.parseLog(log)
    const challengeKey = `${String(
      parsed.args.walletPubKeyHash
    ).toLowerCase()}:${String(parsed.args.sighash).toLowerCase()}`

    if (parsed.name === "FraudChallengeSubmitted") {
      let txValue = txValues.get(log.transactionHash)
      if (!txValue) {
        // eslint-disable-next-line no-await-in-loop
        const tx = await provider.getTransaction(log.transactionHash)
        if (!tx) {
          throw new Error(`Missing transaction ${log.transactionHash}`)
        }
        if (tx.to?.toLowerCase() !== bridgeAddress.toLowerCase()) {
          throw new Error(
            `Fraud challenge ${challengeKey} was not submitted directly to ` +
              "the Bridge; compute the escrow seed with transaction traces"
          )
        }

        txValue = tx.value
        txValues.set(log.transactionHash, txValue)
      }

      if (openChallenges.has(challengeKey)) {
        throw new Error(`Duplicate open fraud challenge ${challengeKey}`)
      }

      openChallenges.set(challengeKey, txValue)
      openEscrow = openEscrow.add(txValue)
    } else {
      const txValue = openChallenges.get(challengeKey)
      if (!txValue) {
        throw new Error(`Resolved unknown fraud challenge ${challengeKey}`)
      }

      openChallenges.delete(challengeKey)
      openEscrow = openEscrow.sub(txValue)
    }
  }

  return openEscrow
}

/**
 * Submits a contract for source verification on Etherscan using the v2 API.
 * The legacy v1 API used by @nomiclabs/hardhat-etherscan is deprecated.
 */
async function etherscanVerifyV2(
  apiKey: string,
  chainId: number,
  contractAddress: string,
  contractName: string,
  compilerVersion: string,
  solcInputJson: string
): Promise<string> {
  const queryString = `chainid=${chainId}`
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
    runs: "1000",
  }).toString()

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.etherscan.io",
        path: `/v2/api?${queryString}`,
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
            if (parsed.status === "1" && parsed.result) {
              resolve(parsed.result)
            } else {
              reject(
                new Error(parsed.result || parsed.message || "Unknown error")
              )
            }
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

  // Patch ethers.js v5 Formatter to handle empty-string `to` field returned
  // by some RPC providers for contract-creation transactions. Without this
  // patch, hardhat-deploy fails with "invalid address" on deploy receipts.
  // Same pattern used in cross-chain Wormhole V2 upgrade scripts.
  const originalFormat = providers.Formatter.prototype.transactionResponse
  providers.Formatter.prototype.transactionResponse = function (tx: any): any {
    const patched = tx.to === "" ? { ...tx, to: null } : tx
    return originalFormat.call(this, patched)
  }

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  console.log("=".repeat(80))
  console.log("TIP-109 Hotfix Deployment")
  console.log("Fixes: missing forceStakeTransfer (PR #939)")
  console.log("       missing zero-address redeemer guard (PR #940)")
  console.log("=".repeat(80))
  console.log(`Network: ${hre.network.name}`)
  console.log(`Deployer: ${deployer}`)

  // --- Step 1: Deploy updated deposit libraries ---
  // The Bridge implementation must link to the versions compiled from this
  // tree. Reusing old mainnet deployments would bypass migration-debt logic.
  console.log("\n--- Deploying updated deposit libraries ---")
  const Deposit = await deploy("DepositTIP109Hotfix", {
    ...deployOptions,
    contract: "Deposit",
    skipIfAlreadyDeployed: false,
  })

  const DepositSweep = await deploy("DepositSweepTIP109Hotfix", {
    ...deployOptions,
    contract: "DepositSweep",
    skipIfAlreadyDeployed: false,
  })

  // --- Step 2: Deploy new Redemption library (PR #940) ---
  console.log("\n--- Deploying new Redemption library ---")
  const Redemption = await deploy("RedemptionTIP109Hotfix", {
    ...deployOptions,
    contract: "Redemption",
    skipIfAlreadyDeployed: false,
  })

  // --- Step 3: Deploy new Fraud library ---
  console.log("\n--- Deploying new Fraud library ---")
  const Fraud = await deploy("FraudTIP109Hotfix", {
    ...deployOptions,
    contract: "Fraud",
    skipIfAlreadyDeployed: false,
  })

  // --- Step 4: Resolve unchanged existing libraries ---
  console.log("\n--- Resolving existing libraries ---")
  const Wallets = await get("Wallets")
  const MovingFunds = await get("MovingFunds")

  // --- Step 5: Deploy new Bridge implementation ---
  // Linked to fresh deployments for every modified linked library.
  console.log("\n--- Deploying Bridge implementation ---")
  const bridgeLibraries = {
    Deposit: Deposit.address,
    DepositSweep: DepositSweep.address,
    Redemption: Redemption.address,
    Wallets: Wallets.address,
    Fraud: Fraud.address,
    MovingFunds: MovingFunds.address,
  }

  const bridgeImpl = await deploy("BridgeTIP109HotfixImplementation", {
    ...deployOptions,
    contract: "Bridge",
    skipIfAlreadyDeployed: false,
    libraries: bridgeLibraries,
  })

  // --- Step 6: Deploy new RebateStaking implementation (PR #939) ---
  console.log("\n--- Deploying RebateStaking implementation ---")
  const rebateImpl = await deploy("RebateStakingTIP109HotfixImplementation", {
    ...deployOptions,
    contract: "RebateStaking",
    skipIfAlreadyDeployed: false,
  })

  // --- Deployment Summary ---
  console.log(`\n${"-".repeat(80)}`)
  console.log("Deployed contract addresses:")
  console.log(`  Deposit library (NEW):         ${Deposit.address}`)
  console.log(`  DepositSweep library (NEW):    ${DepositSweep.address}`)
  console.log(`  Redemption library (NEW):      ${Redemption.address}`)
  console.log(`  Fraud library (NEW):           ${Fraud.address}`)
  console.log(`  Bridge implementation (NEW):   ${bridgeImpl.address}`)
  console.log(`  RebateStaking impl (NEW):      ${rebateImpl.address}`)
  console.log("-".repeat(80))

  // --- Step 7: Update proxy deployment artifacts ---
  // Following the pattern from Wormhole V2 upgrade scripts: update the
  // proxy artifact with the new implementation address and ABI so that
  // hardhat-deploy and downstream tooling reflect the upgraded state.
  console.log("\n--- Updating proxy deployment artifacts ---")

  const Bridge = await get("Bridge")
  const RebateStaking = await get("RebateStaking")
  const BridgeGovernance = await get("BridgeGovernance")

  // --- Step 7a: Deploy a new BridgeGovernance (PR #957) ---
  // The existing mainnet BridgeGovernance predates `seedFraudChallengeEscrow`
  // and has no fallback, so routing the post-upgrade seed call at it would
  // revert and leave `fraudChallengeEscrowSeeded` false — permanently blocking
  // all new fraud challenges. Deploy a fresh BridgeGovernance built from this
  // tree (which forwards `seedFraudChallengeEscrow` to the Bridge), preserving
  // the current governance delay, so governance can transfer Bridge ownership
  // to it before seeding.
  console.log("\n--- Deploying new BridgeGovernance ---")
  const existingBridgeGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    BridgeGovernance.address
  )
  const bridgeGovernanceDelay = await existingBridgeGovernance.governanceDelays(
    0
  )
  console.log(
    `  Preserving governance delay: ${bridgeGovernanceDelay.toString()}s`
  )
  const newBridgeGovernance = await deploy("BridgeGovernanceTIP109Hotfix", {
    ...deployOptions,
    contract: "BridgeGovernance",
    skipIfAlreadyDeployed: false,
    args: [Bridge.address, bridgeGovernanceDelay],
  })
  console.log(`  New BridgeGovernance: ${newBridgeGovernance.address}`)

  // --- Step 7b: Deploy a new migration-debt TBTCVault (PR #957) ---
  // The existing mainnet TBTCVault predates the migration-debt read interface
  // (`hasOutstandingMigrationDebt`, `isMigrationRevealer`, `canRevealMigration`),
  // so the upgraded Bridge would reject it as the canonical migration debt
  // vault (`MigrationDebtVaultInterfaceMissing`). Deploy a fresh TBTCVault
  // built from this tree, wired to the same Bank, TBTC token, and Bridge, so
  // governance can complete the non-proxy vault rotation and activate the
  // migration-debt path.
  console.log("\n--- Deploying new migration-debt TBTCVault ---")
  const Bank = await get("Bank")
  const TBTCToken = await get("TBTC")
  const TBTCVault = await get("TBTCVault")
  const newTBTCVault = await deploy("TBTCVaultTIP109Hotfix", {
    ...deployOptions,
    contract: "TBTCVault",
    skipIfAlreadyDeployed: false,
    args: [Bank.address, TBTCToken.address, Bridge.address],
  })
  console.log(`  New TBTCVault: ${newTBTCVault.address}`)

  const bridgeArtifact = artifacts.readArtifactSync("Bridge")
  await save("Bridge", {
    ...Bridge,
    abi: bridgeArtifact.abi,
    implementation: bridgeImpl.address,
  })
  console.log(`  Bridge proxy artifact updated (impl → ${bridgeImpl.address})`)

  const rebateArtifact = artifacts.readArtifactSync("RebateStaking")
  await save("RebateStaking", {
    ...RebateStaking,
    abi: rebateArtifact.abi,
    implementation: rebateImpl.address,
  })
  console.log(
    `  RebateStaking proxy artifact updated (impl → ${rebateImpl.address})`
  )

  // --- Step 8: Discover ProxyAdmin and generate calldata ---
  console.log("\n--- Discovering ProxyAdmin ---")
  const adminData = await ethers.provider.getStorageAt(
    Bridge.address,
    EIP_1967_ADMIN_SLOT
  )
  const proxyAdminAddress = ethers.utils.getAddress(`0x${adminData.slice(26)}`)
  console.log(`  ProxyAdmin: ${proxyAdminAddress}`)

  if (proxyAdminAddress.toLowerCase() !== KNOWN_PROXY_ADMIN.toLowerCase()) {
    console.log(`  WARNING: does not match known ${KNOWN_PROXY_ADMIN}`)
  }

  console.log("\n--- Generating governance calldata ---")

  const latestBlock = await ethers.provider.getBlockNumber()
  const fraudScanFromBlock = Number(
    process.env.BRIDGE_FRAUD_EVENT_FROM_BLOCK ||
      Bridge.receipt?.blockNumber ||
      0
  )
  const preUpgradeOpenEscrow = await computeOpenFraudChallengeEscrow(
    ethers.provider,
    Bridge.address,
    fraudScanFromBlock,
    latestBlock
  )
  console.log(
    `  Fraud challenge escrow seed at block ${latestBlock}: ` +
      `${preUpgradeOpenEscrow.toString()} wei`
  )
  console.log(
    "  Recompute this seed immediately after the Bridge upgrade executes " +
      "and before calling seedFraudChallengeEscrow."
  )
  console.log(
    "  recoverETH and new fraud challenges remain disabled until the seed " +
      "call succeeds."
  )

  const rebateUpgradeCalldata = encodeUpgrade(
    RebateStaking.address,
    rebateImpl.address
  )
  console.log("\n  Timelock Action [0]: RebateStaking upgrade")
  console.log(`    Target: ProxyAdmin (${proxyAdminAddress})`)
  console.log(`    Calldata: ${rebateUpgradeCalldata}`)
  console.log(`    Selector: ${rebateUpgradeCalldata.slice(0, 10)}`)
  console.log(`    Proxy: ${RebateStaking.address}`)
  console.log(`    New impl: ${rebateImpl.address}`)

  const bridgeUpgradeCalldata = encodeUpgrade(
    Bridge.address,
    bridgeImpl.address
  )
  console.log("\n  Timelock Action [1]: Bridge upgrade")
  console.log(`    Target: ProxyAdmin (${proxyAdminAddress})`)
  console.log(`    Calldata: ${bridgeUpgradeCalldata}`)
  console.log(`    Selector: ${bridgeUpgradeCalldata.slice(0, 10)}`)
  console.log(`    Proxy: ${Bridge.address}`)
  console.log(`    New impl: ${bridgeImpl.address}`)

  // The executable seed calldata is intentionally NOT precomputed and saved.
  // The open pre-upgrade fraud-challenge escrow can grow between this script's
  // run and the post-upgrade seed execution, because new pre-upgrade challenges
  // can still be opened during the governance timelock delay. Persisting a
  // fixed value would let a stale, under-counted seed be executed, which
  // understates `openFraudChallengeEscrow`, exposes challenger deposits to
  // `recoverETH`, and can underflow later challenge resolution.
  // --- BridgeGovernance transfer calldata (finding TOB-18) ---
  // Governance must transfer Bridge ownership to the new BridgeGovernance
  // before the seed action, otherwise `seedFraudChallengeEscrow` (forwarded to
  // the Bridge's `onlyGovernance` entry point) reverts. The freshly deployed
  // BridgeGovernance is owned by the deployer, so its ownership is first handed
  // to the Council Safe.
  // `KNOWN_COUNCIL_SAFE` is stored without an EIP-55 checksum; normalize it to
  // its canonical checksummed form before ABI-encoding it as an address arg.
  const councilSafeAddress = utils.getAddress(KNOWN_COUNCIL_SAFE.toLowerCase())
  const newBridgeGovernanceOwnershipCalldata =
    encodeTransferOwnership(councilSafeAddress)
  const beginBridgeGovernanceTransferCalldata =
    encodeBeginBridgeGovernanceTransfer(newBridgeGovernance.address)
  const finalizeBridgeGovernanceTransferCalldata =
    encodeFinalizeBridgeGovernanceTransfer()

  console.log("\n  Deployer Action: transfer new BridgeGovernance ownership")
  console.log(
    `    Target: new BridgeGovernance (${newBridgeGovernance.address})`
  )
  console.log(`    New owner: Council Safe (${KNOWN_COUNCIL_SAFE})`)

  console.log("\n  Council Safe Action [A]: beginBridgeGovernanceTransfer")
  console.log(
    `    Target: existing BridgeGovernance (${BridgeGovernance.address})`
  )
  console.log(`    New BridgeGovernance: ${newBridgeGovernance.address}`)
  console.log(
    `    Then, after ${bridgeGovernanceDelay.toString()}s, call ` +
      "finalizeBridgeGovernanceTransfer on the existing BridgeGovernance."
  )

  const referenceSeedCalldata =
    encodeSeedFraudChallengeEscrow(preUpgradeOpenEscrow)
  console.log(
    "\n  Council Safe Action [B]: seedFraudChallengeEscrow (RECOMPUTE REQUIRED)"
  )
  console.log(
    `    Target: new BridgeGovernance (${newBridgeGovernance.address})`
  )
  console.log(
    "    Only after the Bridge upgrade AND the BridgeGovernance transfer above."
  )
  console.log("    Recompute the open escrow immediately before execution and")
  console.log("    encode seedFraudChallengeEscrow with that fresh value.")
  console.log(
    `    Reference-only calldata (DO NOT EXECUTE AS-IS): ${referenceSeedCalldata}`
  )
  console.log(
    `    Reference-only seed: ${preUpgradeOpenEscrow.toString()} wei ` +
      `(scanned blocks ${fraudScanFromBlock}..${latestBlock})`
  )

  // --- Migration-debt TBTCVault activation calldata (finding TOB-17) ---
  // Complete the non-proxy TBTCVault rotation, then trust the new vault and
  // set it as the Bridge's canonical migration debt vault so migration reveals
  // can be activated. `setMigrationDebtVault` requires the vault to be trusted
  // and to expose the migration-debt interface, so the ordering below matters.
  const initiateVaultUpgradeCalldata = encodeInitiateVaultUpgrade(
    newTBTCVault.address
  )
  const finalizeVaultUpgradeCalldata = encodeFinalizeVaultUpgrade()
  const trustNewVaultCalldata = encodeSetVaultStatus(newTBTCVault.address, true)
  const setMigrationDebtVaultCalldata = encodeSetMigrationDebtVault(
    newTBTCVault.address
  )

  // The new TBTCVault is deployed by the deployer EOA, so OpenZeppelin Ownable
  // sets the deployer as its owner. `finalizeUpgrade` moves TBTC ownership and
  // the full Bank balance to this vault, making it canonical, so its owner-only
  // surface (addMinter, setAccountControlRedemptionNotifier,
  // activateAccountControlReconciliation, setMigrationRevealer, and the
  // migration-debt operations) must be handed to governance. Transfer its
  // ownership to the Council Safe, matching the new BridgeGovernance handoff and
  // the existing standalone TBTCVault ownership-transfer convention, and run it
  // before finalizeUpgrade so the canonical vault is governance-owned the moment
  // TBTC ownership and the Bank balance move to it.
  const transferNewVaultOwnershipCalldata =
    encodeTransferVaultOwnership(councilSafeAddress)

  // --- Legacy TBTCVault outstanding optimistic minting debt precondition ---
  // The finalizeUpgrade guard that blocks finalization while optimistic minting
  // debt is outstanding lives in the NEW TBTCVault bytecode, but the runbook
  // runs finalizeUpgrade against the LEGACY vault, whose immutable, non-proxy
  // bytecode predates that guard and never runs it. The legacy vault also
  // predates the aggregate optimistic-minting-debt selector, so the runbook
  // reconstructs the aggregate from the per-depositor mapping and gates the
  // finalize action on zero outstanding debt. This is a reference snapshot
  // only: the operator MUST recompute it immediately before executing
  // finalizeUpgrade, because new optimistic mints can finalize on the legacy
  // vault during the 24h vault governance delay.
  const legacyVaultOmEventFromBlock = Number(
    process.env.TBTCVAULT_OM_EVENT_FROM_BLOCK ||
      TBTCVault.receipt?.blockNumber ||
      0
  )
  const legacyOutstandingOmDebt = await computeOutstandingOptimisticMintingDebt(
    ethers.provider,
    TBTCVault.address,
    legacyVaultOmEventFromBlock,
    latestBlock
  )
  const legacyOutstandingOmDebtors = legacyOutstandingOmDebt.map((entry) => ({
    depositor: entry.depositor,
    debt: entry.debt.toString(),
  }))
  console.log("\n--- Legacy TBTCVault outstanding optimistic minting debt ---")
  console.log(
    `  ${legacyOutstandingOmDebt.length} depositor(s) with nonzero debt at ` +
      `block ${latestBlock} (scanned from block ${legacyVaultOmEventFromBlock})`
  )
  if (legacyOutstandingOmDebt.length > 0) {
    console.log(
      "  BLOCKING: the legacy TBTCVault still carries outstanding optimistic " +
        "minting debt. finalizeUpgrade would strand that debt on the legacy " +
        "vault and re-open the double-mint footgun. Do NOT execute the " +
        "finalizeUpgrade action until every listed depositor's " +
        "optimisticMintingDebt reads zero."
    )
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of legacyOutstandingOmDebtors) {
      console.log(`    depositor ${entry.depositor}: ${entry.debt}`)
    }
  }
  console.log(
    "  Bridge untrust/rotation guard note: the Bridge optimistic-minting-debt " +
      "check is a fail-open staticcall and does NOT fire for the legacy vault " +
      "(the selector is absent). Before untrusting the legacy vault or " +
      "rotating the canonical migration debt pointer away from it, manually " +
      "verify this debt set is empty using the same scan."
  )

  console.log("\n  TBTCVault Owner Action [A]: initiateUpgrade(newTBTCVault)")
  console.log(`    Target: existing TBTCVault (${TBTCVault.address})`)
  console.log(`    New TBTCVault: ${newTBTCVault.address}`)
  console.log(
    "    Then, after the 24h vault governance delay, call finalizeUpgrade() " +
      "on the existing TBTCVault."
  )
  console.log(
    "\n  Deployer Action: transfer new TBTCVault ownership to the Council Safe"
  )
  console.log(`    Target: new TBTCVault (${newTBTCVault.address})`)
  console.log(`    New owner: Council Safe (${KNOWN_COUNCIL_SAFE})`)
  console.log(
    "    Run before finalizeUpgrade so the canonical vault is governance-owned " +
      "the moment TBTC ownership and the Bank balance move to it."
  )
  console.log(
    "\n  Council Safe Action [C]: trust and activate the new TBTCVault"
  )
  console.log(
    `    Via new BridgeGovernance (${newBridgeGovernance.address}): ` +
      "setVaultStatus(newTBTCVault, true) then setMigrationDebtVault(newTBTCVault)"
  )

  // --- Step 9: Save deployment summary JSON ---
  const chainId = await hre.getChainId()

  const deploymentSummary = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer,
    chainId,
    purpose:
      "TIP-109 hotfix: add forceStakeTransfer (PR #939) and " +
      "zero-address redeemer guard (PR #940), with fresh Bridge " +
      "libraries for migration-debt and fraud-escrow changes",
    deployedContracts: {
      DepositTIP109Hotfix: Deposit.address,
      DepositSweepTIP109Hotfix: DepositSweep.address,
      RedemptionTIP109Hotfix: Redemption.address,
      FraudTIP109Hotfix: Fraud.address,
      BridgeTIP109HotfixImplementation: bridgeImpl.address,
      RebateStakingTIP109HotfixImplementation: rebateImpl.address,
      BridgeGovernanceTIP109Hotfix: newBridgeGovernance.address,
      TBTCVaultTIP109Hotfix: newTBTCVault.address,
    },
    reusedContracts: {
      Wallets: Wallets.address,
      MovingFunds: MovingFunds.address,
    },
    existingContracts: {
      Bridge: Bridge.address,
      ProxyAdmin: proxyAdminAddress,
      Timelock: KNOWN_TIMELOCK,
      CouncilSafe: KNOWN_COUNCIL_SAFE,
      RebateStaking: RebateStaking.address,
      BridgeGovernance: BridgeGovernance.address,
      TBTCVault: TBTCVault.address,
      Bank: Bank.address,
      TBTC: TBTCToken.address,
    },
    // Complete the non-proxy TBTCVault rotation, then trust and activate the
    // new migration-debt vault. `initiateUpgrade`/`finalizeUpgrade` are run by
    // the TBTCVault owner; the trust/activate steps go through the new
    // BridgeGovernance (after governance has been transferred to it). Ordering
    // is required: finalizeUpgrade only after the 24h vault delay, and
    // setMigrationDebtVault only after setVaultStatus trusts the new vault.
    tbtcVaultMigrationActions: [
      {
        target: TBTCVault.address,
        data: initiateVaultUpgradeCalldata,
        value: 0,
        description:
          "TBTCVault owner: initiate the upgrade to the new migration-debt " +
          "TBTCVault",
      },
      {
        target: newTBTCVault.address,
        data: transferNewVaultOwnershipCalldata,
        value: 0,
        description:
          "Deployer: transfer ownership of the new TBTCVault to the Council " +
          "Safe. Run before finalizeUpgrade so the canonical vault's owner-only " +
          "functions (addMinter, setAccountControlRedemptionNotifier, " +
          "activateAccountControlReconciliation, setMigrationRevealer, and the " +
          "migration-debt operations) are governance-controlled the moment TBTC " +
          "ownership and the Bank balance move to it",
      },
      {
        target: TBTCVault.address,
        data: finalizeVaultUpgradeCalldata,
        value: 0,
        governanceDelaySeconds: "86400",
        // HARD PRECONDITION: the legacy TBTCVault is immutable and predates the
        // finalizeUpgrade optimistic-minting-debt guard, so nothing on-chain
        // blocks a finalize that strands outstanding optimistic minting debt.
        // The operator MUST recompute the outstanding-debt set immediately
        // before execution (the legacy vault can finalize new optimistic mints
        // during the 24h delay) and MUST NOT execute this action while any
        // depositor still reports nonzero optimisticMintingDebt.
        requiresRecomputation: true,
        precondition:
          "Legacy TBTCVault must have zero outstanding optimistic minting " +
          "debt. Recompute by scanning OptimisticMintingFinalized events on " +
          "the legacy TBTCVault, then read optimisticMintingDebt(depositor) " +
          "for every emitted depositor; all must read zero before finalizing.",
        omDebtScan: {
          fromBlock: legacyVaultOmEventFromBlock,
          referenceToBlock: latestBlock,
          referenceOutstandingDepositorCount: legacyOutstandingOmDebt.length,
          referenceOutstandingDepositors: legacyOutstandingOmDebtors,
        },
        description:
          "TBTCVault owner: after the 24h vault governance delay, finalize " +
          "the upgrade, transferring TBTC ownership and Bank balance to the " +
          "new vault. BLOCKED until the legacy vault's outstanding optimistic " +
          "minting debt is zero (see precondition).",
      },
      {
        target: newBridgeGovernance.address,
        data: trustNewVaultCalldata,
        value: 0,
        description:
          "Council Safe (via new BridgeGovernance): trust the new TBTCVault",
      },
      {
        target: newBridgeGovernance.address,
        data: setMigrationDebtVaultCalldata,
        value: 0,
        description:
          "Council Safe (via new BridgeGovernance): set the new TBTCVault as " +
          "the canonical Bridge migration debt vault",
      },
    ],
    // The Bridge optimistic-minting-debt untrust/rotation guard uses a
    // fail-open staticcall against `hasOutstandingOptimisticMintingDebt()`. The
    // legacy TBTCVault predates that selector, so the guard is a no-op for it:
    // untrusting or rotating away from the legacy vault while it still holds
    // optimistic minting debt would be silently allowed and re-open the
    // double-mint footgun. Before ever untrusting the legacy vault or rotating
    // the canonical migration debt pointer away from it, governance MUST
    // manually verify the legacy vault has zero outstanding optimistic minting
    // debt using the per-depositor scan below. A correctly executed
    // finalizeUpgrade precondition already drives the legacy vault to zero
    // debt, and finalizeUpgrade removes its TBTC mint authority, so it cannot
    // accrue new optimistic minting debt afterward.
    legacyVaultUntrustPrecondition: {
      vault: TBTCVault.address,
      guard:
        "Bridge.setVaultStatus / rotateMigrationDebtVault fail-open " +
        "optimistic-minting-debt check does not fire for the legacy vault",
      requirement:
        "Manually verify zero outstanding optimistic minting debt on the " +
        "legacy TBTCVault (scan OptimisticMintingFinalized events, then read " +
        "optimisticMintingDebt(depositor) for each emitted depositor) before " +
        "untrusting it or rotating the canonical migration debt vault away " +
        "from it.",
      omDebtScan: {
        fromBlock: legacyVaultOmEventFromBlock,
        referenceToBlock: latestBlock,
        referenceOutstandingDepositorCount: legacyOutstandingOmDebt.length,
        referenceOutstandingDepositors: legacyOutstandingOmDebtors,
      },
    },
    // The Council Safe must run these BridgeGovernance actions, in order,
    // before the post-upgrade seed action. Without them the seed call reverts
    // (the existing BridgeGovernance lacks `seedFraudChallengeEscrow`), leaving
    // fraud challenges permanently disabled after the Bridge upgrade.
    deployerActions: [
      {
        target: newBridgeGovernance.address,
        data: newBridgeGovernanceOwnershipCalldata,
        value: 0,
        description:
          "Transfer ownership of the new BridgeGovernance from the deployer " +
          "to the Council Safe so it can run seedFraudChallengeEscrow",
      },
    ],
    bridgeGovernanceTransferActions: [
      {
        target: BridgeGovernance.address,
        data: beginBridgeGovernanceTransferCalldata,
        value: 0,
        description:
          "Council Safe: begin transferring Bridge governance to the new " +
          "BridgeGovernance (existing BridgeGovernance.onlyOwner)",
      },
      {
        target: BridgeGovernance.address,
        data: finalizeBridgeGovernanceTransferCalldata,
        value: 0,
        governanceDelaySeconds: bridgeGovernanceDelay.toString(),
        description:
          "Council Safe: after the governance delay, finalize the transfer, " +
          "handing Bridge governance to the new BridgeGovernance",
      },
    ],
    timelockActions: [
      {
        target: proxyAdminAddress,
        data: rebateUpgradeCalldata,
        value: 0,
        description: "RebateStaking proxy upgrade via ProxyAdmin.upgrade()",
      },
      {
        target: proxyAdminAddress,
        data: bridgeUpgradeCalldata,
        value: 0,
        description: "Bridge proxy upgrade via ProxyAdmin.upgrade()",
      },
    ],
    postUpgradeActions: [
      {
        // Route the seed at the NEW BridgeGovernance, which forwards it to the
        // upgraded Bridge. It is executable only after both the Bridge upgrade
        // and the BridgeGovernance transfer above have completed.
        target: newBridgeGovernance.address,
        // Executable calldata is intentionally omitted so a stale, precomputed
        // seed value cannot be copied into the Council Safe action. The seed
        // must be recomputed immediately before execution (see below) and the
        // calldata encoded from the freshly computed open escrow at that time.
        function: "seedFraudChallengeEscrow(uint256)",
        requiresRecomputation: true,
        value: 0,
        description:
          "Recompute the open pre-upgrade fraud challenge escrow immediately " +
          "before execution by scanning fraud challenge events from " +
          "`eventScan.fromBlock` to the current chain head, then encode " +
          "seedFraudChallengeEscrow with that value. Do not reuse the " +
          "reference values below.",
        eventScan: {
          fromBlock: fraudScanFromBlock,
          referenceToBlock: latestBlock,
          referenceOpenEscrowWei: preUpgradeOpenEscrow.toString(),
        },
      },
    ],
    libraries: bridgeLibraries,
  }

  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `tip109-hotfix-deployment-${Date.now()}.json`
  )

  try {
    fs.writeFileSync(summaryPath, JSON.stringify(deploymentSummary, null, 2))
    console.log(`\nDeployment summary saved to: ${summaryPath}`)
  } catch (error) {
    console.log(`WARNING: Failed to write summary: ${(error as Error).message}`)
  }

  console.log(`\n${"=".repeat(80)}`)
  console.log("DEPLOYMENT SUMMARY")
  console.log("=".repeat(80))
  console.log(`  Network:  ${hre.network.name}`)
  console.log(`  Chain ID: ${chainId}`)
  console.log(`  Deployer: ${deployer}`)
  console.log(`  Summary:  ${summaryPath}`)
  // Print the runbook in execution order. The BridgeGovernance transfer must
  // land BEFORE the Bridge upgrade: the upgraded Bridge blocks new fraud
  // challenges until the escrow is seeded, and only the new BridgeGovernance
  // exposes seedFraudChallengeEscrow. Transferring governance first lets the
  // seed run immediately after the upgrade instead of leaving fraud challenges
  // disabled for the whole governance-transfer delay.
  console.log(
    "\n  STEP 1 - Pre-upgrade Council Safe actions (transfer Bridge governance):"
  )
  console.log(
    "    [A] beginBridgeGovernanceTransfer on the existing BridgeGovernance"
  )
  console.log(`        To: ${BridgeGovernance.address}`)
  console.log(`        New BridgeGovernance: ${newBridgeGovernance.address}`)
  console.log(
    "    [B] finalizeBridgeGovernanceTransfer on the existing BridgeGovernance"
  )
  console.log(`        To: ${BridgeGovernance.address}`)
  console.log(
    "        Run [A] and [B] BEFORE the STEP 2 Bridge upgrade so the new"
  )
  console.log(
    "        BridgeGovernance owns the Bridge and the STEP 3 seed can execute"
  )
  console.log(
    "        immediately after the upgrade, not after the transfer delay."
  )
  console.log("\n  STEP 2 - Timelock Actions (minDelay=86400s / 24h):")
  console.log("    [0] RebateStaking upgrade (plain)")
  console.log(`        Proxy: ${RebateStaking.address}`)
  console.log(`        New impl: ${rebateImpl.address}`)
  console.log("    [1] Bridge upgrade (plain)")
  console.log(`        Proxy: ${Bridge.address}`)
  console.log(`        New impl: ${bridgeImpl.address}`)
  console.log(
    "\n  STEP 3 - Post-upgrade Council Safe actions (run immediately after STEP 2):"
  )
  console.log("    [C] seedFraudChallengeEscrow on the NEW BridgeGovernance")
  console.log(`        To: ${newBridgeGovernance.address}`)
  console.log(
    "        Seed: RECOMPUTE the open pre-upgrade escrow immediately before"
  )
  console.log(
    "              executing this action. Do NOT reuse an earlier snapshot;"
  )
  console.log(
    "              new pre-upgrade challenges may open during the timelock delay."
  )
  console.log(
    `        Reference-only snapshot (NOT executable): ${preUpgradeOpenEscrow.toString()} wei`
  )
  console.log("=".repeat(80))

  // --- Step 10: Verify contracts on Etherscan (v2 API) ---
  if (hre.network.tags.etherscan) {
    const etherscanApiKey = process.env.ETHERSCAN_API_KEY
    if (!etherscanApiKey) {
      console.log(
        "\nSkipping Etherscan verification: ETHERSCAN_API_KEY not set"
      )
    } else {
      console.log("\n--- Verifying contracts on Etherscan (v2 API) ---")

      const buildInfoDir = path.join(__dirname, "..", "build", "build-info")
      const buildInfoFiles = fs
        .readdirSync(buildInfoDir)
        .filter((f) => f.endsWith(".json"))

      let solcInput: string | null = null
      let compilerVersion = ""

      // eslint-disable-next-line no-restricted-syntax
      for (const biFile of buildInfoFiles) {
        const bi = JSON.parse(
          fs.readFileSync(path.join(buildInfoDir, biFile), "utf-8")
        )
        if (bi.output?.contracts?.["contracts/bridge/Deposit.sol"]?.Deposit) {
          solcInput = JSON.stringify(bi.input)
          compilerVersion = `v${bi.solcVersion}`
          break
        }
      }

      if (!solcInput) {
        console.log("  Could not find build-info. Skipping verification.")
      } else {
        const networkChainId = parseInt(await hre.getChainId(), 10)
        const contractsToVerify = [
          {
            address: Deposit.address,
            name: "contracts/bridge/Deposit.sol:Deposit",
            label: "Deposit",
          },
          {
            address: DepositSweep.address,
            name: "contracts/bridge/DepositSweep.sol:DepositSweep",
            label: "DepositSweep",
          },
          {
            address: Redemption.address,
            name: "contracts/bridge/Redemption.sol:Redemption",
            label: "Redemption",
          },
          {
            address: Fraud.address,
            name: "contracts/bridge/Fraud.sol:Fraud",
            label: "Fraud",
          },
          {
            address: bridgeImpl.address,
            name: "contracts/bridge/Bridge.sol:Bridge",
            label: "Bridge",
          },
          {
            address: rebateImpl.address,
            name: "contracts/bridge/RebateStaking.sol:RebateStaking",
            label: "RebateStaking",
          },
        ]

        // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
        for (const contract of contractsToVerify) {
          console.log(`Verifying ${contract.label} at ${contract.address}...`)
          try {
            // eslint-disable-next-line no-await-in-loop
            const guid = await etherscanVerifyV2(
              etherscanApiKey,
              networkChainId,
              contract.address,
              contract.name,
              compilerVersion,
              solcInput
            )
            console.log(`  Submitted: GUID=${guid}`)
          } catch (err) {
            console.log(`  Verification failed: ${(err as Error).message}`)
          }
        }
      }
    }
  }
}

export default func

func.tags = ["DeployTIP109Hotfix"]
func.skip = async () => process.env.DEPLOY_TIP109_HOTFIX !== "true"
