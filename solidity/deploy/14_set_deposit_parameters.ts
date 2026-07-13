import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import { BigNumber, utils } from "ethers"

export const DEPOSIT_REVEAL_AHEAD_PERIOD = BigNumber.from("12960000")

const bridgeGovernanceInterface = new utils.Interface([
  "function beginDepositRevealAheadPeriodUpdate(uint32 newDepositRevealAheadPeriod)",
  "function finalizeDepositRevealAheadPeriodUpdate()",
])

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
      description:
        "Begin the Bridge deposit reveal-ahead period update to 150 days",
    },
    finalize: {
      to: bridgeGovernance,
      value: "0",
      data: bridgeGovernanceInterface.encodeFunctionData(
        "finalizeDepositRevealAheadPeriodUpdate"
      ),
      executeAfterSeconds: governanceDelay.toString(),
      description:
        "Finalize the Bridge deposit reveal-ahead period update after the governance delay",
    },
  }
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, getOrNull, log, read } = deployments

  const depositTreasuryFeeDivisor = ethers.BigNumber.from("0")

  // We set the deposit reveal ahead period to 150 days. Paired with the SDK's
  // 180-day refund locktime, this leaves 30 days to fund and reveal a deposit.
  // 150 * 24 * 60 * 60 = 12960000 seconds
  // Fetch the current values of other deposit parameters to keep them unchanged.
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
  if (!deployer || bridgeGovernance.toLowerCase() !== deployer.toLowerCase()) {
    throw new Error(
      `Bridge is governed by unexpected address ${bridgeGovernance}`
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
