import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function deployBank(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const bank = await deploy("Bank", {
    contract: process.env.TEST_USE_STUBS_TBTC === "true" ? "BankStub" : "Bank",
    from: deployer,
    args: [],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(bank)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "Bank",
      address: bank.address,
    })
  }
}

export default func

func.tags = ["Bank"]
