import fs from "fs"
import path from "path"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { utils, constants } from "ethers"

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

// Known mainnet T token address used by the RebateStaking contract.
export const KNOWN_T_TOKEN = "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5"

// ABI fragments for calldata encoding. These are the minimal function
// signatures needed to generate governance calldata without importing
// full contract artifacts.
const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
  "function upgradeAndCall(address proxy, address implementation, bytes data)",
]

const BRIDGE_ABI = [
  "function initializeV5_RepairRebateStaking(address newRebateStaking)",
]

const BRIDGE_GOVERNANCE_ABI = [
  "function setRebateStaking(address rebateStaking)",
  "function beginDepositTreasuryFeeDivisorUpdate(uint64 _newDepositTreasuryFeeDivisor)",
]

// Shared interface instances used by both helper functions and the main
// deployment function for calldata encoding.
const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)
const bridgeInterface = new utils.Interface(BRIDGE_ABI)
const bridgeGovInterface = new utils.Interface(BRIDGE_GOVERNANCE_ABI)

/**
 * Encodes ProxyAdmin.upgrade() calldata for upgrading the RebateStaking proxy
 * to a new implementation.
 * @param rebateStakingProxy - Address of the RebateStaking proxy contract
 * @param newImpl - Address of the new RebateStaking implementation
 * @returns ABI-encoded calldata for ProxyAdmin.upgrade(proxy, implementation)
 */
export function encodeRebateStakingUpgrade(
  rebateStakingProxy: string,
  newImpl: string
): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [
    rebateStakingProxy,
    newImpl,
  ])
}

/**
 * Encodes ProxyAdmin.upgradeAndCall() calldata for upgrading the Bridge proxy
 * and calling initializeV5_RepairRebateStaking(address(0)) in the same
 * transaction. The address(0) parameter clears the stale rebateStaking
 * pointer; the actual wiring happens later via setRebateStaking.
 * @param bridgeProxy - Address of the Bridge proxy contract
 * @param newBridgeImpl - Address of the new Bridge implementation
 * @returns ABI-encoded calldata for ProxyAdmin.upgradeAndCall(proxy, impl, data)
 */
export function encodeBridgeUpgradeAndCall(
  bridgeProxy: string,
  newBridgeImpl: string
): string {
  const initData = bridgeInterface.encodeFunctionData(
    "initializeV5_RepairRebateStaking",
    [constants.AddressZero]
  )
  return proxyAdminInterface.encodeFunctionData("upgradeAndCall", [
    bridgeProxy,
    newBridgeImpl,
    initData,
  ])
}

/**
 * Encodes BridgeGovernance.setRebateStaking() calldata. This is a direct
 * onlyOwner call (NOT routed through begin/finalize governance delay).
 * @param rebateStakingProxy - Address of the RebateStaking proxy to set
 * @returns ABI-encoded calldata for BridgeGovernance.setRebateStaking(address)
 */
export function encodeSetRebateStaking(rebateStakingProxy: string): string {
  return bridgeGovInterface.encodeFunctionData("setRebateStaking", [
    rebateStakingProxy,
  ])
}

/**
 * Encodes BridgeGovernance.beginDepositTreasuryFeeDivisorUpdate() calldata.
 * This begins the governance-delayed update (governanceDelays(0) = 172800s /
 * 48h) and must be followed by a finalize call after the delay expires.
 * @param newDivisor - The new treasury fee divisor value (e.g., 500)
 * @returns ABI-encoded calldata for the begin update function
 */
