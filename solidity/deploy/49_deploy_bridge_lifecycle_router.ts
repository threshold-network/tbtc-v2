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

// Returns a signer for `address` only when that account is configured for the
// current network. Used to decide whether a governance-gated call can be sent by
// this deployment, or must instead be emitted as calldata for manual governance
// execution (the governance owner -- e.g. a Safe -- is not a deployer-controlled
// signer in production). Mirrors 51_deploy_frost_allowlist.
async function getConfiguredSigner(
  hre: HardhatRuntimeEnvironment,
  address: string
) {
  const configuredAccounts = (await hre.ethers.provider.listAccounts()).map(
    (account) => account.toLowerCase()
  )

  if (!configuredAccounts.includes(address.toLowerCase())) {
    return undefined
  }

  return hre.ethers.getSigner(address)
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments, ethers, helpers } = hre
  const { deployer } = await getNamedAccounts()

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

  // Wire the router onto the Bridge. The setter is one-time and governance-gated:
  // - dev/test: Bridge.governance() is the deployer, so call Bridge.setLifecycleRouter
  //   directly.
  // - production: Bridge.governance() is BridgeGovernance, whose setLifecycleRouter is
  //   onlyOwner. When that owner is the governance Safe (not a configured signer), the
  //   deployer cannot send the call -- it would revert with Ownable and abort the deploy
  //   -- so emit the calldata for manual governance execution and skip, instead.
  const currentBridgeGovernance = await bridgeContract.governance()
  const governanceIsDeployer =
    currentBridgeGovernance.toLowerCase() === deployer.toLowerCase()
  const alreadySetSelector = ethers.utils
    .id("LifecycleRouterAlreadySet()")
    .slice(0, 10)

  const routerSetterContract = governanceIsDeployer
    ? bridgeContract
    : bridgeGovernance
  const routerSetterCaller = governanceIsDeployer
    ? deployer
    : await bridgeGovernance.owner()
  const routerSetterSigner = await getConfiguredSigner(hre, routerSetterCaller)

  if (!routerSetterSigner) {
    const calldata = routerSetterContract.interface.encodeFunctionData(
      "setLifecycleRouter",
      [router.address]
    )
    const message =
      `BridgeLifecycleRouter wiring must be executed by ${routerSetterCaller}, ` +
      `which is not a configured signer for network ${hre.network.name}. ` +
      "Submit this call from governance:\n" +
      `  target: ${routerSetterContract.address}\n` +
      `  data:   ${calldata}`

    if (hre.network.name === "mainnet") {
      console.log(`${message}\nskipping for manual governance execution`)
    } else {
      throw new Error(message)
    }
  } else {
    let bridgeRouterConfirmed = false
    try {
      await routerSetterContract
        .connect(routerSetterSigner)
        .setLifecycleRouter(router.address)
      bridgeRouterConfirmed = true
      console.log(
        `wired BridgeLifecycleRouter at ${router.address} onto Bridge ${
          governanceIsDeployer
            ? "directly (governance is still deployer)"
            : "via BridgeGovernance"
        }`
      )
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
  }

  // Wire FrostWalletRegistry.lifecycleOwner onto the router. Also governance-gated:
  // updateLifecycleOwner is restricted to the registry governance. When that is not a
  // configured signer (production Safe), emit the calldata for manual governance
  // execution rather than aborting the deployment.
  const currentLifecycleOwner =
    await frostWalletRegistryContract.lifecycleOwner()
  if (currentLifecycleOwner.toLowerCase() === router.address.toLowerCase()) {
    console.log(
      `FrostWalletRegistry.lifecycleOwner already set to BridgeLifecycleRouter ${router.address}`
    )
  } else {
    const registryGovernance = await frostWalletRegistryContract.governance()
    const registrySigner = await getConfiguredSigner(hre, registryGovernance)

    if (!registrySigner) {
      const calldata = frostWalletRegistryContract.interface.encodeFunctionData(
        "updateLifecycleOwner",
        [router.address]
      )
      const message =
        "FrostWalletRegistry.lifecycleOwner update must be executed by registry " +
        `governance ${registryGovernance}, which is not a configured signer for ` +
        `network ${hre.network.name}. Submit this call from governance:\n` +
        `  target: ${frostWalletRegistryContract.address}\n` +
        `  data:   ${calldata}`

      if (hre.network.name === "mainnet") {
        console.log(`${message}\nskipping for manual governance execution`)
      } else {
        throw new Error(message)
      }
    } else {
      await frostWalletRegistryContract
        .connect(registrySigner)
        .updateLifecycleOwner(router.address)
      console.log(
        `wired FrostWalletRegistry.lifecycleOwner to BridgeLifecycleRouter ${router.address}`
      )

      const finalLifecycleOwner =
        await frostWalletRegistryContract.lifecycleOwner()
      if (finalLifecycleOwner.toLowerCase() !== router.address.toLowerCase()) {
        throw new Error(
          "FrostWalletRegistry.lifecycleOwner mismatch after deploy: " +
            `expected ${router.address}, got ${finalLifecycleOwner}`
        )
      }
    }
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
