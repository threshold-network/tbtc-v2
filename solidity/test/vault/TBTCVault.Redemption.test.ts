import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, getUnnamedAccounts, helpers } from "hardhat"
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
  let account1: SignerWithAddress
  let account2: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ deployer, bridge, bank, tbtcVault, tbtc } = await bridgeFixture())

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
