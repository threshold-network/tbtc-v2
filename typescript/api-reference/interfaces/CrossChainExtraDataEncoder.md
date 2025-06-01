# Interface: CrossChainExtraDataEncoder

Interface for encoding and decoding the extra data included in the
cross-chain deposit script.

## Implemented by

- [`EthereumCrossChainExtraDataEncoder`](../classes/EthereumCrossChainExtraDataEncoder.md)
- [`StarkNetCrossChainExtraDataEncoder`](../classes/StarkNetCrossChainExtraDataEncoder.md)

## Table of contents

### Methods

- [decodeDepositOwner](CrossChainExtraDataEncoder.md#decodedepositowner)
- [encodeDepositOwner](CrossChainExtraDataEncoder.md#encodedepositowner)

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

[lib/contracts/cross-chain.ts:184](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L184)

___

### encodeDepositOwner

▸ **encodeDepositOwner**(`depositOwner`): [`Hex`](../classes/Hex.md)

Encodes the given deposit owner identifier into the extra data.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | [`ChainIdentifier`](ChainIdentifier.md) | Identifier of the deposit owner to encode. For cross-chain deposits, the deposit owner is typically an identifier on the L2 chain. |

#### Returns

[`Hex`](../classes/Hex.md)

Encoded extra data.

#### Defined in

[lib/contracts/cross-chain.ts:177](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L177)
