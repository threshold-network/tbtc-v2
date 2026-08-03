/* eslint-disable no-await-in-loop */
import { randomBytes } from "crypto"
import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { Contract } from "ethers"
import { to1e18 } from "../helpers/contract-test-helpers"

const { increaseTime } = helpers.time

const GOVERNANCE_DELAY = 604_800 // 7 days

const OperatorStatus = { None: 0, Active: 1, Deactivating: 2, Ejected: 3 }

// The hard upper bound the slashing module truncates report input to; the
// never-revert seize path must survive at this size without reverting.
const MAX_REPORT_SEATS = 100
const FULL_REPORT_UNIQUE_PROVIDERS = 35

const PER_SEAT = to1e18(500)
const DELEGATION_PER_PROVIDER = to1e18(2000)

// Worst-case gas ceiling for the whole never-revert seize path
// (SeatAllocator.reportMaliciousBehavior -> SlashingModule.report ->
// StakeVault.applySlash). The full-accounting case drives 35 funded providers;
// the queued-fallback case separately covers the protocol maximum of 100
// unique providers, whose unconditional allocator bookkeeping must fit this
// envelope even when the downstream report runs out of gas.
const GAS_BUDGET = 8_000_000

describe("Seize gas envelope (never-revert report path)", () => {
  let deployer: SignerWithAddress
  let delegator: SignerWithAddress
  let notifier: SignerWithAddress
  // Stands in for the FROST wallet registry: the only caller allowed to
  // drive reportMaliciousBehavior on the allocator.
  let registry: Contract

  let vault: Contract
  let slashingModule: Contract
  let seatAllocator: Contract

  const providers: string[] = []

  before(async function setup() {
    this.timeout(300_000)
    ;[deployer, delegator, notifier] = await ethers.getSigners()

    const tToken = await (await ethers.getContractFactory("TestERC20"))
      .connect(deployer)
      .deploy()
    const tbtcToken = await (await ethers.getContractFactory("MockTBTCToken"))
      .connect(deployer)
      .deploy()
    const signerRegistry = await (
      await ethers.getContractFactory("StakingMockSignerRegistry")
    )
      .connect(deployer)
      .deploy()
    const ledger = await (await ethers.getContractFactory("MockLedger"))
      .connect(deployer)
      .deploy()
    const distributor = await (
      await ethers.getContractFactory("StakingMockRewardsDistributor")
    )
      .connect(deployer)
      .deploy()
    registry = await (
      await ethers.getContractFactory("StakingMockWalletRegistry")
    )
      .connect(deployer)
      .deploy()

    const suffix = randomBytes(8).toString("hex")

    const [vaultInstance] = await helpers.upgrades.deployProxy(
      `SeizeGasVault_${suffix}`,
      {
        contractName: "StakeVault",
        initializerArgs: [tToken.address, tbtcToken.address, GOVERNANCE_DELAY],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    vault = vaultInstance

    const [slashingInstance] = await helpers.upgrades.deployProxy(
      `SeizeGasSlashing_${suffix}`,
      {
        contractName: "SlashingModule",
        initializerArgs: [vault.address, GOVERNANCE_DELAY],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    slashingModule = slashingInstance

    const [allocatorInstance] = await helpers.upgrades.deployProxy(
      `SeizeGasAllocator_${suffix}`,
      {
        contractName: "SeatAllocator",
        initializerArgs: [
          registry.address, // frost wallet registry (the report caller)
          signerRegistry.address,
          vault.address,
          slashingModule.address,
          ledger.address,
          distributor.address,
          GOVERNANCE_DELAY,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: { kind: "transparent" },
      }
    )
    seatAllocator = allocatorInstance

    await vault.connect(deployer).setSignerRegistry(signerRegistry.address)
    await vault.connect(deployer).setSeatAllocator(seatAllocator.address)
    await vault.connect(deployer).setSlashingModule(slashingModule.address)
    await vault.connect(deployer).setRewardsDistributor(distributor.address)
    await vault.connect(deployer).setWalletExposureLedger(ledger.address)
    await slashingModule
      .connect(deployer)
      .setSeatAllocator(seatAllocator.address)
    await vault.connect(deployer).beginDelegationUpdate(true)
    await slashingModule.connect(deployer).beginEconomicSlashingUpdate(true)
    await increaseTime(GOVERNANCE_DELAY)
    await vault.connect(deployer).finalizeDelegationUpdate()
    await slashingModule.connect(deployer).finalizeEconomicSlashingUpdate()

    // Fund 35 distinct provider pools for the full downstream accounting
    // path. Fill all 100 report seats by cycling those providers.
    const totalStake = DELEGATION_PER_PROVIDER.mul(FULL_REPORT_UNIQUE_PROVIDERS)
    await tToken.connect(deployer).mint(delegator.address, totalStake)
    await tToken.connect(delegator).approve(vault.address, totalStake)

    for (let i = 0; i < FULL_REPORT_UNIQUE_PROVIDERS; i++) {
      const provider = ethers.Wallet.createRandom().address
      providers.push(provider)
      await signerRegistry.setOperatorStatus(provider, OperatorStatus.Active)
      await vault.connect(delegator).delegate(provider, DELEGATION_PER_PROVIDER)
    }
    const uniqueProviders = [...providers]
    for (let i = FULL_REPORT_UNIQUE_PROVIDERS; i < MAX_REPORT_SEATS; i++) {
      providers.push(uniqueProviders[i % FULL_REPORT_UNIQUE_PROVIDERS])
    }
  })

  it("processes all report seats across 35 funded providers under budget", async () => {
    const tx = await registry.callReportMaliciousBehavior(
      seatAllocator.address,
      PER_SEAT,
      100,
      notifier.address,
      providers,
      // A best-effort try/catch deliberately makes both the full accounting
      // path and the queued fallback successful transactions. Gas estimation
      // therefore targets the cheaper fallback; provide the block envelope
      // explicitly so this test measures the intended full path.
      { gasLimit: 16_777_000 }
    )
    const receipt = await tx.wait()

    // The never-revert path completed and booked every unique provider (the
    // report was NOT swallowed by the allocator's try/catch).
    expect(await slashingModule.pendingSlashesLength()).to.equal(
      FULL_REPORT_UNIQUE_PROVIDERS
    )
    expect(await slashingModule.pendingSlashCount(providers[0])).to.equal(1)
    // Provider 0 owns three seats: 1500 T is taken from its 2000 T pool.
    expect(await vault.delegatedAssetsOf(providers[0])).to.equal(to1e18(500))
    expect(await vault.seizedBalance()).to.equal(PER_SEAT.mul(MAX_REPORT_SEATS))
    // Weight-dirty marker set for each reported provider.
    expect(await seatAllocator.weightDirty(providers[0])).to.be.true

    // eslint-disable-next-line no-console
    console.log(
      `      worst-case seize gas (${MAX_REPORT_SEATS} seats, ` +
        `${FULL_REPORT_UNIQUE_PROVIDERS} unique providers): ` +
        `${receipt.gasUsed.toString()}`
    )
    expect(receipt.gasUsed).to.be.lt(GAS_BUDGET)
  })

  it("keeps the 100-unique-provider queued fallback under budget", async () => {
    const gasStarvedProviders = Array.from(
      { length: MAX_REPORT_SEATS },
      () => ethers.Wallet.createRandom().address
    )
    const reportId = await seatAllocator.nextFailedSlashReportId()

    const tx = await registry.callReportMaliciousBehavior(
      seatAllocator.address,
      PER_SEAT,
      100,
      notifier.address,
      gasStarvedProviders,
      { gasLimit: GAS_BUDGET }
    )
    await expect(tx)
      .to.emit(seatAllocator, "SlashReportQueued")
      .withArgs(reportId)
    const receipt = await tx.wait()

    // The downstream call consumed its allowance and reverted atomically, but
    // the allocator wrote its exit holds before forwarding gas.
    expect(await slashingModule.pendingSlashesLength()).to.equal(
      FULL_REPORT_UNIQUE_PROVIDERS
    )
    expect(
      await seatAllocator.queuedSlashCount(gasStarvedProviders[0])
    ).to.equal(1)
    expect(await seatAllocator.failedSlashReportHash(reportId)).not.to.equal(
      ethers.constants.HashZero
    )
    expect(receipt.gasUsed).to.be.lt(GAS_BUDGET)
  })
})
