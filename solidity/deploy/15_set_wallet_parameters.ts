import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, read } = deployments
  const { deployer } = await getNamedAccounts()

  deployments.log("setting initial wallet parameters")

  // We set the wallet creation period to two weeks and the min BTC balance to
  // zero. It will allow creating new wallets every two weeks even though they
  // are not sweeping so from the Bridge's perspective their balance is zero.
  //
  // 14 * 24 * 60 * 60 = 1209600 seconds
  const walletCreationPeriod = ethers.toBigInt("1209600")
  const walletCreationMinBtcBalance = ethers.toBigInt("0")

  // Fetch the current values of other wallet parameters to keep them unchanged.
  const walletParameters = await read("Bridge", "walletParameters")

  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateWalletParameters",
    walletCreationPeriod,
    walletCreationMinBtcBalance,
    walletParameters.walletCreationMaxBtcBalance,
    walletParameters.walletClosureMinBtcBalance,
    walletParameters.walletMaxAge,
    walletParameters.walletMaxBtcTransfer,
    walletParameters.walletClosingPeriod
  )
}

export default func

func.tags = ["SetWalletParameters"]
func.dependencies = ["Bridge"]

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
