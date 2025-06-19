/**
 * ABI for StarkNet tBTC token contract
 * This defines the interface for interacting with tBTC tokens on StarkNet
 */

/**
 * Represents an ABI entry for StarkNet contracts
 */
interface StarkNetABIEntry {
  name: string
  type: string
  inputs?: Array<{
    name: string
    type: string
  }>
  outputs?: Array<{
    name?: string
    type: string
  }>
}

/**
 * tBTC token ABI for StarkNet
 * Includes standard ERC20 functions needed for tBTC operations
 */
export const tbtcABI: StarkNetABIEntry[] = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [
      {
        name: "account",
        type: "felt",
      },
    ],
    outputs: [
      {
        type: "Uint256",
      },
    ],
  },
  {
    name: "transfer",
    type: "function",
    inputs: [
      {
        name: "recipient",
        type: "felt",
      },
      {
        name: "amount",
        type: "Uint256",
      },
    ],
    outputs: [
      {
        name: "success",
        type: "felt",
      },
    ],
  },
  {
    name: "transferFrom",
    type: "function",
    inputs: [
      {
        name: "sender",
        type: "felt",
      },
      {
        name: "recipient",
        type: "felt",
      },
      {
        name: "amount",
        type: "Uint256",
      },
    ],
    outputs: [
      {
        name: "success",
        type: "felt",
      },
    ],
  },
  {
    name: "totalSupply",
    type: "function",
    inputs: [],
    outputs: [
      {
        type: "Uint256",
      },
    ],
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [
      {
        type: "felt",
      },
    ],
  },
]
