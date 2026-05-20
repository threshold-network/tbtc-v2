/**
 * Call WalletRegistry.approveDkgResult after the submitter precedence window:
 * block.number > challengePeriodEnd + submitterPrecedencePeriodLength
 * where challengePeriodEnd = submittedResultBlock + resultChallengePeriodLength.
 *
 * Use when no operator in the submitted group will approve (e.g. your nodes
 * are not in the DKG participant set).
 *
 * Requires the exact EcdsaDkg.Result tuple from DkgResultSubmitted (or submit tx).
 *
 * Env vars:
 *   PRIVATE_KEY  - required; funded account private key (never pass as a flag)
 *   CHAIN_API_URL, WALLET_REGISTRY_ADDRESS - optional overrides for flags
 *
 * Example:
 *   PRIVATE_KEY=$KEY yarn approve-dkg-result --rpc-url $CHAIN_API_URL \
 *     --tx-hash 0x...   # or: --seed 0x...
 */

import { ethers } from "ethers"
import { program } from "commander"
import * as fs from "fs"
import * as path from "path"

const CHALLENGE_STATE = 3

async function loadWalletRegistryAbi(): Promise<ethers.utils.Interface> {
  const artifactPath = path.join(
    __dirname,
    "..",
    "src",
    "lib",
    "ethereum",
    "artifacts",
    "sepolia",
    "WalletRegistry.json"
  )
  let parsed: { abi: ethers.utils.Fragment[] }
  try {
    parsed = JSON.parse(
      await fs.promises.readFile(artifactPath, "utf8")
    ) as typeof parsed
  } catch (err) {
    throw new Error(
      `Failed to parse WalletRegistry artifact at ${artifactPath}: ${err}`
    )
  }
  return new ethers.utils.Interface(parsed.abi)
}

program
  .name("approve-dkg-result")
  .description(
    "Approve DKG result on WalletRegistry after submitter precedence (any caller)"
  )
  .requiredOption(
    "-r, --rpc-url <url>",
    "JSON-RPC URL (or CHAIN_API_URL)",
    process.env.CHAIN_API_URL
  )
  .option(
    "-w, --wallet-registry <address>",
    "WalletRegistry (or WALLET_REGISTRY_ADDRESS)",
    process.env.WALLET_REGISTRY_ADDRESS
  )
  .option(
    "--tx-hash <hash>",
    "submitDkgResult transaction hash — decode DkgResultSubmitted from receipt"
  )
  .option(
    "--seed <hex>",
    "DKG seed (indexed on DkgResultSubmitted) — query event on registry"
  )
  .option(
    "--from-block <n>",
    "Start block for --seed event search (ignored with --tx-hash)",
    "0"
  )
  .option(
    "--dry-run",
    "Validate state/timing and eth_call; do not broadcast",
    false
  )
  .option(
    "--skip-timing-check",
    "Do not abort if precedence window not reached yet",
    false
  )
  .parse(process.argv)

const opts = program.opts<{
  rpcUrl: string
  walletRegistry?: string
  txHash?: string
  seed?: string
  fromBlock: string
  dryRun: boolean
  skipTimingCheck: boolean
}>()

