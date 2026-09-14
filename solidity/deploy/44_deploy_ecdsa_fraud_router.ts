import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const CURRENT_PROTOCOL_ID =
  "0x35a446ffef8a2299061382519986bc72b6129928ebe5438078d31d0fb94960fc"

async function assertCurrentRouterHandshake(
  hre: HardhatRuntimeEnvironment,
  routerAddress: string,
  bridgeAddress: string,
  requireEmpty: boolean
) {
  const router = await hre.ethers.getContractAt(
    "EcdsaFraudRouter",
    routerAddress
  )
  const [
    boundBridge,
    protocolID,
    predecessor,
    predecessorCodeHash,
    ancestryDepth,
    openCount,
    unattributedCount,
    openEscrow,
    migratedChallengesActivatedAt,
  ] = await Promise.all([
    router.bridge(),
    router.fraudProtocolID(),
    router.predecessor(),
    router.predecessorCodeHash(),
    router.ancestryDepth(),
    router.openFraudChallengeCount(),
    router.unattributedOpenFraudChallengeCount(),
    router.openFraudChallengeEscrow(),
    router.migratedChallengesActivatedAt(),
  ])

  if (boundBridge.toLowerCase() !== bridgeAddress.toLowerCase()) {
    throw new Error(
      `EcdsaFraudRouter ${routerAddress} is bound to ${boundBridge}, ` +
        `not Bridge ${bridgeAddress}`
    )
  }
  if (protocolID.toLowerCase() !== CURRENT_PROTOCOL_ID) {
    throw new Error(
      `EcdsaFraudRouter ${routerAddress} exposes unsupported protocol ` +
        `${protocolID}; expected ${CURRENT_PROTOCOL_ID}`
    )
  }
  if (predecessor !== hre.ethers.constants.AddressZero) {
    throw new Error(
      `fresh EcdsaFraudRouter ${routerAddress} unexpectedly inherits ${predecessor}`
    )
  }
  if (
    predecessorCodeHash !== hre.ethers.constants.HashZero ||
    ancestryDepth !== 0
  ) {
    throw new Error(
      `fresh EcdsaFraudRouter ${routerAddress} exposes a non-empty ancestry pin`
    )
  }
  if (
    requireEmpty &&
    (!openCount.isZero() ||
      !unattributedCount.isZero() ||
      !openEscrow.isZero() ||
      !migratedChallengesActivatedAt.isZero())
  ) {
    throw new Error(
      `EcdsaFraudRouter ${routerAddress} is not fresh: ${openCount.toString()} open challenge(s), ${openEscrow.toString()} wei escrow, activation epoch ${migratedChallengesActivatedAt.toString()}`
    )
  }
}

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
  const bridgeContract = await ethers.getContractAt("Bridge", Bridge.address)
  const existingRouterDeployment = await deployments.getOrNull(
    "EcdsaFraudRouter"
  )

  // Never let hardhat-deploy replace the canonical stateful-router record
  // before the live Bridge pointer has been read. Changed bytecode under the
  // same deployment name would otherwise save a fresh inactive address and
  // only discover the mismatch afterwards.
  try {
    const liveRouter = await bridgeContract.ecdsaFraudRouter()
    if (liveRouter !== ethers.constants.AddressZero) {
      if (
        !existingRouterDeployment ||
        existingRouterDeployment.address.toLowerCase() !==
          liveRouter.toLowerCase()
      ) {
        throw new Error(
          `canonical EcdsaFraudRouter record does not preserve live router ${liveRouter}`
        )
      }
      const [approvedHash, runtimeCode] = await Promise.all([
        bridgeContract.ecdsaFraudRouterCodeHash(),
        ethers.provider.getCode(liveRouter),
      ])
      const runtimeHash = ethers.utils.keccak256(runtimeCode)
      if (
        approvedHash !== ethers.constants.HashZero &&
        approvedHash.toLowerCase() !== runtimeHash.toLowerCase()
      ) {
        throw new Error(
          `live EcdsaFraudRouter code hash mismatch: ${approvedHash} != ${runtimeHash}`
        )
      }
      console.log(
        `preserving canonical stateful EcdsaFraudRouter ${liveRouter}; ` +
          "prepare replacements through deployment 87 under its distinct alias"
      )
      return
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "CALL_EXCEPTION") throw err
    if (existingRouterDeployment) {
      throw new Error(
        "Bridge does not yet expose ecdsaFraudRouter(); refusing to overwrite " +
          `the existing canonical record ${existingRouterDeployment.address}`
      )
    }
  }

  // EcdsaFraudRouter is a plain (non-upgradeable) contract that
  // pins the Bridge address at construction.
  const ecdsaFraudRouter = await deploy("EcdsaFraudRouter", {
    from: deployer,
    args: [Bridge.address, ethers.constants.AddressZero],
    log: true,
    waitConfirmations: 1,
  })

  // Do not trust the deployment record alone. A router is eligible for fresh
  // wiring only if its immutable Bridge binding, protocol generation, and
  // state all match the on-chain handshake enforced by Bridge.
  await assertCurrentRouterHandshake(
    hre,
    ecdsaFraudRouter.address,
    Bridge.address,
    true
  )

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
  if (
    !governanceIsDeployer &&
    currentBridgeGovernance.toLowerCase() !==
      bridgeGovernance.address.toLowerCase()
  ) {
    throw new Error(
      "Refusing EcdsaFraudRouter wiring through stale BridgeGovernance " +
        `${bridgeGovernance.address}; live Bridge.governance() is ` +
        `${currentBridgeGovernance}. Complete and read back the delayed ` +
        "governance handoff before invoking a wrapper."
    )
  }
  const routerRuntimeCodeHash = ethers.utils.keccak256(
    await ethers.provider.getCode(ecdsaFraudRouter.address)
  )
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
  // Idempotency pre-check via the public getter. Defense in depth: do NOT
  // trust the ethers.js error code alone. A pre-upgrade Bridge returns no
  // data for `ecdsaFraudRouter()` and that surfaces as CALL_EXCEPTION, but
  // an unrelated RPC failure (SERVER_ERROR / TIMEOUT / connection reset)
  // can ALSO classify as CALL_EXCEPTION on some providers. Cross-check by:
  //   1. Confirming the Bridge address actually has deployed bytecode
  //      (`provider.getCode` returns non-empty hex). If it has no code, the
  //      CALL_EXCEPTION is from a bad address and we rethrow.
  //   2. Re-issuing the same query as a raw `eth_call` and inspecting the
  //      returned hex. Empty data => the selector is genuinely absent (the
  //      pre-upgrade case); non-empty data that fails decoding => some
  //      other revert, rethrow.
  //   3. Tolerating ONLY the empty-data case as "selector not found".
  let currentEcdsaFraudRouter: string
  let bridgeExposesGetter = true
  try {
    currentEcdsaFraudRouter = await bridgeContract.ecdsaFraudRouter()
  } catch (err) {
    const errAny = err as {
      code?: string
      data?: string
      error?: { data?: string }
      message?: string
    }
    if (errAny.code !== "CALL_EXCEPTION") {
      throw err
    }
    // (1) Bad address / no contract code at Bridge.address
    const bridgeCode = await ethers.provider.getCode(Bridge.address)
    if (bridgeCode === "0x") {
      throw new Error(
        `Bridge at ${Bridge.address} has no deployed bytecode; refusing to interpret the CALL_EXCEPTION as a missing selector`
      )
    }
    // (2) Raw eth_call to inspect the actual revert data length
    const rawSelector = bridgeContract.interface.getSighash("ecdsaFraudRouter")
    let rawResult: string
    try {
      rawResult = await ethers.provider.call({
        to: Bridge.address,
        data: rawSelector,
      })
    } catch (rawErr) {
      throw new Error(
        `Bridge.ecdsaFraudRouter() raw eth_call failed; treating as a real revert and aborting so the operator can investigate: ${(rawErr as Error).message}`
      )
    }
    // (3) Only empty data + deployed code => selector genuinely absent
    if (rawResult !== "0x" && rawResult !== "") {
      throw new Error(
        `Bridge.ecdsaFraudRouter() returned non-empty data [${rawResult}] but ethers.js decoded it as a CALL_EXCEPTION; refusing to treat this as a missing selector`
      )
    }
    currentEcdsaFraudRouter = ethers.constants.AddressZero
    bridgeExposesGetter = false
  }

  if (
    currentEcdsaFraudRouter.toLowerCase() ===
    ecdsaFraudRouter.address.toLowerCase()
  ) {
    await assertCurrentRouterHandshake(
      hre,
      currentEcdsaFraudRouter,
      Bridge.address,
      false
    )
    const approvedCodeHash = await bridgeContract.ecdsaFraudRouterCodeHash()
    if (
      approvedCodeHash.toLowerCase() !== routerRuntimeCodeHash.toLowerCase()
    ) {
      throw new Error(
        "Bridge EcdsaFraudRouter code hash mismatch: expected " +
          `${routerRuntimeCodeHash}, got ${approvedCodeHash}`
      )
    }
    console.log(
      `EcdsaFraudRouter already wired on this Bridge at ${ecdsaFraudRouter.address}; skipping`
    )
  } else if (currentEcdsaFraudRouter !== ethers.constants.AddressZero) {
    throw new Error(
      "Bridge is already wired to a different stateful EcdsaFraudRouter " +
        `(${currentEcdsaFraudRouter}). Do not overwrite it or migrate its ` +
        "state implicitly. Follow docs/rfc/frost-migration/" +
        "ecdsa-fraud-router-cutover-runbook.md and use " +
        "scripts/ecdsa-fraud-router-cutover.ts to drain and atomically " +
        `replace it with ${ecdsaFraudRouter.address}`
    )
  } else {
    if (!governanceIsDeployer) {
      throw new Error(
        "Refusing to wire EcdsaFraudRouter from deploy 44 on an existing " +
          "governed Bridge. Use the signed cutover manifest, distinct fresh " +
          "BridgeGovernance deployment, and delayed handoff runbook."
      )
    }
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
        [ecdsaFraudRouter.address, routerRuntimeCodeHash]
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
          .setEcdsaFraudRouter(ecdsaFraudRouter.address, routerRuntimeCodeHash)
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
      const approvedCodeHash = await bridgeContract.ecdsaFraudRouterCodeHash()
      if (
        approvedCodeHash.toLowerCase() !== routerRuntimeCodeHash.toLowerCase()
      ) {
        throw new Error(
          "Bridge EcdsaFraudRouter code hash mismatch after deploy: expected " +
            `${routerRuntimeCodeHash}, got ${approvedCodeHash}`
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
