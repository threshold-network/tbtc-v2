import chai, { expect } from "chai"
import { ethers } from "hardhat"

import type { ContractTransactionResponse } from "ethers"
import { requireValue } from "../../../helpers/require-value"

// TODO: Move to @keep-network/hardhat-helpers
// eslint-disable-next-line import/prefer-default-export
export async function assertGasUsed(
  tx: ContractTransactionResponse,
  expectedGasUsed: number,
  delta = 1000
): Promise<void> {
  expect(
    requireValue(await tx.wait(), "Transaction receipt").gasUsed,
    "invalid gas used"
  ).to.be.closeTo(BigInt(expectedGasUsed), BigInt(delta))
}
