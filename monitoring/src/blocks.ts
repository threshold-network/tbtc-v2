import { providers } from "ethers"

import { context } from "./context"

const resolve = () => {
  const provider = new providers.JsonRpcProvider(context.ethereumUrl)

  const latestBlock = async () => {
    const block = await provider.getBlock("latest")
    return block.number
  }

  const blockTimestamp = async (blockNumber: number): Promise<number> => {
    const block = await provider.getBlock(blockNumber)
    return block.timestamp
  }

  const latestBlockTimestamp = async (): Promise<number> => {
    const block = await provider.getBlock("latest")
    return block.timestamp
  }

  return { latestBlock, blockTimestamp, latestBlockTimestamp }
}

export const blocks = resolve()
