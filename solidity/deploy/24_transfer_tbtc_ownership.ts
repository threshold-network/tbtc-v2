import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function transferTbtcOwnership(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()

  // In unit tests we cover VendingMachine, VendingMachineV2, and TBTCVault
  // contracts. All those tests require minting TBTC. To make the test setup
  // easier, we leave the responsibility of transferring the TBTC ownership
  // to the test. In system tests and on testnet, TBTCVault is the owner of TBTC
  // token, just like on v1.0 mainnet, after transferring the ownership from the
  // VendingMachine.
  if (hre.network.name !== "hardhat") {
    const TBTCVault = await deployments.get("TBTCVault")
    await helpers.ownable.transferOwnership("TBTC", TBTCVault.address, deployer)
  }
}

export default func

func.tags = ["TransferTBTCOwnership"]
func.dependencies = ["TBTC", "VendingMachine", "TBTCVault"]
func.runAtTheEnd = true
