import {
  RedemptionRequest,
  TBTCContracts,
  WalletState,
} from "../../lib/contracts"
import {
  BitcoinAddressConverter,
  BitcoinClient,
  BitcoinNetwork,
  BitcoinScriptUtils,
  BitcoinTxHash,
  BitcoinTxOutput,
  BitcoinUtxo,
} from "../../lib/bitcoin"
import { BigNumber, BigNumberish } from "ethers"
import { amountToSatoshi, ApiUrl, endpointUrl, Hex } from "../../lib/utils"
import { RedeemerProxy } from "./redeemer-proxy"
import {
  RedemptionWallet,
  SerializableWallet,
  ValidRedemptionWallet,
} from "../../lib/utils/types"

/**
 * Service exposing features related to tBTC v2 redemptions.
 */
export class RedemptionsService {
  /**
   * Handle to tBTC contracts.
   */
  private readonly tbtcContracts: TBTCContracts
  /**
   * Bitcoin client handle.
   */
  private readonly bitcoinClient: BitcoinClient

  constructor(tbtcContracts: TBTCContracts, bitcoinClient: BitcoinClient) {
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
  }

  /**
   * Requests a redemption of TBTC v2 token into BTC.
   * @param bitcoinRedeemerAddress Bitcoin address redeemed BTC should be
   *                               sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH
   *                               address types are supported.
   * @param amount The amount to be redeemed with the precision of the tBTC
   *        on-chain token contract.
   * @returns Object containing:
   *          - Target chain hash of the request redemption transaction
   *            (for example, Ethereum transaction hash)
   *          - Bitcoin public key of the wallet asked to handle the redemption.
   *            Presented in the compressed form (33 bytes long with 02 or 03 prefix).
   */
  async requestRedemption(
    bitcoinRedeemerAddress: string,
    amount: BigNumber
  ): Promise<{
    targetChainTxHash: Hex
    walletPublicKey: Hex
  }> {
    try {
      const candidateWallets = await this.fetchWalletsForRedemption()
      const { walletPublicKey, mainUtxo, redeemerOutputScript } =
        await this.determineValidRedemptionWallet(
          bitcoinRedeemerAddress,
          amountToSatoshi(amount),
          candidateWallets
        )

      const txHash = await this.tbtcContracts.tbtcToken.requestRedemption(
        walletPublicKey,
        mainUtxo,
        redeemerOutputScript,
        amount
      )

      return {
        targetChainTxHash: txHash,
        walletPublicKey: walletPublicKey,
      }
    } catch (error) {
      console.warn(
        "Error requesting redemption with candidate wallets. Falling back to manual redemption data:",
        error
      )

      const { walletPublicKey, mainUtxo, redeemerOutputScript } =
        await this.determineRedemptionData(bitcoinRedeemerAddress, amount)

      const txHash = await this.tbtcContracts.tbtcToken.requestRedemption(
        walletPublicKey,
        mainUtxo,
        redeemerOutputScript,
        amount
      )

      return {
        targetChainTxHash: txHash,
        walletPublicKey: walletPublicKey,
      }
    }
  }

  /**
   * Requests a redemption of TBTC v2 token into BTC using a custom integration.
   * The function builds the redemption data and handles the redemption request
   * through the provided redeemer proxy.
   * @param bitcoinRedeemerAddress Bitcoin address the redeemed BTC should be
   *        sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH address types are supported.
   * @param amount The amount to be redeemed with the precision of the tBTC
   *        on-chain token contract.
   * @param redeemerProxy Object impleenting functions required to route tBTC
   *        redemption requests through the tBTC bridge.
   * @returns Object containing:
   *          - Target chain hash of the request redemption transaction
   *            (for example, Ethereum transaction hash)
   *          - Bitcoin public key of the wallet asked to handle the redemption.
   *            Presented in the compressed form (33 bytes long with 02 or 03 prefix).
   */
  async requestRedemptionWithProxy(
    bitcoinRedeemerAddress: string,
    amount: BigNumberish,
    redeemerProxy: RedeemerProxy
  ): Promise<{
    targetChainTxHash: Hex
    walletPublicKey: Hex
  }> {
    const chainRedeemerAddress = redeemerProxy.redeemerAddress()

    const { walletPublicKey, mainUtxo, redeemerOutputScript } =
      await this.determineRedemptionData(
        bitcoinRedeemerAddress,
        BigNumber.from(amount)
      )

    const redemptionData =
      this.tbtcContracts.tbtcToken.buildRequestRedemptionData(
        chainRedeemerAddress,
        walletPublicKey,
        mainUtxo,
        redeemerOutputScript
      )

    const targetChainTxHash = await redeemerProxy.requestRedemption(
      redemptionData
    )

    return { targetChainTxHash, walletPublicKey }
  }

