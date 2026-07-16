import fs from "fs"
import path from "path"
import https from "https"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { providers, utils } from "ethers"

import {
  EIP_1967_ADMIN_SLOT,
  KNOWN_PROXY_ADMIN,
  KNOWN_TIMELOCK,
  KNOWN_COUNCIL_SAFE,
} from "./85_deploy_tip109_governance_upgrade"
import {
  abortLiveBridgeUpgradeWithoutVettedCompleteV2,
  isEphemeralLocalNetwork,
} from "./45_deploy_p2tr_signature_fraud_router"

const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
]

const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)

function encodeUpgrade(proxy: string, newImpl: string): string {
  return proxyAdminInterface.encodeFunctionData("upgrade", [proxy, newImpl])
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

  if (!isEphemeralLocalNetwork(hre.network.name)) {
    await abortLiveBridgeUpgradeWithoutVettedCompleteV2(
      hre,
      "86_deploy_tip109_hotfix"
    )
  }

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

  // --- Step 1: Deploy current Bridge libraries ---
  // The Bridge implementation must be linked to the bytecode compiled from
  // this source tree. Historical deployment artifacts may point to earlier
  // library versions that do not implement the current Bridge behavior.
  console.log("\n--- Deploying current Bridge libraries ---")
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
  const Redemption = await deploy("RedemptionTIP109Hotfix", {
    ...deployOptions,
    contract: "Redemption",
    skipIfAlreadyDeployed: false,
  })
  const Wallets = await deploy("WalletsTIP109Hotfix", {
    ...deployOptions,
    contract: "contracts/bridge/Wallets.sol:Wallets",
    skipIfAlreadyDeployed: false,
  })
  const Fraud = await deploy("FraudTIP109Hotfix", {
    ...deployOptions,
    contract: "Fraud",
    skipIfAlreadyDeployed: false,
  })
  const MovingFunds = await deploy("MovingFundsTIP109Hotfix", {
    ...deployOptions,
    contract: "MovingFunds",
    skipIfAlreadyDeployed: false,
  })

  // --- Step 2: Deploy new Bridge implementation ---
  // Linked to all six libraries deployed from the current source tree.
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

  // --- Step 3: Deploy new RebateStaking implementation (PR #939) ---
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
  console.log(`  Wallets library (NEW):         ${Wallets.address}`)
  console.log(`  Fraud library (NEW):           ${Fraud.address}`)
  console.log(`  MovingFunds library (NEW):     ${MovingFunds.address}`)
  console.log(`  Bridge implementation (NEW):   ${bridgeImpl.address}`)
  console.log(`  RebateStaking impl (NEW):      ${rebateImpl.address}`)
  console.log("-".repeat(80))

  // --- Step 4: Update proxy deployment artifacts ---
  // Following the pattern from Wormhole V2 upgrade scripts: update the
  // proxy artifact with the new implementation address and ABI so that
  // hardhat-deploy and downstream tooling reflect the upgraded state.
  console.log("\n--- Updating proxy deployment artifacts ---")

  const Bridge = await get("Bridge")
  const RebateStaking = await get("RebateStaking")

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

  // --- Step 5: Discover ProxyAdmin and generate calldata ---
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

  // --- Step 6: Save deployment summary JSON ---
  const chainId = await hre.getChainId()

  const deploymentSummary = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer,
    chainId,
    purpose:
      "TIP-109 hotfix: add forceStakeTransfer (PR #939) and " +
      "zero-address redeemer guard (PR #940)",
    deployedContracts: {
      DepositTIP109Hotfix: Deposit.address,
      DepositSweepTIP109Hotfix: DepositSweep.address,
      RedemptionTIP109Hotfix: Redemption.address,
      WalletsTIP109Hotfix: Wallets.address,
      FraudTIP109Hotfix: Fraud.address,
      MovingFundsTIP109Hotfix: MovingFunds.address,
      BridgeTIP109HotfixImplementation: bridgeImpl.address,
      RebateStakingTIP109HotfixImplementation: rebateImpl.address,
    },
    existingContracts: {
      Bridge: Bridge.address,
      ProxyAdmin: proxyAdminAddress,
      Timelock: KNOWN_TIMELOCK,
      CouncilSafe: KNOWN_COUNCIL_SAFE,
      RebateStaking: RebateStaking.address,
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
  console.log("\n  Timelock Actions (minDelay=86400s / 24h):")
  console.log("    [0] RebateStaking upgrade (plain)")
  console.log(`        Proxy: ${RebateStaking.address}`)
  console.log(`        New impl: ${rebateImpl.address}`)
  console.log("    [1] Bridge upgrade (plain)")
  console.log(`        Proxy: ${Bridge.address}`)
  console.log(`        New impl: ${bridgeImpl.address}`)
  console.log("=".repeat(80))

  // --- Step 7: Verify contracts on Etherscan (v2 API) ---
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
            console.log(`  Verification failed: ${(err as Error).message}`)
          }
        }
      }
    }
  }
}

export default func

func.tags = ["DeployTIP109Hotfix"]
func.dependencies = ["FrostCustodyNoGo"]
func.skip = async () => process.env.DEPLOY_TIP109_HOTFIX !== "true"
