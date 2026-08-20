import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"

const func: DeployFunction = async function deployBridge(
  hre: HardhatRuntimeEnvironment
) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer, treasury } = await getNamedAccounts()

  const Bank = await deployments.get("Bank")
  const LightRelay = await deployments.get("LightRelay")
  const WalletRegistry = await deployments.get("WalletRegistry")
  const ReimbursementPool = await deployments.get("ReimbursementPool")

  // Local tests and Sepolia (testnet4 Bitcoin): use `1` to ease SPV proofs.
  // Other live networks use mainnet-style `6`.
  const network = deployments.getNetworkName()
  const txProofDifficultyFactor =
    network === "hardhat" ||
    network === "development" ||
    network === "system_tests" ||
    network === "sepolia"
      ? 1
      : 6

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  const Deposit = await deploy("Deposit", deployOptions)
  const DepositSweep = await deploy("DepositSweep", deployOptions)
  const Redemption = await deploy("Redemption", deployOptions)
  const Wallets = await deploy("Wallets", {
    contract: "contracts/bridge/Wallets.sol:Wallets",
    ...deployOptions,
  })
  const Fraud = await deploy("Fraud", deployOptions)
  const MovingFunds = await deploy("MovingFunds", deployOptions)
  const Reservation = await deploy("Reservation", deployOptions)

  // The reservation router holds the Bridge's UTXO-reservation external
  // surface and is reached through the Bridge's fallback via delegatecall.
  // It is stateless code (all storage lives in the Bridge), so a single
  // instance can serve any number of Bridge deployments.
  const ReservationRouter = await deploy("ReservationRouter", {
    ...deployOptions,
    libraries: {
      Reservation: Reservation.address,
    },
  })

  const [bridge, proxyDeployment] = await helpers.upgrades.deployProxy(
    "Bridge",
    {
      contractName:
        process.env.TEST_USE_STUBS_TBTC === "true" ? "BridgeStub" : "Bridge",
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
        },
      },
      proxyOpts: {
        kind: "transparent",
        // Allow external libraries linking. We need to ensure manually that the
        // external  libraries we link are upgrade safe, as the OpenZeppelin plugin
        // doesn't perform such a validation yet.
        // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
        // The Bridge's fallback delegatecalls into the ReservationRouter
        // (see docs/rfc/rfc-13.adoc); this is guarded so it can only be
        // triggered through the proxy, not on the implementation itself.
        unsafeAllow: ["external-library-linking", "delegatecall"],
      },
    }
  )

  // Point the Bridge's fallback at the reservation router. The deployer
  // holds the Bridge governance right after initialization (it is
  // transferred to the governance account in a later script), so this
  // one-time wiring can be done here.
  await (await ethers.getContractAt("Bridge", bridge.address))
    .connect(await ethers.getSigner(deployer))
    .setReservationRouter(ReservationRouter.address)

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(Deposit)
    await helpers.etherscan.verify(DepositSweep)
    await helpers.etherscan.verify(Redemption)
    await helpers.etherscan.verify(Wallets)
    await helpers.etherscan.verify(Fraud)
    await helpers.etherscan.verify(MovingFunds)
    await helpers.etherscan.verify(Reservation)
    await helpers.etherscan.verify(ReservationRouter)

    // We use `verify` instead of `verify:verify` as the `verify` task is defined
    // in "@openzeppelin/hardhat-upgrades" to perform Etherscan verification
    // of Proxy and Implementation contracts.
    await hre.run("verify", {
      address: proxyDeployment.address,
      constructorArgsParams: proxyDeployment.args,
    })
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "Bridge",
      address: bridge.address,
    })
  }
}

export default func

func.tags = ["Bridge"]
func.dependencies = [
  "Bank",
  "LightRelay",
  "Treasury",
  "WalletRegistry",
  "ReimbursementPool",
]
