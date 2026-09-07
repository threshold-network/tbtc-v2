import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { BigNumber, Contract, Event, EventFilter, utils } from "ethers"

// We set the deposit reveal ahead period to 150 days. Paired with the SDK's
// 180-day refund locktime, this leaves 30 days to fund and reveal a deposit.
// 150 * 24 * 60 * 60 = 12960000 seconds
export const DEPOSIT_REVEAL_AHEAD_PERIOD = BigNumber.from("12960000")

const bridgeGovernanceInterface = new utils.Interface([
  "function beginDepositRevealAheadPeriodUpdate(uint32 newDepositRevealAheadPeriod)",
  "function finalizeDepositRevealAheadPeriodUpdate()",
])

// eth_getLogs block ranges are capped by most RPC providers (commonly
// 2,000-10,000 blocks per call); an unbounded fromBlock=0 scan would be
// rejected on mainnet. Chunk queries and bound the lookback to at most
// FALLBACK_LOOKBACK_BLOCKS, never earlier than the BridgeGovernance
// deployment block when known (the contract cannot have emitted events
// before it existed) - whichever bound is more recent wins, so an old
// deployment doesn't force a years-long, thousands-of-chunks scan.
const EVENT_QUERY_CHUNK_BLOCKS = 2000
const FALLBACK_LOOKBACK_BLOCKS = 200_000 // ~27 days at 12s/block

async function queryEventsInChunks(
  contract: Contract,
  filter: EventFilter,
  fromBlock: number,
  toBlock: number
): Promise<Event[]> {
  const events: Event[] = []
  for (
    let chunkStart = fromBlock;
    chunkStart <= toBlock;
    chunkStart += EVENT_QUERY_CHUNK_BLOCKS
  ) {
    const chunkEvents = await contract.queryFilter(
      filter,
      chunkStart,
      Math.min(chunkStart + EVENT_QUERY_CHUNK_BLOCKS - 1, toBlock)
    )
    events.push(...chunkEvents)
  }
  return events
}

interface GovernanceAction {
  to: string
  value: string
  data: string
  description: string
}

interface DepositRevealAheadPeriodGovernanceActions {
  begin: GovernanceAction
  finalize: GovernanceAction & { executeAfterSeconds: string }
}

