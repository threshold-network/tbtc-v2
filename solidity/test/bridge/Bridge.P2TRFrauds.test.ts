/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers } from "hardhat"
import { expect } from "chai"
import type { P2TRSignatureFraudRouter } from "../../typechain"

const boundedV1ProtocolID = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/p2tr-signature-fraud/evidence/bounded-v1")
)

async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  const selector = ethers.utils.id(`${errorName}()`).slice(0, 10).toLowerCase()

  try {
    await promise
  } catch (error) {
    const failure = error as {
      data?: string
      error?: { data?: string }
      message?: string
    }
    const data = (failure.data ?? failure.error?.data ?? "").toLowerCase()
    const message = failure.message ?? String(error)
    if (data.startsWith(selector) || message.includes(errorName)) return
    throw error
  }

  expect.fail(`expected ${errorName}`)
}

describe("P2TRSignatureFraudRouter BOUNDED_V1 retirement", () => {
  it("keeps every lifecycle and migration entrypoint fail-closed", async () => {
    const [bridge, caller] = await ethers.getSigners()
    const factory = await ethers.getContractFactory("P2TRSignatureFraudRouter")
    const router = (await factory.deploy(
      bridge.address
    )) as P2TRSignatureFraudRouter
    await router.deployed()

    expect(await router.evidenceProtocolID()).to.equal(boundedV1ProtocolID)

    for (const action of [0, 1, 2]) {
      await expectCustomError(
        router
          .connect(caller)
          .processP2TRSignatureFraudChallenge(action, "0x", []),
        "P2TRFraudEvidenceUnavailable"
      )
    }

    await expectCustomError(
      router.connect(caller).acceptMigration([], []),
      "P2TRFraudEvidenceUnavailable"
    )
  })
})
