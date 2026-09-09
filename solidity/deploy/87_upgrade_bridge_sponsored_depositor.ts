import fs from "fs"
import path from "path"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { utils } from "ethers"

/**
 * @notice This deployment script upgrades the Bridge contract to add sponsored
 *         depositor support, and upgrades the RebateStaking contract to add
 *         sponsor authorization support. The Bridge upgrade enables the
 *         `sponsoredDepositors` allowlist used by `NativeBTCDepositor` to
 *         route rebate consumption to a staker address decoded from deposit
 *         `extraData`. The RebateStaking upgrade enables the
 *         `stakerSponsorConsent` mapping stakers use to authorize a
 *         sponsored depositor to route rebate consumption to their stake.
 *         Both proxies must be upgraded together: Deposit.sol's sponsored
 *         depositor routing calls `RebateStaking.isSponsorConsentGranted()`,
 *         which does not exist on the currently deployed implementation.
 *
 * @dev IMPORTANT DEPLOYMENT NOTES:
 *
 * MAINNET:
 * - Both the Bridge and RebateStaking upgrades MUST go through the
 *   Timelock contract (24h delay)
 * - Council multisig (6-of-9) schedules and executes via Timelock
 * - The follow-up governance call to setSponsoredDepositor is a direct
 *   onlyOwner call on BridgeGovernance (no begin/finalize delay)
 * - Timeline: ~24-36 hours total (schedule + 24h delay + execute)
 *
 * SEPOLIA (for upgrade mechanism testing):
 * - No Timelock required, direct EOA upgrade
 * - The governance call can be executed directly
 *
 * Context:
 * - PR #970 adds a `sponsoredDepositors` mapping to Bridge storage and a
 *   `setSponsoredDepositor` function on BridgeGovernance
 * - PR #970 also adds a `stakerSponsorConsent` mapping to RebateStaking
 *   storage and `setSponsorConsent` / `isSponsorConsentGranted` functions
 * - The `NativeBTCDepositor` proxy at KNOWN_NATIVE_BTC_DEPOSITOR must be
 *   added to the allowlist after the upgrade for rebate routing to work
 * - This script generates the calldata for both proxy upgrades and the
 *   BridgeGovernance action; actual execution is a separate governance/
 *   multisig operation
 *
 * Usage:
 *   # For Sepolia (testing upgrade mechanism):
 *   DEPLOY_SPONSORED_DEPOSITOR=true yarn deploy --tags UpgradeBridgeSponsoredDepositor --network sepolia
 *
 *   # For Mainnet (production - requires Timelock):
 *   DEPLOY_SPONSORED_DEPOSITOR=true yarn deploy --tags UpgradeBridgeSponsoredDepositor --network mainnet
 *   # Then execute the logged calldata via Council Safe -> Timelock -> ProxyAdmin
 *   # and the BridgeGovernance calldata via Council Safe directly
 */

// EIP-1967 transparent proxy admin storage slot. Defined by the standard
// at https://eips.ethereum.org/EIPS/eip-1967#admin-address and used to
// discover the ProxyAdmin address from any transparent proxy.
export const EIP_1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

// EIP-1967 implementation storage slot. Defined by the standard at
// https://eips.ethereum.org/EIPS/eip-1967#logic-contract-address and used
// to verify proxy upgrade targets.
export const EIP_1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

// Known ProxyAdmin address on mainnet. Used for validation after on-chain
// discovery (log-only warning, not a hard failure if mismatched).
export const KNOWN_PROXY_ADMIN = "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706"

// Known mainnet Timelock Controller address. Owner of the ProxyAdmin,
// used for scheduling and executing proxy upgrades with a 24h delay.
export const KNOWN_TIMELOCK = "0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D"

// Known mainnet Council Safe (6/9 multisig). Proposer and executor
// on the Timelock, and owner of BridgeGovernance.
export const KNOWN_COUNCIL_SAFE = "0x9F6e831c8f8939dc0c830c6e492e7cef4f9c2f5f"

// Known mainnet NativeBTCDepositor proxy address. This is the depositor
// contract that must be added to the sponsoredDepositors allowlist after
// the Bridge upgrade for rebate routing via extraData to function.
export const KNOWN_NATIVE_BTC_DEPOSITOR =
  "0xad7c6d46f4a4bc2d3a227067d03218d6d7c9aaa5"

