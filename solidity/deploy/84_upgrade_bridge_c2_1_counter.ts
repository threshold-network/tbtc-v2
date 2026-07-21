import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import {
  abortLiveBridgeUpgradeWithoutVettedCompleteV2,
  isEphemeralLocalNetwork,
} from "./45_deploy_p2tr_signature_fraud_router"

/// Phase C-2.1a upgrade script — deploys the current versions of all
/// external libraries linked by `Bridge` and upgrades the proxy using
/// those addresses.
///
/// Why a dedicated script: the standard `80_upgrade_bridge_v2.ts`
/// pattern explicitly reuses pre-existing library deployments via
/// `deployments.get`. This script compiles the current `Bridge` source,
/// so each linked library must be deployed from the same source tree.
/// Otherwise, the implementation can delegate to stale library bytecode
/// that lacks the FROST and Taproot behavior exposed by the current Bridge.
/// `hardhat-deploy` compares deployment bytecode and reuses an existing
/// address only when it already contains the current library version.
const func: DeployFunction = async function upgradeBridgeC21Counter(
  hre: HardhatRuntimeEnvironment
) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { get, deploy, log } = deployments
  const { deployer, treasury } = await getNamedAccounts()

  if (!isEphemeralLocalNetwork(hre.network.name)) {
    await abortLiveBridgeUpgradeWithoutVettedCompleteV2(
      hre,
      "84_upgrade_bridge_c2_1_counter"
    )
  }

  const Bank = await get("Bank")
  const LightRelay = await get("LightRelay")
  const WalletRegistry = await get("WalletRegistry")
  const ReimbursementPool = await get("ReimbursementPool")

  const txProofDifficultyFactor = 6

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  const P2TRReservation = await deploy("P2TRReservation", deployOptions)
  const P2TRPreSigning = await deploy("P2TRPreSigning", deployOptions)
  const p2trReservationLinkedOptions: DeployOptions = {
    ...deployOptions,
    libraries: { P2TRReservation: P2TRReservation.address },
  }
  const Deposit = await deploy("Deposit", deployOptions)
  const DepositSweep = await deploy(
    "DepositSweep",
    p2trReservationLinkedOptions
  )
  const Redemption = await deploy("Redemption", p2trReservationLinkedOptions)
  const Wallets = await deploy("Wallets", {
    contract: "contracts/bridge/Wallets.sol:Wallets",
    ...p2trReservationLinkedOptions,
  })
  const Fraud = await deploy("Fraud", deployOptions)
  const MovingFunds = await deploy("MovingFunds", p2trReservationLinkedOptions)

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
          Wallets: Wallets.address,
          Fraud: Fraud.address,
          MovingFunds: MovingFunds.address,
          P2TRPreSigning: P2TRPreSigning.address,
          P2TRReservation: P2TRReservation.address,
        },
      },
      proxyOpts: {
        kind: "transparent",
        constructorArgs: [ethers.constants.AddressZero],
        unsafeAllow: ["external-library-linking"],
      },
    }
  )

  log(
    "C-2.1a upgrade: current Bridge libraries linked:\n" +
      `  Deposit: ${Deposit.address}\n` +
      `  DepositSweep: ${DepositSweep.address}\n` +
      `  Redemption: ${Redemption.address}\n` +
      `  Wallets: ${Wallets.address}\n` +
      `  Fraud: ${Fraud.address}\n` +
      `  MovingFunds: ${MovingFunds.address}\n` +
      `  P2TRPreSigning: ${P2TRPreSigning.address}\n` +
      `  P2TRReservation: ${P2TRReservation.address}\n` +
      `  Bridge: ${bridge.address}`
  )

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(Deposit)
    await helpers.etherscan.verify(DepositSweep)
    await helpers.etherscan.verify(Redemption)
    await helpers.etherscan.verify(Wallets)
    await helpers.etherscan.verify(Fraud)
    await helpers.etherscan.verify(MovingFunds)
    await helpers.etherscan.verify(P2TRPreSigning)
    await helpers.etherscan.verify(P2TRReservation)
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "Deposit",
      address: Deposit.address,
    })
    await hre.tenderly.verify({
      name: "DepositSweep",
      address: DepositSweep.address,
    })
    await hre.tenderly.verify({
      name: "Redemption",
      address: Redemption.address,
    })
    await hre.tenderly.verify({
      name: "Wallets",
      address: Wallets.address,
    })
    await hre.tenderly.verify({
      name: "Fraud",
      address: Fraud.address,
    })
    await hre.tenderly.verify({
      name: "MovingFunds",
      address: MovingFunds.address,
    })
    await hre.tenderly.verify({
      name: "P2TRPreSigning",
      address: P2TRPreSigning.address,
    })
    await hre.tenderly.verify({
      name: "P2TRReservation",
      address: P2TRReservation.address,
    })
    await hre.tenderly.verify({
      name: "Bridge",
      address: bridge.address,
    })
  }
}

export default func

func.tags = ["UpgradeBridgeC21Counter"]
func.dependencies = ["FrostCustodyNoGo"]
// Off by default. To run, set the environment variable
// `RUN_UPGRADE_C2_1_COUNTER=1` and invoke:
//
//   RUN_UPGRADE_C2_1_COUNTER=1 yarn deploy \
//     --tags UpgradeBridgeC21Counter --network <NETWORK>
//
// The env-var gate avoids accidental execution during normal
// fixture-driven deploys (e.g., a `yarn deploy` without tag
// filtering on a development network would otherwise rerun
// this upgrade on every invocation). It also lets the documented
// command actually execute — the prior `func.skip = async () => true`
// was unconditional and made the documented invocation a no-op.
func.skip = async () => process.env.RUN_UPGRADE_C2_1_COUNTER !== "1"
