import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

// Resolve the WalletRegistry deployment if one already exists, otherwise
// defer to the @keep-network/ecdsa external deploy chain to create it.
//
// Background: when `deployments.fixture([Bridge, ...])` is invoked from
// a test fixture in the canonical mirror (PR #971), the dependency
// closure of "Bridge" pulls in tag "WalletRegistry", which is provided
// by BOTH this script and @keep-network/ecdsa's
// `03_deploy_wallet_registry.js`. hardhat-deploy sorts script names
// across the local + external paths and runs `00_*.ts` (this file)
// before `03_*.js` (the actual deployer). If we throw on missing
// state here, the fixture aborts before the deployer can run.
//
// Treating the resolve as logging-only (and letting the downstream
// `03_deploy_wallet_registry.js` actually deploy if needed) makes
// the deploy chain robust to fixture-scoped re-runs while preserving
// the original sanity-log intent.
const func: DeployFunction = async function resolveWalletRegistry(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, helpers } = hre
  const { log } = deployments

  const WalletRegistry = await deployments.getOrNull("WalletRegistry")

  if (WalletRegistry && helpers.address.isValid(WalletRegistry.address)) {
    log(`using existing WalletRegistry at ${WalletRegistry.address}`)
  } else {
    log(
      "WalletRegistry not yet deployed at resolve time; deferring to " +
        "@keep-network/ecdsa external deploy chain (03_deploy_wallet_registry.js)"
    )
  }
}

export default func

func.tags = ["WalletRegistry"]