export function buildDepositRevealAheadPeriodGovernanceActions(
  bridgeGovernance: string,
  governanceDelay: BigNumber
): DepositRevealAheadPeriodGovernanceActions {
  return {
    begin: {
      to: bridgeGovernance,
      value: "0",
      data: bridgeGovernanceInterface.encodeFunctionData(
        "beginDepositRevealAheadPeriodUpdate",
        [DEPOSIT_REVEAL_AHEAD_PERIOD]
      ),
      description: `Begin the Bridge deposit reveal-ahead period update to ${DEPOSIT_REVEAL_AHEAD_PERIOD.div(
        86400
      ).toString()} days`,
    },
    finalize: {
      to: bridgeGovernance,
      value: "0",
      data: bridgeGovernanceInterface.encodeFunctionData(
        "finalizeDepositRevealAheadPeriodUpdate"
      ),
      executeAfterSeconds: governanceDelay.toString(),
      description: `Finalize the Bridge deposit reveal-ahead period update after the governance delay (${governanceDelay.toString()} seconds after the begin transaction is mined; the delay is re-read on-chain at execution)`,
    },
  }
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, getOrNull, log, read } = deployments

  // HISTORICAL NOTE: This mainnet-only script already ran at deployment time
  // and set the deposit treasury fee divisor to 0 (fee disabled back then).
  // It has since been superseded by governance actions and will not re-run
  // on mainnet. Do not read the value below as the current configuration:
  // as of TIP-109, the mainnet deposit and redemption treasury fee divisors
  // are both 500 (20 bps). Always query Bridge.depositParameters() and
  // Bridge.redemptionParameters() on-chain for current values.
  const depositTreasuryFeeDivisor = ethers.BigNumber.from("0")

  // Fetch the current values of other deposit parameters to keep them unchanged,
  // and to compare the live reveal-ahead period against the governance target below.
  const depositParameters = await read("Bridge", "depositParameters")
  const bridgeGovernance = await read("Bridge", "governance")

  // This script runs before Bridge governance is transferred during a fresh
  // deployment. For an existing governed deployment, it acts as a release
  // preflight: accept an already-finalized target or emit the exact delayed
  // governance actions and stop until the Council executes them.
  const bridgeGovernanceDeployment = await getOrNull("BridgeGovernance")
  if (
    bridgeGovernanceDeployment &&
    bridgeGovernance.toLowerCase() ===
      bridgeGovernanceDeployment.address.toLowerCase()
  ) {
    const currentDepositRevealAheadPeriod = BigNumber.from(
      depositParameters.depositRevealAheadPeriod
    )

    if (currentDepositRevealAheadPeriod.eq(DEPOSIT_REVEAL_AHEAD_PERIOD)) {
      log(
        "deposit reveal-ahead period is already finalized at 150 days; " +
          "no governance transaction is required"
      )
      return
    }

    const governanceDelay = BigNumber.from(
      await read("BridgeGovernance", "governanceDelays", 0)
    )
    const bridgeGovernanceContract = await ethers.getContractAt(
      "BridgeGovernance",
      bridgeGovernanceDeployment.address
    )
    const latestBlock = await ethers.provider.getBlockNumber()
    // Externally-deployed artifacts lack a receipt; FALLBACK_LOOKBACK_BLOCKS is the operative safety net in that case.
    const fromBlock = Math.max(
      bridgeGovernanceDeployment.receipt?.blockNumber ?? 0,
      latestBlock - FALLBACK_LOOKBACK_BLOCKS,
      0
    )
    const filterStarted =
      bridgeGovernanceContract.filters.DepositRevealAheadPeriodUpdateStarted()
    const filterUpdated =
      bridgeGovernanceContract.filters.DepositRevealAheadPeriodUpdated()
    const logsStarted = await queryEventsInChunks(
      bridgeGovernanceContract,
      filterStarted,
      fromBlock,
      latestBlock
    )
    const logsUpdated = await queryEventsInChunks(
      bridgeGovernanceContract,
      filterUpdated,
      fromBlock,
      latestBlock
    )

    const lastStarted = logsStarted[logsStarted.length - 1]
    const lastUpdated = logsUpdated[logsUpdated.length - 1]

    if (
      lastStarted &&
      (!lastUpdated ||
        lastStarted.blockNumber > lastUpdated.blockNumber ||
        (lastStarted.blockNumber === lastUpdated.blockNumber &&
          (lastStarted.logIndex ?? 0) > (lastUpdated.logIndex ?? 0)))
    ) {
      const newPeriod = lastStarted.args[0]
      const timestamp = lastStarted.args[1]
      const eta = timestamp.add(governanceDelay)
      log(
        `Pending deposit reveal-ahead period update: new value ${newPeriod}, start timestamp ${timestamp}, ETA ${eta}`
      )
      const warning = !BigNumber.from(newPeriod).eq(DEPOSIT_REVEAL_AHEAD_PERIOD)
        ? ` (pending value ${newPeriod.toString()} does not match target ${DEPOSIT_REVEAL_AHEAD_PERIOD.toString()})`
        : ""
      throw new Error(
        `Deposit reveal-ahead period update is already pending${warning}`
      )
    }

    const governanceActions = buildDepositRevealAheadPeriodGovernanceActions(
      bridgeGovernanceDeployment.address,
      governanceDelay
    )

    log("Bridge governance rollout required before releasing the SDK:")
    log(JSON.stringify(governanceActions, null, 2))

    throw new Error(
      `Deposit reveal-ahead period is ${currentDepositRevealAheadPeriod.toString()} ` +
        `seconds; governance must finalize ${DEPOSIT_REVEAL_AHEAD_PERIOD.toString()} ` +
        "seconds before releasing the 180-day SDK locktime"
    )
  }

  const { deployer } = await getNamedAccounts()
  if (!deployer) {
    throw new Error("Named account 'deployer' is not configured")
  } else if (bridgeGovernance.toLowerCase() !== deployer.toLowerCase()) {
    throw new Error(
      `Bridge is governed by unexpected address ${bridgeGovernance}, expected deployer ${deployer}`
    )
  }

  log("setting initial deposit parameters")
  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateDepositParameters",
    depositParameters.depositDustThreshold,
    depositTreasuryFeeDivisor,
    depositParameters.depositTxMaxFee,
    DEPOSIT_REVEAL_AHEAD_PERIOD
  )
}

export default func

func.tags = ["SetDepositParameters"]
func.dependencies = ["Bridge"]

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
