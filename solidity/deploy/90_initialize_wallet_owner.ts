import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

import initializeWalletOwner from "../tasks/initialize-wallet-owner"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const Bridge = await hre.deployments.get("Bridge")

  hre.deployments.log("initializing Bridge as ECDSA wallet owner")

  await initializeWalletOwner(hre, Bridge.address)
}

export default func

func.tags = ["InitializeWalletOwner"]
func.dependencies = ["Bridge"]
func.runAtTheEnd = true

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "mainnet"
