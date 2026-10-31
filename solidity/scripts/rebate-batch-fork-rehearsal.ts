import fs from "fs"
import path from "path"
import { ContractFactory, ethers as eth } from "ethers"
import type { TransactionReceipt } from "ethers"
import { artifacts, ethers, network } from "hardhat"
import {
  EIP_1967_IMPLEMENTATION_SLOT,
  KNOWN_COUNCIL_SAFE,
  KNOWN_PROXY_ADMIN,
  KNOWN_TIMELOCK,
} from "../deploy/85_deploy_tip109_governance_upgrade"
import {
  assertBridgeImplementationChanges,
  assertSelectorPresence,
  artifactLinkSites,
  buildRebateBatch,
  encodeExecuteBatch,
  encodeScheduleBatch,
  hashOperationBatch,
  postExecutionCheck,
  proveBridgeIdentity,
  rebateSelectorPlan,
  scanSelectors,
} from "../deploy/99_deploy_rebate_staking_reservation_implementation"

/**
 * rebate-batch-fork-rehearsal.ts
 *
 * Proves, on a mainnet fork, why the RebateStaking upgrade has to sit at
 * action `[0]` of the same Timelock batch as the Bridge upgrade.
 *
 * Case A, reversed order (what two separate `schedule` calls produce):
 *   upgrade the Bridge proxy alone, then run a callback redemption. The head
 *   `Redemption` library calls `RebateStaking.isRebateAuthorized`, the
 *   installed staking implementation has no such function and no fallback,
 *   so `requestRedemption` reverts with empty return data. Installs the new
 *   staking implementation afterwards and re-runs the same redemption to
 *   show it now succeeds.
 *
 * Case B, batch order (what this release commits to):
 *   one `scheduleBatch` with the staking upgrade first and the Bridge
 *   upgrade second, `getMinDelay()` advanced, one `executeBatch`, then the
 *   same redemption. Succeeds, and `postExecutionCheck` confirms both
 *   implementation slots moved and that `isRebateAuthorized` answers false
 *   instead of reverting.
 *
 * The wallet's main UTXO is seeded with a labelled storage write, and Bank
 * balance is minted through the Bank's own `onlyBridge` entry point from an
 * impersonated Bridge proxy. Both are labelled in the output so the run is
 * not mistaken for a real lifecycle run.
 *
 * Usage (heavy: run on the fuzz lab, nice -n 19):
 *   FORKING_URL=<archival-rpc> FORKING_BLOCK=<block> \
 *     npx hardhat run scripts/rebate-batch-fork-rehearsal.ts --network fork
 */

// Pinned fork block; override with FORKING_BLOCK and the script checks it.
const FORKING_BLOCK = Number(process.env.FORKING_BLOCK ?? "0")

// The 85 constants are lowercase for readability; ethers validates checksums,
// so normalise once here rather than at every use.
const COUNCIL_SAFE = eth.getAddress(KNOWN_COUNCIL_SAFE.toLowerCase())
const TIMELOCK = eth.getAddress(KNOWN_TIMELOCK.toLowerCase())
const PROXY_ADMIN = eth.getAddress(KNOWN_PROXY_ADMIN.toLowerCase())

const PROPOSER_ROLE = eth.id("PROPOSER_ROLE")
const EXECUTOR_ROLE = eth.id("EXECUTOR_ROLE")

const LIBS: { name: string; artifact: string }[] = [
  { name: "EcdsaLib", artifact: "contracts/bridge/EcdsaLib.sol:EcdsaLib" },
  { name: "Deposit", artifact: "contracts/bridge/Deposit.sol:Deposit" },
  {
    name: "DepositSweep",
    artifact: "contracts/bridge/DepositSweep.sol:DepositSweep",
  },
  { name: "Fraud", artifact: "contracts/bridge/Fraud.sol:Fraud" },
  {
    name: "MovingFunds",
    artifact: "contracts/bridge/MovingFunds.sol:MovingFunds",
  },
  {
    name: "Redemption",
    artifact: "contracts/bridge/Redemption.sol:Redemption",
  },
  { name: "Wallets", artifact: "contracts/bridge/Wallets.sol:Wallets" },
]

