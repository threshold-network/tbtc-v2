import { ethers, helpers, waffle } from "hardhat"
import { randomBytes } from "crypto"
import chai, { expect } from "chai"
import { smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import {
  IWormholeGateway,
  IWormholeRelayer,
  L2BTCDepositorWormhole,
  L2BTCRedeemerWormhole,
} from "../../../typechain"
import { initializeDepositFixture } from "./L1BTCDepositorWormhole.test"

chai.use(smock.matchers)

// Regression coverage for the audit fix that replaces
// `msg.sender.code.length == 0` with `tx.origin == msg.sender` in the
// unsigned-rebate entry points. The pre-fix guard returned true while a
// contract was still executing its constructor, so a throwaway contract
// deployed in the same transaction could mint a rebate on behalf of an
// address it controls. The `tx.origin` check rejects any nested call
// frame -- constructor or otherwise.
describe("L2 rebate EOA guard (regression)", () => {
  const contractsFixture = async () => {
    const { deployer, governance } = await helpers.signers.getNamedSigners()

    const wormholeRelayer = await smock.fake<IWormholeRelayer>(
      "IWormholeRelayer"
    )
    const l2WormholeGateway = await smock.fake<IWormholeGateway>(
      "IWormholeGateway"
    )
    const l1ChainId = 2

    const depositorDeployment = await helpers.upgrades.deployProxy(
      `L2BTCDepositorWormhole_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2BTCDepositorWormhole",
        initializerArgs: [
          wormholeRelayer.address,
          l2WormholeGateway.address,
          l1ChainId,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const l2BtcDepositor = depositorDeployment[0] as L2BTCDepositorWormhole

    // A minimal tBTC stand-in for the redeemer fixture. We do not invoke
    // the happy path in this test, only the guard, so a fake is enough.
    const tbtc = await (
      await ethers.getContractFactory("TestERC20")
    ).deploy()
    await tbtc.deployed()

    const redeemerDeployment = await helpers.upgrades.deployProxy(
      `L2BTCRedeemerWormhole_${randomBytes(8).toString("hex")}`,
      {
        contractName: "L2BTCRedeemerWormhole",
        initializerArgs: [
          tbtc.address,
          l2WormholeGateway.address,
          ethers.utils.hexZeroPad("0x0123", 32),
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    const l2BtcRedeemer = redeemerDeployment[0] as L2BTCRedeemerWormhole

    return {
      deployer,
      governance,
      l2BtcDepositor,
      l2BtcRedeemer,
    }
  }

  let deployer: SignerWithAddress
  let l2BtcDepositor: L2BTCDepositorWormhole
  let l2BtcRedeemer: L2BTCRedeemerWormhole

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, l2BtcDepositor, l2BtcRedeemer } = await waffle.loadFixture(
      contractsFixture
    ))
  })

  describe("L2BTCDepositorWormhole.initializeDepositWithRebate", () => {
    it("rejects contract callers that spoof an EOA during construction", async () => {
      const l2DepositOwner = deployer.address
      const maxRebateSat = 0
      const emptyAuth = "0x"
      const callData = l2BtcDepositor.interface.encodeFunctionData(
        "initializeDepositWithRebate",
        [
          initializeDepositFixture.fundingTx,
          initializeDepositFixture.reveal,
          l2DepositOwner,
          l2DepositOwner, // beneficiary matches, isolating the EOA guard
          maxRebateSat,
          emptyAuth,
        ]
      )

      const factory = await ethers.getContractFactory(
        "ConstructorRebateCaller"
      )
      // The helper performs the target call inside its constructor. Its own
      // code length is zero at call time, but tx.origin is the deployer's
      // EOA while msg.sender is the helper, so the guard must revert.
      await expect(factory.deploy(l2BtcDepositor.address, callData)).to.be
        .revertedWith("Signed auth required")
    })
  })

  describe("L2BTCRedeemerWormhole.requestRedemptionWithRebate", () => {
    it("rejects contract callers that spoof an EOA during construction", async () => {
      const amount = ethers.utils.parseUnits("1", 18)
      const outputScript =
        "0x1976a9140102030405060708090a0b0c0d0e0f101112131488ac"
      const emptyAuth = "0x"

      const callData = l2BtcRedeemer.interface.encodeFunctionData(
        "requestRedemptionWithRebate",
        [
          amount,
          30, // arbitrary recipient wormhole chain id
          outputScript,
          deployer.address, // rebateBeneficiary
          0, // maxRebateSat
          emptyAuth, // rebateAuthorization
          0, // nonce
        ]
      )

      const factory = await ethers.getContractFactory(
        "ConstructorRebateCaller"
      )
      await expect(factory.deploy(l2BtcRedeemer.address, callData)).to.be
        .revertedWith("Signed auth required")
    })
  })
})
