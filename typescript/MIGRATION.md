# Migrating to tBTC SDK v4 (ethers v5 → viem)

Version 4 replaces the SDK's internal Ethereum library, [ethers v5](https://docs.ethers.org/v5/),
with [viem](https://viem.sh). The chain library is now hidden behind an SDK-owned
interface, so future changes to the underlying library will not break your code.

This is a breaking release. Most consumers need only two changes: pass a viem client
(or keep passing an ethers v5 signer — still supported), and switch `BigNumber` values
to native `bigint`. The details below are exhaustive.

## 1. Node.js ≥ 18 required

The minimum supported Node version is now 18 (was 16).

## 2. `ethers` is no longer a dependency of the SDK

The SDK no longer imports `ethers`, and it is not in the SDK's dependency tree as a
direct dependency. You do not need `ethers` installed to use the SDK.

**ethers v5 `Signer`/`Provider` instances are still accepted** by every
`initialize*`/loader entrypoint through a structural compatibility shim — existing v5
integrations keep working without a cast or code change.

**ethers v6 objects are _not_ accepted.** Pass your EIP-1193 provider
(`window.ethereum`) or a viem client instead.

## 3. `EthereumSigner` accepts more shapes

```ts
type EthereumSigner =
  | WalletClient // viem — read + write
  | PublicClient // viem — read only
  | Eip1193Provider // raw EIP-1193 (window.ethereum, WalletConnect, …)
  | EthersV5SignerLike // ethers v5 Signer (structural shim, no ethers import)
  | EthersV5ProviderLike // ethers v5 Provider (structural shim, read only)
```

Recommended: pass a viem `WalletClient` (write) or `PublicClient` (read-only), or a raw
EIP-1193 provider. Example:

```ts
import { createWalletClient, custom } from "viem"
import { mainnet } from "viem/chains"

const walletClient = createWalletClient({
  chain: mainnet,
  transport: custom(window.ethereum),
})

const sdk = await TBTC.initializeMainnet(walletClient)
```

ethers v5 continues to work unchanged:

```ts
const sdk = await TBTC.initializeMainnet(ethersV5Signer) // still supported
```

## 4. `BigNumber` → `bigint` everywhere

Every value that was an ethers `BigNumber` is now a native `bigint`. This affects
parameters, return values, and event/struct fields, including:

- `DepositRequest.amount`, `DepositRequest.treasuryFee`
- `RedemptionRequest.requestedAmount`, `.treasuryFee`, `.txMaxFee`
- `RedemptionRequestedEvent` amounts, `DepositRevealedEvent.amount`
- `Wallet.pendingRedemptionsValue`
- `OptimisticMintingRequestedEvent.amount`,
  `OptimisticMintingFinalizedEvent.optimisticMintingDebt`
- `TBTCToken.totalSupply()`, `Bridge.requestRedemption(amount)`,
  `TBTCToken.requestRedemption(amount)`, `L2BitcoinRedeemer.requestRedemption(amount)`
- `DestinationChainTBTCToken.balanceOf()`
- `BitcoinTxOutput.value`, `BitcoinUtxo.value`
- `ValidRedemptionWallet.walletBTCBalance`
- `amountToSatoshi(value)`, `RedemptionsService.requestRedemption*(amount)`
- deposit funding/refund fee parameters and SPV difficulty parameters

Conversion cheatsheet:

| ethers v5               | viem / native               |
| ----------------------- | --------------------------- |
| `BigNumber.from(x)`     | `BigInt(x)`                 |
| `a.add(b)` / `a.sub(b)` | `a + b` / `a - b`           |
| `a.mul(b)` / `a.div(b)` | `a * b` / `a / b` (integer) |
| `a.eq(b)` / `a.lt(b)`   | `a === b` / `a < b`         |
| `x.toNumber()`          | `Number(x)`                 |
| `x.toString()`          | `x.toString()`              |

> **`JSON.stringify` throws on `bigint`.** If you serialize SDK values, convert with
> `.toString()` first (or a `bigint`-aware replacer). This is a deliberate, loud
> failure rather than silent corruption.

## 5. Renamed / changed exports

- `BitcoinHashUtils.hashLEToBigNumber` → **`hashLEToBigInt`** (returns `bigint`).
- Receipt-returning deposit paths (`initializeDeposit`/`revealDeposit` on depositor
  proxies and cross-chain depositors) now return the SDK-owned
  **`ChainTransactionReceipt`** (`{ transactionHash: string; blockNumber?: number;
status?: "success" | "reverted" | number }`) instead of the ethers
  `TransactionReceipt`. If you only read `.transactionHash`, no change is needed.
- `L1BitcoinRedeemer.requestRedemption` `encodedVm` is now `Hex | Uint8Array`
  (was ethers `BytesLike`).
- Internal adapter exports renamed: `EthersContractConfig` → `EthereumContractConfig`
  (already the documented name), `EthersContractDeployment` → `EvmContractDeployment`;
  `EthersContractHandle` / `EthersTransactionUtils` / `EthersEventUtils` are removed
  (internal; replaced by `EvmContractHandle`). `EthereumContractConfig.signerOrProvider`
  keeps its name but now takes the new `EthereumSigner`.

## 6. Event filtering

- `get*Events` filter arguments remain positional but must now be `0x`-prefixed hex
  strings, addresses, or `bigint` — ethers `BigNumber` filter values are no longer
  accepted.
- Indexed `bytes20`/`bytes32` event filtering (e.g. `getRedemptionRequestedEvents` by
  `walletPublicKeyHash`) now works correctly. If you previously worked around the
  ethers v5 bug that broke this, you can remove that workaround.
- `GetChainEvents.Options.fromBlock` / `.toBlock` remain `number` (unchanged).

## 7. Unchanged

`Hex`, `EthereumAddress`, the `Chains` enum values, Sepolia/Mainnet behavior, all
Bitcoin/Electrum client APIs, retry/backoff semantics, and every non-EVM chain SDK
(StarkNet, SUI, Solana) are unchanged apart from the `BigNumber` → `bigint` type shift
described in §4.

## Notes

- The ethers v5 compatibility shim is provided for a smooth transition and is considered
  deprecated at birth — plan to move to a viem client or raw EIP-1193 provider.
- viem unlocks multicall batching and event subscriptions; these are not used yet and
  are planned follow-ups, not part of this migration.