const BRIDGE_ARTIFACT = "contracts/bridge/Bridge.sol:Bridge"
const STAKING_ARTIFACT = "contracts/bridge/RebateStaking.sol:RebateStaking"

interface Step {
  name: string
  status: "PASS" | "FAIL" | "SKIP"
  txHash?: string
  gasUsed?: number
  values?: Record<string, unknown>
  error?: string
}

const steps: Step[] = []

/**
 * What a failed redemption attempt actually was.
 *
 * `bare` is the only kind that proves the hazard: the EVM reverted with no
 * return data, which is what the missing `isRebateAuthorized` selector
 * does, because `RebateStaking` has neither a fallback nor a receive
 * function.
 */
export type RevertKind =
  /** The EVM reverted and returned no data. */
  | "bare"
  /** The EVM reverted with an `Error(string)` or a panic. */
  | "reason"
  /** The EVM reverted with a custom error's return data. */
  | "custom-error"
  /** The EVM reverted with return data that is neither of the above. */
  | "data"
  /** The error is not an EVM revert at all. */
  | "not-a-revert"

/** The `Error(string)` selector, `keccak256("Error(string)")[:4]`. */
const ERROR_STRING_SELECTOR = "0x08c379a0"
/** The `Panic(uint256)` selector, `keccak256("Panic(uint256)")[:4]`. */
const PANIC_SELECTOR = "0x4e487b71"

/**
 * Classifies a failed redemption attempt.
 *
 * The negative control of this rehearsal is only worth anything if a
 * "reverted" verdict rests on an EVM revert. A timeout, a nonce error, a
 * funding error or an argument-encoding exception is not a revert, and
 * accepting one as a revert would let the rehearsal report the hazard as
 * demonstrated when nothing was demonstrated at all.
 *
 * The classification is by the error's own shape:
 *
 *  - An EVM revert is an ethers `CALL_EXCEPTION`, a Hardhat
 *    `SolidityError`, or a JSON-RPC error whose code is the standard
 *    "execution reverted" code. Anything else - a transport failure, a
 *    nonce error, an encoding error - is `not-a-revert`.
 *  - A revert with empty return data is `bare`. That is the shape the
 *    missing selector produces: `RebateStaking` has no fallback, so the
 *    call returns no data at all.
 *  - A revert with a reason string, a panic or a custom error carries
 *    return data, and is reported as such rather than as a bare revert.
 *
 * The Hardhat shapes are the ones this rehearsal actually sees: Hardhat
 * raises a `SolidityError` for an execution failure, and that error
 * carries no `code` at all, so a classifier that keyed on `code` alone
 * would call every real revert a non-revert.
 */
export function classifyRevert(error: unknown): {
  kind: RevertKind
  data?: string
} {
  // A string carries no shape: every error stringifies the same way, so a
  // message alone cannot prove that the EVM ran the transaction. The caller
  // passes the error object, not `String(error)`.
  if (typeof error !== "object" || error === null) {
    return { kind: "not-a-revert" }
  }
  const candidate = error as {
    code?: unknown
    data?: unknown
    message?: unknown
    stackTrace?: unknown
    constructor?: { name?: string }
  } | null
  const code = typeof candidate?.code === "string" ? candidate.code : undefined
  const message = String(candidate?.message ?? error)
  const data = typeof candidate?.data === "string" ? candidate.data : undefined

  // An EVM revert has to be recognised as one before its return data can
  // be read. The three shapes below are the only ones that mean "the EVM
  // ran the transaction and it failed".
  const isEthersCallException = code === "CALL_EXCEPTION"
  const isHardhatSolidityError =
    candidate?.constructor?.name === "SolidityError" ||
    candidate?.stackTrace !== undefined
  const isJsonRpcRevert =
    code === "-32000" || /execution reverted/i.test(message)
  if (!isEthersCallException && !isHardhatSolidityError && !isJsonRpcRevert) {
    return { kind: "not-a-revert" }
  }

  // Non-empty return data: the revert carried a payload, so it is not the
  // bare revert the missing selector produces.
  if (data !== undefined && data !== "0x") {
    if (
      data.startsWith(ERROR_STRING_SELECTOR) ||
      data.startsWith(PANIC_SELECTOR)
    ) {
      return { kind: "reason", data }
    }
    return { kind: "custom-error", data }
  }

  // Empty return data. The message says which kind of empty revert it is.
  if (/reverted without a reason/i.test(message)) {
    return { kind: "bare" }
  }
  if (/missing revert data/i.test(message)) {
    return { kind: "bare" }
  }
  if (/reverted with reason string/i.test(message)) {
    return { kind: "reason" }
  }
  if (/reverted with (an unrecognized )?custom error/i.test(message)) {
    return { kind: "custom-error" }
  }
  // A revert with empty return data whose message says nothing about it is
  // still a revert, and an empty payload is the shape the hazard has.
  return { kind: "bare" }
}

