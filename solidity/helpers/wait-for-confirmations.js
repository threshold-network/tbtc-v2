/**
 * Wait through the transaction response: Hardhat's ethers v6 provider does not
 * implement provider.waitForTransaction. Fail before verification if the saved
 * deployment has no retrievable, confirmed transaction.
 *
 * @param {Pick<import("ethers").Provider, "getTransaction">} provider
 * @param {string} transactionHash
 * @param {number} confirmations
 * @param {number} timeout
 * @returns {Promise<import("ethers").TransactionReceipt>}
 */
async function waitForConfirmations(
  provider,
  transactionHash,
  confirmations,
  timeout
) {
  if (!transactionHash) {
    throw new Error("Deployment transaction hash is missing")
  }
  const transaction = await provider.getTransaction(transactionHash)
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
