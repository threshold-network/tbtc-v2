import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { utils } from "ethers"

// EIP-1967 transparent proxy admin storage slot. Defined by the standard at
// https://eips.ethereum.org/EIPS/eip-1967#admin-address and used to discover
// the ProxyAdmin address from any transparent proxy on-chain rather than
// hardcoding it (this repo has no hardhat-deploy "ProxyAdmin" deployment).
const EIP_1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

const REBATE_STAKING_ABI = ["function initializeV2_Deprecate()"]

const BRIDGE_ABI = [
  "function initializeV6_ConfigurePegKeeper(address initialPegKeeper)",
]

const PROXY_ADMIN_ABI = [
  "function upgradeAndCall(address proxy, address implementation, bytes calldata data)",
]

// This script only deploys the new implementation contracts and generates
// governance calldata; it never executes the upgrade. The deployer EOA is
// not the ProxyAdmin owner, so the actual upgradeAndCall calls must be
// submitted by the Timelock/Council from the logged calldata below.
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre
  const { deploy, get } = deployments
  const { deployer } = await getNamedAccounts()

  const initialPegKeeper = process.env.INITIAL_PEG_KEEPER
  if (!initialPegKeeper || !utils.isAddress(initialPegKeeper)) {
    throw new Error("INITIAL_PEG_KEEPER env var must be set to a valid address")
  }

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  console.log("=".repeat(80))
  console.log("Bridge V6 Peg Keeper / RebateStaking Deprecation Upgrade")
  console.log("=".repeat(80))
  console.log(`Network: ${hre.network.name}`)
  console.log(`Deployer: ${deployer}`)

  // --- Resolve existing libraries ---
  // Unchanged since last deployment; reused from existing artifacts.
  console.log("\n--- Resolving existing libraries ---")
  const Deposit = await get("Deposit")
  const DepositSweep = await get("DepositSweep")
  const Redemption = await get("Redemption")
  const Wallets = await get("Wallets")
  const Fraud = await get("Fraud")
  const MovingFunds = await get("MovingFunds")

  // --- Deploy new implementations ---
  // Deployed under distinct artifact names to avoid overwriting the existing
  // Bridge/RebateStaking proxy deployment artifacts managed by hardhat-deploy.
  console.log("\n--- Deploying Bridge implementation ---")
  const bridgeImpl = await deploy("BridgeV6PegKeeperImplementation", {
    ...deployOptions,
    contract: "Bridge",
    skipIfAlreadyDeployed: false,
    libraries: {
      Deposit: Deposit.address,
      DepositSweep: DepositSweep.address,
      Redemption: Redemption.address,
      Wallets: Wallets.address,
      Fraud: Fraud.address,
      MovingFunds: MovingFunds.address,
    },
  })

  console.log("\n--- Deploying RebateStaking implementation ---")
  const rebateImpl = await deploy("RebateStakingV6Implementation", {
    ...deployOptions,
    contract: "RebateStaking",
    skipIfAlreadyDeployed: false,
  })

  const RebateStaking = await get("RebateStaking")
  const Bridge = await get("Bridge")

  console.log(`\n${"-".repeat(80)}`)
  console.log("Deployed contract addresses:")
  console.log(`  Bridge implementation:        ${bridgeImpl.address}`)
  console.log(`  RebateStaking implementation: ${rebateImpl.address}`)
  console.log("-".repeat(80))

  // --- Discover ProxyAdmin via EIP-1967 admin slot ---
  console.log("\n--- Discovering ProxyAdmin ---")
  const adminData = await ethers.provider.getStorageAt(
    Bridge.address,
    EIP_1967_ADMIN_SLOT
  )
  const proxyAdminAddress = ethers.utils.getAddress(`0x${adminData.slice(26)}`)
  console.log(`  ProxyAdmin discovered: ${proxyAdminAddress}`)

  // --- Generate governance calldata ---
  const rebateStakingInterface = new utils.Interface(REBATE_STAKING_ABI)
  const bridgeInterface = new utils.Interface(BRIDGE_ABI)
  const proxyAdminInterface = new utils.Interface(PROXY_ADMIN_ABI)

  const rebateStakingCalldata = rebateStakingInterface.encodeFunctionData(
    "initializeV2_Deprecate"
  )
  const bridgeCalldata = bridgeInterface.encodeFunctionData(
    "initializeV6_ConfigurePegKeeper",
    [initialPegKeeper]
  )

  // New implementation addresses are the upgrade target here, NOT the
  // current on-chain implementation - upgradeAndCall must point the proxy at
  // the newly deployed bytecode, or the "upgrade" would be a same-bytecode
  // no-op that merely re-runs the initializer.
  const rebateUpgradeCalldata = proxyAdminInterface.encodeFunctionData(
    "upgradeAndCall",
    [RebateStaking.address, rebateImpl.address, rebateStakingCalldata]
  )
  const bridgeUpgradeCalldata = proxyAdminInterface.encodeFunctionData(
    "upgradeAndCall",
    [Bridge.address, bridgeImpl.address, bridgeCalldata]
  )

  console.log(`\n${"-".repeat(80)}`)
  console.log("Timelock batch (ordered - RebateStaking FIRST, Bridge SECOND):")
  console.log(
    "This ordering matches the PR's Deployment notes and ensures the " +
      "RebateStaking proxy is deprecated before the Bridge upgrade " +
      "permanently disables the legacy rebate hook wiring to it."
  )
  console.log("-".repeat(80))

  console.log(
    "\nAction [0]: RebateStaking ProxyAdmin.upgradeAndCall(initializeV2_Deprecate)"
  )
  console.log(`  Target:   ${proxyAdminAddress}`)
  console.log(`  Proxy:    ${RebateStaking.address}`)
  console.log(`  New impl: ${rebateImpl.address}`)
  console.log(`  Calldata: ${rebateUpgradeCalldata}`)

  console.log(
    "\nAction [1]: Bridge ProxyAdmin.upgradeAndCall(initializeV6_ConfigurePegKeeper)"
  )
  console.log(`  Target:            ${proxyAdminAddress}`)
  console.log(`  Proxy:             ${Bridge.address}`)
  console.log(`  New impl:          ${bridgeImpl.address}`)
  console.log(`  Initial peg keeper: ${initialPegKeeper}`)
  console.log(`  Calldata:          ${bridgeUpgradeCalldata}`)

  console.log(
    "\nPrerequisite: 96_transfer_bridge_governance_v2.ts's governance " +
      "transfer must already be finalized before beginPegKeeperUpdate / " +
      "finalizePegKeeperUpdate / cancelPegKeeperUpdate become usable " +
      "(they live on BridgeGovernanceV2, not the currently-live BridgeGovernance)."
  )
  console.log(`\n${"=".repeat(80)}`)
}

export default func

func.tags = ["UpgradeBridgeV6PegKeeper"]
func.dependencies = [
  "Bridge",
  "RebateStaking",
  "Deposit",
  "DepositSweep",
  "Redemption",
  "Wallets",
  "Fraud",
  "MovingFunds",
]
// Set DEPLOY_PROTOCOL_PEG_KEEPER_UPGRADE=true when running the deployment.
// yarn deploy --tags UpgradeBridgeV6PegKeeper --network <NETWORK>
func.skip = async () =>
  process.env.DEPLOY_PROTOCOL_PEG_KEEPER_UPGRADE !== "true"
