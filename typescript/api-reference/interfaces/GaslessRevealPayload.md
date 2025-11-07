# Interface: GaslessRevealPayload

Payload structure for backend gasless reveal endpoint.

This payload contains all information needed by the relayer backend to
submit a gasless deposit reveal transaction. The backend will:
1. Verify the Bitcoin funding transaction
2. Construct the reveal transaction
3. Pay gas fees and submit to the target chain

All hex string fields should be prefixed with "0x".
The fundingTx structure matches BitcoinRawTxVectors format.

**`See`**

for transaction vector structure reference

## Table of contents

### Properties

- [destinationChainDepositOwner](GaslessRevealPayload.md#destinationchaindepositowner)
- [destinationChainName](GaslessRevealPayload.md#destinationchainname)
- [fundingTx](GaslessRevealPayload.md#fundingtx)
- [reveal](GaslessRevealPayload.md#reveal)

## Properties

### destinationChainDepositOwner

• **destinationChainDepositOwner**: `string`

Destination chain deposit owner address.
Format varies by chain based on the contract parameter type:
- L1 (Ethereum): bytes32 - 32-byte hex (left-padded Ethereum address, e.g., "0x000000000000000000000000" + address)
- Arbitrum: address - 20-byte Ethereum address hex (e.g., "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1")
- Base: address - 20-byte Ethereum address hex (e.g., "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1")
- Sui: bytes32 - 32-byte hex (left-padded Ethereum address)
- StarkNet: bytes32 - 32-byte hex (left-padded Ethereum address)

Note: Backend will automatically pad 20-byte addresses to bytes32 for chains that require it.

#### Defined in

[services/deposits/deposits-service.ts:153](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L153)

___

### destinationChainName

• **destinationChainName**: `string`

Target chain name for backend routing (normalized to lowercase).
- "L1" remains as-is for L1 deposits
- L2 chain names are lowercase: "arbitrum", "base", "sui", "starknet"

#### Defined in

[services/deposits/deposits-service.ts:160](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L160)

___

### fundingTx

• **fundingTx**: `Object`

Bitcoin funding transaction decomposed into vectors.
This structure matches the on-chain contract requirements.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `inputVector` | `string` | All transaction inputs prepended by input count as hex string. |
| `locktime` | `string` | Transaction locktime as 4-byte hex string. |
| `outputVector` | `string` | All transaction outputs prepended by output count as hex string. |
| `version` | `string` | Transaction version as 4-byte hex string (e.g., "0x01000000"). |

#### Defined in

[services/deposits/deposits-service.ts:81](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L81)

___

### reveal

• **reveal**: `Object`

Deposit reveal information matching on-chain reveal structure.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `blindingFactor` | `string` | 8-byte blinding factor as hex string (e.g., "0xf9f0c90d00039523"). |
| `fundingOutputIndex` | `number` | Zero-based index of the deposit output in the funding transaction. |
| `refundLocktime` | `string` | 4-byte refund locktime as hex string (little-endian). |
| `refundPubKeyHash` | `string` | 20-byte refund public key hash as hex string. You can use `computeHash160` function to get the hash from a public key. |
| `vault` | `string` | Vault contract address as hex string (e.g., "0x1234..."). |
| `walletPubKeyHash` | `string` | 20-byte wallet public key hash as hex string. You can use `computeHash160` function to get the hash from a public key. |

#### Defined in

[services/deposits/deposits-service.ts:106](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L106)
