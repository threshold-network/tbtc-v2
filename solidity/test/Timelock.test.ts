import { helpers, waffle, upgrades } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import type { Bridge, TBTCVault, Timelock, ProxyAdmin } from "../typechain"

import bridgeFixture from "./fixtures/bridge"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Timelock", () => {
  let governance: SignerWithAddress
  let governanceSigner: SignerWithAddress

  let bridge: Bridge
  let tbtcVault: TBTCVault
  let timelock: Timelock
  let proxyAdmin: ProxyAdmin

  const zeroBytes32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  const timelockDelay = 86400 // 24h governance delay

  before(async () => {
    const { esdm } = await helpers.signers.getNamedSigners()
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, bridge, tbtcVault } = await waffle.loadFixture(
      bridgeFixture
    ))

    // One of the Threshold Council signers
    governanceSigner = await helpers.account.impersonateAccount(
      "0x2844a0d6442034D3027A05635F4224d966C54fD7",
      {
        from: governance,
        value: 10,
      }
    )

    timelock = (await helpers.contracts.getContract("Timelock")) as Timelock
    proxyAdmin = (await upgrades.admin.getInstance()) as ProxyAdmin

    await proxyAdmin.connect(esdm).transferOwnership(timelock.address)
  })

  context("when upgrading Bridge implementation via Timelock", async () => {
    let expectedNewImplementation: string

    before(async () => {
      await createSnapshot()

      // We need an existing contract. Otherwise, ProxyAdmin.upgrade will
      // revert. Obviously, in a real world, it does not make sense to upgrade
      // Bridge implementation address to point to the vault contract but we
      // just want to confirm switching the implementation address works.
      expectedNewImplementation = tbtcVault.address

      const upgradeTxData = await proxyAdmin.interface.encodeFunctionData(
        "upgrade",
        [bridge.address, expectedNewImplementation]
      )

      await timelock
        .connect(governance)
        .schedule(
          proxyAdmin.address,
          0,
          upgradeTxData,
          zeroBytes32,
          zeroBytes32,
          timelockDelay
        )
      await helpers.time.increaseTime(timelockDelay)
      await timelock
        .connect(governanceSigner)
        .execute(proxyAdmin.address, 0, upgradeTxData, zeroBytes32, zeroBytes32)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should switch the implementation address", async () => {
      const newImplementation = await upgrades.erc1967.getImplementationAddress(
        bridge.address
      )
      expect(newImplementation).to.equal(expectedNewImplementation)
    })
  })
})
