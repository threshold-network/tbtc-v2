import { ethers, deployments, helpers } from "hardhat"
import { expect } from "chai"

import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import type {
  BaseTBTC,
  BaseWormholeGateway,
  BaseWormholeGatewayUpgraded,
} from "../typechain"

const ZERO_ADDRESS = ethers.constants.AddressZero

describe("BaseWormholeGatewayUpgraded - Upgrade", async () => {
  let governance: SignerWithAddress
  let baseWormholeGateway: BaseWormholeGateway

  before(async () => {
    await deployments.fixture()
    ;({ governance } = await helpers.signers.getNamedSigners())

    baseWormholeGateway = (await helpers.contracts.getContract(
      "BaseWormholeGateway"
    )) as BaseWormholeGateway
  })

  describe("when a new contract is valid", () => {
    let baseWormholeGatewayUpgraded: BaseWormholeGatewayUpgraded
    let BaseTBTC: BaseTBTC

    before(async () => {
      BaseTBTC = (await helpers.contracts.getContract("BaseTBTC")) as BaseTBTC

      const [upgradedContract] = await helpers.upgrades.upgradeProxy(
        "BaseWormholeGateway",
        "contracts/test/BaseWormholeGatewayUpgraded.sol:BaseWormholeGatewayUpgraded",
        {
          proxyOpts: {
            call: {
              fn: "initializeV2",
              args: ["Hello darkness my old friend"],
            },
          },
          factoryOpts: {
            signer: governance,
          },
        }
      )
      baseWormholeGatewayUpgraded =
        upgradedContract as BaseWormholeGatewayUpgraded
    })

    it("new instance should have the same address as the old one", async () => {
      expect(baseWormholeGatewayUpgraded.address).equal(
        baseWormholeGateway.address
      )
    })

    it("should initialize new variable", async () => {
      expect(await baseWormholeGatewayUpgraded.newVar()).to.be.equal(
        "Hello darkness my old friend"
      )
    })

    it("should not update already set variable", async () => {
      expect(await baseWormholeGatewayUpgraded.tbtc()).to.be.equal(
        BaseTBTC.address
      )
    })

    it("should revert when V1's initializer is called", async () => {
      await expect(
        baseWormholeGatewayUpgraded.initialize(
          ZERO_ADDRESS,
          ZERO_ADDRESS,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith("Initializable: contract is already initialized")
    })
  })
})