function record(step: Step): void {
  steps.push(step)
  const suffix =
    step.txHash === undefined ? "" : ` tx=${step.txHash.slice(0, 18)}...`
  const error = step.error === undefined ? "" : `\n          ${step.error}`
  console.log(`  [${step.status}] ${step.name}${suffix}${error}`)
}

function readMainnetAddress(file: string): string {
  const p = path.join(__dirname, "..", "deployments", "mainnet", `${file}.json`)
  const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"))
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("address" in parsed) ||
    typeof parsed.address !== "string"
  ) {
    throw new Error(`${file}.json has no address`)
  }
  return parsed.address
}

/**
 * Deploys a contract with its libraries linked in manually. Same shape as
 * the reservations fork scripts: neither hardhat-deploy nor this ethers
 * build can link at run time, so the solc `linkReferences` offsets are
 * patched into the creation code.
 */
async function deployLinked(
  artifactName: string,
  signer: eth.Signer,
  libAddresses: Record<string, string>
) {
  const artifact = await artifacts.readArtifact(artifactName)
  let content = artifact.bytecode.slice(2)
  for (const libs of Object.values(artifact.linkReferences)) {
    for (const [libName, refs] of Object.entries(libs)) {
      const address = libAddresses[libName]
      if (address === undefined) {
        throw new Error(`${artifactName}: no address for library ${libName}`)
      }
      const hex = address.toLowerCase().replace(/^0x/, "")
      for (const ref of refs) {
        const start = ref.start * 2
        content =
          content.slice(0, start) + hex + content.slice(start + ref.length * 2)
      }
    }
  }
  const factory = new ContractFactory(artifact.abi, `0x${content}`, signer)
  const contract = await factory.deploy()
  await contract.waitForDeployment()
  const pending = await contract.deploymentTransaction()
  if (pending === null)
    throw new Error(`${artifactName}: no deploy transaction`)
  const receipt = await pending.wait()
  if (receipt === null) throw new Error(`${artifactName}: deploy not mined`)
  return { contract, receipt }
}

/**
 * Locates the `registeredWallets` mapping slot in the live Bridge layout by
 * probing candidate struct offsets and comparing the entry's
 * `ecdsaWalletID` against the value the public `wallets()` getter returns.
 * The deployed record does not expand the `self` struct, so the offset is
 * discovered rather than assumed.
 */
async function findRegisteredWalletsSlot(
  bridge: string,
  pk: string,
  ecdsaWalletID: string
): Promise<number> {
  const coder = eth.AbiCoder.defaultAbiCoder()
  for (let slot = 51; slot <= 160; slot += 1) {
    const base = eth.keccak256(
      coder.encode(["bytes20", "uint256"], [pk, BigInt(slot)])
    )
    const word = await ethers.provider.getStorage(bridge, base)
    // `ecdsaWalletID` is the struct's first field, so it is the first word.
    if (word.toLowerCase() === ecdsaWalletID.toLowerCase()) {
      return slot
    }
  }
  throw new Error(
    "registeredWallets mapping slot not found in Bridge storage (51..160)"
  )
}

