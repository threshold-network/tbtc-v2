import { BigNumber, BigNumberish, Contract, providers } from "ethers"
import MainnetBridgeDeployment from "../src/lib/ethereum/artifacts/mainnet/Bridge.json"

// Must be kept in sync manually with DEPOSIT_REVEAL_AHEAD_PERIOD in solidity/deploy/14_set_deposit_parameters.ts.
export const REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD = BigNumber.from("12960000")

interface DepositParameters {
  depositRevealAheadPeriod: BigNumberish
}

export interface DepositParametersReader {
  depositParameters(): Promise<DepositParameters>
}

export async function checkMainnetDepositParameters(
  bridge: DepositParametersReader
): Promise<void> {
  let depositRevealAheadPeriod
  try {
    ;({ depositRevealAheadPeriod } = await bridge.depositParameters())
  } catch (error) {
    throw new Error(
      "INFRA_ERROR: Failed to fetch deposit parameters from chain: " +
        `${error instanceof Error ? error.message : String(error)}`
    )
  }

  const actualDepositRevealAheadPeriod = BigNumber.from(
    depositRevealAheadPeriod
  )

  if (actualDepositRevealAheadPeriod.gt(REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD)) {
    throw new Error(
      "GOVERNANCE_MISMATCH: Refusing to publish the 180-day SDK locktime: mainnet Bridge " +
        `deposit reveal-ahead period is ${actualDepositRevealAheadPeriod.toString()} ` +
        `seconds; exceeds required maximum of ${REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD.toString()} ` +
        "seconds"
    )
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.CHAIN_API_URL
  if (!rpcUrl) {
    throw new Error(
      "CHAIN_API_URL is required to verify mainnet deposit parameters"
    )
  }

  const provider = new providers.JsonRpcProvider(rpcUrl)
  const network = await provider.getNetwork()
  if (network.chainId !== 1) {
    throw new Error(
      `Unexpected network chain ID ${network.chainId}; expected 1 (Ethereum mainnet)`
    )
  }
  const bridge = new Contract(
    MainnetBridgeDeployment.address,
    MainnetBridgeDeployment.abi,
    provider
  ) as Contract & DepositParametersReader
  await checkMainnetDepositParameters(bridge)
  console.log(
    "Mainnet Bridge deposit reveal-ahead period is finalized at " +
      `${REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD.toString()} seconds`
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
