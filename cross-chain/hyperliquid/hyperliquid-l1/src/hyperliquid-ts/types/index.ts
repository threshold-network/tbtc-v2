interface TokenSpecification {
  name: string;
  szDecimals: number;
  weiDecimals: number;
}

export interface RegisterToken {
  spec: TokenSpecification;
  maxGas: number;
  fullName: string;
}

export interface DeployerTradingFeeShare {
  token: number,
  share: string,
}

export interface UserGenesis {
  token: number;
  userAndWei: Array<[string, string]>;
  existingTokenAndWei: Array<[number, string]>;
}

export interface Genesis {
  token: number;
  maxSupply: string;
}

export interface SpotTokens {
  tokens: [number, number];
}

export interface Hyperliquidity {
  spot: number;
  startPx: string;
  orderSz: string;
  nOrders: number;
  nSeededLevels: number;
}

export interface Signature {
  r: string;
  s: string;
  v: number;
}

export interface SpotDeployState {
  states: {
    token: number;
    spec: {
      name: string;
      szDecimals: number;
      weiDecimals: number;
    };
    fullName: string;
    spots: number[];
    maxSupply: number;
    hyperliquidityGenesisBalance: string;
    totalGenesisBalanceWei: string;
    userGenesisBalances: [string, string][];
    existingTokenGenesisBalances: [number, string][];
  }[];
  gasAuction: {
    startTimeSeconds: number;
    durationSeconds: number;
    startGas: string;
    currentGas: string | null;
    endGas: string;
  };
}