  /**
   *
   * @param bitcoinRedeemerAddress Bitcoin address redeemed BTC should be
   *                               sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH
   *                               address types are supported.
   * @param amount The amount to be redeemed with the precision of the tBTC
   *                on-chain token contract.
   * @returns Object containing:
   *          - Bitcoin public key of the wallet asked to handle the redemption.
   *            Presented in the compressed form (33 bytes long with 02 or 03 prefix).
   *          - Main UTXO of the wallet.
   *          - Redeemer output script.
   */
  protected async determineRedemptionData(
    bitcoinRedeemerAddress: string,
    amount: BigNumber
  ): Promise<{
    walletPublicKey: Hex
    mainUtxo: BitcoinUtxo
    redeemerOutputScript: Hex
  }> {
    const redeemerOutputScript = await this.getRedeemerOutputScript(
      bitcoinRedeemerAddress
    )

    // The findWalletForRedemption operates on satoshi amount precision (1e8)
    // while the amount parameter is TBTC token precision (1e18). We need to
    // convert the amount to get proper results.
    const { walletPublicKey, mainUtxo } = await this.findWalletForRedemption(
      redeemerOutputScript,
      amountToSatoshi(amount)
    )

    return { walletPublicKey, mainUtxo, redeemerOutputScript }
  }

  /**
   *
   * @param bitcoinRedeemerAddress Bitcoin address redeemed BTC should be
   *                               sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH
   *                               address types are supported.
   * @param amount The amount to be redeemed with the precision of the tBTC
   *                on-chain token contract.
   * @param potentialCandidateWallets Array of wallets that can handle the
   *                                  redemption request. The wallets must
   *                                  be in the Live state.
   * @returns Object containing:
   *          - Bitcoin public key of the wallet asked to handle the redemption.
   *           Presented in the compressed form (33 bytes long with 02 or 03 prefix).
   *         - Wallet public key hash.
   *         - Main UTXO of the wallet.
   *         - Redeemer output script.
   *
   * @throws Throws an error if no valid redemption wallet exists for the given
   *         input parameters.
   */
  protected async determineValidRedemptionWallet(
    bitcoinRedeemerAddress: string,
    amount: BigNumber,
    potentialCandidateWallets: Array<SerializableWallet>
  ): Promise<RedemptionWallet> {
    let walletPublicKey: Hex | undefined = undefined
    let mainUtxo: BitcoinUtxo | undefined = undefined
    const redeemerOutputScript = await this.getRedeemerOutputScript(
      bitcoinRedeemerAddress
    )

    for (let index = 0; index < potentialCandidateWallets.length; index++) {
      const serializableWallet = potentialCandidateWallets[index]
      const {
        walletBTCBalance: candidateBTCBalance,
        walletPublicKey: candidatePublicKey,
        mainUtxo: candidateMainUtxo,
      } = this.fromSerializableWallet(serializableWallet)

      if (candidateBTCBalance.lt(amount)) {
        console.debug(
          `The wallet (${candidatePublicKey.toString()})` +
            `cannot handle the redemption request. ` +
            `Continue the loop execution to the next wallet...`
        )
        continue
      }

      const pendingRedemption =
        await this.tbtcContracts.bridge.pendingRedemptions(
          candidatePublicKey,
          redeemerOutputScript
        )

      if (pendingRedemption.requestedAt !== 0) {
        console.debug(
          `There is a pending redemption request from this wallet to the ` +
            `same Bitcoin address. Given wallet public key` +
            `(${candidatePublicKey.toString()}) and redeemer output script ` +
            `(${redeemerOutputScript.toString()}) pair can be used for only one ` +
            `pending request at the same time. ` +
            `Continue the loop execution to the next wallet...`
        )
        continue
      }
      walletPublicKey = candidatePublicKey
      mainUtxo = candidateMainUtxo

      console.debug(
        `The wallet (${walletPublicKey.toString()})` +
          `can handle the redemption request. ` +
          `Stop the loop execution and proceed with the redemption...`
      )

      break
    }

    if (!walletPublicKey || !mainUtxo) {
      throw new Error(`Could not find a wallet with enough funds.`)
    }

    return { walletPublicKey, mainUtxo, redeemerOutputScript }
  }

