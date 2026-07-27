import {BytesLike} from "ethers"

/**
 * Represents a set of data used for given fraud scenario.
 */
export interface FraudTestData {
  /**
   * The signature generated during input signing.
   */
  signature: {
    v: number
    r: BytesLike
    s: BytesLike
  }

  /**
   * The preimage used during the input signing.
   * The SHA-256 hash of `preimage` results in `preimageSha256`.
   */
  preimage: BytesLike

  /**
   * The SHA-256 hash of the preimage.
   * The SHA-256 hash of `preimageSha256` results in `sighash` which is used
   * during input signing.
   */
  preimageSha256: BytesLike

  /**
   * The SHA-256 hash of `preimageSha256`.
   * This is the data that is actually signed during the input signing.
   */
  sighash: BytesLike

  /**
   * Determines whether the input used during signing is witness or not.
   */
  witness: boolean

  /**
   * Swept deposits that will be registered in the system during the test case
   * execution.
   */
  deposits: {
    txHash: BytesLike // little endian
    txOutputIndex: number
    txOutputValue: number
  }[]

  /**
   * Spent main UTXOs that will be registered in the system during the test case
   * execution.
   */
  spentMainUtxos: {
    txHash: BytesLike // little endian
    txOutputIndex: number
    txOutputValue: number
  }[]

  /**
   * Processed moved funds sweep requests that will be registered in the system
   * during the test case execution.
   */
  movedFundsSweepRequests: {
    txHash: BytesLike // little endian
    txOutputIndex: number
    txOutputValue: number
  }[]
}

export const wallet = {
  // Uncompressed and unprefixed version of the public key:
  // 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9
  publicKey:
    "0x989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9" +
    "d218b65e7d91c752f7b22eaceb771a9af3a6f3d3f010a5d471a1aeef7d7713af",

  // Hash 160 of the public key:
  // 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9
  pubKeyHash160: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",

  // ID of the ECDSA Wallet from ECDSA Wallet Registry i.e. Keccak256(uncompressedPublicKey)
  ecdsaWalletID:
    "0x9ff37567d973e4d884bc42d2d1a6cb1ff22676ab64f82c62b58e2b0ffd3fff71",
}

// Test data comes from the (only) input of transaction:
// https://live.blockcypher.com/btc-testnet/tx/25725b6110fdd095282e61f714e72ec14ebdba7d2c29e93a89a9fb11504a5f10/
export const nonWitnessSignSingleInputTx: FraudTestData = {
  signature: {
    v: 28,
    r: "0x918157d51c1c74858b577d039f0a936aea6236c2510cf31828d1025e4dfd803d",
    s: "0x27905b4bd56fa9a2ee15c2bc4478bccb83dd8340db272ec5fad5b3b4faf32fcd",
  },
  preimage:
    "0x0100000001fb26e52365437fc4fce01864d1303e0e1ed2824ef83345ea6e8517" +
    "4060778acb000000005c14934b98637ca318a4d6e7ca6ffd1690b8e77df6377508" +
    "f9f0c90d000395237576a9148db50eb52063ea9d98b3eac91489a90f738986f687" +
    "63ac6776a914e257eccafbc07c381642ce6e7e55120fb077fbed8804e0250162b1" +
    "75ac68ffffffff01b8240000000000001600148db50eb52063ea9d98b3eac91489" +
    "a90f738986f60000000001000000",
  preimageSha256:
    "0x90d29d1021c2a1a381c0c8a39f5ffda96770e1c2ffed835f822500033841b2e3",
  sighash: "0x5d09cd07392c7163335b67eacc999491a3794c15b88e2b59094be5c5b157064b",
  witness: false,
  deposits: [],
  spentMainUtxos: [],
  movedFundsSweepRequests: [
    {
      txHash:
        "0xfb26e52365437fc4fce01864d1303e0e1ed2824ef83345ea6e85174060778acb",
      txOutputIndex: 0,
      txOutputValue: 11000,
    },
  ],
}

