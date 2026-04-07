#!/usr/bin/env ts-node
/**
 * E2E deposit test: initiate deposit, get BTC address, reveal after funding.
 *
 * Usage:
 *   CHAIN_API_URL=https://... DEPOSITOR_PRIVATE_KEY=0x... yarn e2e-deposit
 *
 * Optional: ELECTRUM_URL=ssl://host:50002 to override Electrum server.
 * ELECTRUM_CONNECTION_TIMEOUT (default 30000 ms), ELECTRUM_RETRY_ATTEMPTS
 * (default 5) for connection tuning.
 *
 * BITCOIN_NETWORK=testnet4: skip Electrum for address step (getNetwork).
 * Use when Electrum is unreachable; run step 2 (reveal) from droplet.
 *
 * Run twice: first to get address (send BTC), second to reveal after funding.
 * Deposit receipt is saved to deposit-receipt.json between runs.
 */
import * as fs from "fs"
import { ethers } from "ethers"
import { TBTC } from "../src/services/tbtc"
import { Deposit } from "../src/services/deposits"
import { DepositReceipt } from "../src/lib/contracts"
import { Hex } from "../src/lib/utils"
import { EthereumAddress } from "../src/lib/ethereum"
import { ElectrumClient } from "../src/lib/electrum"
import {
  BitcoinClientWithNetworkOverride,
  BitcoinNetwork,
} from "../src/lib/bitcoin"
import { loadEthereumCoreContracts } from "../src/lib/ethereum"
import { Chains } from "../src/lib/contracts"

const RECEIPT_FILE = "deposit-receipt.json"

function serializeReceipt(receipt: DepositReceipt): object {
  return {
    depositor: receipt.depositor.identifierHex,
    blindingFactor: receipt.blindingFactor.toString(),
    walletPublicKeyHash: receipt.walletPublicKeyHash.toString(),
    refundPublicKeyHash: receipt.refundPublicKeyHash.toString(),
    refundLocktime: receipt.refundLocktime.toString(),
    extraData: receipt.extraData?.toString(),
  }
}

function deserializeReceipt(obj: any): DepositReceipt {
  const depositorHex =
    obj.depositor.startsWith("0x") ? obj.depositor : "0x" + obj.depositor
  return {
    depositor: EthereumAddress.from(depositorHex),
    blindingFactor: Hex.from(obj.blindingFactor),
    walletPublicKeyHash: Hex.from(obj.walletPublicKeyHash),
    refundPublicKeyHash: Hex.from(obj.refundPublicKeyHash),
    refundLocktime: Hex.from(obj.refundLocktime),
    extraData: obj.extraData ? Hex.from(obj.extraData) : undefined,
  }
}

async function main() {
  const rpcUrl = process.env.CHAIN_API_URL
  const privateKey = process.env.DEPOSITOR_PRIVATE_KEY

  if (!rpcUrl || !privateKey) {
    console.error("Set CHAIN_API_URL and DEPOSITOR_PRIVATE_KEY")
    process.exit(1)
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(privateKey, provider)

  let tbtc
  const electrumUrl = process.env.ELECTRUM_URL
  const useNetworkOverride = process.env.BITCOIN_NETWORK === "testnet4"

  if (electrumUrl || useNetworkOverride) {
    const tbtcContracts = await loadEthereumCoreContracts(
      wallet,
      Chains.Ethereum.Sepolia
    )
    let bitcoinClient
    if (electrumUrl) {
      const connectionTimeout = parseInt(
        process.env.ELECTRUM_CONNECTION_TIMEOUT || "30000",
        10
      )
      const retryAttempts = parseInt(
        process.env.ELECTRUM_RETRY_ATTEMPTS || "5",
        10
      )
      bitcoinClient = ElectrumClient.fromUrl(
        electrumUrl,
        undefined,
        retryAttempts,
        1000,
        connectionTimeout
      )
    } else {
      bitcoinClient = ElectrumClient.fromDefaultConfig(BitcoinNetwork.Testnet4)
    }
    if (useNetworkOverride) {
      bitcoinClient = new BitcoinClientWithNetworkOverride(
        bitcoinClient,
        BitcoinNetwork.Testnet4
      )
    }
    tbtc = await TBTC.initializeCustom(tbtcContracts, bitcoinClient)
  } else {
    tbtc = await TBTC.initializeSepolia(wallet)
  }
  tbtc.deposits.setDefaultDepositor(EthereumAddress.from(wallet.address))

  const bitcoinRecoveryAddress =
    process.env.BTC_RECOVERY_ADDRESS || "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc"

  let deposit: Deposit
  let justCreatedReceipt = false

  if (fs.existsSync(RECEIPT_FILE)) {
    const saved = JSON.parse(fs.readFileSync(RECEIPT_FILE, "utf-8"))
    const receipt = deserializeReceipt(saved.receipt)
    deposit = await Deposit.fromReceipt(
      receipt,
      tbtc.tbtcContracts,
      tbtc.bitcoinClient
    )
  } else {
    deposit = await tbtc.deposits.initiateDeposit(bitcoinRecoveryAddress)
    const receipt = deposit.getReceipt()
    fs.writeFileSync(
      RECEIPT_FILE,
      JSON.stringify(
        { receipt: serializeReceipt(receipt), btcRecoveryAddress: bitcoinRecoveryAddress },
        null,
        2
      )
    )
    justCreatedReceipt = true
  }

  const btcAddress = await deposit.getBitcoinAddress()

  // With BITCOIN_NETWORK=testnet4, skip Electrum for address step.
  // When we just created the receipt, user hasn't sent BTC yet.
  const skipDetectFunding = useNetworkOverride && justCreatedReceipt
  const utxos = skipDetectFunding ? [] : await deposit.detectFunding()

  if (utxos.length === 0) {
    console.log("=== Step 1: Send Testnet4 BTC ===")
    console.log("Address:", btcAddress)
    console.log("Faucet: https://mempool.space/testnet4/faucet")
    console.log("")
    if (skipDetectFunding) {
      console.log(
        "Electrum skipped (BITCOIN_NETWORK=testnet4). Copy deposit-receipt.json"
      )
      console.log("to your droplet and run: yarn e2e-deposit")
    } else {
      console.log("After 1+ confirmation, run: yarn e2e-deposit")
    }
    return
  }

  console.log("=== Step 2: Revealing deposit ===")
  const result = await deposit.initiateMinting()
  const txHash =
    typeof result === "object" && "hash" in result
      ? result.hash
      : (result as Hex).toPrefixedString()
  console.log("Tx:", txHash)
  console.log("Revealed. Wait for sweep (~1h). Check TBTC balance.")
  fs.unlinkSync(RECEIPT_FILE)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
