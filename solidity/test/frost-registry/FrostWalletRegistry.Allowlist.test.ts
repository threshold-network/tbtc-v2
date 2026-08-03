/* eslint-disable no-await-in-loop */
import hre, { deployments, ethers, helpers, upgrades, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { smock } from "@defi-wonderland/smock"
import { expect } from "chai"
import bridgeFixture from "../fixtures/bridge"
import type { Bridge, BridgeStub, IRandomBeacon } from "../../typechain"
import { deriveFundedOperatorWallets } from "../integration/utils/frost-wallet-registry"

let testDeploymentCounter = 0

const encodeLiveWalletProof = (
  liveWalletIDs: string[],
  historicalWalletsCreated: number,
  historicalWalletsClosed: number
): string =>
  ethers.utils.defaultAbiCoder.encode(
    ["bytes32[]", "uint256", "uint256"],
    [liveWalletIDs, historicalWalletsCreated, historicalWalletsClosed]
  )

async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  const expectedSelector = ethers.utils.id(`${errorName}()`).slice(0, 10)
  try {
    await promise
  } catch (err) {
    const errAny = err as {
      data?: string
      message?: string
      error?: { data?: string }
    }
    const revertData = errAny.data || errAny.error?.data || ""
    const errMsg = errAny.message || String(err)
    if (
      (revertData && revertData.toLowerCase().startsWith(expectedSelector)) ||
      errMsg.toLowerCase().includes(expectedSelector)
    ) {
      return
    }
    throw new Error(
      `expected revert with custom error ${errorName} ` +
        `(selector ${expectedSelector}), got: ${errMsg}`
    )
  }
  throw new Error(
    `expected revert with custom error ${errorName} but tx succeeded`
  )
}