// Known mainnet RebateStaking proxy address. This proxy must be upgraded
// alongside the Bridge proxy: Deposit.sol's sponsored depositor routing
// calls RebateStaking.isSponsorConsentGranted(), which does not exist on the
// currently deployed RebateStaking implementation.
export const KNOWN_REBATE_STAKING_PROXY =
  "0x0184739C32edc3471D3e4860c8E39a5f3Ff85A45"

// ABI fragments for calldata encoding. These are the minimal function
// signatures needed to generate governance calldata without importing
// full contract artifacts.
const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
]

const BRIDGE_GOVERNANCE_ABI = [
  "function setSponsoredDepositor(address depositor, bool sponsored)",
]

// Shared interface instances used by both helper functions and the main
// deployment function for calldata encoding.
const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)
const bridgeGovInterface = new utils.Interface(BRIDGE_GOVERNANCE_ABI)

/**
 * Encodes ProxyAdmin.upgrade() calldata for upgrading the Bridge proxy to
 * the new implementation. The new `sponsoredDepositors` mapping added by
 * this upgrade is a plain Solidity mapping and zero-defaults to empty, so
 * no post-upgrade initializer call is required.
 * @param bridgeProxy - Address of the Bridge proxy contract
 * @param newBridgeImpl - Address of the new Bridge implementation
 * @returns ABI-encoded calldata for ProxyAdmin.upgrade(proxy, implementation)
 */
export function encodeBridgeUpgrade(
  bridgeProxy: string,
  newBridgeImpl: string
): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [
    bridgeProxy,
    newBridgeImpl,
  ])
}

/**
 * Encodes ProxyAdmin.upgrade() calldata for upgrading the RebateStaking
 * proxy to the new implementation. The new `stakerSponsorConsent` mapping
 * added by this upgrade is a plain Solidity mapping and zero-defaults to
 * empty, so no post-upgrade initializer call is required.
 * @param rebateStakingProxy - Address of the RebateStaking proxy contract
 * @param newRebateStakingImpl - Address of the new RebateStaking implementation
 * @returns ABI-encoded calldata for ProxyAdmin.upgrade(proxy, implementation)
 */
export function encodeRebateStakingUpgrade(
  rebateStakingProxy: string,
  newRebateStakingImpl: string
): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [
    rebateStakingProxy,
    newRebateStakingImpl,
  ])
}

/**
 * Encodes BridgeGovernance.setSponsoredDepositor() calldata. This is a direct
 * onlyOwner call (NOT routed through begin/finalize governance delay).
 * @param depositor - Address of the depositor contract to allowlist/remove
 * @param sponsored - New allowlist membership state
 * @returns ABI-encoded calldata for BridgeGovernance.setSponsoredDepositor(address,bool)
 */
export function encodeSetSponsoredDepositor(
  depositor: string,
  sponsored: boolean
): string {
  return bridgeGovInterface.encodeFunctionData("setSponsoredDepositor", [
    depositor,
    sponsored,
  ])
}

/** Structure for a post-deployment verification check entry. */
interface VerificationCheck {
  command: string
  expectedResult: string
  description: string
}

/** Logs a governance calldata action with consistent formatting. */
function logCalldataAction(
  label: string,
  target: string,
  targetName: string,
  calldata: string,
  details: Record<string, string>
): void {
  console.log(`\n  ${label}`)
  console.log(`    Target: ${targetName} (${target})`)
  console.log(`    Calldata: ${calldata}`)
  console.log(`    Selector: ${calldata.slice(0, 10)}`)
  Object.entries(details).forEach(([key, value]) => {
    console.log(`    ${key}: ${value}`)
  })
}

