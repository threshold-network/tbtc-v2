export const TBTC_NAME = "TBTC";
export const TBTC_SIZE_DECIMALS = 3;
export const TBTC_WEI_DECIMALS = 8;
export const TBTC_DEPLOYMENT_MAX_GAS = 1000000000000;
export const TBTC_FULL_NAME = "HyperLiquid tBTC v2";
export const USDC_SPOT_INDEX = 0;
export const SYSTEM_CONTRACT = "0x2222222222222222222222222222222222222222";
export const TBTC_MAX_SUPPLY_IN_WEI = "2100000000000000";

export const BASE_URLS = {
  PRODUCTION: 'https://api.hyperliquid.xyz',
  TESTNET: 'https://api.hyperliquid-testnet.xyz'
};

export const ENDPOINTS = {
  INFO: '/info',
  EXCHANGE: '/exchange'
};

export enum InfoType {
  SPOT_DEPLOY_STATE = 'spotDeployState',
}

export enum ExchangeType {
  SPOT_DEPLOY = 'spotDeploy',
}
