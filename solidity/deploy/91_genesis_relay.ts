import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function genesisLightRelay(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  // The genesis header comes form the Bitcoin mainnet block at height 766080
  // which is the first block of Bitcoin difficulty epoch 380.
  const genesisHeader =
    "0x0000402089138e40cd8b4832beb8013bc80b1425c8bcbe10fc28040000000000000000" +
    "0058a06ab0edc5653a6ab78490675a954f8d8b4d4f131728dcf965cd0022a02cdde59f8e" +
    "63303808176bbe3919"
  const genesisHeight = 766080
  const genesisProofLength = 20

  await execute(
    "LightRelay",
    { from: deployer, log: true, waitConfirmations: 1 },
    "genesis",
    genesisHeader,
    genesisHeight,
    genesisProofLength
  )
}

export default func

func.tags = ["GenesisLightRelay"]
func.dependencies = ["LightRelay"]

// Only execute for mainnet.
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
