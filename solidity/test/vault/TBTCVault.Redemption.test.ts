import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { expect } from "chai"
import { BigNumberish, ContractTransaction } from "ethers"
import { BytesLike } from "@ethersproject/bytes"

import { constants, walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"
import { toSatoshis } from "../helpers/contract-test-helpers"

import type {
  Bank,
  BankStub,
  Bridge,
  BridgeStub,
  MockAccountControlRedemptionNotifier,
  TBTC,
  TBTCVault,
} from "../../typechain"

const { to1e18 } = helpers.number
const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time
const { defaultAbiCoder } = ethers.utils

describe("TBTCVault - Redemption", () => {
  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const mainUtxo = {
    txHash:
      "0x3835ecdee2daa83c9a19b5012104ace55ecab197b5e16489c26d372e475f5d2a",
    txOutputIndex: 0,
    txOutputValue: 10000000000,
  }

  let bridge: Bridge & BridgeStub
  let bank: Bank & BankStub
  let tbtc: TBTC
  let tbtcVault: TBTCVault

  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let account1: SignerWithAddress
  let account2: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, governance, bridge, bank, tbtcVault, tbtc } =
      await waffle.loadFixture(bridgeFixture))

    // TBTC token ownership transfer is not performed in deployment scripts.
    // Check TransferTBTCOwnership deployment step for more information.
    await tbtc.connect(deployer).transferOwnership(tbtcVault.address)

    const accounts = await getUnnamedAccounts()
    account1 = await ethers.getSigner(accounts[0])
    account2 = await ethers.getSigner(accounts[1])

    const initialBankBalance = to1e18(100)
    await bank.setBalance(account1.address, initialBankBalance)
    await bank.setBalance(account2.address, initialBankBalance)
    await bank
      .connect(account1)
      .approveBalance(tbtcVault.address, initialBankBalance)
    await bank
      .connect(account2)
      .approveBalance(tbtcVault.address, initialBankBalance)

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
    await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)
  })

  describe("unmintAndRedeem", () => {
    const requestRedemption = async (
      redeemer: SignerWithAddress,
      redeemerOutputScript: string,
      amount: BigNumberish
    ): Promise<ContractTransaction> => {
      const data = defaultAbiCoder.encode(
        ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
        [
          redeemer.address,
          walletPubKeyHash,
          mainUtxo.txHash,
          mainUtxo.txOutputIndex,
          mainUtxo.txOutputValue,
          redeemerOutputScript,
        ]
      )

      return tbtcVault.connect(redeemer).unmintAndRedeem(amount, data)
    }

    context("when the redeemer has no TBTC", () => {
      const amount = to1e18(1)
      before(async () => {
        await createSnapshot()

        await tbtc.connect(account1).approve(tbtcVault.address, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          tbtcVault.connect(account1).unmintAndRedeem(to1e18(1), [])
        ).to.be.revertedWith("Burn amount exceeds balance")
      })
    })

    context("when the redeemer has not enough TBTC", () => {
      const mintedAmount = to1e18(1)
      const redeemedAmount = mintedAmount.add(constants.satoshiMultiplier)

      before(async () => {
        await createSnapshot()

        await tbtcVault.connect(account1).mint(mintedAmount)
        await tbtc.connect(account1).approve(tbtcVault.address, redeemedAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          tbtcVault.connect(account1).unmintAndRedeem(redeemedAmount, [])
        ).to.be.revertedWith("Burn amount exceeds balance")
      })
    })

    context("when there is a single redeemer", () => {
      const redeemerOutputScriptP2WPKH =
        "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
      const redeemerOutputScriptP2WSH =
        "0x220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c"
      const redeemerOutputScriptP2PKH =
        "0x1976a914f4eedc8f40d4b8e30771f792b065ebec0abaddef88ac"
      const redeemerOutputScriptP2SH =
        "0x17a914f4eedc8f40d4b8e30771f792b065ebec0abaddef87"

      const mintedAmount = to1e18(100)
      const redeemedAmount1 = to1e18(10)
      const redeemedAmount2 = to1e18(20)
      const redeemedAmount3 = to1e18(30)
      const redeemedAmount4 = to1e18(15)
      const totalRedeemedAmount = redeemedAmount1
        .add(redeemedAmount2)
        .add(redeemedAmount3)
        .add(redeemedAmount4)
      const notRedeemedAmount = mintedAmount.sub(totalRedeemedAmount)

      const transactions: ContractTransaction[] = []

      before(async () => {
        await createSnapshot()

        await tbtcVault.connect(account1).mint(mintedAmount)
        await tbtc.connect(account1).approve(tbtcVault.address, mintedAmount)

        transactions.push(
          await requestRedemption(
            account1,
            redeemerOutputScriptP2WPKH,
            redeemedAmount1
          )
        )
        transactions.push(
          await requestRedemption(
            account1,
            redeemerOutputScriptP2WSH,
            redeemedAmount2
          )
        )
        transactions.push(
          await requestRedemption(
            account1,
            redeemerOutputScriptP2PKH,
            redeemedAmount3
          )
        )
        transactions.push(
          await requestRedemption(
            account1,
            redeemerOutputScriptP2SH,
            redeemedAmount4
          )
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer balances to Bridge", async () => {
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(
          notRedeemedAmount.div(constants.satoshiMultiplier)
        )
        expect(await bank.balanceOf(bridge.address)).to.equal(
          totalRedeemedAmount.div(constants.satoshiMultiplier)
        )
      })

      it("should request redemptions in Bridge", async () => {
        const redemptionRequest1 = await bridge.pendingRedemptions(
          buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WPKH)
        )
        expect(redemptionRequest1.redeemer).to.be.equal(account1.address)
        expect(redemptionRequest1.requestedAmount).to.be.equal(
          redeemedAmount1.div(constants.satoshiMultiplier)
        )

        const redemptionRequest2 = await bridge.pendingRedemptions(
          buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WSH)
        )
        expect(redemptionRequest2.redeemer).to.be.equal(account1.address)
        expect(redemptionRequest2.requestedAmount).to.be.equal(
          redeemedAmount2.div(constants.satoshiMultiplier)
        )

        const redemptionRequest3 = await bridge.pendingRedemptions(
          buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2PKH)
        )
        expect(redemptionRequest3.redeemer).to.be.equal(account1.address)
        expect(redemptionRequest3.requestedAmount).to.be.equal(
          redeemedAmount3.div(constants.satoshiMultiplier)
        )

        const redemptionRequest4 = await bridge.pendingRedemptions(
          buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2SH)
        )
        expect(redemptionRequest4.redeemer).to.be.equal(account1.address)
        expect(redemptionRequest4.requestedAmount).to.be.equal(
          redeemedAmount4.div(constants.satoshiMultiplier)
        )
      })

      it("should burn TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          notRedeemedAmount
        )
        expect(await tbtc.totalSupply()).to.be.equal(notRedeemedAmount)
      })

      it("should emit Unminted events", async () => {
        await expect(transactions[0])
          .to.emit(tbtcVault, "Unminted")
          .withArgs(account1.address, redeemedAmount1)
        await expect(transactions[1])
          .to.emit(tbtcVault, "Unminted")
          .withArgs(account1.address, redeemedAmount2)
        await expect(transactions[2])
          .to.emit(tbtcVault, "Unminted")
          .withArgs(account1.address, redeemedAmount3)
        await expect(transactions[3])
          .to.emit(tbtcVault, "Unminted")
          .withArgs(account1.address, redeemedAmount4)
      })
    })

    context("when amount is not fully convertible to satoshis", () => {
      const redeemerOutputScriptP2WPKH =
        "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"

      const mintedAmount = to1e18(20)
      // Amount is 3 Bitcoin in 1e18 precision plus 0.1 satoshi in 1e18 precision
      const redeemedAmount = ethers.BigNumber.from("3000000001000000000")
      const notRedeemedAmount = to1e18(17) // 20 - 3; remainder should be ignored

      let transaction: ContractTransaction

      before(async () => {
        await createSnapshot()

        await tbtcVault.connect(account1).mint(mintedAmount)
        await tbtc.connect(account1).approve(tbtcVault.address, mintedAmount)

        transaction = await requestRedemption(
          account1,
          redeemerOutputScriptP2WPKH,
          redeemedAmount
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      // redeeming 3 BTC, the remainder is ignored

      it("should transfer balances to Bridge", async () => {
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(
          notRedeemedAmount.div(constants.satoshiMultiplier)
        )
        expect(await bank.balanceOf(bridge.address)).to.equal(toSatoshis(3))
      })

      it("should request redemptions in Bridge", async () => {
        const redemptionRequest1 = await bridge.pendingRedemptions(
          buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WPKH)
        )
        expect(redemptionRequest1.redeemer).to.be.equal(account1.address)
        expect(redemptionRequest1.requestedAmount).to.be.equal(toSatoshis(3))
      })

      it("should burn TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          notRedeemedAmount
        )
        expect(await tbtc.totalSupply()).to.be.equal(notRedeemedAmount)
      })

      it("should emit Unminted events", async () => {
        await expect(transaction)
          .to.emit(tbtcVault, "Unminted")
          .withArgs(account1.address, to1e18(3))
      })
    })

    context("when there are multiple redeemers", () => {
      const redeemerOutputScriptP2WPKH =
        "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
      const redeemerOutputScriptP2WSH =
        "0x220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c"

      const mintedAmount1 = to1e18(10)
      const mintedAmount2 = to1e18(20)
      const redeemedAmount1 = to1e18(1)
      const redeemedAmount2 = to1e18(2)

      const totalMintedAmount = mintedAmount1.add(mintedAmount2)
      const totalRedeemedAmount = redeemedAmount1.add(redeemedAmount2)
      const totalNotRedeemedAmount = totalMintedAmount.sub(totalRedeemedAmount)

      const transactions: ContractTransaction[] = []

      before(async () => {
        await createSnapshot()

        console.log(await bank.balanceOf(account1.address))
        console.log(await bank.balanceOf(account2.address))

        await tbtcVault.connect(account1).mint(mintedAmount1)
        await tbtc.connect(account1).approve(tbtcVault.address, mintedAmount1)

        await tbtcVault.connect(account2).mint(mintedAmount2)
        await tbtc.connect(account2).approve(tbtcVault.address, mintedAmount2)

        transactions.push(
          await requestRedemption(
            account1,
            redeemerOutputScriptP2WPKH,
            redeemedAmount1
          )
        )
        transactions.push(
          await requestRedemption(
            account2,
            redeemerOutputScriptP2WSH,
            redeemedAmount2
          )
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should transfer balances to Bridge", async () => {
        expect(await bank.balanceOf(tbtcVault.address)).to.equal(
          totalNotRedeemedAmount.div(constants.satoshiMultiplier)
        )
        expect(await bank.balanceOf(bridge.address)).to.equal(
          totalRedeemedAmount.div(constants.satoshiMultiplier)
        )
      })

      it("should request redemptions in Bridge", async () => {
        const redemptionRequest1 = await bridge.pendingRedemptions(
          buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WPKH)
        )
        expect(redemptionRequest1.redeemer).to.be.equal(account1.address)
        expect(redemptionRequest1.requestedAmount).to.be.equal(
          redeemedAmount1.div(constants.satoshiMultiplier)
        )

        const redemptionRequest2 = await bridge.pendingRedemptions(
          buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WSH)
        )
        expect(redemptionRequest2.redeemer).to.be.equal(account2.address)
        expect(redemptionRequest2.requestedAmount).to.be.equal(
          redeemedAmount2.div(constants.satoshiMultiplier)
        )
      })

      it("should burn TBTC", async () => {
        expect(await tbtc.balanceOf(account1.address)).to.equal(
          mintedAmount1.sub(redeemedAmount1)
        )
        expect(await tbtc.balanceOf(account2.address)).to.equal(
          mintedAmount2.sub(redeemedAmount2)
        )
        expect(await tbtc.totalSupply()).to.be.equal(totalNotRedeemedAmount)
      })

      it("should emit Unminted events", async () => {
        await expect(transactions[0])
          .to.emit(tbtcVault, "Unminted")
          .withArgs(account1.address, redeemedAmount1)
        await expect(transactions[1])
          .to.emit(tbtcVault, "Unminted")
          .withArgs(account2.address, redeemedAmount2)
      })
    })
  })

  describe("receiveApproval", () => {
    const requestRedemption = async (
      redeemer: SignerWithAddress,
      redeemerOutputScript: string,
      amount: BigNumberish
    ): Promise<ContractTransaction> => {
      const data = defaultAbiCoder.encode(
        ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
        [
          redeemer.address,
          walletPubKeyHash,
          mainUtxo.txHash,
          mainUtxo.txOutputIndex,
          mainUtxo.txOutputValue,
          redeemerOutputScript,
        ]
      )

      return tbtc
        .connect(redeemer)
        .approveAndCall(tbtcVault.address, amount, data)
    }

    context("when called via approveAndCall", () => {
      context("when called with non-empty extraData", () => {
        context("when there is a single redeemer", () => {
          const redeemerOutputScriptP2WPKH =
            "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
          const redeemerOutputScriptP2WSH =
            "0x220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c"
          const redeemerOutputScriptP2PKH =
            "0x1976a914f4eedc8f40d4b8e30771f792b065ebec0abaddef88ac"
          const redeemerOutputScriptP2SH =
            "0x17a914f4eedc8f40d4b8e30771f792b065ebec0abaddef87"

          const mintedAmount = to1e18(100)
          const redeemedAmount1 = to1e18(10)
          const redeemedAmount2 = to1e18(20)
          const redeemedAmount3 = to1e18(30)
          const redeemedAmount4 = to1e18(15)
          const totalRedeemedAmount = redeemedAmount1
            .add(redeemedAmount2)
            .add(redeemedAmount3)
            .add(redeemedAmount4)
          const notRedeemedAmount = mintedAmount.sub(totalRedeemedAmount)

          const transactions: ContractTransaction[] = []

          before(async () => {
            await createSnapshot()

            await tbtcVault.connect(account1).mint(mintedAmount)

            transactions.push(
              await requestRedemption(
                account1,
                redeemerOutputScriptP2WPKH,
                redeemedAmount1
              )
            )
            transactions.push(
              await requestRedemption(
                account1,
                redeemerOutputScriptP2WSH,
                redeemedAmount2
              )
            )
            transactions.push(
              await requestRedemption(
                account1,
                redeemerOutputScriptP2PKH,
                redeemedAmount3
              )
            )
            transactions.push(
              await requestRedemption(
                account1,
                redeemerOutputScriptP2SH,
                redeemedAmount4
              )
            )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should transfer balances to Bridge", async () => {
            expect(await bank.balanceOf(tbtcVault.address)).to.equal(
              notRedeemedAmount.div(constants.satoshiMultiplier)
            )
            expect(await bank.balanceOf(bridge.address)).to.equal(
              totalRedeemedAmount.div(constants.satoshiMultiplier)
            )
          })

          it("should request redemptions in Bridge", async () => {
            const redemptionRequest1 = await bridge.pendingRedemptions(
              buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WPKH)
            )
            expect(redemptionRequest1.redeemer).to.be.equal(account1.address)
            expect(redemptionRequest1.requestedAmount).to.be.equal(
              redeemedAmount1.div(constants.satoshiMultiplier)
            )

            const redemptionRequest2 = await bridge.pendingRedemptions(
              buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WSH)
            )
            expect(redemptionRequest2.redeemer).to.be.equal(account1.address)
            expect(redemptionRequest2.requestedAmount).to.be.equal(
              redeemedAmount2.div(constants.satoshiMultiplier)
            )

            const redemptionRequest3 = await bridge.pendingRedemptions(
              buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2PKH)
            )
            expect(redemptionRequest3.redeemer).to.be.equal(account1.address)
            expect(redemptionRequest3.requestedAmount).to.be.equal(
              redeemedAmount3.div(constants.satoshiMultiplier)
            )

            const redemptionRequest4 = await bridge.pendingRedemptions(
              buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2SH)
            )
            expect(redemptionRequest4.redeemer).to.be.equal(account1.address)
            expect(redemptionRequest4.requestedAmount).to.be.equal(
              redeemedAmount4.div(constants.satoshiMultiplier)
            )
          })

          it("should burn TBTC", async () => {
            expect(await tbtc.balanceOf(account1.address)).to.equal(
              notRedeemedAmount
            )
            expect(await tbtc.totalSupply()).to.be.equal(notRedeemedAmount)
          })

          it("should emit Unminted events", async () => {
            await expect(transactions[0])
              .to.emit(tbtcVault, "Unminted")
              .withArgs(account1.address, redeemedAmount1)
            await expect(transactions[1])
              .to.emit(tbtcVault, "Unminted")
              .withArgs(account1.address, redeemedAmount2)
            await expect(transactions[2])
              .to.emit(tbtcVault, "Unminted")
              .withArgs(account1.address, redeemedAmount3)
            await expect(transactions[3])
              .to.emit(tbtcVault, "Unminted")
              .withArgs(account1.address, redeemedAmount4)
          })
        })

        context("when there are multiple redeemers", () => {
          const redeemerOutputScriptP2WPKH =
            "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
          const redeemerOutputScriptP2WSH =
            "0x220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c"

          const mintedAmount1 = to1e18(10)
          const mintedAmount2 = to1e18(20)
          const redeemedAmount1 = to1e18(1)
          const redeemedAmount2 = to1e18(2)

          const totalMintedAmount = mintedAmount1.add(mintedAmount2)
          const totalRedeemedAmount = redeemedAmount1.add(redeemedAmount2)
          const totalNotRedeemedAmount =
            totalMintedAmount.sub(totalRedeemedAmount)

          const transactions: ContractTransaction[] = []

          before(async () => {
            await createSnapshot()

            await tbtcVault.connect(account1).mint(mintedAmount1)
            await tbtcVault.connect(account2).mint(mintedAmount2)

            transactions.push(
              await requestRedemption(
                account1,
                redeemerOutputScriptP2WPKH,
                redeemedAmount1
              )
            )
            transactions.push(
              await requestRedemption(
                account2,
                redeemerOutputScriptP2WSH,
                redeemedAmount2
              )
            )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should transfer balances to Bridge", async () => {
            expect(await bank.balanceOf(tbtcVault.address)).to.equal(
              totalNotRedeemedAmount.div(constants.satoshiMultiplier)
            )
            expect(await bank.balanceOf(bridge.address)).to.equal(
              totalRedeemedAmount.div(constants.satoshiMultiplier)
            )
          })

          it("should request redemptions in Bridge", async () => {
            const redemptionRequest1 = await bridge.pendingRedemptions(
              buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WPKH)
            )
            expect(redemptionRequest1.redeemer).to.be.equal(account1.address)
            expect(redemptionRequest1.requestedAmount).to.be.equal(
              redeemedAmount1.div(constants.satoshiMultiplier)
            )

            const redemptionRequest2 = await bridge.pendingRedemptions(
              buildRedemptionKey(walletPubKeyHash, redeemerOutputScriptP2WSH)
            )
            expect(redemptionRequest2.redeemer).to.be.equal(account2.address)
            expect(redemptionRequest2.requestedAmount).to.be.equal(
              redeemedAmount2.div(constants.satoshiMultiplier)
            )
          })

          it("should burn TBTC", async () => {
            expect(await tbtc.balanceOf(account1.address)).to.equal(
              mintedAmount1.sub(redeemedAmount1)
            )
            expect(await tbtc.balanceOf(account2.address)).to.equal(
              mintedAmount2.sub(redeemedAmount2)
            )
            expect(await tbtc.totalSupply()).to.be.equal(totalNotRedeemedAmount)
          })

          it("should emit Unminted events", async () => {
            await expect(transactions[0])
              .to.emit(tbtcVault, "Unminted")
              .withArgs(account1.address, redeemedAmount1)
            await expect(transactions[1])
              .to.emit(tbtcVault, "Unminted")
              .withArgs(account2.address, redeemedAmount2)
          })
        })
      })
    })
  })

  describe("setAccountControlRedemptionNotifier", () => {
    let notifier: MockAccountControlRedemptionNotifier

    before(async () => {
      await createSnapshot()
      const NotifierFactory = await ethers.getContractFactory(
        "MockAccountControlRedemptionNotifier"
      )
      notifier =
        (await NotifierFactory.deploy()) as MockAccountControlRedemptionNotifier
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault
            .connect(account1)
            .setAccountControlRedemptionNotifier(notifier.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await tbtcVault
          .connect(governance)
          .setAccountControlRedemptionNotifier(notifier.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the configured notifier", async () => {
        expect(await tbtcVault.accountControlRedemptionNotifier()).to.equal(
          notifier.address
        )
      })

      it("should emit AccountControlRedemptionNotifierUpdated", async () => {
        await expect(tx)
          .to.emit(tbtcVault, "AccountControlRedemptionNotifierUpdated")
          .withArgs(notifier.address)
      })
    })
  })

  describe("setAccountControlReconciliationRequired", () => {
    let notifier: MockAccountControlRedemptionNotifier

    before(async () => {
      await createSnapshot()
      const NotifierFactory = await ethers.getContractFactory(
        "MockAccountControlRedemptionNotifier"
      )
      notifier =
        (await NotifierFactory.deploy()) as MockAccountControlRedemptionNotifier
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault
            .connect(account1)
            .setAccountControlReconciliationRequired(true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        await tbtcVault
          .connect(governance)
          .setAccountControlRedemptionNotifier(notifier.address)
        tx = await tbtcVault
          .connect(governance)
          .setAccountControlReconciliationRequired(true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the requirement flag", async () => {
        expect(await tbtcVault.accountControlReconciliationRequired()).to.be
          .true
      })

      it("should emit AccountControlReconciliationRequirementUpdated", async () => {
        await expect(tx)
          .to.emit(tbtcVault, "AccountControlReconciliationRequirementUpdated")
          .withArgs(true)
      })
    })

    context("when enabling the requirement without a notifier", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault
            .connect(governance)
            .setAccountControlReconciliationRequired(true)
        ).to.be.revertedWith("Notifier required to require reconciliation")
      })
    })

    context("when disabling the requirement without a notifier", () => {
      it("should not revert", async () => {
        await expect(
          tbtcVault
            .connect(governance)
            .setAccountControlReconciliationRequired(false)
        ).to.not.be.reverted
      })
    })
  })

  describe("activateAccountControlReconciliation", () => {
    let notifier: MockAccountControlRedemptionNotifier

    before(async () => {
      await createSnapshot()
      const NotifierFactory = await ethers.getContractFactory(
        "MockAccountControlRedemptionNotifier"
      )
      notifier =
        (await NotifierFactory.deploy()) as MockAccountControlRedemptionNotifier
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a non-owner", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault
            .connect(account1)
            .activateAccountControlReconciliation(notifier.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called with the zero notifier", () => {
      it("should revert without half-activating", async () => {
        // Activation must be atomic: it may not leave the vault in the
        // "required but no notifier" state that reverts every legacy
        // redemption, so a zero notifier is rejected outright.
        await expect(
          tbtcVault
            .connect(governance)
            .activateAccountControlReconciliation(ethers.constants.AddressZero)
        ).to.be.revertedWith("Notifier required to activate reconciliation")

        expect(await tbtcVault.accountControlReconciliationRequired()).to.be
          .false
        expect(await tbtcVault.accountControlRedemptionNotifier()).to.equal(
          ethers.constants.AddressZero
        )
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await tbtcVault
          .connect(governance)
          .activateAccountControlReconciliation(notifier.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should wire the notifier and require reconciliation atomically", async () => {
        expect(await tbtcVault.accountControlRedemptionNotifier()).to.equal(
          notifier.address
        )
        expect(await tbtcVault.accountControlReconciliationRequired()).to.be
          .true
      })

      it("should emit both configuration events", async () => {
        await expect(tx)
          .to.emit(tbtcVault, "AccountControlRedemptionNotifierUpdated")
          .withArgs(notifier.address)
        await expect(tx)
          .to.emit(tbtcVault, "AccountControlReconciliationRequirementUpdated")
          .withArgs(true)
      })
    })
  })

  describe("Account Control redemption reconciliation", () => {
    const redeemerOutputScript =
      "0x160014f4eedc8f40d4b8e30771f792b065ebec0abaddef"
    const mintedAmount = to1e18(10)
    const redeemedAmount = to1e18(4)
    let notifier: MockAccountControlRedemptionNotifier

    const requestRedemption = async (
      redeemer: SignerWithAddress,
      amount: BigNumberish
    ): Promise<ContractTransaction> => {
      const data = defaultAbiCoder.encode(
        ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
        [
          redeemer.address,
          walletPubKeyHash,
          mainUtxo.txHash,
          mainUtxo.txOutputIndex,
          mainUtxo.txOutputValue,
          redeemerOutputScript,
        ]
      )
      return tbtcVault.connect(redeemer).unmintAndRedeem(amount, data)
    }

    // Asserts that calling `call` reverts with `revertReason` before any
    // durable state change: no notifier call, no TBTC burn/supply
    // change/allowance consumption, and no Bank transfer. Used to prove the
    // plain-unmint disablement is atomic, regardless of which entry point or
    // notifier configuration triggers it. Takes a thunk rather than a bare
    // promise so the transaction is only sent after the "before" snapshot is
    // captured.
    const expectAtomicRevert = async (
      call: () => Promise<ContractTransaction>,
      revertReason: string
    ): Promise<void> => {
      const callCountBefore = await notifier.callCount()
      const allowanceBefore = await tbtc.allowance(
        account1.address,
        tbtcVault.address
      )
      const bankBalanceBefore = await bank.balanceOf(account1.address)
      const vaultBankBalanceBefore = await bank.balanceOf(tbtcVault.address)
      const supplyBefore = await tbtc.totalSupply()

      await expect(call()).to.be.revertedWith(revertReason)

      expect(await notifier.callCount()).to.equal(callCountBefore)
      expect(await tbtc.balanceOf(account1.address)).to.equal(mintedAmount)
      expect(await tbtc.totalSupply()).to.equal(supplyBefore)
      expect(
        await tbtc.allowance(account1.address, tbtcVault.address)
      ).to.equal(allowanceBefore)
      expect(await bank.balanceOf(account1.address)).to.equal(bankBalanceBefore)
      expect(await bank.balanceOf(tbtcVault.address)).to.equal(
        vaultBankBalanceBefore
      )
    }

    before(async () => {
      await createSnapshot()

      const NotifierFactory = await ethers.getContractFactory(
        "MockAccountControlRedemptionNotifier"
      )
      notifier =
        (await NotifierFactory.deploy()) as MockAccountControlRedemptionNotifier

      await tbtcVault.connect(account1).mint(mintedAmount)
      await tbtc.connect(account1).approve(tbtcVault.address, mintedAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when no notifier is configured", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("redeems without any reconciliation call", async () => {
        // Reconciliation is not required (the default), so the legacy path
        // completes without a notifier - the non-AC deployment behaviour.
        await requestRedemption(account1, redeemedAmount)

        expect(await notifier.callCount()).to.equal(0)
        expect(await bank.balanceOf(bridge.address)).to.equal(
          redeemedAmount.div(constants.satoshiMultiplier)
        )
      })
    })

    context(
      "when reconciliation is required but no notifier is configured",
      () => {
        before(async () => {
          await createSnapshot()
          await tbtcVault
            .connect(governance)
            .activateAccountControlReconciliation(notifier.address)
          await tbtcVault
            .connect(governance)
            .setAccountControlRedemptionNotifier(ethers.constants.AddressZero)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("reverts the redemption and burns no TBTC", async () => {
          // An AC deployment that turned on the requirement must not let
          // AC-origin supply redeem through the legacy path without a notifier.
          await expect(
            requestRedemption(account1, redeemedAmount)
          ).to.be.revertedWith("Account Control reconciliation required")

          expect(await tbtc.balanceOf(account1.address)).to.equal(mintedAmount)
        })
      }
    )

    context(
      "when reconciliation is required and a notifier is configured",
      () => {
        before(async () => {
          await createSnapshot()
          await tbtcVault
            .connect(governance)
            .activateAccountControlReconciliation(notifier.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("reconciles the reserve and completes the redemption", async () => {
          await requestRedemption(account1, redeemedAmount)

          expect(await notifier.callCount()).to.equal(1)
          expect(await bank.balanceOf(bridge.address)).to.equal(
            redeemedAmount.div(constants.satoshiMultiplier)
          )
        })
      }
    )

    context("when a notifier is configured and reconciliation succeeds", () => {
      before(async () => {
        await createSnapshot()
        await tbtcVault
          .connect(governance)
          .setAccountControlRedemptionNotifier(notifier.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("reconciles the reserve and completes the redemption", async () => {
        await requestRedemption(account1, redeemedAmount)

        expect(await notifier.callCount()).to.equal(1)
        expect(await notifier.lastRedeemer()).to.equal(account1.address)
        expect(await notifier.lastAmount()).to.equal(redeemedAmount)
        expect(await bank.balanceOf(bridge.address)).to.equal(
          redeemedAmount.div(constants.satoshiMultiplier)
        )
      })
    })

    context("when a notifier is configured and reconciliation fails", () => {
      before(async () => {
        await createSnapshot()
        await tbtcVault
          .connect(governance)
          .setAccountControlRedemptionNotifier(notifier.address)
        await notifier.setShouldRevert(true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("reverts the redemption and burns no TBTC", async () => {
        await expect(
          requestRedemption(account1, redeemedAmount)
        ).to.be.revertedWith("AC reconciliation failed")

        // The redeemer keeps their TBTC because the redemption reverted.
        expect(await tbtc.balanceOf(account1.address)).to.equal(mintedAmount)
      })
    })

    context(
      "when reconciliation is activated (the AC deployment guarantee)",
      () => {
        // Exercises the activation guarantee: once an Account Control deployment
        // activates reconciliation, AC-origin supply is reconciled on the
        // legacy redemption path.
        before(async () => {
          await createSnapshot()
          await tbtcVault
            .connect(governance)
            .activateAccountControlReconciliation(notifier.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("reconciles AC-origin supply on the legacy redemption", async () => {
          await requestRedemption(account1, redeemedAmount)

          expect(await notifier.callCount()).to.equal(1)
          expect(await notifier.lastRedeemer()).to.equal(account1.address)
          expect(await notifier.lastAmount()).to.equal(redeemedAmount)
          expect(await bank.balanceOf(bridge.address)).to.equal(
            redeemedAmount.div(constants.satoshiMultiplier)
          )
        })
      }
    )

    context("when an activated notifier is later removed", () => {
      // The requirement flag survives clearing the notifier, so an operator
      // cannot reopen the bypass by unsetting the notifier after activation:
      // the legacy redemption reverts instead of completing without AC
      // accounting.
      before(async () => {
        await createSnapshot()
        await tbtcVault
          .connect(governance)
          .activateAccountControlReconciliation(notifier.address)
        await tbtcVault
          .connect(governance)
          .setAccountControlRedemptionNotifier(ethers.constants.AddressZero)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("reverts the legacy redemption instead of bypassing AC accounting", async () => {
        await expect(
          requestRedemption(account1, redeemedAmount)
        ).to.be.revertedWith("Account Control reconciliation required")

        expect(await tbtc.balanceOf(account1.address)).to.equal(mintedAmount)
      })
    })

    context("when the configured notifier is codeless", () => {
      // An address with no deployed code (e.g. a misconfigured governance
      // parameter) must not silently succeed: a high-level call to a
      // function with no return value still reverts against a codeless
      // address under this compiler version, so the redemption fails closed
      // exactly like a reverting notifier.
      before(async () => {
        await createSnapshot()
        await tbtcVault
          .connect(governance)
          .activateAccountControlReconciliation(notifier.address)
        await tbtcVault
          .connect(governance)
          .setAccountControlRedemptionNotifier(account2.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("reverts the redemption and burns no TBTC", async () => {
        await expect(requestRedemption(account1, redeemedAmount)).to.be.reverted

        expect(await tbtc.balanceOf(account1.address)).to.equal(mintedAmount)
      })
    })

    context(
      "when called through receiveApproval with non-empty extraData (the callback entry point)",
      () => {
        before(async () => {
          await createSnapshot()
          await tbtcVault
            .connect(governance)
            .activateAccountControlReconciliation(notifier.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("reconciles the reserve and completes the redemption", async () => {
          const data = defaultAbiCoder.encode(
            ["address", "bytes20", "bytes32", "uint32", "uint64", "bytes"],
            [
              account1.address,
              walletPubKeyHash,
              mainUtxo.txHash,
              mainUtxo.txOutputIndex,
              mainUtxo.txOutputValue,
              redeemerOutputScript,
            ]
          )

          await tbtc
            .connect(account1)
            .approveAndCall(tbtcVault.address, redeemedAmount, data)

          expect(await notifier.callCount()).to.equal(1)
          expect(await notifier.lastRedeemer()).to.equal(account1.address)
          expect(await notifier.lastAmount()).to.equal(redeemedAmount)
          expect(await bank.balanceOf(bridge.address)).to.equal(
            redeemedAmount.div(constants.satoshiMultiplier)
          )
        })
      }
    )

    describe("via the plain unmint path", () => {
      // Once Account Control reconciliation is required, plain unmint no
      // longer reconciles AC exposure the way `unmintAndRedeem` does - it is
      // disabled outright. A *reversible* per-unmint decrement would create
      // transferable Bank balance that can be handed to an unrelated holder
      // and re-minted through `mint`/`receiveBalanceApproval`, permanently
      // detaching the decrement from the balance it was meant to track.
      // `unmintAndRedeem` remains the irreversible, reconciled exit for
      // AC-origin supply - see the "cross-route transfer-then-remint" tests
      // below for the end-to-end fungibility argument.
      const revertReason =
        "Unmint unavailable while Account Control reconciliation is required"

      context("when reconciliation is not required (legacy behaviour)", () => {
        context("when no notifier is configured", () => {
          before(async () => {
            await createSnapshot()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("unmints without any reconciliation call", async () => {
            await tbtcVault.connect(account1).unmint(redeemedAmount)

            expect(await notifier.callCount()).to.equal(0)
          })
        })

        context("when a notifier is configured but not required", () => {
          // Configuring a notifier alone must not create a reversible
          // decrement: the requirement flag is what activates reconciliation,
          // not the mere presence of a notifier address.
          before(async () => {
            await createSnapshot()
            await tbtcVault
              .connect(governance)
              .setAccountControlRedemptionNotifier(notifier.address)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("unmints without calling the configured notifier", async () => {
            await tbtcVault.connect(account1).unmint(redeemedAmount)

            expect(await notifier.callCount()).to.equal(0)
          })
        })
      })

      context("when reconciliation is required", () => {
        context("when the notifier is healthy", () => {
          before(async () => {
            await createSnapshot()
            await tbtcVault
              .connect(governance)
              .activateAccountControlReconciliation(notifier.address)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("reverts with no notifier call, burn, allowance consumption, supply change, or Bank transfer", async () => {
            await expectAtomicRevert(
              () => tbtcVault.connect(account1).unmint(redeemedAmount),
              revertReason
            )
          })
        })

        context("when the notifier is missing (zero address)", () => {
          before(async () => {
            await createSnapshot()
            await tbtcVault
              .connect(governance)
              .activateAccountControlReconciliation(notifier.address)
            await tbtcVault
              .connect(governance)
              .setAccountControlRedemptionNotifier(ethers.constants.AddressZero)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("reverts identically, independent of notifier health", async () => {
            await expectAtomicRevert(
              () => tbtcVault.connect(account1).unmint(redeemedAmount),
              revertReason
            )
          })
        })

        context("when the notifier is codeless", () => {
          before(async () => {
            await createSnapshot()
            await tbtcVault
              .connect(governance)
              .activateAccountControlReconciliation(notifier.address)
            await tbtcVault
              .connect(governance)
              .setAccountControlRedemptionNotifier(account2.address)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("reverts identically, independent of notifier health", async () => {
            await expectAtomicRevert(
              () => tbtcVault.connect(account1).unmint(redeemedAmount),
              revertReason
            )
          })
        })

        context("when the notifier would revert", () => {
          before(async () => {
            await createSnapshot()
            await tbtcVault
              .connect(governance)
              .activateAccountControlReconciliation(notifier.address)
            await notifier.setShouldRevert(true)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("reverts identically, independent of notifier health", async () => {
            await expectAtomicRevert(
              () => tbtcVault.connect(account1).unmint(redeemedAmount),
              revertReason
            )
          })
        })
      })
    })

    describe("via receiveApproval with empty extraData", () => {
      // `receiveApproval` with empty `extraData` routes to the same shared
      // `_unmint`, so it is disabled by the same guard and for the same
      // reason as the direct `unmint` path above.
      const revertReason =
        "Unmint unavailable while Account Control reconciliation is required"

      context("when reconciliation is not required (legacy behaviour)", () => {
        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("unmints without any reconciliation call", async () => {
          await tbtc
            .connect(account1)
            .approveAndCall(tbtcVault.address, redeemedAmount, [])

          expect(await notifier.callCount()).to.equal(0)
        })
      })

      context("when reconciliation is required", () => {
        before(async () => {
          await createSnapshot()
          await tbtcVault
            .connect(governance)
            .activateAccountControlReconciliation(notifier.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("reverts with the same atomicity guarantees as direct unmint", async () => {
          await expectAtomicRevert(
            () =>
              tbtc
                .connect(account1)
                .approveAndCall(tbtcVault.address, redeemedAmount, []),
            revertReason
          )
        })
      })
    })

    describe("cross-route transfer-then-remint cannot restore AC exposure", () => {
      // Bank balance is transferable, so a *reversible* per-unmint AC
      // decrement could be defeated by moving the balance to an unrelated
      // holder before it is re-minted: A unmints (recording a decrement), A
      // transfers the resulting Bank balance to B, and B re-mints it as TBTC
      // through `mint` or `receiveBalanceApproval` - neither of which
      // restores the decrement A's unmint recorded. Repeating the cycle would
      // deflate AC's recorded exposure without ever completing an
      // irreversible redemption. Disabling plain unmint once reconciliation
      // is required removes this at the source: A never obtains Bank credit
      // to transfer in the first place, so the sequence below cannot get past
      // its first leg.
      const freshBalance = toSatoshis(3)

      context("before Account Control activation (legacy behaviour)", () => {
        context("via a direct Bank transfer and mint", () => {
          before(async () => {
            await createSnapshot()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("allows plain unmint, transfer, and remint", async () => {
            const satoshis = redeemedAmount.div(constants.satoshiMultiplier)
            const aBankBalanceBefore = await bank.balanceOf(account1.address)

            await tbtcVault.connect(account1).unmint(redeemedAmount)
            expect(await bank.balanceOf(account1.address)).to.equal(
              aBankBalanceBefore.add(satoshis)
            )

            await bank
              .connect(account1)
              .transferBalance(account2.address, satoshis)

            const bTbtcBefore = await tbtc.balanceOf(account2.address)
            await tbtcVault
              .connect(account2)
              .mint(satoshis.mul(constants.satoshiMultiplier))

            expect(await tbtc.balanceOf(account2.address)).to.equal(
              bTbtcBefore.add(satoshis.mul(constants.satoshiMultiplier))
            )
            expect(await notifier.callCount()).to.equal(0)
          })
        })

        context(
          "via a delegated Bank transfer and receiveBalanceApproval",
          () => {
            before(async () => {
              await createSnapshot()
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("allows plain unmint, delegated transfer, and remint", async () => {
              const satoshis = redeemedAmount.div(constants.satoshiMultiplier)

              await tbtcVault.connect(account1).unmint(redeemedAmount)

              await bank
                .connect(account1)
                .approveBalance(account2.address, satoshis)
              await bank
                .connect(account2)
                .transferBalanceFrom(
                  account1.address,
                  account2.address,
                  satoshis
                )

              const bTbtcBefore = await tbtc.balanceOf(account2.address)
              await bank
                .connect(account2)
                .approveBalanceAndCall(tbtcVault.address, satoshis, [])

              expect(await tbtc.balanceOf(account2.address)).to.equal(
                bTbtcBefore.add(satoshis.mul(constants.satoshiMultiplier))
              )
              expect(await notifier.callCount()).to.equal(0)
            })
          }
        )
      })

      context("after Account Control activation", () => {
        context("via a direct Bank transfer and mint", () => {
          before(async () => {
            await createSnapshot()
            await tbtcVault
              .connect(governance)
              .activateAccountControlReconciliation(notifier.address)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("blocks transfer-then-remint after Account Control activation", async () => {
            // A cannot obtain Bank credit from plain unmint once
            // reconciliation is required.
            await expect(
              tbtcVault.connect(account1).unmint(redeemedAmount)
            ).to.be.revertedWith(
              "Unmint unavailable while Account Control reconciliation is required"
            )
            expect(await notifier.callCount()).to.equal(0)
            expect(await tbtc.balanceOf(account1.address)).to.equal(
              mintedAmount
            )

            // Unrelated fresh Bank balance for A - not proceeds of the
            // reverted unmint above (e.g. an ordinary BTC deposit). Zeroing
            // both balances first makes the causation of what follows
            // unambiguous.
            await bank.setBalance(account1.address, freshBalance)
            await bank.setBalance(account2.address, 0)

            await bank
              .connect(account1)
              .transferBalance(account2.address, freshBalance)
            expect(await bank.balanceOf(account2.address)).to.equal(
              freshBalance
            )

            // B re-mints the unrelated balance through the ordinary mint
            // path.
            await tbtcVault
              .connect(account2)
              .mint(freshBalance.mul(constants.satoshiMultiplier))

            expect(await tbtc.balanceOf(account2.address)).to.equal(
              freshBalance.mul(constants.satoshiMultiplier)
            )
            // The transfer-then-remint sequence never touched AC accounting:
            // the blocked unmint never called the notifier, and `mint` does
            // not call it either, so there is no reversible decrement it
            // could have consumed or restored.
            expect(await notifier.callCount()).to.equal(0)
          })
        })

        context(
          "via a delegated Bank transfer and receiveBalanceApproval",
          () => {
            before(async () => {
              await createSnapshot()
              await tbtcVault
                .connect(governance)
                .activateAccountControlReconciliation(notifier.address)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("blocks delegated-transfer-then-receiveBalanceApproval after Account Control activation", async () => {
              // A cannot obtain Bank credit from the empty-extraData
              // receiveApproval unmint entry point either, once
              // reconciliation is required.
              await expect(
                tbtc
                  .connect(account1)
                  .approveAndCall(tbtcVault.address, redeemedAmount, [])
              ).to.be.revertedWith(
                "Unmint unavailable while Account Control reconciliation is required"
              )
              expect(await notifier.callCount()).to.equal(0)
              expect(await tbtc.balanceOf(account1.address)).to.equal(
                mintedAmount
              )

              // Unrelated fresh Bank balance for A, moved to B via the
              // delegated transferBalanceFrom allowance mechanism instead of
              // a direct transfer.
              await bank.setBalance(account1.address, freshBalance)
              await bank.setBalance(account2.address, 0)
              await bank
                .connect(account1)
                .approveBalance(account2.address, freshBalance)
              await bank
                .connect(account2)
                .transferBalanceFrom(
                  account1.address,
                  account2.address,
                  freshBalance
                )
              expect(await bank.balanceOf(account2.address)).to.equal(
                freshBalance
              )

              // B re-mints the unrelated balance through the delegated
              // approveBalanceAndCall -> receiveBalanceApproval path.
              await bank
                .connect(account2)
                .approveBalanceAndCall(tbtcVault.address, freshBalance, [])

              expect(await tbtc.balanceOf(account2.address)).to.equal(
                freshBalance.mul(constants.satoshiMultiplier)
              )
              expect(await notifier.callCount()).to.equal(0)
            })
          }
        )
      })
    })
  })
})

function buildRedemptionKey(
  walletPubKeyHash: BytesLike,
  redeemerOutputScript: BytesLike
): string {
  return ethers.utils.solidityKeccak256(
    ["bytes32", "bytes20"],
    [
      ethers.utils.solidityKeccak256(["bytes"], [redeemerOutputScript]),
      walletPubKeyHash,
    ]
  )
}
