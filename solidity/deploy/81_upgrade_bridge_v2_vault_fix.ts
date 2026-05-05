// ////////////////////////////////////////////////////////////////////////
// DEPRECATED -- HISTORICAL UPGRADE
//
// The vault=0x0 deposit repair this script encodes executed on mainnet:
//   - Bridge proxy 0x5e4861a80B55f035D899f66772117F00FA0E8e7B
//   - DepositVaultFixed emitted at block 24282346 in tx
//     0xa460f4b08ef9c73690cc52b75f852aea9ae8e319c2124b430cb3a07a8a8d3ca5
//   - Initialized(2) emitted in the same tx; slot 50 (_initialized) reads
//     0x05, so reinitializer(2) is permanently consumed on the live proxy
//     (OpenZeppelin Initializable does not decrement).
//
// The Bridge.initializeV2_FixVaultZeroDeposit selector this script targets
// is not declared in the Bridge source in this tree. Kept func.skip-gated
// for historical reference only.
// ////////////////////////////////////////////////////////////////////////

import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

/**
 * @notice Historical record of the Bridge v2 upgrade that repaired the
 *         vault=0x0 deposit blocking sweeps for wallet 71bfad9a. The
 *         repair executed on mainnet via the Timelock route; see the
 *         DEPRECATED block at the top of this file for on-chain evidence.
 *         This script body is kept in tree for provenance only and is
 *         hard-disabled by func.skip.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { get, log } = deployments
  const { deployer } = await getNamedAccounts()

  log("=".repeat(80))
  log("Upgrading Bridge with vault=0x0 deposit fix")
  log("=".repeat(80))

  // WARNING: This script expects no changes in the external libraries and uses
  // `get` function to load the ones that were already published before.
  // If there are any changes in the external libraries make sure to deploy fresh
  // versions of the libraries and link them to the implementation.
  const Deposit = await get("Deposit")
  const DepositSweep = await get("DepositSweep")
  const Redemption = await get("Redemption")
  const Wallets = await get("Wallets")
  const Fraud = await get("Fraud")
  const MovingFunds = await get("MovingFunds")

  log("Using existing libraries:")
  log(`  Deposit: ${Deposit.address}`)
  log(`  DepositSweep: ${DepositSweep.address}`)
  log(`  Redemption: ${Redemption.address}`)
  log(`  Wallets: ${Wallets.address}`)
  log(`  Fraud: ${Fraud.address}`)
  log(`  MovingFunds: ${MovingFunds.address}`)

  // Get the existing Bridge proxy
  const bridgeDeployment = await get("Bridge")
  log(`\nExisting Bridge proxy: ${bridgeDeployment.address}`)

  // Perform the upgrade with the reinitializer call
  const [bridge, proxyDeployment] = await helpers.upgrades.upgradeProxy(
    "Bridge",
    "Bridge",
    {
      contractName: "Bridge",
      factoryOpts: {
        signer: await ethers.getSigner(deployer),
        libraries: {
          Deposit: Deposit.address,
          DepositSweep: DepositSweep.address,
          Redemption: Redemption.address,
          Wallets: Wallets.address,
          Fraud: Fraud.address,
          MovingFunds: MovingFunds.address,
        },
      },
      proxyOpts: {
        kind: "transparent",
        // Allow external libraries linking. We need to ensure manually that the
        // external libraries we link are upgrade safe, as the OpenZeppelin plugin
        // doesn't perform such a validation yet.
        // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
        unsafeAllow: ["external-library-linking"],
        // Use call option to invoke the reinitializer instead of the original initializer
        call: {
          fn: "initializeV2_FixVaultZeroDeposit",
          args: [],
        },
      },
    }
  )

  log("\nUpgrade completed!")
  log("  New implementation deployed")
  log(`  Bridge proxy: ${proxyDeployment.address}`)
  log(`  Bridge instance: ${bridge.address}`)

  // Verify on Etherscan if on mainnet
  if (hre.network.tags.etherscan) {
    log("\nVerifying on Etherscan...")
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  // Verify on Tenderly if configured
  if (hre.network.tags.tenderly) {
    log("\nVerifying on Tenderly...")
    await hre.tenderly.verify({
      name: "Bridge",
      address: bridge.address,
    })
  }

  log(`\n${"=".repeat(80)}`)
  log("Upgrade complete. Verify the deposit vault was fixed:")
  log("=".repeat(80))
  log(`
Post-upgrade verification commands:

1. Check new implementation:
   cast call ${bridgeDeployment.address} "implementation()" --rpc-url <RPC_URL>

2. Verify deposit vault was fixed (should return TBTCVault address):
   cast call ${bridgeDeployment.address} \\
     "deposits(uint256)(address,uint64,uint32,address,uint64,uint32,bytes32)" \\
     0xf3bc9cd6f46f4c206bc8711e40bb5692e8fe5f0ac4d4da0a709dc71bb751c98a \\
     --rpc-url <RPC_URL>

3. Expected vault value after fix:
   - Mainnet TBTCVault: 0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD
   - Sepolia TBTCVault: Check deployments/sepolia/TBTCVault.json

4. Check for DepositVaultFixed event in the upgrade transaction
`)
}

export default func

func.tags = ["UpgradeBridgeVaultFix"]
func.dependencies = ["Bridge"]

// Hard-disabled: the targeted Bridge.initializeV2_FixVaultZeroDeposit
// selector is not declared in the Bridge source in this tree, and the
// on-chain repair has executed (see DEPRECATED header for evidence).
// Kept for historical reference only.
func.skip = async () => true
