import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import { DEPOSIT_REFUND_LOCKTIME_DURATION_SECONDS } from "../../src/services/deposits/deposits-service"
import {
  checkMainnetDepositParameters,
  DepositParametersReader,
  REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD,
} from "../../scripts/check-mainnet-deposit-parameters"

chai.use(chaiAsPromised)

describe("Check mainnet deposit parameters", () => {
  function bridgeWithDepositRevealAheadPeriod(
    depositRevealAheadPeriod: number
  ): DepositParametersReader {
    return {
      depositParameters: async () => ({ depositRevealAheadPeriod }),
    }
  }

  it("accepts the finalized 150-day reveal-ahead period", async () => {
    await checkMainnetDepositParameters(
      bridgeWithDepositRevealAheadPeriod(
        REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD.toNumber()
      )
    )
  })

  it("blocks publication while mainnet still has the old value", async () => {
    await expect(
      checkMainnetDepositParameters(
        bridgeWithDepositRevealAheadPeriod(21945600)
      )
    ).to.be.rejectedWith(
      "Refusing to publish the 180-day SDK locktime: mainnet Bridge " +
        "deposit reveal-ahead period is 21945600 seconds; expected " +
        "12960000 seconds to be finalized"
    )
  })

  it("fails closed when the mainnet value cannot be read", async () => {
    const readError = new Error("RPC unavailable")
    const bridge: DepositParametersReader = {
      depositParameters: async () => {
        throw readError
      },
    }

    await expect(checkMainnetDepositParameters(bridge)).to.be.rejectedWith(
      "INFRA_ERROR: Failed to fetch deposit parameters from chain: " +
        readError.message
    )
  })
  it("maintains a 30-day depositor funding window between the SDK refund locktime and the governance-required reveal-ahead period", async () => {
    const thirtyDaysInSeconds = 30 * 24 * 60 * 60
    const expectedLocktime =
      REQUIRED_DEPOSIT_REVEAL_AHEAD_PERIOD.add(thirtyDaysInSeconds)
    expect(expectedLocktime.toString()).to.equal(
      DEPOSIT_REFUND_LOCKTIME_DURATION_SECONDS.toString()
    )
  })
})