/** Builds the array of post-deployment verification checks. */
function buildVerificationChecks(addresses: {
  bridgeProxy: string
  bridgeImpl: string
  rebateStakingProxy: string
  rebateStakingImpl: string
}): VerificationCheck[] {
  return [
    {
      command: `cast call ${addresses.bridgeProxy} "isSponsoredDepositor(address)(bool)" ${KNOWN_NATIVE_BTC_DEPOSITOR}`,
      expectedResult: "true",
      description:
        "After BridgeGovernance.setSponsoredDepositor call, NativeBTCDepositor should be on the allowlist",
    },
    {
      command: `cast code ${addresses.bridgeImpl}`,
      expectedResult:
        "Bytecode should contain the sponsoredDepositors storage layout",
      description:
        "Bridge implementation bytecode should contain the new sponsored depositor functionality",
    },
    {
      command: `cast call ${addresses.bridgeProxy} "deposits(uint256)(bytes32,uint32,uint64,uint32,address,uint32)" <sample_deposit_key>`,
      expectedResult: "Existing deposit data unchanged after upgrade",
      description:
        "Existing deposits should remain unaffected by the Bridge upgrade",
    },
    {
      command:
        `cast storage ${addresses.bridgeProxy} 79 && ` +
        `cast storage ${addresses.bridgeProxy} 80 && ` +
        `cast storage ${addresses.bridgeProxy} 81`,
      expectedResult:
        "Slot 79 = redemptionWatchtower address, " +
        "slot 80 = rebateStaking address, " +
        "slot 81 = sponsoredDepositors mapping base (reads zero, mappings " +
        "are unrepresented at their base slot), " +
        "slots 82-128 = zero (__gap[47], reduced from 48 to make room for " +
        "the new mapping)",
      description:
        "Bridge storage layout: slot 79=redemptionWatchtower, slot 80=rebateStaking, slot 81=sponsoredDepositors mapping base, slots 82-128=__gap[47] (reduced from 48); total struct footprint unchanged",
    },
    {
      command: `cast storage ${addresses.rebateStakingProxy} ${EIP_1967_IMPLEMENTATION_SLOT}`,
      expectedResult: `Should contain ${addresses.rebateStakingImpl} (padded to 32 bytes)`,
      description:
        "RebateStaking proxy EIP-1967 implementation pointer should reference the newly deployed implementation",
    },
    {
      command:
        `cast call ${addresses.rebateStakingProxy} "isSponsorConsentGranted(address,address)(bool)" ` +
        `<sample_staker> ${KNOWN_NATIVE_BTC_DEPOSITOR}`,
      expectedResult: "false (no authorization set for un-configured stakers)",
      description:
        "RebateStaking implementation should expose isSponsorConsentGranted() and preserve default false state after upgrade",
    },
  ]
}

