import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

// Returns a signer for `address` only when that account is configured for the
// current network. Used to decide whether a governance-gated call can be sent by
// this deployment, or must instead be emitted as calldata for manual governance
// execution (the governance owner -- e.g. a Safe -- is not a deployer-controlled
// signer in production). Mirrors 48_deploy_frost_wallet_registry.
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
  const { deployments, helpers, getNamedAccounts, ethers } = hre
  const { deploy } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  // EcdsaFraudRouter is a plain (non-upgradeable) contract that
  // pins the Bridge address at construction.
  const ecdsaFraudRouter = await deploy("EcdsaFraudRouter", {
    from: deployer,
    args: [Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  // Wire the router onto the Bridge via the one-time governance setter
  // `Bridge.setEcdsaFraudRouter`. Until this lands, `Bridge.ecdsaFraudRouter()`
  // stays `address(0)`, `slashWalletForFraud` (the router's only privileged
  // Bridge entry point, gated by `onlyEcdsaFraudRouter`) is unreachable, and
  // all ECDSA fraud slashing is dead -- the router is deployed-but-dead until
  // this call runs. The setter is one-time (reverts
  // `EcdsaFraudRouterAlreadySet()` once set), so this wiring is idempotent and
  // must skip cleanly on re-runs.
  //
  // This mirrors the `setFrostWalletRegistry` wiring in
  // 48_deploy_frost_wallet_registry: read the current Bridge value, send the
  // setter when the deployer/governance owner is a configured signer, else emit
  // the exact governance calldata for manual execution, and verify idempotently.
  const bridgeContract = await ethers.getContractAt("Bridge", Bridge.address)
  const bridgeGovernance = await ethers.getContractAt(
    "BridgeGovernance",
    (
      await deployments.get("BridgeGovernance")
    ).address
  )

  // Route the setter based on the current `Bridge.governance()`. On a fresh
  // deploy chain (test/local) `21_transfer_bridge_governance.ts` runs last
  // (`runAtTheEnd = true`), so this script executes while `Bridge.governance`
  // is still the `deployer` named account -- the only address that passes
  // `Bridge.onlyGovernance` in that window (routing through `BridgeGovernance`
  // there would revert with "Caller is not the governance"). Once governance
  // has been transferred, `Bridge.governance` is the `BridgeGovernance`
  // contract and the setter must be routed through its `onlyOwner` wrapper
  // (production deploys substitute the governance multisig signer there).
  const currentBridgeGovernance = await bridgeContract.governance()
  const governanceIsDeployer =
    currentBridgeGovernance.toLowerCase() === deployer.toLowerCase()
  const ALREADY_SET_SELECTOR = ethers.utils
    .id("EcdsaFraudRouterAlreadySet()")
    .slice(0, 10)

  // Idempotency pre-check via the public getter. `setEcdsaFraudRouter` is a
  // one-shot setter, so a re-run must skip cleanly on EVERY governance
  // configuration -- including a multisig owner that is not a configured
  // signer, where the wiring is emitted as calldata (not sent) and the
  // AlreadySet revert path is never reached.
  //
  // When preparing the atomic upgrade of an EXISTING Bridge, the proxy is
  // still on the pre-upgrade implementation, which has no `ecdsaFraudRouter()`
  // selector until the governance proposal executes -- so this read reverts
  // with a CALL_EXCEPTION (the eth_call returns no data to decode). A plain
  // getter cannot revert for any other reason, so tolerate ONLY that case:
  // treat the router as unwired and fall through to emit the setter calldata
  // the operator needs for the upgrade/wiring proposal, rather than aborting
  // before that branch is reached. Any other error (e.g. an RPC failure)
  // rethrows so it is not silently swallowed (cf. the blanket-catch regression
  // fixed in 48_deploy_frost_wallet_registry).
  let currentEcdsaFraudRouter: string
  let bridgeExposesGetter = true
  try {
    currentEcdsaFraudRouter = await bridgeContract.ecdsaFraudRouter()
  } catch (err) {
    if ((err as { code?: string }).code !== "CALL_EXCEPTION") {
      throw err
    }
    console.log(
      "Bridge.ecdsaFraudRouter() reverted (no such selector on the current " +
        "Bridge implementation -- pre-upgrade proxy); treating the router as " +
        "unwired and emitting wiring for the upgrade proposal"
    )
    currentEcdsaFraudRouter = ethers.constants.AddressZero
    bridgeExposesGetter = false
  }

  if (
    currentEcdsaFraudRouter.toLowerCase() ===
    ecdsaFraudRouter.address.toLowerCase()
  ) {
    console.log(
      `EcdsaFraudRouter already wired on this Bridge at ${ecdsaFraudRouter.address}; skipping`
    )
  } else if (currentEcdsaFraudRouter !== ethers.constants.AddressZero) {
    throw new Error(
      "Bridge is already wired to a different EcdsaFraudRouter " +
        `(${currentEcdsaFraudRouter}); refusing to wire ` +
        `${ecdsaFraudRouter.address}`
    )
  } else {
    // Resolve the authorized caller. In the governance-wrapper case the setter
    // is `BridgeGovernance.onlyOwner`, so the call must come from the wrapper
    // owner -- which post-handoff is the governance multisig, not `deployer`.
    // When that owner is not a configured signer, emit the calldata for manual
    // governance execution and skip (mainnet) rather than sending from
    // `deployer` and reverting.
    const setterContract = governanceIsDeployer
      ? bridgeContract
      : bridgeGovernance
    const setterCaller = governanceIsDeployer
      ? deployer
      : await bridgeGovernance.owner()
    // A pre-upgrade Bridge has no `setEcdsaFraudRouter` selector yet, so the
    // transaction cannot be sent regardless of who is a configured signer.
    // Force the calldata-emission path in that case (leave the signer
    // unresolved) rather than attempting -- and reverting -- the send.
    const setterSigner = bridgeExposesGetter
      ? await getConfiguredSigner(hre, setterCaller)
      : undefined

    if (!setterSigner) {
      const calldata = setterContract.interface.encodeFunctionData(
        "setEcdsaFraudRouter",
        [ecdsaFraudRouter.address]
      )
      const reason = !bridgeExposesGetter
        ? `the Bridge at ${Bridge.address} does not yet expose ` +
          "setEcdsaFraudRouter (pre-upgrade implementation); wire it as part " +
          "of the upgrade proposal"
        : `${setterCaller} is not a configured signer for network ${hre.network.name}`
      const message =
        `EcdsaFraudRouter wiring must be executed by governance -- ${reason}. ` +
        "Submit this call from governance:\n" +
        `  target: ${setterContract.address}\n` +
        `  data:   ${calldata}`

      // A pre-upgrade Bridge genuinely cannot be wired now on ANY network, so
      // emit the calldata and continue. Otherwise keep the existing guard:
      // skip on mainnet (a non-signer governance owner is expected there) and
      // error elsewhere so an unexpected non-signer is surfaced.
      if (!bridgeExposesGetter || hre.network.name === "mainnet") {
        console.log(`${message}\nskipping for manual governance execution`)
      } else {
        throw new Error(message)
      }
    } else {
      try {
        const tx = await setterContract
          .connect(setterSigner)
          .setEcdsaFraudRouter(ecdsaFraudRouter.address)
        await tx.wait(1)
        console.log(
          `wired EcdsaFraudRouter at ${ecdsaFraudRouter.address} onto Bridge ${
            governanceIsDeployer
              ? "directly (governance is still deployer)"
              : "via BridgeGovernance"
          }`
        )
      } catch (err) {
        // Tolerate only a concurrent deployment that wired the SAME router
        // between the pre-check read above and this call (AlreadySet revert).
        const errAny = err as {
          data?: string
          error?: { data?: string }
          message?: string
        }
        const revertData =
          errAny.data || errAny.error?.data || errAny.message || ""
        if (
          typeof revertData === "string" &&
          revertData.toLowerCase().includes(ALREADY_SET_SELECTOR.toLowerCase())
        ) {
          console.log("EcdsaFraudRouter already wired on this Bridge; skipping")
        } else {
          console.error(
            "setEcdsaFraudRouter call reverted with an unexpected error;",
            "deploy aborted so the operator can investigate:",
            errAny.message || err
          )
          throw err
        }
      }

      // Idempotent post-check: assert the on-chain value now reflects this
      // router. Only meaningful when the setter was actually sent; the
      // calldata-emit path skips before reaching here. Also catches a
      // concurrent deploy that wired a DIFFERENT router (AlreadySet caught
      // above) between the pre-check and this send.
      const wiredRouter = await bridgeContract.ecdsaFraudRouter()
      if (
        wiredRouter.toLowerCase() !== ecdsaFraudRouter.address.toLowerCase()
      ) {
        throw new Error(
          "Bridge.ecdsaFraudRouter mismatch after deploy: " +
            `expected ${ecdsaFraudRouter.address}, got ${wiredRouter}`
        )
      }
    }
  }

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(ecdsaFraudRouter)
  }

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "EcdsaFraudRouter",
      address: ecdsaFraudRouter.address,
    })
  }
}

export default func

func.tags = ["EcdsaFraudRouter"]
func.dependencies = ["Bridge", "BridgeGovernance"]
