import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function () {
  // Polygon support is deprecated. This resolver is intentionally kept as a
  // no-op so historical deployments remain loadable without configuring a new
  // Arbitrum peer.
}

export default func

func.tags = ["ArbitrumWormholeGateway"]
