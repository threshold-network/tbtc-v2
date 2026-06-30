# Class: P2TRWitnessSignatureError

## Hierarchy

- `Error`

  ↳ **`P2TRWitnessSignatureError`**

## Table of contents

### Constructors

- [constructor](P2TRWitnessSignatureError.md#constructor)

### Properties

- [code](P2TRWitnessSignatureError.md#code)
- [message](P2TRWitnessSignatureError.md#message)
- [name](P2TRWitnessSignatureError.md#name)
- [stack](P2TRWitnessSignatureError.md#stack)
- [prepareStackTrace](P2TRWitnessSignatureError.md#preparestacktrace)
- [stackTraceLimit](P2TRWitnessSignatureError.md#stacktracelimit)

### Methods

- [captureStackTrace](P2TRWitnessSignatureError.md#capturestacktrace)

## Constructors

### constructor

• **new P2TRWitnessSignatureError**(`code`, `message`): [`P2TRWitnessSignatureError`](P2TRWitnessSignatureError.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `code` | [`P2TRWitnessSignatureErrorCode`](../README.md#p2trwitnesssignatureerrorcode) |
| `message` | `string` |

#### Returns

[`P2TRWitnessSignatureError`](P2TRWitnessSignatureError.md)

#### Overrides

Error.constructor

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:46](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L46)

## Properties

### code

• `Readonly` **code**: [`P2TRWitnessSignatureErrorCode`](../README.md#p2trwitnesssignatureerrorcode)

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:44](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L44)

___

### message

• **message**: `string`

#### Inherited from

Error.message

#### Defined in

tbtc-v2/typescript/node_modules/typescript/lib/lib.es5.d.ts:1077

___

### name

• **name**: `string`

#### Inherited from

Error.name

#### Defined in

tbtc-v2/typescript/node_modules/typescript/lib/lib.es5.d.ts:1076

___

### stack

• `Optional` **stack**: `string`

#### Inherited from

Error.stack

#### Defined in

tbtc-v2/typescript/node_modules/typescript/lib/lib.es5.d.ts:1078

___

### prepareStackTrace

▪ `Static` `Optional` **prepareStackTrace**: (`err`: `Error`, `stackTraces`: `CallSite`[]) => `any`

Optional override for formatting stack traces

**`See`**

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Type declaration

▸ (`err`, `stackTraces`): `any`

##### Parameters

| Name | Type |
| :------ | :------ |
| `err` | `Error` |
| `stackTraces` | `CallSite`[] |

##### Returns

`any`

#### Inherited from

Error.prepareStackTrace

#### Defined in

tbtc-v2/typescript/node_modules/@types/node/globals.d.ts:98

___

### stackTraceLimit

▪ `Static` **stackTraceLimit**: `number`

#### Inherited from

Error.stackTraceLimit

#### Defined in

tbtc-v2/typescript/node_modules/@types/node/globals.d.ts:100

## Methods

### captureStackTrace

▸ **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Create .stack property on a target object

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

tbtc-v2/typescript/node_modules/@types/node/globals.d.ts:91
