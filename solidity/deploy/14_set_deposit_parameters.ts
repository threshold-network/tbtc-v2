import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, read } = deployments
  const { deployer } = await getNamedAccounts()

  deployments.log("setting initial deposit parameters")

  const depositTreasuryFeeDivisor = ethers.toBigInt("0")

  // We set the deposit reveal ahead period to 8 months and two weeks, assuming
  // 1 month = 30 days. That gives 254 days which translates to
  // 254 * 24 * 60 * 60 = 21945600 seconds
  const depositRevealAheadPeriod = ethers.toBigInt("21945600")

  // Fetch the current values of other deposit parameters to keep them unchanged.
  const depositParameters = await read("Bridge", "depositParameters")

  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateDepositParameters",
    depositParameters.depositDustThreshold,
    depositTreasuryFeeDivisor,
    depositParameters.depositTxMaxFee,
    depositRevealAheadPeriod
  )
}

export default func

func.tags = ["SetDepositParameters"]
func.dependencies = ["Bridge"]

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
