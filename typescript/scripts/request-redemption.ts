#!/usr/bin/env ts-node
/**
 * Request tBTC → BTC redemption via SDK (TBTC.approveAndCall → TBTCVault).
 *
 * Usage:
 *   CHAIN_API_URL=https://... \
 *   REDEEMER_PRIVATE_KEY=0x... \
 *   BTC_REDEEMER_ADDRESS=tb1... \
 *   REDEMPTION_AMOUNT_SAT=50000 \
 *   yarn request-redemption
 *
 * Optional:
 *   CHAIN_ID=11155111        Sepolia default; set if your RPC uses another chain
 *   ELECTRUM_URL=tcp://...   (same as e2e-deposit)
 *   BITCOIN_NETWORK=testnet4 (Electrum network override)
 *   REDEMPTION_MAX=1         redeem full TBTC balance (token 1e18 precision; amount
 *                            is rounded down to whole satoshi)
 *   STRICT_REDEMPTION_AMOUNT=1  fail if REDEMPTION_AMOUNT_SAT exceeds TBTC balance
 *                            (default: cap to your on-chain balance and continue)
 *
 * Notes:
 * - On Sepolia/testnet, the SDK first tries TBTC Explorer (Mainnet-only) and logs a
 *   warning, then uses Bridge events — that is expected.
 * - tBTC must match this SDK's Sepolia TBTC address; custom deployments need a custom
 *   contracts bundle.
 * - Bridge enforces amount >= redemptionDustThreshold (often 1_000_000 sat on testnets).
 *   If your balance is below that, you cannot redeem until you hold more tBTC or the
 *   governance parameter is lowered.
 *
 * Bitcoin address types: P2PKH, P2WPKH, P2SH, P2WSH (SDK enforces).
 */
import { ethers, BigNumber } from "ethers"
import { TBTC } from "../src/services/tbtc"
import { ElectrumClient } from "../src/lib/electrum"
import {
  BitcoinClientWithNetworkOverride,
  BitcoinNetwork,
} from "../src/lib/bitcoin"
import { loadEthereumCoreContracts } from "../src/lib/ethereum"
import { Chains } from "../src/lib/contracts"
import { Hex } from "../src/lib/utils"
import { amountToSatoshi } from "../src/lib/utils/bitcoin"

/** Same as tBTC token: 1 satoshi == 1e10 in ERC-20 units. */
const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

function satToTokenAmount(sat: BigNumber): BigNumber {
  return sat.mul(SATOSHI_MULTIPLIER)
}

function tokenAmountToWholeSatoshi(token: BigNumber): BigNumber {
  return token.sub(token.mod(SATOSHI_MULTIPLIER)).div(SATOSHI_MULTIPLIER)
}

async function getTbtcBalance(
  wallet: ethers.Wallet,
  tokenAddress: string
): Promise<BigNumber> {
  const erc20 = new ethers.Contract(
    tokenAddress,
    ["function balanceOf(address) view returns (uint256)"],
    wallet
  )
  return erc20.balanceOf(wallet.address) as Promise<BigNumber>
}

async function getRedemptionDustThreshold(
  wallet: ethers.Wallet,
  bridgeAddress: string
): Promise<BigNumber> {
  const bridge = new ethers.Contract(
    bridgeAddress,
    [
      "function redemptionParameters() view returns (uint64,uint64,uint64,uint64,uint32,uint96,uint32)",
    ],
    wallet
  )
  const r = await bridge.redemptionParameters()
  return BigNumber.from(r[0])
}

