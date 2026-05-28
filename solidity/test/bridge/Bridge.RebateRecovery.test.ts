import { ethers, helpers, upgrades, waffle } from "hardhat"
import { expect } from "chai"

import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  BridgeGovernance,
  RebateStaking,
  Bridge,
  BridgeStub,
} from "../../typechain"

import bridgeFixture from "../fixtures/bridge"

const { AddressZero } = ethers.constants

describe("Bridge - Rebate staking recovery upgrade", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let esdm: SignerWithAddress

  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let rebateStaking: RebateStaking

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, esdm } = await helpers.signers.getNamedSigners())
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ bridge, bridgeGovernance, rebateStaking } = await waffle.loadFixture(
      bridgeFixture
    ))
  })

  it("repairs rebate staking during an upgrade", async () => {
    await bridgeGovernance
      .connect(governance)
      .setRebateStaking(rebateStaking.address)

    expect(await bridge.getRebateStaking()).to.equal(rebateStaking.address)

    const bridgeLibraries = {
      Deposit: (await helpers.contracts.getContract("Deposit")).address,
      DepositSweep: (await helpers.contracts.getContract("DepositSweep"))
        .address,
      Redemption: (await helpers.contracts.getContract("Redemption")).address,
      Wallets: (await helpers.contracts.getContract("Wallets")).address,
      Fraud: (await helpers.contracts.getContract("Fraud")).address,
      MovingFunds: (await helpers.contracts.getContract("MovingFunds")).address,
    }

    const bridgeFactory = await ethers.getContractFactory("BridgeStub", {
      signer: deployer,
      libraries: bridgeLibraries,
    })

    const newImplementation = await bridgeFactory.deploy()
    await newImplementation.deployed()

    const proxyAdmin = await upgrades.admin.getInstance()
    const proxyAdminWithUpgrade = await ethers.getContractAt(
      [
        "function upgradeAndCall(address proxy, address implementation, bytes data)",
      ],
      proxyAdmin.address,
      esdm
    )

    const upgradeData = bridgeFactory.interface.encodeFunctionData(
      "initializeV5_RepairRebateStaking",
      [AddressZero]
    )

    await expect(
      proxyAdminWithUpgrade.upgradeAndCall(
        bridge.address,
        newImplementation.address,
        upgradeData
      )
    )
      .to.emit(bridge, "RebateStakingRepaired")
      .withArgs(rebateStaking.address, AddressZero)

    expect(await bridge.getRebateStaking()).to.equal(AddressZero)
  })
})
