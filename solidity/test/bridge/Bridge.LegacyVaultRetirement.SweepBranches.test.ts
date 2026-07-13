/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai"
import { ethers } from "hardhat"
import type { Contract, Signer } from "ethers"

// ---------------------------------------------------------------------------
// Headless proofs of the two B2 legacy-retirement danger branches.
//
// These reproduce, WITHOUT a mainnet fork, the exact sweep-routing mechanics
// whose interaction caused B2. They drive the REAL `Bank` sweep routing and the
// REAL `TBTC` (owner-gated `mint`) token, through a faithful TBTCVault-style
// callback mock (`MockLegacyMintingVault`) and a router that mirrors
// `DepositSweep.submitDepositSweepProof`'s trusted/untrusted branch selection
// (`MockSweepRouter`). They are the executed substance of the two bad-branch
// cases the mainnet-fork suite documents but cannot run on the supplied endpoint.
//
//   Branch 1 — callback-brick: a still-trusted legacy vault that no longer owns
//   TBTC makes the sweep callback's `mint` revert, reverting the whole proof tx
//   (funds are not swept). This is why the legacy vault must be UNTRUSTED, not
//   left trusted, at cutover.
//
//   Branch 2 — untrusted double-mint: an untrusted vault path routes the sweep
//   through `Bank.increaseBalances` with NO vault callback, so optimistic-minting
//   debt is never repaid while the depositor still holds the optimistic mint and
//   now also gains a fresh, mintable Bank balance. This is why an UNSWEPT
//   finalized optimistic mint must not exist (the empty-`P` invariant) before the
//   legacy vault is untrusted.
// ---------------------------------------------------------------------------

describe("Bridge - legacy vault retirement sweep-routing branches (headless)", () => {
  // Sweep amount, in the mock's Bank-balance units. The fixed 1e10 satoshi
  // scaling of the production path is irrelevant to the branch logic.
  const AMOUNT = 1_000_000

  async function deployFixture(): Promise<{
    bank: Contract
    tbtc: Contract
    router: Contract
    vault: Contract
    deployer: Signer
    depositor: Signer
    successor: Signer
  }> {
    const [deployer, depositor, successor] = await ethers.getSigners()

    const bank = await (await ethers.getContractFactory("Bank")).deploy()
    const tbtc = await (await ethers.getContractFactory("TBTC")).deploy()
    const router = await (
      await ethers.getContractFactory("MockSweepRouter")
    ).deploy(bank.address)
    const vault = await (
      await ethers.getContractFactory("MockLegacyMintingVault")
    ).deploy(bank.address, tbtc.address)

    // The Bank's sole authorized caller is the router (its "bridge"), so the
    // router's `route` is the only way sweep proceeds reach a depositor.
    await bank.updateBridge(router.address)

    // The TBTC token owner starts as the deployer; individual tests move it to
    // the vault (so the vault can mint on a trusted sweep) after any setup that
    // needs the deployer to still own the token.
    return { bank, tbtc, router, vault, deployer, depositor, successor }
  }

  it("callback-brick: a still-trusted legacy vault that no longer owns TBTC reverts the sweep", async () => {
    const { bank, tbtc, router, vault, depositor, successor } =
      await deployFixture()
    const depositorAddr = await depositor.getAddress()
    const successorAddr = await successor.getAddress()

    // Healthy state: the vault owns the token and is trusted, so a sweep routed
    // to it mints TBTC to the depositor and credits the vault's Bank balance.
    await tbtc.transferOwnership(vault.address)
    await router.setVaultTrusted(vault.address, true)
    await router.route(vault.address, [depositorAddr], [AMOUNT])
    expect(await tbtc.balanceOf(depositorAddr)).to.equal(AMOUNT)
    expect(await bank.balanceOf(vault.address)).to.equal(AMOUNT)

    // The legacy `finalizeUpgrade` moves TBTC ownership to the successor, but the
    // vault is LEFT TRUSTED (the mistake the remediation prevents by untrusting).
    await vault.transferTokenOwnership(successorAddr)
    expect(await tbtc.owner()).to.equal(successorAddr)

    // A subsequent trusted-vault sweep now reverts inside the callback's
    // owner-gated `mint`, reverting the whole proof tx. Funds are NOT swept:
    // neither the depositor nor the vault gains any new balance.
    await expect(router.route(vault.address, [depositorAddr], [AMOUNT])).to.be
      .reverted
    expect(await bank.balanceOf(depositorAddr)).to.equal(0)
    expect(await bank.balanceOf(vault.address)).to.equal(AMOUNT)
    expect(await tbtc.balanceOf(depositorAddr)).to.equal(AMOUNT)
  })

  it("untrusted double-mint: the untrusted-vault path credits Bank balance without repaying optimistic debt", async () => {
    const { bank, tbtc, vault, router, deployer, depositor } =
      await deployFixture()
    const depositorAddr = await depositor.getAddress()

    // The depositor already received a finalized optimistic mint of AMOUNT TBTC
    // (minted while the deployer still owned the token) and it is not yet swept,
    // so the vault carries the outstanding optimistic-minting debt.
    await tbtc.connect(deployer).mint(depositorAddr, AMOUNT)
    await tbtc.transferOwnership(vault.address)
    await vault.setOptimisticMintingDebt(depositorAddr, AMOUNT)

    // The legacy vault is UNTRUSTED. Sweeping the still-unswept finalized deposit
    // routes through `Bank.increaseBalances` with no vault callback.
    expect(await router.isVaultTrusted(vault.address)).to.equal(false)
    await router.route(vault.address, [depositorAddr], [AMOUNT])

    // Double realization: the depositor still holds the optimistically-minted
    // TBTC, the optimistic-minting debt was NEVER repaid (no callback ran), and
    // the depositor now additionally holds a fresh, mintable Bank balance.
    expect(await tbtc.balanceOf(depositorAddr)).to.equal(AMOUNT)
    expect(await vault.optimisticMintingDebt(depositorAddr)).to.equal(AMOUNT)
    expect(await bank.balanceOf(depositorAddr)).to.equal(AMOUNT)
  })

  it("contrast: the trusted-vault path repays the optimistic debt instead of duplicating value", async () => {
    const { bank, tbtc, vault, router, deployer, depositor } =
      await deployFixture()
    const depositorAddr = await depositor.getAddress()

    // Same starting position as the double-mint case: an unswept finalized
    // optimistic mint the depositor already holds.
    await tbtc.connect(deployer).mint(depositorAddr, AMOUNT)
    await tbtc.transferOwnership(vault.address)
    await vault.setOptimisticMintingDebt(depositorAddr, AMOUNT)

    // With the vault TRUSTED, the sweep takes the callback path: the callback
    // repays the optimistic debt from the sweep proceeds. No fresh depositor Bank
    // balance and no second mint — the sweep value accrues to the vault instead.
    await router.setVaultTrusted(vault.address, true)
    await router.route(vault.address, [depositorAddr], [AMOUNT])

    expect(await vault.optimisticMintingDebt(depositorAddr)).to.equal(0)
    expect(await bank.balanceOf(depositorAddr)).to.equal(0)
    expect(await bank.balanceOf(vault.address)).to.equal(AMOUNT)
    // The depositor's token balance is unchanged: no second mint occurred.
    expect(await tbtc.balanceOf(depositorAddr)).to.equal(AMOUNT)
  })
})
