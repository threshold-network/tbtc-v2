/* eslint-disable no-underscore-dangle */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, Contract, ContractTransaction } from "ethers"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import { Deployment } from "hardhat-deploy/types"
import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  IRelay,
  IVault,
  BridgeGovernance,
  RebateStaking,
} from "../../typechain"
import type {
  DepositRevealInfoStruct,
  InfoStruct as BitcoinTxInfoStruct,
} from "../../typechain/Bridge"
import bridgeFixture from "../fixtures/bridge"
import { constants, walletState } from "../fixtures"
import {
  DepositSweepTestData,
  MultipleDepositsNoMainUtxo,
  MultipleDepositsWithMainUtxo,
  NO_MAIN_UTXO,
  SingleMainUtxo,
  SingleMainUtxoP2SHOutput,
  SingleP2SHDeposit,
  SingleP2WSHDeposit,
} from "../data/deposit-sweep"
import { to1e18 } from "../helpers/contract-test-helpers"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time
const { impersonateAccount } = helpers.account

const ZERO_ADDRESS = ethers.constants.AddressZero

describe("Bridge - Deposit", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let treasury: SignerWithAddress

  let bank: Bank & BankStub
  let relay: FakeContract<IRelay>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let t: Contract
  let rebateStaking: RebateStaking
  let deployBridge: (
    txProofDifficultyFactor: number
  ) => Promise<[Contract, Deployment]>

  let deployer: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      spvMaintainer,
      treasury,
      bank,
      relay,
      bridge,
      bridgeGovernance,
      t,
      rebateStaking,
      deployBridge,
    } = await waffle.loadFixture(bridgeFixture))

    // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
    // the initial value in the Bridge in order to save test Bitcoins.
    // Scaling down deposit TX max fee as well.
    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(2000)
    // Disable the reveal ahead period since refund locktimes are fixed
    // within transactions used in this test suite.
    await bridge.setDepositRevealAheadPeriod(0)

    await bridgeGovernance
      .connect(governance)
      .setRebateStaking(rebateStaking.address)
  })

  type RevealDepositFixture = {
    P2SHFundingTx: BitcoinTxInfoStruct
    P2WSHFundingTx: BitcoinTxInfoStruct
    depositorAddress: string
    reveal: DepositRevealInfoStruct
    extraData?: string
  }

  // Fixture used for revealDeposit test scenario.
  const revealDepositFixture: RevealDepositFixture = {
    // Data of a proper P2SH deposit funding transaction. Little-endian hash is:
    // 0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2
    P2SHFundingTx: {
      version: "0x01000000",
      inputVector:
        "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
        "c2b952f0100000000ffffffff",
      outputVector:
        "0x02102700000000000017a9142c1444d23936c57bdd8b3e67e5938a5440c" +
        "da455877ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2" +
        "140d2726",
      locktime: "0x00000000",
    },
    // Data of a proper P2WSH deposit funding transaction. Little-endian hash is:
    // 0x6a81de17ce3da1eadc833c5fd9d85dac307d3b78235f57afbcd9f068fc01b99e.
    P2WSHFundingTx: {
      version: "0x01000000",
      inputVector:
        "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
        "c2b952f0100000000ffffffff",
      outputVector:
        "0x021027000000000000220020df74a2e385542c87acfafa564ea4bc4fc4e" +
        "b87d2b6a37d6c3b64722be83c636f10d73b00000000001600147ac2d9378a" +
        "1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    },
    // Data matching the redeem script locking the funding output of
    // P2SHFundingTx and P2WSHFundingTx.
    depositorAddress: "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
    reveal: {
      fundingOutputIndex: 0,
      blindingFactor: "0xf9f0c90d00039523",
      // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
      walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
      // HASH160 of 0300d6f28a2f6bf9836f57fcda5d284c9a8f849316119779f0d6090830d97763a9.
      refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
      refundLocktime: "0x60bcea61",
      vault: "0x594cfd89700040163727828AE20B52099C58F02C",
    },
  }

  // Fixture used for revealDepositWithExtraData test scenario.
  const revealDepositWithExtraDataFixture: RevealDepositFixture = {
    // Data of a proper P2SH deposit funding transaction embedding some
    // extra data. Little-endian hash is:
    // 0x6383cd1829260b6034cd12bad36171748e8c3c6a8d57fcb6463c62f96116dfbc.
    P2SHFundingTx: {
      version: "0x01000000",
      inputVector:
        "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
        "c2b952f0100000000ffffffff",
      outputVector:
        "0x02102700000000000017a9149fe6615a307aa1d7eee668c1227802b2fbc" +
        "aa919877ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2" +
        "140d2726",
      locktime: "0x00000000",
    },
    // Data of a proper P2WSH deposit funding transaction embedding some
    // extra data. Little-endian hash is:
    // 0xc9312103d0d8d55344ef2d51acc409e004fbaaba7893b1725fa505ff73795732.
    P2WSHFundingTx: {
      version: "0x01000000",
      inputVector:
        "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
        "c2b952f0100000000ffffffff",
      outputVector:
        "0x021027000000000000220020bfaeddba12b0de6feeb649af76376876bc1" +
        "feb6c2248fbfef9293ba3ac51bb4a10d73b00000000001600147ac2d9378a" +
        "1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    },
    // Data matching the redeem script locking the funding output of
    // P2SHFundingTx and P2WSHFundingTx.
    depositorAddress: "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
    reveal: {
      fundingOutputIndex: 0,
      blindingFactor: "0xf9f0c90d00039523",
      // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
      walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
      // HASH160 of 0300d6f28a2f6bf9836f57fcda5d284c9a8f849316119779f0d6090830d97763a9.
      refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
      refundLocktime: "0x60bcea61",
      vault: "0x594cfd89700040163727828AE20B52099C58F02C",
    },
    // sha256("fancy extra data")
    extraData:
      "0xa9b38ea6435c8941d6eda6a46b68e3e2117196995bd154ab55196396b03d9bda",
  }

  describe("revealDeposit", () => {
    const { P2SHFundingTx, P2WSHFundingTx, depositorAddress, reveal } =
      revealDepositFixture

    let depositor: SignerWithAddress

    before(async () => {
      depositor = await impersonateAccount(depositorAddress, {
        from: governance,
        value: 10,
      })
    })

    context("when wallet is in Live state", () => {
      before(async () => {
        await createSnapshot()

        await bridgeGovernance
          .connect(governance)
          .setVaultStatus(reveal.vault, true)

        // Simulate the wallet is a Live one and is known in the system.
        await bridge.setWallet(reveal.walletPubKeyHash, {
          ecdsaWalletID: ethers.constants.HashZero,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.Live,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when reveal ahead period validation is disabled", () => {
        context("when funding transaction is P2SH", () => {
          context("when funding output script hash is correct", () => {
            context("when deposit was not revealed yet", () => {
              context("when amount is not below the dust threshold", () => {
                context("when deposit is routed to a trusted vault", () => {
                  context(
                    "when nothing staked in rebate staking contract",
                    () => {
                      let tx: ContractTransaction

                      before(async () => {
                        await createSnapshot()
                        tx = await bridge
                          .connect(depositor)
                          .revealDeposit(P2SHFundingTx, reveal)
                      })

                      after(async () => {
                        await restoreSnapshot()
                      })

                      it("should store proper deposit data", async () => {
                        // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                        const depositKey = ethers.utils.solidityKeccak256(
                          ["bytes32", "uint32"],
                          [
                            "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                            reveal.fundingOutputIndex,
                          ]
                        )

                        const deposit = await bridge.deposits(depositKey)

                        // Depositor address, same as in `reveal.depositor`.
                        expect(deposit.depositor).to.be.equal(
                          "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637"
                        )
                        // Deposit amount in satoshi. In this case it's 10000 satoshi
                        // because the P2SH deposit transaction set this value for the
                        // funding output.
                        expect(deposit.amount).to.be.equal(10000)
                        // Revealed time should be set.
                        expect(deposit.revealedAt).to.be.equal(
                          await lastBlockTime()
                        )
                        // Deposit vault, same as in `reveal.vault`.
                        expect(deposit.vault).to.be.equal(
                          "0x594cfd89700040163727828AE20B52099C58F02C"
                        )
                        // Treasury fee should be computed according to the current
                        // value of the `depositTreasuryFeeDivisor`.
                        expect(deposit.treasuryFee).to.be.equal(5)
                        // Swept time should be unset.
                        expect(deposit.sweptAt).to.be.equal(0)
                        // Extra data must not be set.
                        expect(deposit.extraData).to.be.equal(
                          ethers.constants.HashZero
                        )
                      })

                      it("should emit DepositRevealed event", async () => {
                        await expect(tx)
                          .to.emit(bridge, "DepositRevealed")
                          .withArgs(
                            "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                            reveal.fundingOutputIndex,
                            "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                            10000,
                            "0xf9f0c90d00039523",
                            "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                            "0x28e081f285138ccbe389c1eb8985716230129f89",
                            "0x60bcea61",
                            reveal.vault
                          )
                      })
                    }
                  )
                  context(
                    "when depositor has stake in rebate staking contract",
                    () => {
                      let tx: ContractTransaction

                      const stakeAmount = to1e18(5)
                      let availableRebate: number

                      before(async () => {
                        await createSnapshot()

                        await t
                          .connect(deployer)
                          .mint(depositor.address, stakeAmount)
                        await t
                          .connect(depositor)
                          .approve(rebateStaking.address, stakeAmount)
                        await rebateStaking
                          .connect(depositor)
                          .stake(stakeAmount)
                        availableRebate = (
                          await rebateStaking.getAvailableRebate(
                            depositor.address
                          )
                        ).toNumber()

                        tx = await bridge
                          .connect(depositor)
                          .revealDeposit(P2SHFundingTx, reveal)
                      })

                      after(async () => {
                        await restoreSnapshot()
                      })

                      it("should store proper deposit data", async () => {
                        // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                        const depositKey = ethers.utils.solidityKeccak256(
                          ["bytes32", "uint32"],
                          [
                            "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                            reveal.fundingOutputIndex,
                          ]
                        )

                        const deposit = await bridge.deposits(depositKey)

                        // Depositor address, same as in `reveal.depositor`.
                        expect(deposit.depositor).to.be.equal(
                          "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637"
                        )
                        // Deposit amount in satoshi. In this case it's 10000 satoshi
                        // because the P2SH deposit transaction set this value for the
                        // funding output.
                        expect(deposit.amount).to.be.equal(10000)
                        // Revealed time should be set.
                        expect(deposit.revealedAt).to.be.equal(
                          await lastBlockTime()
                        )
                        // Deposit vault, same as in `reveal.vault`.
                        expect(deposit.vault).to.be.equal(
                          "0x594cfd89700040163727828AE20B52099C58F02C"
                        )
                        // Treasury fee should be computed according to the current
                        // value of the `depositTreasuryFeeDivisor`.
                        expect(deposit.treasuryFee).to.be.equal(0)
                        // Swept time should be unset.
                        expect(deposit.sweptAt).to.be.equal(0)
                        // Extra data must not be set.
                        expect(deposit.extraData).to.be.equal(
                          ethers.constants.HashZero
                        )
                      })

                      it("should emit DepositRevealed event", async () => {
                        await expect(tx)
                          .to.emit(bridge, "DepositRevealed")
                          .withArgs(
                            "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                            reveal.fundingOutputIndex,
                            "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                            10000,
                            "0xf9f0c90d00039523",
                            "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                            "0x28e081f285138ccbe389c1eb8985716230129f89",
                            "0x60bcea61",
                            reveal.vault
                          )
                      })

                      it("should decrease available rebate", async () => {
                        expect(
                          (
                            await rebateStaking.getAvailableRebate(
                              depositor.address
                            )
                          ).toNumber()
                        ).to.be.lessThan(availableRebate)
                      })
                    }
                  )
                })

                context("when deposit is not routed to a vault", () => {
                  let tx: ContractTransaction
                  let nonRoutedReveal: DepositRevealInfoStruct

                  before(async () => {
                    await createSnapshot()

                    nonRoutedReveal = { ...reveal }
                    nonRoutedReveal.vault = ZERO_ADDRESS
                    tx = await bridge
                      .connect(depositor)
                      .revealDeposit(P2SHFundingTx, nonRoutedReveal)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should accept the deposit", async () => {
                    await expect(tx)
                      .to.emit(bridge, "DepositRevealed")
                      .withArgs(
                        "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                        reveal.fundingOutputIndex,
                        "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                        10000,
                        "0xf9f0c90d00039523",
                        "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                        "0x28e081f285138ccbe389c1eb8985716230129f89",
                        "0x60bcea61",
                        ZERO_ADDRESS
                      )
                  })
                })

                context("when deposit treasury fee is zero", () => {
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    await bridgeGovernance
                      .connect(governance)
                      .beginDepositTreasuryFeeDivisorUpdate(0)
                    await helpers.time.increaseTime(constants.governanceDelay)
                    await bridgeGovernance
                      .connect(governance)
                      .finalizeDepositTreasuryFeeDivisorUpdate()

                    tx = await bridge
                      .connect(depositor)
                      .revealDeposit(P2SHFundingTx, reveal)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should store proper deposit data", async () => {
                    // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                    const depositKey = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint32"],
                      [
                        "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                        reveal.fundingOutputIndex,
                      ]
                    )

                    const deposit = await bridge.deposits(depositKey)

                    // Deposit amount in satoshi. In this case it's 10000 satoshi
                    // because the P2SH deposit transaction set this value for the
                    // funding output.
                    expect(deposit.amount).to.be.equal(10000)

                    // Treasury fee should be computed according to the current
                    // value of the `depositTreasuryFeeDivisor`.
                    // The divisor is 0 so the treasury fee is 0 as well.
                    expect(deposit.treasuryFee).to.be.equal(0)

                    // Extra data must not be set.
                    expect(deposit.extraData).to.be.equal(
                      ethers.constants.HashZero
                    )
                  })

                  it("should accept the deposit", async () => {
                    await expect(tx)
                      .to.emit(bridge, "DepositRevealed")
                      .withArgs(
                        "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                        reveal.fundingOutputIndex,
                        "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                        10000,
                        "0xf9f0c90d00039523",
                        "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                        "0x28e081f285138ccbe389c1eb8985716230129f89",
                        "0x60bcea61",
                        reveal.vault
                      )
                  })
                })

                context("when deposit is routed to a non-trusted vault", () => {
                  let nonTrustedVaultReveal

                  before(async () => {
                    await createSnapshot()

                    nonTrustedVaultReveal = { ...reveal }
                    nonTrustedVaultReveal.vault =
                      "0x92499afEAD6c41f757Ec3558D0f84bf7ec5aD967"
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(depositor)
                        .revealDeposit(P2SHFundingTx, nonTrustedVaultReveal)
                    ).to.be.revertedWith("Vault is not trusted")
                  })
                })
              })

              context("when amount is below the dust threshold", () => {
                before(async () => {
                  await createSnapshot()

                  // The `P2SHFundingTx` used within this scenario has an output
                  // whose value is 10000 satoshi. To make the scenario happen, it
                  // is enough that the contract's deposit dust threshold is
                  // bigger by 1 satoshi.
                  await bridge.setDepositDustThreshold(10001)
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    bridge
                      .connect(depositor)
                      .revealDeposit(P2SHFundingTx, reveal)
                  ).to.be.revertedWith("Deposit amount too small")
                })
              })
            })

            context("when deposit was already revealed", () => {
              before(async () => {
                await createSnapshot()

                await bridge
                  .connect(depositor)
                  .revealDeposit(P2SHFundingTx, reveal)
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  bridge.connect(depositor).revealDeposit(P2SHFundingTx, reveal)
                ).to.be.revertedWith("Deposit already revealed")
              })
            })
          })

          context("when funding output script hash is wrong", () => {
            it("should revert", async () => {
              // Corrupt reveal data by setting a wrong blinding factor
              const corruptedReveal = { ...reveal }
              corruptedReveal.blindingFactor = "0xf9f0c90d00039524"

              await expect(
                bridge
                  .connect(depositor)
                  .revealDeposit(P2SHFundingTx, corruptedReveal)
              ).to.be.revertedWith("Wrong 20-byte script hash")
            })
          })

          context(
            "when the caller address does not match the funding output script",
            () => {
              it("should revert", async () => {
                const accounts = await getUnnamedAccounts()
                const thirdParty = await ethers.getSigner(accounts[0])

                await expect(
                  bridge
                    .connect(thirdParty)
                    .revealDeposit(P2SHFundingTx, reveal)
                ).to.be.revertedWith("Wrong 20-byte script hash")
              })
            }
          )

          context("when funding transaction embeds extra data", () => {
            it("should revert", async () => {
              await expect(
                bridge.connect(depositor).revealDeposit(
                  // Use a transaction that embeds extra data in the deposit script.
                  revealDepositWithExtraDataFixture.P2SHFundingTx,
                  reveal
                )
              ).to.be.revertedWith("Wrong 20-byte script hash")
            })
          })
        })

        context("when funding transaction is P2WSH", () => {
          context("when funding output script hash is correct", () => {
            context("when deposit was not revealed yet", () => {
              context("when deposit is routed to a trusted vault", () => {
                let tx: ContractTransaction

                before(async () => {
                  await createSnapshot()

                  tx = await bridge
                    .connect(depositor)
                    .revealDeposit(P2WSHFundingTx, reveal)
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should store proper deposit data", async () => {
                  // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                  const depositKey = ethers.utils.solidityKeccak256(
                    ["bytes32", "uint32"],
                    [
                      "0x6a81de17ce3da1eadc833c5fd9d85dac307d3b78235f57afbcd9f068fc01b99e",
                      reveal.fundingOutputIndex,
                    ]
                  )

                  const deposit = await bridge.deposits(depositKey)

                  // Depositor address, same as in `reveal.depositor`.
                  expect(deposit.depositor).to.be.equal(
                    "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637"
                  )
                  // Deposit amount in satoshi. In this case it's 10000 satoshi
                  // because the P2SH deposit transaction set this value for the
                  // funding output.
                  expect(deposit.amount).to.be.equal(10000)
                  // Revealed time should be set.
                  expect(deposit.revealedAt).to.be.equal(await lastBlockTime())
                  // Deposit vault, same as in `reveal.vault`.
                  expect(deposit.vault).to.be.equal(
                    "0x594cfd89700040163727828AE20B52099C58F02C"
                  )
                  // Treasury fee should be computed according to the current
                  // value of the `depositTreasuryFeeDivisor`.
                  expect(deposit.treasuryFee).to.be.equal(5)
                  // Swept time should be unset.
                  expect(deposit.sweptAt).to.be.equal(0)
                  // Extra data must not be set.
                  expect(deposit.extraData).to.be.equal(
                    ethers.constants.HashZero
                  )
                })

                it("should emit DepositRevealed event", async () => {
                  await expect(tx)
                    .to.emit(bridge, "DepositRevealed")
                    .withArgs(
                      "0x6a81de17ce3da1eadc833c5fd9d85dac307d3b78235f57afbcd9f068fc01b99e",
                      reveal.fundingOutputIndex,
                      "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                      10000,
                      "0xf9f0c90d00039523",
                      "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                      "0x28e081f285138ccbe389c1eb8985716230129f89",
                      "0x60bcea61",
                      reveal.vault
                    )
                })
              })

              context("when deposit is not routed to a vault", () => {
                let tx: ContractTransaction
                let nonRoutedReveal: DepositRevealInfoStruct

                before(async () => {
                  await createSnapshot()

                  nonRoutedReveal = { ...reveal }
                  nonRoutedReveal.vault = ZERO_ADDRESS
                  tx = await bridge
                    .connect(depositor)
                    .revealDeposit(P2WSHFundingTx, nonRoutedReveal)
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should accept the deposit", async () => {
                  await expect(tx)
                    .to.emit(bridge, "DepositRevealed")
                    .withArgs(
                      "0x6a81de17ce3da1eadc833c5fd9d85dac307d3b78235f57afbcd9f068fc01b99e",
                      reveal.fundingOutputIndex,
                      "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                      10000,
                      "0xf9f0c90d00039523",
                      "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                      "0x28e081f285138ccbe389c1eb8985716230129f89",
                      "0x60bcea61",
                      ZERO_ADDRESS
                    )
                })
              })

              context("when deposit is routed to a non-trusted vault", () => {
                let nonTrustedVaultReveal

                before(async () => {
                  await createSnapshot()

                  nonTrustedVaultReveal = { ...reveal }
                  nonTrustedVaultReveal.vault =
                    "0x92499afEAD6c41f757Ec3558D0f84bf7ec5aD967"
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    bridge
                      .connect(depositor)
                      .revealDeposit(P2WSHFundingTx, nonTrustedVaultReveal)
                  ).to.be.revertedWith("Vault is not trusted")
                })
              })
            })

            context("when deposit was already revealed", () => {
              before(async () => {
                await createSnapshot()

                await bridge
                  .connect(depositor)
                  .revealDeposit(P2WSHFundingTx, reveal)
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  bridge
                    .connect(depositor)
                    .revealDeposit(P2WSHFundingTx, reveal)
                ).to.be.revertedWith("Deposit already revealed")
              })
            })
          })

          context("when funding output script hash is wrong", () => {
            it("should revert", async () => {
              // Corrupt reveal data by setting a wrong blinding factor
              const corruptedReveal = { ...reveal }
              corruptedReveal.blindingFactor = "0xf9f0c90d00039524"

              await expect(
                bridge
                  .connect(depositor)
                  .revealDeposit(P2WSHFundingTx, corruptedReveal)
              ).to.be.revertedWith("Wrong 32-byte script hash")
            })
          })

          context(
            "when the caller address does not match the funding output script",
            () => {
              it("should revert", async () => {
                const accounts = await getUnnamedAccounts()
                const thirdParty = await ethers.getSigner(accounts[0])

                await expect(
                  bridge
                    .connect(thirdParty)
                    .revealDeposit(P2WSHFundingTx, reveal)
                ).to.be.revertedWith("Wrong 32-byte script hash")
              })
            }
          )

          context("when funding transaction embeds extra data", () => {
            it("should revert", async () => {
              await expect(
                bridge.connect(depositor).revealDeposit(
                  // Use a transaction that embeds extra data in the deposit script.
                  revealDepositWithExtraDataFixture.P2WSHFundingTx,
                  reveal
                )
              ).to.be.revertedWith("Wrong 32-byte script hash")
            })
          })
        })

        context("when funding transaction is neither P2SH nor P2WSH", () => {
          it("should revert", async () => {
            // Corrupt transaction output data by making a 21-byte script hash.
            const corruptedP2SHFundingTx = { ...P2SHFundingTx }
            corruptedP2SHFundingTx.outputVector =
              "0x02102700000000000017a9156a6ade1c799a3e5a59678e776f21be14d66dc" +
              "15ed8877ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2" +
              "140d2726"

            await expect(
              bridge
                .connect(depositor)
                .revealDeposit(corruptedP2SHFundingTx, reveal)
            ).to.be.revertedWith("Wrong script hash length")
          })
        })
      })

      context("when reveal ahead period validation is enabled", () => {
        const encodeRefundLocktime = (refundLocktimeTimestamp: number) => {
          const refundLocktimeTimestampHex = BigNumber.from(
            refundLocktimeTimestamp
          )
            .toHexString()
            .substring(2)
          const refundLocktimeBuffer = Buffer.from(
            refundLocktimeTimestampHex,
            "hex"
          )
          return `0x${refundLocktimeBuffer.reverse().toString("hex")}`
        }

        before(async () => {
          await createSnapshot()

          // Reveal ahead period is disabled by default in this test suite
          // (see root before clause). We need to enable it manually.
          await bridge.setDepositRevealAheadPeriod(
            constants.depositRevealAheadPeriod
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when reveal ahead period is preserved", () => {
          it("should pass the refund locktime validation", async () => {
            const now = Math.floor(Date.now() / 1000)
            const refundLocktimeDuration = 2592000 // 30 days
            const refundLocktimeTimestamp = now + refundLocktimeDuration
            const latestPossibleRevealTimestamp =
              refundLocktimeTimestamp - constants.depositRevealAheadPeriod

            const alteredReveal = {
              ...reveal,
              refundLocktime: encodeRefundLocktime(refundLocktimeTimestamp),
            }

            await ethers.provider.send("evm_setNextBlockTimestamp", [
              BigNumber.from(latestPossibleRevealTimestamp).toHexString(),
            ])

            // We cannot assert that the reveal transaction succeeded since
            // we modified the revealed refund locktime which differs from
            // the one embedded in the transaction P2SH. We just make sure
            // the execution does not revert on the refund locktime validation.
            await expect(
              bridge
                .connect(depositor)
                .revealDeposit(P2WSHFundingTx, alteredReveal)
            ).to.be.not.revertedWith("Deposit refund locktime is too close")
          })
        })

        context("when reveal ahead period is not preserved", () => {
          it("should revert", async () => {
            const now = Math.floor(Date.now() / 1000)
            const refundLocktimeDuration = 2592000 // 30 days
            const refundLocktimeTimestamp = now + refundLocktimeDuration
            const latestPossibleRevealTimestamp =
              refundLocktimeTimestamp - constants.depositRevealAheadPeriod

            const alteredReveal = {
              ...reveal,
              refundLocktime: encodeRefundLocktime(refundLocktimeTimestamp),
            }

            await ethers.provider.send("evm_setNextBlockTimestamp", [
              BigNumber.from(latestPossibleRevealTimestamp + 1).toHexString(),
            ])

            await expect(
              bridge
                .connect(depositor)
                .revealDeposit(P2WSHFundingTx, alteredReveal)
            ).to.be.revertedWith("Deposit refund locktime is too close")
          })
        })

        context("when refund locktime integer value is less than 500M", () => {
          it("should revert", async () => {
            const alteredReveal = {
              ...reveal,
              refundLocktime: encodeRefundLocktime(499999999),
            }

            await expect(
              bridge
                .connect(depositor)
                .revealDeposit(P2WSHFundingTx, alteredReveal)
            ).to.be.revertedWith("Refund locktime must be a value >= 500M")
          })
        })
      })
    })

    context("when wallet is not in Live state", () => {
      const testData = [
        {
          testName: "when wallet state is Unknown",
          walletState: walletState.Unknown,
        },
        {
          testName: "when wallet state is MovingFunds",
          walletState: walletState.MovingFunds,
        },
        {
          testName: "when the source wallet is in the Closing state",
          walletState: walletState.Closing,
        },
        {
          testName: "when wallet state is Closed",
          walletState: walletState.Closed,
        },
        {
          testName: "when wallet state is Terminated",
          walletState: walletState.Terminated,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          before(async () => {
            await createSnapshot()
            await bridge.setWallet(reveal.walletPubKeyHash, {
              ecdsaWalletID: ethers.constants.HashZero,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: test.walletState,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.connect(depositor).revealDeposit(P2SHFundingTx, reveal)
            ).to.be.revertedWith("Wallet must be in Live state")
          })
        })
      })
    })
  })

  describe("revealDepositWithExtraData", () => {
    const {
      P2SHFundingTx,
      P2WSHFundingTx,
      depositorAddress,
      reveal,
      extraData,
    } = revealDepositWithExtraDataFixture

    let depositor: SignerWithAddress

    before(async () => {
      depositor = await impersonateAccount(depositorAddress, {
        from: governance,
        value: 10,
      })
    })

    context("when extra data is non-zero", () => {
      context("when wallet is in Live state", () => {
        before(async () => {
          await createSnapshot()

          await bridgeGovernance
            .connect(governance)
            .setVaultStatus(reveal.vault, true)

          // Simulate the wallet is a Live one and is known in the system.
          await bridge.setWallet(reveal.walletPubKeyHash, {
            ecdsaWalletID: ethers.constants.HashZero,
            mainUtxoHash: ethers.constants.HashZero,
            pendingRedemptionsValue: 0,
            createdAt: await lastBlockTime(),
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState.Live,
            movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
          })
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when reveal ahead period validation is disabled", () => {
          context("when funding transaction is P2SH", () => {
            context("when funding output script hash is correct", () => {
              context("when deposit was not revealed yet", () => {
                context("when amount is not below the dust threshold", () => {
                  context("when deposit is routed to a trusted vault", () => {
                    let tx: ContractTransaction

                    before(async () => {
                      await createSnapshot()
                      tx = await bridge
                        .connect(depositor)
                        .revealDepositWithExtraData(
                          P2SHFundingTx,
                          reveal,
                          extraData
                        )
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should store proper deposit data", async () => {
                      // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                      const depositKey = ethers.utils.solidityKeccak256(
                        ["bytes32", "uint32"],
                        [
                          "0x6383cd1829260b6034cd12bad36171748e8c3c6a8d57fcb6463c62f96116dfbc",
                          reveal.fundingOutputIndex,
                        ]
                      )

                      const deposit = await bridge.deposits(depositKey)

                      // Depositor address, same as in `reveal.depositor`.
                      expect(deposit.depositor).to.be.equal(
                        "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637"
                      )
                      // Deposit amount in satoshi. In this case it's 10000 satoshi
                      // because the P2SH deposit transaction set this value for the
                      // funding output.
                      expect(deposit.amount).to.be.equal(10000)
                      // Revealed time should be set.
                      expect(deposit.revealedAt).to.be.equal(
                        await lastBlockTime()
                      )
                      // Deposit vault, same as in `reveal.vault`.
                      expect(deposit.vault).to.be.equal(
                        "0x594cfd89700040163727828AE20B52099C58F02C"
                      )
                      // Treasury fee should be computed according to the current
                      // value of the `depositTreasuryFeeDivisor`.
                      expect(deposit.treasuryFee).to.be.equal(5)
                      // Swept time should be unset.
                      expect(deposit.sweptAt).to.be.equal(0)
                      // Extra data must be set.
                      expect(deposit.extraData).to.be.equal(extraData)
                    })

                    it("should emit DepositRevealed event", async () => {
                      await expect(tx)
                        .to.emit(bridge, "DepositRevealed")
                        .withArgs(
                          "0x6383cd1829260b6034cd12bad36171748e8c3c6a8d57fcb6463c62f96116dfbc",
                          reveal.fundingOutputIndex,
                          "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                          10000,
                          "0xf9f0c90d00039523",
                          "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                          "0x28e081f285138ccbe389c1eb8985716230129f89",
                          "0x60bcea61",
                          reveal.vault
                        )
                    })
                  })

                  context("when deposit is not routed to a vault", () => {
                    let tx: ContractTransaction
                    let nonRoutedReveal: DepositRevealInfoStruct

                    before(async () => {
                      await createSnapshot()

                      nonRoutedReveal = { ...reveal }
                      nonRoutedReveal.vault = ZERO_ADDRESS
                      tx = await bridge
                        .connect(depositor)
                        .revealDepositWithExtraData(
                          P2SHFundingTx,
                          nonRoutedReveal,
                          extraData
                        )
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should accept the deposit", async () => {
                      await expect(tx)
                        .to.emit(bridge, "DepositRevealed")
                        .withArgs(
                          "0x6383cd1829260b6034cd12bad36171748e8c3c6a8d57fcb6463c62f96116dfbc",
                          reveal.fundingOutputIndex,
                          "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                          10000,
                          "0xf9f0c90d00039523",
                          "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                          "0x28e081f285138ccbe389c1eb8985716230129f89",
                          "0x60bcea61",
                          ZERO_ADDRESS
                        )
                    })
                  })

                  context("when deposit treasury fee is zero", () => {
                    let tx: ContractTransaction

                    before(async () => {
                      await createSnapshot()

                      await bridgeGovernance
                        .connect(governance)
                        .beginDepositTreasuryFeeDivisorUpdate(0)
                      await helpers.time.increaseTime(constants.governanceDelay)
                      await bridgeGovernance
                        .connect(governance)
                        .finalizeDepositTreasuryFeeDivisorUpdate()

                      tx = await bridge
                        .connect(depositor)
                        .revealDepositWithExtraData(
                          P2SHFundingTx,
                          reveal,
                          extraData
                        )
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should store proper deposit data", async () => {
                      // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                      const depositKey = ethers.utils.solidityKeccak256(
                        ["bytes32", "uint32"],
                        [
                          "0x6383cd1829260b6034cd12bad36171748e8c3c6a8d57fcb6463c62f96116dfbc",
                          reveal.fundingOutputIndex,
                        ]
                      )

                      const deposit = await bridge.deposits(depositKey)

                      // Deposit amount in satoshi. In this case it's 10000 satoshi
                      // because the P2SH deposit transaction set this value for the
                      // funding output.
                      expect(deposit.amount).to.be.equal(10000)

                      // Treasury fee should be computed according to the current
                      // value of the `depositTreasuryFeeDivisor`.
                      // The divisor is 0 so the treasury fee is 0 as well.
                      expect(deposit.treasuryFee).to.be.equal(0)
                      // Extra data must be set.
                      expect(deposit.extraData).to.be.equal(extraData)
                    })

                    it("should accept the deposit", async () => {
                      await expect(tx)
                        .to.emit(bridge, "DepositRevealed")
                        .withArgs(
                          "0x6383cd1829260b6034cd12bad36171748e8c3c6a8d57fcb6463c62f96116dfbc",
                          reveal.fundingOutputIndex,
                          "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                          10000,
                          "0xf9f0c90d00039523",
                          "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                          "0x28e081f285138ccbe389c1eb8985716230129f89",
                          "0x60bcea61",
                          reveal.vault
                        )
                    })
                  })

                  context(
                    "when deposit is routed to a non-trusted vault",
                    () => {
                      let nonTrustedVaultReveal

                      before(async () => {
                        await createSnapshot()

                        nonTrustedVaultReveal = { ...reveal }
                        nonTrustedVaultReveal.vault =
                          "0x92499afEAD6c41f757Ec3558D0f84bf7ec5aD967"
                      })

                      after(async () => {
                        await restoreSnapshot()
                      })

                      it("should revert", async () => {
                        await expect(
                          bridge
                            .connect(depositor)
                            .revealDepositWithExtraData(
                              P2SHFundingTx,
                              nonTrustedVaultReveal,
                              extraData
                            )
                        ).to.be.revertedWith("Vault is not trusted")
                      })
                    }
                  )
                })

                context("when amount is below the dust threshold", () => {
                  before(async () => {
                    await createSnapshot()

                    // The `P2SHFundingTx` used within this scenario has an output
                    // whose value is 10000 satoshi. To make the scenario happen, it
                    // is enough that the contract's deposit dust threshold is
                    // bigger by 1 satoshi.
                    await bridge.setDepositDustThreshold(10001)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(depositor)
                        .revealDepositWithExtraData(
                          P2SHFundingTx,
                          reveal,
                          extraData
                        )
                    ).to.be.revertedWith("Deposit amount too small")
                  })
                })
              })

              context("when deposit was already revealed", () => {
                before(async () => {
                  await createSnapshot()

                  await bridge
                    .connect(depositor)
                    .revealDepositWithExtraData(
                      P2SHFundingTx,
                      reveal,
                      extraData
                    )
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    bridge
                      .connect(depositor)
                      .revealDepositWithExtraData(
                        P2SHFundingTx,
                        reveal,
                        extraData
                      )
                  ).to.be.revertedWith("Deposit already revealed")
                })
              })
            })

            context("when funding output script hash is wrong", () => {
              it("should revert", async () => {
                // Corrupt reveal data by setting a wrong blinding factor
                const corruptedReveal = { ...reveal }
                corruptedReveal.blindingFactor = "0xf9f0c90d00039524"

                await expect(
                  bridge
                    .connect(depositor)
                    .revealDepositWithExtraData(
                      P2SHFundingTx,
                      corruptedReveal,
                      extraData
                    )
                ).to.be.revertedWith("Wrong 20-byte script hash")
              })
            })

            context(
              "when the caller address does not match the funding output script",
              () => {
                it("should revert", async () => {
                  const accounts = await getUnnamedAccounts()
                  const thirdParty = await ethers.getSigner(accounts[0])

                  await expect(
                    bridge
                      .connect(thirdParty)
                      .revealDepositWithExtraData(
                        P2SHFundingTx,
                        reveal,
                        extraData
                      )
                  ).to.be.revertedWith("Wrong 20-byte script hash")
                })
              }
            )

            context("when the revealed extra data do not match", () => {
              it("should revert", async () => {
                // Corrupt the extra data.
                const corruptedExtraData = ethers.utils.keccak256(extraData)

                await expect(
                  bridge
                    .connect(depositor)
                    .revealDepositWithExtraData(
                      P2SHFundingTx,
                      reveal,
                      corruptedExtraData
                    )
                ).to.be.revertedWith("Wrong 20-byte script hash")
              })
            })

            context(
              "when funding transaction does not embed extra data",
              () => {
                it("should revert", async () => {
                  await expect(
                    bridge.connect(depositor).revealDepositWithExtraData(
                      // Use a transaction that doesn't embed extra data in the deposit script.
                      revealDepositFixture.P2SHFundingTx,
                      reveal,
                      extraData
                    )
                  ).to.be.revertedWith("Wrong 20-byte script hash")
                })
              }
            )
          })

          context("when funding transaction is P2WSH", () => {
            context("when funding output script hash is correct", () => {
              context("when deposit was not revealed yet", () => {
                context("when deposit is routed to a trusted vault", () => {
                  let tx: ContractTransaction

                  before(async () => {
                    await createSnapshot()

                    tx = await bridge
                      .connect(depositor)
                      .revealDepositWithExtraData(
                        P2WSHFundingTx,
                        reveal,
                        extraData
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should store proper deposit data", async () => {
                    // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                    const depositKey = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint32"],
                      [
                        "0xc9312103d0d8d55344ef2d51acc409e004fbaaba7893b1725fa505ff73795732",
                        reveal.fundingOutputIndex,
                      ]
                    )

                    const deposit = await bridge.deposits(depositKey)

                    // Depositor address, same as in `reveal.depositor`.
                    expect(deposit.depositor).to.be.equal(
                      "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637"
                    )
                    // Deposit amount in satoshi. In this case it's 10000 satoshi
                    // because the P2SH deposit transaction set this value for the
                    // funding output.
                    expect(deposit.amount).to.be.equal(10000)
                    // Revealed time should be set.
                    expect(deposit.revealedAt).to.be.equal(
                      await lastBlockTime()
                    )
                    // Deposit vault, same as in `reveal.vault`.
                    expect(deposit.vault).to.be.equal(
                      "0x594cfd89700040163727828AE20B52099C58F02C"
                    )
                    // Treasury fee should be computed according to the current
                    // value of the `depositTreasuryFeeDivisor`.
                    expect(deposit.treasuryFee).to.be.equal(5)
                    // Swept time should be unset.
                    expect(deposit.sweptAt).to.be.equal(0)
                    // Extra data must be set.
                    expect(deposit.extraData).to.be.equal(extraData)
                  })

                  it("should emit DepositRevealed event", async () => {
                    await expect(tx)
                      .to.emit(bridge, "DepositRevealed")
                      .withArgs(
                        "0xc9312103d0d8d55344ef2d51acc409e004fbaaba7893b1725fa505ff73795732",
                        reveal.fundingOutputIndex,
                        "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                        10000,
                        "0xf9f0c90d00039523",
                        "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                        "0x28e081f285138ccbe389c1eb8985716230129f89",
                        "0x60bcea61",
                        reveal.vault
                      )
                  })
                })

                context("when deposit is not routed to a vault", () => {
                  let tx: ContractTransaction
                  let nonRoutedReveal: DepositRevealInfoStruct

                  before(async () => {
                    await createSnapshot()

                    nonRoutedReveal = { ...reveal }
                    nonRoutedReveal.vault = ZERO_ADDRESS
                    tx = await bridge
                      .connect(depositor)
                      .revealDepositWithExtraData(
                        P2WSHFundingTx,
                        nonRoutedReveal,
                        extraData
                      )
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should accept the deposit", async () => {
                    await expect(tx)
                      .to.emit(bridge, "DepositRevealed")
                      .withArgs(
                        "0xc9312103d0d8d55344ef2d51acc409e004fbaaba7893b1725fa505ff73795732",
                        reveal.fundingOutputIndex,
                        "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                        10000,
                        "0xf9f0c90d00039523",
                        "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                        "0x28e081f285138ccbe389c1eb8985716230129f89",
                        "0x60bcea61",
                        ZERO_ADDRESS
                      )
                  })
                })

                context("when deposit is routed to a non-trusted vault", () => {
                  let nonTrustedVaultReveal

                  before(async () => {
                    await createSnapshot()

                    nonTrustedVaultReveal = { ...reveal }
                    nonTrustedVaultReveal.vault =
                      "0x92499afEAD6c41f757Ec3558D0f84bf7ec5aD967"
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    await expect(
                      bridge
                        .connect(depositor)
                        .revealDepositWithExtraData(
                          P2WSHFundingTx,
                          nonTrustedVaultReveal,
                          extraData
                        )
                    ).to.be.revertedWith("Vault is not trusted")
                  })
                })
              })

              context("when deposit was already revealed", () => {
                before(async () => {
                  await createSnapshot()

                  await bridge
                    .connect(depositor)
                    .revealDepositWithExtraData(
                      P2WSHFundingTx,
                      reveal,
                      extraData
                    )
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  await expect(
                    bridge
                      .connect(depositor)
                      .revealDepositWithExtraData(
                        P2WSHFundingTx,
                        reveal,
                        extraData
                      )
                  ).to.be.revertedWith("Deposit already revealed")
                })
              })
            })

            context("when funding output script hash is wrong", () => {
              it("should revert", async () => {
                // Corrupt reveal data by setting a wrong blinding factor
                const corruptedReveal = { ...reveal }
                corruptedReveal.blindingFactor = "0xf9f0c90d00039524"

                await expect(
                  bridge
                    .connect(depositor)
                    .revealDepositWithExtraData(
                      P2WSHFundingTx,
                      corruptedReveal,
                      extraData
                    )
                ).to.be.revertedWith("Wrong 32-byte script hash")
              })
            })

            context(
              "when the caller address does not match the funding output script",
              () => {
                it("should revert", async () => {
                  const accounts = await getUnnamedAccounts()
                  const thirdParty = await ethers.getSigner(accounts[0])

                  await expect(
                    bridge
                      .connect(thirdParty)
                      .revealDepositWithExtraData(
                        P2WSHFundingTx,
                        reveal,
                        extraData
                      )
                  ).to.be.revertedWith("Wrong 32-byte script hash")
                })
              }
            )

            context("when the revealed extra data do not match", () => {
              it("should revert", async () => {
                // Corrupt the extra data.
                const corruptedExtraData = ethers.utils.keccak256(extraData)

                await expect(
                  bridge
                    .connect(depositor)
                    .revealDepositWithExtraData(
                      P2WSHFundingTx,
                      reveal,
                      corruptedExtraData
                    )
                ).to.be.revertedWith("Wrong 32-byte script hash")
              })
            })

            context(
              "when funding transaction does not embed extra data",
              () => {
                it("should revert", async () => {
                  await expect(
                    bridge.connect(depositor).revealDepositWithExtraData(
                      // Use a transaction that doesn't embed extra data in the deposit script.
                      revealDepositFixture.P2WSHFundingTx,
                      reveal,
                      extraData
                    )
                  ).to.be.revertedWith("Wrong 32-byte script hash")
                })
              }
            )
          })

          context("when funding transaction is neither P2SH nor P2WSH", () => {
            it("should revert", async () => {
              // Corrupt transaction output data by making a 21-byte script hash.
              const corruptedP2SHFundingTx = { ...P2SHFundingTx }
              corruptedP2SHFundingTx.outputVector =
                "0x02102700000000000017a9156a6ade1c799a3e5a59678e776f21be14d66dc" +
                "15ed8877ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2" +
                "140d2726"

              await expect(
                bridge
                  .connect(depositor)
                  .revealDepositWithExtraData(
                    corruptedP2SHFundingTx,
                    reveal,
                    extraData
                  )
              ).to.be.revertedWith("Wrong script hash length")
            })
          })
        })

        context("when reveal ahead period validation is enabled", () => {
          const encodeRefundLocktime = (refundLocktimeTimestamp: number) => {
            const refundLocktimeTimestampHex = BigNumber.from(
              refundLocktimeTimestamp
            )
              .toHexString()
              .substring(2)
            const refundLocktimeBuffer = Buffer.from(
              refundLocktimeTimestampHex,
              "hex"
            )
            return `0x${refundLocktimeBuffer.reverse().toString("hex")}`
          }

          before(async () => {
            await createSnapshot()

            // Reveal ahead period is disabled by default in this test suite
            // (see root before clause). We need to enable it manually.
            await bridge.setDepositRevealAheadPeriod(
              constants.depositRevealAheadPeriod
            )
          })

          after(async () => {
            await restoreSnapshot()
          })

          context("when reveal ahead period is preserved", () => {
            it("should pass the refund locktime validation", async () => {
              const now = Math.floor(Date.now() / 1000)
              const refundLocktimeDuration = 2592000 // 30 days
              const refundLocktimeTimestamp = now + refundLocktimeDuration
              const latestPossibleRevealTimestamp =
                refundLocktimeTimestamp - constants.depositRevealAheadPeriod

              const alteredReveal = {
                ...reveal,
                refundLocktime: encodeRefundLocktime(refundLocktimeTimestamp),
              }

              await ethers.provider.send("evm_setNextBlockTimestamp", [
                BigNumber.from(latestPossibleRevealTimestamp).toHexString(),
              ])

              // We cannot assert that the reveal transaction succeeded since
              // we modified the revealed refund locktime which differs from
              // the one embedded in the transaction P2SH. We just make sure
              // the execution does not revert on the refund locktime validation.
              await expect(
                bridge
                  .connect(depositor)
                  .revealDepositWithExtraData(
                    P2WSHFundingTx,
                    alteredReveal,
                    extraData
                  )
              ).to.be.not.revertedWith("Deposit refund locktime is too close")
            })
          })

          context("when reveal ahead period is not preserved", () => {
            it("should revert", async () => {
              const now = Math.floor(Date.now() / 1000)
              const refundLocktimeDuration = 2592000 // 30 days
              const refundLocktimeTimestamp = now + refundLocktimeDuration
              const latestPossibleRevealTimestamp =
                refundLocktimeTimestamp - constants.depositRevealAheadPeriod

              const alteredReveal = {
                ...reveal,
                refundLocktime: encodeRefundLocktime(refundLocktimeTimestamp),
              }

              await ethers.provider.send("evm_setNextBlockTimestamp", [
                BigNumber.from(latestPossibleRevealTimestamp + 1).toHexString(),
              ])

              await expect(
                bridge
                  .connect(depositor)
                  .revealDepositWithExtraData(
                    P2WSHFundingTx,
                    alteredReveal,
                    extraData
                  )
              ).to.be.revertedWith("Deposit refund locktime is too close")
            })
          })

          context(
            "when refund locktime integer value is less than 500M",
            () => {
              it("should revert", async () => {
                const alteredReveal = {
                  ...reveal,
                  refundLocktime: encodeRefundLocktime(499999999),
                }

                await expect(
                  bridge
                    .connect(depositor)
                    .revealDepositWithExtraData(
                      P2WSHFundingTx,
                      alteredReveal,
                      extraData
                    )
                ).to.be.revertedWith("Refund locktime must be a value >= 500M")
              })
            }
          )
        })
      })

      context("when wallet is not in Live state", () => {
        const testData = [
          {
            testName: "when wallet state is Unknown",
            walletState: walletState.Unknown,
          },
          {
            testName: "when wallet state is MovingFunds",
            walletState: walletState.MovingFunds,
          },
          {
            testName: "when the source wallet is in the Closing state",
            walletState: walletState.Closing,
          },
          {
            testName: "when wallet state is Closed",
            walletState: walletState.Closed,
          },
          {
            testName: "when wallet state is Terminated",
            walletState: walletState.Terminated,
          },
        ]

        testData.forEach((test) => {
          context(test.testName, () => {
            before(async () => {
              await createSnapshot()
              await bridge.setWallet(reveal.walletPubKeyHash, {
                ecdsaWalletID: ethers.constants.HashZero,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: await lastBlockTime(),
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: test.walletState,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge
                  .connect(depositor)
                  .revealDepositWithExtraData(P2SHFundingTx, reveal, extraData)
              ).to.be.revertedWith("Wallet must be in Live state")
            })
          })
        })
      })
    })

    context("when extra data is zero", () => {
      it("should revert", async () => {
        await expect(
          bridge
            .connect(depositor)
            .revealDepositWithExtraData(
              P2SHFundingTx,
              reveal,
              ethers.constants.HashZero
            )
        ).to.be.revertedWith("Extra data must not be empty")
      })
    })
  })

  describe("submitDepositSweepProof", () => {
    const walletDraft = {
      ecdsaWalletID: ethers.constants.HashZero,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 0,
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Unknown,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    }

    context("when the wallet state is Live", () => {
      context("when transaction proof is valid", () => {
        context("when there is only one output", () => {
          context("when the single output is 20-byte", () => {
            context("when single output is either P2PKH or P2WPKH", () => {
              context("when main UTXO data are valid", () => {
                context(
                  "when transaction fee does not exceed the deposit transaction maximum fee",
                  () => {
                    context("when there is only one input", () => {
                      context(
                        "when the single input is a revealed unswept P2SH deposit",
                        () => {
                          let tx: ContractTransaction
                          const data: DepositSweepTestData = SingleP2SHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            tx = await runDepositSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should mark deposit as swept", async () => {
                            // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                            const depositKey = ethers.utils.solidityKeccak256(
                              ["bytes32", "uint32"],
                              [
                                data.deposits[0].fundingTx.hash,
                                data.deposits[0].reveal.fundingOutputIndex,
                              ]
                            )

                            const deposit = await bridge.deposits(depositKey)

                            expect(deposit.sweptAt).to.be.equal(
                              await lastBlockTime()
                            )
                          })

                          it("should update main UTXO for the given wallet", async () => {
                            const { mainUtxoHash } = await bridge.wallets(
                              walletPubKeyHash
                            )

                            // Amount can be checked by opening the sweep tx in a Bitcoin
                            // testnet explorer. In this case, the sum of inputs is
                            // 20000 satoshi (from the single deposit) and there is a
                            // fee of 1500 so the output value is 18500.
                            const expectedMainUtxo =
                              ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32", "uint64"],
                                [data.sweepTx.hash, 0, 18500]
                              )

                            expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
                          })

                          it("should update the depositor's balance", async () => {
                            // The sum of sweep tx inputs is 20000 satoshi. The output
                            // value is 18500 so the transaction fee is 1500. There is
                            // only one deposit so it incurs the entire transaction fee.
                            // The deposit should also incur the treasury fee whose
                            // initial value is 0.05% of the deposited amount so the
                            // final depositor balance should be cut by 10 satoshi.
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(18490)
                          })

                          it("should transfer collected treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(10)
                          })

                          it("should emit DepositsSwept event", async () => {
                            await expect(tx)
                              .to.emit(bridge, "DepositsSwept")
                              .withArgs(walletPubKeyHash, data.sweepTx.hash)
                          })
                        }
                      )

                      context(
                        "when the single input is a revealed unswept P2WSH deposit",
                        () => {
                          let tx: ContractTransaction
                          const data: DepositSweepTestData = SingleP2WSHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            tx = await runDepositSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should mark deposit as swept", async () => {
                            // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                            const depositKey = ethers.utils.solidityKeccak256(
                              ["bytes32", "uint32"],
                              [
                                data.deposits[0].fundingTx.hash,
                                data.deposits[0].reveal.fundingOutputIndex,
                              ]
                            )

                            const deposit = await bridge.deposits(depositKey)

                            expect(deposit.sweptAt).to.be.equal(
                              await lastBlockTime()
                            )
                          })

                          it("should update main UTXO for the given wallet", async () => {
                            const { mainUtxoHash } = await bridge.wallets(
                              walletPubKeyHash
                            )

                            // Amount can be checked by opening the sweep tx in a Bitcoin
                            // testnet explorer. In this case, the sum of inputs is
                            // 80000 satoshi (from the single deposit) and there is a
                            // fee of 2000 so the output value is 78000.
                            const expectedMainUtxo =
                              ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32", "uint64"],
                                [data.sweepTx.hash, 0, 78000]
                              )

                            expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
                          })

                          it("should update the depositor's balance", async () => {
                            // The sum of sweep tx inputs is 80000 satoshi. The output
                            // value is 78000 so the fee is 2000. There is only one
                            // deposit so it incurs the entire fee. The deposit should
                            // also incur the treasury fee whose initial value is 0.05%
                            // of the deposited amount so the final depositor balance
                            // should be cut by 40 satoshi.
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(77960)
                          })

                          it("should transfer collected treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(40)
                          })

                          it("should emit DepositsSwept event", async () => {
                            await expect(tx)
                              .to.emit(bridge, "DepositsSwept")
                              .withArgs(walletPubKeyHash, data.sweepTx.hash)
                          })
                        }
                      )

                      context(
                        "when the single input is a revealed unswept deposit with a trusted vault",
                        async () => {
                          let vault: FakeContract<IVault>
                          let tx: ContractTransaction

                          const data: DepositSweepTestData = SingleP2WSHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Deploy a fake vault and mark it as trusted.
                            vault = await smock.fake<IVault>("IVault")
                            await bridgeGovernance
                              .connect(governance)
                              .setVaultStatus(vault.address, true)

                            // Enrich the test data with the vault parameter.
                            const dataWithVault: DepositSweepTestData =
                              JSON.parse(JSON.stringify(data))
                            dataWithVault.vault = vault.address
                            dataWithVault.deposits[0].reveal.vault =
                              vault.address

                            tx = await runDepositSweepScenario(dataWithVault)
                          })

                          after(async () => {
                            vault.receiveBalanceIncrease.reset()

                            await restoreSnapshot()
                          })

                          it("should mark deposit as swept", async () => {
                            // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                            const depositKey = ethers.utils.solidityKeccak256(
                              ["bytes32", "uint32"],
                              [
                                data.deposits[0].fundingTx.hash,
                                data.deposits[0].reveal.fundingOutputIndex,
                              ]
                            )

                            const deposit = await bridge.deposits(depositKey)

                            expect(deposit.sweptAt).to.be.equal(
                              await lastBlockTime()
                            )
                          })

                          it("should update main UTXO for the given wallet", async () => {
                            const { mainUtxoHash } = await bridge.wallets(
                              walletPubKeyHash
                            )

                            // Amount can be checked by opening the sweep tx in a Bitcoin
                            // testnet explorer. In this case, the sum of inputs is
                            // 80000 satoshi (from the single deposit) and there is a
                            // fee of 2000 so the output value is 78000.
                            const expectedMainUtxo =
                              ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32", "uint64"],
                                [data.sweepTx.hash, 0, 78000]
                              )

                            expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
                          })

                          it("should not update the depositor's balance", async () => {
                            // The depositor balance should not be increased.
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(0)
                          })

                          it("should update the vault's balance", async () => {
                            // The vault's balance should be increased by the
                            // sum of all swept deposits counted as follows:
                            //
                            // The sum of sweep tx inputs is 80000 satoshi. The output
                            // value is 78000 so the fee is 2000. There is only one
                            // deposit so it incurs the entire fee. The deposit should
                            // also incur the treasury fee whose initial value is 0.05%
                            // of the deposited amount so the final depositor balance
                            // should be cut by 40 satoshi. The final sum
                            // is 77960.
                            expect(
                              await bank.balanceOf(vault.address)
                            ).to.be.equal(77960)
                          })

                          it("should call the vault's receiveBalanceIncrease function", async () => {
                            expect(
                              vault.receiveBalanceIncrease
                            ).to.have.been.calledOnceWith(
                              [data.deposits[0].depositor],
                              [77960]
                            )
                          })

                          it("should transfer collected treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(40)
                          })

                          it("should emit DepositsSwept event", async () => {
                            await expect(tx)
                              .to.emit(bridge, "DepositsSwept")
                              .withArgs(walletPubKeyHash, data.sweepTx.hash)
                          })
                        }
                      )

                      // This test cares only about the fact sweeping works
                      // correctly when no deposit treasury fee is collected.
                      // It uses the test data from P2SH deposit test.
                      context(
                        "when the deposit treasury fee is zero",
                        async () => {
                          const data: DepositSweepTestData = SingleP2SHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            await bridgeGovernance
                              .connect(governance)
                              .beginDepositTreasuryFeeDivisorUpdate(0)
                            await helpers.time.increaseTime(
                              constants.governanceDelay
                            )
                            await bridgeGovernance
                              .connect(governance)
                              .finalizeDepositTreasuryFeeDivisorUpdate()

                            await runDepositSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should update the depositor's balance", async () => {
                            // The sum of sweep tx inputs is 20000 satoshi. The output
                            // value is 18500 so the transaction fee is 1500. There is
                            // only one deposit so it incurs the entire transaction fee.
                            // There is no deposit treasury fee so the final depositor
                            // balance is not additionally cut.
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(18500)
                          })

                          it("should collect no treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(0)
                          })
                        }
                      )

                      context(
                        "when the single input is a revealed unswept deposit with a non-trusted vault",
                        async () => {
                          let vault: FakeContract<IVault>
                          let tx: ContractTransaction

                          const data: DepositSweepTestData = SingleP2WSHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Deploy a fake vault and mark it as trusted.
                            vault = await smock.fake<IVault>("IVault")
                            await bridgeGovernance
                              .connect(governance)
                              .setVaultStatus(vault.address, true)

                            // Enrich the test data with the vault parameter.
                            const dataWithVault: DepositSweepTestData =
                              JSON.parse(JSON.stringify(data))
                            dataWithVault.vault = vault.address
                            dataWithVault.deposits[0].reveal.vault =
                              vault.address

                            // Mark the vault as non-trusted just before
                            // proof submission.
                            const beforeProofActions = async () => {
                              await bridgeGovernance
                                .connect(governance)
                                .setVaultStatus(vault.address, false)
                            }

                            tx = await runDepositSweepScenario(
                              dataWithVault,
                              beforeProofActions
                            )
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should mark deposit as swept", async () => {
                            // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                            const depositKey = ethers.utils.solidityKeccak256(
                              ["bytes32", "uint32"],
                              [
                                data.deposits[0].fundingTx.hash,
                                data.deposits[0].reveal.fundingOutputIndex,
                              ]
                            )

                            const deposit = await bridge.deposits(depositKey)

                            expect(deposit.sweptAt).to.be.equal(
                              await lastBlockTime()
                            )
                          })

                          it("should update main UTXO for the given wallet", async () => {
                            const { mainUtxoHash } = await bridge.wallets(
                              walletPubKeyHash
                            )

                            // Amount can be checked by opening the sweep tx in a Bitcoin
                            // testnet explorer. In this case, the sum of inputs is
                            // 80000 satoshi (from the single deposit) and there is a
                            // fee of 2000 so the output value is 78000.
                            const expectedMainUtxo =
                              ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32", "uint64"],
                                [data.sweepTx.hash, 0, 78000]
                              )

                            expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
                          })

                          it("should update the depositor's balance", async () => {
                            // The sum of sweep tx inputs is 80000 satoshi. The output
                            // value is 78000 so the fee is 2000. There is only one
                            // deposit so it incurs the entire fee. The deposit should
                            // also incur the treasury fee whose initial value is 0.05%
                            // of the deposited amount so the final depositor balance
                            // should be cut by 40 satoshi.
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(77960)
                          })

                          it("should transfer collected treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(40)
                          })

                          it("should emit DepositsSwept event", async () => {
                            await expect(tx)
                              .to.emit(bridge, "DepositsSwept")
                              .withArgs(walletPubKeyHash, data.sweepTx.hash)
                          })
                        }
                      )

                      context(
                        "when the single input is a revealed unswept deposit with a trusted vault but non-equal to the vault passed via function parameter",
                        async () => {
                          let vault: FakeContract<IVault>
                          let tx: Promise<ContractTransaction>

                          const data: DepositSweepTestData = SingleP2WSHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Deploy a fake vault and mark it as trusted.
                            vault = await smock.fake<IVault>("IVault")
                            await bridgeGovernance
                              .connect(governance)
                              .setVaultStatus(vault.address, true)

                            // Enrich the test data with the vault parameter.
                            // However, deliberately set the `vault` parameter
                            // passed to `submitDepositSweepProof` to another
                            // value than in the deposit.
                            const dataWithVault: DepositSweepTestData =
                              JSON.parse(JSON.stringify(data))
                            dataWithVault.vault = ethers.constants.AddressZero
                            dataWithVault.deposits[0].reveal.vault =
                              vault.address

                            tx = runDepositSweepScenario(dataWithVault)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should revert", async () => {
                            await expect(tx).to.be.revertedWith(
                              "Deposit should be routed to another vault"
                            )
                          })
                        }
                      )

                      context(
                        "when the single input is the expected main UTXO",
                        () => {
                          const previousData: DepositSweepTestData =
                            SingleP2SHDeposit
                          const data: DepositSweepTestData = SingleMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } =
                            previousData.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Make the first sweep which is actually the predecessor
                            // of the sweep tested within this scenario.
                            await runDepositSweepScenario(previousData)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should revert", async () => {
                            await expect(
                              runDepositSweepScenario(data)
                            ).to.be.revertedWith(
                              "Sweep transaction must process at least one deposit"
                            )
                          })
                        }
                      )

                      context(
                        "when the single input is a revealed but already swept deposit",
                        () => {
                          const data: DepositSweepTestData = SingleP2SHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Make a proper sweep to turn the tested deposit into
                            // the swept state.
                            await runDepositSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should revert", async () => {
                            // Main UTXO parameter must point to the properly
                            // made sweep to avoid revert at validation stage.
                            const mainUtxo = {
                              txHash: data.sweepTx.hash,
                              txOutputIndex: 0,
                              txOutputValue: 18500,
                            }

                            // Try replaying the already done sweep.
                            await expect(
                              bridge
                                .connect(spvMaintainer)
                                .submitDepositSweepProof(
                                  data.sweepTx,
                                  data.sweepProof,
                                  mainUtxo,
                                  ethers.constants.AddressZero
                                )
                            ).to.be.revertedWith("Deposit already swept")
                          })
                        }
                      )

                      context("when the single input is an unknown", () => {
                        const data: DepositSweepTestData = SingleP2SHDeposit
                        // Take wallet public key hash from first deposit. All
                        // deposits in same sweep batch should have the same value
                        // of that field.
                        const { walletPubKeyHash } = data.deposits[0].reveal

                        before(async () => {
                          await createSnapshot()

                          // Simulate the wallet is a Live one and is known in the system.
                          await bridge.setWallet(walletPubKeyHash, {
                            ...walletDraft,
                            state: walletState.Live,
                          })

                          // Necessary to pass the proof validation.
                          relay.getPrevEpochDifficulty.returns(
                            data.chainDifficulty
                          )
                          relay.getCurrentEpochDifficulty.returns(
                            data.chainDifficulty
                          )
                        })

                        after(async () => {
                          await restoreSnapshot()
                        })

                        it("should revert", async () => {
                          // Try to sweep a deposit which was not revealed before and
                          // is unknown from system's point of view.
                          await expect(
                            bridge
                              .connect(spvMaintainer)
                              .submitDepositSweepProof(
                                data.sweepTx,
                                data.sweepProof,
                                NO_MAIN_UTXO,
                                ethers.constants.AddressZero
                              )
                          ).to.be.revertedWith("Unknown input type")
                        })
                      })
                    })

                    // Since P2SH vs P2WSH path has been already checked in the scenario
                    // "when there is only one input", we no longer differentiate deposits
                    // using that criterion during "when there are multiple inputs" scenario.
                    context("when there are multiple inputs", () => {
                      context(
                        "when input vector consists only of revealed unswept deposits and the expected main UTXO",
                        () => {
                          let tx: ContractTransaction
                          const previousData: DepositSweepTestData =
                            MultipleDepositsNoMainUtxo
                          const data: DepositSweepTestData =
                            MultipleDepositsWithMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Make the first sweep which is actually the predecessor
                            // of the sweep tested within this scenario.
                            await runDepositSweepScenario(previousData)

                            tx = await runDepositSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should mark deposits as swept", async () => {
                            for (let i = 0; i < data.deposits.length; i++) {
                              // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                              const depositKey = ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32"],
                                [
                                  data.deposits[i].fundingTx.hash,
                                  data.deposits[i].reveal.fundingOutputIndex,
                                ]
                              )

                              // eslint-disable-next-line no-await-in-loop
                              const deposit = await bridge.deposits(depositKey)

                              expect(deposit.sweptAt).to.be.equal(
                                // eslint-disable-next-line no-await-in-loop
                                await lastBlockTime(),
                                `Deposit with index ${i} has an unexpected swept time`
                              )
                            }
                          })

                          it("should update main UTXO for the given wallet", async () => {
                            const { mainUtxoHash } = await bridge.wallets(
                              walletPubKeyHash
                            )

                            // Amount can be checked by opening the sweep tx in a Bitcoin
                            // testnet explorer. In this case, the sum of inputs is
                            // 4148000 satoshi and there is a fee of 2999 so the output
                            // value is 4145001.
                            const expectedMainUtxo =
                              ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32", "uint64"],
                                [data.sweepTx.hash, 0, 4145001]
                              )

                            expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
                          })

                          it("should update the depositors balances", async () => {
                            // The sum of sweep tx inputs is 4148000 satoshi. The output
                            // value is 4145001 so the sweep transaction fee is 2999.
                            // There are 5 deposits so the fee per deposit is 599
                            // and the indivisible remainder is 4 which means the
                            // last deposit should incur 603 satoshi. Worth noting
                            // the order of deposits used by this test scenario
                            // data does not correspond to the order of sweep
                            // transaction inputs. Each deposit should also incur
                            // the treasury fee whose initial value is 0.05% of the
                            // deposited amount.

                            // Deposit with index 0 used as input with index 5
                            // in the sweep transaction. This is the last deposit
                            // (according to inputs order) and it should incur the
                            // remainder of the transaction fee.
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(219287)

                            // Deposit with index 1 used as input with index 3
                            // in the sweep transaction.
                            expect(
                              await bank.balanceOf(data.deposits[1].depositor)
                            ).to.be.equal(759021)

                            // Deposit with index 2 used as input with index 1
                            // in the sweep transaction.
                            expect(
                              await bank.balanceOf(data.deposits[2].depositor)
                            ).to.be.equal(938931)

                            // Deposit with index 3 used as input with index 2
                            // in the sweep transaction.
                            expect(
                              await bank.balanceOf(data.deposits[3].depositor)
                            ).to.be.equal(878961)

                            // Deposit with index 4 used as input with index 4
                            // in the sweep transaction.
                            expect(
                              await bank.balanceOf(data.deposits[4].depositor)
                            ).to.be.equal(289256)
                          })

                          it("should transfer collected treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(2075)
                          })

                          it("should mark the previous main UTXO as spent", async () => {
                            const mainUtxoKey = ethers.utils.solidityKeccak256(
                              ["bytes32", "uint32"],
                              [
                                data.mainUtxo.txHash,
                                data.mainUtxo.txOutputIndex,
                              ]
                            )

                            expect(await bridge.spentMainUTXOs(mainUtxoKey)).to
                              .be.true
                          })

                          it("should emit DepositsSwept event", async () => {
                            await expect(tx)
                              .to.emit(bridge, "DepositsSwept")
                              .withArgs(walletPubKeyHash, data.sweepTx.hash)
                          })
                        }
                      )

                      context(
                        "when input vector consists only of revealed unswept deposits with a trusted vault and the expected main UTXO",
                        () => {
                          let vault: FakeContract<IVault>
                          let tx: ContractTransaction

                          const previousData: DepositSweepTestData =
                            MultipleDepositsNoMainUtxo
                          const data: DepositSweepTestData =
                            MultipleDepositsWithMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Make the first sweep which is actually the predecessor
                            // of the sweep tested within this scenario.
                            await runDepositSweepScenario(previousData)

                            // Deploy a fake vault and mark it as trusted.
                            vault = await smock.fake<IVault>("IVault")
                            await bridgeGovernance
                              .connect(governance)
                              .setVaultStatus(vault.address, true)

                            // Enrich the test data with the vault parameter.
                            const dataWithVault: DepositSweepTestData =
                              JSON.parse(JSON.stringify(data))
                            dataWithVault.vault = vault.address
                            dataWithVault.deposits[0].reveal.vault =
                              vault.address
                            dataWithVault.deposits[1].reveal.vault =
                              vault.address
                            dataWithVault.deposits[2].reveal.vault =
                              vault.address
                            dataWithVault.deposits[3].reveal.vault =
                              vault.address
                            dataWithVault.deposits[4].reveal.vault =
                              vault.address

                            tx = await runDepositSweepScenario(dataWithVault)
                          })

                          after(async () => {
                            vault.receiveBalanceIncrease.reset()

                            await restoreSnapshot()
                          })

                          it("should mark deposits as swept", async () => {
                            for (let i = 0; i < data.deposits.length; i++) {
                              // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                              const depositKey = ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32"],
                                [
                                  data.deposits[i].fundingTx.hash,
                                  data.deposits[i].reveal.fundingOutputIndex,
                                ]
                              )

                              // eslint-disable-next-line no-await-in-loop
                              const deposit = await bridge.deposits(depositKey)

                              expect(deposit.sweptAt).to.be.equal(
                                // eslint-disable-next-line no-await-in-loop
                                await lastBlockTime(),
                                `Deposit with index ${i} has an unexpected swept time`
                              )
                            }
                          })

                          it("should update main UTXO for the given wallet", async () => {
                            const { mainUtxoHash } = await bridge.wallets(
                              walletPubKeyHash
                            )

                            // Amount can be checked by opening the sweep tx in a Bitcoin
                            // testnet explorer. In this case, the sum of inputs is
                            // 4148000 satoshi and there is a fee of 2999 so the output
                            // value is 4145001.
                            const expectedMainUtxo =
                              ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32", "uint64"],
                                [data.sweepTx.hash, 0, 4145001]
                              )

                            expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
                          })

                          it("should not update the depositors balances", async () => {
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(0)

                            expect(
                              await bank.balanceOf(data.deposits[1].depositor)
                            ).to.be.equal(0)

                            expect(
                              await bank.balanceOf(data.deposits[2].depositor)
                            ).to.be.equal(0)

                            expect(
                              await bank.balanceOf(data.deposits[3].depositor)
                            ).to.be.equal(0)

                            expect(
                              await bank.balanceOf(data.deposits[4].depositor)
                            ).to.be.equal(0)
                          })

                          it("should update the vault's balance", async () => {
                            // The vault's balance should be increased by the
                            // sum of all swept deposits counted as follows:
                            //
                            // The sum of sweep tx inputs is 4148000 satoshi
                            // (including the main UTXO value). The output value
                            // is 4145001 so the sweep transaction fee is 2999.
                            // There are 5 deposits so the fee per deposit is 599
                            // and the indivisible remainder is 4 which means the
                            // last deposit should incur 603 satoshi. Each deposit
                            // should also incur the treasury fee whose initial
                            // value is 0.05% of the deposited amount. The
                            // final sum of all deposits is 3085456.
                            expect(
                              await bank.balanceOf(vault.address)
                            ).to.be.equal(3085456)
                          })

                          it("should call the vault's receiveBalanceIncrease function", async () => {
                            // The order of deposits is different that
                            // the order of inputs that refers them in
                            // the transaction.
                            expect(
                              vault.receiveBalanceIncrease
                            ).to.have.been.calledOnceWith(
                              [
                                data.deposits[2].depositor,
                                data.deposits[3].depositor,
                                data.deposits[1].depositor,
                                data.deposits[4].depositor,
                                data.deposits[0].depositor,
                              ],
                              [938931, 878961, 759021, 289256, 219287]
                            )
                          })

                          it("should transfer collected treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(2075)
                          })

                          it("should mark the previous main UTXO as spent", async () => {
                            const mainUtxoKey = ethers.utils.solidityKeccak256(
                              ["bytes32", "uint32"],
                              [
                                data.mainUtxo.txHash,
                                data.mainUtxo.txOutputIndex,
                              ]
                            )

                            expect(await bridge.spentMainUTXOs(mainUtxoKey)).to
                              .be.true
                          })

                          it("should emit DepositsSwept event", async () => {
                            await expect(tx)
                              .to.emit(bridge, "DepositsSwept")
                              .withArgs(walletPubKeyHash, data.sweepTx.hash)
                          })
                        }
                      )

                      context(
                        "when input vector consists only of revealed unswept deposits with a non-trusted vault and the expected main UTXO",
                        () => {
                          let vault: FakeContract<IVault>
                          let tx: ContractTransaction

                          const previousData: DepositSweepTestData =
                            MultipleDepositsNoMainUtxo
                          const data: DepositSweepTestData =
                            MultipleDepositsWithMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Make the first sweep which is actually the predecessor
                            // of the sweep tested within this scenario.
                            await runDepositSweepScenario(previousData)

                            // Deploy a fake vault and mark it as trusted.
                            vault = await smock.fake<IVault>("IVault")
                            await bridgeGovernance
                              .connect(governance)
                              .setVaultStatus(vault.address, true)

                            // Enrich the test data with the vault parameter.
                            const dataWithVault: DepositSweepTestData =
                              JSON.parse(JSON.stringify(data))
                            dataWithVault.vault = vault.address
                            dataWithVault.deposits[0].reveal.vault =
                              vault.address
                            dataWithVault.deposits[1].reveal.vault =
                              vault.address
                            dataWithVault.deposits[2].reveal.vault =
                              vault.address
                            dataWithVault.deposits[3].reveal.vault =
                              vault.address
                            dataWithVault.deposits[4].reveal.vault =
                              vault.address

                            // Mark the vault as non-trusted just before
                            // proof submission.
                            const beforeProofActions = async () => {
                              await bridgeGovernance
                                .connect(governance)
                                .setVaultStatus(vault.address, false)
                            }

                            tx = await runDepositSweepScenario(
                              dataWithVault,
                              beforeProofActions
                            )
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should mark deposits as swept", async () => {
                            for (let i = 0; i < data.deposits.length; i++) {
                              // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                              const depositKey = ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32"],
                                [
                                  data.deposits[i].fundingTx.hash,
                                  data.deposits[i].reveal.fundingOutputIndex,
                                ]
                              )

                              // eslint-disable-next-line no-await-in-loop
                              const deposit = await bridge.deposits(depositKey)

                              expect(deposit.sweptAt).to.be.equal(
                                // eslint-disable-next-line no-await-in-loop
                                await lastBlockTime(),
                                `Deposit with index ${i} has an unexpected swept time`
                              )
                            }
                          })

                          it("should update main UTXO for the given wallet", async () => {
                            const { mainUtxoHash } = await bridge.wallets(
                              walletPubKeyHash
                            )

                            // Amount can be checked by opening the sweep tx in a Bitcoin
                            // testnet explorer. In this case, the sum of inputs is
                            // 4148000 satoshi and there is a fee of 2999 so the output
                            // value is 4145001.
                            const expectedMainUtxo =
                              ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32", "uint64"],
                                [data.sweepTx.hash, 0, 4145001]
                              )

                            expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
                          })

                          it("should update the depositors balances", async () => {
                            // The sum of sweep tx inputs is 4148000 satoshi. The output
                            // value is 4145001 so the sweep transaction fee is 2999.
                            // There are 5 deposits so the fee per deposit is 599
                            // and the indivisible remainder is 4 which means the
                            // last deposit should incur 603 satoshi. Worth noting
                            // the order of deposits used by this test scenario
                            // data does not correspond to the order of sweep
                            // transaction inputs. Each deposit should also incur
                            // the treasury fee whose initial value is 0.05% of the
                            // deposited amount.

                            // Deposit with index 0 used as input with index 5
                            // in the sweep transaction. This is the last deposit
                            // (according to inputs order) and it should incur the
                            // remainder of the transaction fee.
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(219287)

                            // Deposit with index 1 used as input with index 3
                            // in the sweep transaction.
                            expect(
                              await bank.balanceOf(data.deposits[1].depositor)
                            ).to.be.equal(759021)

                            // Deposit with index 2 used as input with index 1
                            // in the sweep transaction.
                            expect(
                              await bank.balanceOf(data.deposits[2].depositor)
                            ).to.be.equal(938931)

                            // Deposit with index 3 used as input with index 2
                            // in the sweep transaction.
                            expect(
                              await bank.balanceOf(data.deposits[3].depositor)
                            ).to.be.equal(878961)

                            // Deposit with index 4 used as input with index 4
                            // in the sweep transaction.
                            expect(
                              await bank.balanceOf(data.deposits[4].depositor)
                            ).to.be.equal(289256)
                          })

                          it("should transfer collected treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(2075)
                          })

                          it("should mark the previous main UTXO as spent", async () => {
                            const mainUtxoKey = ethers.utils.solidityKeccak256(
                              ["bytes32", "uint32"],
                              [
                                data.mainUtxo.txHash,
                                data.mainUtxo.txOutputIndex,
                              ]
                            )

                            expect(await bridge.spentMainUTXOs(mainUtxoKey)).to
                              .be.true
                          })

                          it("should emit DepositsSwept event", async () => {
                            await expect(tx)
                              .to.emit(bridge, "DepositsSwept")
                              .withArgs(walletPubKeyHash, data.sweepTx.hash)
                          })
                        }
                      )

                      context(
                        "when input vector consists only of revealed unswept deposits with different trusted vaults and the expected main UTXO",
                        () => {
                          let vaultA: FakeContract<IVault>
                          let vaultB: FakeContract<IVault>
                          let tx: Promise<ContractTransaction>

                          const previousData: DepositSweepTestData =
                            MultipleDepositsNoMainUtxo
                          const data: DepositSweepTestData =
                            MultipleDepositsWithMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Make the first sweep which is actually the predecessor
                            // of the sweep tested within this scenario.
                            await runDepositSweepScenario(previousData)

                            // Deploy two fake vaults and mark them as trusted.
                            vaultA = await smock.fake<IVault>("IVault")
                            vaultB = await smock.fake<IVault>("IVault")
                            await bridgeGovernance
                              .connect(governance)
                              .setVaultStatus(vaultA.address, true)
                            await bridgeGovernance
                              .connect(governance)
                              .setVaultStatus(vaultB.address, true)

                            // Enrich the test data with the vault parameter.
                            const dataWithVault: DepositSweepTestData =
                              JSON.parse(JSON.stringify(data))
                            dataWithVault.vault = vaultA.address
                            dataWithVault.deposits[0].reveal.vault =
                              vaultA.address
                            dataWithVault.deposits[1].reveal.vault =
                              vaultA.address
                            dataWithVault.deposits[2].reveal.vault =
                              vaultB.address
                            dataWithVault.deposits[3].reveal.vault =
                              vaultB.address
                            dataWithVault.deposits[4].reveal.vault =
                              vaultA.address

                            tx = runDepositSweepScenario(dataWithVault)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should revert", async () => {
                            await expect(tx).to.be.revertedWith(
                              "Deposit should be routed to another vault"
                            )
                          })
                        }
                      )

                      context(
                        "when input vector consists only of revealed unswept deposits but there is no main UTXO since it is not expected",
                        () => {
                          let tx: ContractTransaction
                          const data: DepositSweepTestData =
                            MultipleDepositsNoMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            tx = await runDepositSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should mark deposits as swept", async () => {
                            for (let i = 0; i < data.deposits.length; i++) {
                              // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                              const depositKey = ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32"],
                                [
                                  data.deposits[i].fundingTx.hash,
                                  data.deposits[i].reveal.fundingOutputIndex,
                                ]
                              )

                              // eslint-disable-next-line no-await-in-loop
                              const deposit = await bridge.deposits(depositKey)

                              expect(deposit.sweptAt).to.be.equal(
                                // eslint-disable-next-line no-await-in-loop
                                await lastBlockTime(),
                                `Deposit with index ${i} has an unexpected swept time`
                              )
                            }
                          })

                          it("should update main UTXO for the given wallet", async () => {
                            const { mainUtxoHash } = await bridge.wallets(
                              walletPubKeyHash
                            )

                            // Amount can be checked by opening the sweep tx in a Bitcoin
                            // testnet explorer. In this case, the sum of inputs is
                            // 1060000 satoshi and there is a fee of 2000 so the output
                            // value is 1058000.
                            const expectedMainUtxo =
                              ethers.utils.solidityKeccak256(
                                ["bytes32", "uint32", "uint64"],
                                [data.sweepTx.hash, 0, 1058000]
                              )

                            expect(mainUtxoHash).to.be.equal(expectedMainUtxo)
                          })

                          it("should update the depositors balances", async () => {
                            // The sum of sweep tx inputs is 1060000 satoshi. The output
                            // value is 1058000 so the sweep transaction fee is 2000.
                            // There are 5 deposits so the fee per deposit is 400
                            // and there is no indivisible remainder. Each deposit
                            // should also incur the treasury fee whose initial
                            // value is 0.05% of the deposited amount.
                            expect(
                              await bank.balanceOf(data.deposits[0].depositor)
                            ).to.be.equal(29585)

                            expect(
                              await bank.balanceOf(data.deposits[1].depositor)
                            ).to.be.equal(9595)

                            expect(
                              await bank.balanceOf(data.deposits[2].depositor)
                            ).to.be.equal(209495)

                            expect(
                              await bank.balanceOf(data.deposits[3].depositor)
                            ).to.be.equal(369415)

                            expect(
                              await bank.balanceOf(data.deposits[4].depositor)
                            ).to.be.equal(439380)
                          })

                          it("should transfer collected treasury fee", async () => {
                            expect(
                              await bank.balanceOf(treasury.address)
                            ).to.be.equal(530)
                          })

                          it("should emit DepositsSwept event", async () => {
                            await expect(tx)
                              .to.emit(bridge, "DepositsSwept")
                              .withArgs(walletPubKeyHash, data.sweepTx.hash)
                          })
                        }
                      )

                      context(
                        "when input vector consists only of revealed unswept deposits but there is no main UTXO despite it is expected",
                        () => {
                          const previousData: DepositSweepTestData =
                            SingleP2WSHDeposit
                          const data: DepositSweepTestData = JSON.parse(
                            JSON.stringify(MultipleDepositsNoMainUtxo)
                          )
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } =
                            previousData.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Make the first sweep to create an on-chain expectation
                            // that the tested sweep will contain the main UTXO
                            // input.
                            await runDepositSweepScenario(previousData)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should revert", async () => {
                            // Use sweep data which doesn't reference the main UTXO.
                            // However, pass a correct main UTXO parameter in order
                            // to pass main UTXO validation in the contract.
                            data.mainUtxo = {
                              txHash: previousData.sweepTx.hash,
                              txOutputIndex: 0,
                              txOutputValue: 78000,
                            }

                            await expect(
                              runDepositSweepScenario(data)
                            ).to.be.revertedWith(
                              "Expected main UTXO not present in sweep transaction inputs"
                            )
                          })
                        }
                      )

                      context(
                        "when input vector contains a revealed but already swept deposit",
                        () => {
                          const data: DepositSweepTestData =
                            MultipleDepositsNoMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })

                            // Make a proper sweep to turn the tested deposits into
                            // the swept state.
                            await runDepositSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should revert", async () => {
                            // Main UTXO parameter must point to the properly
                            // made sweep to avoid revert at validation stage.
                            const mainUtxo = {
                              txHash: data.sweepTx.hash,
                              txOutputIndex: 0,
                              txOutputValue: 1058000,
                            }

                            // Try replaying the already done sweep.
                            await expect(
                              bridge
                                .connect(spvMaintainer)
                                .submitDepositSweepProof(
                                  data.sweepTx,
                                  data.sweepProof,
                                  mainUtxo,
                                  ethers.constants.AddressZero
                                )
                            ).to.be.revertedWith("Deposit already swept")
                          })
                        }
                      )

                      context(
                        "when input vector contains an unknown input",
                        () => {
                          const data: DepositSweepTestData =
                            MultipleDepositsWithMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal

                          before(async () => {
                            await createSnapshot()

                            // Simulate the wallet is a Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ...walletDraft,
                              state: walletState.Live,
                            })
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should revert", async () => {
                            // Used test data contains an actual main UTXO input
                            // but the previous action proof was not submitted on-chain
                            // so input is unknown from contract's perspective.
                            await expect(
                              runDepositSweepScenario(data)
                            ).to.be.revertedWith("Unknown input type")
                          })
                        }
                      )
                    })
                  }
                )

                context(
                  "when transaction fee exceeds the deposit transaction maximum fee",
                  () => {
                    const data: DepositSweepTestData = SingleP2SHDeposit
                    // Take wallet public key hash from first deposit. All
                    // deposits in same sweep batch should have the same value
                    // of that field.
                    const { walletPubKeyHash } = data.deposits[0].reveal

                    before(async () => {
                      await createSnapshot()

                      // Simulate the wallet is a Live one and is known in
                      // the system.
                      await bridge.setWallet(walletPubKeyHash, {
                        ...walletDraft,
                        state: walletState.Live,
                      })

                      // Set the deposit transaction maximum fee to a value much
                      // lower than the fee used by the test data transaction.
                      await bridge.setDepositTxMaxFee(100)
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should revert", async () => {
                      await expect(
                        runDepositSweepScenario(data)
                      ).to.be.revertedWith("'Transaction fee is too high")
                    })
                  }
                )
              })

              context("when main UTXO data are invalid", () => {
                const previousData: DepositSweepTestData =
                  MultipleDepositsNoMainUtxo
                const data: DepositSweepTestData = JSON.parse(
                  JSON.stringify(MultipleDepositsWithMainUtxo)
                )
                // Take wallet public key hash from first deposit. All
                // deposits in same sweep batch should have the same value
                // of that field.
                const { walletPubKeyHash } = data.deposits[0].reveal

                before(async () => {
                  await createSnapshot()

                  // Simulate the wallet is a Live one and is known in
                  // the system.
                  await bridge.setWallet(walletPubKeyHash, {
                    ...walletDraft,
                    state: walletState.Live,
                  })

                  // Make the first sweep which is actually the predecessor
                  // of the sweep tested within this scenario.
                  await runDepositSweepScenario(previousData)
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  // Forge the main UTXO parameter to force validation crash.
                  data.mainUtxo = NO_MAIN_UTXO

                  await expect(
                    runDepositSweepScenario(data)
                  ).to.be.revertedWith("Invalid main UTXO data")
                })
              })
            })

            context("when single output is neither P2PKH nor P2WPKH", () => {
              const data: DepositSweepTestData = SingleMainUtxoP2SHOutput

              before(async () => {
                await createSnapshot()
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(runDepositSweepScenario(data)).to.be.revertedWith(
                  "Output must be P2PKH or P2WPKH"
                )
              })
            })
          })

          context("when the single output is not 20-byte", () => {
            before(async () => {
              await createSnapshot()

              // Necessary to pass the proof validation.
              relay.getPrevEpochDifficulty.returns(20870012)
              relay.getCurrentEpochDifficulty.returns(20870012)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              // To test this case, an arbitrary transaction with single
              // P2WSH output is used. In that case, the wallet public key
              // hash will have a wrong length of 32 bytes. Used transaction:
              // https://live.blockcypher.com/btc-testnet/tx/af56cae479215c5e44a6a4db0eeb10a1abdd98020a6c01b9c26ea7b829aa2809
              const sweepTx = {
                version: "0x01000000",
                inputVector:
                  "0x01d32586237f6a832c3aa324bb83151e43e6cca2e4312d676f14" +
                  "dbbd6b1f04f4680100000000ffffffff",
                outputVector:
                  "0x012ea3090000000000220020af802a76c10b6a646fff8d358241" +
                  "c121c9be1c53628adb26bd6554631bfc7d8b",
                locktime: "0x00000000",
              }

              const sweepProof = {
                merkleProof:
                  "0xf09955dcfb05b1c369eb9f58b6e583e49f47b9b8d6e63537dcac" +
                  "10bf0cc5407d06e76ee2d75b5be5ec365a4c1272067b786d79a64d" +
                  "c015eb40dedd3c813f4dee40c149ee21036bba713d14b3c22454ef" +
                  "44c958293a015e9e186983f20c46d74a29ca5f705913e210229078" +
                  "af993e89d90bb731dab3c8cf8907d683ab60faca1866036118737e" +
                  "07aaa74d489e80f773b4d9ff2887a4855b805aaf1b5a7a1b0bf382" +
                  "be8dab2401ec758a705b648724f93d14c3b72ce4fb3cd7d414e8a1" +
                  "75ef173e",
                txIndexInBlock: 20,
                bitcoinHeaders:
                  "0x0000e020fbeb3a876746438f1fd793add061b0b7af2f88a387ee" +
                  "f5b38600000000000000933a0cec98a028727df04dafbbe691c8ad" +
                  "442351db7321c9f7cc169aa9f64a9a7af6f361cbcd001a65073028",
                coinbasePreimage:
                  "0xe774cd2615268932bf6124630c72313bd7f89f1a8ea2e18e09f1" +
                  "efefdb78b57c",
                coinbaseProof:
                  "0x1b37fa565263a660309b37f0388d9851bde7c555030091a511af" +
                  "3f76e547f998364e95feeb9b08f5792ed93641ee32ac35b6cc5d7a" +
                  "e003634203101f249628a72a30e79e606506ca0c8603f2ad5f8bcf" +
                  "94b16de2dda71889317fbb1d370863e0cf4e8b68b37a1d56d186b1" +
                  "d0937333b5e219a5aeac722cab81dcf99dbf44c0063190440e6a92" +
                  "4fd5622bd7c1e192a8413dabc931f974fde0e2d8bd0dda33264182" +
                  "be8dab2401ec758a705b648724f93d14c3b72ce4fb3cd7d414e8a1" +
                  "75ef173e",
              }

              await expect(
                bridge
                  .connect(spvMaintainer)
                  .submitDepositSweepProof(
                    sweepTx,
                    sweepProof,
                    NO_MAIN_UTXO,
                    ethers.constants.AddressZero
                  )
              ).to.be.revertedWith(
                "Output's public key hash must have 20 bytes"
              )
            })
          })
        })

        context("when output count is other than one", () => {
          before(async () => {
            await createSnapshot()

            // Necessary to pass the proof validation.
            relay.getCurrentEpochDifficulty.returns(1)
            relay.getPrevEpochDifficulty.returns(1)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // To test this case, an arbitrary transaction with two
            // outputs is used. Used transaction:
            // https://live.blockcypher.com/btc-testnet/tx/c580e0e352570d90e303d912a506055ceeb0ee06f97dce6988c69941374f5479
            const sweepTx = {
              version: "0x01000000",
              inputVector:
                "0x011d9b71144a3ddbb56dd099ee94e6dd8646d7d1eb37fe1195367e6f" +
                "a844a388e7010000006a47304402206f8553c07bcdc0c3b90631188810" +
                "3d623ca9096ca0b28b7d04650a029a01fcf9022064cda02e39e65ace71" +
                "2029845cfcf58d1b59617d753c3fd3556f3551b609bbb00121039d61d6" +
                "2dcd048d3f8550d22eb90b4af908db60231d117aeede04e7bc11907bfa" +
                "ffffffff",
              outputVector:
                "0x02204e00000000000017a9143ec459d0f3c29286ae5df5fcc421e278" +
                "6024277e87a6c2140000000000160014e257eccafbc07c381642ce6e7e" +
                "55120fb077fbed",
              locktime: "0x00000000",
            }

            const sweepProof = {
              merkleProof:
                "0x161d24e53fc61db783f0271d45ef43b76e69fc975cf38decbba654ae" +
                "3d09f5d1a060c3448c0c06ededa9749e559ffa65e2d5f3abac749b278e" +
                "1189aa5b49a499b032963ea3fad337c4a9c8df4e748865503b5aea083f" +
                "b32efe4dca057a741a020790cde5b50acc2cdbd231e43594036388f1e5" +
                "d20ebba319465c56e85bf4e4b4f8b7276402b6c114000c59149494f852" +
                "84507c253bbc505fec7ea50f370aa150",
              txIndexInBlock: 8,
              bitcoinHeaders:
                "0x00000020fbee5222c9fc99c8071cee3fed39b4c0d39f41075469ce9f" +
                "52000000000000003fd9c72d0611b373ce2b1996e0ebb8bc36dc12d431" +
                "cae5b9371f343111f3d7519015da61ffff001dbddfb528000040208a9f" +
                "e49585b4cd8a94daeeb926c6f1e96151c74ae1ae0b18c6a6d564000000" +
                "0065c05d9ea40cace1b6b0ad0b8a9a18646096b54484fbdd96b1596560" +
                "f6999194a815da612ac0001a2e4c6405",
              coinbasePreimage:
                "0x35175fcdae1fc3d708454466b4512536495526328679c1eb65d6068d" +
                "f25119a9",
              coinbaseProof:
                "0x6c4b2539848240a0e5ebe398adb6f1e12b6c097055b50f7421fe9a33" +
                "1129b11f14c82d817a4f9ca5c6713f8a2d660f7f4364833c5a8452d1fb" +
                "f0529c889bec6b20fc2c08cfba8c87c53db2595c19a6721968bb858ea8" +
                "4da7e0dbcb9647fa55054cd5775e08a11ad69238c23f9d5a4349672691" +
                "b6d7a9b04462a16bb3dc7ab4b0f8b7276402b6c114000c59149494f852" +
                "84507c253bbc505fec7ea50f370aa150",
            }

            await expect(
              bridge
                .connect(spvMaintainer)
                .submitDepositSweepProof(
                  sweepTx,
                  sweepProof,
                  NO_MAIN_UTXO,
                  ethers.constants.AddressZero
                )
            ).to.be.revertedWith("Sweep transaction must have a single output")
          })
        })
      })

      context("when transaction proof is not valid", () => {
        context("when input vector is not valid", () => {
          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()

            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Corrupt the input vector by setting a compactSize uint claiming
            // there is no inputs at all.
            data.sweepTx.inputVector =
              "0x0079544f374199c68869ce7df906eeb0ee5c0506a512d903e3900d5752" +
              "e3e080c500000000c847304402205eff3ae003a5903eb33f32737e3442b6" +
              "516685a1addb19339c2d02d400cf67ce0220707435fc2a0577373c63c99d" +
              "242c30bea5959ec180169978d43ece50618fe0ff012103989d253b17a6a0" +
              "f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d94c5c14934b" +
              "98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576" +
              "a9148db50eb52063ea9d98b3eac91489a90f738986f68763ac6776a914e2" +
              "57eccafbc07c381642ce6e7e55120fb077fbed8804e0250162b175ac68ff" +
              "ffffff"

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Invalid input vector provided"
            )
          })
        })

        context("when output vector is not valid", () => {
          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()

            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Corrupt the output vector by setting a compactSize uint claiming
            // there is no outputs at all.
            data.sweepTx.outputVector =
              "0x0044480000000000001600148db50eb52063ea9d98b3eac91489a90f73" +
              "8986f6"

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Invalid output vector provided"
            )
          })
        })

        context(
          "when transaction is not on same level of merkle tree as coinbase",
          () => {
            const data: DepositSweepTestData = JSON.parse(
              JSON.stringify(SingleP2SHDeposit)
            )
            // Take wallet public key hash from first deposit. All
            // deposits in same sweep batch should have the same value
            // of that field.
            const { walletPubKeyHash } = data.deposits[0].reveal

            before(async () => {
              await createSnapshot()

              // Simulate the wallet is a Live one and is known in
              // the system.
              await bridge.setWallet(walletPubKeyHash, {
                ...walletDraft,
                state: walletState.Live,
              })
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              // Simulate that the proven transaction is deeper in the merkle tree
              // than the coinbase. This is achieved by appending additional
              // hashes to the merkle proof.
              data.sweepProof.merkleProof +=
                ethers.utils.sha256("0x01").substring(2) +
                ethers.utils.sha256("0x02").substring(2)

              await expect(runDepositSweepScenario(data)).to.be.revertedWith(
                "Tx not on same level of merkle tree as coinbase"
              )
            })
          }
        )

        context("when merkle proof is not valid", () => {
          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()

            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Corrupt the merkle proof by changing tx index in block to an
            // invalid one. The proper one is 36 so any other will do the trick.
            data.sweepProof.txIndexInBlock = 30

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Tx merkle proof is not valid for provided header and tx hash"
            )
          })
        })

        context("when coinbase merkle proof is not valid", () => {
          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()

            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Corrupt the coinbase preimage.
            data.sweepProof.coinbasePreimage = ethers.utils.sha256(
              data.sweepProof.coinbasePreimage
            )

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Coinbase merkle proof is not valid for provided header and hash"
            )
          })
        })

        context("when proof difficulty is not current nor previous", () => {
          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()

            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // To pass the proof validation, the difficulty returned by the relay
            // must be 22350181 for test data used in this scenario. Setting
            // a different value will cause difficulty comparison failure.
            data.chainDifficulty = 1

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Not at current or previous difficulty"
            )
          })
        })

        context("when headers chain length is not valid", () => {
          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()

            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Corrupt the bitcoin headers length in the sweep proof. The proper
            // value is length divisible by 80 so any length violating this
            // rule will cause failure. In this case, we just remove the last
            // byte from proper headers chain.
            const properHeaders = data.sweepProof.bitcoinHeaders.toString()
            data.sweepProof.bitcoinHeaders = properHeaders.substring(
              0,
              properHeaders.length - 2
            )

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Invalid length of the headers chain"
            )
          })
        })

        context("when headers chain is not valid", () => {
          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()

            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Bitcoin headers must form a chain to pass the proof validation.
            // That means the `previous block hash` encoded in the given block
            // header must match the actual previous header's hash. To test
            // that scenario, we corrupt the `previous block hash` of the
            // second header. Each header is 80 bytes length. First 4 bytes
            // of each header is `version` and 32 subsequent bytes is
            // `previous block hash`. Changing byte 85 of the whole chain will
            // do the work.
            const properHeaders = data.sweepProof.bitcoinHeaders.toString()
            data.sweepProof.bitcoinHeaders = `${properHeaders.substring(
              0,
              170
            )}ff${properHeaders.substring(172)}`

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Invalid headers chain"
            )
          })
        })

        context("when the work in the header is insufficient", () => {
          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()
            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Each header encodes a `difficulty target` field in bytes 72-76.
            // The given header's hash (interpreted as uint) must be bigger than
            // the `difficulty target`. To test this scenario, we change the
            // last byte of the last header in such a way their hash becomes
            // lower than their `difficulty target`.
            const properHeaders = data.sweepProof.bitcoinHeaders.toString()
            data.sweepProof.bitcoinHeaders = `${properHeaders.substring(
              0,
              properHeaders.length - 2
            )}ff`

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Insufficient work in a header"
            )
          })
        })

        context(
          "when accumulated difficulty in headers chain is insufficient",
          () => {
            let otherBridge: Bridge & BridgeStub
            const data: DepositSweepTestData = JSON.parse(
              JSON.stringify(SingleP2SHDeposit)
            )
            // Take wallet public key hash from first deposit. All
            // deposits in same sweep batch should have the same value
            // of that field.
            const { walletPubKeyHash } = data.deposits[0].reveal

            before(async () => {
              await createSnapshot()

              // Simulate the wallet is a Live one and is known in
              // the system.
              await bridge.setWallet(walletPubKeyHash, {
                ...walletDraft,
                state: walletState.Live,
              })

              // Necessary to pass the first part of proof validation.
              relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
              relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

              // Deploy another bridge which has higher `txProofDifficultyFactor`
              // than the original bridge. That means it will need 12 confirmations
              // to deem transaction proof validity. This scenario uses test
              // data which has only 6 confirmations. That should force the
              // failure we expect within this scenario.
              otherBridge = (await deployBridge(12))[0] as BridgeStub
              await otherBridge.setSpvMaintainerStatus(
                spvMaintainer.address,
                true
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                otherBridge
                  .connect(spvMaintainer)
                  .submitDepositSweepProof(
                    data.sweepTx,
                    data.sweepProof,
                    data.mainUtxo,
                    ethers.constants.AddressZero
                  )
              ).to.be.revertedWith(
                "Insufficient accumulated difficulty in header chain"
              )
            })
          }
        )

        context("when transaction data is limited to 64 bytes", () => {
          // This test proves it is impossible to construct a valid proof if
          // the transaction data (version, locktime, inputs, outputs)
          // length is 64 bytes or less.

          const data: DepositSweepTestData = JSON.parse(
            JSON.stringify(SingleP2SHDeposit)
          )
          // Take wallet public key hash from first deposit. All
          // deposits in same sweep batch should have the same value
          // of that field.
          const { walletPubKeyHash } = data.deposits[0].reveal

          before(async () => {
            await createSnapshot()

            // Simulate the wallet is a Live one and is known in
            // the system.
            await bridge.setWallet(walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            // Modify the `sweepTx` part of test data in such a way so it is only
            // 64 bytes in length and correctly passes as many SPV proof checks as
            // possible.
            data.sweepTx.version = "0x01000000" // 4 bytes
            data.sweepTx.locktime = "0x00000000" // 4 bytes

            // 42 bytes at minimum to pass input formatting validation (1 byte
            // for inputs length, 32 bytes for tx hash, 4 bytes for tx index,
            // 1 byte for script sig length, 4 bytes for sequence number).
            data.sweepTx.inputVector =
              "0x01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
              "aaaaaa1111111100ffffffff"

            // 32 bytes at minimum to pass output formatting validation and the
            // output script check (1 byte for outputs length, 8 bytes for
            // output amount, 23 bytes for length-prefixed output script -
            // `submitDepositSweepProof` checks that the output contains
            // a 23-byte or 26-byte long script). Since 50 bytes has already been
            // used on version, locktime and inputs, the output must be shortened
            // to 14 bytes, so that the total transaction length is 64 bytes.
            data.sweepTx.outputVector = "0x01aaaaaaaaaaaaaaaa160014bbbb"

            await expect(runDepositSweepScenario(data)).to.be.revertedWith(
              "Invalid output vector provided"
            )
          })
        })
      })
    })

    context("when the wallet state is MovingFunds", () => {
      // The execution of `submitDepositSweepProof` is the same for wallets in
      // `MovingFunds` state as for the ones in `Live` state. Therefore the
      // testing of `MovingFunds` state is limited to just one simple test case
      // (sweeping single P2SH deposit).
      const data: DepositSweepTestData = SingleP2SHDeposit
      const { fundingTx, depositor, reveal } = data.deposits[0]

      before(async () => {
        await createSnapshot()

        // Initially set the state to Live, so that the deposit can be revealed
        await bridge.setWallet(reveal.walletPubKeyHash, {
          ...walletDraft,
          state: walletState.Live,
        })

        relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
        relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

        const depositorSigner = await impersonateAccount(depositor, {
          from: governance,
          value: 10,
        })
        await bridge.connect(depositorSigner).revealDeposit(fundingTx, reveal)

        // Simulate the wallet's state has changed to MovingFunds
        const wallet = await bridge.wallets(reveal.walletPubKeyHash)
        await bridge.setWallet(reveal.walletPubKeyHash, {
          ...wallet,
          state: walletState.MovingFunds,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed", async () => {
        await expect(
          bridge
            .connect(spvMaintainer)
            .submitDepositSweepProof(
              data.sweepTx,
              data.sweepProof,
              data.mainUtxo,
              ethers.constants.AddressZero
            )
        ).not.to.be.reverted
      })
    })

    context("when the wallet state is neither Live or MovingFunds", () => {
      const data: DepositSweepTestData = SingleP2SHDeposit
      const { fundingTx, depositor, reveal } = data.deposits[0]

      const testData = [
        {
          testName: "when wallet state is Unknown",
          walletState: walletState.Unknown,
        },
        {
          testName: "when wallet state is Closing",
          walletState: walletState.Closing,
        },
        {
          testName: "when wallet state is Closed",
          walletState: walletState.Closed,
        },
        {
          testName: "when wallet state is Terminated",
          walletState: walletState.Terminated,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          before(async () => {
            await createSnapshot()

            // Initially set the state to Live, so that the deposit can be revealed
            await bridge.setWallet(reveal.walletPubKeyHash, {
              ...walletDraft,
              state: walletState.Live,
            })

            relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
            relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

            const depositorSigner = await impersonateAccount(depositor, {
              from: governance,
              value: 10,
            })
            await bridge
              .connect(depositorSigner)
              .revealDeposit(fundingTx, reveal)

            // Simulate the wallet's state has changed
            const wallet = await bridge.wallets(reveal.walletPubKeyHash)
            await bridge.setWallet(reveal.walletPubKeyHash, {
              ...wallet,
              state: test.walletState,
            })
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge
                .connect(spvMaintainer)
                .submitDepositSweepProof(
                  data.sweepTx,
                  data.sweepProof,
                  data.mainUtxo,
                  ethers.constants.AddressZero
                )
            ).to.be.revertedWith("Wallet must be in Live or MovingFunds state")
          })
        })
      })
    })
  })

  async function runDepositSweepScenario(
    data: DepositSweepTestData,
    beforeProofActions?: () => Promise<void>
  ): Promise<ContractTransaction> {
    relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
    relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

    for (let i = 0; i < data.deposits.length; i++) {
      const { fundingTx, depositor, reveal } = data.deposits[i]

      // eslint-disable-next-line no-await-in-loop
      const depositorSigner = await impersonateAccount(depositor, {
        from: governance,
        value: 10,
      })

      // eslint-disable-next-line no-await-in-loop
      await bridge.connect(depositorSigner).revealDeposit(fundingTx, reveal)
    }

    if (beforeProofActions) {
      await beforeProofActions()
    }

    return bridge
      .connect(spvMaintainer)
      .submitDepositSweepProof(
        data.sweepTx,
        data.sweepProof,
        data.mainUtxo,
        data.vault
      )
  }
})
