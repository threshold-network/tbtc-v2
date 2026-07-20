# Enumeration: RelayerDepositStatus

Status of a deposit as reported by the relayer's deposit-status endpoint.

These are the three on-chain states the Starknet deposit-status endpoint can
return. The endpoint derives its value from the L1 depositor contract's
`deposits` mapping (`Unknown`/`Initialized`/`Finalized`), which has exactly
these three states. This enum intentionally does NOT mirror every value of
the relayer's internal cross-chain lifecycle enum (which additionally has
`AWAITING_WORMHOLE_VAA` and `BRIDGED`): those internal lifecycle values are
never surfaced by the status endpoint, so trusting them here would widen the
accepted input beyond what the endpoint can actually report and weaken the
fail-closed validation in [StarkNetBitcoinDepositor.handleDepositConflict](../classes/StarkNetBitcoinDepositor.md#handledepositconflict).

## Table of contents

### Enumeration Members

- [FINALIZED](RelayerDepositStatus.md#finalized)
- [INITIALIZED](RelayerDepositStatus.md#initialized)
- [QUEUED](RelayerDepositStatus.md#queued)

## Enumeration Members

### FINALIZED

• **FINALIZED** = ``2``

#### Defined in

[src/lib/starknet/starknet-depositor.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L74)

___

### INITIALIZED

• **INITIALIZED** = ``1``

#### Defined in

[src/lib/starknet/starknet-depositor.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L72)

___

### QUEUED

• **QUEUED** = ``0``

#### Defined in

[src/lib/starknet/starknet-depositor.ts:70](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L70)