async function main(): Promise<void> {
  const block = await ethers.provider.getBlockNumber()
  if (FORKING_BLOCK === 0 || block !== FORKING_BLOCK) {
    throw new Error(
      `Fork block is ${block}, expected pinned ${FORKING_BLOCK}; set FORKING_BLOCK=${block}`
    )
  }
  console.log(`Fork block: ${block}`)

  const bridge = readMainnetAddress("Bridge")
  const rebateStaking = readMainnetAddress("RebateStaking")
  const bank = readMainnetAddress("Bank")
  const deployerAddress = (await ethers.getSigners())[0].address

  // Addresses that sign nothing but must hold ETH to be impersonated.
  const balanceOwner = eth.getAddress(
    "0x00000000000000000000000000000000000ba1a0"
  )
  const redeemer = eth.getAddress("0x00000000000000000000000000000000000feed5")
  const actors = [
    deployerAddress,
    TIMELOCK,
    COUNCIL_SAFE,
    balanceOwner,
    redeemer,
    bridge,
  ]

  console.log("\n=== Step 1: impersonate actors ===")
  for (const actor of actors) {
    await network.provider.send("hardhat_impersonateAccount", [actor])
    await network.provider.send("hardhat_setBalance", [
      actor,
      "0x8AC7230489E80000",
    ])
  }
  const deployer = await ethers.getSigner(deployerAddress)
  const timelock = await ethers.getSigner(TIMELOCK)
  const council = await ethers.getSigner(COUNCIL_SAFE)
  const ownerSigner = await ethers.getSigner(balanceOwner)
  const bridgeSigner = await ethers.getSigner(bridge)
  record({ name: "01-impersonate-actors", status: "PASS", values: { actors } })

  console.log(
    "\n=== Step 2: deploy the release builds on the fork (the rehearsal " +
      "stands in for the release pipeline, which owns the Bridge deployment) ==="
  )
  const libAddresses: Record<string, string> = {}
  for (const { name, artifact } of LIBS) {
    const { contract } = await deployLinked(artifact, deployer, {})
    libAddresses[name] = await contract.getAddress()
    console.log(`    ${name} -> ${libAddresses[name]}`)
  }
  const bridgeBuild = await deployLinked(
    BRIDGE_ARTIFACT,
    deployer,
    libAddresses
  )
  const newBridgeImpl = await bridgeBuild.contract.getAddress()
  const stakingBuild = await deployLinked(STAKING_ARTIFACT, deployer, {})
  const newStakingImpl = await stakingBuild.contract.getAddress()
  record({
    name: "02-deploy-release-builds",
    status: "PASS",
    values: { newBridgeImpl, newStakingImpl, libraries: libAddresses },
  })

  // The deployed Bridge build is now the input the deploy script would be
  // given, so the same rules apply to it: it must differ from the installed
  // one, and it must *be* the Bridge. The rehearsal checks both through the
  // same helpers the deploy script uses, so the rehearsal and the ceremony
  // agree on what "the release build" means.
  //
  // The identity proof names the Redemption library from the Bridge
  // artifact's link map, so the library is identified rather than guessed
  // at from a PUSH20 scan. The negative control below passes the
  // Redemption library itself as the Bridge implementation and requires
  // the proof to reject it.
  const currentBridgeImplWord = await ethers.provider.getStorage(
    bridge,
    EIP_1967_IMPLEMENTATION_SLOT
  )
  const currentBridgeImpl = eth.getAddress(
    `0x${currentBridgeImplWord.slice(26)}`
  )
  const bridgeArtifact = await artifacts.readArtifact(BRIDGE_ARTIFACT)
  const linkSites = artifactLinkSites(bridgeArtifact.deployedLinkReferences)
  try {
    assertBridgeImplementationChanges(currentBridgeImpl, newBridgeImpl)
    const bridgeCode = await ethers.provider.getCode(newBridgeImpl)
    const identity = proveBridgeIdentity({
      candidateAddress: newBridgeImpl,
      candidateRuntime: bridgeCode,
      artifactRuntime: bridgeArtifact.deployedBytecode,
      linkSites,
    })
    if (!identity.isBridge) {
      throw new Error(
        `the deployed Bridge build is not the Bridge implementation: ${identity.reason}`
      )
    }
    const redemptionLibrary = identity.libraries.Redemption
    if (redemptionLibrary === undefined) {
      throw new Error(
        "the deployed Bridge build does not link a Redemption library"
      )
    }
    const redemptionCode = await ethers.provider.getCode(redemptionLibrary)
    if (scanSelectors(redemptionCode)["0x96253dad"] !== true) {
      throw new Error(
        `the Redemption library ${redemptionLibrary} does not carry 0x96253dad`
      )
    }

    // Negative control: the Redemption library is a library, not the
    // Bridge implementation. It satisfies every other check the
    // pre-flight makes, so the identity proof has to reject it.
    const redemptionIdentity = proveBridgeIdentity({
      candidateAddress: redemptionLibrary,
      candidateRuntime: redemptionCode,
      artifactRuntime: bridgeArtifact.deployedBytecode,
      linkSites,
    })
    if (redemptionIdentity.isBridge) {
      throw new Error(
        `the Redemption library ${redemptionLibrary} was accepted as the Bridge implementation`
      )
    }

    record({
      name: "02b-bridge-build-matches-the-input-rules",
      status: "PASS",
      values: {
        currentBridgeImpl,
        newBridgeImpl,
        redemptionLibrary,
        libraries: identity.libraries,
        rejectionOfRedemptionLibrary: redemptionIdentity.reason,
      },
    })
  } catch (e) {
    record({
      name: "02b-bridge-build-matches-the-input-rules",
      status: "FAIL",
      error: String(e),
    })
    return writeArtifact(block, { bridge, rebateStaking })
  }

  console.log("\n=== Step 3: pre-flight selector scan ===")
  const plan = rebateSelectorPlan()
  const implWord = await ethers.provider.getStorage(
    rebateStaking,
    EIP_1967_IMPLEMENTATION_SLOT
  )
  const installedImpl = eth.getAddress(`0x${implWord.slice(26)}`)
  const installedCode = await ethers.provider.getCode(installedImpl)
  // The runtime code of a locally deployed build is only reachable through
  // the deployment transaction, so the scan uses the artifact the deploy
  // script writes. Read it from disk to check exactly what was installed.
  const stakingArtifact = await artifacts.readArtifact(STAKING_ARTIFACT)
  try {
    assertSelectorPresence(
      `installed RebateStaking ${installedImpl}`,
      installedCode,
      plan.installedStaking
    )
    assertSelectorPresence(
      "head RebateStaking build",
      stakingArtifact.deployedBytecode,
      plan.newStaking
    )
    assertSelectorPresence(
      "head Redemption library build",
      (
        await artifacts.readArtifact(
          "contracts/bridge/Redemption.sol:Redemption"
        )
      ).deployedBytecode,
      plan.newRedemption
    )
    const installedFound = scanSelectors(installedCode)
    record({
      name: "03-selector-scan",
      status: "PASS",
      values: { installedImpl, installedFound },
    })
  } catch (e) {
    record({ name: "03-selector-scan", status: "FAIL", error: String(e) })
    return writeArtifact(block, { bridge, rebateStaking })
  }

  console.log("\n=== Step 4: seed the redemption path ===")
  const bridgeContract = await ethers.getContractAt(BRIDGE_ARTIFACT, bridge)
  const pk = (await bridgeContract.activeWalletPubKeyHash()) as string
  // `wallets` is a generated getter over a struct, so the result is a
  // positional tuple. Field order matches Wallets.Wallet:
  // 0 ecdsaWalletID, 1 mainUtxoHash, 2 pendingRedemptionsValue,
  // 7 state.
  const bridgeWallets = await ethers.getContractAt(
    [
      "function wallets(bytes20) view returns (tuple(bytes32 ecdsaWalletID, bytes32 mainUtxoHash, uint64 pendingRedemptionsValue, uint32 createdAt, uint32 movingFundsRequestedAt, uint32 closingStartedAt, uint32 pendingMovedFundsSweepRequestsCount, uint8 state, bytes32 movingFundsTargetWalletsCommitmentHash))",
    ],
    bridge
  )
  const walletTuple = (await bridgeWallets.wallets(pk)) as unknown[]
  const ecdsaWalletID = String(walletTuple[0])
  const pendingRedemptionsValue = BigInt(walletTuple[2] as bigint)
  const walletState = Number(walletTuple[7])
  if (walletState !== 1) {
    throw new Error(`active wallet state is ${walletState}, expected Live (1)`)
  }
  const mappingSlot = await findRegisteredWalletsSlot(bridge, pk, ecdsaWalletID)
  const coder = eth.AbiCoder.defaultAbiCoder()
  const walletBase = eth.keccak256(
    coder.encode(["bytes20", "uint256"], [pk, BigInt(mappingSlot)])
  )
  const mainUtxoHashSlot = eth.toBeHex(BigInt(walletBase) + 1n, 32)

  // Positional tuple: dust threshold, treasury fee divisor, tx max fee, ...
  const redemptionParameters =
    (await bridgeContract.redemptionParameters()) as unknown[]
  const dustThreshold = BigInt(redemptionParameters[0] as bigint)
  // 1% treasury fee on this amount; non-zero, so the gate is reached.
  const amount = dustThreshold + BigInt(100_000)
  const txHash = eth.hexlify(eth.randomBytes(32))
  const txOutputIndex = 0
  const txOutputValue = pendingRedemptionsValue + amount + BigInt(1_000_000)
  const newMainUtxoHash = eth.keccak256(
    eth.solidityPacked(
      ["bytes32", "uint32", "uint64"],
      [txHash, txOutputIndex, txOutputValue]
    )
  )
  // SEEDED: the real main UTXO preimage is not recoverable from chain data,
  // so the wallet's main UTXO hash is pointed at a constructed UTXO. This
  // changes nothing about which code path the redemption takes; it only
  // satisfies the main-UTXO consistency check that precedes the rebate gate.
  await network.provider.send("hardhat_setStorageAt", [
    bridge,
    mainUtxoHashSlot,
    newMainUtxoHash,
  ])
  // SEEDED: Bank balance is minted through Bank.increaseBalance, which is
  // `onlyBridge`, from an impersonated Bridge proxy. No T-token supply is
  // fabricated and no storage is written directly.
  const bankContract = await ethers.getContractAt("Bank", bank)
  const mint = await bankContract
    .connect(bridgeSigner)
    .increaseBalance(balanceOwner, amount)
  await mint.wait()
  record({
    name: "04-seed-redemption-path",
    status: "PASS",
    values: {
      pk,
      mappingSlot,
      mainUtxoHashSlot,
      amount: amount.toString(),
      pendingRedemptionsValue: pendingRedemptionsValue.toString(),
      seededMainUtxoHash: newMainUtxoHash,
    },
  })

  let attempt = 0
  const runRedemption = async (
    label: string,
    expect: "success" | "revert"
  ): Promise<{
    ok: boolean
    bareRevert?: boolean
    error?: string
    txHash?: string
  }> => {
    attempt += 1
    // A fresh P2WPKH output script per attempt, so each attempt uses its own
    // redemption key and can never trip the "pending redemption" guard. The
    // leading byte is the script's own length (0x16 = 22), which is the
    // length-prefixed form `Redemption.requestRedemption` expects.
    const script = `0x160014${eth.hexlify(eth.randomBytes(20)).slice(2)}`
    const data = coder.encode(
      ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
      [redeemer, pk, txHash, txOutputIndex, txOutputValue, script]
    )
    const name = `redemption-${label}-${attempt}`
    try {
      const tx = await bankContract
        .connect(ownerSigner)
        .approveBalanceAndCall(bridge, amount, data)
      const receipt = await tx.wait()
      if (receipt === null) throw new Error("no receipt")
      record({
        name,
        status: expect === "success" ? "PASS" : "FAIL",
        txHash: receipt.hash,
        gasUsed: Number(receipt.gasUsed),
        error:
          expect === "success"
            ? undefined
            : "redemption SUCCEEDED where a revert was expected",
      })
      return { ok: true, txHash: receipt.hash }
    } catch (e) {
      const message = String(e)
      // The verdict has to rest on an EVM revert, not on any error at all.
      // A timeout, a nonce error, a funding error or an argument-encoding
      // exception is not a revert, and treating one as a revert would let
      // the negative control pass without the hazard ever being shown.
      const revert = classifyRevert(e)
      const bareRevert = revert.kind === "bare"
      const status =
        expect === "revert" ? (bareRevert ? "PASS" : "FAIL") : "FAIL"
      record({
        name,
        status,
        error:
          expect === "revert" && !bareRevert
            ? `expected the bare missing-selector revert, got ${revert.kind}: ${message}`
            : message,
      })
      return { ok: false, error: message, bareRevert }
    }
  }

  // =========================================================================
  // Case A: reversed order (Bridge upgraded alone, staking later)
  // =========================================================================
  console.log("\n=== Case A: reversed order ===")
  const snapshot = await network.provider.send("evm_snapshot", [])
  const proxyAdmin = await ethers.getContractAt(
    ["function upgrade(address proxy, address implementation)"],
    PROXY_ADMIN,
    timelock
  )
  const timelockContract = await ethers.getContractAt(
    [
      "function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256) returns (bytes32)",
      "function executeBatch(address[],uint256[],bytes[],bytes32,bytes32)",
      "function getMinDelay() view returns (uint256)",
      "function hasRole(bytes32,address) view returns (bool)",
    ],
    TIMELOCK
  )
  const delay = (await timelockContract.getMinDelay()) as bigint

  const bridgeUpgrade = await proxyAdmin.upgrade(bridge, newBridgeImpl)
  const bridgeUpgradeReceipt = await bridgeUpgrade.wait()
  record({
    name: "A1-bridge-upgrade-alone",
    status: "PASS",
    txHash: bridgeUpgradeReceipt?.hash,
    gasUsed: Number(bridgeUpgradeReceipt?.gasUsed ?? 0),
    values: { note: "what a separate first schedule would do" },
  })

  const reversed = await runRedemption("reversed", "revert")
  const reversedReverted = !reversed.ok
  if (!reversedReverted) {
    record({
      name: "A2-reversed-order-revert",
      status: "FAIL",
      error:
        "callback redemption SUCCEEDED with the old staking implementation; the hazard would be theoretical",
    })
  }

  const stakingUpgrade = await proxyAdmin.upgrade(rebateStaking, newStakingImpl)
  const stakingUpgradeReceipt = await stakingUpgrade.wait()
  record({
    name: "A3-staking-upgrade-after",
    status: "PASS",
    txHash: stakingUpgradeReceipt?.hash,
    gasUsed: Number(stakingUpgradeReceipt?.gasUsed ?? 0),
  })
  const afterReversed = await runRedemption("after-staking", "success")

  // Back to the pre-Case-A state: both proxies on their installed builds,
  // no pending redemption, wallet seed intact.
  await network.provider.send("evm_revert", [snapshot])

  // =========================================================================
  // Case B: one batch, staking upgrade first
  // =========================================================================
  console.log("\n=== Case B: single batch, staking first ===")
  const batch = buildRebateBatch({
    proxyAdmin: PROXY_ADMIN,
    rebateStakingProxy: rebateStaking,
    rebateStakingImplementation: newStakingImpl,
    bridgeProxy: bridge,
    bridgeImplementation: newBridgeImpl,
    salt: eth.id("rebase-rehearsal/salt"),
  })
  const operationId = hashOperationBatch(batch)

  // The proposer must hold PROPOSER_ROLE; the executor is whichever of the
  // open role, the Council Safe or the Timelock itself can execute.
  const proposerIsCouncil = (await timelockContract.hasRole(
    PROPOSER_ROLE,
    COUNCIL_SAFE
  )) as boolean
  if (!proposerIsCouncil) {
    record({
      name: "B0-role-probe",
      status: "FAIL",
      error: `Council Safe ${COUNCIL_SAFE} does not hold PROPOSER_ROLE`,
    })
    return writeArtifact(block, { bridge, rebateStaking })
  }
  let executorSigner = await ethers.getSigner(deployerAddress)
  let executorLabel = "open-executor-role"
  const executorOpen = (await timelockContract.hasRole(
    EXECUTOR_ROLE,
    "0x0000000000000000000000000000000000000000"
  )) as boolean
  if (!executorOpen) {
    const councilHasExecutor = (await timelockContract.hasRole(
      EXECUTOR_ROLE,
      COUNCIL_SAFE
    )) as boolean
    if (councilHasExecutor) {
      executorSigner = council
      executorLabel = "council-safe"
    } else {
      const timelockHasExecutor = (await timelockContract.hasRole(
        EXECUTOR_ROLE,
        TIMELOCK
      )) as boolean
      if (!timelockHasExecutor) {
        record({
          name: "B0-role-probe",
          status: "FAIL",
          error: "no actor holds EXECUTOR_ROLE and the role is not open",
        })
        return writeArtifact(block, { bridge, rebateStaking })
      }
      executorSigner = timelock
      executorLabel = "timelock-self"
    }
  }
  record({
    name: "B0-role-probe",
    status: "PASS",
    values: { executor: executorLabel, delay: delay.toString(), operationId },
  })

  const scheduleCalldata = encodeScheduleBatch(batch, delay)
  const scheduleTx = await council.sendTransaction({
    to: TIMELOCK,
    data: scheduleCalldata,
  })
  const scheduleReceipt = await scheduleTx.wait()
  record({
    name: "B1-scheduleBatch",
    status: "PASS",
    txHash: scheduleReceipt?.hash,
    gasUsed: Number(scheduleReceipt?.gasUsed ?? 0),
    values: { operationId },
  })

  // OZ TimelockController: executeBatch requires the full delay to elapse.
  await network.provider.send("evm_increaseTime", [Number(delay) + 1])
  await network.provider.send("evm_mine", [])

  const executeCalldata = encodeExecuteBatch(batch)
  const executeTx = await executorSigner.sendTransaction({
    to: TIMELOCK,
    data: executeCalldata,
  })
  const executeReceipt = await executeTx.wait()
  record({
    name: "B2-executeBatch",
    status: "PASS",
    txHash: executeReceipt?.hash,
    gasUsed: Number(executeReceipt?.gasUsed ?? 0),
    values: { actions: batch.actions.map((action) => action.description) },
  })

  const batched = await runRedemption("batch-order", "success")
  let postCheck: Record<string, string> | undefined
  try {
    postCheck = await postExecutionCheck({
      provider: ethers.provider,
      rebateStakingProxy: rebateStaking,
      rebateStakingImplementation: newStakingImpl,
      bridgeProxy: bridge,
      bridgeImplementation: newBridgeImpl,
    })
    record({
      name: "B3-post-execution-check",
      status: "PASS",
      values: postCheck,
    })
  } catch (e) {
    record({
      name: "B3-post-execution-check",
      status: "FAIL",
      error: String(e),
    })
  }

  console.log(`\n=== result ===`)
  console.log(`  reversed order redemption reverted: ${reversedReverted}`)
  console.log(`  reversed order retry after upgrade: ${afterReversed.ok}`)
  console.log(`  batch order redemption succeeded:   ${batched.ok}`)
  console.log(
    `  post-execution check:               ${postCheck !== undefined}`
  )

  // `writeArtifact` sets the exit status from the recorded steps, so the
  // run fails here exactly when a step failed, on this path and on every
  // early return alike.
  writeArtifact(
    block,
    { bridge, rebateStaking, newBridgeImpl, newStakingImpl, operationId },
    {
      reversedReverted,
      afterReversedOk: afterReversed.ok,
      batchOk: batched.ok,
      postCheck,
    }
  )
}

/**
 * Writes the artifact and sets the process exit status.
 *
 * Every exit from the rehearsal goes through here, including the early
 * returns a failed pre-flight makes. A rehearsal that never scheduled or
 * executed the batch must not exit 0: the exit status is the only thing a
 * caller outside this file can see, so a step that recorded `FAIL` and
 * returned has to fail the run.
 */
function writeArtifact(
  block: number,
  addresses: Record<string, string | undefined>,
  verdict?: Record<string, unknown>
): void {
  const dir = path.join(__dirname, "..", "dryrun-artifacts")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rebate-batch-fork-${block}.json`)
  const failed = steps.some((step) => step.status === "FAIL")
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        forkBlock: block,
        runAt: new Date().toISOString(),
        addresses,
        verdict,
        steps,
      },
      null,
      2
    )
  )
  console.log(`\nArtifact: ${file}`)
  if (failed) {
    console.log("\nFAIL: at least one step failed; see the artifact")
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
