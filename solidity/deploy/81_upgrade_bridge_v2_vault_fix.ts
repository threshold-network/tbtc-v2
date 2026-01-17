import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

/**
 * @notice This deployment script upgrades the Bridge contract to v2 with the
 *         vault=0x0 deposit fix. The fix is implemented as a reinitializer
 *         function that runs once during the upgrade.
 *
 * @dev IMPORTANT DEPLOYMENT NOTES:
 *
 * MAINNET:
 * - The upgrade MUST go through the Timelock contract (24h delay)
 * - Council multisig (6-of-9) schedules and executes via Timelock
 * - Timeline: ~36-40 hours total (schedule + 24h delay + execute)
 * - See consensus document for detailed rollout plan
 *
 * SEPOLIA (for upgrade mechanism testing):
 * - No Timelock required, direct EOA upgrade
 * - The reinitializer has MAINNET-SPECIFIC hardcoded values:
 *   - Deposit key: specific to the mainnet vault=0x0 deposit
 *   - TBTCVault: mainnet address (0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD)
 * - On Sepolia, the reinitializer will FAIL if:
 *   - The deposit doesn't exist (revealedAt == 0)
 *   - The vault is already set (vault != 0x0)
 * - For testing on Sepolia, either:
 *   - Create a mock deposit with vault=0x0 first, OR
 *   - Use a mainnet fork (recommended for accurate testing)
 *
 * Context:
 * - Wallet 71bfad9a has a deposit with vault=0x0 that is blocking all sweeps
 * - This deposit was revealed on 2026-01-08 by depositor 0xe7c9a5298A2d2e48B5df3F9D361BA1469B0f436B
 * - The reinitializer fixes the deposit's vault to point to TBTCVault
 *
 * Usage:
 *   # For Sepolia (testing upgrade mechanism - will fail on reinitializer):
 *   yarn deploy --tags UpgradeBridgeVaultFix --network sepolia
 *
 *   # For Mainnet (production - requires Timelock):
 *   # See consensus document for Timelock-based deployment
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

// IMPORTANT: Set to false when ready to deploy
// When running the upgrade, set this to false and run:
// yarn deploy --tags UpgradeBridgeVaultFix --network <NETWORK>
func.skip = async () => true
