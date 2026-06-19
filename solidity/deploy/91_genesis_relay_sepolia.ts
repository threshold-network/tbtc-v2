import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

/**
 * Initializes LightRelay (SepoliaLightRelay) with Bitcoin testnet4 genesis block.
 * Requires LightRelay owner key (0x4815cd81ffc21039a25acfbd97ce75cce8579042).
 *
 * Genesis block from BIP-94:
 * - Hash: 00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043
 * - Height: 0 (epoch boundary)
 * - genesisProofLength: 4 for testnet
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments } = hre
  const { execute, read } = deployments

  const alreadyReady = (await read("LightRelay", "ready")) as boolean
  if (alreadyReady) {
    deployments.log(
      "LightRelay genesis already performed (ready=true); skipping genesis()"
    )
    return
  }

  // Testnet4 genesis block header (80 bytes) from BIP-94
  const genesisHeader =
    "0x010000000000000000000000000000000000000000000000000000000000000000000000" +
    "4e7b2b9128fe0291db0693af2ae418b767e657cd407e80cb1434221eaea7a07a046f3566" +
    "ffff001dbb0c7817"
  const genesisHeight = 0 // Block 0, epoch boundary (0 % 2016 == 0)
  const genesisProofLength = 4 // Lower for testnet (20 for mainnet)

  await execute(
    "LightRelay",
    {
      from: (await hre.getNamedAccounts()).deployer,
      log: true,
      waitConfirmations: 1,
    },
    "genesis",
    genesisHeader,
    genesisHeight,
    genesisProofLength
  )
}

export default func

func.tags = ["GenesisLightRelaySepolia"]
func.dependencies = ["LightRelay"]

// Only execute for Sepolia.
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "sepolia"
