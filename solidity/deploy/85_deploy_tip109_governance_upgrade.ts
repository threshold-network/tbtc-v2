import fs from "fs"
import path from "path"
import https from "https"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { utils } from "ethers"

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
]

const BRIDGE_GOVERNANCE_ABI = [
  "function setRebateStaking(address rebateStaking)",
  "function beginDepositTreasuryFeeDivisorUpdate(uint64 _newDepositTreasuryFeeDivisor)",
]

// Shared interface instances used by both helper functions and the main
// deployment function for calldata encoding.
const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)
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
 * Encodes ProxyAdmin.upgrade() calldata for upgrading the Bridge proxy to a
 * new implementation.
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

/**
 * Submits a contract for source verification on Etherscan using the v2 API.
 * Returns the verification GUID for status polling.
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
  depositSweepLib: string
  redemptionLib: string
  walletsLib: string
  fraudLib: string
  movingFundsLib: string
}): VerificationCheck[] {
  return [
    {
      command: `cast call ${addresses.bridgeProxy} "getRebateStaking()(address)"`,
      expectedResult: addresses.rebateStakingProxy,
      description:
        "After setRebateStaking executes, Bridge should reference the RebateStaking proxy",
    },
    {
      command: `cast code ${addresses.bridgeImpl}`,
      expectedResult:
        "Bytecode should contain embedded library address fragments: " +
        `${addresses.depositLib.slice(2).toLowerCase()} (Deposit), ` +
        `${addresses.depositSweepLib.slice(2).toLowerCase()} (DepositSweep), ` +
        `${addresses.redemptionLib.slice(2).toLowerCase()} (Redemption), ` +
        `${addresses.walletsLib.slice(2).toLowerCase()} (Wallets), ` +
        `${addresses.fraudLib.slice(2).toLowerCase()} (Fraud), and ` +
        `${addresses.movingFundsLib.slice(2).toLowerCase()} (MovingFunds)`,
      description:
        "Bridge implementation bytecode should contain embedded addresses of all six current Bridge libraries",
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

  // --- Step 1: Deploy current Bridge library versions ---
  // The implementation is compiled from the current checkout, so every
  // external library must be deployed from the same source before linking.
  console.log("\n--- Deploying current Bridge libraries ---")
  const Deposit = await deploy("Deposit", deployOptions)
  const DepositSweep = await deploy("DepositSweep", deployOptions)
  const Redemption = await deploy("Redemption", deployOptions)
  const Wallets = await deploy("Wallets", {
    contract: "contracts/bridge/Wallets.sol:Wallets",
    ...deployOptions,
  })
  const Fraud = await deploy("Fraud", deployOptions)
  const MovingFunds = await deploy("MovingFunds", deployOptions)

  // --- Step 3: Deploy Bridge implementation ---
  // Uses a distinct artifact name to avoid overwriting the existing Bridge
  // proxy artifact managed by hardhat-deploy. The Bridge contract links
  // all 6 libraries required by the current implementation.
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
  console.log(`  DepositSweep library:         ${DepositSweep.address}`)
  console.log(`  Redemption library:           ${Redemption.address}`)
  console.log(`  Wallets library:              ${Wallets.address}`)
  console.log(`  Fraud library:                ${Fraud.address}`)
  console.log(`  MovingFunds library:          ${MovingFunds.address}`)
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
  //                    Timelock.execute() -> ProxyAdmin.upgrade
  //   Council route:   Council Safe -> BridgeGovernance.setRebateStaking()
  //                    (direct onlyOwner, no begin/finalize)
  //   Governance route: Council Safe ->
  //                     BridgeGovernance.beginDepositTreasuryFeeDivisorUpdate()
  //                     -> [wait 48h] -> finalizeDepositTreasuryFeeDivisorUpdate()
  console.log("\n--- Generating governance calldata ---")

  const RebateStaking = await get("RebateStaking")
  const BridgeGovernance = await get("BridgeGovernance")

  // Timelock actions array: RebateStaking upgrade FIRST, Bridge upgrade
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

  // timelockActions[1]: Bridge upgrade
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
      DepositSweep: DepositSweep.address,
      Redemption: Redemption.address,
      Wallets: Wallets.address,
      Fraud: Fraud.address,
      MovingFunds: MovingFunds.address,
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
        description: "Bridge proxy upgrade via ProxyAdmin.upgrade()",
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
      depositSweepLib: DepositSweep.address,
      redemptionLib: Redemption.address,
      walletsLib: Wallets.address,
      fraudLib: Fraud.address,
      movingFundsLib: MovingFunds.address,
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
  console.log("    [1] Bridge upgrade")
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

  // --- Step 7: Verify contracts on Etherscan (v2 API) ---
  if (hre.network.tags.etherscan) {
    const etherscanApiKey = process.env.ETHERSCAN_API_KEY
    if (!etherscanApiKey) {
      console.log(
        "\nSkipping Etherscan verification: ETHERSCAN_API_KEY not set"
      )
    } else {
      console.log("\n--- Verifying contracts on Etherscan (v2 API) ---")

      // Load the solc standard JSON input from the build info that
      // produced the deployed bytecode. hardhat-deploy stores the
      // solcInputHash in each deployment artifact, and the matching
      // build-info JSON contains the full compiler input.
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
        console.log(
          "  Could not find build-info with Deposit compilation. Skipping verification."
        )
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
            address: Wallets.address,
            name: "contracts/bridge/Wallets.sol:Wallets",
            label: "Wallets",
          },
          {
            address: Fraud.address,
            name: "contracts/bridge/Fraud.sol:Fraud",
            label: "Fraud",
          },
          {
            address: MovingFunds.address,
            name: "contracts/bridge/MovingFunds.sol:MovingFunds",
            label: "MovingFunds",
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
            console.log(
              `  Verification submission failed: ${(err as Error).message}`
            )
          }
        }
      }
    }
  }
}

export default func

func.tags = ["DeployTIP109GovernanceUpgrade"]
// Set DEPLOY_TIP109=true when running the deployment.
// yarn deploy --tags DeployTIP109GovernanceUpgrade --network <NETWORK>
func.skip = async () => process.env.DEPLOY_TIP109 !== "true"
