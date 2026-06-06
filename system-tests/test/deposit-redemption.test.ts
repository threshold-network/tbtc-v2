import {
  extractBitcoinRawTxVectors,
  Hex,
  BitcoinTxHash,
  BitcoinNetwork,
  ElectrumClient,
  DepositFunding,
  DepositScript,
  BitcoinAddressConverter,
  WalletTx,
  BitcoinHashUtils,
  EthereumAddress,
  TBTC,
} from "@keep-network/tbtc-v2.ts"
import { BigNumber, constants, Contract } from "ethers"
import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"

import {
  setupSystemTestsContext,
  createTbtcContractsHandle,
} from "./utils/context"
import { fakeRelayDifficulty, waitTransactionConfirmed } from "./utils/bitcoin"

import type {
  RedemptionRequest,
  BitcoinUtxo,
  DepositReceipt,
} from "@keep-network/tbtc-v2.ts"
import type { SystemTestsContext } from "./utils/context"

chai.use(chaiAsPromised)

/**
 * This system test scenario performs a single deposit and redemption.
 *
 * The scenario consists of the following steps:
 * 1. The depositor broadcasts the deposit transaction on BTC chain and reveals
 *    it to the bridge.
 * 2. The wallet broadcasts the sweep transaction of the given deposit on BTC
 *    chain and submits the sweep proof to the bridge.
 * 3. The depositor (redeemer) requests the redemption of its entire bank
 *    balance.
 * 4. The wallet broadcasts the redemption transaction handling the given
 *    request and submits the redemption proof to the bridge.
 *
 * Following prerequisites must be fulfilled to make a successful pass:
 * - The depositor's BTC balance must allow to perform the deposit
 * - tBTC v2 contracts must be deployed on used Ethereum network
 * - A fresh live wallet (with no main UTXO yet) must be registered in
 *   the bridge
 */
