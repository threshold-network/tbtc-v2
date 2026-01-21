import { BigNumber } from "@ethersproject/bignumber"
import { program } from "commander"
import * as fs from "fs"
import {
  BitcoinTxHash,
  BitcoinUtxo,
  DepositReceipt,
  DepositRefund,
  DepositScript,
  ElectrumClient,
  ElectrumCredentials,
  Hex,
} from "../src"

program
  .version("0.0.1")
  .requiredOption(
    "-d, --deposit-json-path <deposit-json-path>",
    "deposit JSON file path"
  )
  .requiredOption(
    "-a, --deposit-amount <amount-to-refund>",
    "amount of BTC to refund"
  )
  .requiredOption(
    "-t, --deposit-transaction-id <transaction-id>",
    "transaction id of the original deposit"
  )
  .requiredOption(
    "-i, --deposit-transaction-index <transaction-index>",
    "deposit transaction index"
  )
  .requiredOption(
    "-k, --private-key <private-key>",
    "private key of the BTC wallet"
  )
  .requiredOption(
    "-f, --transaction-fee <transaction-fee>",
    "recovery address of the BTC wallet"
  )
  .requiredOption("-o, --host <host>", "network name")
  .requiredOption("-p, --port <port>", "network name")
  .requiredOption("-r, --protocol <protocol>", "network name")
  .parse(process.argv)

// Parse the program options
const options = program.opts()
const depositJsonPath = options.depositJsonPath
const refundAmount = options.depositAmount // in satoshi
const transactionId = options.depositTransactionId
const transactionIndex = options.depositTransactionIndex
const refunderPrivateKey = options.privateKey
const fee = options.transactionFee
const electrumCredentials = {
  host: options.host,
  port: options.port,
  protocol: options.protocol,
} as ElectrumCredentials

const depositJson = JSON.parse(fs.readFileSync(depositJsonPath, "utf-8"))

const deposit: DepositReceipt = {
  depositor: depositJson.depositor,
  walletPublicKeyHash: Hex.from(depositJson.walletPublicKeyHash),
  refundPublicKeyHash: Hex.from(depositJson.refundPublicKeyHash),
  blindingFactor: Hex.from(depositJson.blindingFactor),
  refundLocktime: Hex.from(depositJson.refundLocktime),
}
const recoveryAddress = depositJson.btcRecoveryAddress

console.log("======= refund provided data ========")
console.log("deposit JSON: ", depositJson)
console.log("deposit recovery amount: ", refundAmount)
console.log("deposit transaction ID: ", transactionId)
console.log("deposit transaction index: ", transactionIndex)
console.log("recovery address: ", recoveryAddress)
console.log("electrum credentials:", electrumCredentials)
console.log("=====================================")

async function run(): Promise<void> {
  const client = new ElectrumClient([electrumCredentials])

  const depositUtxo: BitcoinUtxo = {
    transactionHash: BitcoinTxHash.from(transactionId),
    outputIndex: Number(transactionIndex),
    value: BigNumber.from(refundAmount),
  }

  const depositScript = DepositScript.fromReceipt(deposit)
  const depositRefund = DepositRefund.fromScript(depositScript)

  const refundTxHash = await depositRefund.submitTransaction(
    client,
    BigNumber.from(fee),
    depositUtxo,
    recoveryAddress,
    refunderPrivateKey
  )

  console.log("Refund transaction ID", refundTxHash.transactionHash.toString())
}

;(async () => {
  try {
    await run()
  } catch (e) {
    console.log("Exception called:", e)
  }
})()
