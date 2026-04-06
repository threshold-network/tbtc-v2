"use strict"
/**
 * Patched copy of @keep-network/random-beacon/export/deploy/04_deploy_random_beacon.js
 *
 * Upstream always calls helpers.ownable.transferOwnership from deployer. If BeaconSortitionPool was
 * already transferred to a *previous* RandomBeacon (e.g. rerun Phase H without a fresh pool from
 * Phase D), deployer is no longer owner → "Ownable: caller is not the owner".
 *
 * We skip when the pool is already owned by this RandomBeacon, transfer when deployer owns the
 * pool, and otherwise throw a clear error (full --nuke + redeploy keep-core Phase D required).
 *
 * Full-stack script: keep-core Phase D runs this script first and transfers the pool to
 * RandomBeacon. Phase G copies RandomBeacon.json into tbtc-v2; Phase H must not deploy a second
 * RandomBeacon or re-transfer — we exit early when the pool is already owned by the RandomBeacon
 * address from deployments (Phase D).
 */
const func = async function (hre) {
  const { getNamedAccounts, deployments, helpers } = hre
  const { deployer } = await getNamedAccounts()
  const { log } = deployments

  const BeaconSortitionPool = await deployments.get("BeaconSortitionPool")
  const randomBeaconFromPriorPhase = await deployments.getOrNull("RandomBeacon")
  if (randomBeaconFromPriorPhase) {
    const poolOwner = await deployments.read("BeaconSortitionPool", {}, "owner")
    if (helpers.address.equal(poolOwner, randomBeaconFromPriorPhase.address)) {
      log(
        "BeaconSortitionPool already owned by RandomBeacon from keep-core Phase D — skipping redeploy and transferOwnership"
      )
      return
    }
  }

  const T = await deployments.get("T")
  const TokenStaking = await deployments.get("TokenStaking")
  const ReimbursementPool = await deployments.get("ReimbursementPool")
  const BeaconDkgValidator = await deployments.get("BeaconDkgValidator")

  const deployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  const BLS = await deployments.deploy("BLS", deployOptions)
  const BeaconAuthorization = await deployments.deploy(
    "BeaconAuthorization",
    deployOptions
  )
  const BeaconDkg = await deployments.deploy("BeaconDkg", deployOptions)
  const BeaconInactivity = await deployments.deploy(
    "BeaconInactivity",
    deployOptions
  )

  const RandomBeacon = await deployments.deploy("RandomBeacon", {
    contract:
      process.env.TEST_USE_STUBS_BEACON === "true"
        ? "RandomBeaconStub"
        : undefined,
    args: [
      BeaconSortitionPool.address,
      T.address,
      TokenStaking.address,
      BeaconDkgValidator.address,
      ReimbursementPool.address,
    ],
    libraries: {
      BLS: BLS.address,
      BeaconAuthorization: BeaconAuthorization.address,
      BeaconDkg: BeaconDkg.address,
      BeaconInactivity: BeaconInactivity.address,
    },
    ...deployOptions,
  })

  const poolOwner = await deployments.read("BeaconSortitionPool", {}, "owner")
  if (helpers.address.equal(poolOwner, RandomBeacon.address)) {
    log(
      "BeaconSortitionPool already owned by this RandomBeacon; skipping transferOwnership"
    )
  } else if (helpers.address.equal(poolOwner, deployer)) {
    await helpers.ownable.transferOwnership(
      "BeaconSortitionPool",
      RandomBeacon.address,
      deployer
    )
  } else {
    throw new Error(
      `BeaconSortitionPool owner is ${poolOwner}, deployer is ${deployer}. ` +
        `Cannot transfer pool to RandomBeacon at ${RandomBeacon.address}. ` +
        `The pool was likely already transferred to an older RandomBeacon from a previous deploy. ` +
        `Run a full redeploy with --nuke so keep-core Phase D deploys a fresh BeaconSortitionPool, then run Phase H again.`
    )
  }

  if (hre.network.tags.etherscan) {
    await hre.ethers.provider.waitForTransaction(
      RandomBeacon.transactionHash,
      2,
      300000
    )
    await helpers.etherscan.verify(BLS)
    await helpers.etherscan.verify(BeaconAuthorization)
    await helpers.etherscan.verify(BeaconDkg)
    await helpers.etherscan.verify(BeaconInactivity)
    await helpers.etherscan.verify(RandomBeacon)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "RandomBeacon",
      address: RandomBeacon.address,
    })
  }
}

module.exports = func
func.tags = ["RandomBeacon"]
func.dependencies = [
  "T",
  "TokenStaking",
  "ReimbursementPool",
  "BeaconSortitionPool",
  "BeaconDkgValidator",
]
