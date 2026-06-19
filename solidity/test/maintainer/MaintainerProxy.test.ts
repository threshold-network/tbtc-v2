/* eslint-disable no-underscore-dangle */
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { SigningKey } from "ethers/lib/utils"
import { assert, expect } from "chai"
import { ContractTransaction, BigNumber, BigNumberish } from "ethers"
import type { FakeContract } from "@defi-wonderland/smock"
import { smock } from "@defi-wonderland/smock"

import { ecdsaWalletTestData } from "../data/ecdsa"
import type {
  BridgeStub,
  IWalletRegistry,
  Bank,
  BankStub,
  MaintainerProxy,
  ReimbursementPool,
  Bridge,
  BridgeGovernance,
  IRelay,
  IVault,
} from "../../typechain"

import {
  RedemptionTestData,
  SinglePendingRequestedRedemption,
  MultiplePendingRequestedRedemptions,
  MultiplePendingRequestedRedemptionsWithP2WPKHChange,
} from "../data/redemption"

import {
  MultipleDepositsNoMainUtxo,
  MultipleDepositsWithMainUtxo,
  NO_MAIN_UTXO,
  SingleP2SHDeposit,
  SingleP2WSHDeposit,
  DepositSweepTestData,
} from "../data/deposit-sweep"

import {
  wallet as fraudWallet,
  nonWitnessSignSingleInputTx,
  nonWitnessSignMultipleInputsTx,
  witnessSignSingleInputTx,
  witnessSignMultipleInputTx,
} from "../data/fraud"

import {
  MovedFundsSweepTestData,
  MovedFundsSweepWithMainUtxo,
  MovedFundsSweepWithoutMainUtxo,
  MovingFundsTestData,
  MultipleTargetWalletsAndDivisibleAmount,
  MultipleTargetWalletsAndIndivisibleAmount,
  SingleTargetWallet,
} from "../data/moving-funds"

