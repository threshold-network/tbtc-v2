import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

// Resolve the ReimbursementPool deployment if one already exists,
// otherwise defer to the @keep-network/random-beacon external deploy
// chain (`01_deploy_reimbursement_pool.js`) to create it.
//
// Background: tag "ReimbursementPool" is provided by THREE scripts:
//   - this file (local, runs first by 00_*.ts filename order)
//   - @keep-network/ecdsa's 00_resolve_reimbursement_pool.js
//   - @keep-network/random-beacon's 01_deploy_reimbursement_pool.js
// When `deployments.fixture([Bridge, ...])` is invoked from a test
// fixture, hardhat-deploy runs scripts in filename order; throwing
// here aborts the fixture before the random-beacon deployer can run.
// Treat the resolve as logging-only and let the downstream deployer
// take over — same divergence rationale as 00_resolve_wallet_registry.ts.
const func: DeployFunction = async function resolveReimbursementPool(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, helpers } = hre
  const { log } = deployments

  const ReimbursementPool = await deployments.getOrNull("ReimbursementPool")

  if (ReimbursementPool && helpers.address.isValid(ReimbursementPool.address)) {
    log(`using existing ReimbursementPool at ${ReimbursementPool.address}`)
  } else {
    log(
      "ReimbursementPool not yet deployed at resolve time; deferring to " +
        "@keep-network/random-beacon external deploy chain " +
        "(01_deploy_reimbursement_pool.js)"
    )
  }
}

export default func

func.tags = ["ReimbursementPool"]
