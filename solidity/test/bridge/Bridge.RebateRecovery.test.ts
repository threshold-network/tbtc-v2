import { ethers, helpers, upgrades } from "hardhat"
import { expect } from "chai"

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import type {
  BridgeGovernance,
  RebateStaking,
  Bridge,
  BridgeStub,
} from "../../typechain"

import bridgeFixture from "../fixtures/bridge"

const { ZeroAddress: AddressZero } = ethers

describe("Bridge - Rebate staking recovery upgrade", () => {
  let deployer: HardhatEthersSigner
  let governance: HardhatEthersSigner
  let esdm: HardhatEthersSigner

  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let rebateStaking: RebateStaking

  before(async () => {
    ;({ deployer, governance, esdm } = await helpers.signers.getNamedSigners())
    ;({ bridge, bridgeGovernance, rebateStaking } = await bridgeFixture())
  })

  it("repairs rebate staking during an upgrade", async () => {
    await bridgeGovernance
      .connect(governance)
      .setRebateStaking(rebateStaking.target)

    expect(await bridge.getRebateStaking()).to.equal(rebateStaking.target)

    const bridgeLibraries = {
      Deposit: (await helpers.contracts.getContract("Deposit")).target,
      DepositSweep: (await helpers.contracts.getContract("DepositSweep"))
        .target,
      Redemption: (await helpers.contracts.getContract("Redemption")).target,
      Wallets: (await helpers.contracts.getContract("Wallets")).target,
      Fraud: (await helpers.contracts.getContract("Fraud")).target,
      MovingFunds: (await helpers.contracts.getContract("MovingFunds")).target,
    }

    const bridgeFactory = await ethers.getContractFactory("BridgeStub", {
      signer: deployer,
      libraries: bridgeLibraries,
    })

    const newImplementation = await bridgeFactory.deploy()
    await newImplementation.waitForDeployment()

    const proxyAdmin = await ethers.getContractAt(
      "ProxyAdmin",
      await (await upgrades.admin.getInstance()).getAddress()
    )
    const proxyAdminWithUpgrade = await ethers.getContractAt(
      [
        "function upgradeAndCall(address proxy, address implementation, bytes data)",
      ],
      proxyAdmin.target,
      esdm
    )

    const upgradeData = bridgeFactory.interface.encodeFunctionData(
      "initializeV5_RepairRebateStaking",
      [AddressZero]
    )

    await expect(
      proxyAdminWithUpgrade.upgradeAndCall(
        bridge.target,
        newImplementation.target,
        upgradeData
      )
    )
      .to.emit(bridge, "RebateStakingRepaired")
      .withArgs(rebateStaking.target, AddressZero)

    expect(await bridge.getRebateStaking()).to.equal(AddressZero)
  })
})
