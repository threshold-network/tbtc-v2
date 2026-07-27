import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, read } = deployments
  const { deployer } = await getNamedAccounts()

  deployments.log("disabling moving funds in the Bridge")

  // To disable moving funds mechanism, we need to prevent wallets entering
  // into the `MOVING_FUNDS` state. A wallet can enter this state in three ways:
  // 1. Wallet does not handle a redemption request on time
  // 2. Wallet submits a valid heartbeat failure claim
  // 3. Wallet is no longer an active wallet and becomes "closeable" i.e.
  //    fulfills all conditions necessary to begin the closing process
  //
  // The first way is covered as redemptions are disabled for the initial
  // launch (see 07_disable_redemptions.ts).
  //
  // The second way requires that a majority of the wallet signing group signs
  // the claim. However, the claim feature is not yet implemented in the
  // official off-chain software so the only option is a malicious majority
  // that cooperates to produce a claim against the protocol. That case has a
  // very low probability.
  //
  // The third case is the only one relevant for this script. A wallet cannot
  // become "closeable" if both of the following is true:
  // - walletMaxAge is set to the maximum value allowed for uint32 type (2^32-1 = 4294967295)
  // - walletClosureMinBtcBalance is zero
  const walletMaxAge = ethers.toBigInt("4294967295")
  const walletClosureMinBtcBalance = ethers.toBigInt("0")

  // Fetch the current values of other wallet parameters to keep them unchanged.
  const walletParameters = await read("Bridge", "walletParameters")

  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateWalletParameters",
    walletParameters.walletCreationPeriod,
    walletParameters.walletCreationMinBtcBalance,
    walletParameters.walletCreationMaxBtcBalance,
    walletClosureMinBtcBalance,
    walletMaxAge,
    walletParameters.walletMaxBtcTransfer,
    walletParameters.walletClosingPeriod
  )

  // To emphasize the fact that moving funds is disabled, we set:
  // - movingFundsTimeout to uint32 max value (2^32-1 = 4294967295),
  // - movedFundsSweepTimeout to uint32 max value,
  // - movingFundsTimeoutSlashingAmount to 0,
  // - movedFundsSweepTimeoutSlashingAmount to 0,
  // - movingFundsTimeoutNotifierRewardMultiplier to 0,
  // - movedFundsSweepTimeoutNotifierRewardMultiplier to 0.
  const movingFundsTimeout = ethers.toBigInt("4294967295")
  const movedFundsSweepTimeout = ethers.toBigInt("4294967295")
  const movingFundsTimeoutSlashingAmount = ethers.toBigInt("0")
  const movedFundsSweepTimeoutSlashingAmount = ethers.toBigInt("0")
  const movingFundsTimeoutNotifierRewardMultiplier = ethers.toBigInt("0")
  const movedFundsSweepTimeoutNotifierRewardMultiplier =
    ethers.toBigInt("0")

  // Fetch the current values of other moving funds parameters to keep them unchanged.
  const movingFundsParameters = await read("Bridge", "movingFundsParameters")

  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateMovingFundsParameters",
    movingFundsParameters.movingFundsTxMaxTotalFee,
    movingFundsParameters.movingFundsDustThreshold,
    movingFundsParameters.movingFundsTimeoutResetDelay,
    movingFundsTimeout,
    movingFundsTimeoutSlashingAmount,
    movingFundsTimeoutNotifierRewardMultiplier,
    movingFundsParameters.movingFundsCommitmentGasOffset,
    movingFundsParameters.movedFundsSweepTxMaxTotalFee,
    movedFundsSweepTimeout,
    movedFundsSweepTimeoutSlashingAmount,
    movedFundsSweepTimeoutNotifierRewardMultiplier
  )
}

export default func

func.tags = ["DisableMovingFunds"]
func.dependencies = ["Bridge"]

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