// Test data comes from the input at index 5 of transaction:
// https://live.blockcypher.com/btc-testnet/tx/798f9a00cb9a8fddad777cf2923d9370fb2df9b76fcf1cde827618cd7a60d34e/
export const nonWitnessSignMultipleInputsTx: FraudTestData = {
  signature: {
    v: 27,
    r: "0x70e406238e54819e9d3babb6d980f544e5545dbad00110ae8ef351887132a3ce",
    s: "0x6404df96341218d89cfbe5b8dab14edf58a7d336583373f4d1a06f64cad105f0",
  },
  preimage:
    "0x0100000006bdaf864f75dbe4490bc3acf451c291906cbb9c32c5a6b50cdc97b23f427" +
    "7890a0000000000ffffffff3c5a87fe0a5d77616623278cd25fa7b5f2602e43d4a1c17e" +
    "6a2b2fd964670def0000000000ffffffff3fd813441999ae54f62f6e5ace9b1ee2941ff" +
    "53432a3d8b4317f22c6072978c00000000000ffffffff0d43fe1d6e5e0a44838fbedb2e" +
    "b41a8f5c5f313470c3dfd7dad92bc50cc1f6170000000000ffffffffa5f90f326daa312" +
    "858eba12b225704ec668762cabffd83b2a0eeb0a0f12c77d10000000000ffffffff7a39" +
    "cc92883a8ec888c6d86a741b1bf8a51769230832e52d1395346bcab037e9000000005c1" +
    "4934b98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576a9148d" +
    "b50eb52063ea9d98b3eac91489a90f738986f68763ac6776a914e257eccafbc07c38164" +
    "2ce6e7e55120fb077fbed8804e0250162b175ac68ffffffff011cd40000000000001600" +
    "148db50eb52063ea9d98b3eac91489a90f738986f60000000001000000",
  preimageSha256:
    "0x69b912fd0ea8922db4af34145378f7e0f15d6c0eb22bf5d68ab6645819f2476c",
  sighash: "0x3a3c771a0d6e2484e1f00dca91e724b9f60a986b0c1ac4cafb9ae69a7401a573",
  witness: false,
  deposits: [
    {
      txHash:
        "0x7a39cc92883a8ec888c6d86a741b1bf8a51769230832e52d1395346bcab037e9",
      txOutputIndex: 0,
      txOutputValue: 8000,
    },
  ],
  spentMainUtxos: [],
  movedFundsSweepRequests: [],
}

// Test data comes from the (only) input of transaction:
// https://live.blockcypher.com/btc-testnet/tx/1cd5779e463eb4e3cb4b2aa93333ccc022d6d46f74e2855a6985775be98b8bba/
export const witnessSignSingleInputTx: FraudTestData = {
  signature: {
    v: 27,
    r: "0xbe367625b075362d13a46a71e91e99b633ab476d6e76870c6daaa078991e41b5",
    s: "0x041e65394627554cf832d073c47760e96ca5f3a554c01cf7b1d96d79c200202a",
  },
  preimage:
    "0x01000000bb7f55b88160c46023b4f2f5356df30e6032f0cc4ebb896462a11be4a0" +
    "1b9a523bb13029ce7b1f559ef5e747fcac439f1455a2ec7c5f09b72290795e7066" +
    "5044cbb4ac0f93b0ad4a8c387e9942a9b65ba54a01692dd1a6edc7c3b70f0355cc" +
    "ec000000005c14934b98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d" +
    "000395237576a9148db50eb52063ea9d98b3eac91489a90f738986f68763ac6776" +
    "a914e257eccafbc07c381642ce6e7e55120fb077fbed8804e0250162b175ac68f0" +
    "55000000000000fffffffff5ef547c0c70b4a4747f180b1cc244b99a3d2c12e71d" +
    "73d68ca9da53591139f10000000001000000",
  preimageSha256:
    "0xdfb4a0032c9da53e79640f404cf9e07ff0a881706d0cee6e8ff360f0371d4782",
  sighash: "0xb8994753efd78cc66075991d3a21beef96d4e8a5e9ff06bc692401203df02610",
  witness: true,
  deposits: [
    {
      txHash:
        "0xcbb4ac0f93b0ad4a8c387e9942a9b65ba54a01692dd1a6edc7c3b70f0355ccec",
      txOutputIndex: 0,
      txOutputValue: 22000,
    },
  ],
  spentMainUtxos: [],
  movedFundsSweepRequests: [],
}

