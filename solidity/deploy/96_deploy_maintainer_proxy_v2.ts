import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deploy, execute, getOrNull, read } = deployments
  const { deployer, governance } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")
  const ReimbursementPool = await deployments.get("ReimbursementPool")

  const maintainerProxyV2 = await deploy("MaintainerProxyV2", {
    contract: "MaintainerProxyV2",
    from: deployer,
    args: [Bridge.address, ReimbursementPool.address],
    log: true,
    waitConfirmations: 1,
  })

  // Copy the existing SPV-maintainer allowlist while the deployer still owns
  // the fresh V2 contract. The index check makes resumed deployments safe.
  if ((await getOrNull("MaintainerProxy")) !== null) {
    const spvMaintainers: string[] = await read(
      "MaintainerProxy",
      "allSpvMaintainers"
    )

    await spvMaintainers.reduce<Promise<void>>(async (previous, maintainer) => {
      await previous
      const maintainerIndex = await read(
        "MaintainerProxyV2",
        "isSpvMaintainer",
        maintainer
      )

      if (maintainerIndex.toString() === "0") {
        await execute(
          "MaintainerProxyV2",
          { from: deployer, log: true, waitConfirmations: 1 },
          "authorizeSpvMaintainer",
          maintainer
        )
      }

      return undefined
    }, Promise.resolve())
  }

  await helpers.ownable.transferOwnership(
    "MaintainerProxyV2",
    governance,
    deployer
  )

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(maintainerProxyV2)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "MaintainerProxyV2",
      address: maintainerProxyV2.address,
    })
  }

  // Activation intentionally remains a governance operation: authorize V2
  // in both Bridge and ReimbursementPool before trusting ReservationVault.
}

export default func

func.tags = ["MaintainerProxyV2"]

// Do not declare the legacy Bridge or MaintainerProxy tags as dependencies.
// Their scripts deploy immutable/proxy contracts and are unsafe to recurse on
// an existing network. The deployment records read above are prerequisites;
// a full fresh deployment executes them earlier by numeric script order.
