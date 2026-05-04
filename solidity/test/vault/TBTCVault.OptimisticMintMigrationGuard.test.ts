import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ethers } from "hardhat"

import type {
  Bank,
  MockTBTCBridgeWithSweep,
  TBTC,
  TBTCVaultHarness,
} from "../../typechain"

const MIGRATION_TAG = "AC_MIGRATEV1"

const encodeMigrationExtraData = (revealer: string): string =>
  ethers.utils.hexConcat([
    ethers.utils.hexlify(ethers.utils.toUtf8Bytes(MIGRATION_TAG)),
    ethers.utils.hexZeroPad(revealer, 20),
  ])

const fundingTxHash = (tx: {
  version: string
  inputVector: string
  outputVector: string
  locktime: string
}): string =>
  ethers.utils.sha256(
    ethers.utils.sha256(
      `0x${tx.version.substring(2)}` +
        `${tx.inputVector.substring(2)}` +
        `${tx.outputVector.substring(2)}` +
        `${tx.locktime.substring(2)}`
    )
  )

describe("TBTCVault - Optimistic Minting migration guard", () => {
  let deployer: SignerWithAddress
  let minter: SignerWithAddress
  let revealer: SignerWithAddress

  let bank: Bank
  let bridge: MockTBTCBridgeWithSweep
  let tbtc: TBTC
  let vault: TBTCVaultHarness

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[deployer, minter, revealer] = await ethers.getSigners()

    const BankFactory = await ethers.getContractFactory("Bank")
    bank = await BankFactory.deploy()

    const BridgeFactory = await ethers.getContractFactory(
      "MockTBTCBridgeWithSweep"
    )
    bridge = await BridgeFactory.deploy()

    const TBTCFactory = await ethers.getContractFactory("TBTC")
    tbtc = await TBTCFactory.deploy()

    const VaultFactory = await ethers.getContractFactory("TBTCVaultHarness")
    vault = await VaultFactory.deploy(
      bank.address,
      tbtc.address,
      bridge.address
    )

    await vault.addMinter(minter.address)
  })

  it("reverts optimistic mint requests for migration-tagged deposits", async () => {
    const fundingTx = {
      version: "0x01000000",
      inputVector:
        "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20dc2b952f0100000000ffffffff",
      outputVector:
        "0x021027000000000000220020bfaeddba12b0de6feeb649af76376876bc1feb6c2248fbfef9293ba3ac51bb4a10d73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    }
    const reveal = {
      fundingOutputIndex: 0,
      blindingFactor: "0xf9f0c90d00039523",
      walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
      refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
      refundLocktime: "0x60bcea61",
      vault: vault.address,
    }

    const depositKey = await vault.calculateDepositKey(
      fundingTxHash(fundingTx),
      reveal.fundingOutputIndex
    )
    await bridge.setNextDepositKey(depositKey)

    await bridge
      .connect(revealer)
      .revealDepositWithExtraData(
        fundingTx,
        reveal,
        encodeMigrationExtraData(revealer.address)
      )

    await expect(
      vault
        .connect(minter)
        .requestOptimisticMint(
          fundingTxHash(fundingTx),
          reveal.fundingOutputIndex
        )
    ).to.be.revertedWith("Migration deposits can not use optimistic minting")
  })

  it("reverts optimistic mint finalization for migration-tagged deposits", async () => {
    const fundingTx = {
      version: "0x01000000",
      inputVector:
        "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20dc2b952f0100000000ffffffff",
      outputVector:
        "0x021027000000000000220020bfaeddba12b0de6feeb649af76376876bc1feb6c2248fbfef9293ba3ac51bb4a10d73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    }
    const reveal = {
      fundingOutputIndex: 0,
      blindingFactor: "0xf9f0c90d00039523",
      walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
      refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
      refundLocktime: "0x60bcea61",
      vault: vault.address,
    }

    const txHash = fundingTxHash(fundingTx)
    const depositKey = await vault.calculateDepositKey(
      txHash,
      reveal.fundingOutputIndex
    )
    await bridge.setNextDepositKey(depositKey)

    await bridge
      .connect(revealer)
      .revealDepositWithExtraData(
        fundingTx,
        reveal,
        encodeMigrationExtraData(revealer.address)
      )

    const { timestamp } = await ethers.provider.getBlock("latest")
    await vault.setOptimisticMintingRequestForTest(
      txHash,
      reveal.fundingOutputIndex,
      timestamp - 4 * 60 * 60,
      0
    )

    await expect(
      vault
        .connect(minter)
        .finalizeOptimisticMint(txHash, reveal.fundingOutputIndex)
    ).to.be.revertedWith("Migration deposits can not use optimistic minting")
  })
})
