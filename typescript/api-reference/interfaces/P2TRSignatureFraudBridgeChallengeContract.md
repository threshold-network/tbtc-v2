# Interface: P2TRSignatureFraudBridgeChallengeContract

Duck-typed contract interface the P2TR signature-fraud watchtower
uses to submit challenges on-chain.

IMPORTANT: After the ECDSA fraud extraction (Bridge PR #435), the
`processP2TRSignatureFraudChallenge` entry point moved off Bridge
into the dedicated `P2TRSignatureFraudRouter` sidecar. Callers
MUST pass an instance of the router contract (not Bridge); passing
Bridge will fail at runtime because the entry point no longer
exists on Bridge.

`fraudParameters` still lives on Bridge, so consumers that need
the deposit-amount lookup can either (a) pass the router contract
if it exposes a `fraudParameters` view that proxies through, or
(b) supply `challengeDepositAmount` directly via the submitter
options to skip the read.

The type name retains "Bridge" for backward source-compat with
pre-extraction consumers; semantically it is now the router
contract. Will be renamed to `P2TRSignatureFraudRouterContract`
in a follow-up SDK breaking-change release.

## Table of contents

### Methods

- [fraudParameters](P2TRSignatureFraudBridgeChallengeContract.md#fraudparameters)
- [processP2TRSignatureFraudChallenge](P2TRSignatureFraudBridgeChallengeContract.md#processp2trsignaturefraudchallenge)

## Methods

### fraudParameters

▸ **fraudParameters**(): `Promise`\<[`P2TRSignatureFraudBridgeFraudParameters`](../README.md#p2trsignaturefraudbridgefraudparameters)\>

#### Returns

`Promise`\<[`P2TRSignatureFraudBridgeFraudParameters`](../README.md#p2trsignaturefraudbridgefraudparameters)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2218](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2218)

___

### processP2TRSignatureFraudChallenge

▸ **processP2TRSignatureFraudChallenge**(`action`, `payload`, `walletMembersIDs`, `overrides`): `Promise`\<[`P2TRSignatureFraudBridgeTransaction`](../README.md#p2trsignaturefraudbridgetransaction)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `action` | `number` |
| `payload` | `string` |
| `walletMembersIDs` | `number`[] |
| `overrides` | `Object` |
| `overrides.value` | `BigNumberish` |

#### Returns

`Promise`\<[`P2TRSignatureFraudBridgeTransaction`](../README.md#p2trsignaturefraudbridgetransaction)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2219](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2219)