  /**
   * Finds the oldest live wallet that has enough BTC to handle a redemption
   * request.
   * @param redeemerOutputScript The redeemer output script the redeemed funds are
   *        supposed to be locked on. Must not be prepended with length.
   * @param amount The amount to be redeemed in satoshis.
   * @returns Promise with the wallet details needed to request a redemption.
   */
  protected async findWalletForRedemption(
    redeemerOutputScript: Hex,
    amount: BigNumber
  ): Promise<{
    walletPublicKey: Hex
    mainUtxo: BitcoinUtxo
  }> {
    const allWalletEvents =
      await this.tbtcContracts.bridge.getNewWalletRegisteredEvents()

    let maxAmount = BigNumber.from(0)

    const bitcoinNetwork = await this.bitcoinClient.getNetwork()

    let liveWalletsCounter = 0

    const candidateResults: Array<{
      index: number
      walletPublicKey: Hex
      mainUtxo: BitcoinUtxo
    }> = []

    const concurrencyLimit = 50

    const chunkedWallets = this.chunkArray(allWalletEvents, concurrencyLimit)

    for (let cIndex = 0; cIndex < chunkedWallets.length; cIndex++) {
      const chunk = chunkedWallets[cIndex]
      const chunkPromises = chunk.map(async (walletEvent, indexInChunk) => {
        const globalIndex = cIndex * concurrencyLimit + indexInChunk

        const { walletPublicKeyHash } = walletEvent
        const { state, walletPublicKey, pendingRedemptionsValue } =
          await this.tbtcContracts.bridge.wallets(walletPublicKeyHash)

        // Wallet must be in Live state.
        if (state !== WalletState.Live || !walletPublicKey) {
          console.debug(
            `Wallet is not in Live state ` +
              `(wallet public key hash: ${walletPublicKeyHash.toString()}). ` +
              `Continue the loop execution to the next wallet...`
          )
          return
        }
        liveWalletsCounter++

        const mainUtxo = await this.determineWalletMainUtxo(
          walletPublicKeyHash,
          bitcoinNetwork
        )
        if (!mainUtxo) {
          console.debug(
            `Could not find matching UTXO on chains ` +
              `for wallet public key hash (${walletPublicKeyHash.toString()}). ` +
              `Continue the loop execution to the next wallet...`
          )
          return
        }
        const pendingRedemption =
          await this.tbtcContracts.bridge.pendingRedemptions(
            walletPublicKey,
            redeemerOutputScript
          )

        if (pendingRedemption.requestedAt !== 0) {
          console.debug(
            `There is a pending redemption request from this wallet to the ` +
              `same Bitcoin address. Given wallet public key hash` +
              `(${walletPublicKeyHash.toString()}) and redeemer output script ` +
              `(${redeemerOutputScript.toString()}) pair can be used for only one ` +
              `pending request at the same time. ` +
              `Continue the loop execution to the next wallet...`
          )
          return
        }

        const walletBTCBalance = mainUtxo.value.sub(pendingRedemptionsValue)

        if (walletBTCBalance.gt(maxAmount)) {
          maxAmount = walletBTCBalance
        }

        if (walletBTCBalance.gte(amount)) {
          candidateResults.push({
            index: globalIndex,
            walletPublicKey,
            mainUtxo,
          })
        } else {
          console.debug(
            `The wallet (${walletPublicKeyHash.toString()})` +
              `cannot handle the redemption request. ` +
              `Continue the loop execution to the next wallet...`
          )
        }
      })
      await Promise.all(chunkPromises)
    }

    if (liveWalletsCounter === 0) {
      throw new Error("Currently, there are no live wallets in the network.")
    }

    // If no wallet can handle it, check if maxAmount is zero =>
    // that might mean all have a pending redemption for that address.
    if (candidateResults.length === 0) {
      if (maxAmount.eq(0)) {
        throw new Error(
          "All live wallets in the network have the pending redemption for a given Bitcoin address. " +
            "Please use another Bitcoin address."
        )
      }

      throw new Error(
        `Could not find a wallet with enough funds. ` +
          `Maximum redemption amount is ${maxAmount.toString()} Satoshi ` +
          `( ${maxAmount.div(BigNumber.from(1e8)).toString()} BTC )`
      )
    }

    // Sort candidates by their original index to pick the "oldest" wallet
    // from the events array. If `getNewWalletRegisteredEvents()` is already
    // in oldest->newest order, then using the `index` is sufficient to find
    // the earliest wallet.
    candidateResults.sort((a, b) => a.index - b.index)
    const chosenWallet = candidateResults[0]

    return {
      walletPublicKey: chosenWallet.walletPublicKey,
      mainUtxo: chosenWallet.mainUtxo,
    }
  }

