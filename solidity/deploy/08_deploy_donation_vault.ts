import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bank = await deployments.get("Bank")

  const donationVault = await deploy("DonationVault", {
    contract: "DonationVault",
    from: deployer,
    args: [Bank.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(donationVault)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "DonationVault",
      address: donationVault.address,
    })
  }
}

export default func

func.tags = ["DonationVault"]
func.dependencies = ["Bank"]
