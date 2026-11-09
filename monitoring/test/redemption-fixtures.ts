import { BigNumber } from "ethers"
import { EthereumAddress, Hex } from "@keep-network/tbtc-v2.ts"

import type { RedemptionRequestedEvent } from "@keep-network/tbtc-v2.ts"

export function redemptionRequest(
  blockNumber = 10,
  txByte = "44"
): RedemptionRequestedEvent {
  return {
    blockNumber,
    blockHash: Hex.from("22".repeat(32)),
    transactionHash: Hex.from(txByte.repeat(32)),
    walletPublicKeyHash: Hex.from("11".repeat(20)),
    redeemerOutputScript: Hex.from(`0014${"33".repeat(20)}`),
    redeemer: EthereumAddress.from(`0x${"55".repeat(20)}`),
    requestedAmount: BigNumber.from(10000000),
    treasuryFee: BigNumber.from(1000),
    txMaxFee: BigNumber.from(10000),
  }
}
