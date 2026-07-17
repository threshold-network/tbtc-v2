# Enumeration: StarkNetRelayerDepositStatus

Status of a deposit as reported by the relayer's deposit-status endpoint.

These are the three on-chain states the Starknet deposit-status endpoint can
return. QUEUED=0 is the on-chain Unknown slot (the contract's deposits mapping
stores 0 for not-initialized). The endpoint derives its value from the L1
depositor contract's `deposits` mapping (`Unknown`/`Initialized`/`Finalized`),
which has exactly these three states. This enum intentionally does NOT mirror
every value of the relayer's internal cross-chain lifecycle enum (which
additionally has `AWAITING_WORMHOLE_VAA` and `BRIDGED`): those internal
lifecycle values are never surfaced by the status endpoint, so trusting them
here would widen the accepted input beyond what the endpoint can actually
report and weaken the fail-closed validation in
[StarkNetBitcoinDepositor.handleDepositConflict](../classes/StarkNetBitcoinDepositor.md#handledepositconflict).

## Table of contents

### Enumeration Members

- [FINALIZED](StarkNetRelayerDepositStatus.md#finalized)
- [INITIALIZED](StarkNetRelayerDepositStatus.md#initialized)
- [QUEUED](StarkNetRelayerDepositStatus.md#queued)

## Enumeration Members

### FINALIZED

• **FINALIZED** = ``2``

#### Defined in

[src/lib/starknet/starknet-depositor.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L78)

___

### INITIALIZED

• **INITIALIZED** = ``1``

#### Defined in

[src/lib/starknet/starknet-depositor.ts:76](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L76)

___

### QUEUED

• **QUEUED** = ``0``

#### Defined in

[src/lib/starknet/starknet-depositor.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L74)
