import { BitcoinNetwork } from "../bitcoin/network"

/**
 * NativeBTCDepositor contract addresses for gasless L1 tBTC deposits.
 *
 * These contracts enable users to make Bitcoin deposits to L1 Ethereum
 * without paying gas fees. The relayer backend handles all transaction costs.
 * The depositor contract acts as an intermediary that accepts Bitcoin deposits
 * and automatically initiates the tBTC minting process on the user's behalf.
 *
 * @remarks
 * This constant maps Bitcoin network types to their corresponding
 * NativeBTCDepositor smart contract addresses deployed on Ethereum.
 * It is used by the DepositsService to select the appropriate contract
 * address based on the Bitcoin network environment (mainnet vs testnet).
 *
 * The gasless deposit flow works as follows:
 * 1. User makes a Bitcoin deposit to the depositor contract address
 * 2. Relayer backend detects the deposit and covers gas costs
 * 3. Depositor contract initiates tBTC minting on Ethereum L1
 * 4. User receives tBTC without paying any Ethereum transaction fees
 *
 * @example
 * ```typescript
 * import { NATIVE_BTC_DEPOSITOR_ADDRESSES } from "@keep-network/tbtc-v2.ts"
 * import { BitcoinNetwork } from "@keep-network/tbtc-v2.ts"
 *
 * const bitcoinNetwork = BitcoinNetwork.Mainnet
 * const depositorAddress = NATIVE_BTC_DEPOSITOR_ADDRESSES[bitcoinNetwork]
 * console.log(depositorAddress) // "0xad7c6d46F4a4bc2D3A227067d03218d6D7c9aaa5"
 * ```
 *
 * @see {@link https://github.com/keep-network/tbtc-v2/blob/main/solidity/contracts/depositor/NativeBTCDepositor.sol} for contract implementation
 */
export const NATIVE_BTC_DEPOSITOR_ADDRESSES: Record<
  BitcoinNetwork.Mainnet | BitcoinNetwork.Testnet,
  string
> = {
  [BitcoinNetwork.Mainnet]: "0xad7c6d46F4a4bc2D3A227067d03218d6D7c9aaa5",
  [BitcoinNetwork.Testnet]: "0xb673147244A39d0206b36925A8A456EB91a7Abc0",
}