async function main(): Promise<void> {
  if (!opts.rpcUrl) {
    throw new Error("Missing --rpc-url or CHAIN_API_URL")
  }
  if (!process.env.PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY env var")
  }
  if (!opts.walletRegistry) {
    throw new Error(
      "Missing --wallet-registry or WALLET_REGISTRY_ADDRESS (Sepolia example: 0xE87E97aFb2B43212d1B80b588611dB8eF0F2fb71)"
    )
  }
  if (!opts.txHash && !opts.seed) {
    throw new Error("Provide either --tx-hash (submitDkgResult tx) or --seed")
  }
  if (opts.txHash && opts.seed) {
    console.warn("Both --tx-hash and --seed set; using --tx-hash.")
  }

  const iface = await loadWalletRegistryAbi()
  const provider = new ethers.providers.JsonRpcProvider(opts.rpcUrl)
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider)
  const registry = new ethers.Contract(opts.walletRegistry, iface, wallet)

  type DkgResultTuple = {
    submitterMemberIndex: ethers.BigNumber
    groupPubKey: string
    misbehavedMembersIndices: number[]
    signatures: string
    signingMembersIndices: ethers.BigNumber[]
    members: ethers.BigNumber[]
    membersHash: string
  }

  let result!: DkgResultTuple
  let submittedBlock: number

  if (opts.txHash) {
    const receipt = await provider.getTransactionReceipt(opts.txHash)
    if (!receipt) {
      throw new Error(`Receipt not found for tx ${opts.txHash}`)
    }
    submittedBlock = receipt.blockNumber
    let found = false
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== opts.walletRegistry.toLowerCase()) {
        continue
      }
      let parsed: ethers.utils.LogDescription
      try {
        parsed = iface.parseLog(log)
      } catch {
        continue
      }
      if (parsed.name === "DkgResultSubmitted") {
        result = parsed.args.result as DkgResultTuple
        found = true
        break
      }
    }
    if (!found) {
      throw new Error(
        "No DkgResultSubmitted from WalletRegistry in that receipt"
      )
    }
  } else {
    const seedBn = ethers.BigNumber.from(opts.seed)
    const filter = registry.filters.DkgResultSubmitted(null, seedBn)
    const events = await registry.queryFilter(
      filter,
      parseInt(opts.fromBlock, 10),
      "latest"
    )
    if (events.length === 0) {
      throw new Error(
        `No DkgResultSubmitted for seed ${opts.seed} from block ${opts.fromBlock}`
      )
    }
    if (events.length > 1) {
      console.warn(
        `Warning: ${events.length} matching events; using the latest.`
      )
    }
    const ev = events[events.length - 1]
    if (!ev.args) {
      throw new Error("Event has no args")
    }
    result = ev.args.result as DkgResultTuple
    submittedBlock = ev.blockNumber
  }

  const tuple = {
    submitterMemberIndex: result.submitterMemberIndex,
    groupPubKey: result.groupPubKey,
    misbehavedMembersIndices: result.misbehavedMembersIndices,
    signatures: result.signatures,
    signingMembersIndices: result.signingMembersIndices,
    members: result.members,
    membersHash: result.membersHash,
  }

  const state = await registry.getWalletCreationState()
  const stateNum =
    typeof state === "number" ? state : state.toNumber?.() ?? Number(state)
  console.log("Wallet creation state (3 = CHALLENGE):", stateNum)
  if (stateNum !== CHALLENGE_STATE) {
    console.warn(
      "Expected CHALLENGE (3); approval may revert with wrong state."
    )
  }

  const params = await registry.dkgParameters()
  const resultChallengePeriodLength = params.resultChallengePeriodLength
  const submitterPrecedencePeriodLength = params.submitterPrecedencePeriodLength
  const challengePeriodEnd = ethers.BigNumber.from(submittedBlock).add(
    resultChallengePeriodLength
  )
  const anyoneApproveAfter = challengePeriodEnd.add(
    submitterPrecedencePeriodLength
  )
  const head = await provider.getBlockNumber()

  console.log("Submitted result at block:", submittedBlock)
  console.log(
    "resultChallengePeriodLength:",
    resultChallengePeriodLength.toString()
  )
  console.log(
    "submitterPrecedencePeriodLength:",
    submitterPrecedencePeriodLength.toString()
  )
  console.log("challengePeriodEnd (block):", challengePeriodEnd.toString())
  console.log(
    "Anyone (non-submitter) may approve after block:",
    anyoneApproveAfter.toString()
  )
  console.log("Current block:", head)

  const ok =
    ethers.BigNumber.from(head).gt(anyoneApproveAfter) || opts.skipTimingCheck
  if (!ok) {
    const need = anyoneApproveAfter.sub(head).toNumber()
    throw new Error(
      `Precedence window not over yet (need block > ${anyoneApproveAfter.toString()}, current ${head}). Wait ~${need} more blocks or pass --skip-timing-check to send anyway.`
    )
  }

  if (opts.dryRun) {
    await registry.callStatic.approveDkgResult(tuple)
    console.log("dry-run: callStatic approveDkgResult succeeded")
    return
  }

  const tx = await registry.approveDkgResult(tuple)
  console.log("Sent:", tx.hash)
  const mined = await tx.wait()
  console.log("Mined in block:", mined.blockNumber, "status:", mined.status)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
