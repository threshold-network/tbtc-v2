import { readFileSync, writeFileSync } from "fs"
import { JsonRpcProvider } from "ethers"

const [, , deploymentPath, txHash, address, rpcUrl] = process.argv

if (!deploymentPath || !txHash || !address || !rpcUrl) {
  console.error(
    "Usage: bun scripts/update-deployment-from-receipt.ts <deploymentPath> <txHash> <address> <rpcUrl>"
  )
  process.exit(1)
}

const provider = new JsonRpcProvider(rpcUrl)
const receipt = await provider.getTransactionReceipt(txHash)

if (!receipt) {
  console.error(`No receipt found for tx ${txHash}`)
  process.exit(1)
}

const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"))

deployment.address = address
deployment.transactionHash = txHash
deployment.numDeployments = (deployment.numDeployments ?? 0) + 1
deployment.receipt = {
  ...deployment.receipt,
  to: receipt.to ?? null,
  from: receipt.from,
  contractAddress: address,
  transactionIndex: receipt.transactionIndex,
  gasUsed: receipt.gasUsed.toString(),
  logsBloom: receipt.logsBloom,
  blockHash: receipt.blockHash,
  transactionHash: txHash,
  logs: receipt.logs ?? [],
  blockNumber: receipt.blockNumber,
  cumulativeGasUsed: receipt.cumulativeGasUsed.toString(),
  status: receipt.status ?? deployment.receipt?.status ?? 1,
  byzantium: deployment.receipt?.byzantium ?? true,
}

writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2))
