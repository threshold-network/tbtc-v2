/* eslint-disable no-underscore-dangle */
import hre, { ethers } from "hardhat"
import { smock } from "@defi-wonderland/smock"
import chai, { expect } from "chai"

import {
  Operators,
  signFrostDkgResult,
} from "../integration/utils/frost-wallet-registry"

chai.use(smock.matchers)

describe("FrostWalletRegistry DKG liveness integration", () => {
  const GROUP_SIZE = 100
  const CHALLENGE_PERIOD = 6
  const selectedMembers = Array.from(
    { length: GROUP_SIZE },
    (_, index) => index + 1
  )

  let walletOwner: any
  let randomBeacon: any

  afterEach(async () => {
    if (walletOwner) {
      await hre.network.provider.send("hardhat_stopImpersonatingAccount", [
        walletOwner.address,
      ])
    }
    if (randomBeacon) {
      await hre.network.provider.send("hardhat_stopImpersonatingAccount", [
        randomBeacon.address,
      ])
    }
  })

  it("preserves a fully valid selected-group submission and approval", async function () {
    this.timeout(120_000)

    const [deployer, ...availableSigners] = await ethers.getSigners()
    const operatorSigners = availableSigners.slice(9, 9 + GROUP_SIZE)
    const operators = new Operators(
      ...operatorSigners.map((signer, index) => ({
        id: index + 1,
        signer,
        stakingProvider: signer.address,
      }))
    )

    const pool = await smock.fake(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )
    pool.isLocked.returns(false)
    pool.isOperatorInPool
      .whenCalledWith(operatorSigners[0].address)
      .returns(true)
    pool.getIDOperator
      .whenCalledWith(selectedMembers[0])
      .returns(operatorSigners[0].address)
    pool.getIDOperators.returns(
      operatorSigners.slice(0, 51).map((signer) => signer.address)
    )
    pool.selectGroup.returns(selectedMembers)

    randomBeacon = await smock.fake("IRandomBeacon")
    const reimbursementPool = await smock.fake("ReimbursementPool")
    walletOwner = await smock.fake("IFrostWalletOwner")
    reimbursementPool.refund.returns()

    const Validator = await ethers.getContractFactory("FrostDkgValidator")
    const validator = await Validator.deploy(pool.address)
    await validator.deployed()

    const FrostInactivity = await ethers.getContractFactory("FrostInactivity")
    const frostInactivity = await FrostInactivity.deploy()
    await frostInactivity.deployed()

    const Registry = await ethers.getContractFactory("FrostWalletRegistry", {
      signer: deployer,
      libraries: { FrostInactivity: frostInactivity.address },
    })
    const implementation = await Registry.deploy(pool.address, {
      gasLimit: 12_000_000,
    })
    await implementation.deployed()

    const initializeData = Registry.interface.encodeFunctionData("initialize", [
      validator.address,
      randomBeacon.address,
      reimbursementPool.address,
      walletOwner.address,
    ])
    const Proxy = await ethers.getContractFactory("TransparentUpgradeableProxy")
    const proxy = await Proxy.deploy(
      implementation.address,
      availableSigners[0].address,
      initializeData,
      { gasLimit: 12_000_000 }
    )
    await proxy.deployed()
    const registry = Registry.attach(proxy.address)

    await registry.updateLifecycleOwner(deployer.address)
    await hre.network.provider.send("hardhat_setBalance", [
      walletOwner.address,
      "0x56BC75E2D63100000",
    ])
    await hre.network.provider.send("hardhat_impersonateAccount", [
      walletOwner.address,
    ])
    const walletOwnerSigner = await ethers.getSigner(walletOwner.address)
    const freshMigration = await registry.getWalletArchiveMigration()
    expect(freshMigration.state).to.equal(4)
    expect(await registry.getWalletArchiveMigrationManifestHash()).to.not.equal(
      ethers.constants.HashZero
    )
    expect(await registry.registered(ethers.constants.HashZero)).to.equal(false)
    await registry.updateDkgParameters(8, CHALLENGE_PERIOD, 50_000, 20, 5)

    for (const address of [randomBeacon.address]) {
      await hre.network.provider.send("hardhat_setBalance", [
        address,
        "0x56BC75E2D63100000",
      ])
      await hre.network.provider.send("hardhat_impersonateAccount", [address])
    }

    await registry.connect(walletOwnerSigner).requestNewWallet()
    expect(pool.lock).to.have.been.calledOnce

    pool.isLocked.returns(true)
    const seed = ethers.BigNumber.from(
      ethers.utils.id("frost-wallet-registry-liveness-valid-seed")
    )
    const randomBeaconSigner = await ethers.getSigner(randomBeacon.address)

    // Adversarial upgrade race: a request entered AWAITING_SEED after the
    // deployment preflight but the upgraded implementation observes an empty
    // manifest slot. Every remaining transition must freeze until migration
    // finalization; otherwise this in-flight session could register a wallet
    // during partial backfill.
    const archiveStateSlot = 205
    const originalArchiveStateWord = ethers.BigNumber.from(
      await ethers.provider.getStorageAt(registry.address, archiveStateSlot)
    )
    const archiveStateMask = ethers.BigNumber.from(0xff).shl(224)
    const setArchiveState = async (state: number) =>
      hre.network.provider.send("hardhat_setStorageAt", [
        registry.address,
        ethers.utils.hexValue(archiveStateSlot),
        ethers.utils.hexZeroPad(
          originalArchiveStateWord
            .and(ethers.constants.MaxUint256.xor(archiveStateMask))
            .or(ethers.BigNumber.from(state).shl(224))
            .toHexString(),
          32
        ),
      ])
    await setArchiveState(1)
    await expect(registry.connect(randomBeaconSigner).__beaconCallback(seed, 0))
      .to.be.reverted
    await expect(registry.notifySeedTimeout()).to.be.reverted
    expect(await registry.getWalletCreationState()).to.equal(1)

    await setArchiveState(4)
    await registry.connect(randomBeaconSigner).__beaconCallback(seed, 0)

    const xOnlyOutputKey = ethers.utils.id(
      "frost-wallet-registry-liveness-valid-key"
    )
    const result = await signFrostDkgResult(
      hre,
      operators,
      walletOwner.address,
      registry.address,
      seed,
      xOnlyOutputKey,
      1,
      [],
      51
    )

    const [isValid, validationError] = await registry.isDkgResultValid(result)
    expect(isValid, validationError).to.equal(true)

    await setArchiveState(1)
    await expect(registry.connect(operatorSigners[0]).submitDkgResult(result))
      .to.be.reverted
    await expect(registry.notifyDkgTimeout()).to.be.reverted
    expect(await registry.getWalletCreationState()).to.equal(2)

    await setArchiveState(4)
    await registry.connect(operatorSigners[0]).submitDkgResult(result)

    await setArchiveState(1)
    await expect(
      registry.connect(operatorSigners[0]).challengeDkgResult(result)
    ).to.be.reverted
    await hre.network.provider.send("hardhat_mine", [
      `0x${(CHALLENGE_PERIOD + 1).toString(16)}`,
    ])
    await expect(registry.connect(operatorSigners[0]).approveDkgResult(result))
      .to.be.reverted
    expect(await registry.getWalletCreationState()).to.equal(3)

    await setArchiveState(2)
    await registry.finalizeArchiveMigration()
    expect((await registry.getWalletArchiveMigration()).state).to.equal(3)

    // Migration finalization rebases a pending result's submission block. The
    // time spent frozen therefore cannot make the result immediately
    // approvable; challengers receive a complete post-finalization window.
    await expect(
      registry.connect(operatorSigners[0]).approveDkgResult(result)
    ).to.be.revertedWith("Challenge period has not passed yet")
    await hre.network.provider.send("hardhat_mine", [
      `0x${CHALLENGE_PERIOD.toString(16)}`,
    ])
    await registry.connect(operatorSigners[0]).approveDkgResult(result)

    expect(walletOwner.__frostWalletCreatedCallback).to.have.been.calledOnce
    expect(walletOwner.__frostWalletCreatedCallback).to.have.been.calledWith(
      xOnlyOutputKey
    )
    expect(pool.unlock).to.have.been.calledOnce
    expect(await registry.isWalletRegistered(xOnlyOutputKey)).to.equal(true)
  })
})
