/* eslint-disable no-await-in-loop */
import hre, { deployments, ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { smock } from "@defi-wonderland/smock"
import { expect } from "chai"
import bridgeFixture from "../fixtures/bridge"
import type { Bridge, BridgeStub, IRandomBeacon } from "../../typechain"
import { deriveFundedOperatorWallets } from "../integration/utils/frost-wallet-registry"

let testDeploymentCounter = 0

describe("FrostWalletRegistry allowlist authorization", () => {
  let deployer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let frostWalletRegistry: any
  let frostAllowlist: any
  let frostSortitionPool: any

  const OPERATOR_COUNT = 3

  beforeEach(async () => {
    testDeploymentCounter += 1

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, thirdParty, bridge } = await waffle.loadFixture(
      bridgeFixture
    ))

    const t = await deployments.get("T")
    const reimbursementPool = await deployments.get("ReimbursementPool")
    const randomBeacon = await smock.fake<IRandomBeacon>("IRandomBeacon")

    const SortitionPoolFactory = await ethers.getContractFactory(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )
    frostSortitionPool = await SortitionPoolFactory.connect(deployer).deploy(
      t.address,
      ethers.utils.parseEther("1")
    )
    await frostSortitionPool.deployed()
    await frostSortitionPool.connect(deployer).deactivateChaosnet()

    const ValidatorFactory = await ethers.getContractFactory(
      "FrostDkgValidator"
    )
    const validator = await ValidatorFactory.connect(deployer).deploy(
      frostSortitionPool.address
    )
    await validator.deployed()

    const InactivityFactory = await ethers.getContractFactory("FrostInactivity")
    const inactivity = await InactivityFactory.connect(deployer).deploy()
    await inactivity.deployed()

    const [registry] = await helpers.upgrades.deployProxy(
      `FrostWalletRegistryAllowlistTest${testDeploymentCounter}`,
      {
        contractName: "FrostWalletRegistry",
        initializerArgs: [
          validator.address,
          randomBeacon.address,
          reimbursementPool.address,
          bridge.address,
        ],
        factoryOpts: {
          signer: deployer,
          libraries: { FrostInactivity: inactivity.address },
        },
        proxyOpts: {
          constructorArgs: [frostSortitionPool.address],
          unsafeAllow: ["external-library-linking"],
          kind: "transparent",
        },
      }
    )
    frostWalletRegistry = registry
    await frostSortitionPool.transferOwnership(frostWalletRegistry.address)

    const [allowlist] = await helpers.upgrades.deployProxy(
      `FrostAllowlistAllowlistTest${testDeploymentCounter}`,
      {
        contractName: "FrostAllowlist",
        initializerArgs: [frostWalletRegistry.address],
        factoryOpts: {
          signer: deployer,
        },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    frostAllowlist = allowlist
  })

  it("lets allowlisted operators join without token staking", async () => {
    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(frostAllowlist.address)

    const weight = await frostWalletRegistry.minimumAuthorization()
    const wallets = await deriveFundedOperatorWallets(hre, OPERATOR_COUNT)

    for (const wallet of wallets) {
      await frostAllowlist
        .connect(deployer)
        .addStakingProvider(wallet.address, weight)

      await frostWalletRegistry.connect(wallet).registerOperator(wallet.address)
      await frostWalletRegistry.connect(wallet).joinSortitionPool()

      expect(await frostWalletRegistry.eligibleStake(wallet.address)).to.equal(
        weight
      )
      expect(
        await frostWalletRegistry.operatorToStakingProvider(wallet.address)
      ).to.equal(wallet.address)
    }

    expect(await frostSortitionPool.operatorsInPool()).to.equal(OPERATOR_COUNT)
  })

  it("rejects authorization reads before allowlist initialization", async () => {
    const [wallet] = await deriveFundedOperatorWallets(hre, 1)
    await frostWalletRegistry.connect(wallet).registerOperator(wallet.address)

    await expect(
      frostWalletRegistry.connect(wallet).joinSortitionPool()
    ).to.be.revertedWith("Authorization source is not initialized")
  })

  it("rejects allowlist initialization by non-governance", async () => {
    await expect(
      frostWalletRegistry
        .connect(thirdParty)
        .initializeV2(frostAllowlist.address)
    ).to.be.revertedWith("Caller is not the governance")
  })
})
