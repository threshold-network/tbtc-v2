import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, helpers, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  // P2TRSignatureFraudRouter is a plain (non-upgradeable) contract
  // that pins the Bridge address at construction. Sister sidecar to
  // EcdsaFraudRouter for the P2TR signature-fraud lifecycle. Wiring
  // is a separate one-time governance step
  // (Bridge.setP2TRFraudRouter) performed by the deployment pipeline
  // after this script runs.
  const p2trFraudRouter = await deploy("P2TRSignatureFraudRouter", {
    from: deployer,
    args: [Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(p2trFraudRouter)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "P2TRSignatureFraudRouter",
      address: p2trFraudRouter.address,
    })
  }
}

export default func

func.tags = ["P2TRSignatureFraudRouter"]
func.dependencies = ["Bridge"]
