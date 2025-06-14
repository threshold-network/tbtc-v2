import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer, governance } = await getNamedAccounts()

  const timelock = await deploy("Timelock", {
    from: deployer,
    contract: "@keep-network/tbtc-v2/contracts/Timelock.sol:Timelock",
    args: [
      86400, // 24h governance delay
      [governance], // Threshold Council multisig as a proposer
      // All current signers from the Threshold Council multisig as executors
      // plus the Threshold Council multisig itself. The last one is here in
      // case Threshold Council multisig rotates the owners but forgets to
      // update the Timelock contract.
      // See https://app.safe.global/settings/setup?safe=eth:0x9F6e831c8F8939DC0C830C6e492e7cEf4f9C2F5f
      [
        "0x9C20993E98aa5A6BAD8AD0FC42C2f4cc3008096f",
        "0x2844a0d6442034D3027A05635F4224d966C54fD7",
        "0xeceC507477b969FC05053fB044619b723D458E8e",
        "0x739730cCb2a34cc83D3e30645002C52bA4B06167",
        "0x3c7832b15407D1BD8aE03C41D2A849006A0cD905",
        "0xA6d76e990fE10C4b741ceb87590bE6cb23979a6e",
        "0x49848f38D31e2b150190E44a4fE056a239EA1aad",
        "0x76C6CEf8ae443fA7404dD60dabc18B9158e37A75",
        "0xe05808c1EFe0302b27Fc21F0E4a0f15e21e62e78",
        governance,
      ],
    ],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.basescan) {
    await hre.run("verify:verify", {
      contract: "@keep-network/tbtc-v2/contracts/Timelock.sol:Timelock",
      address: timelock.address,
      constructorArguments: timelock.args,
    })
  }
}

export default func

func.tags = ["Timelock"]
