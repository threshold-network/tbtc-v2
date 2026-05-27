import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer, chaosnetOwner } = await getNamedAccounts()
  const { execute } = deployments
  const { to1e18 } = helpers.number

  const POOL_WEIGHT_DIVISOR = to1e18(1)

  const T = await deployments.get("T")

  // The FROST registry uses a dedicated sortition pool, mirroring
  // the upstream ECDSA registry's pattern. RFC #437 §"Open
  // considerations" #6 originally recommended pool sharing
  // (operators are the same physical entities), but the upstream
  // SortitionPool's owner model is single-owner, so sharing one
  // pool between the ECDSA and FROST registries would require a
  // router contract owning the pool — a substantial separate
  // design that is deferred until D-2's ECDSA retirement makes the
  // sharing question moot. Until then, operators register
  // separately in `EcdsaSortitionPool` and `FrostSortitionPool`.
  const FrostSortitionPool = await deployments.deploy("FrostSortitionPool", {
    contract: "SortitionPool",
    from: deployer,
    args: [T.address, POOL_WEIGHT_DIVISOR],
    log: true,
    waitConfirmations: 1,
  })

  await execute(
    "FrostSortitionPool",
    { from: deployer, log: true, waitConfirmations: 1 },
    "transferChaosnetOwnerRole",
    chaosnetOwner
  )

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(FrostSortitionPool)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "FrostSortitionPool",
      address: FrostSortitionPool.address,
    })
  }
}

export default func

func.tags = ["FrostSortitionPool"]
func.dependencies = ["TokenStaking", "T"]
