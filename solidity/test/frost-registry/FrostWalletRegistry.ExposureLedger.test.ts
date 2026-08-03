/* eslint-disable no-underscore-dangle */
import hre, { deployments, ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { smock, FakeContract } from "@defi-wonderland/smock"
import { expect } from "chai"
import type { ContractReceipt } from "ethers"
import bridgeFixture from "../fixtures/bridge"
import type {
  Bridge,
  BridgeStub,
  IRandomBeacon,
  ReimbursementPool,
} from "../../typechain"
import {
  FROST_GROUP_SIZE,
  allowlistOperatorWallets,
  deriveFundedOperatorWallets,
  performFrostDkg,
  registerOperators,
  selectFrostGroup,
} from "../integration/utils/frost-wallet-registry"

// Delegated staking module, spec section E: wallet exposure
// ledger hooks on the FrostWalletRegistry.
//
// Covers:
//   1. Set-once wiring of `setWalletExposureLedger` (governance
//      only, zero address rejected, codeless address rejected,
//      second set rejected).
//   2. `approveDkgResult` hook: the registry resolves the DKG
//      result's member IDs to staking providers, aggregates
//      unique provider / seat-count arrays, and calls
//      `onWalletRegistered` — with a reverting ledger the
//      approval still succeeds and only emits
//      `WalletExposureLedgerCallFailed`.
//   3. `closeWallet` hook: `onWalletClosed` is invoked; a
//      reverting ledger cannot brick closure.
//   4. Codeless ledger guard: a ledger that loses its code after
//      wiring (selfdestruct) cannot brick `approveDkgResult` or
//      `closeWallet` via the compiler-inserted extcodesize check
//      that sits outside the library's try/catch. Driven through a
//      harness linked against the same library deployment. An
//      installer creates, wires, and self-destructs the stub in one
//      transaction so code is removed under EIP-6780 (smock fakes
//      keep their code, so the codeless state cannot be simulated
//      on the registry's wired fake).
//
// Reuses the HappyPath fixture shape (100 registered operators,
// impersonated Bridge + beacon, compressed challenge period) and
// runs the DKG twice — once against a reverting ledger fake
// (resilience) and once against a well-behaved fake (payload
// correctness).

// The `WalletExposureLedgerSet` / `WalletExposureLedgerCallFailed`
// events are declared in the externally linked
// `FrostWalletExposure` library and emitted via delegatecall, so
// they surface with the registry's address but are absent from
// the registry's own ABI — match them by topic hash.
const LEDGER_SET_TOPIC = ethers.utils.id("WalletExposureLedgerSet(address)")
const CALL_FAILED_TOPIC = ethers.utils.id(
  "WalletExposureLedgerCallFailed(bytes32)"
)

function logsWithTopic(
  receipt: ContractReceipt,
  topic: string,
  emitter: string
) {
  return receipt.logs.filter(
    (log) =>
      log.topics[0] === topic &&
      log.address.toLowerCase() === emitter.toLowerCase()
  )
}

// Helper: assert a transaction reverts with a specific no-arg
// custom error by manually decoding the 4-byte selector (the
// project's test toolchain does not register chai's
// `revertedWithCustomError` matcher). Mirrors
// `FrostWalletRegistry.GuardsUnit.test.ts`.
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
      errMsg.toLowerCase().includes(expectedSelector) ||
      errMsg.includes(errorName)
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

describe("FrostWalletRegistry wallet exposure ledger hooks", () => {
  let deployer: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let frostWalletRegistry: any
  let frostSortitionPool: any
  let randomBeacon: any
  let operators: Awaited<ReturnType<typeof registerOperators>>
  let ledgerFake: FakeContract
  let exposureLib: any

  before(async function setupFixture() {
    // 100 sequential operator registrations + two DKG flows.
    this.timeout(600_000)

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, thirdParty, bridge } = await waffle.loadFixture(
      bridgeFixture
    ))

    const t = await deployments.get("T")

    randomBeacon = await smock.fake<IRandomBeacon>("IRandomBeacon")

    const reimbursementPoolFake = await smock.fake<ReimbursementPool>(
      "ReimbursementPool"
    )
    reimbursementPoolFake.refund.returns()

    const SortitionPoolFactory = await ethers.getContractFactory(
      "@keep-network/sortition-pools/contracts/SortitionPool.sol:SortitionPool"
    )
    frostSortitionPool = await SortitionPoolFactory.connect(deployer).deploy(
      t.address,
      ethers.utils.parseEther("1") // POOL_WEIGHT_DIVISOR
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

    const InactFactory = await ethers.getContractFactory("FrostInactivity")
    const inact = await InactFactory.connect(deployer).deploy()
    await inact.deployed()

    const ExposureFactory = await ethers.getContractFactory(
      "FrostWalletExposure"
    )
    const exposure = await ExposureFactory.connect(deployer).deploy()
    await exposure.deployed()
    exposureLib = exposure

    // Distinct deployment label so this fixture doesn't collide
    // with the other frost-registry tests when they run in the
    // same Hardhat process.
    const [registry] = await helpers.upgrades.deployProxy(
      "FrostWalletRegistryExposureLedgerTest",
      {
        contractName: "FrostWalletRegistry",
        initializerArgs: [
          validator.address,
          randomBeacon.address,
          reimbursementPoolFake.address,
          bridge.address,
        ],
        factoryOpts: {
          signer: deployer,
          libraries: {
            FrostInactivity: inact.address,
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

    await bridge.resetFrostWalletRegistryForTest(frostWalletRegistry.address)
    await bridge.resetLifecycleRouterForTest(deployer.address)
    await frostWalletRegistry
      .connect(deployer)
      .updateLifecycleOwner(deployer.address)

    // Compress challenge period to 10 blocks so the test runs
    // fast (production is much longer).
    const dkgParams = await frostWalletRegistry.dkgParameters()
    await frostWalletRegistry
      .connect(deployer)
      .updateDkgParameters(
        dkgParams.seedTimeout,
        10,
        dkgParams.resultChallengeExtraGas,
        dkgParams.resultSubmissionTimeout,
        dkgParams.submitterPrecedencePeriodLength
      )

    const [frostAllowlist] = await helpers.upgrades.deployProxy(
      "FrostAllowlistExposureLedgerTest",
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

    await frostWalletRegistry
      .connect(deployer)
      .initializeV2(frostAllowlist.address)

    // 100 operators allowlisted + funded + registered + joined
    // the pool.
    const wallets = await deriveFundedOperatorWallets(hre, FROST_GROUP_SIZE)
    await allowlistOperatorWallets(frostAllowlist, frostWalletRegistry, wallets)
    operators = await registerOperators(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      wallets
    )

    ledgerFake = await smock.fake("IWalletExposureLedger")
    ledgerFake.frostWalletRegistry.returns(frostWalletRegistry.address)
  })

  /// Drives one full DKG round (request → seed → submit →
  /// approve) for the given wallet key and returns the approve
  /// receipt plus the group used.
  async function runDkgRound(
    xOnlyOutputKey: string,
    seedLabel: string,
    approveGasLimit?: number
  ) {
    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
    const bridgeImpersonated = await ethers.getSigner(bridge.address)
    await hre.network.provider.send("hardhat_setBalance", [
      bridge.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    await frostWalletRegistry.connect(bridgeImpersonated).requestNewWallet()

    await ethers.provider.send("hardhat_impersonateAccount", [
      randomBeacon.address,
    ])
    const beaconImpersonated = await ethers.getSigner(randomBeacon.address)
    await hre.network.provider.send("hardhat_setBalance", [
      randomBeacon.address,
      "0x56BC75E2D63100000", // 100 ETH
    ])
    const seed = ethers.BigNumber.from(ethers.utils.id(seedLabel))
    await frostWalletRegistry
      .connect(beaconImpersonated)
      .__beaconCallback(seed, 0)

    const groupMembers = await selectFrostGroup(
      hre,
      frostWalletRegistry,
      frostSortitionPool,
      operators
    )

    const { approveDkgResultTx, dkgResult } = await performFrostDkg(
      hre,
      frostWalletRegistry,
      bridge.address,
      seed,
      xOnlyOutputKey,
      groupMembers,
      { approveGasLimit }
    )

    const approveReceipt = await approveDkgResultTx.wait()
    return { approveReceipt, dkgResult, groupMembers }
  }

  /// Computes the unique provider / seat-count arrays the
  /// registry must hand to the ledger: iterate the result's
  /// members in order, resolve each to its staking provider
  /// (provider == operator wallet address in this fixture), and
  /// aggregate in first-occurrence order.
  function expectedExposure(
    groupMembers: Awaited<ReturnType<typeof selectFrostGroup>>
  ): { providers: string[]; seatCounts: number[] } {
    const providers: string[] = []
    const seatCounts: number[] = []
    for (const member of groupMembers) {
      const provider = member.stakingProvider.toLowerCase()
      const idx = providers.indexOf(provider)
      if (idx === -1) {
        providers.push(provider)
        seatCounts.push(1)
      } else {
        seatCounts[idx] += 1
      }
    }
    return { providers, seatCounts }
  }

  const walletKeyA =
    "0xabcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01"
  const walletKeyB =
    "0xbeadfeed12345678beadfeed12345678beadfeed12345678beadfeed12345678"
  const gasFailureWallet = ethers.utils.id("gas-reserve-wallet")

  describe("setWalletExposureLedger wiring", () => {
    it("rejects non-governance callers", async () => {
      await expect(
        frostWalletRegistry
          .connect(thirdParty)
          .setWalletExposureLedger(thirdParty.address)
      ).to.be.revertedWith("Caller is not the governance")
    })

    it("rejects the zero address", async () => {
      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .setWalletExposureLedger(ethers.constants.AddressZero),
        "WalletExposureLedgerAddressZero"
      )
    })

    it("rejects an address with no deployed code (EOA)", async () => {
      // A codeless ledger would brick approveDkgResult / closeWallet:
      // the extcodesize check on the notification calls reverts
      // outside the library's try/catch.
      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .setWalletExposureLedger(thirdParty.address),
        "WalletExposureLedgerNotContract"
      )
    })

    it("rejects a ledger initialized for another registry", async () => {
      const mismatchedLedger = await smock.fake("IWalletExposureLedger")
      mismatchedLedger.frostWalletRegistry.returns(thirdParty.address)

      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .setWalletExposureLedger(mismatchedLedger.address),
        "WalletExposureLedgerRegistryMismatch"
      )
      expect(await frostWalletRegistry.walletExposureLedger()).to.equal(
        ethers.constants.AddressZero
      )
    })

    it("reverts approval when a ledger registration exhausts forwarded gas", async function gasReserve() {
      this.timeout(240_000)
      const snapshot = await ethers.provider.send("evm_snapshot", [])
      try {
        const GasBurner = await ethers.getContractFactory(
          "GasBurningWalletExposureLedger"
        )
        const gasBurner = await GasBurner.connect(deployer).deploy(
          frostWalletRegistry.address
        )
        await gasBurner.deployed()
        await frostWalletRegistry
          .connect(deployer)
          .setWalletExposureLedger(gasBurner.address)

        await expectCustomError(
          runDkgRound(
            gasFailureWallet,
            "frost-exposure-ledger-gas-reserve",
            12_000_000
          ),
          "InsufficientWalletExposureCallbackGas"
        )
        expect(
          await frostWalletRegistry.isWalletRegistered(gasFailureWallet)
        ).to.equal(false)
      } finally {
        await ethers.provider.send("evm_revert", [snapshot])
      }
    })

    it("sets the ledger and emits WalletExposureLedgerSet", async () => {
      expect(await frostWalletRegistry.walletExposureLedger()).to.equal(
        ethers.constants.AddressZero
      )

      const tx = await frostWalletRegistry
        .connect(deployer)
        .setWalletExposureLedger(ledgerFake.address)
      const receipt = await tx.wait()

      expect(await frostWalletRegistry.walletExposureLedger()).to.equal(
        ledgerFake.address
      )

      const setLogs = logsWithTopic(
        receipt,
        LEDGER_SET_TOPIC,
        frostWalletRegistry.address
      )
      expect(setLogs).to.have.lengthOf(1)
      const [emittedAddress] = ethers.utils.defaultAbiCoder.decode(
        ["address"],
        setLogs[0].data
      )
      expect(emittedAddress).to.equal(ledgerFake.address)
    })

    it("rejects a second set (set-once)", async () => {
      await expectCustomError(
        frostWalletRegistry
          .connect(deployer)
          .setWalletExposureLedger(thirdParty.address),
        "WalletExposureLedgerAlreadySet"
      )
    })
  })

  describe("approveDkgResult → onWalletRegistered", () => {
    it("survives a reverting ledger: approval succeeds and emits WalletExposureLedgerCallFailed", async function dkgAgainstRevertingLedger() {
      this.timeout(240_000)

      ledgerFake.onWalletRegistered.reverts("exposure ledger down")

      const { approveReceipt } = await runDkgRound(
        walletKeyA,
        "frost-exposure-ledger-seed-A"
      )

      // Approval fully succeeded despite the reverting ledger.
      expect(await frostWalletRegistry.getWalletCreationState()).to.equal(
        0 /* IDLE */
      )
      expect(await frostWalletRegistry.isWalletRegistered(walletKeyA)).to.equal(
        true
      )

      // ... and the failure was surfaced as an event carrying the
      // walletID.
      const failedLogs = logsWithTopic(
        approveReceipt,
        CALL_FAILED_TOPIC,
        frostWalletRegistry.address
      )
      expect(failedLogs).to.have.lengthOf(1)
      expect(failedLogs[0].topics[1]).to.equal(walletKeyA)
    })

    it("invokes the ledger with unique providers and aligned seat counts", async function dkgAgainstHealthyLedger() {
      this.timeout(240_000)

      ledgerFake.onWalletRegistered.reset()

      const { approveReceipt, dkgResult, groupMembers } = await runDkgRound(
        walletKeyB,
        "frost-exposure-ledger-seed-B"
      )

      expect(await frostWalletRegistry.isWalletRegistered(walletKeyB)).to.equal(
        true
      )

      // No failure event this time.
      expect(
        logsWithTopic(
          approveReceipt,
          CALL_FAILED_TOPIC,
          frostWalletRegistry.address
        )
      ).to.have.lengthOf(0)

      // The hook was called exactly once, with walletID == the
      // x-only output key and first-occurrence-ordered unique
      // provider / seat-count arrays covering every member seat.
      expect(ledgerFake.onWalletRegistered._watchable.getCallCount()).to.equal(
        1
      )
      const call = ledgerFake.onWalletRegistered.getCall(0)
      const [walletID, providers, seatCounts] = call.args as unknown as [
        string,
        string[],
        number[]
      ]

      expect(walletID).to.equal(walletKeyB)

      const expected = expectedExposure(groupMembers)
      expect(providers.map((p: string) => p.toLowerCase())).to.deep.equal(
        expected.providers
      )
      expect(seatCounts.map((c) => Number(c))).to.deep.equal(
        expected.seatCounts
      )

      // Providers are unique and seat counts cover all 100 seats.
      const lowercased = providers.map((p: string) => p.toLowerCase())
      expect(new Set(lowercased).size).to.equal(providers.length)
      expect(seatCounts.reduce((acc, c) => acc + Number(c), 0)).to.equal(
        dkgResult.members.length
      )
    })
  })

  describe("closeWallet → onWalletClosed", () => {
    it("survives a reverting ledger: closure succeeds and emits WalletExposureLedgerCallFailed", async () => {
      ledgerFake.onWalletClosed.reverts("exposure ledger down")

      const tx = await frostWalletRegistry
        .connect(deployer)
        .closeWallet(walletKeyA)
      const receipt = await tx.wait()

      // The wallet is gone despite the reverting ledger.
      expect(await frostWalletRegistry.isWalletRegistered(walletKeyA)).to.equal(
        false
      )
      await expect(tx)
        .to.emit(frostWalletRegistry, "WalletClosed")
        .withArgs(walletKeyA)

      const failedLogs = logsWithTopic(
        receipt,
        CALL_FAILED_TOPIC,
        frostWalletRegistry.address
      )
      expect(failedLogs).to.have.lengthOf(1)
      expect(failedLogs[0].topics[1]).to.equal(walletKeyA)
    })

    it("invokes the ledger with the closed walletID", async () => {
      ledgerFake.onWalletClosed.reset()

      const tx = await frostWalletRegistry
        .connect(deployer)
        .closeWallet(walletKeyB)
      const receipt = await tx.wait()

      expect(await frostWalletRegistry.isWalletRegistered(walletKeyB)).to.equal(
        false
      )
      expect(
        logsWithTopic(receipt, CALL_FAILED_TOPIC, frostWalletRegistry.address)
      ).to.have.lengthOf(0)

      expect(ledgerFake.onWalletClosed._watchable.getCallCount()).to.equal(1)
      expect(ledgerFake.onWalletClosed.getCall(0).args[0]).to.equal(walletKeyB)
    })
  })

  describe("codeless ledger guard (selfdestruct after wiring)", () => {
    let harness: any
    let installer: any

    before(async () => {
      // The harness links against the SAME library deployment the
      // registry uses, so the guard code under test is identical.
      const HarnessFactory = await ethers.getContractFactory(
        "FrostWalletExposureHarness",
        {
          libraries: { FrostWalletExposure: exposureLib.address },
          signer: deployer,
        }
      )
      harness = await HarnessFactory.deploy()
      await harness.deployed()

      const InstallerFactory = await ethers.getContractFactory(
        "EphemeralLedgerInstaller"
      )
      installer = await InstallerFactory.connect(deployer).deploy()
      await installer.deployed()
    })

    it("rejects wiring an address with no code at the library level", async () => {
      await expectCustomError(
        harness.setLedger(thirdParty.address),
        "WalletExposureLedgerNotContract"
      )
    })

    it("treats a ledger that lost its code as a failed notification instead of reverting", async () => {
      // The installer creates the stub, wires it while it has code, and then
      // destroys it in the same transaction so EIP-6780 removes its code.
      await installer.wireAndDestroy(harness.address)
      const destructibleLedger = await installer.lastLedger()
      expect(await harness.ledger()).to.equal(destructibleLedger)

      // Without the library's
      // code-length guard the compiler-inserted extcodesize check on
      // the notification calls would revert OUTSIDE the try/catch,
      // bricking approveDkgResult / closeWallet.
      expect(await ethers.provider.getCode(destructibleLedger)).to.equal("0x")

      const walletID = ethers.utils.id("codeless-ledger-wallet")

      // notifyWalletRegistered: succeeds and surfaces the failure as an
      // event (the guard fires before the sortition pool or the ledger
      // are touched).
      const regTx = await harness.notifyWalletRegistered(
        frostSortitionPool.address,
        walletID,
        []
      )
      const regReceipt = await regTx.wait()
      const regFailedLogs = logsWithTopic(
        regReceipt,
        CALL_FAILED_TOPIC,
        harness.address
      )
      expect(regFailedLogs).to.have.lengthOf(1)
      expect(regFailedLogs[0].topics[1]).to.equal(walletID)

      // notifyWalletClosed: same guard, same surfacing.
      const closeTx = await harness.notifyWalletClosed(walletID)
      const closeReceipt = await closeTx.wait()
      const closeFailedLogs = logsWithTopic(
        closeReceipt,
        CALL_FAILED_TOPIC,
        harness.address
      )
      expect(closeFailedLogs).to.have.lengthOf(1)
      expect(closeFailedLogs[0].topics[1]).to.equal(walletID)
    })
  })
})
