import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

function revertDataContains(err: unknown, selector: string): boolean {
  const errAny = err as {
    data?: string
    error?: { data?: string }
    message?: string
  }
  const revertData = errAny.data || errAny.error?.data || errAny.message || ""

  return (
    typeof revertData === "string" &&
    revertData.toLowerCase().includes(selector.toLowerCase())
  )
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, ethers, helpers } = hre
  const { deployer } = await getNamedAccounts()
  const deployerSigner = await ethers.getSigner(deployer)

  const Bridge = await deployments.get("Bridge")
  const FrostWalletRegistry = await deployments.get("FrostWalletRegistry")

  const router = await deployments.deploy("BridgeLifecycleRouter", {
    from: deployer,
    args: [Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  const routerContract = await ethers.getContractAt(
    "BridgeLifecycleRouter",
    router.address
  )
  const routerBridge = await routerContract.bridge()
  if (routerBridge.toLowerCase() !== Bridge.address.toLowerCase()) {
    throw new Error(
      `BridgeLifecycleRouter.bridge mismatch: expected ${Bridge.address}, got ${routerBridge}`
    )
  }

  const bridgeContract = await ethers.getContractAt("Bridge", Bridge.address)
  const bridgeGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    (
      await deployments.get("BridgeGovernance")
    ).address
  )
  const frostWalletRegistryContract = await ethers.getContractAt(
    "FrostWalletRegistry",
    FrostWalletRegistry.address
  )

  const currentBridgeGovernance = await bridgeContract.governance()
  const governanceIsDeployer =
    currentBridgeGovernance.toLowerCase() === deployer.toLowerCase()
  const alreadySetSelector = ethers.utils
    .id("LifecycleRouterAlreadySet()")
    .slice(0, 10)

  let bridgeRouterConfirmed = false
  try {
    if (governanceIsDeployer) {
      await bridgeContract
        .connect(deployerSigner)
        .setLifecycleRouter(router.address)
      console.log(
        `wired BridgeLifecycleRouter at ${router.address} onto Bridge directly (governance is still deployer)`
      )
    } else {
      await bridgeGovernance
        .connect(deployerSigner)
        .setLifecycleRouter(router.address)
      console.log(
        `wired BridgeLifecycleRouter at ${router.address} onto Bridge via BridgeGovernance`
      )
    }
    bridgeRouterConfirmed = true
  } catch (err) {
    if (!revertDataContains(err, alreadySetSelector)) {
      const errAny = err as { message?: string }
      console.error(
        "setLifecycleRouter call reverted with an unexpected error;",
        "deploy aborted so the operator can investigate:",
        errAny.message || err
      )
      throw err
    }

    const lifecycleRouterEvents = await bridgeContract.queryFilter(
      bridgeContract.filters.LifecycleRouterSet(),
      0,
      "latest"
    )
    const lastLifecycleRouter =
      lifecycleRouterEvents.length > 0
        ? lifecycleRouterEvents[lifecycleRouterEvents.length - 1].args
            ?.lifecycleRouter
        : undefined

    if (
      lastLifecycleRouter &&
      lastLifecycleRouter.toLowerCase() === router.address.toLowerCase()
    ) {
      bridgeRouterConfirmed = true
      console.log(
        `BridgeLifecycleRouter already wired on this Bridge at ${router.address}; skipping Bridge setter`
      )
    } else {
      throw new Error(
        "Bridge lifecycle router is already set, but the LifecycleRouterSet event " +
          `does not match this deployment (${router.address}). Refusing to guess ` +
          "the one-time Bridge router value."
      )
    }
  }

  if (!bridgeRouterConfirmed) {
    throw new Error("Bridge lifecycle router was not confirmed")
  }

  const currentLifecycleOwner =
    await frostWalletRegistryContract.lifecycleOwner()
  if (currentLifecycleOwner.toLowerCase() === router.address.toLowerCase()) {
    console.log(
      `FrostWalletRegistry.lifecycleOwner already set to BridgeLifecycleRouter ${router.address}`
    )
  } else {
    const registryGovernance = await frostWalletRegistryContract.governance()
    if (registryGovernance.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error(
        "FrostWalletRegistry.lifecycleOwner must be updated to " +
          `${router.address}, but registry governance is ${registryGovernance}; ` +
          `deployer ${deployer} cannot call updateLifecycleOwner directly`
      )
    }

    await frostWalletRegistryContract
      .connect(deployerSigner)
      .updateLifecycleOwner(router.address)
    console.log(
      `wired FrostWalletRegistry.lifecycleOwner to BridgeLifecycleRouter ${router.address}`
    )
  }

  const finalLifecycleOwner = await frostWalletRegistryContract.lifecycleOwner()
  if (finalLifecycleOwner.toLowerCase() !== router.address.toLowerCase()) {
    throw new Error(
      "FrostWalletRegistry.lifecycleOwner mismatch after deploy: " +
        `expected ${router.address}, got ${finalLifecycleOwner}`
    )
  }

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(router)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "BridgeLifecycleRouter",
      address: router.address,
    })
  }
}

export default func

func.tags = ["BridgeLifecycleRouter"]
func.dependencies = ["Bridge", "BridgeGovernance", "FrostWalletRegistry"]
