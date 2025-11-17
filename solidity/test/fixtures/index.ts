import { to1ePrecision } from "../helpers/contract-test-helpers"

export const constants = {
  unmintFee: to1ePrecision(1, 15), // 0.001
  depositDustThreshold: 1000000, // 1000000 satoshi = 0.01 BTC
  depositTxMaxFee: 100000, // 100000 satoshi = 0.001 BTC
  depositTreasuryFeeDivisor: 2000, // 1/2000 == 5bps == 0.05% == 0.0005
  depositRevealAheadPeriod: 1296000, // 15 days
  redemptionDustThreshold: 1000000, // 1000000 satoshi = 0.01 BTC
  redemptionTreasuryFeeDivisor: 2000, // 1/2000 == 5bps == 0.05% == 0.0005
  redemptionTxMaxFee: 100000, // 100000 satoshi = 0.001 BTC
  redemptionTxMaxTotalFee: 1000000, // 1000000 satoshi = 0.01 BTC
  redemptionTimeout: 432000, // 5 days
  redemptionTimeoutSlashingAmount: to1ePrecision(100, 18), // 100 T
  redemptionTimeoutNotifierRewardMultiplier: 100, // 100%
  movingFundsTxMaxTotalFee: 100000, // 100000 satoshi = 0.001 BTC
  movingFundsDustThreshold: 200000, // 200000 satoshi = 0.002 BTC
  movingFundsTimeoutResetDelay: 518400, // 6 days
  movingFundsTimeout: 604800, // 1 week
  movingFundsTimeoutSlashingAmount: to1ePrecision(100, 18), // 100 T
  movingFundsTimeoutNotifierRewardMultiplier: 100, // 100%
  movedFundsSweepTxMaxTotalFee: 100000, // 100000 satoshi = 0.001 BTC
  movedFundsSweepTimeout: 604800, // 1 week
  movedFundsSweepTimeoutSlashingAmount: to1ePrecision(100, 18), // 100 T
  movedFundsSweepTimeoutNotifierRewardMultiplier: 100, // 100%
  movingFundsCommitmentGasOffset: 15000,
  fraudChallengeDepositAmount: to1ePrecision(5, 18), // 5 ether
  fraudChallengeDefeatTimeout: 604800, // 1 week
  fraudSlashingAmount: to1ePrecision(100, 18), // 100 T
  fraudNotifierRewardMultiplier: 100, // 100%
  walletCreationPeriod: 604800, // 1 week
  walletCreationMinBtcBalance: to1ePrecision(1, 8), // 1 BTC
  walletCreationMaxBtcBalance: to1ePrecision(100, 8), // 100 BTC
  walletClosureMinBtcBalance: to1ePrecision(5, 7), // 0.5 BTC
  walletMaxAge: 26 * 604800, // 26 weeks ~ 6 months
  walletMaxBtcTransfer: to1ePrecision(10, 8), // 10 BTC
  walletClosingPeriod: 3456000, // 40 days
  governanceDelay: 172800, // 48 hours
  satoshiMultiplier: 1e10, // Converts satoshi to TBTC token units
  rebateStakingAddress: "0xE41d2489571d322189246DaFA5ebDe1F4699F498",
}

export const walletState = {
  Unknown: 0,
  Live: 1,
  MovingFunds: 2,
  Closing: 3,
  Closed: 4,
  Terminated: 5,
}

export const walletAction = {
  Idle: 0,
  Heartbeat: 1,
  DepositSweep: 2,
  Redemption: 3,
  MovingFunds: 4,
  MovedFundsSweep: 5,
}

export const ecdsaDkgState = {
  IDLE: 0,
  AWAITING_SEED: 1,
  AWAITING_RESULT: 2,
  CHALLENGE: 3,
}

export const movedFundsSweepRequestState = {
  Unknown: 0,
  Pending: 1,
  Processed: 2,
  TimedOut: 3,
}
