# Interface: ElectrumCredentials

Represents a set of credentials required to establish an Electrum connection.

## Table of contents

### Properties

- [host](ElectrumCredentials.md#host)
- [path](ElectrumCredentials.md#path)
- [port](ElectrumCredentials.md#port)
- [protocol](ElectrumCredentials.md#protocol)

## Properties

### host

• **host**: `string`

Host pointing to the Electrum server.

#### Defined in

[lib/electrum/client.ts:37](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L37)

___

### path

• `Optional` **path**: `string`

Optional URL path (e.g. for authenticated WebSocket endpoints).

#### Defined in

[lib/electrum/client.ts:49](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L49)

___

### port

• **port**: `number`

Port the Electrum server listens on.

#### Defined in

[lib/electrum/client.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L41)

___

### protocol

• **protocol**: ``"tcp"`` \| ``"tls"`` \| ``"ssl"`` \| ``"ws"`` \| ``"wss"``

Protocol used by the Electrum server.

#### Defined in

[lib/electrum/client.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L45)
