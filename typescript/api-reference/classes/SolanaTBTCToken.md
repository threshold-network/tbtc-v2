# Class: SolanaTBTCToken

TBTC Token class that:
- Derives the mint PDA from the seed "tbtc-mint".
- Fetches balances & total supply via SPL Token.
- Manually creates a user’s ATA if needed (no direct Keypair usage).

## Implements

- [`DestinationChainTBTCToken`](../interfaces/DestinationChainTBTCToken.md)

## Table of contents

### Constructors

- [constructor](SolanaTBTCToken.md#constructor)

### Properties

- [#programId](SolanaTBTCToken.md##programid)
- [#provider](SolanaTBTCToken.md##provider)
- [#tbtcMint](SolanaTBTCToken.md##tbtcmint)

### Methods

- [balanceOf](SolanaTBTCToken.md#balanceof)
- [getChainIdentifier](SolanaTBTCToken.md#getchainidentifier)
- [totalSupply](SolanaTBTCToken.md#totalsupply)

## Constructors

### constructor

• **new SolanaTBTCToken**(`provider`): [`SolanaTBTCToken`](SolanaTBTCToken.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `provider` | `AnchorProvider` |

#### Returns

[`SolanaTBTCToken`](SolanaTBTCToken.md)

#### Defined in

[src/lib/solana/solana-tbtc-token.ts:25](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-tbtc-token.ts#L25)

## Properties

### #programId

• `Private` `Readonly` **#programId**: `PublicKey`

#### Defined in

[src/lib/solana/solana-tbtc-token.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-tbtc-token.ts#L22)

___

### #provider

• `Private` `Readonly` **#provider**: `AnchorProvider`

#### Defined in

[src/lib/solana/solana-tbtc-token.ts:21](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-tbtc-token.ts#L21)

___

### #tbtcMint

• `Private` `Readonly` **#tbtcMint**: `PublicKey`

#### Defined in

[src/lib/solana/solana-tbtc-token.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-tbtc-token.ts#L23)

## Methods

### balanceOf

▸ **balanceOf**(`identifier`): `Promise`\<`bigint`\>

Returns the user’s TBTC balance (in smallest token units).
If the associated token account does not exist, we create it
using a transaction signed by the connected wallet.

#### Parameters

| Name | Type |
| :------ | :------ |
| `identifier` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<`bigint`\>

#### Implementation of

[DestinationChainTBTCToken](../interfaces/DestinationChainTBTCToken.md).[balanceOf](../interfaces/DestinationChainTBTCToken.md#balanceof)

#### Defined in

[src/lib/solana/solana-tbtc-token.ts:55](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-tbtc-token.ts#L55)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

get the chain identifier from the program ID:

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Implementation of

[DestinationChainTBTCToken](../interfaces/DestinationChainTBTCToken.md).[getChainIdentifier](../interfaces/DestinationChainTBTCToken.md#getchainidentifier)

#### Defined in

[src/lib/solana/solana-tbtc-token.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-tbtc-token.ts#L45)

___

### totalSupply

▸ **totalSupply**(): `Promise`\<`bigint`\>

Fetches the total supply from the TBTC mint’s SPL Token account.

#### Returns

`Promise`\<`bigint`\>

#### Defined in

[src/lib/solana/solana-tbtc-token.ts:96](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-tbtc-token.ts#L96)
