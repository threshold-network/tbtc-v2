import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, helpers, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer, governance } = await getNamedAccounts()

  const timelock = await deploy("Timelock", {
    from: deployer,
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
        "0xe989805835093e37E6b12dCddF718e0481024573",
        "0x1Ba899530A89fAb245De9ff6cc23534F4a8A4e58",
        "0x75ed7b219a737134f00255e331a36a706BD2ae2C",
        "0xcE3778528fC73D46685069D455bbCcE16A6e22Af",
        "0x35B46702C5d1CD36194217Fb92F72B563eFf851A",
        "0xf791EfdF778a3Ca9cc193fFbe57Da33d1596E854",
        governance,
      ],
    ],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(timelock)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "Timelock",
      address: timelock.address,
    })
  }
}

export default func

func.tags = ["Timelock"]
