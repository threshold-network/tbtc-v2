import { BigNumber, BigNumberish, Contract, providers } from "ethers"
import MainnetBridgeDeployment from "../src/lib/ethereum/artifacts/mainnet/Bridge.json"

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
  const { depositRevealAheadPeriod } = await bridge.depositParameters()
  const actualDepositRevealAheadPeriod = BigNumber.from(
    depositRevealAheadPeriod
  )

  if (
    !actualDepositRevealAheadPeriod.eq(REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD)
  ) {
    throw new Error(
      "Refusing to publish the 180-day SDK locktime: mainnet Bridge " +
        `deposit reveal-ahead period is ${actualDepositRevealAheadPeriod.toString()} ` +
        `seconds; expected ${REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD.toString()} ` +
        "seconds to be finalized"
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

  const provider = new providers.StaticJsonRpcProvider(rpcUrl, 1)
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