  /**
   * Chunk an array into subarrays of a given size.
   * @param arr The array to be chunked.
   * @param chunkSize The size of each chunk.
   * @returns An array of subarrays, where each subarray has a maximum length of `chunkSize`.
   */
  private chunkArray<T>(arr: T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) {
      throw new Error("chunkSize must be greater than 0.")
    }
    const result: T[][] = []
    for (let i = 0; i < arr.length; i += chunkSize) {
      result.push(arr.slice(i, i + chunkSize))
    }
    return result
  }

  /**
   * Determines the plain-text wallet main UTXO currently registered in the
   * Bridge on-chain contract. The returned main UTXO can be undefined if the
   * wallet does not have a main UTXO registered in the Bridge at the moment.
   * @param walletPublicKeyHash - Public key hash of the wallet.
   * @param bitcoinNetwork - Bitcoin network.
   * @returns Promise holding the wallet main UTXO or undefined value.
   */
  protected async determineWalletMainUtxo(
    walletPublicKeyHash: Hex,
    bitcoinNetwork: BitcoinNetwork
  ): Promise<BitcoinUtxo | undefined> {
    const { mainUtxoHash } = await this.tbtcContracts.bridge.wallets(
      walletPublicKeyHash
    )

    // Valid case when the wallet doesn't have a main UTXO registered into
    // the Bridge.
    if (
      mainUtxoHash.equals(
        Hex.from(
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        )
      )
    ) {
      return undefined
    }

    // The wallet main UTXO registered in the Bridge almost always comes
    // from the latest BTC transaction made by the wallet. However, there may
    // be cases where the BTC transaction was made but their SPV proof is
    // not yet submitted to the Bridge thus the registered main UTXO points
    // to the second last BTC transaction. In theory, such a gap between
    // the actual latest BTC transaction and the registered main UTXO in
    // the Bridge may be even wider. To cover the worst possible cases, we
    // must rely on the full transaction history. Due to performance reasons,
    // we are first taking just the transactions hashes (fast call) and then
    // fetch full transaction data (time-consuming calls) starting from
    // the most recent transactions as there is a high chance the main UTXO
    // comes from there.
    const walletTxHashes = await this.bitcoinClient.getTxHashesForPublicKeyHash(
      walletPublicKeyHash
    )

    const getOutputScript = (witness: boolean): Hex => {
      const address = BitcoinAddressConverter.publicKeyHashToAddress(
        walletPublicKeyHash,
        witness,
        bitcoinNetwork
      )
      return BitcoinAddressConverter.addressToOutputScript(
        address,
        bitcoinNetwork
      )
    }

    const walletP2PKH = getOutputScript(false)
    const walletP2WPKH = getOutputScript(true)

    const isWalletOutput = (output: BitcoinTxOutput) =>
      walletP2PKH.equals(output.scriptPubKey) ||
      walletP2WPKH.equals(output.scriptPubKey)

    // Start iterating from the latest transaction as the chance it matches
    // the wallet main UTXO is the highest.
    for (let i = walletTxHashes.length - 1; i >= 0; i--) {
      const walletTxHash = walletTxHashes[i]
      const walletTransaction = await this.bitcoinClient.getTransaction(
        walletTxHash
      )

      // Find the output that locks the funds on the wallet. Only such an output
      // can be a wallet main UTXO.
      const outputIndex = walletTransaction.outputs.findIndex(isWalletOutput)

      // Should never happen as all transactions come from wallet history. Just
      // in case check whether the wallet output was actually found.
      if (outputIndex < 0) {
        console.error(
          `wallet output for transaction ${walletTransaction.transactionHash.toString()} not found`
        )
        continue
      }

      // Build a candidate UTXO instance based on the detected output.
      const utxo: BitcoinUtxo = {
        transactionHash: walletTransaction.transactionHash,
        outputIndex: outputIndex,
        value: walletTransaction.outputs[outputIndex].value,
      }

      // Check whether the candidate UTXO hash matches the main UTXO hash stored
      // on the Bridge.
      if (mainUtxoHash.equals(this.tbtcContracts.bridge.buildUtxoHash(utxo))) {
        return utxo
      }
    }

    // Should never happen if the wallet has the main UTXO registered in the
    // Bridge. It could only happen due to some serious error, e.g. wrong main
    // UTXO hash stored in the Bridge or Bitcoin blockchain data corruption.
    console.error(
      `main UTXO with hash ${mainUtxoHash.toPrefixedString()} not found for wallet ${walletPublicKeyHash.toString()}`
    )
    return undefined
  }

  /**
   * Gets data of a registered redemption request from the Bridge contract.
   * @param bitcoinRedeemerAddress Bitcoin redeemer address used to request
   *                               the redemption.
   * @param walletPublicKey Bitcoin public key of the wallet handling the
   *                        redemption. Must be in the compressed form
   *                        (33 bytes long with 02 or 03 prefix).
   * @param type Type of redemption requests the function will look for. Can be
   *        either `pending` or `timedOut`. By default, `pending` is used.
   * @returns Matching redemption requests.
   * @throws Throws an error if no redemption request exists for the given
   *         input parameters.
   */
  async getRedemptionRequests(
    bitcoinRedeemerAddress: string,
    walletPublicKey: Hex,
    type: "pending" | "timedOut" = "pending"
  ): Promise<RedemptionRequest> {
    const redeemerOutputScript = await this.getRedeemerOutputScript(
      bitcoinRedeemerAddress
    )
    let redemptionRequest: RedemptionRequest | undefined = undefined

    switch (type) {
      case "pending": {
        redemptionRequest = await this.tbtcContracts.bridge.pendingRedemptions(
          walletPublicKey,
          redeemerOutputScript
        )
        break
      }
      case "timedOut": {
        redemptionRequest = await this.tbtcContracts.bridge.timedOutRedemptions(
          walletPublicKey,
          redeemerOutputScript
        )
        break
      }
      default: {
        throw new Error("Unsupported redemption request type")
      }
    }

    if (!redemptionRequest || redemptionRequest.requestedAt == 0) {
      throw new Error("Redemption request does not exist")
    }

    return redemptionRequest
  }

  /**
   * Fetches all wallets that are currently live and can handle a redemption
   * request.
   * @returns Array of wallet events.
   */
  protected async fetchWalletsForRedemption(): Promise<
    Array<SerializableWallet>
  > {
    const network = await this.bitcoinClient.getNetwork()

    if (network !== BitcoinNetwork.Mainnet) {
      throw new Error("This function is only available on Mainnet")
    }

    const response = await fetch(
      `${ApiUrl.TBTC_EXPLORER}${endpointUrl.TBTC_REDEMPTION_WALLET}`
    )
    if (!response.ok) {
      throw new Error("Failed to fetch redemption wallet from server")
    }

    const { data } = await response.json()
    return data.candidateResults
  }

  /**
   * Converts a Bitcoin address to its output script.
   * @param bitcoinRedeemerAddress Bitcoin address to be converted.
   * @returns The output script of the given Bitcoin address.
   */
  protected async getRedeemerOutputScript(
    bitcoinRedeemerAddress: string
  ): Promise<Hex> {
    const bitcoinNetwork = await this.bitcoinClient.getNetwork()

    const redeemerOutputScript = BitcoinAddressConverter.addressToOutputScript(
      bitcoinRedeemerAddress,
      bitcoinNetwork
    )

    if (
      !BitcoinScriptUtils.isP2PKHScript(redeemerOutputScript) &&
      !BitcoinScriptUtils.isP2WPKHScript(redeemerOutputScript) &&
      !BitcoinScriptUtils.isP2SHScript(redeemerOutputScript) &&
      !BitcoinScriptUtils.isP2WSHScript(redeemerOutputScript)
    ) {
      throw new Error("Redeemer output script must be of standard type")
    }

    return redeemerOutputScript
  }

  protected fromSerializableWallet(
    serialized: SerializableWallet
  ): ValidRedemptionWallet {
    return {
      index: serialized.index,
      walletPublicKey: Hex.from(serialized.walletPublicKey),
      mainUtxo: {
        transactionHash: BitcoinTxHash.from(
          serialized.mainUtxo.transactionHash
        ),
        outputIndex: serialized.mainUtxo.outputIndex,
        value: BigNumber.from(serialized.mainUtxo.value),
      },
      walletBTCBalance: BigNumber.from(serialized.walletBTCBalance),
    }
  }
}
