import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, read } = deployments
  const { deployer } = await getNamedAccounts()

  deployments.log("disabling redemptions in the Bridge")

  // To disable redemptions, we need to make the redemption dust threshold
  // extremely high. The redemption dust threshold value is determined by the
  // redemptionDustThreshold governance parameter. This parameter is uint64.
  // The maximum value for the uint64 is 2^64-1 = 18446744073709551615.
  const redemptionDustThreshold = ethers.toBigInt("18446744073709551615")

  // To emphasize the fact that redemptions are disabled, we set:
  // - redemptionTimeout to uint32 max value (2^32-1 = 4294967295),
  // - redemptionTimeoutSlashingAmount to zero,
  // - redemptionTimeoutNotifierRewardMultiplier to zero.
  const redemptionTimeout = ethers.toBigInt("4294967295")
  const redemptionTimeoutSlashingAmount = ethers.toBigInt("0")
  const redemptionTimeoutNotifierRewardMultiplier = ethers.toBigInt("0")

  // Fetch the current values of other redemption parameters to keep them unchanged.
  const redemptionParameters = await read("Bridge", "redemptionParameters")

  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateRedemptionParameters",
    redemptionDustThreshold,
    redemptionParameters.redemptionTreasuryFeeDivisor,
    redemptionParameters.redemptionTxMaxFee,
    redemptionParameters.redemptionTxMaxTotalFee,
    redemptionTimeout,
    redemptionTimeoutSlashingAmount,
    redemptionTimeoutNotifierRewardMultiplier
  )
}

export default func

func.tags = ["DisableRedemptions"]
func.dependencies = ["Bridge"]

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
