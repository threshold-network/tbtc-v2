# Interface: BitcoinTxOutput

Data about a Bitcoin transaction output.

## Table of contents

### Properties

- [outputIndex](BitcoinTxOutput.md#outputindex)
- [scriptPubKey](BitcoinTxOutput.md#scriptpubkey)
- [value](BitcoinTxOutput.md#value)

## Properties

### outputIndex

• **outputIndex**: `number`

The 0-based index of the output.

#### Defined in

[lib/bitcoin/tx.ts:77](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L77)

___

### scriptPubKey

• **scriptPubKey**: [`Hex`](../classes/Hex.md)

The receiving scriptPubKey.

#### Defined in

[lib/bitcoin/tx.ts:87](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L87)

___

### value

• **value**: `BigNumber`

The value of the output in satoshis.

#### Defined in

[lib/bitcoin/tx.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L82)
