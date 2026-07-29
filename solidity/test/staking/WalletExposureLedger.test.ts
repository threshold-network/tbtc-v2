/* eslint-disable no-await-in-loop */
import { randomBytes } from "crypto"
import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"

// hardhat-deploy persists proxy deployments by name across test processes;
// a per-deployment random suffix keeps labels collision-free (same idiom as
// the other staking suites).
const uniqueSuffix = (): string => randomBytes(8).toString("hex")

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

describe("WalletExposureLedger", () => {
  // The ledger's only privileged caller is the FROST wallet registry; a
  // plain signer stands in for it so tests can drive the two hooks
  // directly.
  let registrySigner: SignerWithAddress
  let thirdParty: SignerWithAddress
  let providerA: string
  let providerB: string
  let providerC: string
  let ledger: any

  const wallet1 = ethers.utils.id("wallet-1")
  const wallet2 = ethers.utils.id("wallet-2")
  const wallet3 = ethers.utils.id("wallet-3")
  const wallet4 = ethers.utils.id("wallet-4")
  const wallet5 = ethers.utils.id("wallet-5")
  const unknownWallet = ethers.utils.id("wallet-unknown")

  async function deployLedger(registryAddress: string): Promise<any> {
    const [instance] = await helpers.upgrades.deployProxy(
      `WalletExposureLedgerUnitTest_${uniqueSuffix()}`,
      {
        contractName: "WalletExposureLedger",
        initializerArgs: [registryAddress],
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    return instance
  }

  function register(
    walletID: string,
    providers: string[],
    seatCounts?: number[]
  ) {
    return ledger
      .connect(registrySigner)
      .onWalletRegistered(
        walletID,
        providers,
        seatCounts ?? providers.map(() => 1)
      )
  }

  function close(walletID: string) {
    return ledger.connect(registrySigner).onWalletClosed(walletID)
  }

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[, registrySigner, thirdParty] = await ethers.getSigners()
    const signers = await ethers.getSigners()
    providerA = signers[10].address
    providerB = signers[11].address
    providerC = signers[12].address

    ledger = await deployLedger(registrySigner.address)
  })

  describe("initialization", () => {
    it("stores the registry address", async () => {
      expect(await ledger.frostWalletRegistry()).to.equal(
        registrySigner.address
      )
    })

    it("rejects the zero registry address", async () => {
      await expectCustomError(
        deployLedger(ethers.constants.AddressZero),
        "ZeroAddress"
      )
    })
  })

  describe("access control", () => {
    it("rejects onWalletRegistered from non-registry callers", async () => {
      await expectCustomError(
        ledger
          .connect(thirdParty)
          .onWalletRegistered(wallet1, [providerA], [1]),
        "NotWalletRegistry"
      )
    })

    it("rejects onWalletClosed from non-registry callers", async () => {
      await register(wallet1, [providerA])
      await expectCustomError(
        ledger.connect(thirdParty).onWalletClosed(wallet1),
        "NotWalletRegistry"
      )
    })
  })

  describe("onWalletRegistered", () => {
    it("assigns sequential per-provider epochs across wallets", async () => {
      await register(wallet1, [providerA, providerB], [3, 1])
      await register(wallet2, [providerA, providerC], [1, 2])

      expect(await ledger.currentEpoch(providerA)).to.equal(2)
      expect(await ledger.currentEpoch(providerB)).to.equal(1)
      expect(await ledger.currentEpoch(providerC)).to.equal(1)

      expect(await ledger.liveWalletCount(providerA)).to.equal(2)
      expect(await ledger.liveWalletCount(providerB)).to.equal(1)
      expect(await ledger.liveWalletCount(providerC)).to.equal(1)

      expect(await ledger.liveEpochs(providerA, 1)).to.be.true
      expect(await ledger.liveEpochs(providerA, 2)).to.be.true
      expect(await ledger.liveEpochs(providerB, 1)).to.be.true
      expect(await ledger.oldestLiveEpoch(providerA)).to.equal(1)
    })

    it("stores the wallet record including seat counts", async () => {
      await register(wallet1, [providerA, providerB], [7, 2])

      const record = await ledger.getWalletExposure(wallet1)
      expect(record.stakingProviders).to.deep.equal([providerA, providerB])
      expect(record.epochs.map((e: any) => e.toNumber())).to.deep.equal([1, 1])
      expect(record.seatCounts).to.deep.equal([7, 2])
      expect(record.live).to.be.true
    })

    it("emits WalletExposureRegistered", async () => {
      await expect(register(wallet1, [providerA], [4])).to.emit(
        ledger,
        "WalletExposureRegistered"
      )
    })

    it("rejects mismatched providers/seatCounts arrays", async () => {
      await expectCustomError(
        ledger
          .connect(registrySigner)
          .onWalletRegistered(wallet1, [providerA, providerB], [1]),
        "ArrayLengthMismatch"
      )
    })

    it("rejects registering the same wallet twice", async () => {
      await register(wallet1, [providerA])
      await expectCustomError(
        register(wallet1, [providerB]),
        "WalletAlreadyRegistered"
      )
    })

    it("rejects re-registering a closed wallet", async () => {
      await register(wallet1, [providerA])
      await close(wallet1)
      await expectCustomError(
        register(wallet1, [providerA]),
        "WalletAlreadyRegistered"
      )
    })
  })

  describe("onWalletClosed", () => {
    beforeEach(async () => {
      await register(wallet1, [providerA, providerB]) // A epoch 1, B epoch 1
      await register(wallet2, [providerA]) // A epoch 2
    })

    it("clears epoch liveness and decrements live counts", async () => {
      await close(wallet1)

      expect(await ledger.liveWalletCount(providerA)).to.equal(1)
      expect(await ledger.liveWalletCount(providerB)).to.equal(0)
      expect(await ledger.liveEpochs(providerA, 1)).to.be.false
      expect(await ledger.liveEpochs(providerA, 2)).to.be.true

      const record = await ledger.getWalletExposure(wallet1)
      expect(record.live).to.be.false
    })

    it("advances the oldest live epoch pointer past dead epochs", async () => {
      expect(await ledger.oldestLiveEpoch(providerA)).to.equal(1)
      await close(wallet1)
      expect(await ledger.oldestLiveEpoch(providerA)).to.equal(2)
    })

    it("emits WalletExposureClosed", async () => {
      await expect(close(wallet1))
        .to.emit(ledger, "WalletExposureClosed")
        .withArgs(wallet1)
    })

    it("is idempotent for an already-closed wallet", async () => {
      await close(wallet1)
      // A second close must be a no-op, not a revert (the registry calls
      // this hook from Bridge-driven paths inside try/catch, but a revert
      // would still surface as a CallFailed event).
      await expect(close(wallet1)).to.not.emit(ledger, "WalletExposureClosed")
      expect(await ledger.liveWalletCount(providerA)).to.equal(1)
      expect(await ledger.liveWalletCount(providerB)).to.equal(0)
    })

    it("is a no-op for an unknown wallet", async () => {
      await expect(close(unknownWallet)).to.not.emit(
        ledger,
        "WalletExposureClosed"
      )
      expect(await ledger.liveWalletCount(providerA)).to.equal(2)
    })
  })

  describe("hasLiveExposureAtOrBefore", () => {
    it("returns false for a provider with no exposure", async () => {
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 0)).to.be.false
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 100)).to.be.false
    })

    it("reports live exposure at and after the assigned epoch", async () => {
      await register(wallet1, [providerA]) // epoch 1

      // Epoch 0 predates the exposure: an exit requested before the
      // wallet existed is not blocked by it.
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 0)).to.be.false
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 1)).to.be.true
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 100)).to.be.true
    })

    it("unlocks old epochs when the oldest wallet closes first", async () => {
      await register(wallet1, [providerA]) // epoch 1
      await register(wallet2, [providerA]) // epoch 2

      await close(wallet1)

      // Exit requested at epoch 1 unlocks: the only live wallet has
      // epoch 2 > 1.
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 1)).to.be.false
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 2)).to.be.true
    })

    it("keeps old epochs locked when a newer wallet closes first", async () => {
      await register(wallet1, [providerA]) // epoch 1
      await register(wallet2, [providerA]) // epoch 2

      await close(wallet2)

      // Wallet 1 (epoch 1) is still live so both queries stay locked.
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 1)).to.be.true
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 2)).to.be.true
    })

    it("returns false everywhere once all wallets are closed", async () => {
      await register(wallet1, [providerA])
      await register(wallet2, [providerA])
      await close(wallet1)
      await close(wallet2)

      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 1)).to.be.false
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 2)).to.be.false
      expect(await ledger.liveWalletCount(providerA)).to.equal(0)
    })

    it("tracks the oldest live epoch across multiple closures", async () => {
      const walletIDs = [wallet1, wallet2, wallet3, wallet4, wallet5]
      for (const walletID of walletIDs) {
        await register(walletID, [providerA]) // epochs 1..5
      }

      await close(wallet1)
      await close(wallet2)
      await close(wallet3)

      expect(await ledger.oldestLiveEpoch(providerA)).to.equal(4)
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 3)).to.be.false
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 4)).to.be.true
    })
  })

  describe("bounded lazy walk (fail-safe direction)", () => {
    // Builds a >256-epoch dead range between the stored oldest-live-epoch
    // pointer and the first live epoch, so the bounded view-side walk
    // cannot find the answer and must fall back to "exposure exists"
    // (exits stay locked — never unlocked wrongly).
    //
    // The registry always passes unique providers, but the ledger
    // tolerates duplicates (each occurrence consumes its own epoch),
    // which lets the test mint hundreds of epochs per transaction.
    //
    // Construction: epoch 1 stays live while wallets 4/3/2 (epochs
    // 2..601) close newest-first — the pointer never walks because
    // epoch 1 is live. Closing wallet 1 last kills epoch 1 and triggers
    // a single bounded walk: 1 → 257, stranding the pointer 345 dead
    // epochs away from the only live epoch (602).
    const DUPS = 200

    it("falls back to locked when the walk bound is exhausted, and heals", async function boundedWalk() {
      this.timeout(120_000)

      const manyA = new Array(DUPS).fill(providerA)
      const seats = new Array(DUPS).fill(1)

      await register(wallet1, [providerA]) // epoch 1
      await register(wallet2, manyA, seats) // epochs 2..201
      await register(wallet3, manyA, seats) // epochs 202..401
      await register(wallet4, manyA, seats) // epochs 402..601
      await register(wallet5, [providerA]) // epoch 602

      // Close newest-first; epoch 1 stays live so the pointer holds.
      await close(wallet4)
      await close(wallet3)
      await close(wallet2)
      expect(await ledger.oldestLiveEpoch(providerA)).to.equal(1)

      // Kill epoch 1: the state-side walk advances at most 256 steps
      // (1 → 257) and strands on a dead epoch; epochs 257..601 are all
      // dead, live epoch 602 is out of reach of the 256-step view walk.
      await close(wallet1)
      expect(await ledger.liveWalletCount(providerA)).to.equal(1)
      expect(await ledger.oldestLiveEpoch(providerA)).to.equal(257)
      expect(await ledger.liveEpochs(providerA, 602)).to.be.true

      // The true answer for epoch 400 is "false" (first live epoch is
      // 602), but the view cannot prove it within 256 steps — it must
      // fail safe and report exposure, keeping the exit locked.
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 400)).to.be.true

      // Once the last live wallet closes, the live count short-circuit
      // unlocks correctly regardless of the stale pointer.
      await close(wallet5)
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 602)).to.be.false

      // A new registration while no live exposure remains heals the
      // pointer directly to the fresh epoch.
      await register(unknownWallet, [providerA]) // epoch 603
      expect(await ledger.oldestLiveEpoch(providerA)).to.equal(603)
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 602)).to.be.false
      expect(await ledger.hasLiveExposureAtOrBefore(providerA, 603)).to.be.true
    })
  })
})
