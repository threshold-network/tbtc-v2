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
  "function governance() view returns (address)",
]

const PROXY_ADMIN_ABI = [
  "function upgradeAndCall(address proxy, address implementation, bytes calldata data)",
]

// This script only deploys the new implementation contracts and generates
// governance calldata; it never executes the upgrade. The deployer EOA's
// relationship to the ProxyAdmin owner varies by network (see
// hardhat.config.ts namedAccounts) and is not assumed here - the actual
// upgradeAndCall calls must be submitted by whichever account controls the
// ProxyAdmin (Timelock/Council) using the logged calldata below.
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers, artifacts } = hre
  const { deploy, get, save } = deployments
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

  // --- Verify BridgeGovernanceV2 is already live before generating calldata ---
  // initializeV6_ConfigurePegKeeper and the beginPegKeeperUpdate /
  // finalizePegKeeperUpdate / cancelPegKeeperUpdate flow it enables only
  // exist on BridgeGovernanceV2. If 96_transfer_bridge_governance_v2.ts's
  // migration has not fully finalized yet, Bridge still recognizes the old
  // BridgeGovernance as its governance contract, and any calldata generated
  // here would target a peg keeper flow governance cannot yet reach.
  console.log("\n--- Verifying governance transfer is finalized ---")
  const Bridge = await get("Bridge")
  let BridgeGovernanceV2
  try {
    BridgeGovernanceV2 = await get("BridgeGovernanceV2")
  } catch (error) {
    throw new Error(
      "BridgeGovernanceV2 has not been deployed on this network yet. " +
        "hardhat-deploy's tag dependency resolution pulls " +
        "95_deploy_bridge_governance_v2.ts into this run, but that " +
        "script is independently skip-gated behind " +
        "DEPLOY_BRIDGE_GOVERNANCE_V2=true and will not execute just " +
        "because this script declares it as a dependency. If " +
        "BridgeGovernanceV2 was already deployed in a prior invocation, " +
        "its deployment record should already be on disk -- check the " +
        "correct network/deployments directory is in scope. Otherwise, " +
        "set DEPLOY_BRIDGE_GOVERNANCE_V2=true alongside " +
        "DEPLOY_PROTOCOL_PEG_KEEPER_UPGRADE=true, or run " +
        "`yarn deploy --tags BridgeGovernanceV2` on its own first."
    )
  }
  const bridgeReadOnly = await ethers.getContractAt(BRIDGE_ABI, Bridge.address)
  const currentGovernance = await bridgeReadOnly.governance()
  const allowUnsafeOrder = process.env.ALLOW_UNSAFE_ORDER === "true"
  if (
    currentGovernance.toLowerCase() !== BridgeGovernanceV2.address.toLowerCase()
  ) {
    if (!allowUnsafeOrder) {
      throw new Error(
        `Bridge.governance() is ${currentGovernance}, not ` +
          `BridgeGovernanceV2 (${BridgeGovernanceV2.address}). ` +
          "96_transfer_bridge_governance_v2.ts's governance transfer " +
          "(beginBridgeGovernanceTransfer AND " +
          "finalizeBridgeGovernanceTransfer, after the governance delay " +
          "elapses) must fully finalize before this upgrade batch is " +
          "generated. Set ALLOW_UNSAFE_ORDER=true to override for dry runs."
      )
    }
    console.log(
      "  WARNING: BridgeGovernanceV2 is not yet Bridge's live governance " +
        "contract, but continuing because ALLOW_UNSAFE_ORDER=true."
    )
  } else {
    console.log("  BridgeGovernanceV2 is Bridge's live governance contract.")
  }

  // --- Resolve unchanged libraries ---
  // DepositSweep/Wallets/Fraud/MovingFunds are unchanged since last
  // deployment; reused from existing artifacts.
  console.log("\n--- Resolving unchanged libraries ---")
  const DepositSweep = await get("DepositSweep")
  const Wallets = await get("Wallets")
  const Fraud = await get("Fraud")
  const MovingFunds = await get("MovingFunds")

  // --- Deploy changed libraries ---
  // Deposit and Redemption gained new fee-waiver branches in this PR (peg
  // keeper deposits/redemptions bypass the treasury fee), so they must be
  // redeployed here rather than reused via `get()`. Deployed under distinct
  // artifact names so the existing Deposit/Redemption deployment records
  // (still depended on by other, unrelated deploy scripts) are not
  // overwritten.
  console.log("\n--- Deploying updated Deposit/Redemption libraries ---")
  const Deposit = await deploy("DepositV6PegKeeper", {
    ...deployOptions,
    contract: "Deposit",
    skipIfAlreadyDeployed: false,
  })
  const Redemption = await deploy("RedemptionV6PegKeeper", {
    ...deployOptions,
    contract: "Redemption",
    skipIfAlreadyDeployed: false,
  })

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

  console.log(`\n${"-".repeat(80)}`)
  console.log("Deployed contract addresses:")
  console.log(`  Bridge implementation:        ${bridgeImpl.address}`)
  console.log(`  RebateStaking implementation: ${rebateImpl.address}`)
  console.log("-".repeat(80))

  // --- Update proxy deployment artifacts ---
  // hardhat-deploy's `deploy()` above only stores the new implementation
  // contracts under their own distinct artifact names; it never touches the
  // Bridge/RebateStaking proxy deployment records. Without this,
  // `deployments.get("Bridge").implementation` and
  // `deployments.get("RebateStaking").implementation` would keep pointing at
  // the pre-upgrade implementations even after the Timelock executes the
  // upgradeAndCall calls below.
  console.log("\n--- Updating proxy deployment artifacts ---")
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
  console.log("Timelock batch (RebateStaking FIRST, Bridge SECOND):")
  console.log(
    "These two payloads must be submitted by the operator as ONE ordered " +
      "Timelock batch - RebateStaking action [0] before Bridge action [1]. " +
      "This script does not encode or enforce the batch or its ordering; " +
      "the order matches the PR's Deployment notes: the RebateStaking proxy " +
      "must be deprecated before the Bridge upgrade permanently disables " +
      "the legacy rebate hook wiring to it."
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
  "BridgeGovernanceV2",
]
// Set DEPLOY_PROTOCOL_PEG_KEEPER_UPGRADE=true when running the deployment.
// yarn deploy --tags UpgradeBridgeV6PegKeeper --network <NETWORK>
func.skip = async () =>
  process.env.DEPLOY_PROTOCOL_PEG_KEEPER_UPGRADE !== "true"