// Test data comes from the input at index 4 of transaction:
// https://live.blockcypher.com/btc-testnet/tx/798f9a00cb9a8fddad777cf2923d9370fb2df9b76fcf1cde827618cd7a60d34e/
export const witnessSignMultipleInputTx: FraudTestData = {
  signature: {
    v: 28,
    r: "0x4e500227e3394f7878075b5a5fdea97a0710ec87351a62a5cc7b8853aba794b3",
    s: "0x3df12e35c70955af616db8bac4d80d3fa913a58fd5b771cd82c52a395ae81ce5",
  },
  preimage:
    "0x010000008906f824476e64e7c41517503fcc98d9cae70e76c3c507d90fd5c2434649" +
    "313794ab25a89d162fcb547d533cd20ba0fce1379a1d435825ec1484dcd8a0dd414fa5" +
    "f90f326daa312858eba12b225704ec668762cabffd83b2a0eeb0a0f12c77d100000000" +
    "1976a9148db50eb52063ea9d98b3eac91489a90f738986f688acd020000000000000ff" +
    "ffffffb72599001cf12b672a074ce9ff50fe8cb87432044fd6a5b85953ddc9abc458b9" +
    "0000000001000000",
  preimageSha256:
    "0xbf0ff823c255934b7a4ef21dfb98df0547b177a9f71caf0f1f86ae592ec47a09",
  sighash: "0xd05adb53b09ac6b1cc0a0166558f8b90d2898c9a368d40a2a033e5e0c1af9b11",
  witness: true,
  deposits: [],
  spentMainUtxos: [
    {
      txHash:
        "0xa5f90f326daa312858eba12b225704ec668762cabffd83b2a0eeb0a0f12c77d1",
      txOutputIndex: 0,
      txOutputValue: 8400,
    },
  ],
  movedFundsSweepRequests: [],
}

// Test data comes from the input at index 1 of transaction:
// https://live.blockcypher.com/btc-testnet/tx/28690a451632041443e9a5bb365c70bbd3f5c1bc6c4d9b8290873c94709cc1fe/
// Wrong sighash was used (SIGHASH_NONE | SIGHASH_ANYONECANPAY).
export const wrongSighashType: FraudTestData = {
  signature: {
    v: 27,
    r: "0x829e367e4a7212184e869ae6aca9487131c9548a4fa6be7e829a91af433c3f75",
    s: "0x616cc02ca4b894e0ef1a9e48f8468d7c1b4338ae0b992debcd1030f13fbd7adc",
  },
  preimage:
    "0x01000000000000000000000000000000000000000000000000000000000000000000000" +
    "00000000000000000000000000000000000000000000000000000000000000000f7f663bc" +
    "3e389cce42c0d0874a9e0d6390ecbb9af3eba1b3f276b83795f1b1af000000005c14934b9" +
    "8637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576a9148db50eb520" +
    "63ea9d98b3eac91489a90f738986f68763ac6776a914e257eccafbc07c381642ce6e7e551" +
    "20fb077fbed8804e0250162b175ac682823000000000000ffffffff000000000000000000" +
    "00000000000000000000000000000000000000000000000000000082000000",
  preimageSha256:
    "0x6c8afcb2efdb0313c40acb92b80a1ae9113111ce7f081877875d28c20d9fffd7",
  sighash: "0x4fd8491a872a42d20e434e838afd6e4d6d6422e035db0d41a9a11cb0596b2959",
  witness: true,
  deposits: [
    {
      txHash:
        "0xf7f663bc3e389cce42c0d0874a9e0d6390ecbb9af3eba1b3f276b83795f1b1af",
      txOutputIndex: 0,
      txOutputValue: 9000,
    },
  ],
  spentMainUtxos: [],
  movedFundsSweepRequests: [],
}