describe("System Test - Deposit and redemption", () => {
  let systemTestsContext: SystemTestsContext

  let bridgeAddress: string
  let bank: Contract
  let relay: Contract

  let depositorSdk: TBTC
  let maintainerSdk: TBTC
  let walletTx: WalletTx

  const depositAmount = BigNumber.from(2000000)
  const depositSweepTxFee = BigNumber.from(10000)
  const depositTxFee = BigNumber.from(1500)
  // Number of retries for Electrum requests.
  const ELECTRUM_RETRIES = 5
  // Initial backoff step in milliseconds that will be increased exponentially for
  // subsequent Electrum retry attempts.
  const ELECTRUM_RETRY_BACKOFF_STEP_MS = 10000 // 10sec

  let depositReceipt: DepositReceipt
  let depositUtxo: BitcoinUtxo
  let sweepUtxo: BitcoinUtxo

  let depositorBitcoinAddress: string
  let depositorBitcoinLegacyAddress: string

  before(async () => {
    systemTestsContext = await setupSystemTestsContext()
    const { electrumUrl, maintainer, depositor, deployedContracts } =
      systemTestsContext

    const relayDeploymentInfo = deployedContracts.LightRelay
    relay = new Contract(
      relayDeploymentInfo.address,
      relayDeploymentInfo.abi,
      maintainer
    )

    const bankDeploymentInfo = deployedContracts.Bank
    bank = new Contract(
      bankDeploymentInfo.address,
      bankDeploymentInfo.abi,
      maintainer
    )

    const electrumClient = ElectrumClient.fromUrl(
      electrumUrl,
      undefined,
      ELECTRUM_RETRIES,
      ELECTRUM_RETRY_BACKOFF_STEP_MS
    )

    bridgeAddress = deployedContracts.Bridge.address

    const depositorTbtcContracts = await createTbtcContractsHandle(
      deployedContracts,
      depositor
    )

    depositorSdk = await TBTC.initializeCustom(
      depositorTbtcContracts,
      electrumClient
    )

    const maintainerTbtcContracts = await createTbtcContractsHandle(
      deployedContracts,
      maintainer
    )

    maintainerSdk = await TBTC.initializeCustom(
      maintainerTbtcContracts,
      electrumClient
    )

    walletTx = new WalletTx(maintainerTbtcContracts, electrumClient)

    depositorBitcoinAddress = BitcoinAddressConverter.publicKeyToAddress(
      systemTestsContext.depositorBitcoinKeyPair.publicKey.compressed,
      BitcoinNetwork.Testnet
    )
    depositorBitcoinLegacyAddress =
      BitcoinAddressConverter.publicKeyToAddress(
        systemTestsContext.depositorBitcoinKeyPair.publicKey.compressed,
        BitcoinNetwork.Testnet,
        false
      )

    depositorSdk.deposits.setDefaultDepositor(
      EthereumAddress.from(await depositor.getAddress())
    )
  })

  context("when deposit is made and revealed", () => {
    before("make and reveal deposit", async () => {
      const deposit = await depositorSdk.deposits.initiateDeposit(
        // Use the depositor's address as the recovery address.
        depositorBitcoinAddress
      )
      depositReceipt = deposit.getReceipt()
      const depositScript = DepositScript.fromReceipt(depositReceipt)
      const depositFunding = DepositFunding.fromScript(depositScript)

      console.log(`
        Deposit receipt generated:
        - depositor: ${depositReceipt.depositor.identifierHex}
        - walletPublicKeyHash: ${depositReceipt.walletPublicKeyHash}
        - refundPublicKeyHash: ${depositReceipt.refundPublicKeyHash}
        - blindingFactor: ${depositReceipt.blindingFactor}
        - refundLocktime: ${depositReceipt.refundLocktime}
      `)

      const depositorWitnessUtxos =
        await depositorSdk.bitcoinClient.findAllUnspentTransactionOutputs(
          depositorBitcoinAddress
        )
      const depositorLegacyUtxos =
        await depositorSdk.bitcoinClient.findAllUnspentTransactionOutputs(
          depositorBitcoinLegacyAddress
        )
      const depositorUtxos = [
        ...depositorWitnessUtxos,
        ...depositorLegacyUtxos,
      ]

      ;({ depositUtxo } = await depositFunding.submitTransaction(
        depositAmount,
        depositorUtxos,
        depositTxFee,
        systemTestsContext.depositorBitcoinKeyPair.wif,
        depositorSdk.bitcoinClient
      ))

      console.log(`
        Deposit made on BTC chain:
        - Transaction hash: ${depositUtxo.transactionHash}
        - Output index: ${depositUtxo.outputIndex}
      `)

      // Since the reveal deposit logic does not perform SPV proof, we
      // can reveal the deposit transaction immediately without waiting
      // for confirmations.
      const rawDepositTransaction =
        await depositorSdk.bitcoinClient.getRawTransaction(
          depositUtxo.transactionHash
        )
      const depositRawTxVectors = extractBitcoinRawTxVectors(
        rawDepositTransaction
      )

      // Reveal without providing the vault address.
      await depositorSdk.tbtcContracts.bridge.revealDeposit(
        depositRawTxVectors,
        depositUtxo.outputIndex,
        depositReceipt
      )

      console.log(`
        Deposit revealed on Ethereum chain
      `)
    })

    it("should broadcast the deposit transaction on the Bitcoin network", async () => {
      expect(
        (
          await maintainerSdk.bitcoinClient.getRawTransaction(
            depositUtxo.transactionHash
          )
        ).transactionHex.length
      ).to.be.greaterThan(0)
    })

    it("should reveal the deposit to the bridge", async () => {
      const { revealedAt } = await maintainerSdk.tbtcContracts.bridge.deposits(
        depositUtxo.transactionHash,
        depositUtxo.outputIndex
      )
      expect(revealedAt).to.be.greaterThan(0)
    })

    context("when deposit is swept and sweep proof submitted", () => {
      before("sweep the deposit and submit sweep proof", async () => {
        ;({ newMainUtxo: sweepUtxo } =
          await walletTx.depositSweep.submitTransaction(
            depositSweepTxFee,
            systemTestsContext.walletBitcoinKeyPair.wif,
            [depositUtxo],
            [depositReceipt]
          ))

        console.log(`
        Deposit swept on Bitcoin chain:
        - Transaction hash: ${sweepUtxo.transactionHash}
      `)

        // Unlike in the deposit transaction case, we must wait for the sweep
        // transaction to have an enough number of confirmations. This is
        // because the bridge performs the SPV proof of that transaction.
        await waitTransactionConfirmed(
          maintainerSdk.bitcoinClient,
          sweepUtxo.transactionHash
        )

        await fakeRelayDifficulty(
          relay,
          maintainerSdk.bitcoinClient,
          sweepUtxo.transactionHash
        )

        // TODO: Consider fetching the current wallet main UTXO and passing it
        //       here. This will allow running this test scenario multiple
        //       times for the same wallet.
        await maintainerSdk.maintenance.spv.submitDepositSweepProof(
          sweepUtxo.transactionHash,
          // This is the first sweep of the given wallet so there is no main UTXO.
          {
            // The function expects an unprefixed hash.
            transactionHash: BitcoinTxHash.from(constants.HashZero),
            outputIndex: 0,
            value: BigNumber.from(0),
          }
        )

        console.log(`
        Deposit sweep proved on the bridge
      `)
      })

      it("should broadcast the sweep transaction on the Bitcoin network", async () => {
        expect(
          (
            await maintainerSdk.bitcoinClient.getRawTransaction(
              sweepUtxo.transactionHash
            )
          ).transactionHex.length
        ).to.be.greaterThan(0)
      })

      it("should sweep the deposit on the bridge", async () => {
        const { sweptAt } = await maintainerSdk.tbtcContracts.bridge.deposits(
          depositUtxo.transactionHash,
          depositUtxo.outputIndex
        )
        expect(sweptAt).to.be.greaterThan(0)
      })

      it("should increase depositor's balance in the bank", async () => {
        const { treasuryFee } =
          await maintainerSdk.tbtcContracts.bridge.deposits(
            depositUtxo.transactionHash,
            depositUtxo.outputIndex
          )

        const expectedBalance = depositAmount
          .sub(treasuryFee)
          .sub(depositSweepTxFee)

        const actualBalance = await bank.balanceOf(
          systemTestsContext.depositor.address
        )

        expect(actualBalance).to.be.equal(expectedBalance)
      })

      context("when redemption is requested", () => {
        let requestedAmount: BigNumber
        let redeemerOutputScript: Hex
        let redemptionRequest: RedemptionRequest

        before("request the redemption", async () => {
          // Redeem the full depositor's balance.
          requestedAmount = await bank.balanceOf(
            systemTestsContext.depositor.address
          )

          // Allow the bridge to take the redeemed bank balance.
          await bank
            .connect(systemTestsContext.depositor)
            .approveBalance(bridgeAddress, requestedAmount)

          // Request redemption to depositor's address.
          redeemerOutputScript = Hex.from(
            `0014${BitcoinHashUtils.computeHash160(
              systemTestsContext.depositorBitcoinKeyPair.publicKey.compressed
            )}`
          )

          await depositorSdk.tbtcContracts.bridge.requestRedemption(
            systemTestsContext.walletBitcoinKeyPair.publicKey.compressed,
            sweepUtxo,
            redeemerOutputScript,
            requestedAmount
          )

          console.log(
            `Requested redemption of ${requestedAmount} satoshis to script ${redeemerOutputScript} on the bridge`
          )

          redemptionRequest =
            await maintainerSdk.redemptions.getRedemptionRequests(
              depositorBitcoinAddress,
              systemTestsContext.walletBitcoinKeyPair.publicKey.compressed,
              "pending"
            )
        })

        it("should transfer depositor's bank balance to the Bridge", async () => {
          expect(
            await bank.balanceOf(systemTestsContext.depositor.address)
          ).to.be.equal(0)

          expect(await bank.balanceOf(bridgeAddress)).to.be.equal(
            requestedAmount
          )
        })

        it("should register the redemption request on the bridge", async () => {
          expect(redemptionRequest.requestedAt).to.be.greaterThan(0)
          expect(redemptionRequest.requestedAmount).to.be.equal(requestedAmount)
          expect(redemptionRequest.redeemerOutputScript).to.be.deep.equal(
            redeemerOutputScript
          )
        })

        context(
          "when redemption is made and redemption proof submitted",
          () => {
            let redemptionTxHash: BitcoinTxHash

            before(
              "make the redemption and submit redemption proof",
              async () => {
                ;({ transactionHash: redemptionTxHash } =
                  await walletTx.redemption.submitTransaction(
                    systemTestsContext.walletBitcoinKeyPair.wif,
                    sweepUtxo,
                    [redemptionRequest.redeemerOutputScript]
                  ))

                console.log(
                  "Redemption made on Bitcoin chain:\n" +
                    `- Transaction hash: ${redemptionTxHash}`
                )

                await waitTransactionConfirmed(
                  maintainerSdk.bitcoinClient,
                  redemptionTxHash
                )

                await fakeRelayDifficulty(
                  relay,
                  maintainerSdk.bitcoinClient,
                  redemptionTxHash
                )

                await maintainerSdk.maintenance.spv.submitRedemptionProof(
                  redemptionTxHash,
                  sweepUtxo,
                  systemTestsContext.walletBitcoinKeyPair.publicKey.compressed
                )

                console.log("Redemption proved on the bridge")
              }
            )

            it("should broadcast the redemption transaction on the Bitcoin network", async () => {
              expect(
                (
                  await maintainerSdk.bitcoinClient.getRawTransaction(
                    redemptionTxHash
                  )
                ).transactionHex.length
              ).to.be.greaterThan(0)
            })

            it("should close the redemption request on the bridge", async () => {
              await expect(
                maintainerSdk.redemptions.getRedemptionRequests(
                  depositorBitcoinAddress,
                  systemTestsContext.walletBitcoinKeyPair.publicKey.compressed,
                  "pending"
                )
              ).to.be.rejectedWith("Redemption request does not exist")
            })

            it("should decrease Bridge's balance in the bank", async () => {
              const actualBalance = await bank.balanceOf(bridgeAddress)

              expect(actualBalance).to.be.equal(0)
            })
          }
        )
      })
    })
  })
})
