# Interface: ElectrumCredentials

Represents a set of credentials required to establish an Electrum connection.

## Table of contents

### Properties

- [host](ElectrumCredentials.md#host)
- [port](ElectrumCredentials.md#port)
- [protocol](ElectrumCredentials.md#protocol)

## Properties

### host

• **host**: `string`

Host pointing to the Electrum server.

#### Defined in

[lib/electrum/client.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L35)

___

### port

• **port**: `number`

Port the Electrum server listens on.

#### Defined in

[lib/electrum/client.ts:39](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L39)

___

### protocol

• **protocol**: ``"tcp"`` \| ``"tls"`` \| ``"ssl"`` \| ``"ws"`` \| ``"wss"``

Protocol used by the Electrum server.

#### Defined in

[lib/electrum/client.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L43)
