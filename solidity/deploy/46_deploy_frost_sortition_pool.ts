import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, ethers, helpers } = hre
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

  // Idempotency: re-runs of this deploy script must not revert on a
  // non-deployer chaosnet-owner. Mirror the precheck pattern used by the
  // sibling FROST scripts (44/45/48/49/50/52/53) — read the current
  // chaosnet-owner before sending the setter and skip if it already
  // matches the target. SortitionPool's chaosnet-owner transfer is gated
  // by onlyChaosnetOwner, so any second `yarn deploy` run on a network
  // where chaosnetOwner != deployer would otherwise revert and break the
  // re-run guarantee. This branch is the canonical idempotent path; if
  // the current owner is an UNEXPECTED third party, abort and surface
  // the operator-visible state rather than silently overwriting it.
  const frostSortitionPool = await ethers.getContractAt(
    "SortitionPool",
    FrostSortitionPool.address
  )
  const currentChaosnetOwner = await frostSortitionPool.chaosnetOwner()

  if (currentChaosnetOwner.toLowerCase() === chaosnetOwner.toLowerCase()) {
    console.log(
      `FrostSortitionPool ${FrostSortitionPool.address} chaosnet-owner already set to ${chaosnetOwner}; skipping transfer`
    )
  } else if (currentChaosnetOwner.toLowerCase() !== deployer.toLowerCase()) {
    throw new Error(
      `Refusing to transfer FrostSortitionPool chaosnet-owner: current owner is ${currentChaosnetOwner}, ` +
        `expected either deployer ${deployer} (post-deploy state) or target ${chaosnetOwner} (already transferred). ` +
        "Move the live owner to the target manually before re-running this script."
    )
  } else {
    await execute(
      "FrostSortitionPool",
      { from: deployer, log: true, waitConfirmations: 1 },
      "transferChaosnetOwnerRole",
      chaosnetOwner
    )
  }

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
func.dependencies = ["T"]