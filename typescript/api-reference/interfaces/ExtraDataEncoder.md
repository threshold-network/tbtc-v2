# Interface: ExtraDataEncoder

Interface for encoding and decoding the extra data included in the
cross-chain deposit script.

## Implemented by

- [`ArbitrumExtraDataEncoder`](../classes/ArbitrumExtraDataEncoder.md)
- [`EthereumExtraDataEncoder`](../classes/EthereumExtraDataEncoder.md)
- [`SolanaExtraDataEncoder`](../classes/SolanaExtraDataEncoder.md)
- [`StarkNetExtraDataEncoder`](../classes/StarkNetExtraDataEncoder.md)

## Table of contents

### Methods

- [decodeDepositOwner](ExtraDataEncoder.md#decodedepositowner)
- [encodeDepositOwner](ExtraDataEncoder.md#encodedepositowner)

## Methods

### decodeDepositOwner

▸ **decodeDepositOwner**(`extraData`): [`ChainIdentifier`](ChainIdentifier.md)

Decodes the extra data into the deposit owner identifier.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `extraData` | [`Hex`](../classes/Hex.md) | Extra data to decode. |

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

Identifier of the deposit owner.

#### Defined in

[lib/contracts/cross-chain.ts:245](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L245)

___

### encodeDepositOwner

▸ **encodeDepositOwner**(`depositOwner`): [`Hex`](../classes/Hex.md)

Encodes the given deposit owner identifier into the extra data.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | [`ChainIdentifier`](ChainIdentifier.md) | Identifier of the deposit owner to encode. For cross-chain deposits, the deposit owner is typically an identifier on the destination chain. |

#### Returns

[`Hex`](../classes/Hex.md)

Encoded extra data.

#### Defined in

[lib/contracts/cross-chain.ts:238](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L238)
