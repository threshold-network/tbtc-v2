/**
 * Hand-written ABI fragments of the tBTC v2 Bridge reservation surface.
 *
 * The reservation functions are not declared in the monolithic Bridge
 * contract. The Bridge's fallback routes every unmatched selector to the
 * reservation router through a delegatecall, so all reservation functions
 * execute at the Bridge address, on the Bridge storage, with the Bridge
 * code. Callers use the union of the Bridge ABI and the router ABI at
 * the Bridge address.
 *
 * The reservation router artifacts are not published yet. Until then,
 * these fragments are hand-written to match the router contract.
 * When the artifacts are published, regenerate this file from the
 * `ReservationRouter.json` artifact and delete these fragments; the
 * deployment objects and the fragment merging in
 * `reservation-bridge-deployments.ts` stay the same.
 *
 * The fragments must remain selector-disjoint from the Bridge ABI: a
 * selector declared by the Bridge never reaches the router, so any
 * duplicate declaration would be unreachable.
 */

export type AbiFragment = {
  type: string
  name?: string
  inputs?: AbiFragmentInput[]
  outputs?: AbiFragmentInput[]
  components?: AbiFragmentInput[]
  indexed?: boolean
  stateMutability?: string
  anonymous?: boolean
}

type AbiFragmentInput = {
  type: string
  name?: string
  components?: AbiFragmentInput[]
  internalType?: string
  indexed?: boolean
}

const reservationRequestComponents: AbiFragmentInput[] = [
  { internalType: "address", name: "owner", type: "address" },
  { internalType: "uint64", name: "mintedAmount", type: "uint64" },
  { internalType: "uint32", name: "acceptedAt", type: "uint32" },
  { internalType: "bytes20", name: "walletPubKeyHash", type: "bytes20" },
  { internalType: "uint64", name: "anchorAmount", type: "uint64" },
  { internalType: "uint32", name: "expiresAt", type: "uint32" },
  { internalType: "bytes32", name: "anchorTxHash", type: "bytes32" },
  { internalType: "uint32", name: "anchorTxOutputIndex", type: "uint32" },
  {
    internalType: "enum Reservation.ReservationState",
    name: "state",
    type: "uint8",
  },
  { internalType: "uint64", name: "requestNonce", type: "uint64" },
  { internalType: "bool", name: "retryCredit", type: "bool" },
  {
    internalType: "uint32",
    name: "dissolutionEligibleAt",
    type: "uint32",
  },
  {
    internalType: "uint64",
    name: "cumulativeReanchorFee",
    type: "uint64",
  },
  {
    internalType: "uint32",
    name: "reanchorCooldownUntil",
    type: "uint32",
  },
]

const reservationActionComponents: AbiFragmentInput[] = [
  {
    internalType: "bytes20",
    name: "targetWalletPubKeyHash",
    type: "bytes20",
  },
  { internalType: "uint32", name: "requestedAt", type: "uint32" },
  { internalType: "uint32", name: "timeoutAt", type: "uint32" },
  { internalType: "uint64", name: "txMaxFee", type: "uint64" },
  {
    internalType: "enum Reservation.ActionType",
    name: "actionType",
    type: "uint8",
  },
  {
    internalType: "enum Reservation.ActionState",
    name: "state",
    type: "uint8",
  },
  { internalType: "bool", name: "feePaid", type: "bool" },
  { internalType: "address", name: "redeemer", type: "address" },
  { internalType: "bytes32", name: "actionDataHash", type: "bytes32" },
  { internalType: "bytes32", name: "sourceAnchorUtxoHash", type: "bytes32" },
  { internalType: "uint64", name: "amount", type: "uint64" },
  { internalType: "bool", name: "usedRetryCredit", type: "bool" },
  {
    internalType: "uint32",
    name: "watchtowerDefaultDelay",
    type: "uint32",
  },
  {
    internalType: "uint32",
    name: "watchtowerLevelOneDelay",
    type: "uint32",
  },
  {
    internalType: "uint32",
    name: "watchtowerLevelTwoDelay",
    type: "uint32",
  },
  {
    internalType: "uint64",
    name: "retryCreditSourceNonce",
    type: "uint64",
  },
  { internalType: "bool", name: "isPartial", type: "bool" },
  { internalType: "uint32", name: "termSeconds", type: "uint32" },
  { internalType: "uint32", name: "dissolutionDelay", type: "uint32" },
  { internalType: "uint64", name: "minAmount", type: "uint64" },
  { internalType: "bool", name: "thirdPartyHold", type: "bool" },
]

