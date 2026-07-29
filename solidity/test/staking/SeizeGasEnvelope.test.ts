/* eslint-disable no-await-in-loop */
import { randomBytes } from "crypto"
import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { Contract } from "ethers"
import { to1e18 } from "../helpers/contract-test-helpers"

const GOVERNANCE_DELAY = 604_800 // 7 days

const OperatorStatus = { None: 0, Active: 1, Deactivating: 2, Ejected: 3 }

// The hard upper bound the slashing module truncates report input to; the
// never-revert seize path must survive at this size without reverting.
const MAX_REPORT_SEATS = 112

const PER_SEAT = to1e18(500)
const DELEGATION_PER_PROVIDER = to1e18(1000)

// Worst-case gas ceiling for the whole never-revert seize path
// (SeatAllocator.reportMaliciousBehavior -> SlashingModule.report ->
// StakeVault.applySlash) driven at MAX_REPORT_SEATS DISTINCT providers, each
// with stake so the atomic haircut does real work. Measured worst case is
// ~16.29M gas; the 17M ceiling is a tight regression guard that still stays
// comfortably under the 30M block gas limit so a Bridge seize call remains
// feasible. This is a strict envelope: a real FROST wallet has at most 100
// seats aggregating to far fewer unique operators (<=35 per the design), so a
// production seize is well below this.
const GAS_BUDGET = 17_000_000

describe("Seize gas envelope (never-revert report path)", () => {
  let deployer: SignerWithAddress
  let delegator: SignerWithAddress
  let notifier: SignerWithAddress
  // Stands in for the FROST wallet registry: the only caller allowed to
  // drive reportMaliciousBehavior on the allocator.
  let registry: SignerWithAddress

  let vault: Contract
  let slashingModule: Contract
  let seatAllocator: Contract

  const providers: string[] = []

  before(async function setup() {
    this.timeout(300_000)
    ;[deployer, delegator, notifier, registry] = await ethers.getSigners()

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

    // Fund the delegator and stake into 112 distinct provider pools so
    // every applySlash in the report loop haircuts real delegated assets.
    const totalStake = DELEGATION_PER_PROVIDER.mul(MAX_REPORT_SEATS)
    await tToken.connect(deployer).mint(delegator.address, totalStake)
    await tToken.connect(delegator).approve(vault.address, totalStake)

    for (let i = 0; i < MAX_REPORT_SEATS; i++) {
      const provider = ethers.Wallet.createRandom().address
      providers.push(provider)
      await signerRegistry.setOperatorStatus(provider, OperatorStatus.Active)
      await vault.connect(delegator).delegate(provider, DELEGATION_PER_PROVIDER)
    }
  })

  it("processes MAX_REPORT_SEATS distinct providers under the gas budget without reverting", async () => {
    const tx = await seatAllocator
      .connect(registry)
      .reportMaliciousBehavior(PER_SEAT, 100, notifier.address, providers)
    const receipt = await tx.wait()

    // The never-revert path completed and booked every unique provider (the
    // report was NOT swallowed by the allocator's try/catch).
    expect(await slashingModule.pendingSlashesLength()).to.equal(
      MAX_REPORT_SEATS
    )
    expect(await slashingModule.pendingSlashCount(providers[0])).to.equal(1)
    // Atomic haircut landed: 500 T taken from each 1000 T delegated pool.
    expect(await vault.delegatedAssetsOf(providers[0])).to.equal(to1e18(500))
    expect(await vault.seizedBalance()).to.equal(PER_SEAT.mul(MAX_REPORT_SEATS))
    // Weight-dirty marker set for each reported provider.
    expect(await seatAllocator.weightDirty(providers[0])).to.be.true

    // eslint-disable-next-line no-console
    console.log(
      `      worst-case seize gas (${MAX_REPORT_SEATS} unique providers): ` +
        `${receipt.gasUsed.toString()}`
    )
    expect(receipt.gasUsed).to.be.lt(GAS_BUDGET)
  })
})
