import { BitcoinNetwork } from "../../src"
import { Hex } from "../../src"

export const btcAddresses: Record<
  Exclude<BitcoinNetwork, BitcoinNetwork.Unknown>,
  {
    [addressType: string]: {
      address: string
      redeemerOutputScript: string
      scriptPubKey: Hex
    }
  }
> = {
  testnet: {
    P2PKH: {
      address: "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
      redeemerOutputScript:
        "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
      scriptPubKey: Hex.from(
        "76a9142cd680318747b720d67bf4246eb7403b476adb3488ac"
      ),
    },
    P2WPKH: {
      address: "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
      redeemerOutputScript: "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
      scriptPubKey: Hex.from("0014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0"),
    },
    P2SH: {
      address: "2MsM67NLa71fHvTUBqNENW15P68nHB2vVXb",
      redeemerOutputScript:
        "0x17a914011beb6fb8499e075a57027fb0a58384f2d3f78487",
      scriptPubKey: Hex.from("a914011beb6fb8499e075a57027fb0a58384f2d3f78487"),
    },
    P2WSH: {
      address: "tb1qau95mxzh2249aa3y8exx76ltc2sq0e7kw8hj04936rdcmnynhswqqz02vv",
      redeemerOutputScript:
        "0x220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c",
      scriptPubKey: Hex.from(
        "0020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c"
      ),
    },
  },
  testnet4: {
    P2PKH: {
      address: "mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc",
      redeemerOutputScript:
        "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
      scriptPubKey: Hex.from(
        "76a9142cd680318747b720d67bf4246eb7403b476adb3488ac"
      ),
    },
    P2WPKH: {
      address: "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx",
      redeemerOutputScript: "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
      scriptPubKey: Hex.from("0014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0"),
    },
    P2SH: {
      address: "2MsM67NLa71fHvTUBqNENW15P68nHB2vVXb",
      redeemerOutputScript:
        "0x17a914011beb6fb8499e075a57027fb0a58384f2d3f78487",
      scriptPubKey: Hex.from("a914011beb6fb8499e075a57027fb0a58384f2d3f78487"),
    },
    P2WSH: {
      address: "tb1qau95mxzh2249aa3y8exx76ltc2sq0e7kw8hj04936rdcmnynhswqqz02vv",
      redeemerOutputScript:
        "0x220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c",
      scriptPubKey: Hex.from(
        "0020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c"
      ),
    },
  },
  mainnet: {
    P2PKH: {
      address: "12higDjoCCNXSA95xZMWUdPvXNmkAduhWv",
      redeemerOutputScript:
        "0x1976a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac",
      scriptPubKey: Hex.from(
        "76a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac"
      ),
    },
    P2WPKH: {
      address: "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c",
      redeemerOutputScript: "0x1600148d7a0a3461e3891723e5fdf8129caa0075060cff",
      scriptPubKey: Hex.from("00148d7a0a3461e3891723e5fdf8129caa0075060cff"),
    },
    P2SH: {
      address: "342ftSRCvFHfCeFFBuz4xwbeqnDw6BGUey",
      redeemerOutputScript:
        "0x17a91419a7d869032368fd1f1e26e5e73a4ad0e474960e87",
      scriptPubKey: Hex.from("a91419a7d869032368fd1f1e26e5e73a4ad0e474960e87"),
    },
    P2WSH: {
      address: "bc1qeklep85ntjz4605drds6aww9u0qr46qzrv5xswd35uhjuj8ahfcqgf6hak",
      redeemerOutputScript:
        "0x220020cdbf909e935c855d3e8d1b61aeb9c5e3c03ae8021b286839b1a72f2e48fdba70",
      scriptPubKey: Hex.from(
        "0020cdbf909e935c855d3e8d1b61aeb9c5e3c03ae8021b286839b1a72f2e48fdba70"
      ),
    },
  },
}

export const btcAddressFromPublicKey: Record<
  Exclude<BitcoinNetwork, BitcoinNetwork.Unknown>,
  Record<string, { publicKey: Hex; address: string }>
> = {
  testnet: {
    P2PKH: {
      publicKey: Hex.from(
        "0304cc460f320822d17d567a9a1b1039f765ff72512758605b5962226b3d8e5329"
      ),
      address: "msVQ3CCdqffxc5BtxUrtHFPq6CoZSTaJTq",
    },
    P2WPKH: {
      publicKey: Hex.from(
        "0304cc460f320822d17d567a9a1b1039f765ff72512758605b5962226b3d8e5329"
      ),
      address: "tb1qsdtz442y5fmay39rj39vancf7jm0jrf40qkulw",
    },
  },
  testnet4: {
    P2PKH: {
      publicKey: Hex.from(
        "0304cc460f320822d17d567a9a1b1039f765ff72512758605b5962226b3d8e5329"
      ),
      address: "msVQ3CCdqffxc5BtxUrtHFPq6CoZSTaJTq",
    },
    P2WPKH: {
      publicKey: Hex.from(
        "0304cc460f320822d17d567a9a1b1039f765ff72512758605b5962226b3d8e5329"
      ),
      address: "tb1qsdtz442y5fmay39rj39vancf7jm0jrf40qkulw",
    },
  },
  mainnet: {
    P2PKH: {
      publicKey: Hex.from(
        "0304cc460f320822d17d567a9a1b1039f765ff72512758605b5962226b3d8e5329"
      ),
      address: "1CySk97f2eEhpxiHEutWTLBWEDCrZDbSCr",
    },
    P2WPKH: {
      publicKey: Hex.from(
        "0304cc460f320822d17d567a9a1b1039f765ff72512758605b5962226b3d8e5329"
      ),
      address: "bc1qsdtz442y5fmay39rj39vancf7jm0jrf49xd0ya",
    },
  },
}
