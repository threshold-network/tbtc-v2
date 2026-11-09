import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { helpers, deployments } = hre
  const { log } = deployments

  const SolanaWormholeGateway = await deployments.getOrNull(
    "SolanaWormholeGateway"
  )

  if (
    SolanaWormholeGateway &&
    helpers.address.isValid(SolanaWormholeGateway.address)
  ) {
    log(
      `using existing SolanaWormholeGateway at ${SolanaWormholeGateway.address}`
    )
  } else if (hre.network.name === "hardhat") {
    log("using fake SolanaWormholeGateway for hardhat network")
  } else {
    throw new Error("deployed SolanaWormholeGateway contract not found")
  }
}

export default func

func.tags = ["SolanaWormholeGateway"]

// Solana is outside the supported Sepolia routing topology.
func.skip = async (hre) => hre.network.name === "arbitrumSepolia"
