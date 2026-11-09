/**
 * Some RPC providers return an empty-string `to` field for contract-creation
 * transactions/receipts instead of omitting it or returning `null`. Ethers
 * v6's formatters reject that empty string as an invalid address (unlike
 * v5), so this normalizes it to `null` before ethers parses the response.
 * This is a standalone CommonJS copy of helpers/provider.ts's fix: this file
 * is vendored into node_modules by apply-solidity-contracts-export-deploy-
 * patch.sh and cannot import the TypeScript helper from there.
 *
 * Must patch `hre.network.provider`, not `hre.ethers.provider`:
 * `HardhatEthersProvider.getTransaction`/`getTransactionReceipt` call
 * `this._hardhatProvider.send(...)` directly (bypassing the outer ethers
 * provider's own `.send`), and `_hardhatProvider` is `hre.network.provider`
 * by reference (see @nomicfoundation/hardhat-ethers's
 * `internal/index.js`: `new HardhatEthersProvider(hre.network.provider, ...)`).
 */
const normalizedProviders = new WeakSet()

const NORMALIZED_METHODS = {
  eth_getTransactionByHash: true,
  eth_getTransactionReceipt: true,
}

function normalizeEmptyRecipient(method, result) {
  if (
    NORMALIZED_METHODS[method] &&
    result !== null &&
    typeof result === "object" &&
    "to" in result &&
    result.to === ""
  ) {
    return { ...result, to: null }
  }
  return result
}

function installContractCreationNormalization(provider) {
  if (normalizedProviders.has(provider)) return
  const send = provider.send.bind(provider)
  // eslint-disable-next-line no-param-reassign
  provider.send = async (method, params) =>
    normalizeEmptyRecipient(method, await send(method, params))
  if (provider.request) {
    const request = provider.request.bind(provider)
    // eslint-disable-next-line no-param-reassign
    provider.request = async (args) =>
      normalizeEmptyRecipient(args.method, await request(args))
  }
  normalizedProviders.add(provider)
}

/**
 * Wait through the transaction response: Hardhat's ethers v6 provider does not
 * implement provider.waitForTransaction. Fail before verification if the saved
 * deployment has no retrievable, confirmed transaction.
 *
 * @param {import("hardhat/types").HardhatRuntimeEnvironment} hre
 * @param {string} transactionHash
 * @param {number} confirmations
 * @param {number} timeout
 * @returns {Promise<import("ethers").TransactionReceipt>}
 */
async function waitForConfirmations(
  hre,
  transactionHash,
  confirmations,
  timeout
) {
  installContractCreationNormalization(hre.network.provider)
  if (!transactionHash) {
    throw new Error("Deployment transaction hash is missing")
  }
  const transaction = await hre.ethers.provider.getTransaction(transactionHash)
  if (!transaction) {
    throw new Error(`Deployment transaction ${transactionHash} was not found`)
  }
  const receipt = await transaction.wait(confirmations, timeout)
  if (!receipt) {
    throw new Error(
      `Deployment transaction ${transactionHash} is not confirmed`
    )
  }
  return receipt
}

module.exports = waitForConfirmations
