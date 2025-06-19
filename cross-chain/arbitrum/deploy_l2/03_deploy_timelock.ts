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
        "0x2844a0d6442034D3027A05635F4224d966C54fD7",
        "0xf35dEE924F483Bc234F09cbfbc8B4488fD06be20",
        "0x739730cCb2a34cc83D3e30645002C52bA4B06167",
        "0x3c7832b15407D1BD8aE03C41D2A849006A0cD905",
        "0x1Ba899530A89fAb245De9ff6cc23534F4a8A4e58",
        "0x12107242e2FbEd0a503e102751fa6Aa8cB7446eC",
        "0x9C20993E98aa5A6BAD8AD0FC42C2f4cc3008096f",
        "0x35B46702C5d1CD36194217Fb92F72B563eFf851A",
        "0xe05808c1EFe0302b27Fc21F0E4a0f15e21e62e78",
        governance,
      ],
    ],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.arbiscan) {
    await hre.run("verify:verify", {
      contract: "@keep-network/tbtc-v2/contracts/Timelock.sol:Timelock",
      address: timelock.address,
      constructorArguments: timelock.args,
    })
  }
}

export default func

func.tags = ["Timelock"]
