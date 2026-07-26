import { viem } from "hardhat"
import { expect } from "chai"
import { getAddress } from "viem"

import type { ITBTCVault } from "../../typechain"
import { createMock } from "./mock"
import type { Mock } from "./mock"

/**
 * Evidence for the viem evaluation in `docs/hardhat-3-migration.md`.
 *
 * `test/helpers/mock.ts` is written against ethers v5 throughout, which reads
 * like a blocker for moving the suite to viem. It is not one: the mock's
 * configuration and its recording both live in contract storage, reached over
 * ordinary RPC, so what the helper hands back is a control surface rather than
 * a binding. A viem test can drive a mock the ethers helper configured, and a
 * call sent by viem is recorded the same as any other.
 *
 * This asserts that in both directions, so the claim is not taken on faith.
 */
describe("MockContract / viem interoperability", () => {
  let vault: Mock<ITBTCVault>

  before(async () => {
    vault = await createMock<ITBTCVault>("ITBTCVault")
  })

  it("answers a viem read with what the ethers helper configured", async () => {
    await vault.optimisticMintingFeeDivisor.returns(500)

    const asViem = await viem.getContractAt(
      "ITBTCVault",
      getAddress(vault.address)
    )

    expect(await asViem.read.optimisticMintingFeeDivisor()).to.equal(500)
  })

  it("records a write sent by viem", async () => {
    await vault.unmint.reset()

    const asViem = await viem.getContractAt(
      "ITBTCVault",
      getAddress(vault.address)
    )

    await asViem.write.unmint([BigInt(123)])

    expect(await vault.unmint.callCount()).to.equal(1)

    // The recorded argument is decoded by the ethers-side helper, so it comes
    // back as an ethers `BigNumber` even though viem sent the call. Compared
    // as a string to keep the assertion independent of which chai matchers
    // happen to be installed.
    const call = await vault.unmint.getCall(0)
    expect(String(call.args[0])).to.equal("123")
  })
})
