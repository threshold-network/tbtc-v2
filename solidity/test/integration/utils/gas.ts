import chai, { expect } from "chai"
import { ethers } from "hardhat"

import type { ContractTransactionResponse } from "ethers"

// TODO: Move to @keep-network/hardhat-helpers
// eslint-disable-next-line import/prefer-default-export
export async function assertGasUsed(
  tx: ContractTransactionResponse,
  expectedGasUsed: number,
  delta = 1000
): Promise<void> {
  expect((await tx.wait()).gasUsed, "invalid gas used").to.be.closeTo(
    BigInt(expectedGasUsed),
    BigInt(delta)
  )
}
