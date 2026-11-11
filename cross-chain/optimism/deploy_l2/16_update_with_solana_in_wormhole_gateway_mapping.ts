import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { execute, log } = deployments
  const { deployer } = await getNamedAccounts()

  // Fake SolanaWormholeGateway for local development purposes only.
  const fakeSolanaWormholeGateway =
    "0x11a22dc2e01ecd2ae40864822d4406ff8aed4e2b8932385dabe818422ff67e1b"

  // See https://docs.wormhole.com/wormhole/blockchain-environments/solana
  // This ID is valid for both Solana Devnet and Mainnet
  const solanaWormholeChainID = 1

  const solanaWormholeGateway = await deployments.getOrNull(
    "SolanaWormholeGateway"
  )

  let solanaWormholeGatewayAddress = solanaWormholeGateway?.address
  if (!solanaWormholeGatewayAddress && hre.network.name === "hardhat") {
    solanaWormholeGatewayAddress = fakeSolanaWormholeGateway
    log(`fake SolanaWormholeGateway address ${solanaWormholeGatewayAddress}`)
  }

  await execute(
    "OptimismWormholeGateway",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateGatewayAddress",
    solanaWormholeChainID,
    solanaWormholeGatewayAddress
  )
}

export default func

func.tags = ["SetSolanaGatewayAddress"]

// Solana is outside the supported Sepolia routing topology.
func.skip = async (hre) => hre.network.name === "optimismSepolia"
func.dependencies = ["OptimismWormholeGateway", "SolanaWormholeGateway"]
