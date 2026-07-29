import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import type { Contract } from "ethers"

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

// The Bridge exposes no getter for the current lifecycle router (omitted for
// EIP-170); it is only recoverable from the one-shot LifecycleRouterSet event.
// Read it newest-first in bounded block ranges so the lookup works on RPC providers
// that enforce eth_getLogs block-range limits -- an unbounded
// `queryFilter(0, "latest")` aborts there, breaking the idempotent / manual-governance
// re-run path.
//
// The lower bound is genesis (0): the only stable choice. `Bridge.receipt.blockNumber`
// is the proxy's LATEST UPGRADE block (hardhat-deploy overwrites the deployment receipt
// on every upgrade) and can be AFTER the LifecycleRouterSet event, silently missing it.
// The setter reverts once set, so at most one such event exists; the newest-first scan
// early-exits on the first (newest) match, so re-runs shortly after wiring settle fast.
const LIFECYCLE_ROUTER_LOG_QUERY_BLOCK_RANGE = 10000

async function readCurrentLifecycleRouter(
  bridgeContract: Contract
): Promise<string | undefined> {
  const filter = bridgeContract.filters.LifecycleRouterSet()
  const latestBlock = await bridgeContract.provider.getBlockNumber()
  for (
    let toBlock = latestBlock;
    toBlock >= 0;
    toBlock -= LIFECYCLE_ROUTER_LOG_QUERY_BLOCK_RANGE
  ) {
    const fromBlock = Math.max(
      toBlock - LIFECYCLE_ROUTER_LOG_QUERY_BLOCK_RANGE + 1,
      0
    )
    // eslint-disable-next-line no-await-in-loop
    const events = await bridgeContract.queryFilter(filter, fromBlock, toBlock)
    if (events.length > 0) {
      return events[events.length - 1].args?.lifecycleRouter as
        | string
        | undefined
    }
  }

  return undefined
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

  // Wire the router onto the Bridge. The setter is one-time and governance-gated,
  // and the Bridge exposes no getter for the current value -- it is only recoverable
  // from the one-shot LifecycleRouterSet event. Read it first so re-runs are
  // idempotent regardless of who governance is (the production Safe is not a deployer
  // signer, so we must not depend on being able to send the setter to learn it is
  // already set).
  const currentLifecycleRouter = await readCurrentLifecycleRouter(
    bridgeContract
  )

  if (
    currentLifecycleRouter &&
    currentLifecycleRouter.toLowerCase() === router.address.toLowerCase()
  ) {
    console.log(
      `BridgeLifecycleRouter already wired on this Bridge at ${router.address}; skipping Bridge setter`
    )
  } else if (currentLifecycleRouter) {
    throw new Error(
      "Bridge lifecycle router is already set, but the LifecycleRouterSet event " +
        `does not match this deployment (${router.address}). Refusing to guess ` +
        "the one-time Bridge router value."
    )
  } else {
    // Not yet wired. Resolve the authorized caller:
    // - dev/test: Bridge.governance() is the deployer, so call Bridge.setLifecycleRouter
    //   directly.
    // - production: Bridge.governance() is BridgeGovernance, whose setLifecycleRouter is
    //   onlyOwner. When that owner is the governance Safe (not a configured signer), the
    //   deployer cannot send the call -- it would revert with Ownable -- so emit the
    //   calldata for manual governance execution and skip, instead.
    const currentBridgeGovernance = await bridgeContract.governance()
    const governanceIsDeployer =
      currentBridgeGovernance.toLowerCase() === deployer.toLowerCase()
    const alreadySetSelector = ethers.utils
      .id("LifecycleRouterAlreadySet()")
      .slice(0, 10)

    // A pre-upgrade Bridge proxy does not expose `setLifecycleRouter` yet, so
    // the send would revert regardless of who is a configured signer (unlike
    // the fraud-router / registry scripts, this one has no getter for its own
    // value, so probe a view added in the same FROST upgrade instead). If
    // `frostLifecycleContext` reverts with a CALL_EXCEPTION the Bridge is
    // pre-upgrade, so force the calldata-emission path rather than attempting --
    // and reverting -- the send, so testnet upgrade preparation is not blocked.
    let bridgeExposesLifecycleWiring = true
    try {
      await bridgeContract.frostLifecycleContext(ethers.constants.AddressZero)
    } catch (err) {
      if ((err as { code?: string }).code !== "CALL_EXCEPTION") {
        throw err
      }
      bridgeExposesLifecycleWiring = false
    }

    const routerSetterContract = governanceIsDeployer
      ? bridgeContract
      : bridgeGovernance
    const routerSetterCaller = governanceIsDeployer
      ? deployer
      : await bridgeGovernance.owner()
    const routerSetterSigner = bridgeExposesLifecycleWiring
      ? await getConfiguredSigner(hre, routerSetterCaller)
      : undefined

    if (!routerSetterSigner) {
      const calldata = routerSetterContract.interface.encodeFunctionData(
        "setLifecycleRouter",
        [router.address]
      )
      const reason = !bridgeExposesLifecycleWiring
        ? `the Bridge at ${bridgeContract.address} does not yet expose ` +
          "setLifecycleRouter (pre-upgrade implementation); wire it as part of " +
          "the upgrade proposal"
        : `${routerSetterCaller} is not a configured signer for network ${hre.network.name}`
      const message =
        `BridgeLifecycleRouter wiring must be executed by governance -- ${reason}. ` +
        "Submit this call from governance:\n" +
        `  target: ${routerSetterContract.address}\n` +
        `  data:   ${calldata}`

      // A pre-upgrade Bridge cannot be wired now on any network, so emit the
      // calldata and continue. Otherwise keep the existing guard: skip on
      // mainnet (a non-signer governance owner is expected) and error elsewhere.
      if (!bridgeExposesLifecycleWiring || hre.network.name === "mainnet") {
        console.log(`${message}\nskipping for manual governance execution`)
      } else {
        throw new Error(message)
      }
    } else {
      try {
        const tx = await routerSetterContract
          .connect(routerSetterSigner)
          .setLifecycleRouter(router.address)
        await tx.wait(1)
        console.log(
          `wired BridgeLifecycleRouter at ${router.address} onto Bridge ${
            governanceIsDeployer
              ? "directly (governance is still deployer)"
              : "via BridgeGovernance"
          }`
        )
      } catch (err) {
        // Tolerate only a concurrent deployment that wired the SAME router between
        // the event read above and this call (AlreadySet revert + matching event).
        if (!revertDataContains(err, alreadySetSelector)) {
          const errAny = err as { message?: string }
          console.error(
            "setLifecycleRouter call reverted with an unexpected error;",
            "deploy aborted so the operator can investigate:",
            errAny.message || err
          )
          throw err
        }

        const racedRouter = await readCurrentLifecycleRouter(bridgeContract)
        if (
          !racedRouter ||
          racedRouter.toLowerCase() !== router.address.toLowerCase()
        ) {
          throw new Error(
            "Bridge lifecycle router is already set, but the LifecycleRouterSet event " +
              `does not match this deployment (${router.address}). Refusing to guess ` +
              "the one-time Bridge router value."
          )
        }
        console.log(
          `BridgeLifecycleRouter already wired on this Bridge at ${router.address}; skipping Bridge setter`
        )
      }
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
      const updateTx = await frostWalletRegistryContract
        .connect(registrySigner)
        .updateLifecycleOwner(router.address)
      await updateTx.wait(1)
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