import bridgeFixture from "../fixtures/bridge"
import { constants, walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { provider } = waffle
const { impersonateAccount } = helpers.account

const { lastBlockTime, increaseTime } = helpers.time
const { keccak256, sha256 } = ethers.utils

const { publicKey: walletPublicKey, pubKeyHash160: walletPublicKeyHash } =
  fraudWallet

// Most of the tests around specific bridge functionality were ported from the
// other tbtc-v2 tests suites and adjusted to check the refund functionality of
// the MaintainerProxy contract.
describe("MaintainerProxy", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let walletMaintainer: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress

  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let maintainerProxy: MaintainerProxy
  let reimbursementPool: ReimbursementPool
  let relay: FakeContract<IRelay>
  let walletRegistry: FakeContract<IWalletRegistry>
  let bank: Bank & BankStub

  let fraudChallengeDepositAmount: BigNumber
  let movingFundsTimeoutResetDelay: number

  let initialWalletMaintainerBalance: BigNumber
  let initialSpvMaintainerBalance: BigNumber

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      bridge,
      bridgeGovernance,
      maintainerProxy,
      relay,
      bank,
      reimbursementPool,
      maintainerProxy,
      deployer,
    } = await waffle.loadFixture(bridgeFixture))
    ;({ movingFundsTimeoutResetDelay } = await bridge.movingFundsParameters())

    walletRegistry = await smock.fake<IWalletRegistry>("IWalletRegistry", {
      address: (await bridge.contractReferences()).ecdsaWalletRegistry,
    })

    // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
    // the initial value in the Bridge in order to save test Bitcoins.
    // Scaling down deposit TX max fee as well.
    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(2000)
    // Disable the reveal ahead period since refund locktimes are fixed
    // within transactions used in this test suite.
    await bridge.setDepositRevealAheadPeriod(0)

    await deployer.sendTransaction({
      to: walletRegistry.address,
      value: ethers.utils.parseEther("100"),
    })

    await deployer.sendTransaction({
      to: reimbursementPool.address,
      value: ethers.utils.parseEther("100"),
    })
    ;({ fraudChallengeDepositAmount } = await bridge.fraudParameters())
    ;[thirdParty, walletMaintainer, spvMaintainer] =
      await helpers.signers.getUnnamedSigners()

    await maintainerProxy
      .connect(governance)
      .authorizeWalletMaintainer(walletMaintainer.address)
    await maintainerProxy
      .connect(governance)
      .authorizeSpvMaintainer(spvMaintainer.address)

    initialWalletMaintainerBalance = await provider.getBalance(
      walletMaintainer.address
    )
    initialSpvMaintainerBalance = await provider.getBalance(
      spvMaintainer.address
    )
  })

  describe("requestNewWallet", () => {
    context("when called by an unauthorized third party", () => {
      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        await expect(
          maintainerProxy.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context(
      "when called by an SPV maintainer that is not wallet maintainer",
      () => {
        // Even though transaction reverts some funds were spent.
        // We need to restore the state to keep the balances as initially.
        before(async () => createSnapshot())
        after(async () => restoreSnapshot())

        it("should revert", async () => {
          await expect(
            maintainerProxy
              .connect(spvMaintainer)
              .requestNewWallet(NO_MAIN_UTXO)
          ).to.be.revertedWith("Caller is not authorized")
        })
      }
    )

    context("when called by a wallet maintainer", async () => {
      const activeWalletMainUtxo = {
        txHash:
          "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
        txOutputIndex: 1,
        txOutputValue: constants.walletCreationMinBtcBalance,
      }

      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await maintainerProxy
          .connect(walletMaintainer)
          .requestNewWallet(activeWalletMainUtxo)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit NewWalletRequested event", async () => {
        await expect(tx).to.emit(bridge, "NewWalletRequested")
      })

      it("should refund ETH", async () => {
        const postMaintainerBalance = await provider.getBalance(
          walletMaintainer.address
        )
        const diff = postMaintainerBalance.sub(initialWalletMaintainerBalance)

        expect(diff).to.be.gt(0)
        expect(diff).to.be.lt(
          ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
        )
      })
    })
  })

  describe("submitDepositSweepProof", () => {
    before(async () => {
      await createSnapshot()

      const data: DepositSweepTestData = SingleP2SHDeposit
      // Take wallet public key hash from first deposit. All
      // deposits in same sweep batch should have the same value
      // of that field.
      const { walletPubKeyHash } = data.deposits[0].reveal

      await bridge.setWallet(walletPubKeyHash, {
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

    context("when called by an unauthorized third party", () => {
      const data: DepositSweepTestData = SingleP2SHDeposit

      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        const tx = maintainerProxy
          .connect(thirdParty)
          .submitDepositSweepProof(
            data.sweepTx,
            data.sweepProof,
            data.mainUtxo,
            data.vault
          )

        await expect(tx).to.be.revertedWith("Caller is not authorized")
      })
    })

    context(
      "when called by a wallet maintainer that is not SPV maintainer",
      () => {
        const data: DepositSweepTestData = SingleP2SHDeposit

        // Even though transaction reverts some funds were spent.
        // We need to restore the state to keep the balances as initially.
        before(async () => createSnapshot())
        after(async () => restoreSnapshot())

        it("should revert", async () => {
          const tx = maintainerProxy
            .connect(walletMaintainer)
            .submitDepositSweepProof(
              data.sweepTx,
              data.sweepProof,
              data.mainUtxo,
              data.vault
            )

          await expect(tx).to.be.revertedWith("Caller is not authorized")
        })
      }
    )

    context("when called by an SPV maintainer", () => {
      context("when there is only one input", () => {
        context(
          "when the single input is a revealed unswept P2SH deposit",
          () => {
            const data: DepositSweepTestData = SingleP2SHDeposit
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await runDepositSweepScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("1500000", "gwei") // 0,0015 ETH
              )
            })
          }
        )

        context(
          "when the single input is a revealed unswept P2WSH deposit",
          () => {
            const data: DepositSweepTestData = SingleP2WSHDeposit
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await runDepositSweepScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2100000", "gwei") // 0,002 ETH
              )
            })
          }
        )

        context(
          "when the single input is a revealed unswept deposit with a trusted vault",
          () => {
            const data: DepositSweepTestData = SingleP2WSHDeposit
            let vault: FakeContract<IVault>
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Deploy a fake vault and mark it as trusted.
              vault = await smock.fake<IVault>("IVault")
              await bridgeGovernance
                .connect(governance)
                .setVaultStatus(vault.address, true)

              // Enrich the test data with the vault parameter.
              const dataWithVault: DepositSweepTestData = JSON.parse(
                JSON.stringify(data)
              )
              dataWithVault.vault = vault.address
              dataWithVault.deposits[0].reveal.vault = vault.address

              tx = await runDepositSweepScenario(dataWithVault)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          }
        )

        context(
          "when the single input is a revealed unswept deposit with a non-trusted vault",
          () => {
            const data: DepositSweepTestData = SingleP2WSHDeposit
            let vault: FakeContract<IVault>
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Deploy a fake vault and mark it as trusted.
              vault = await smock.fake<IVault>("IVault")
              await bridgeGovernance
                .connect(governance)
                .setVaultStatus(vault.address, true)

              // Enrich the test data with the vault parameter.
              const dataWithVault: DepositSweepTestData = JSON.parse(
                JSON.stringify(data)
              )
              dataWithVault.vault = vault.address
              dataWithVault.deposits[0].reveal.vault = vault.address

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

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          }
        )
      })

      context("when there are multiple inputs", () => {
        context(
          "when input vector consists only of revealed unswept " +
            "deposits and the expected main UTXO",
          () => {
            const previousData: DepositSweepTestData =
              MultipleDepositsNoMainUtxo
            const data: DepositSweepTestData = MultipleDepositsWithMainUtxo
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Make the first sweep which is actually the predecessor
              // of the sweep tested within this scenario.
              await runDepositSweepScenario(previousData)

              tx = await runDepositSweepScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
              )
            })
          }
        )

        context(
          "when input vector consists only of revealed unswept deposits with a " +
            "trusted vault and the expected main UTXO",
          () => {
            const previousData: DepositSweepTestData =
              MultipleDepositsNoMainUtxo
            const data: DepositSweepTestData = MultipleDepositsWithMainUtxo
            let vault: FakeContract<IVault>
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Make the first sweep which is actually the predecessor
              // of the sweep tested within this scenario.
              await runDepositSweepScenario(previousData)

              // Deploy a fake vault and mark it as trusted.
              vault = await smock.fake<IVault>("IVault")
              await bridgeGovernance
                .connect(governance)
                .setVaultStatus(vault.address, true)

              // Enrich the test data with the vault parameter.
              const dataWithVault: DepositSweepTestData = JSON.parse(
                JSON.stringify(data)
              )
              dataWithVault.vault = vault.address
              dataWithVault.deposits[0].reveal.vault = vault.address
              dataWithVault.deposits[1].reveal.vault = vault.address
              dataWithVault.deposits[2].reveal.vault = vault.address
              dataWithVault.deposits[3].reveal.vault = vault.address
              dataWithVault.deposits[4].reveal.vault = vault.address

              tx = await runDepositSweepScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
              )
            })
          }
        )

        context(
          "when input vector consists only of revealed unswept deposits with a non-trusted vault and the expected main UTXO",
          () => {
            const previousData: DepositSweepTestData =
              MultipleDepositsNoMainUtxo
            const data: DepositSweepTestData = MultipleDepositsWithMainUtxo
            let vault: FakeContract<IVault>
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Make the first sweep which is actually the predecessor
              // of the sweep tested within this scenario.
              await runDepositSweepScenario(previousData)

              // Deploy a fake vault and mark it as trusted.
              vault = await smock.fake<IVault>("IVault")
              await bridgeGovernance
                .connect(governance)
                .setVaultStatus(vault.address, true)

              // Enrich the test data with the vault parameter.
              const dataWithVault: DepositSweepTestData = JSON.parse(
                JSON.stringify(data)
              )
              dataWithVault.vault = vault.address
              dataWithVault.deposits[0].reveal.vault = vault.address
              dataWithVault.deposits[1].reveal.vault = vault.address
              dataWithVault.deposits[2].reveal.vault = vault.address
              dataWithVault.deposits[3].reveal.vault = vault.address
              dataWithVault.deposits[4].reveal.vault = vault.address

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

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2100000", "gwei") // 0,0021 ETH
              )
            })
          }
        )

        context(
          "when input vector consists only of revealed unswept deposits with different trusted vaults and the expected main UTXO",
          () => {
            const previousData: DepositSweepTestData =
              MultipleDepositsNoMainUtxo
            const data: DepositSweepTestData = MultipleDepositsWithMainUtxo
            let vaultA: FakeContract<IVault>
            let vaultB: FakeContract<IVault>
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

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
              const dataWithVault: DepositSweepTestData = JSON.parse(
                JSON.stringify(data)
              )
              dataWithVault.vault = vaultA.address
              dataWithVault.deposits[0].reveal.vault = vaultA.address
              dataWithVault.deposits[1].reveal.vault = vaultA.address
              dataWithVault.deposits[2].reveal.vault = vaultB.address
              dataWithVault.deposits[3].reveal.vault = vaultB.address
              dataWithVault.deposits[4].reveal.vault = vaultA.address

              tx = await runDepositSweepScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
              )
            })
          }
        )

        context(
          "when input vector consists only of revealed unswept " +
            "deposits but there is no main UTXO since it is not expected",
          () => {
            const data: DepositSweepTestData = MultipleDepositsNoMainUtxo
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await runDepositSweepScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositSwept event", async () => {
              await expect(tx).to.emit(bridge, "DepositsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
              )
            })
          }
        )
      })
    })
  })

  describe("submitRedemptionProof", () => {
    let redemptionTimeout: BigNumber

    before(async () => {
      redemptionTimeout = BigNumber.from(
        (await bridge.redemptionParameters()).redemptionTimeout
      )
    })

    context("when called by an unauthorized third party", () => {
      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        const data: RedemptionTestData = SinglePendingRequestedRedemption
        const tx = maintainerProxy
          .connect(thirdParty)
          .submitRedemptionProof(
            data.redemptionTx,
            data.redemptionProof,
            data.mainUtxo,
            data.wallet.pubKeyHash
          )
        await expect(tx).to.be.revertedWith("Caller is not authorized")
      })
    })

    context(
      "when called by a wallet maintainer that is not SPV maintainer",
      () => {
        // Even though transaction reverts some funds were spent.
        // We need to restore the state to keep the balances as initially.
        before(async () => createSnapshot())
        after(async () => restoreSnapshot())

        it("should revert", async () => {
          const data: RedemptionTestData = SinglePendingRequestedRedemption
          const tx = maintainerProxy
            .connect(walletMaintainer)
            .submitRedemptionProof(
              data.redemptionTx,
              data.redemptionProof,
              data.mainUtxo,
              data.wallet.pubKeyHash
            )
          await expect(tx).to.be.revertedWith("Caller is not authorized")
        })
      }
    )

    context("when called by an SPV maintainer", async () => {
      context("when there is only one output", () => {
        context(
          "when the single output is a pending requested redemption",
          () => {
            const data: RedemptionTestData = SinglePendingRequestedRedemption
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Simulate the situation when treasury fee is 0% to
              // allow using the whole wallet's main UTXO value
              // to fulfill the redemption request.
              const beforeRequestActions = async () => {
                await bridge.setRedemptionTreasuryFeeDivisor(0)
              }

              // eslint-disable-next-line @typescript-eslint/no-extra-semi
              tx = await runRedemptionScenario(data, beforeRequestActions)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("3500000", "gwei") // 0,0035 ETH
              )
            })
          }
        )

        context(
          "when the single output is a non-reported timed out requested redemption",
          () => {
            const data: RedemptionTestData = SinglePendingRequestedRedemption
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Simulate the situation when treasury fee is 0% to
              // allow using the whole wallet's main UTXO value
              // to fulfill the redemption request.
              const beforeRequestActions = async () => {
                await bridge.setRedemptionTreasuryFeeDivisor(0)
              }

              // Before submitting the redemption proof, wait
              // an amount of time that will make the request
              // timed out though don't report the timeout.
              const beforeProofActions = async () => {
                await increaseTime(redemptionTimeout)
              }

              // eslint-disable-next-line @typescript-eslint/no-extra-semi
              tx = await runRedemptionScenario(
                data,
                beforeRequestActions,
                beforeProofActions
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("3500000", "gwei") // 0,0035 ETH
              )
            })
          }
        )

        context(
          "when the single output is a reported timed out requested redemption",
          () => {
            const data: RedemptionTestData = SinglePendingRequestedRedemption
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Simulate the situation when treasury fee is 0% to
              // allow using the whole wallet's main UTXO value
              // to fulfill the redemption request.
              const beforeRequestActions = async () => {
                await bridge.setRedemptionTreasuryFeeDivisor(0)
              }

              // Before submitting the redemption proof, wait
              // an amount of time that will make the request
              // timed out and then report the timeout.
              const beforeProofActions = async () => {
                await increaseTime(redemptionTimeout)
                await bridge.notifyRedemptionTimeout(
                  data.wallet.pubKeyHash,
                  [],
                  data.redemptionRequests[0].redeemerOutputScript
                )
              }

              // eslint-disable-next-line @typescript-eslint/no-extra-semi
              tx = await runRedemptionScenario(
                data,
                beforeRequestActions,
                beforeProofActions
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          }
        )
      })

      context("when there are multiple outputs", () => {
        context(
          "when output vector consists only of pending requested redemptions",
          () => {
            const data: RedemptionTestData = MultiplePendingRequestedRedemptions
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Simulate the situation when treasury fee is 0% to
              // allow using the whole wallet's main UTXO value
              // to fulfill the redemption requests.
              const beforeRequestActions = async () => {
                await bridge.setRedemptionTreasuryFeeDivisor(0)
              }

              // eslint-disable-next-line @typescript-eslint/no-extra-semi
              tx = await runRedemptionScenario(data, beforeRequestActions)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("8200000", "gwei") // 0,0082 ETH
              )
            })
          }
        )

        context(
          "when output vector consists of pending requested redemptions and a non-zero change",
          () => {
            const data: RedemptionTestData =
              MultiplePendingRequestedRedemptionsWithP2WPKHChange
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // eslint-disable-next-line @typescript-eslint/no-extra-semi
              tx = await runRedemptionScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )

              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )
              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("9000000", "gwei") // 0,009 ETH
              )
            })
          }
        )

        context(
          "when output vector consists only of reported timed out requested redemptions",
          () => {
            const data: RedemptionTestData = MultiplePendingRequestedRedemptions
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Simulate the situation when treasury fee is 0% to
              // allow using the whole wallet's main UTXO value
              // to fulfill the redemption requests.
              const beforeRequestActions = async () => {
                await bridge.setRedemptionTreasuryFeeDivisor(0)
              }

              // Before submitting the redemption proof, wait
              // an amount of time that will make the requests
              // timed out and then report the timeouts.
              const beforeProofActions = async () => {
                await increaseTime(redemptionTimeout)

                for (let i = 0; i < data.redemptionRequests.length; i++) {
                  // eslint-disable-next-line no-await-in-loop
                  await bridge.notifyRedemptionTimeout(
                    data.wallet.pubKeyHash,
                    [],
                    data.redemptionRequests[i].redeemerOutputScript
                  )
                }
              }

              // eslint-disable-next-line @typescript-eslint/no-extra-semi
              tx = await runRedemptionScenario(
                data,
                beforeRequestActions,
                beforeProofActions
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              // The submitter deletes from `timedOutRedemptions` mapping
              // multiple times in this scenario. They will end up being more
              // net-positive than in all other scenarios.
              // Such a situation is quite unlikely to happen in practice.
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("10000000", "gwei") // 0,01 ETH
              )
            })
          }
        )

        context(
          "when output vector consists of reported timed out requested redemptions and a non-zero change",
          () => {
            const data: RedemptionTestData =
              MultiplePendingRequestedRedemptionsWithP2WPKHChange
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Before submitting the redemption proof, wait
              // an amount of time that will make the requests
              // timed out and then report the timeouts.
              const beforeProofActions = async () => {
                await increaseTime(redemptionTimeout)

                for (let i = 0; i < data.redemptionRequests.length; i++) {
                  // eslint-disable-next-line no-await-in-loop
                  await bridge.notifyRedemptionTimeout(
                    data.wallet.pubKeyHash,
                    [],
                    data.redemptionRequests[i].redeemerOutputScript
                  )
                }
              }

              // eslint-disable-next-line @typescript-eslint/no-extra-semi
              tx = await runRedemptionScenario(
                data,
                undefined,
                beforeProofActions
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              // The submitter deletes from `timedOutRedemptions` mapping
              // multiple times in this scenario. They will end up being more
              // net-positive than in all other scenarios.
              // Such a situation is quite unlikely to happen in practice.
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("10000000", "gwei") // 0,01 ETH
              )
            })
          }
        )

        context(
          "when output vector consists of pending requested redemptions and reported timed out requested redemptions",
          () => {
            const data: RedemptionTestData = MultiplePendingRequestedRedemptions
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Simulate the situation when treasury fee is 0% to
              // allow using the whole wallet's main UTXO value
              // to fulfill the redemption requests.
              const beforeRequestActions = async () => {
                await bridge.setRedemptionTreasuryFeeDivisor(0)
              }

              // Before submitting the redemption proof, wait
              // an amount of time that will make the requests
              // timed out but report timeout only the two first
              // requests.
              const beforeProofActions = async () => {
                await increaseTime(redemptionTimeout)

                await bridge.notifyRedemptionTimeout(
                  data.wallet.pubKeyHash,
                  [],
                  data.redemptionRequests[0].redeemerOutputScript
                )
                await bridge.notifyRedemptionTimeout(
                  data.wallet.pubKeyHash,
                  [],
                  data.redemptionRequests[1].redeemerOutputScript
                )
              }

              tx = await runRedemptionScenario(
                data,
                beforeRequestActions,
                beforeProofActions
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("7000000", "gwei") // 0,007 ETH
              )
            })
          }
        )

        context(
          "when output vector consists of pending requested redemptions, reported timed out requested redemptions and a non-zero change",
          () => {
            const data: RedemptionTestData =
              MultiplePendingRequestedRedemptionsWithP2WPKHChange
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              // Before submitting the redemption proof, wait
              // an amount of time that will make the requests
              // timed out but report timeout only the two first
              // requests.
              const beforeProofActions = async () => {
                await increaseTime(redemptionTimeout)

                await bridge.notifyRedemptionTimeout(
                  data.wallet.pubKeyHash,
                  [],
                  data.redemptionRequests[0].redeemerOutputScript
                )
                await bridge.notifyRedemptionTimeout(
                  data.wallet.pubKeyHash,
                  [],
                  data.redemptionRequests[1].redeemerOutputScript
                )
              }

              tx = await runRedemptionScenario(
                data,
                undefined,
                beforeProofActions
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit RedemptionsCompleted event", async () => {
              await expect(tx).to.emit(bridge, "RedemptionsCompleted")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                // Keep a small headroom for minor gas/refund variance across environments.
                ethers.utils.parseUnits("7200000", "gwei") // 0.0072 ETH
              )
            })
          }
        )
      })
    })
  })

  describe("notifyWalletCloseable", () => {
    context("when called by an unauthorized third party", () => {
      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .notifyWalletCloseable(
              ecdsaWalletTestData.pubKeyHash160,
              NO_MAIN_UTXO
            )
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context(
      "when called by an SPV maintainer that is not wallet maintainer",
      () => {
        // Even though transaction reverts some funds were spent.
        // We need to restore the state to keep the balances as initially.
        before(async () => createSnapshot())
        after(async () => restoreSnapshot())

        it("should revert", async () => {
          await expect(
            maintainerProxy
              .connect(spvMaintainer)
              .notifyWalletCloseable(
                ecdsaWalletTestData.pubKeyHash160,
                NO_MAIN_UTXO
              )
          ).to.be.revertedWith("Caller is not authorized")
        })
      }
    )

    context("when called by a wallet maintainer", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ecdsaWalletID: ecdsaWalletTestData.walletID,
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

      context("when wallet reached the maximum age", () => {
        before(async () => {
          await createSnapshot()

          await increaseTime((await bridge.walletParameters()).walletMaxAge)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when wallet balance is zero", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            tx = await maintainerProxy
              .connect(walletMaintainer)
              .notifyWalletCloseable(
                ecdsaWalletTestData.pubKeyHash160,
                NO_MAIN_UTXO
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit WalletClosing event", async () => {
            await expect(tx).to.emit(bridge, "WalletClosing")
          })

          it("should refund ETH", async () => {
            const postMaintainerBalance = await provider.getBalance(
              walletMaintainer.address
            )
            const diff = postMaintainerBalance.sub(
              initialWalletMaintainerBalance
            )

            expect(diff).to.be.gt(0)
            expect(diff).to.be.lt(
              ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
            )
          })
        })

        context("when wallet balance is greater than zero", () => {
          const walletMainUtxo = {
            txHash:
              "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
            txOutputIndex: 0,
            txOutputValue: 1,
          }

          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await bridge.setWalletMainUtxo(
              ecdsaWalletTestData.pubKeyHash160,
              walletMainUtxo
            )

            tx = await maintainerProxy
              .connect(walletMaintainer)
              .notifyWalletCloseable(
                ecdsaWalletTestData.pubKeyHash160,
                walletMainUtxo
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit WalletMovingFunds event", async () => {
            await expect(tx).to.emit(bridge, "WalletMovingFunds")
          })

          it("should refund ETH", async () => {
            const postMaintainerBalance = await provider.getBalance(
              walletMaintainer.address
            )
            const diff = postMaintainerBalance.sub(
              initialWalletMaintainerBalance
            )

            expect(diff).to.be.gt(0)
            expect(diff).to.be.lt(
              ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
            )
          })
        })
      })

      context(
        "when wallet did not reach the maximum age but their balance is lesser than the minimum threshold",
        () => {
          context("when wallet balance is zero", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await maintainerProxy
                .connect(walletMaintainer)
                .notifyWalletCloseable(
                  ecdsaWalletTestData.pubKeyHash160,
                  NO_MAIN_UTXO
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit WalletClosing event", async () => {
              await expect(tx).to.emit(bridge, "WalletClosing")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                walletMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialWalletMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          })

          context("when wallet balance is greater than zero", () => {
            const walletMainUtxo = {
              txHash:
                "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
              txOutputIndex: 0,
              txOutputValue: constants.walletClosureMinBtcBalance.sub(1),
            }

            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              await bridge.setWalletMainUtxo(
                ecdsaWalletTestData.pubKeyHash160,
                walletMainUtxo
              )

              tx = await maintainerProxy
                .connect(walletMaintainer)
                .notifyWalletCloseable(
                  ecdsaWalletTestData.pubKeyHash160,
                  walletMainUtxo
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit WalletMovingFunds event", async () => {
              await expect(tx).to.emit(bridge, "WalletMovingFunds")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                walletMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialWalletMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          })
        }
      )
    })
  })

  describe("defeatFraudChallenge", () => {
    context("when the input is non-witness", () => {
      context("when the transaction has single input", () => {
        context(
          "when the input is marked as correctly spent in the Bridge",
          () => {
            const data = nonWitnessSignSingleInputTx
            let initialThirdPartyBalance: BigNumber
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              await bridge.setWallet(walletPublicKeyHash, {
                ecdsaWalletID: ethers.constants.HashZero,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: await lastBlockTime(),
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: walletState.Live,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
              await bridge.setSweptDeposits(data.deposits)
              await bridge.setSpentMainUtxos(data.spentMainUtxos)
              await bridge.setProcessedMovedFundsSweepRequests(
                data.movedFundsSweepRequests
              )

              await bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  data.preimageSha256,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )

              initialThirdPartyBalance = await provider.getBalance(
                thirdParty.address
              )
              tx = await maintainerProxy
                .connect(thirdParty)
                .defeatFraudChallenge(
                  walletPublicKey,
                  data.preimage,
                  data.witness
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit FraudChallengeDefeated event", async () => {
              await expect(tx).to.emit(bridge, "FraudChallengeDefeated")
            })

            it("should refund ETH", async () => {
              const postThirdPartyBalance = await provider.getBalance(
                thirdParty.address
              )
              const diff = postThirdPartyBalance.sub(initialThirdPartyBalance)

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          }
        )
      })

      context("when the transaction has multiple inputs", () => {
        context(
          "when the input is marked as correctly spent in the Bridge",
          () => {
            const data = nonWitnessSignMultipleInputsTx
            let initialThirdPartyBalance: BigNumber
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              await bridge.setWallet(walletPublicKeyHash, {
                ecdsaWalletID: ethers.constants.HashZero,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: await lastBlockTime(),
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: walletState.Live,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
              await bridge.setSweptDeposits(data.deposits)
              await bridge.setSpentMainUtxos(data.spentMainUtxos)
              await bridge.setProcessedMovedFundsSweepRequests(
                data.movedFundsSweepRequests
              )

              await bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  data.preimageSha256,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )

              initialThirdPartyBalance = await provider.getBalance(
                thirdParty.address
              )
              tx = await maintainerProxy
                .connect(thirdParty)
                .defeatFraudChallenge(
                  walletPublicKey,
                  data.preimage,
                  data.witness
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit FraudChallengeDefeated event", async () => {
              await expect(tx).to.emit(bridge, "FraudChallengeDefeated")
            })

            it("should refund ETH", async () => {
              const postThirdPartyBalance = await provider.getBalance(
                thirdParty.address
              )
              const diff = postThirdPartyBalance.sub(initialThirdPartyBalance)

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          }
        )
      })
    })

    context("when the input is witness", () => {
      context("when the transaction has single input", () => {
        context(
          "when the input is marked as correctly spent in the Bridge",
          () => {
            const data = witnessSignSingleInputTx
            let initialThirdPartyBalance: BigNumber
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              await bridge.setWallet(walletPublicKeyHash, {
                ecdsaWalletID: ethers.constants.HashZero,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: await lastBlockTime(),
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: walletState.Live,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
              await bridge.setSweptDeposits(data.deposits)
              await bridge.setSpentMainUtxos(data.spentMainUtxos)
              await bridge.setProcessedMovedFundsSweepRequests(
                data.movedFundsSweepRequests
              )

              await bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  data.preimageSha256,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )

              initialThirdPartyBalance = await provider.getBalance(
                thirdParty.address
              )
              tx = await maintainerProxy
                .connect(thirdParty)
                .defeatFraudChallenge(
                  walletPublicKey,
                  data.preimage,
                  data.witness
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit FraudChallengeDefeated event", async () => {
              await expect(tx).to.emit(bridge, "FraudChallengeDefeated")
            })

            it("should refund ETH", async () => {
              const postThirdPartyBalance = await provider.getBalance(
                thirdParty.address
              )
              const diff = postThirdPartyBalance.sub(initialThirdPartyBalance)

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          }
        )
      })

      context("when the transaction has multiple inputs", () => {
        context(
          "when the input is marked as correctly spent in the Bridge",
          () => {
            const data = witnessSignMultipleInputTx
            let initialThirdPartyBalance: BigNumber
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              await bridge.setWallet(walletPublicKeyHash, {
                ecdsaWalletID: ethers.constants.HashZero,
                mainUtxoHash: ethers.constants.HashZero,
                pendingRedemptionsValue: 0,
                createdAt: await lastBlockTime(),
                movingFundsRequestedAt: 0,
                closingStartedAt: 0,
                pendingMovedFundsSweepRequestsCount: 0,
                state: walletState.Live,
                movingFundsTargetWalletsCommitmentHash:
                  ethers.constants.HashZero,
              })
              await bridge.setSweptDeposits(data.deposits)
              await bridge.setSpentMainUtxos(data.spentMainUtxos)
              await bridge.setProcessedMovedFundsSweepRequests(
                data.movedFundsSweepRequests
              )

              await bridge
                .connect(thirdParty)
                .submitFraudChallenge(
                  walletPublicKey,
                  data.preimageSha256,
                  data.signature,
                  {
                    value: fraudChallengeDepositAmount,
                  }
                )

              initialThirdPartyBalance = await provider.getBalance(
                thirdParty.address
              )
              tx = await maintainerProxy
                .connect(thirdParty)
                .defeatFraudChallenge(
                  walletPublicKey,
                  data.preimage,
                  data.witness
                )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit FraudChallengeDefeated event", async () => {
              await expect(tx).to.emit(bridge, "FraudChallengeDefeated")
            })

            it("should refund ETH", async () => {
              const postThirdPartyBalance = await provider.getBalance(
                thirdParty.address
              )
              const diff = postThirdPartyBalance.sub(initialThirdPartyBalance)

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
              )
            })
          }
        )
      })
    })
  })

  describe("defeatFraudChallengeWithHeartbeat", () => {
    let heartbeatWalletPublicKey: string
    let heartbeatWalletSigningKey: SigningKey

    let initialThirdPartyBalance: BigNumber
    let tx: ContractTransaction

    before(async () => {
      await createSnapshot()

      // For `defeatFraudChallengeWithHeartbeat` unit tests we do not use test
      // data from `fraud.ts`. Instead, we create random wallet and use its
      // SigningKey.
      //
      // This approach is better long-term. In case the format of the heartbeat
      // message changes or in case we want to add more unit tests, we can simply
      // call appropriate function to compute another signature. Also, we do not
      // use any BTC-specific data for this set of unit tests.
      const wallet = ethers.Wallet.createRandom()
      // We use `ethers.utils.SigningKey` for a `Wallet` instead of
      // `Signer.signMessage` to do not add '\x19Ethereum Signed Message:\n'
      // prefix to the signed message. The format of the heartbeat message is
      // the same no matter on which host chain TBTC is deployed.
      heartbeatWalletSigningKey = new ethers.utils.SigningKey(wallet.privateKey)
      // Public key obtained as `wallet.publicKey` is an uncompressed key,
      // prefixed with `0x04`. To compute raw ECDSA key, we need to drop `0x04`.
      heartbeatWalletPublicKey = `0x${wallet.publicKey.substring(4)}`

      const walletID = keccak256(heartbeatWalletPublicKey)
      const walletPublicKeyX = `0x${heartbeatWalletPublicKey.substring(2, 66)}`
      const walletPublicKeyY = `0x${heartbeatWalletPublicKey.substring(66)}`
      await bridge
        .connect(walletRegistry.wallet)
        .__ecdsaWalletCreatedCallback(
          walletID,
          walletPublicKeyX,
          walletPublicKeyY
        )

      const heartbeatMessage = "0xFFFFFFFFFFFFFFFF0000000000E0EED7"
      const heartbeatMessageSha256 = sha256(heartbeatMessage)
      const sighash = sha256(sha256(heartbeatMessage))

      const signature = ethers.utils.splitSignature(
        heartbeatWalletSigningKey.signDigest(sighash)
      )

      await bridge
        .connect(thirdParty)
        .submitFraudChallenge(
          heartbeatWalletPublicKey,
          heartbeatMessageSha256,
          signature,
          {
            value: fraudChallengeDepositAmount,
          }
        )

      initialThirdPartyBalance = await provider.getBalance(thirdParty.address)
      tx = await maintainerProxy
        .connect(thirdParty)
        .defeatFraudChallengeWithHeartbeat(
          heartbeatWalletPublicKey,
          heartbeatMessage
        )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should emit FraudChallengeDefeated event", async () => {
      await expect(tx).to.emit(bridge, "FraudChallengeDefeated")
    })

    it("should refund ETH", async () => {
      const postThirdPartyBalance = await provider.getBalance(
        thirdParty.address
      )
      const diff = postThirdPartyBalance.sub(initialThirdPartyBalance)

      expect(diff).to.be.gt(0)
      expect(diff).to.be.lt(
        ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
      )
    })
  })

  describe("submitMovingFundsProof", () => {
    context("when called by an unauthorized third party", () => {
      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        const data = SingleTargetWallet
        expect(
          maintainerProxy
            .connect(thirdParty)
            .submitMovingFundsProof(
              data.movingFundsTx,
              data.movingFundsProof,
              data.mainUtxo,
              data.wallet.pubKeyHash
            )
        ).to.be.to.be.revertedWith("Caller is not authorized")
      })
    })

    context(
      "when called by a wallet maintainer that is not SPV maintainer",
      () => {
        // Even though transaction reverts some funds were spent.
        // We need to restore the state to keep the balances as initially.
        before(async () => createSnapshot())
        after(async () => restoreSnapshot())

        it("should revert", async () => {
          const data = SingleTargetWallet
          expect(
            maintainerProxy
              .connect(walletMaintainer)
              .submitMovingFundsProof(
                data.movingFundsTx,
                data.movingFundsProof,
                data.mainUtxo,
                data.wallet.pubKeyHash
              )
          ).to.be.to.be.revertedWith("Caller is not authorized")
        })
      }
    )

    context("when called by an SPV maintainer", () => {
      const testData: {
        testName: string
        data: MovingFundsTestData
      }[] = [
        {
          testName: "when there is a single target wallet",
          data: SingleTargetWallet,
        },
        {
          testName:
            "when there are multiple target wallets and the amount is indivisible",
          data: MultipleTargetWalletsAndIndivisibleAmount,
        },
        {
          testName:
            "when there are multiple target wallets and the amount is divisible",
          data: MultipleTargetWalletsAndDivisibleAmount,
        },
      ]

      testData.forEach((test) => {
        context(test.testName, () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            tx = await runMovingFundsScenario(test.data)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit MovingFundsCompleted event", async () => {
            await expect(tx).to.emit(bridge, "MovingFundsCompleted")
          })

          it("should refund ETH", async () => {
            const postMaintainerBalance = await provider.getBalance(
              spvMaintainer.address
            )
            const diff = postMaintainerBalance.sub(initialSpvMaintainerBalance)

            expect(diff).to.be.gt(0)
            expect(diff).to.be.lt(
              ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
            )
          })
        })
      })
    })
  })

  describe("resetMovingFundsTimeout", () => {
    let initialThirdPartyBalance: BigNumber
    let tx: ContractTransaction

    before(async () => {
      await createSnapshot()

      await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
        ecdsaWalletID: ecdsaWalletTestData.walletID,
        mainUtxoHash: ethers.constants.HashZero,
        pendingRedemptionsValue: 0,
        createdAt: 0,
        movingFundsRequestedAt: (await lastBlockTime()) + 1,
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: walletState.MovingFunds,
        movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
      })

      await increaseTime(movingFundsTimeoutResetDelay)

      initialThirdPartyBalance = await provider.getBalance(thirdParty.address)
      tx = await maintainerProxy
        .connect(thirdParty)
        .resetMovingFundsTimeout(ecdsaWalletTestData.pubKeyHash160)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should emit MovingFundsTimeoutReset event", async () => {
      await expect(tx).to.emit(bridge, "MovingFundsTimeoutReset")
    })

    it("should refund ETH", async () => {
      const postThirdPartyBalance = await provider.getBalance(
        thirdParty.address
      )
      const diff = postThirdPartyBalance.sub(initialThirdPartyBalance)

      expect(diff).to.be.gt(0)
      expect(diff).to.be.lt(
        ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
      )
    })
  })

  describe("notifyMovingFundsBelowDust", () => {
    const mainUtxo = {
      txHash: ethers.constants.HashZero,
      txOutputIndex: 0,
      txOutputValue: constants.movingFundsDustThreshold - 1,
    }

    let tx: ContractTransaction

    context("when called by an unauthorized third party", () => {
      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .notifyMovingFundsBelowDust(
              ecdsaWalletTestData.pubKeyHash160,
              mainUtxo
            )
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context(
      "when called by an SPV mantainer that is not wallet maintainer",
      () => {
        // Even though transaction reverts some funds were spent.
        // We need to restore the state to keep the balances as initially.
        before(async () => createSnapshot())
        after(async () => restoreSnapshot())

        it("should revert", async () => {
          await expect(
            maintainerProxy
              .connect(spvMaintainer)
              .notifyMovingFundsBelowDust(
                ecdsaWalletTestData.pubKeyHash160,
                mainUtxo
              )
          ).to.be.revertedWith("Caller is not authorized")
        })
      }
    )

    context("when called by a wallet maintainer", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ecdsaWalletID: ecdsaWalletTestData.walletID,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: 0,
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.MovingFunds,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })

        await bridge.setWalletMainUtxo(
          ecdsaWalletTestData.pubKeyHash160,
          mainUtxo
        )

        tx = await maintainerProxy
          .connect(walletMaintainer)
          .notifyMovingFundsBelowDust(
            ecdsaWalletTestData.pubKeyHash160,
            mainUtxo
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit MovingFundsBelowDustReported event", async () => {
        await expect(tx).to.emit(bridge, "MovingFundsBelowDustReported")
      })

      it("should refund ETH", async () => {
        const postMaintainerBalance = await provider.getBalance(
          walletMaintainer.address
        )
        const diff = postMaintainerBalance.sub(initialWalletMaintainerBalance)

        expect(diff).to.be.gt(0)
        expect(diff).to.be.lt(
          ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
        )
      })
    })
  })

  describe("submitMovedFundsSweepProof", () => {
    context("when called by an unauthorized third party", () => {
      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        const data: MovedFundsSweepTestData = MovedFundsSweepWithoutMainUtxo
        const tx = maintainerProxy
          .connect(thirdParty)
          .submitMovedFundsSweepProof(
            data.sweepTx,
            data.sweepProof,
            data.mainUtxo
          )
        await expect(tx).to.be.revertedWith("Caller is not authorized")
      })
    })

    context(
      "when called by a wallet maintainer that is not SPV maintainer",
      () => {
        // Even though transaction reverts some funds were spent.
        // We need to restore the state to keep the balances as initially.
        before(async () => createSnapshot())
        after(async () => restoreSnapshot())

        it("should revert", async () => {
          const data: MovedFundsSweepTestData = MovedFundsSweepWithoutMainUtxo
          const tx = maintainerProxy
            .connect(walletMaintainer)
            .submitMovedFundsSweepProof(
              data.sweepTx,
              data.sweepProof,
              data.mainUtxo
            )
          await expect(tx).to.be.revertedWith("Caller is not authorized")
        })
      }
    )

    context("when called by an SPV maintainer", () => {
      context("when the sweeping wallet has no main UTXO set", () => {
        context(
          "when there is a single input referring to a Pending sweep request",
          () => {
            const data: MovedFundsSweepTestData = MovedFundsSweepWithoutMainUtxo
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await runMovedFundsSweepScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit MovedFundsSwept event", async () => {
              await expect(tx).to.emit(bridge, "MovedFundsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
              )
            })
          }
        )
      })

      context("when the sweeping wallet has a main UTXO set", () => {
        context(
          "when the first input refers to a Pending sweep request and the second " +
            "input refers to the sweeping wallet main UTXO",
          () => {
            const data: MovedFundsSweepTestData = MovedFundsSweepWithMainUtxo
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await runMovedFundsSweepScenario(data)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit MovedFundsSwept event", async () => {
              await expect(tx).to.emit(bridge, "MovedFundsSwept")
            })

            it("should refund ETH", async () => {
              const postMaintainerBalance = await provider.getBalance(
                spvMaintainer.address
              )
              const diff = postMaintainerBalance.sub(
                initialSpvMaintainerBalance
              )

              expect(diff).to.be.gt(0)
              expect(diff).to.be.lt(
                ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
              )
            })
          }
        )
      })
    })
  })

  describe("notifyWalletClosingPeriodElapsed", () => {
    context("when called by an unauthorized third party", () => {
      // Even though transaction reverts some funds were spent.
      // We need to restore the state to keep the balances as initially.
      before(async () => createSnapshot())
      after(async () => restoreSnapshot())

      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .notifyWalletClosingPeriodElapsed(ecdsaWalletTestData.pubKeyHash160)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context(
      "when called by an SPV maintainer that is not wallet maintainer",
      () => {
        // Even though transaction reverts some funds were spent.
        // We need to restore the state to keep the balances as initially.
        before(async () => createSnapshot())
        after(async () => restoreSnapshot())

        it("should revert", async () => {
          await expect(
            maintainerProxy
              .connect(spvMaintainer)
              .notifyWalletClosingPeriodElapsed(
                ecdsaWalletTestData.pubKeyHash160
              )
          ).to.be.revertedWith("Caller is not authorized")
        })
      }
    )

    context("when called by a wallet maintainer", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ecdsaWalletID: ecdsaWalletTestData.walletID,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: 0,
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.Live,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })

        // Switches the wallet to Closing state because the wallet has
        // no main UTXO set.
        await bridge
          .connect(walletRegistry.wallet)
          .__ecdsaWalletHeartbeatFailedCallback(
            ecdsaWalletTestData.walletID,
            ecdsaWalletTestData.publicKeyX,
            ecdsaWalletTestData.publicKeyY
          )

        await increaseTime(
          (
            await bridge.walletParameters()
          ).walletClosingPeriod
        )

        tx = await maintainerProxy
          .connect(walletMaintainer)
          .notifyWalletClosingPeriodElapsed(ecdsaWalletTestData.pubKeyHash160)
      })

      after(async () => {
        await restoreSnapshot()
        await walletRegistry.closeWallet.reset()
      })

      it("should emit WalletClosed event", async () => {
        await expect(tx).to.emit(bridge, "WalletClosed")
      })

      it("should refund ETH", async () => {
        const postMaintainerBalance = await provider.getBalance(
          walletMaintainer.address
        )
        const diff = postMaintainerBalance.sub(initialWalletMaintainerBalance)

        expect(diff).to.be.gt(0)
        expect(diff).to.be.lt(
          ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
        )
      })
    })
  })

  describe("authorizeWalletMaintainer", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .authorizeWalletMaintainer(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await maintainerProxy
          .connect(governance)
          .authorizeWalletMaintainer(thirdParty.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should be already populated with the authorized maintainer", async () => {
        expect(
          await maintainerProxy.isWalletMaintainer(walletMaintainer.address)
        ).to.be.equal(1)
      })

      it("should authorize a thirdParty", async () => {
        expect(
          await maintainerProxy.isWalletMaintainer(thirdParty.address)
        ).to.be.equal(2)
      })

      it("should be total of 2 authorized maintainers", async () => {
        const maintainers = await maintainerProxy.allWalletMaintainers()
        expect(maintainers.length).to.be.equal(2)
      })

      it("should add a thirdParty to a maintainers list", async () => {
        const thirdPartyAddress = await maintainerProxy.walletMaintainers(1)
        expect(thirdPartyAddress).to.be.equal(thirdParty.address)
      })

      it("should emit a WalletMaintainerAuthorized event", async () => {
        await expect(tx)
          .to.emit(maintainerProxy, "WalletMaintainerAuthorized")
          .withArgs(thirdParty.address)
      })
    })
  })

  describe("authorizeSpvMaintainer", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .authorizeSpvMaintainer(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()

        tx = await maintainerProxy
          .connect(governance)
          .authorizeSpvMaintainer(thirdParty.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should be already populated with the authorized maintainer", async () => {
        expect(
          await maintainerProxy.isSpvMaintainer(spvMaintainer.address)
        ).to.be.equal(1)
      })

      it("should authorize a thirdParty", async () => {
        expect(
          await maintainerProxy.isSpvMaintainer(thirdParty.address)
        ).to.be.equal(2)
      })

      it("should be total of 2 authorized maintainers", async () => {
        const maintainers = await maintainerProxy.allSpvMaintainers()
        expect(maintainers.length).to.be.equal(2)
      })

      it("should add a thirdParty to a maintainers list", async () => {
        const thirdPartyAddress = await maintainerProxy.spvMaintainers(1)
        expect(thirdPartyAddress).to.be.equal(thirdParty.address)
      })

      it("should emit an SpvMaintainerAuthorized event", async () => {
        await expect(tx)
          .to.emit(maintainerProxy, "SpvMaintainerAuthorized")
          .withArgs(thirdParty.address)
      })
    })
  })

  describe("unauthorizeWalletMaintainer", () => {
    before(async () => {
      await createSnapshot()

      await maintainerProxy
        .connect(governance)
        .unauthorizeWalletMaintainer(walletMaintainer.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .unauthorizeWalletMaintainer(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      it("should be a total of 0 authorized maintainers", async () => {
        const authorizedMaintainers =
          await maintainerProxy.allWalletMaintainers()
        await expect(authorizedMaintainers.length).to.be.equal(0)
      })

      context("when there are no authorized maintainers", () => {
        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            maintainerProxy
              .connect(governance)
              .unauthorizeWalletMaintainer(thirdParty.address)
          ).to.be.revertedWith("No maintainer to unauthorize")
        })
      })

      context("when there are authorized maintainers", () => {
        context(
          "when maintainer to unauthorize is not among the authorized maintainers",
          () => {
            before(async () => {
              await createSnapshot()
              const signers = await helpers.signers.getUnnamedSigners()
              const maintainers = [
                signers[1],
                signers[2],
                signers[3],
                signers[4],
                signers[5],
                signers[6],
                signers[7],
                signers[8],
              ]

              for (let i = 0; i < maintainers.length; i++) {
                /* eslint-disable no-await-in-loop */
                await maintainerProxy
                  .connect(governance)
                  .authorizeWalletMaintainer(maintainers[i].address)
              }
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                maintainerProxy
                  .connect(governance)
                  .unauthorizeWalletMaintainer(governance.address)
              ).to.be.revertedWith("No maintainer to unauthorize")
            })
          }
        )
      })

      context("when there is one authorized maintainer", () => {
        context("when unauthorizing the one that is authorized", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await maintainerProxy
              .connect(governance)
              .authorizeWalletMaintainer(thirdParty.address)

            tx = await maintainerProxy
              .connect(governance)
              .unauthorizeWalletMaintainer(thirdParty.address)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should unauthorize the maintainer", async () => {
            expect(
              await maintainerProxy.isWalletMaintainer(thirdParty.address)
            ).to.be.equal(0)
          })

          it("should emit a WalletMaintainerUnauthorized event", async () => {
            await expect(tx)
              .to.emit(maintainerProxy, "WalletMaintainerUnauthorized")
              .withArgs(thirdParty.address)
          })
        })
      })

      context("when there are many authorized maintainers", () => {
        let maintainer1: SignerWithAddress
        let maintainer2: SignerWithAddress
        let maintainer3: SignerWithAddress
        let maintainer4: SignerWithAddress
        let maintainer5: SignerWithAddress
        let maintainer6: SignerWithAddress
        let maintainer7: SignerWithAddress
        let maintainer8: SignerWithAddress

        before(async () => {
          await createSnapshot()
          const signers = await helpers.signers.getUnnamedSigners()
          /* eslint-disable */
          maintainer1 = signers[1]
          maintainer2 = signers[2]
          maintainer3 = signers[3]
          maintainer4 = signers[4]
          maintainer5 = signers[5]
          maintainer6 = signers[6]
          maintainer7 = signers[7]
          maintainer8 = signers[8]
          /* eslint-enable */
          const maintainers = [
            maintainer1,
            maintainer2,
            maintainer3,
            maintainer4,
            maintainer5,
            maintainer6,
            maintainer7,
            maintainer8,
          ]

          for (let i = 0; i < maintainers.length; i++) {
            /* eslint-disable no-await-in-loop */
            await maintainerProxy
              .connect(governance)
              .authorizeWalletMaintainer(maintainers[i].address)
          }
        })

        after(async () => {
          await restoreSnapshot()
        })

        // Init authorized maintainers: [0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8]
        // Unauthorize: [0x1, 0x3]
        // Swap the last maintainer with the one to unauthorize
        // New authorized maintainers: [0x8, 0x2, 0x7, 0x4, 0x5, 0x6]
        context(
          "when unauthorizing a couple of maintainers from the beginning",
          () => {
            let tx1: ContractTransaction
            let tx3: ContractTransaction
            before(async () => {
              await createSnapshot()

              tx1 = await maintainerProxy
                .connect(governance)
                .unauthorizeWalletMaintainer(maintainer1.address)

              tx3 = await maintainerProxy
                .connect(governance)
                .unauthorizeWalletMaintainer(maintainer3.address)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should unauthorize the maintainer", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer1.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer8.address)
              ).to.be.equal(1)
            })

            it("should unauthorize the other maintainer", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer3.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer7.address)
              ).to.be.equal(3)
            })

            it("should remove 2 maintainers from the maintainers array", async () => {
              const authorizedMaintainers =
                await maintainerProxy.allWalletMaintainers()

              expect(authorizedMaintainers.length).to.be.equal(6)
              const expectedMaintainers = [
                maintainer8.address,
                maintainer2.address,
                maintainer7.address,
                maintainer4.address,
                maintainer5.address,
                maintainer6.address,
              ]

              expect(authorizedMaintainers).to.be.deep.equal(
                expectedMaintainers
              )
            })

            it("should emit a WalletMaintainerUnauthorized event", async () => {
              await expect(tx1)
                .to.emit(maintainerProxy, "WalletMaintainerUnauthorized")
                .withArgs(maintainer1.address)
            })

            it("should emit a WalletMaintainerUnauthorized event", async () => {
              await expect(tx3)
                .to.emit(maintainerProxy, "WalletMaintainerUnauthorized")
                .withArgs(maintainer3.address)
            })
          }
        )

        // Init authorized maintainers: [0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8]
        // Unauthorize: [0x3, 0x6]
        // Swap the last maintainer with the one to unauthorize
        // New authorized maintainers: [0x1, 0x2, 0x8, 0x4, 0x5, 0x7]
        context(
          "when unauthorizing a couple of maintainers from the middle",
          () => {
            let tx3: ContractTransaction
            let tx6: ContractTransaction
            before(async () => {
              await createSnapshot()

              tx3 = await maintainerProxy
                .connect(governance)
                .unauthorizeWalletMaintainer(maintainer3.address)

              tx6 = await maintainerProxy
                .connect(governance)
                .unauthorizeWalletMaintainer(maintainer6.address)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should unauthorize a maintainer", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer3.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer8.address)
              ).to.be.equal(3)
            })

            it("should unauthorize the other maintainer", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer6.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer7.address)
              ).to.be.equal(6)
            })

            it("should remove 2 maintainers from the maintainers array", async () => {
              const authorizedMaintainers =
                await maintainerProxy.allWalletMaintainers()

              expect(authorizedMaintainers.length).to.be.equal(6)
              const expectedMaintainers = [
                maintainer1.address,
                maintainer2.address,
                maintainer8.address,
                maintainer4.address,
                maintainer5.address,
                maintainer7.address,
              ]

              expect(authorizedMaintainers).to.be.deep.equal(
                expectedMaintainers
              )
            })

            it("should emit a WalletMaintainerUnauthorized event", async () => {
              await expect(tx3)
                .to.emit(maintainerProxy, "WalletMaintainerUnauthorized")
                .withArgs(maintainer3.address)
            })

            it("should emit a WalletMaintainerUnauthorized event", async () => {
              await expect(tx6)
                .to.emit(maintainerProxy, "WalletMaintainerUnauthorized")
                .withArgs(maintainer6.address)
            })
          }
        )

        // Init authorized maintainers: [0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8]
        // Unauthorize: [0x5, 0x8]
        // Swap the last maintainer with the one to unauthorize
        // New authorized maintainers: [0x1, 0x2, 0x3, 0x4, 0x7, 0x6]
        context(
          "when unauthorizing a couple of maintainers from the end",
          () => {
            let tx5: ContractTransaction
            let tx8: ContractTransaction
            before(async () => {
              await createSnapshot()

              tx5 = await maintainerProxy
                .connect(governance)
                .unauthorizeWalletMaintainer(maintainer5.address)

              tx8 = await maintainerProxy
                .connect(governance)
                .unauthorizeWalletMaintainer(maintainer8.address)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should unauthorize a maintainer", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer5.address)
              ).to.be.equal(0)
            })

            it("should unauthorize the other maintainer", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer8.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isWalletMaintainer(maintainer7.address)
              ).to.be.equal(5)
            })

            it("should remove 2 maintainers from the maintainers array", async () => {
              const authorizedMaintainers =
                await maintainerProxy.allWalletMaintainers()

              expect(authorizedMaintainers.length).to.be.equal(6)
              const expectedMaintainers = [
                maintainer1.address,
                maintainer2.address,
                maintainer3.address,
                maintainer4.address,
                maintainer7.address,
                maintainer6.address,
              ]

              expect(authorizedMaintainers).to.be.deep.equal(
                expectedMaintainers
              )
            })

            it("should emit a WalletMaintainerUnauthorized event", async () => {
              await expect(tx5)
                .to.emit(maintainerProxy, "WalletMaintainerUnauthorized")
                .withArgs(maintainer5.address)
            })

            it("should emit a WalletMaintainerUnauthorized event", async () => {
              await expect(tx8)
                .to.emit(maintainerProxy, "WalletMaintainerUnauthorized")
                .withArgs(maintainer8.address)
            })
          }
        )
      })
    })
  })

  describe("unauthorizeSpvMaintainer", () => {
    before(async () => {
      await createSnapshot()

      await maintainerProxy
        .connect(governance)
        .unauthorizeSpvMaintainer(spvMaintainer.address)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .unauthorizeSpvMaintainer(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      it("should be a total of 0 authorized maintainers", async () => {
        const authorizedMaintainers = await maintainerProxy.allSpvMaintainers()
        await expect(authorizedMaintainers.length).to.be.equal(0)
      })

      context("when there are no authorized maintainers", () => {
        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            maintainerProxy
              .connect(governance)
              .unauthorizeSpvMaintainer(thirdParty.address)
          ).to.be.revertedWith("No maintainer to unauthorize")
        })
      })

      context("when there are authorized maintainers", () => {
        context(
          "when maintainer to unauthorize is not among the authorized maintainers",
          () => {
            before(async () => {
              await createSnapshot()
              const signers = await helpers.signers.getUnnamedSigners()
              const maintainers = [
                signers[1],
                signers[2],
                signers[3],
                signers[4],
                signers[5],
                signers[6],
                signers[7],
                signers[8],
              ]

              for (let i = 0; i < maintainers.length; i++) {
                /* eslint-disable no-await-in-loop */
                await maintainerProxy
                  .connect(governance)
                  .authorizeSpvMaintainer(maintainers[i].address)
              }
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                maintainerProxy
                  .connect(governance)
                  .unauthorizeSpvMaintainer(governance.address)
              ).to.be.revertedWith("No maintainer to unauthorize")
            })
          }
        )
      })

      context("when there is one authorized maintainer", () => {
        context("when unauthorizing the one that is authorized", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await maintainerProxy
              .connect(governance)
              .authorizeSpvMaintainer(thirdParty.address)

            tx = await maintainerProxy
              .connect(governance)
              .unauthorizeSpvMaintainer(thirdParty.address)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should unauthorize the maintainer", async () => {
            expect(
              await maintainerProxy.isSpvMaintainer(thirdParty.address)
            ).to.be.equal(0)
          })

          it("should emit an SpvMaintainerUnauthorized event", async () => {
            await expect(tx)
              .to.emit(maintainerProxy, "SpvMaintainerUnauthorized")
              .withArgs(thirdParty.address)
          })
        })
      })

      context("when there are many authorized maintainers", () => {
        let maintainer1: SignerWithAddress
        let maintainer2: SignerWithAddress
        let maintainer3: SignerWithAddress
        let maintainer4: SignerWithAddress
        let maintainer5: SignerWithAddress
        let maintainer6: SignerWithAddress
        let maintainer7: SignerWithAddress
        let maintainer8: SignerWithAddress

        before(async () => {
          await createSnapshot()
          const signers = await helpers.signers.getUnnamedSigners()
          /* eslint-disable */
          maintainer1 = signers[1]
          maintainer2 = signers[2]
          maintainer3 = signers[3]
          maintainer4 = signers[4]
          maintainer5 = signers[5]
          maintainer6 = signers[6]
          maintainer7 = signers[7]
          maintainer8 = signers[8]
          /* eslint-enable */
          const maintainers = [
            maintainer1,
            maintainer2,
            maintainer3,
            maintainer4,
            maintainer5,
            maintainer6,
            maintainer7,
            maintainer8,
          ]

          for (let i = 0; i < maintainers.length; i++) {
            /* eslint-disable no-await-in-loop */
            await maintainerProxy
              .connect(governance)
              .authorizeSpvMaintainer(maintainers[i].address)
          }
        })

        after(async () => {
          await restoreSnapshot()
        })

        // Init authorized maintainers: [0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8]
        // Unauthorize: [0x1, 0x3]
        // Swap the last maintainer with the one to unauthorize
        // New authorized maintainers: [0x8, 0x2, 0x7, 0x4, 0x5, 0x6]
        context(
          "when unauthorizing a couple of maintainers from the beginning",
          () => {
            let tx1: ContractTransaction
            let tx3: ContractTransaction
            before(async () => {
              await createSnapshot()

              tx1 = await maintainerProxy
                .connect(governance)
                .unauthorizeSpvMaintainer(maintainer1.address)

              tx3 = await maintainerProxy
                .connect(governance)
                .unauthorizeSpvMaintainer(maintainer3.address)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should unauthorize the maintainer", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer1.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer8.address)
              ).to.be.equal(1)
            })

            it("should unauthorize the other maintainer", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer3.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer7.address)
              ).to.be.equal(3)
            })

            it("should remove 2 maintainers from the maintainers array", async () => {
              const authorizedMaintainers =
                await maintainerProxy.allSpvMaintainers()

              expect(authorizedMaintainers.length).to.be.equal(6)
              const expectedMaintainers = [
                maintainer8.address,
                maintainer2.address,
                maintainer7.address,
                maintainer4.address,
                maintainer5.address,
                maintainer6.address,
              ]

              expect(authorizedMaintainers).to.be.deep.equal(
                expectedMaintainers
              )
            })

            it("should emit an SpvMaintainerUnauthorized event", async () => {
              await expect(tx1)
                .to.emit(maintainerProxy, "SpvMaintainerUnauthorized")
                .withArgs(maintainer1.address)
            })

            it("should emit an SpvMaintainerUnauthorized event", async () => {
              await expect(tx3)
                .to.emit(maintainerProxy, "SpvMaintainerUnauthorized")
                .withArgs(maintainer3.address)
            })
          }
        )

        // Init authorized maintainers: [0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8]
        // Unauthorize: [0x3, 0x6]
        // Swap the last maintainer with the one to unauthorize
        // New authorized maintainers: [0x1, 0x2, 0x8, 0x4, 0x5, 0x7]
        context(
          "when unauthorizing a couple of maintainers from the middle",
          () => {
            let tx3: ContractTransaction
            let tx6: ContractTransaction
            before(async () => {
              await createSnapshot()

              tx3 = await maintainerProxy
                .connect(governance)
                .unauthorizeSpvMaintainer(maintainer3.address)

              tx6 = await maintainerProxy
                .connect(governance)
                .unauthorizeSpvMaintainer(maintainer6.address)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should unauthorize a maintainer", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer3.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer8.address)
              ).to.be.equal(3)
            })

            it("should unauthorize the other maintainer", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer6.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer7.address)
              ).to.be.equal(6)
            })

            it("should remove 2 maintainers from the maintainers array", async () => {
              const authorizedMaintainers =
                await maintainerProxy.allSpvMaintainers()

              expect(authorizedMaintainers.length).to.be.equal(6)
              const expectedMaintainers = [
                maintainer1.address,
                maintainer2.address,
                maintainer8.address,
                maintainer4.address,
                maintainer5.address,
                maintainer7.address,
              ]

              expect(authorizedMaintainers).to.be.deep.equal(
                expectedMaintainers
              )
            })

            it("should emit an SpvMaintainerUnauthorized event", async () => {
              await expect(tx3)
                .to.emit(maintainerProxy, "SpvMaintainerUnauthorized")
                .withArgs(maintainer3.address)
            })

            it("should emit an SpvMaintainerUnauthorized event", async () => {
              await expect(tx6)
                .to.emit(maintainerProxy, "SpvMaintainerUnauthorized")
                .withArgs(maintainer6.address)
            })
          }
        )

        // Init authorized maintainers: [0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8]
        // Unauthorize: [0x5, 0x8]
        // Swap the last maintainer with the one to unauthorize
        // New authorized maintainers: [0x1, 0x2, 0x3, 0x4, 0x7, 0x6]
        context(
          "when unauthorizing a couple of maintainers from the end",
          () => {
            let tx5: ContractTransaction
            let tx8: ContractTransaction
            before(async () => {
              await createSnapshot()

              tx5 = await maintainerProxy
                .connect(governance)
                .unauthorizeSpvMaintainer(maintainer5.address)

              tx8 = await maintainerProxy
                .connect(governance)
                .unauthorizeSpvMaintainer(maintainer8.address)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should unauthorize a maintainer", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer5.address)
              ).to.be.equal(0)
            })

            it("should unauthorize the other maintainer", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer8.address)
              ).to.be.equal(0)
            })

            it("should change the last maintainer's index with the unauthorized one", async () => {
              expect(
                await maintainerProxy.isSpvMaintainer(maintainer7.address)
              ).to.be.equal(5)
            })

            it("should remove 2 maintainers from the maintainers array", async () => {
              const authorizedMaintainers =
                await maintainerProxy.allSpvMaintainers()

              expect(authorizedMaintainers.length).to.be.equal(6)
              const expectedMaintainers = [
                maintainer1.address,
                maintainer2.address,
                maintainer3.address,
                maintainer4.address,
                maintainer7.address,
                maintainer6.address,
              ]

              expect(authorizedMaintainers).to.be.deep.equal(
                expectedMaintainers
              )
            })

            it("should emit an SpvMaintainerUnauthorized event", async () => {
              await expect(tx5)
                .to.emit(maintainerProxy, "SpvMaintainerUnauthorized")
                .withArgs(maintainer5.address)
            })

            it("should emit an SpvMaintainerUnauthorized event", async () => {
              await expect(tx8)
                .to.emit(maintainerProxy, "SpvMaintainerUnauthorized")
                .withArgs(maintainer8.address)
            })
          }
        )
      })
    })
  })

  describe("updateBridge", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy.connect(thirdParty).updateBridge(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await maintainerProxy
          .connect(governance)
          .updateBridge(thirdParty.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the bridge", async () => {
        expect(await maintainerProxy.bridge()).to.equal(thirdParty.address)
      })

      it("should emit the BridgeUpdated event", async () => {
        await expect(tx)
          .to.emit(maintainerProxy, "BridgeUpdated")
          .withArgs(thirdParty.address)
      })
    })
  })

  describe("updateGasOffsetParameters", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .updateGasOffsetParameters(
              40,
              41,
              42,
              43,
              44,
              45,
              46,
              47,
              48,
              49,
              50
            )
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await maintainerProxy
          .connect(governance)
          .updateGasOffsetParameters(40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit the GasOffsetParametersUpdated event", async () => {
        await expect(tx)
          .to.emit(maintainerProxy, "GasOffsetParametersUpdated")
          .withArgs(40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50)
      })

      it("should update submitRedemptionProofGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.submitRedemptionProofGasOffset()
        expect(updatedOffset).to.be.equal(41)
      })

      it("should update resetMovingFundsTimeoutGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.resetMovingFundsTimeoutGasOffset()
        expect(updatedOffset).to.be.equal(42)
      })

      it("should update submitMovingFundsProofGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.submitMovingFundsProofGasOffset()
        expect(updatedOffset).to.be.equal(43)
      })

      it("should update notifyMovingFundsBelowDustGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.notifyMovingFundsBelowDustGasOffset()
        expect(updatedOffset).to.be.equal(44)
      })

      it("should update submitMovedFundsSweepProofGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.submitMovedFundsSweepProofGasOffset()
        expect(updatedOffset).to.be.equal(45)
      })

      it("should update requestNewWalletGasOffset", async () => {
        const updatedOffset = await maintainerProxy.requestNewWalletGasOffset()
        expect(updatedOffset).to.be.equal(46)
      })

      it("should update notifyWalletCloseableGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.notifyWalletCloseableGasOffset()
        expect(updatedOffset).to.be.equal(47)
      })

      it("should update notifyWalletClosingPeriodElapsedGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.notifyWalletClosingPeriodElapsedGasOffset()
        expect(updatedOffset).to.be.equal(48)
      })

      it("should update defeatFraudChallengeGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.defeatFraudChallengeGasOffset()
        expect(updatedOffset).to.be.equal(49)
      })

      it("should update defeatFraudChallengeWithHeartbeatGasOffset", async () => {
        const updatedOffset =
          await maintainerProxy.defeatFraudChallengeWithHeartbeatGasOffset()
        expect(updatedOffset).to.be.equal(50)
      })
    })
  })

  describe("updateReimbursementPool", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .updateReimbursementPool(thirdParty.address)
        ).to.be.revertedWith("Caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await maintainerProxy
          .connect(governance)
          .updateReimbursementPool(thirdParty.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit the ReimbursementPoolUpdated event", async () => {
        await expect(tx)
          .to.emit(maintainerProxy, "ReimbursementPoolUpdated")
          .withArgs(thirdParty.address)
      })
    })
  })

  async function makeRedemptionAllowance(
    redeemer: SignerWithAddress,
    amount: BigNumberish
  ): Promise<ContractTransaction> {
    // Simulate the redeemer has a TBTC balance allowing to make the request.
    await bank.setBalance(redeemer.address, amount)
    // Redeemer must allow the Bridge to spent the requested amount.
    return bank
      .connect(redeemer)
      .increaseBalanceAllowance(bridge.address, amount)
  }

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

    return maintainerProxy
      .connect(spvMaintainer)
      .submitDepositSweepProof(
        data.sweepTx,
        data.sweepProof,
        data.mainUtxo,
        data.vault
      )
      .then((tx: ContractTransaction) => {
        relay.getCurrentEpochDifficulty.reset()
        relay.getPrevEpochDifficulty.reset()

        return tx
      })
  }

  async function runRedemptionScenario(
    data: RedemptionTestData,
    beforeRequestActions?: () => Promise<void>,
    beforeProofActions?: () => Promise<void>
  ): Promise<ContractTransaction> {
    relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
    relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)

    // Scaling down redemption dust threshold 100x to what is in Bridge default
    // parameters.
    await bridge.setRedemptionDustThreshold(10000)
    // Scaling down moving funds dust threshold 100x to what is in Bridge
    // default parameters. This is needed because we lowered the redemption
    // dust threshold and the moving funds dust threshold must be always
    // below it.
    await bridgeGovernance
      .connect(governance)
      .beginMovingFundsDustThresholdUpdate(2000)
    await increaseTime(await bridgeGovernance.governanceDelays(0))
    await bridgeGovernance
      .connect(governance)
      .finalizeMovingFundsDustThresholdUpdate()
    // Scaling down redemption TX max fee accordingly.
    await bridgeGovernance
      .connect(governance)
      .beginRedemptionTxMaxFeeUpdate(1000)
    await increaseTime(await bridgeGovernance.governanceDelays(0))
    await bridgeGovernance
      .connect(governance)
      .finalizeRedemptionTxMaxFeeUpdate()

    // Simulate the wallet is a registered one.
    await bridge.setWallet(data.wallet.pubKeyHash, {
      ecdsaWalletID: data.wallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: data.wallet.pendingRedemptionsValue,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: data.wallet.state,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })
    // Simulate the prepared main UTXO belongs to the wallet.
    await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, data.mainUtxo)

    if (beforeRequestActions) {
      await beforeRequestActions()
    }

    for (let i = 0; i < data.redemptionRequests.length; i++) {
      const { redeemer, redeemerOutputScript, amount } =
        data.redemptionRequests[i]

      /* eslint-disable no-await-in-loop */
      const redeemerSigner = await impersonateAccount(redeemer, {
        from: governance,
        value: 100,
      })

      await makeRedemptionAllowance(redeemerSigner, amount)

      await bridge
        .connect(redeemerSigner)
        .requestRedemption(
          data.wallet.pubKeyHash,
          data.mainUtxo,
          redeemerOutputScript,
          amount
        )
      /* eslint-enable no-await-in-loop */
    }

    if (beforeProofActions) {
      await beforeProofActions()
    }

    return maintainerProxy
      .connect(spvMaintainer)
      .submitRedemptionProof(
        data.redemptionTx,
        data.redemptionProof,
        data.mainUtxo,
        data.wallet.pubKeyHash
      )
      .then((tx: ContractTransaction) => {
        relay.getCurrentEpochDifficulty.reset()
        relay.getPrevEpochDifficulty.reset()

        return tx
      })
  }

  async function runMovingFundsScenario(
    data: MovingFundsTestData,
    beforeProofActions?: () => Promise<void>
  ): Promise<ContractTransaction> {
    relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
    relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)

    // Simulate the wallet is a registered one.
    await bridge.setWallet(data.wallet.pubKeyHash, {
      ecdsaWalletID: data.wallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: await lastBlockTime(),
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: data.wallet.state,
      movingFundsTargetWalletsCommitmentHash:
        data.targetWalletsCommitment.length > 0
          ? ethers.utils.solidityKeccak256(
              ["bytes20[]"],
              [data.targetWalletsCommitment]
            )
          : ethers.constants.HashZero,
    })
    // Simulate the prepared main UTXO belongs to the wallet.
    await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, data.mainUtxo)

    if (beforeProofActions) {
      await beforeProofActions()
    }

    return maintainerProxy
      .connect(spvMaintainer)
      .submitMovingFundsProof(
        data.movingFundsTx,
        data.movingFundsProof,
        data.mainUtxo,
        data.wallet.pubKeyHash
      )
      .then((tx: ContractTransaction) => {
        relay.getCurrentEpochDifficulty.reset()
        relay.getPrevEpochDifficulty.reset()

        return tx
      })
  }

  async function runMovedFundsSweepScenario(
    data: MovedFundsSweepTestData,
    beforeProofActions?: () => Promise<void>
  ): Promise<ContractTransaction> {
    relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)
    relay.getPrevEpochDifficulty.returns(data.chainDifficulty)

    // Simulate the wallet is a registered one.
    await bridge.setWallet(data.wallet.pubKeyHash, {
      ecdsaWalletID: data.wallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: data.wallet.state,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })

    if (data.mainUtxo.txHash !== ethers.constants.HashZero) {
      // Simulate the prepared main UTXO belongs to the wallet.
      await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, data.mainUtxo)
    }

    if (data.movedFundsSweepRequest) {
      await bridge.setPendingMovedFundsSweepRequest(
        data.movedFundsSweepRequest.walletPubKeyHash,
        data.movedFundsSweepRequest
      )
      // Just make sure the stub function `setPendingMovedFundsSweepRequest`
      // initialized the counter properly.
      assert(
        (await bridge.wallets(data.movedFundsSweepRequest.walletPubKeyHash))
          .pendingMovedFundsSweepRequestsCount === 1,
        "Pending moved funds request counter for the sweeping wallet should be set up to 1"
      )
    }

    if (beforeProofActions) {
      await beforeProofActions()
    }

    return maintainerProxy
      .connect(spvMaintainer)
      .submitMovedFundsSweepProof(data.sweepTx, data.sweepProof, data.mainUtxo)
      .then((tx: ContractTransaction) => {
        relay.getCurrentEpochDifficulty.reset()
        relay.getPrevEpochDifficulty.reset()

        return tx
      })
  }
})
