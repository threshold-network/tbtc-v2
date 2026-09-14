import { expect } from "chai"
import { ethers } from "hardhat"
import { BigNumber, Wallet } from "ethers"
import type { Contract } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"

describe("ReimbursementPool", () => {
  let owner: SignerWithAddress
  let caller: SignerWithAddress
  let receiver: Wallet
  let pool: Contract
  let harness: Contract

  const staticGas = 1
  // Large enough that tx.gasprice is never capped by maxGasPrice, so the
  // refund reflects actual gas spent rather than the cap.
  const maxGasPrice = BigNumber.from("1000000000000")
  const fundAmount = ethers.utils.parseEther("1")

  beforeEach(async () => {
    ;[owner, caller] = await ethers.getSigners()
    // A freshly generated address, never one of the fixed hardhat test
    // accounts: under a mainnet fork those well-known addresses can alias a
    // real deployed contract that forwards incoming ETH onward, which would
    // make a balance-delta assertion on it meaningless.
    receiver = ethers.Wallet.createRandom()

    pool = await (
      await ethers.getContractFactory("ReimbursementPool")
    ).deploy(staticGas, maxGasPrice)
    await pool.deployed()

    harness = await (
      await ethers.getContractFactory("ReimbursementTest")
    ).deploy()
    await harness.deployed()

    await harness.updateReimbursementPool(pool.address)

    await owner.sendTransaction({ to: pool.address, value: fundAmount })
  })

  it("refunds ETH to the receiver out of the pool when authorized", async () => {
    await pool.connect(owner).authorize(harness.address)

    const receiverBalanceBefore = await ethers.provider.getBalance(
      receiver.address
    )
    const poolBalanceBefore = await ethers.provider.getBalance(pool.address)

    // `caller` submits the tx so `receiver`'s balance only changes due to
    // the refund, never due to its own gas cost.
    await harness.connect(caller).run(receiver.address)

    const receiverBalanceAfter = await ethers.provider.getBalance(
      receiver.address
    )
    const poolBalanceAfter = await ethers.provider.getBalance(pool.address)

    const refunded = receiverBalanceAfter.sub(receiverBalanceBefore)

    expect(refunded).to.be.gt(0)
    expect(poolBalanceBefore.sub(poolBalanceAfter)).to.equal(refunded)
  })

  it("reverts the refund when the caller contract is not authorized", async () => {
    await expect(
      harness.connect(caller).run(receiver.address)
    ).to.be.revertedWith("Contract is not authorized for a refund")
  })
})