/** Prints all verification checks to console with numbered formatting. */
function logVerificationChecks(checks: VerificationCheck[]): void {
  console.log(`\n${"=".repeat(80)}`)
  console.log("POST-DEPLOYMENT VERIFICATION COMMANDS")
  console.log("=".repeat(80))
  checks.forEach((check, index) => {
    console.log(`\n  [${index + 1}] ${check.description}`)
    console.log(`      Command: ${check.command}`)
    console.log(`      Expected: ${check.expectedResult}`)
  })
  console.log(`\n${"=".repeat(80)}`)
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy, get } = deployments
  const { deployer } = await getNamedAccounts()
  const { ethers } = hre

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  console.log("=".repeat(80))
  console.log("Bridge Sponsored Depositor Upgrade Deployment")
  console.log("=".repeat(80))
  console.log(`Network: ${hre.network.name}`)
  console.log(`Deployer: ${deployer}`)

  // --- Step 1: Deploy updated library, resolve unchanged libraries ---
  // Deposit has the sponsored-depositor rebate routing changes (an
  // external library the Bridge contract calls via
  // `using Deposit for BridgeState.Storage` + DELEGATECALL) and requires a
  // fresh deployment so the new behavior is linked into the Bridge
  // implementation below. DepositSweep, Redemption, Wallets, Fraud, and
  // MovingFunds have NOT changed since last deployment and are reused from
  // existing deployment artifacts.
  console.log(
    "\n--- Deploying updated library / resolving unchanged libraries ---"
  )
  const previousDeposit = await get("Deposit")
  const Deposit = await deploy("Deposit", deployOptions)
  if (Deposit.address.toLowerCase() === previousDeposit.address.toLowerCase()) {
    throw new Error(
      "Deposit library address unchanged after redeploy - sponsored-routing behavior will not activate"
    )
  }
  const DepositSweep = await get("DepositSweep")
  const Redemption = await get("Redemption")
  const Wallets = await get("Wallets")
  const Fraud = await get("Fraud")
  const MovingFunds = await get("MovingFunds")

  console.log("Newly deployed libraries:")
  console.log(`  Deposit:       ${Deposit.address}`)
  console.log("Existing library addresses:")
  console.log(`  DepositSweep:  ${DepositSweep.address}`)
  console.log(`  Redemption:    ${Redemption.address}`)
  console.log(`  Wallets:       ${Wallets.address}`)
  console.log(`  Fraud:         ${Fraud.address}`)
  console.log(`  MovingFunds:   ${MovingFunds.address}`)

  // --- Step 2: Deploy Bridge implementation ---
  // Uses a distinct artifact name to avoid overwriting the existing Bridge
  // proxy artifact managed by hardhat-deploy. The Bridge contract requires
  // all 6 libraries linked at deployment time.
  console.log("\n--- Deploying Bridge implementation ---")
  const bridgeLibraries = {
    Deposit: Deposit.address,
    DepositSweep: DepositSweep.address,
    Redemption: Redemption.address,
    Wallets: Wallets.address,
    Fraud: Fraud.address,
    MovingFunds: MovingFunds.address,
  }

  const bridgeImpl = await deploy("BridgeSponsoredDepositorImplementation", {
    ...deployOptions,
    contract: "Bridge",
    skipIfAlreadyDeployed: false,
    libraries: bridgeLibraries,
  })

  // --- Step 3: Deploy RebateStaking implementation ---
  // Implementation-only (NOT a proxy). Uses a distinct artifact name to
  // avoid overwriting the existing RebateStaking proxy artifact. The actual
  // proxy upgrade is handled via governance calldata in a subsequent step.
  // RebateStaking has no library dependencies, unlike Bridge.
  console.log("\n--- Deploying RebateStaking implementation ---")
  const rebateStakingImpl = await deploy(
    "RebateStakingSponsoredDepositorImplementation",
    {
      ...deployOptions,
      contract: "RebateStaking",
      skipIfAlreadyDeployed: false,
    }
  )

  // --- Deployment Summary ---
  console.log(`\n${"-".repeat(80)}`)
  console.log("Deployed contract addresses:")
  console.log(`  Bridge implementation:        ${bridgeImpl.address}`)
  console.log(`  RebateStaking implementation: ${rebateStakingImpl.address}`)
  console.log("-".repeat(80))

  // --- Step 4: Discover ProxyAdmin via EIP-1967 admin slot ---
  // The Bridge proxy stores the ProxyAdmin address in the EIP-1967
  // admin storage slot. Reading it on-chain avoids hardcoding.
  console.log("\n--- Discovering ProxyAdmin ---")
  const Bridge = await get("Bridge")
  const adminData = await ethers.provider.getStorageAt(
    Bridge.address,
    EIP_1967_ADMIN_SLOT
  )
  const proxyAdminAddress = ethers.utils.getAddress(`0x${adminData.slice(26)}`)
  console.log(`  ProxyAdmin discovered: ${proxyAdminAddress}`)

  if (proxyAdminAddress.toLowerCase() !== KNOWN_PROXY_ADMIN.toLowerCase()) {
    console.log(
      `  WARNING: Discovered ProxyAdmin ${proxyAdminAddress} does not match ` +
        `known address ${KNOWN_PROXY_ADMIN}`
    )
  } else {
    console.log("  ProxyAdmin matches known address")
  }

  // --- Step 5: Generate governance calldata ---
  // The deployer EOA is NOT the ProxyAdmin owner, so the script generates
  // calldata for governance actors rather than executing transactions.
  //
  // Governance flow:
  //   Timelock route:  Council Safe -> Timelock.schedule() -> [wait 24h] ->
  //                    Timelock.execute() -> ProxyAdmin.upgrade (Bridge and
  //                    RebateStaking proxies must both be upgraded together,
  //                    since Deposit.sol calls
  //                    RebateStaking.isSponsorConsentGranted())
  //   Council route:   Council Safe -> BridgeGovernance.setSponsoredDepositor()
  //                    (direct onlyOwner, no begin/finalize)
  //   Per-staker opt-in: after both proxy upgrades and the Council Safe
  //                    allowlist call, the sponsored-routing rebate does NOT
  //                    activate for any staker until that staker separately
  //                    calls RebateStaking.setSponsorConsent(depositor,
  //                    true) themselves. This script cannot automate or
  //                    execute this on a staker's behalf; operators should
  //                    communicate this to affected stakers (e.g.
  //                    NativeBTCDepositor users) as part of the rollout.
  console.log("\n--- Generating governance calldata ---")

  const BridgeGovernance = await get("BridgeGovernance")
  const RebateStaking = await get("RebateStaking")

  if (
    RebateStaking.address.toLowerCase() !==
    KNOWN_REBATE_STAKING_PROXY.toLowerCase()
  ) {
    console.log(
      `  WARNING: Discovered RebateStaking ${RebateStaking.address} does not ` +
        `match known address ${KNOWN_REBATE_STAKING_PROXY}`
    )
  } else {
    console.log("  RebateStaking proxy matches known address")
  }

  // Timelock action [0]: RebateStaking upgrade. Ordered before the Bridge
  // upgrade so the RebateStaking proxy already exposes
  // isSponsorConsentGranted() by the time the Bridge upgrade activates.
  // Timelock minDelay = 86400s (24h)
  const rebateStakingUpgradeCalldata = encodeRebateStakingUpgrade(
    RebateStaking.address,
    rebateStakingImpl.address
  )
  logCalldataAction(
    "Timelock Action [0]: RebateStaking upgrade",
    proxyAdminAddress,
    "ProxyAdmin",
    rebateStakingUpgradeCalldata,
    {
      Proxy: RebateStaking.address,
      "New impl": rebateStakingImpl.address,
    }
  )

  // Timelock action [1]: Bridge upgrade
  // Timelock minDelay = 86400s (24h)
  const bridgeUpgradeCalldata = encodeBridgeUpgrade(
    Bridge.address,
    bridgeImpl.address
  )
  logCalldataAction(
    "Timelock Action [1]: Bridge upgrade",
    proxyAdminAddress,
    "ProxyAdmin",
    bridgeUpgradeCalldata,
    {
      Proxy: Bridge.address,
      "New impl": bridgeImpl.address,
    }
  )

  // Council Safe direct action: setSponsoredDepositor on BridgeGovernance
  const setSponsoredCalldata = encodeSetSponsoredDepositor(
    KNOWN_NATIVE_BTC_DEPOSITOR,
    true
  )
  console.log(
    "\nWARNING: Do not execute the Council Safe setSponsoredDepositor " +
      "action until Timelock Action [0] (RebateStaking upgrade) has been " +
      "scheduled AND executed on-chain. The two Timelock actions are NOT " +
      "batched atomically; executing Council Safe's action first will make " +
      "revealDepositWithExtraData calls through the allowlisted depositor " +
      "revert (isSponsorConsentGranted selector does not exist on the " +
      "not-yet-upgraded RebateStaking implementation)."
  )
  logCalldataAction(
    "Council Safe Action: setSponsoredDepositor",
    BridgeGovernance.address,
    "BridgeGovernance",
    setSponsoredCalldata,
    {
      Depositor: KNOWN_NATIVE_BTC_DEPOSITOR,
      Sponsored: "true",
    }
  )

  console.log(`\n${"=".repeat(80)}`)
  console.log("Governance calldata generation complete")
  console.log("=".repeat(80))

  // --- Step 6: Save deployment summary JSON ---
  const chainId = await hre.getChainId()

  const deploymentSummary = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer,
    chainId,
    deployedContracts: {
      BridgeSponsoredDepositorImplementation: bridgeImpl.address,
      RebateStakingSponsoredDepositorImplementation: rebateStakingImpl.address,
    },
    existingContracts: {
      Bridge: Bridge.address,
      RebateStaking: RebateStaking.address,
      ProxyAdmin: proxyAdminAddress,
      Timelock: KNOWN_TIMELOCK,
      CouncilSafe: KNOWN_COUNCIL_SAFE,
      BridgeGovernance: BridgeGovernance.address,
      NativeBTCDepositor: KNOWN_NATIVE_BTC_DEPOSITOR,
    },
    timelockActions: [
      {
        target: proxyAdminAddress,
        data: rebateStakingUpgradeCalldata,
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
    councilSafeActions: [
      {
        to: BridgeGovernance.address,
        data: setSponsoredCalldata,
        value: 0,
        description:
          "setSponsoredDepositor on BridgeGovernance (direct onlyOwner call)",
        requiresPriorExecution: ["Timelock Action [0]: RebateStaking upgrade"],
      },
    ],
    libraries: bridgeLibraries,
    verificationChecks: buildVerificationChecks({
      bridgeProxy: Bridge.address,
      bridgeImpl: bridgeImpl.address,
      rebateStakingProxy: RebateStaking.address,
      rebateStakingImpl: rebateStakingImpl.address,
    }),
  }

  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `bridge-sponsored-depositor-upgrade-${Date.now()}.json`
  )

  try {
    fs.writeFileSync(summaryPath, JSON.stringify(deploymentSummary, null, 2))
    console.log(`\nDeployment summary saved to: ${summaryPath}`)
  } catch (error) {
    console.log(
      `WARNING: Failed to write deployment summary to ${summaryPath}: ` +
        `${(error as Error).message}`
    )
  }

  console.log(`\n${"=".repeat(80)}`)
  console.log("DEPLOYMENT SUMMARY")
  console.log("=".repeat(80))
  console.log(`  Network:  ${hre.network.name}`)
  console.log(`  Chain ID: ${chainId}`)
  console.log(`  Deployer: ${deployer}`)
  console.log(`  Summary:  ${summaryPath}`)
  console.log("\n  Timelock Actions (minDelay=86400s / 24h):")
  console.log("    [0] RebateStaking upgrade")
  console.log(`        Target: ProxyAdmin (${proxyAdminAddress})`)
  console.log(`        Selector: ${rebateStakingUpgradeCalldata.slice(0, 10)}`)
  console.log(`        Proxy: ${RebateStaking.address}`)
  console.log(`        New impl: ${rebateStakingImpl.address}`)
  console.log("    [1] Bridge upgrade")
  console.log(`        Target: ProxyAdmin (${proxyAdminAddress})`)
  console.log(`        Selector: ${bridgeUpgradeCalldata.slice(0, 10)}`)
  console.log(`        Proxy: ${Bridge.address}`)
  console.log(`        New impl: ${bridgeImpl.address}`)
  console.log("\n  Council Safe Actions:")
  console.log("    setSponsoredDepositor on BridgeGovernance")
  console.log(`        To: ${BridgeGovernance.address}`)
  console.log(`        Depositor: ${KNOWN_NATIVE_BTC_DEPOSITOR}`)
  console.log("        Sponsored: true")
  console.log("=".repeat(80))

  // --- Post-deployment verification commands ---
  logVerificationChecks(deploymentSummary.verificationChecks)

  // --- Step 7: Verify contracts on Etherscan (v2 API) ---
  if (hre.network.tags.etherscan) {
    const etherscanApiKey = process.env.ETHERSCAN_API_KEY
    if (etherscanApiKey) {
      console.log("\nVerifying Bridge implementation on Etherscan...")
      try {
        await hre.run("verify", {
          address: bridgeImpl.address,
          constructorArgsParams: bridgeImpl.args,
        })
        console.log("Verification successful")
      } catch (error) {
        console.log(
          `WARNING: Etherscan verification failed: ${(error as Error).message}`
        )
      }

      console.log("\nVerifying RebateStaking implementation on Etherscan...")
      try {
        await hre.run("verify", {
          address: rebateStakingImpl.address,
          constructorArgsParams: rebateStakingImpl.args,
        })
        console.log("Verification successful")
      } catch (error) {
        console.log(
          `WARNING: Etherscan verification failed: ${(error as Error).message}`
        )
      }
    } else {
      console.log(
        "\nSkipping Etherscan verification: ETHERSCAN_API_KEY not set"
      )
    }
  }
}

export default func

func.tags = ["UpgradeBridgeSponsoredDepositor"]
// Set DEPLOY_SPONSORED_DEPOSITOR=true when running the deployment.
// yarn deploy --tags UpgradeBridgeSponsoredDepositor --network <NETWORK>
func.skip = async () => process.env.DEPLOY_SPONSORED_DEPOSITOR !== "true"
