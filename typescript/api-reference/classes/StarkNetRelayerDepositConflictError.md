# Class: StarkNetRelayerDepositConflictError

Thrown when the relayer reports that a deposit reveal already exists
but its status/deposit-ID does not align with the local derivation.
Preserves whatever deposit ID and verified status could be recovered from
the relayer so the caller can poll the relayer or otherwise recover.

## Hierarchy

- `Error`

  ↳ **`StarkNetRelayerDepositConflictError`**

## Table of contents

### Constructors

- [constructor](StarkNetRelayerDepositConflictError.md#constructor)

### Properties

- [depositId](StarkNetRelayerDepositConflictError.md#depositid)
- [depositIdMismatch](StarkNetRelayerDepositConflictError.md#depositidmismatch)
- [locallyDerivedDepositId](StarkNetRelayerDepositConflictError.md#locallyderiveddepositid)
- [message](StarkNetRelayerDepositConflictError.md#message)
- [name](StarkNetRelayerDepositConflictError.md#name)
- [stack](StarkNetRelayerDepositConflictError.md#stack)
- [status](StarkNetRelayerDepositConflictError.md#status)
- [statusVerified](StarkNetRelayerDepositConflictError.md#statusverified)
- [stackTraceLimit](StarkNetRelayerDepositConflictError.md#stacktracelimit)

### Methods

- [captureStackTrace](StarkNetRelayerDepositConflictError.md#capturestacktrace)
- [prepareStackTrace](StarkNetRelayerDepositConflictError.md#preparestacktrace)

## Constructors

### constructor

• **new StarkNetRelayerDepositConflictError**(`message`, `depositId`, `locallyDerivedDepositId`, `status`, `statusVerified`, `depositIdMismatch?`): [`StarkNetRelayerDepositConflictError`](StarkNetRelayerDepositConflictError.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `message` | `string` | `undefined` |
| `depositId` | `undefined` \| `string` | `undefined` |
| `locallyDerivedDepositId` | `undefined` \| `string` | `undefined` |
| `status` | `undefined` \| [`StarkNetRelayerDepositStatus`](../enums/StarkNetRelayerDepositStatus.md) | `undefined` |
| `statusVerified` | `boolean` | `undefined` |
| `depositIdMismatch` | `boolean` | `false` |

#### Returns

[`StarkNetRelayerDepositConflictError`](StarkNetRelayerDepositConflictError.md)

#### Overrides

Error.constructor

#### Defined in

[src/lib/starknet/starknet-depositor.ts:151](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L151)

## Properties

### depositId

• `Readonly` **depositId**: `undefined` \| `string`

The deposit ID reported by the relayer,
or undefined if the relayer's reported ID was non-canonical or missing.

#### Defined in

[src/lib/starknet/starknet-depositor.ts:153](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L153)

___

### depositIdMismatch

• `Readonly` **depositIdMismatch**: `boolean` = `false`

True specifically when the relayer
reported a canonical deposit ID that disagrees with the SDK's own
locally-derived ID (both known, but different) - as opposed to
`statusVerified` being false for any other reason (e.g. no local ID was
available at all). Lets callers distinguish a genuine ID mismatch from an
unconfigured or unreachable status endpoint without diffing fields
themselves.

#### Defined in

[src/lib/starknet/starknet-depositor.ts:157](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L157)

___

### locallyDerivedDepositId

• `Readonly` **locallyDerivedDepositId**: `undefined` \| `string`

The deposit ID
independently derived by the SDK from the funding transaction, if available.

#### Defined in

[src/lib/starknet/starknet-depositor.ts:154](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L154)

___

### message

• **message**: `string`

#### Inherited from

Error.message

#### Defined in

node_modules/typescript/lib/lib.es5.d.ts:1077

___

### name

• **name**: `string`

#### Inherited from

Error.name

#### Defined in

node_modules/typescript/lib/lib.es5.d.ts:1076

___

### stack

• `Optional` **stack**: `string`

#### Inherited from

Error.stack

#### Defined in

node_modules/typescript/lib/lib.es5.d.ts:1078

___

### status

• `Readonly` **status**: `undefined` \| [`StarkNetRelayerDepositStatus`](../enums/StarkNetRelayerDepositStatus.md)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:155](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L155)

___

### statusVerified

• `Readonly` **statusVerified**: `boolean`

Whether the relayer's status response is
self-consistent and trustable as *the relayer's own account* of the
deposit - NOT independently verified against L1. This depositor has no L1
provider and cannot cross-check the relayer's claim against on-chain
state, so a malicious, buggy, or stale relayer's report cannot be caught
here. True only when the relayer's status response echoed back the exact
deposit ID that was queried AND that ID was the SDK's own
locally-derived ID (either because the relayer's reported ID agreed with
it, or because no canonical relayer ID was available and the query used
the local ID directly) - a relayer merely corroborating its own
unverifiable claim, with no local ID available to cross-check against,
never counts as verified. False in every other case: no status endpoint
configured, no canonical ID available to query, the query failed, the
relayer's success response was not the literal boolean `true`, a
canonical relayer-reported ID mismatched the locally derived one, or the
relayer reported an unrecognized status.

#### Defined in

[src/lib/starknet/starknet-depositor.ts:156](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L156)

___

### stackTraceLimit

▪ `Static` **stackTraceLimit**: `number`

The `Error.stackTraceLimit` property specifies the number of stack frames
collected by a stack trace (whether generated by `new Error().stack` or
`Error.captureStackTrace(obj)`).

The default value is `10` but may be set to any valid JavaScript number. Changes
will affect any stack trace captured _after_ the value has been changed.

If set to a non-number value, or set to a negative number, stack traces will
not capture any frames.

#### Inherited from

Error.stackTraceLimit

#### Defined in

node_modules/@types/node/globals.d.ts:68

## Methods

### captureStackTrace

▸ **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Creates a `.stack` property on `targetObject`, which when accessed returns
a string representing the location in the code at which
`Error.captureStackTrace()` was called.

```js
const myObject = {};
Error.captureStackTrace(myObject);
myObject.stack;  // Similar to `new Error().stack`
```

The first line of the trace will be prefixed with
`${myObject.name}: ${myObject.message}`.

The optional `constructorOpt` argument accepts a function. If given, all frames
above `constructorOpt`, including `constructorOpt`, will be omitted from the
generated stack trace.

The `constructorOpt` argument is useful for hiding implementation
details of error generation from the user. For instance:

```js
function a() {
  b();
}

function b() {
  c();
}

function c() {
  // Create an error without stack trace to avoid calculating the stack trace twice.
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new Error();
  Error.stackTraceLimit = stackTraceLimit;

  // Capture the stack trace above function b
  Error.captureStackTrace(error, b); // Neither function c, nor b is included in the stack trace
  throw error;
}

a();
```

#### Parameters

| Name | Type |
| :------ | :------ |
| `targetObject` | `object` |
| `constructorOpt?` | `Function` |

#### Returns

`void`

#### Inherited from

Error.captureStackTrace

#### Defined in

node_modules/@types/node/globals.d.ts:52

___

### prepareStackTrace

▸ **prepareStackTrace**(`err`, `stackTraces`): `any`

#### Parameters

| Name | Type |
| :------ | :------ |
| `err` | `Error` |
| `stackTraces` | `CallSite`[] |

#### Returns

`any`

**`See`**

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Inherited from

Error.prepareStackTrace

#### Defined in

node_modules/@types/node/globals.d.ts:56
