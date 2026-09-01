import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { utils } from "ethers"

const BRIDGE_GOVERNANCE_ABI = [
  "function beginBridgeGovernanceTransfer(address _newBridgeGovernance)",
  "function finalizeBridgeGovernanceTransfer()",
]

// This script only generates calldata; it never executes the transfer. The
// deployer EOA that runs deploy scripts is not the BridgeGovernance owner on
// mainnet/sepolia (that's the Council Safe), and unconditionally executing
// beginBridgeGovernanceTransfer/finalizeBridgeGovernanceTransfer here would
// also run this irreversible governance migration during `yarn deploy:test`
// and any unit test that pulls in this deployment via `deployments.fixture()`.
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments } = hre

  const OldBridgeGovernance = await deployments.get("BridgeGovernance")
  const NewBridgeGovernance = await deployments.get("BridgeGovernanceV2")

  const bridgeGovernanceInterface = new utils.Interface(BRIDGE_GOVERNANCE_ABI)

  const beginCalldata = bridgeGovernanceInterface.encodeFunctionData(
    "beginBridgeGovernanceTransfer",
    [NewBridgeGovernance.address]
  )
  const finalizeCalldata = bridgeGovernanceInterface.encodeFunctionData(
    "finalizeBridgeGovernanceTransfer"
  )

  console.log("=".repeat(80))
  console.log(
    "Bridge Governance Transfer (BridgeGovernance -> BridgeGovernanceV2)"
  )
  console.log("=".repeat(80))
  console.log(
    "This migration must complete in full (both begin AND finalize, after " +
      "the governance delay elapses) BEFORE running " +
      "97_upgrade_bridge_v6_peg_keeper.ts's upgradeAndCall batch: " +
      "beginPegKeeperUpdate/finalizePegKeeperUpdate/cancelPegKeeperUpdate " +
      "only exist on BridgeGovernanceV2, and Bridge.updatePegKeeper is " +
      "onlyGovernance, so Bridge must already recognize BridgeGovernanceV2 " +
      "as its governance contract before those calls are usable."
  )
  console.log(`\nOld BridgeGovernance: ${OldBridgeGovernance.address}`)
  console.log(`New BridgeGovernance: ${NewBridgeGovernance.address}`)

  console.log(
    `\nStep 1 - beginBridgeGovernanceTransfer (call now, owner of ${OldBridgeGovernance.address}):`
  )
  console.log(`  Target:   ${OldBridgeGovernance.address}`)
  console.log(`  Calldata: ${beginCalldata}`)

  console.log(
    "\nStep 2 - finalizeBridgeGovernanceTransfer (call after the governance delay elapses):"
  )
  console.log(`  Target:   ${OldBridgeGovernance.address}`)
  console.log(`  Calldata: ${finalizeCalldata}`)
  console.log(`\n${"=".repeat(80)}`)
}

export default func

func.tags = ["TransferBridgeGovernanceV2"]
func.dependencies = ["BridgeGovernance", "BridgeGovernanceV2"]
// Set DEPLOY_BRIDGE_GOVERNANCE_TRANSFER=true when running the deployment.
// yarn deploy --tags TransferBridgeGovernanceV2 --network <NETWORK>
func.skip = async () => process.env.DEPLOY_BRIDGE_GOVERNANCE_TRANSFER !== "true"
