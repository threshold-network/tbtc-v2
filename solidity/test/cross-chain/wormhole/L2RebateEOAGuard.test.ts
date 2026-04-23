import { ethers, waffle } from "hardhat"
import chai, { expect } from "chai"
import { smock } from "@defi-wonderland/smock"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import {
  IWormholeGateway,
  IWormholeRelayer,
  L2BTCDepositorWormhole,
  L2BTCRedeemerWormhole,
} from "../../../typechain"

// Minimal, compilation-only deposit fixture. The guard fires before any
// field is validated, so the exact bytes do not matter -- we just need
// the calldata shape to encode cleanly.
const fundingTxFixture = {
  version: "0x01000000",
  inputVector:
    "0x01dfe39760a5edabdab013114053d789ada21e356b59fea41d980396" +
    "c1a4474fad0100000023220020e57edf10136b0434e46bc08c5ac5a1e4" +
    "5f64f778a96f984d0051873c7a8240f2ffffffff",
  outputVector:
    "0x02804f1200000000002200202f601522e7bb1f7de5c56bdbd45590b3" +
    "499bad09190581dcaa17e152d8f0c2a9b7e837000000000017a9148688" +
    "4e6be1525dab5ae0b451bd2c72cee67dcf4187",
  locktime: "0x00000000",
}
const revealFixture = {
  fundingOutputIndex: 0,
  blindingFactor: "0xba863847d2d0fee3",
  walletPubKeyHash: "0xf997563fee8610ca28f99ac05bd8a29506800d4d",
  refundPubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
  refundLocktime: "0xde2b4c67",
  vault: "0xB5679dE944A79732A75CE556191DF11F489448d5",
}

chai.use(smock.matchers)

// Regression coverage for the audit fix that replaces
// `msg.sender.code.length == 0` with `tx.origin == msg.sender` in the
// unsigned-rebate entry points. The pre-fix guard returned true while a
// contract was still executing its constructor, so a throwaway contract
// deployed in the same transaction could mint a rebate on behalf of an
// address it controls. The `tx.origin` check rejects any nested call
// frame -- constructor or otherwise.
// Helper to deploy an upgradeable contract behind a minimal
// TransparentUpgradeableProxy without going through the OpenZeppelin
// hardhat-upgrades plugin. The plugin's upgrade-safety validation
// trips on these contracts in the environment used by this repo, but
// for the regression we only need a live instance at a proxy address
// -- no storage-layout checks are required.
async function deployBehindMinimalProxy(
  contractName: string,
  initializerName: string,
  initializerArgs: unknown[],
  deployer: SignerWithAddress,
  proxyAdmin: SignerWithAddress
) {
  const factory = await ethers.getContractFactory(contractName, deployer)
  const impl = await factory.deploy()
  await impl.deployed()

  const initData = impl.interface.encodeFunctionData(
    initializerName,
    initializerArgs
  )

  const ProxyFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
    deployer
  )
  const proxy = await ProxyFactory.deploy(
    impl.address,
    proxyAdmin.address,
    initData
  )
  await proxy.deployed()

  return factory.attach(proxy.address)
}

describe("L2 rebate EOA guard (regression)", () => {
  const contractsFixture = async () => {
    const signers = await ethers.getSigners()
    const deployer = signers[0]
    const proxyAdmin = signers[9]
    const governance = signers[1]

    const wormholeRelayer = await smock.fake<IWormholeRelayer>(
      "IWormholeRelayer"
    )
    const l2WormholeGateway = await smock.fake<IWormholeGateway>(
      "IWormholeGateway"
    )
    const l1ChainId = 2

    const tbtc = await (
      await ethers.getContractFactory("TestERC20", deployer)
    ).deploy()
    await tbtc.deployed()

    const l2BtcRedeemer = (await deployBehindMinimalProxy(
      "L2BTCRedeemerWormhole",
      "initialize",
      [
        tbtc.address,
        l2WormholeGateway.address,
        ethers.utils.hexZeroPad("0x0123", 32),
      ],
      deployer,
      proxyAdmin
    )) as L2BTCRedeemerWormhole

    const l2BtcDepositor = (await deployBehindMinimalProxy(
      "L2BTCDepositorWormhole",
      "initialize",
      [wormholeRelayer.address, l2WormholeGateway.address, l1ChainId],
      deployer,
      proxyAdmin
    )) as L2BTCDepositorWormhole

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
          fundingTxFixture,
          revealFixture,
          l2DepositOwner,
          l2DepositOwner, // beneficiary matches, isolating the EOA guard
          maxRebateSat,
          emptyAuth,
        ]
      )

      const factory = await ethers.getContractFactory("ConstructorRebateCaller")
      // The helper performs the target call inside its constructor. Its own
      // code length is zero at call time, but tx.origin is the deployer's
      // EOA while msg.sender is the helper, so the guard must revert.
      await expect(
        factory.deploy(l2BtcDepositor.address, callData)
      ).to.be.revertedWith("Signed auth required")
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

      const factory = await ethers.getContractFactory("ConstructorRebateCaller")
      await expect(
        factory.deploy(l2BtcRedeemer.address, callData)
      ).to.be.revertedWith("Signed auth required")
    })
  })
})
