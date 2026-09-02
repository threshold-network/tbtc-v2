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
Always a 32-byte hex value (bytes32), passed through unchanged from
`receipt.extraData` - every destination chain's own extraData encoder
already produces a 32-byte value (see `AbstractL1BTCDepositor.initializeDeposit`,
solidity/contracts/cross-chain/AbstractL1BTCDepositor.sol:283-293). The backend
or on-chain contract decodes it per chain type; the SDK does not re-encode
or re-extract it.

#### Defined in

[src/services/deposits/deposits-service.ts:161](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L161)

___

### destinationChainName

• **destinationChainName**: `string`

Target chain name for backend routing (normalized to lowercase).
- "L1" remains as-is for L1 deposits
- L2 chain names are lowercase: "arbitrum", "base", "sui", "starknet"

#### Defined in

[src/services/deposits/deposits-service.ts:168](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L168)

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

[src/services/deposits/deposits-service.ts:91](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L91)

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

[src/services/deposits/deposits-service.ts:116](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L116)