export const reservationBridgeAbiFragments: AbiFragment[] = [
  {
    type: "function",
    name: "requestReservationAcceptance",
    stateMutability: "nonpayable",
    inputs: [
      {
        components: [
          { internalType: "bytes4", name: "version", type: "bytes4" },
          { internalType: "bytes", name: "inputVector", type: "bytes" },
          { internalType: "bytes", name: "outputVector", type: "bytes" },
          { internalType: "bytes4", name: "locktime", type: "bytes4" },
        ],
        internalType: "struct BitcoinTx.Info",
        name: "fundingTx",
        type: "tuple",
      },
      {
        components: [
          { internalType: "bytes", name: "merkleProof", type: "bytes" },
          { internalType: "uint256", name: "txIndexInBlock", type: "uint256" },
          { internalType: "bytes", name: "bitcoinHeaders", type: "bytes" },
          {
            internalType: "bytes32",
            name: "coinbasePreimage",
            type: "bytes32",
          },
          { internalType: "bytes", name: "coinbaseProof", type: "bytes" },
        ],
        internalType: "struct BitcoinTx.Proof",
        name: "fundingProof",
        type: "tuple",
      },
      {
        internalType: "uint32",
        name: "fundingOutputIndex",
        type: "uint32",
      },
      { internalType: "bytes20", name: "walletPubKeyHash", type: "bytes20" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "releaseReservedDepositToPool",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "uint256", name: "depositKey", type: "uint256" },
      { internalType: "address", name: "vault", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reservations",
    stateMutability: "view",
    inputs: [
      { internalType: "uint256", name: "reservationKey", type: "uint256" },
    ],
    outputs: [
      {
        internalType: "struct Reservation.ReservationRequest",
        name: "",
        type: "tuple",
        components: reservationRequestComponents,
      },
    ],
  },
  {
    type: "function",
    name: "reservationActions",
    stateMutability: "view",
    inputs: [
      { internalType: "uint256", name: "reservationKey", type: "uint256" },
      { internalType: "uint64", name: "requestNonce", type: "uint64" },
    ],
    outputs: [
      {
        internalType: "struct Reservation.ReservationAction",
        name: "",
        type: "tuple",
        components: reservationActionComponents,
      },
    ],
  },
  {
    type: "function",
    name: "reservationParameters",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { internalType: "address", name: "reservationVault", type: "address" },
      {
        internalType: "uint64",
        name: "reservationMinAmount",
        type: "uint64",
      },
      { internalType: "uint64", name: "reservationTxMaxFee", type: "uint64" },
      {
        internalType: "uint32",
        name: "reservationTermSeconds",
        type: "uint32",
      },
      {
        internalType: "uint32",
        name: "reservationDissolutionDelay",
        type: "uint32",
      },
      {
        internalType: "uint64",
        name: "reservationMaxTotalAmount",
        type: "uint64",
      },
      {
        internalType: "uint64",
        name: "reservationTotalAmount",
        type: "uint64",
      },
      {
        internalType: "uint32",
        name: "maxReservationsPerWallet",
        type: "uint32",
      },
      {
        internalType: "uint32",
        name: "reservationActionTimeout",
        type: "uint32",
      },
      {
        internalType: "uint32",
        name: "reservationRenewalWindowSeconds",
        type: "uint32",
      },
    ],
  },
  {
    type: "function",
    name: "reservationCaps",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        internalType: "uint64",
        name: "maxReservationsAmountPerWallet",
        type: "uint64",
      },
      {
        internalType: "uint64",
        name: "reservationMaxSingleAmount",
        type: "uint64",
      },
      { internalType: "uint32", name: "maxActiveReservations", type: "uint32" },
      {
        internalType: "uint32",
        name: "maxThirdPartyReanchorHoldsPerWallet",
        type: "uint32",
      },
    ],
  },
  {
    type: "function",
    name: "reservationHandoffReserveWallets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ internalType: "uint32", name: "reserves", type: "uint32" }],
  },
  {
    type: "function",
    name: "activeReservationsCount",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { internalType: "uint32", name: "count", type: "uint32" },
      { internalType: "uint32", name: "maxActive", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "walletReservationsAmount",
    stateMutability: "view",
    inputs: [
      { internalType: "bytes20", name: "walletPubKeyHash", type: "bytes20" },
    ],
    outputs: [{ internalType: "uint64", name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "walletReservationsCount",
    stateMutability: "view",
    inputs: [
      { internalType: "bytes20", name: "walletPubKeyHash", type: "bytes20" },
    ],
    outputs: [{ internalType: "uint32", name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "pendingReservedDeposits",
    stateMutability: "view",
    inputs: [],
    outputs: [{ internalType: "uint64", name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "reservedDepositWallet",
    stateMutability: "view",
    inputs: [{ internalType: "uint256", name: "depositKey", type: "uint256" }],
    outputs: [{ internalType: "bytes20", name: "", type: "bytes20" }],
  },
  {
    type: "function",
    name: "pendingThirdPartyReanchorHolds",
    stateMutability: "view",
    inputs: [
      { internalType: "bytes20", name: "walletPubKeyHash", type: "bytes20" },
    ],
    outputs: [{ internalType: "uint32", name: "holds", type: "uint32" }],
  },
  {
    type: "function",
    name: "isReservedDeposit",
    stateMutability: "view",
    inputs: [{ internalType: "uint256", name: "depositKey", type: "uint256" }],
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "ReservedDepositReleasedToPool",
    anonymous: false,
    inputs: [
      {
        internalType: "uint256",
        name: "depositKey",
        type: "uint256",
        indexed: true,
      },
      {
        internalType: "address",
        name: "depositor",
        type: "address",
        indexed: true,
      },
      { internalType: "address", name: "vault", type: "address" },
    ],
  },
]
