import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployWalletProposalValidator(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, helpers, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  const walletProposalValidator = await deploy("WalletProposalValidator", {
    from: deployer,
    args: [Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(walletProposalValidator)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "WalletProposalValidator",
      address: walletProposalValidator.address,
    })
  }
}

export default func

func.tags = ["WalletProposalValidator"]
func.dependencies = ["Bridge"]