export function encodeBeginDepositTreasuryFeeDivisorUpdate(
  newDivisor: number
): string {
  return bridgeGovInterface.encodeFunctionData(
    "beginDepositTreasuryFeeDivisorUpdate",
    [newDivisor]
  )
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

/**
 * Builds the array of post-deployment verification checks. Each check
 * provides a `cast` CLI command that operators can run to verify the
 * upgrade executed correctly on-chain.
 */
function buildVerificationChecks(addresses: {
  bridgeProxy: string
  bridgeImpl: string
  rebateStakingProxy: string
  rebateImpl: string
  depositLib: string
  redemptionLib: string
}): VerificationCheck[] {
  return [
    {
      command: `cast call ${addresses.bridgeProxy} "getRebateStaking()(address)"`,
      expectedResult: "0x0000000000000000000000000000000000000000 (address(0))",
      description:
        "After Bridge upgrade with initializeV5 repair, rebate staking getter should return address(0)",
    },
    {
      command: `cast code ${addresses.bridgeImpl}`,
      expectedResult:
        "Bytecode should contain embedded library address fragments: " +
        `${addresses.depositLib.slice(2).toLowerCase()} (Deposit) and ` +
        `${addresses.redemptionLib.slice(2).toLowerCase()} (Redemption)`,
      description:
        "Bridge implementation bytecode should contain embedded addresses of new Deposit and Redemption libraries",
    },
    {
      command: `cast call ${addresses.bridgeProxy} "deposits(uint256)(bytes32,uint32,uint64,uint32,address,uint32)" <sample_deposit_key>`,
      expectedResult: "Existing deposit data unchanged after upgrade",
      description:
        "Existing P2SH deposits should remain unaffected by the Bridge upgrade",
    },
    {
      command: `cast call ${addresses.bridgeImpl} "..." | grep -c "^" -- or inspect ABI for 56 public/external selectors`,
      expectedResult: "56 selectors",
      description:
        "Bridge implementation should expose exactly 56 public/external function selectors",
    },
    {
      command: `cast storage ${addresses.rebateStakingProxy} ${EIP_1967_IMPLEMENTATION_SLOT}`,
      expectedResult: `Should contain ${addresses.rebateImpl} (padded to 32 bytes)`,
      description:
        "Proxy EIP-1967 implementation pointer should reference the newly deployed rebate impl",
    },
    {
      command:
        `cast storage ${addresses.bridgeProxy} 79 && ` +
        `cast storage ${addresses.bridgeProxy} 80 && ` +
        `cast storage ${addresses.bridgeProxy} 81`,
      expectedResult:
        "Slot 79 = redemptionWatchtower address, " +
        "slot 80 = rebate staking address, " +
        "slots 81-128 = zero (__gap[48], gap size unchanged)",
      description:
        "Bridge storage layout: slot 79=redemptionWatchtower, slot 80=rebate staking, slots 81-128=__gap[48] with gap size unchanged",
    },
    {
      command:
        `cast call ${addresses.rebateStakingProxy} "bridge()(address)" && ` +
        `cast call ${addresses.rebateStakingProxy} "rebatePerToken()(uint256)" && ` +
        `cast call ${addresses.rebateStakingProxy} "token()(address)" && ` +
        `cast call ${addresses.rebateStakingProxy} "rollingWindow()(uint256)" && ` +
        `cast call ${addresses.rebateStakingProxy} "unstakingPeriod()(uint256)"`,
      expectedResult:
        `bridge() = ${addresses.bridgeProxy}, ` +
        "rebatePerToken = 1000000000000000000 (1e18), " +
        `token = ${KNOWN_T_TOKEN}, ` +
        "rollingWindow = 2592000, " +
        "unstakingPeriod = 2592000",
      description:
        "RebateStaking state should be preserved after proxy upgrade -- critical for staked T",
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
  console.log("TIP-109 Governance Upgrade Deployment")
  console.log("=".repeat(80))
  console.log(`Network: ${hre.network.name}`)
  console.log(`Deployer: ${deployer}`)

  // --- Step 1: Deploy new library versions ---
  // Deposit has rebate integration changes; Redemption has the balanceOwner
  // fix. Both require fresh deployments.
  console.log("\n--- Deploying updated libraries ---")
  const Deposit = await deploy("Deposit", deployOptions)
  const Redemption = await deploy("Redemption", deployOptions)

  // --- Step 2: Resolve unchanged existing libraries ---
  // These libraries have NOT changed since last deployment and are reused
  // from existing deployment artifacts.
  console.log("\n--- Resolving existing libraries ---")
  const DepositSweep = await get("DepositSweep")
  const Wallets = await get("Wallets")
  const Fraud = await get("Fraud")
  const MovingFunds = await get("MovingFunds")

  console.log("Existing library addresses:")
  console.log(`  DepositSweep: ${DepositSweep.address}`)
  console.log(`  Wallets:      ${Wallets.address}`)
  console.log(`  Fraud:        ${Fraud.address}`)
  console.log(`  MovingFunds:  ${MovingFunds.address}`)

  // --- Step 3: Deploy Bridge implementation ---
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

  const bridgeImpl = await deploy("BridgeTIP109Implementation", {
    ...deployOptions,
    contract: "Bridge",
    skipIfAlreadyDeployed: false,
    libraries: bridgeLibraries,
  })

  // --- Step 4: Deploy RebateStaking implementation ---
  // Implementation-only (NOT a proxy). Uses a distinct artifact name to
  // avoid overwriting the existing RebateStaking proxy artifact. The actual
  // proxy upgrade is handled via governance calldata in a subsequent step.
  console.log("\n--- Deploying RebateStaking implementation ---")
  const rebateImpl = await deploy("RebateStakingTIP109Implementation", {
    ...deployOptions,
    contract: "RebateStaking",
    skipIfAlreadyDeployed: false,
  })

  // --- Deployment Summary ---
  console.log(`\n${"-".repeat(80)}`)
  console.log("Deployed contract addresses:")
  console.log(`  Deposit library:              ${Deposit.address}`)
  console.log(`  Redemption library:           ${Redemption.address}`)
  console.log(`  Bridge implementation:        ${bridgeImpl.address}`)
  console.log(`  RebateStaking implementation: ${rebateImpl.address}`)
  console.log("-".repeat(80))

  // --- Step 5: Discover ProxyAdmin via EIP-1967 admin slot ---
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

  // --- Step 6: Generate governance calldata ---
  // The deployer EOA is NOT the ProxyAdmin owner, so the script generates
  // calldata for governance actors rather than executing transactions.
  //
  // Governance flow:
  //   Timelock route:  Council Safe -> Timelock.schedule() -> [wait 24h] ->
  //                    Timelock.execute() -> ProxyAdmin.upgrade/upgradeAndCall
  //   Council route:   Council Safe -> BridgeGovernance.setRebateStaking()
  //                    (direct onlyOwner, no begin/finalize)
  //   Governance route: Council Safe ->
  //                     BridgeGovernance.beginDepositTreasuryFeeDivisorUpdate()
  //                     -> [wait 48h] -> finalizeDepositTreasuryFeeDivisorUpdate()
  console.log("\n--- Generating governance calldata ---")

  const RebateStaking = await get("RebateStaking")
  const BridgeGovernance = await get("BridgeGovernance")

  // Timelock actions array: RebateStaking upgrade FIRST, Bridge upgradeAndCall
  // SECOND. This ordering ensures the RebateStaking proxy has the new 3-arg
  // ABI before Bridge activation references it.
  // Timelock minDelay = 86400s (24h)

  // timelockActions[0]: RebateStaking upgrade
  const rebateUpgradeCalldata = encodeRebateStakingUpgrade(
    RebateStaking.address,
    rebateImpl.address
  )
  logCalldataAction(
    "Timelock Action [0]: RebateStaking upgrade",
    proxyAdminAddress,
    "ProxyAdmin",
    rebateUpgradeCalldata,
    { Proxy: RebateStaking.address, "New impl": rebateImpl.address }
  )

  // timelockActions[1]: Bridge upgradeAndCall
  const bridgeUpgradeCalldata = encodeBridgeUpgradeAndCall(
    Bridge.address,
    bridgeImpl.address
  )
  logCalldataAction(
    "Timelock Action [1]: Bridge upgradeAndCall",
    proxyAdminAddress,
    "ProxyAdmin",
    bridgeUpgradeCalldata,
    {
      Proxy: Bridge.address,
      "New impl": bridgeImpl.address,
      "Inner call": "initializeV5_RepairRebateStaking(address(0))",
    }
  )

  // Council Safe direct action: setRebateStaking on BridgeGovernance
  const setRebateCalldata = encodeSetRebateStaking(RebateStaking.address)
  logCalldataAction(
    "Council Safe Action: setRebateStaking",
    BridgeGovernance.address,
    "BridgeGovernance",
    setRebateCalldata,
    { "RebateStaking proxy": RebateStaking.address }
  )

  // Governance-delayed action: beginDepositTreasuryFeeDivisorUpdate
  // governanceDelays(0) = 172800s (48h) before finalize can be called
  const feeDivisorCalldata = encodeBeginDepositTreasuryFeeDivisorUpdate(500)
  logCalldataAction(
    "Governance Action: beginDepositTreasuryFeeDivisorUpdate",
    BridgeGovernance.address,
    "BridgeGovernance",
    feeDivisorCalldata,
    { "New divisor": "500", "Governance delay": "172800s (48h)" }
  )

  console.log(`\n${"=".repeat(80)}`)
  console.log("Governance calldata generation complete")
  console.log("=".repeat(80))

  // --- Step 7b: Save deployment summary JSON ---
  const chainId = await hre.getChainId()

  const deploymentSummary = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer,
    chainId,
    deployedContracts: {
      Deposit: Deposit.address,
      Redemption: Redemption.address,
      BridgeTIP109Implementation: bridgeImpl.address,
      RebateStakingTIP109Implementation: rebateImpl.address,
    },
    existingContracts: {
      Bridge: Bridge.address,
      ProxyAdmin: proxyAdminAddress,
      Timelock: KNOWN_TIMELOCK,
      CouncilSafe: KNOWN_COUNCIL_SAFE,
      BridgeGovernance: BridgeGovernance.address,
      RebateStaking: RebateStaking.address,
      TToken: KNOWN_T_TOKEN,
    },
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
        description: "Bridge proxy upgrade via ProxyAdmin.upgradeAndCall()",
      },
    ],
    councilSafeActions: [
      {
        to: BridgeGovernance.address,
        data: setRebateCalldata,
        value: 0,
        description:
          "setRebateStaking on BridgeGovernance (direct onlyOwner call)",
      },
    ],
    governanceActions: [
      {
        to: BridgeGovernance.address,
        data: feeDivisorCalldata,
        value: 0,
        description:
          "beginDepositTreasuryFeeDivisorUpdate on BridgeGovernance (172800s governance delay)",
      },
    ],
    libraries: bridgeLibraries,
    verificationChecks: buildVerificationChecks({
      bridgeProxy: Bridge.address,
      bridgeImpl: bridgeImpl.address,
      rebateStakingProxy: RebateStaking.address,
      rebateImpl: rebateImpl.address,
      depositLib: Deposit.address,
      redemptionLib: Redemption.address,
    }),
  }

  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `tip109-deployment-${Date.now()}.json`
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
  console.log(`        Selector: ${rebateUpgradeCalldata.slice(0, 10)}`)
  console.log(`        Proxy: ${RebateStaking.address}`)
  console.log(`        New impl: ${rebateImpl.address}`)
  console.log("    [1] Bridge upgradeAndCall")
  console.log(`        Target: ProxyAdmin (${proxyAdminAddress})`)
  console.log(`        Selector: ${bridgeUpgradeCalldata.slice(0, 10)}`)
  console.log(`        Proxy: ${Bridge.address}`)
  console.log(`        New impl: ${bridgeImpl.address}`)
  console.log("\n  Council Safe Actions:")
  console.log("    setRebateStaking on BridgeGovernance")
  console.log(`        To: ${BridgeGovernance.address}`)
  console.log(`        RebateStaking proxy: ${RebateStaking.address}`)
  console.log("\n  Governance Actions (governanceDelays(0)=172800s / 48h):")
  console.log("    beginDepositTreasuryFeeDivisorUpdate")
  console.log(`        To: ${BridgeGovernance.address}`)
  console.log("        New divisor: 500")
  console.log("=".repeat(80))

  // --- Post-deployment verification commands ---
  // Print cast commands that operators can run to verify the upgrade
  // executed correctly on-chain.
  logVerificationChecks(deploymentSummary.verificationChecks)

  // --- Step 7: Verify contracts on Etherscan ---
  if (hre.network.tags.etherscan) {
    const { helpers } = hre

    console.log("\n--- Verifying contracts on Etherscan ---")

    await helpers.etherscan.verify(Deposit)
    await helpers.etherscan.verify(Redemption)
    await helpers.etherscan.verify(rebateImpl)

    try {
      await hre.run("verify:verify", {
        address: bridgeImpl.address,
        constructorArguments: [],
        libraries: bridgeLibraries,
      })
    } catch (error) {
      console.log(
        "Bridge implementation verification may have failed:",
        (error as Error).message
      )
    }
  }
}

export default func

func.tags = ["DeployTIP109GovernanceUpgrade"]
// Set DEPLOY_TIP109=true when running the deployment.
// yarn deploy --tags DeployTIP109GovernanceUpgrade --network <NETWORK>
func.skip = async () => process.env.DEPLOY_TIP109 !== "true"
