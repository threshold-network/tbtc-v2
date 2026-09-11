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

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  type Abi,
  type Address,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { program } from "commander"
import * as fs from "fs"
import * as path from "path"

const CHALLENGE_STATE = 3

async function loadWalletRegistryAbi(): Promise<Abi> {
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
  let parsed: { abi: Abi }
  try {
    parsed = JSON.parse(
      await fs.promises.readFile(artifactPath, "utf8")
    ) as typeof parsed
  } catch (err) {
    throw new Error(
      `Failed to parse WalletRegistry artifact at ${artifactPath}: ${err}`
    )
  }
  return parsed.abi
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

/**
 * The EcdsaDkg.Result tuple as decoded by viem. Small uints arrive as
 * `number`, uint256 values as `bigint` - both re-encode losslessly when the
 * tuple is passed back to `approveDkgResult`.
 */
type DkgResultTuple = {
  submitterMemberIndex: bigint
  groupPubKey: `0x${string}`
  misbehavedMembersIndices: readonly number[]
  signatures: `0x${string}`
  signingMembersIndices: readonly bigint[]
  members: readonly number[]
  membersHash: `0x${string}`
}

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

  const abi = await loadWalletRegistryAbi()
  const registryAddress = opts.walletRegistry as Address

  const publicClient = createPublicClient({ transport: http(opts.rpcUrl) })
  const chainId = await publicClient.getChainId()
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  })
  const privateKey = process.env.PRIVATE_KEY!
  const account = privateKeyToAccount(
    (privateKey.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`) as `0x${string}`
  )
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(opts.rpcUrl),
  })

  let result!: DkgResultTuple
  let submittedBlock: number

  if (opts.txHash) {
    let receipt
    try {
      receipt = await publicClient.getTransactionReceipt({
        hash: opts.txHash as `0x${string}`,
      })
    } catch {
      throw new Error(`Receipt not found for tx ${opts.txHash}`)
    }
    submittedBlock = Number(receipt.blockNumber)
    let found = false
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== registryAddress.toLowerCase()) {
        continue
      }
      let decoded: { eventName: string; args: unknown }
      try {
        decoded = decodeEventLog({
          abi,
          data: log.data,
          topics: log.topics,
        }) as typeof decoded
      } catch {
        continue
      }
      if (decoded.eventName === "DkgResultSubmitted") {
        result = (decoded.args as { result: DkgResultTuple }).result
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
    const events = (await publicClient.getContractEvents({
      address: registryAddress,
      abi,
      eventName: "DkgResultSubmitted",
      args: { seed: BigInt(opts.seed!) },
      fromBlock: BigInt(parseInt(opts.fromBlock, 10)),
      toBlock: "latest",
    } as never)) as unknown as Array<{
      args?: { result?: DkgResultTuple }
      blockNumber: bigint
    }>
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
    if (!ev.args || !ev.args.result) {
      throw new Error("Event has no args")
    }
    result = ev.args.result
    submittedBlock = Number(ev.blockNumber)
  }

  const tuple: DkgResultTuple = {
    submitterMemberIndex: result.submitterMemberIndex,
    groupPubKey: result.groupPubKey,
    misbehavedMembersIndices: result.misbehavedMembersIndices,
    signatures: result.signatures,
    signingMembersIndices: result.signingMembersIndices,
    members: result.members,
    membersHash: result.membersHash,
  }

  const state = (await publicClient.readContract({
    address: registryAddress,
    abi,
    functionName: "getWalletCreationState",
  } as never)) as number | bigint
  const stateNum = Number(state)
  console.log("Wallet creation state (3 = CHALLENGE):", stateNum)
  if (stateNum !== CHALLENGE_STATE) {
    console.warn(
      "Expected CHALLENGE (3); approval may revert with wrong state."
    )
  }

  const params = (await publicClient.readContract({
    address: registryAddress,
    abi,
    functionName: "dkgParameters",
  } as never)) as {
    resultChallengePeriodLength: bigint
    submitterPrecedencePeriodLength: bigint
  }
  const resultChallengePeriodLength = BigInt(params.resultChallengePeriodLength)
  const submitterPrecedencePeriodLength = BigInt(
    params.submitterPrecedencePeriodLength
  )
  const challengePeriodEnd =
    BigInt(submittedBlock) + resultChallengePeriodLength
  const anyoneApproveAfter =
    challengePeriodEnd + submitterPrecedencePeriodLength
  const head = await publicClient.getBlockNumber()

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
  console.log("Current block:", head.toString())

  const ok = head > anyoneApproveAfter || opts.skipTimingCheck
  if (!ok) {
    const need = (anyoneApproveAfter - head).toString()
    throw new Error(
      `Precedence window not over yet (need block > ${anyoneApproveAfter.toString()}, current ${head.toString()}). Wait ~${need} more blocks or pass --skip-timing-check to send anyway.`
    )
  }

  if (opts.dryRun) {
    await publicClient.simulateContract({
      address: registryAddress,
      abi,
      functionName: "approveDkgResult",
      args: [tuple],
      account,
    } as never)
    console.log("dry-run: simulated approveDkgResult succeeded")
    return
  }

  const { request } = (await publicClient.simulateContract({
    address: registryAddress,
    abi,
    functionName: "approveDkgResult",
    args: [tuple],
    account,
  } as never)) as unknown as { request: never }
  const hash = await walletClient.writeContract(request)
  console.log("Sent:", hash)
  const mined = await publicClient.waitForTransactionReceipt({ hash })
  console.log(
    "Mined in block:",
    Number(mined.blockNumber),
    "status:",
    mined.status
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
