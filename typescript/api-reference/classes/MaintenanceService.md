# Class: MaintenanceService

Service exposing features relevant to authorized maintainers and
operators of the tBTC v2 system.

## Table of contents

### Constructors

- [constructor](MaintenanceService.md#constructor)

### Properties

- [optimisticMinting](MaintenanceService.md#optimisticminting)
- [spv](MaintenanceService.md#spv)

## Constructors

### constructor

• **new MaintenanceService**(`tbtcContracts`, `bitcoinClient`): [`MaintenanceService`](MaintenanceService.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |

#### Returns

[`MaintenanceService`](MaintenanceService.md)

#### Defined in

[services/maintenance/maintenance-service.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/maintenance-service.ts#L20)

## Properties

### optimisticMinting

• `Readonly` **optimisticMinting**: [`OptimisticMinting`](OptimisticMinting.md)

Features for optimistic minting maintainers.

#### Defined in

[services/maintenance/maintenance-service.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/maintenance-service.ts#L14)

___

### spv

• `Readonly` **spv**: [`Spv`](Spv.md)

Features for SPV proof maintainers.

#### Defined in

[services/maintenance/maintenance-service.ts:18](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/maintenance-service.ts#L18)
