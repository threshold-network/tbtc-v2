import { deployments, helpers } from "hardhat"
import { expect } from "chai"

import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

import type { HyperEVMTBTC,HyperEVMTBTCUpgraded } from "../typechain"

describe("HyperEVMTBTC - Upgrade", async () => {
  let governance: SignerWithAddress
  let hyperEvmTbtc: HyperEVMTBTC

  before(async () => {
    await deployments.fixture()
    ;({ governance } = await helpers.signers.getNamedSigners())

    hyperEvmTbtc = (await helpers.contracts.getContract(
      "HyperEVMTBTC"
    )) as HyperEVMTBTC
  })

  describe("when a new contract is valid", () => {
    let hyperEvmTbtcUpgraded: HyperEVMTBTCUpgraded

    before(async () => {
      const [upgradedContract] = await helpers.upgrades.upgradeProxy(
        "HyperEVMTBTC",
        "HyperEVMTBTCUpgraded",
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
      hyperEvmTbtcUpgraded = upgradedContract as HyperEVMTBTCUpgraded
    })

    it("new instance should have the same address as the old one", async () => {
      expect(hyperEvmTbtcUpgraded.address).equal(hyperEvmTbtc.address)
    })

    it("should initialize new variable", async () => {
      expect(await hyperEvmTbtcUpgraded.newVar()).to.be.equal(
        "Hello darkness my old friend"
      )
    })

    it("should not update already set name", async () => {
      expect(await hyperEvmTbtcUpgraded.name()).to.be.equal("HyperEVM tBTC v2")
    })

    it("should not update already set symbol", async () => {
      expect(await hyperEvmTbtcUpgraded.symbol()).to.be.equal("tBTC")
    })

    it("should revert when V1's initializer is called", async () => {
      await expect(
        hyperEvmTbtcUpgraded.initialize("HyperEVMTBTCv2", "HypTBTCv2")
      ).to.be.revertedWith("Initializable: contract is already initialized")
    })
  })
})