async function main() {
  const rpcUrl = process.env.CHAIN_API_URL
  const privateKey = process.env.REDEEMER_PRIVATE_KEY
  const btcAddress = process.env.BTC_REDEEMER_ADDRESS
  const amountSatEnv = process.env.REDEMPTION_AMOUNT_SAT
  const redeemMax = process.env.REDEMPTION_MAX === "1"

  if (!rpcUrl || !privateKey || !btcAddress) {
    console.error(
      "Required: CHAIN_API_URL, REDEEMER_PRIVATE_KEY, BTC_REDEEMER_ADDRESS"
    )
    process.exit(1)
  }
  if (!redeemMax && !amountSatEnv) {
    console.error(
      "Set REDEMPTION_AMOUNT_SAT (satoshis) or REDEMPTION_MAX=1 for full balance"
    )
    process.exit(1)
  }

  // StaticJsonRpcProvider avoids eth_chainId-based network detection (which fails
  // with NETWORK_ERROR / noNetwork when the RPC is slow, flaky, or misconfigured).
  const chainId = parseInt(process.env.CHAIN_ID || "11155111", 10)
  const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, chainId)
  const wallet = new ethers.Wallet(privateKey, provider)

  const electrumUrl = process.env.ELECTRUM_URL
  const useNetworkOverride = process.env.BITCOIN_NETWORK === "testnet4"

  let tbtc: TBTC
  if (electrumUrl || useNetworkOverride) {
    const tbtcContracts = await loadEthereumCoreContracts(
      wallet,
      Chains.Ethereum.Sepolia
    )
    let bitcoinClient
    if (electrumUrl) {
      const connectionTimeout = parseInt(
        process.env.ELECTRUM_CONNECTION_TIMEOUT || "30000",
        10
      )
      const retryAttempts = parseInt(
        process.env.ELECTRUM_RETRY_ATTEMPTS || "5",
        10
      )
      bitcoinClient = ElectrumClient.fromUrl(
        electrumUrl,
        undefined,
        retryAttempts,
        1000,
        connectionTimeout
      )
    } else {
      bitcoinClient = ElectrumClient.fromDefaultConfig(BitcoinNetwork.Testnet4)
    }
    if (useNetworkOverride) {
      bitcoinClient = new BitcoinClientWithNetworkOverride(
        bitcoinClient,
        BitcoinNetwork.Testnet4
      )
    }
    tbtc = await TBTC.initializeCustom(tbtcContracts, bitcoinClient)
  } else {
    tbtc = await TBTC.initializeSepolia(wallet)
  }

  const tokenId = await tbtc.tbtcContracts.tbtcToken.getChainIdentifier()
  const tokenAddress = `0x${tokenId.identifierHex}`

  const balance = await getTbtcBalance(wallet, tokenAddress)
  const balanceSat = tokenAmountToWholeSatoshi(balance)
  console.log(
    `TBTC balance (this token): ${balanceSat.toString()} sat` +
      ` (${balance.toString()} smallest units)`
  )

  let amount: BigNumber
  if (redeemMax) {
    if (balanceSat.lte(0)) {
      console.error("No tBTC balance to redeem (or dust after rounding).")
      process.exit(1)
    }
    amount = satToTokenAmount(balanceSat)
    console.log(
      `Redeeming max: ${balanceSat.toString()} sat (token units aligned)`
    )
  } else {
    amount = satToTokenAmount(BigNumber.from(amountSatEnv))
  }

  if (amount.gt(balance)) {
    const strict = process.env.STRICT_REDEMPTION_AMOUNT === "1"
    if (strict) {
      console.error(
        "Burn amount would exceed balance. Lower REDEMPTION_AMOUNT_SAT or use REDEMPTION_MAX=1."
      )
      process.exit(1)
    }
    const cappedSat = balanceSat
    if (cappedSat.lte(0)) {
      console.error("Cannot cap: TBTC balance is zero.")
      process.exit(1)
    }
    console.warn(
      `Requested redemption > TBTC balance. Capping to ${cappedSat.toString()} sat.`
    )
    amount = satToTokenAmount(cappedSat)
  }

  const bridgeId = await tbtc.tbtcContracts.bridge.getChainIdentifier()
  const bridgeAddress = `0x${bridgeId.identifierHex}`
  const dustThresholdSat = await getRedemptionDustThreshold(
    wallet,
    bridgeAddress
  )
  const redemptionSat = amountToSatoshi(amount)
  console.log(
    `Bridge redemption dust threshold (min redemption): ${dustThresholdSat.toString()} sat`
  )
  if (redemptionSat.lt(dustThresholdSat)) {
    console.error(
      `Redemption amount (${redemptionSat.toString()} sat) is below the Bridge minimum ` +
        `(${dustThresholdSat.toString()} sat). On-chain revert: "Redemption amount too small". ` +
        `Mint more tBTC until balance >= ${dustThresholdSat.toString()} sat, or ask governance to lower redemptionDustThreshold.`
    )
    process.exit(1)
  }

  console.log("Requesting redemption...")
  console.log("  Redeemer (ETH):", wallet.address)
  console.log("  BTC output:", btcAddress)

  const { targetChainTxHash, walletPublicKey } =
    await tbtc.redemptions.requestRedemption(btcAddress, amount)

  console.log("Submitted.")
  const txHex = targetChainTxHash as Hex
  const pkHex = walletPublicKey as Hex
  console.log("  Ethereum tx:", txHex.toPrefixedString())
  console.log("  Wallet pubkey:", pkHex.toPrefixedString())
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
