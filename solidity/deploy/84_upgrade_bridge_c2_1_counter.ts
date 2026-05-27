import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

/// Phase C-2.1a upgrade script — deploys a fresh `Wallets`
/// library (the only one with FROST-related code changes this
/// cycle) and re-links Bridge to the new address.
///
/// Why a dedicated script: the standard `80_upgrade_bridge_v2.ts`
/// pattern explicitly REUSES the pre-existing library
/// deployments via `deployments.get("Wallets")`. C-2.1a's only
/// behavior change is the `self.ecdsaWalletCount += 1` increment
/// in `Wallets.registerNewWallet` — that lives in the `Wallets`
/// library's bytecode, NOT in Bridge's. Reusing the old library
/// address would link the new Bridge implementation to old
/// library code; the counter would stay 0 forever.
/// (Codex P1 review on PR #442.)
///
/// All other linked libraries (`Deposit`, `DepositSweep`,
/// `Redemption`, `MovingFunds`) are unchanged, so this script
/// keeps them at their existing addresses.
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { get, deploy } = deployments
  const { deployer, treasury } = await getNamedAccounts()

  const Bank = await get("Bank")
  const LightRelay = await get("LightRelay")
  const WalletRegistry = await get("WalletRegistry")
  const ReimbursementPool = await get("ReimbursementPool")

  const txProofDifficultyFactor = 6

  // Unchanged libraries — reuse existing addresses.
  const Deposit = await get("Deposit")
  const DepositSweep = await get("DepositSweep")
  const Redemption = await get("Redemption")
  const MovingFunds = await get("MovingFunds")

  // Wallets has changed (C-2.1a counter increment) — deploy
  // a fresh library version. hardhat-deploy will detect the
  // bytecode hash mismatch and publish a new address.
  const Wallets = await deploy("Wallets", {
    contract: "contracts/bridge/Wallets.sol:Wallets",
    from: deployer,
    log: true,
    waitConfirmations: 1,
  })

  const [bridge, proxyDeployment] = await helpers.upgrades.upgradeProxy(
    "Bridge",
    "Bridge",
    {
      contractName: "Bridge",
      initializerArgs: [
        Bank.address,
        LightRelay.address,
        treasury,
        WalletRegistry.address,
        ReimbursementPool.address,
        txProofDifficultyFactor,
      ],
      factoryOpts: {
        signer: await ethers.getSigner(deployer),
        libraries: {
          Deposit: Deposit.address,
          DepositSweep: DepositSweep.address,
          Redemption: Redemption.address,
          // Fresh Wallets address — this is what carries the
          // C-2.1a counter increment.
          Wallets: Wallets.address,
          MovingFunds: MovingFunds.address,
        },
      },
      proxyOpts: {
        kind: "transparent",
        unsafeAllow: ["external-library-linking"],
      },
    }
  )

  console.log(
    `C-2.1a upgrade: fresh Wallets library at ${Wallets.address} linked to Bridge ${bridge.address}`
  )

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(Wallets)
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "Wallets",
      address: Wallets.address,
    })
    await hre.tenderly.verify({
      name: "Bridge",
      address: bridge.address,
    })
  }
}

export default func

func.tags = ["UpgradeBridgeC21Counter"]
// Off by default. To run, set the environment variable
// `RUN_UPGRADE_C2_1_COUNTER=1` and invoke:
//
//   RUN_UPGRADE_C2_1_COUNTER=1 yarn deploy \
//     --tags UpgradeBridgeC21Counter --network <NETWORK>
//
// The env-var gate avoids accidental execution during normal
// fixture-driven deploys (e.g., a `yarn deploy` without tag
// filtering on a development network would otherwise rerun
// this upgrade and link a fresh Wallets library on every
// invocation). It also lets the documented command actually
// execute — the prior `func.skip = async () => true` was
// unconditional and made the documented invocation a no-op
// (Codex P1 review on PR #442).
func.skip = async () => process.env.RUN_UPGRADE_C2_1_COUNTER !== "1"