describe("FrostWalletRegistry allowlist authorization", () => {
  let deployer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let proxyAdminOwner: SignerWithAddress
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
    ;({ esdm: proxyAdminOwner } = await helpers.signers.getNamedSigners())

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
      frostSortitionPool.address,
      0 // maxSeatsPerWallet disabled
    )
    await validator.deployed()

    const InactivityFactory = await ethers.getContractFactory("FrostInactivity")
    const inactivity = await InactivityFactory.connect(deployer).deploy()
    await inactivity.deployed()

    const ExposureFactory = await ethers.getContractFactory(
      "FrostWalletExposure"
    )
    const exposure = await ExposureFactory.connect(deployer).deploy()
    await exposure.deployed()

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
          libraries: {
            FrostInactivity: inactivity.address,
            FrostWalletExposure: exposure.address,
          },
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

  it("atomically migrates and rolls back the complete active authorization roster", async () => {
    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(frostAllowlist.address)

    const weight = await frostWalletRegistry.minimumAuthorization()
    const migratedWeight = weight.mul(2)
    const wallets = await deriveFundedOperatorWallets(hre, OPERATOR_COUNT)
    const providers = wallets.map((wallet) => wallet.address)

    for (const wallet of wallets) {
      await frostAllowlist
        .connect(deployer)
        .addStakingProvider(wallet.address, weight)
      await frostWalletRegistry.connect(wallet).registerOperator(wallet.address)
      await frostWalletRegistry.connect(wallet).joinSortitionPool()
    }

    const MigrationSourceFactory = await ethers.getContractFactory(
      "StakingMigrationAuthorizationSource"
    )
    const migrationSource = await MigrationSourceFactory.connect(
      deployer
    ).deploy()
    for (const provider of providers) {
      await migrationSource.setWeight(provider, migratedWeight)
    }
    const emptyWalletProof = encodeLiveWalletProof([], 0, 0)

    const [walletExposureLedger] = await helpers.upgrades.deployProxy(
      `WalletExposureLedgerMigrationTest${testDeploymentCounter}`,
      {
        contractName: "WalletExposureLedger",
        initializerArgs: [frostWalletRegistry.address],
        proxyOpts: { kind: "transparent" },
      }
    )
    await expectCustomError(
      frostWalletRegistry
        .connect(thirdParty)
        .migrateAuthorizationSource(
          migrationSource.address,
          true,
          walletExposureLedger.address,
          providers,
          emptyWalletProof
        ),
      "CallerNotGovernanceOrProxyAdmin"
    )
    await migrationSource.setRevertPreparationWithoutData(true)
    await expect(
      frostWalletRegistry
        .connect(deployer)
        .migrateAuthorizationSource(
          migrationSource.address,
          true,
          walletExposureLedger.address,
          providers,
          emptyWalletProof
        )
    ).to.be.reverted
    expect(await frostWalletRegistry.walletExposureLedger()).to.equal(
      ethers.constants.AddressZero
    )
    expect(await frostWalletRegistry.authorizationSource()).to.equal(
      frostAllowlist.address
    )
    await migrationSource.setRevertPreparationWithoutData(false)

    // Exercise the production cutover shape: deploy the new implementation
    // and have ProxyAdmin perform upgradeAndCall. The migration library
    // recognizes the EIP-1967 admin while ordinary non-governance callers
    // remain rejected. Governance retains the repeatable direct rollback path.
    const InactivityFactory = await ethers.getContractFactory("FrostInactivity")
    const inactivity = await InactivityFactory.connect(deployer).deploy()
    const ExposureFactory = await ethers.getContractFactory(
      "FrostWalletExposure"
    )
    const exposure = await ExposureFactory.connect(deployer).deploy()
    const RegistryFactory = await ethers.getContractFactory(
      "FrostWalletRegistry",
      {
        signer: deployer,
        libraries: {
          FrostInactivity: inactivity.address,
          FrostWalletExposure: exposure.address,
        },
      }
    )
    const implementation = await RegistryFactory.deploy(
      frostSortitionPool.address
    )
    const migrationCall = frostWalletRegistry.interface.encodeFunctionData(
      "migrateAuthorizationSource",
      [
        migrationSource.address,
        true,
        walletExposureLedger.address,
        providers,
        emptyWalletProof,
      ]
    )
    const proxyAdmin = await upgrades.admin.getInstance()
    await expect(
      proxyAdmin
        .connect(proxyAdminOwner)
        .upgradeAndCall(
          frostWalletRegistry.address,
          implementation.address,
          migrationCall
        )
    )
      .to.emit(frostWalletRegistry, "AuthorizationSourceUpdated")
      .withArgs(migrationSource.address)

    expect(await migrationSource.prepareCalls()).to.equal(1)
    expect(await frostWalletRegistry.walletExposureLedger()).to.equal(
      walletExposureLedger.address
    )
    for (const provider of providers) {
      expect(await frostWalletRegistry.eligibleStake(provider)).to.equal(
        migratedWeight
      )
    }

    // A stateful source may reduce a provider to zero and remove it from the
    // pool. Rollback must use the preserved Phase-0 roster to reinsert it.
    const removedProvider = providers[providers.length - 1]
    await migrationSource.setWeight(removedProvider, 0)
    await frostWalletRegistry.updateOperatorStatus(removedProvider)
    expect(await frostWalletRegistry.isOperatorInPool(removedProvider)).to.be
      .false

    // Rollback uses the already-populated production FrostAllowlist. Its
    // deployed implementation predates the optional preparation hook; the
    // migration tolerates that missing selector and still rewrites every leaf.
    await frostWalletRegistry
      .connect(deployer)
      .migrateAuthorizationSource(
        frostAllowlist.address,
        false,
        ethers.constants.AddressZero,
        providers.slice(0, -1),
        "0x"
      )
    expect(await migrationSource.detachCalls()).to.equal(1)
    for (const provider of providers) {
      expect(await frostWalletRegistry.eligibleStake(provider)).to.equal(weight)
      expect(await frostWalletRegistry.isOperatorInPool(provider)).to.be.true
    }
  })

  it("rejects an incomplete active migration roster", async () => {
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
    }

    const MigrationSourceFactory = await ethers.getContractFactory(
      "StakingMigrationAuthorizationSource"
    )
    const migrationSource = await MigrationSourceFactory.connect(
      deployer
    ).deploy()
    await expect(
      frostWalletRegistry
        .connect(deployer)
        .migrateAuthorizationSource(
          migrationSource.address,
          true,
          ethers.constants.AddressZero,
          [wallets[0].address],
          "0x"
        )
    ).to.be.revertedWith("Authorization roster length mismatch")
    expect(await frostWalletRegistry.authorizationSource()).to.equal(
      frostAllowlist.address
    )
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

  it("rejects direct malicious-behavior reports from non-registry callers", async () => {
    await expectCustomError(
      frostAllowlist
        .connect(thirdParty)
        .reportMaliciousBehavior(0, 0, thirdParty.address, [
          thirdParty.address,
        ]),
      "NotWalletRegistry"
    )
  })

  it("lets governance increase an existing provider's weight", async () => {
    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(frostAllowlist.address)

    const weight = await frostWalletRegistry.minimumAuthorization()
    const increasedWeight = weight.mul(2)
    const [wallet] = await deriveFundedOperatorWallets(hre, 1)

    await frostAllowlist
      .connect(deployer)
      .addStakingProvider(wallet.address, weight)

    await frostWalletRegistry.connect(wallet).registerOperator(wallet.address)
    await frostWalletRegistry.connect(wallet).joinSortitionPool()
    expect(await frostWalletRegistry.isOperatorUpToDate(wallet.address)).to.be
      .true

    await expect(
      frostAllowlist
        .connect(deployer)
        .increaseWeight(wallet.address, increasedWeight)
    )
      .to.emit(frostAllowlist, "WeightIncreased")
      .withArgs(wallet.address, weight, increasedWeight)

    expect(await frostWalletRegistry.eligibleStake(wallet.address)).to.equal(
      increasedWeight
    )
    expect(await frostWalletRegistry.isOperatorUpToDate(wallet.address)).to.be
      .false

    await frostWalletRegistry
      .connect(wallet)
      .updateOperatorStatus(wallet.address)
    expect(await frostWalletRegistry.isOperatorUpToDate(wallet.address)).to.be
      .true
  })

  it("rejects weight increases while a decrease is pending", async () => {
    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(frostAllowlist.address)

    const weight = await frostWalletRegistry.minimumAuthorization()
    const initialWeight = weight.mul(2)
    const [wallet] = await deriveFundedOperatorWallets(hre, 1)

    await frostAllowlist
      .connect(deployer)
      .addStakingProvider(wallet.address, initialWeight)
    await frostAllowlist
      .connect(deployer)
      .requestWeightDecrease(wallet.address, weight)

    await expectCustomError(
      frostAllowlist
        .connect(deployer)
        .increaseWeight(wallet.address, initialWeight.mul(2)),
      "DecreasePending"
    )
  })

  it("finalizes requested weight decreases through the registry", async () => {
    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(frostAllowlist.address)

    const weight = await frostWalletRegistry.minimumAuthorization()
    const initialWeight = weight.mul(2)
    const [wallet] = await deriveFundedOperatorWallets(hre, 1)

    await frostWalletRegistry
      .connect(deployer)
      .updateAuthorizationParameters(weight, 1, 1)

    await frostAllowlist
      .connect(deployer)
      .addStakingProvider(wallet.address, initialWeight)

    await frostWalletRegistry.connect(wallet).registerOperator(wallet.address)
    await frostWalletRegistry.connect(wallet).joinSortitionPool()

    await frostAllowlist
      .connect(deployer)
      .requestWeightDecrease(wallet.address, weight)
    await frostWalletRegistry
      .connect(wallet)
      .updateOperatorStatus(wallet.address)

    await ethers.provider.send("evm_increaseTime", [2])
    await ethers.provider.send("evm_mine", [])

    await expect(
      frostWalletRegistry.approveAuthorizationDecrease(wallet.address)
    )
      .to.emit(frostAllowlist, "WeightDecreaseFinalized")
      .withArgs(wallet.address, initialWeight, weight)

    expect(
      await frostAllowlist.authorizedWeight(
        wallet.address,
        ethers.constants.AddressZero
      )
    ).to.equal(weight)
    expect(
      await frostWalletRegistry.pendingAuthorizationDecrease(wallet.address)
    ).to.equal(0)
    expect(await frostWalletRegistry.eligibleStake(wallet.address)).to.equal(
      weight
    )
  })

  it("rejects direct authorization-decrease approval from non-registry callers", async () => {
    const [wallet] = await deriveFundedOperatorWallets(hre, 1)

    await expectCustomError(
      frostAllowlist
        .connect(thirdParty)
        .approveAuthorizationDecrease(wallet.address),
      "NotWalletRegistry"
    )
  })
})
