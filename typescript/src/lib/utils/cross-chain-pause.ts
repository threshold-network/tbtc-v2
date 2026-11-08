/**
 * Refuses cross-chain deposit and redemption writes while temporarily paused.
 *
 * Keep this independent of application UI maintenance and configuration.
 * Receipt reconstruction, funding detection, status reads and refunds remain
 * available; a saved cross-chain deposit must not submit a new reveal meanwhile.
 * @returns Never returns while cross-chain operations are paused.
 * @throws Always throws the pause error.
 */
export function assertCrossChainOperationsAllowed(): void {
  throw new Error(
    "Cross-chain deposits and redemptions are temporarily paused. " +
      "Preserve existing receipts and monitor pending transactions."
  )
}
