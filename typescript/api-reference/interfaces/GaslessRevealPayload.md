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
Format varies by chain:
- L1: 32-byte hex (left-padded Ethereum address)
- L2 (Wormhole): 20-byte Ethereum address hex

#### Defined in

[services/deposits/deposits-service.ts:142](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L142)

___

### destinationChainName

• **destinationChainName**: `string`

Target chain name for backend routing.
Must match the chain specified during deposit initiation.

#### Defined in

[services/deposits/deposits-service.ts:148](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L148)

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

[services/deposits/deposits-service.ts:75](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L75)

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

[services/deposits/deposits-service.ts:100](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L100)
