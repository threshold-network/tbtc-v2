import {
  BitcoinSpvProof,
  BitcoinRawTx,
  BitcoinTx,
  BitcoinTxHash,
  BitcoinTxMerkleBranch,
  Hex,
} from "../../src"
import { BigNumber } from "@ethersproject/bignumber"

/**
 * Represents a set of data used for given proof scenario.
 */
export interface ProofTestData {
  requiredConfirmations: number
  bitcoinChainData: {
    transaction: BitcoinTx
    rawTransaction: BitcoinRawTx
    accumulatedTxConfirmations: number
    latestBlockHeight: number
    headersChain: Hex
    transactionMerkleBranch: BitcoinTxMerkleBranch
    coinbaseRawTransaction: BitcoinRawTx
    coinbaseMerkleBranch: BitcoinTxMerkleBranch
  }
  expectedProof: BitcoinSpvProof & BitcoinTx
}

/**
 * Test data that is based on a Bitcoin testnet transaction with a single input
 * https://live.blockcypher.com/btc-testnet/tx/44c568bc0eac07a2a9c2b46829be5b5d46e7d00e17bfb613f506a75ccf86a473/
 */
export const singleInputProofTestData: ProofTestData = {
  requiredConfirmations: 6,
  bitcoinChainData: {
    transaction: {
      transactionHash: BitcoinTxHash.from(
        "44c568bc0eac07a2a9c2b46829be5b5d46e7d00e17bfb613f506a75ccf86a473"
      ),
      inputs: [
        {
          transactionHash: BitcoinTxHash.from(
            "8ee67b585eeb682bf6907ea311282540ee53edf605e0f09757226a4dc3e72a67"
          ),
          outputIndex: 0,
          scriptSig: Hex.from(""),
        },
      ],
      outputs: [
        {
          outputIndex: 0,
          value: BigNumber.from(8400),
          scriptPubKey: Hex.from(
            "00148db50eb52063ea9d98b3eac91489a90f738986f6"
          ),
        },
      ],
    },
    rawTransaction: {
      transactionHex:
        "01000000000101672ae7c34d6a225797f0e005f6ed53ee40252811a37e90f62b" +
        "68eb5e587be68e0000000000ffffffff01d0200000000000001600148db50eb5" +
        "2063ea9d98b3eac91489a90f738986f603483045022100b12afadf68ad978160" +
        "0f065e0b09e22058ca2293aa86ac38add3ca7cfb01b3b7022009ecce0c1c3ebd" +
        "26569c6b0d60e15b4675860737487d1b7c782439acf4709bdf012103989d253b" +
        "17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d95c14934b" +
        "98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576a914" +
        "8db50eb52063ea9d98b3eac91489a90f738986f68763ac6776a914e257eccafb" +
        "c07c381642ce6e7e55120fb077fbed8804e0250162b175ac6800000000",
    },
    accumulatedTxConfirmations: 50,
    latestBlockHeight: 2164335,
    headersChain: Hex.from(
      "04e00020732d33ea35d62f9488cff5d64c0d702afd5d88092230ddfcc45f00000" +
        "0000000196283ba24a3f5bad91ef95338aa6d214c934f2c1392e39a0447377fe5" +
        "b0a04be7c01c62ffff001df0be0a27040000206c318b23e5c42e86ef3edd080e5" +
        "0c9c233b9f0b6d186bd57e41300000000000021fb8cda200bff4fec1338d85a1e" +
        "005bb4d729d908a7c5c232ecd0713231d0445ec11c62ed3e031a7b43466e04e00" +
        "020f416898d79d4a46fa6c54f190ad3d502bad8aa3afdec0714aa000000000000" +
        "000603a5cc15e5906cb4eac9f747869fdc9be856e76a110b4f87da90db20f9fbe" +
        "28fc11c62ed3e031a15dfc3db04000020642125b3910fdaead521b57955e28893" +
        "d89f8ce7fd3ba1dd6d01000000000000f9e17a266a2267ee02d5ab82a75a76805" +
        "db821a13abd2e80e0950d883311e5355dc21c62ed3e031adefc02c4040000205b" +
        "6de55e069be71b21a62cd140dc7031225f7258dc758f19ea01000000000000139" +
        "966d27d9ed0c0c1ed9162c2fea2ccf0ba212706f6bc421d0a2b6211de040d1ac4" +
        "1c62ed3e031a4726538f04e000208475e15e0314635d32abf04c761fee528d6a3" +
        "f2db3b3d13798000000000000002a3fa06fecd9dd4bf2e25e22a95d4f65435d5c" +
        "5b42bcf498b4e756f9f4ea67cea1c51c62ed3e031a9d7bf3ac000000203f16d45" +
        "0c51853a4cd9569d225028aa08ab6139eee31f4f67a010000000000004cda79bc" +
        "48b970de2fb29c3f38626eb9d70d8bae7b92aad09f2a0ad2d2f334d35bca1c62f" +
        "fff001d048fc217"
    ),
    transactionMerkleBranch: {
      blockHeight: 2164152,
      merkle: [
        Hex.from(
          "7bffaff2c61291861276da41cf6c3842fad555af97dd1ff98ce41c61a0072b12"
        ),
        Hex.from(
          "7a5876ddee8e553ff0650c739b2ec66e192d8afe5fc0ce763bf810457aea330c"
        ),
        Hex.from(
          "2d17b67d5519bc39fbef8650afd3fe11fdfb3f471434a5b551cfa9a41441901f"
        ),
        Hex.from(
          "1376d102b677591ce2fa62553e2a57ab5919022b03036521facfce93a0338026"
        ),
        Hex.from(
          "43ad3aadad675e398c59eb846a8e037cf7de8ba3b38f3388175f25d84b777c80"
        ),
        Hex.from(
          "6969c227128793b3c9e99c05f20fb9b91fdb73458fd53151b5fe29d30c10cf9a"
        ),
        Hex.from(
          "0a76bc4d8c3d532357be4d188ba89e9ae364a7d3c365e690e3cb07359b86129c"
        ),
      ],
      position: 11,
    },
    coinbaseRawTransaction: {
      transactionHex:
        "02000000000101000000000000000000000000000000000000000000000000000" +
        "0000000000000ffffffff4803b8052104e0c01c62425443506f6f6cfabe6d6d56" +
        "06828fa0322cc81efd5fdbf7f100c7a8497e88dbc102097b30e08f13465bd9040" +
        "000000d6531d503040db19f2e020000000000ffffffff0297814e000000000017" +
        "a9147bef0b4a4dafa77b2ec52b81659cbcf0d9a91487870000000000000000266" +
        "a24aa21a9ed4a673a4a13930bcc67727968c29960bf8ba07b218ff3811edf3ef3" +
        "cc196707880120000000000000000000000000000000000000000000000000000" +
        "000000000000000000000",
    },
    coinbaseMerkleBranch: {
      blockHeight: 2164152,
      merkle: [
        Hex.from(
          "095b539f725018c6afd940281d22f523ae74f9b07fe685b4f3decf130a6e3d7a"
        ),
        Hex.from(
          "ad6a634865b1e61051b6ecf819d98110db0cf5747eaf2205fe9e82db47318b95"
        ),
        Hex.from(
          "0c99d031690fa507e27c4068516c752297ea7df9a5b7482bfc0c44705c059024"
        ),
        Hex.from(
          "352a81a4e75ea8c39060a6a383a4bd19245d86cf38918d9d49cafd4e54dfba7e"
        ),
        Hex.from(
          "43ad3aadad675e398c59eb846a8e037cf7de8ba3b38f3388175f25d84b777c80"
        ),
        Hex.from(
          "6969c227128793b3c9e99c05f20fb9b91fdb73458fd53151b5fe29d30c10cf9a"
        ),
        Hex.from(
          "0a76bc4d8c3d532357be4d188ba89e9ae364a7d3c365e690e3cb07359b86129c"
        ),
      ],
      position: 0,
    },
  },
  expectedProof: {
    transactionHash: BitcoinTxHash.from(
      "44c568bc0eac07a2a9c2b46829be5b5d46e7d00e17bfb613f506a75ccf86a473"
    ),
    inputs: [
      {
        transactionHash: BitcoinTxHash.from(
          "8ee67b585eeb682bf6907ea311282540ee53edf605e0f09757226a4dc3e72a67"
        ),
        outputIndex: 0,
        scriptSig: Hex.from(""),
      },
    ],
    outputs: [
      {
        outputIndex: 0,
        value: BigNumber.from(8400),
        scriptPubKey: Hex.from("00148db50eb52063ea9d98b3eac91489a90f738986f6"),
      },
    ],
    merkleProof: Hex.from(
      "122b07a0611ce48cf91fdd97af55d5fa42386ccf41da7612869112c6f2afff7b0c" +
        "33ea7a4510f83b76cec05ffe8a2d196ec62e9b730c65f03f558eeedd76587a1f90" +
        "4114a4a9cf51b5a53414473ffbfd11fed3af5086effb39bc19557db6172d268033" +
        "a093cecffa216503032b021959ab572a3e5562fae21c5977b602d17613807c774b" +
        "d8255f1788338fb3a38bdef77c038e6a84eb598c395e67adad3aad439acf100cd3" +
        "29feb55131d58f4573db1fb9b90ff2059ce9c9b393871227c269699c12869b3507" +
        "cbe390e665c3d3a764e39a9ea88b184dbe5723533d8c4dbc760a"
    ),
    txIndexInBlock: 11,
    bitcoinHeaders: Hex.from(
      "04e00020732d33ea35d62f9488cff5d64c0d702afd5d88092230ddfcc45f000000" +
        "000000196283ba24a3f5bad91ef95338aa6d214c934f2c1392e39a0447377fe5b0" +
        "a04be7c01c62ffff001df0be0a27040000206c318b23e5c42e86ef3edd080e50c9" +
        "c233b9f0b6d186bd57e41300000000000021fb8cda200bff4fec1338d85a1e005b" +
        "b4d729d908a7c5c232ecd0713231d0445ec11c62ed3e031a7b43466e04e00020f4" +
        "16898d79d4a46fa6c54f190ad3d502bad8aa3afdec0714aa000000000000000603" +
        "a5cc15e5906cb4eac9f747869fdc9be856e76a110b4f87da90db20f9fbe28fc11c" +
        "62ed3e031a15dfc3db04000020642125b3910fdaead521b57955e28893d89f8ce7" +
        "fd3ba1dd6d01000000000000f9e17a266a2267ee02d5ab82a75a76805db821a13a" +
        "bd2e80e0950d883311e5355dc21c62ed3e031adefc02c4040000205b6de55e069b" +
        "e71b21a62cd140dc7031225f7258dc758f19ea01000000000000139966d27d9ed0" +
        "c0c1ed9162c2fea2ccf0ba212706f6bc421d0a2b6211de040d1ac41c62ed3e031a" +
        "4726538f04e000208475e15e0314635d32abf04c761fee528d6a3f2db3b3d13798" +
        "000000000000002a3fa06fecd9dd4bf2e25e22a95d4f65435d5c5b42bcf498b4e7" +
        "56f9f4ea67cea1c51c62ed3e031a9d7bf3ac000000203f16d450c51853a4cd9569" +
        "d225028aa08ab6139eee31f4f67a010000000000004cda79bc48b970de2fb29c3f" +
        "38626eb9d70d8bae7b92aad09f2a0ad2d2f334d35bca1c62ffff001d048fc217"
    ),
    coinbasePreimage: Hex.from(
      "8e690235847a80c4d300542a2d27b90bfd13d77b3421c1b5590f4220718cd3fd"
    ),
    coinbaseProof: Hex.from(
      "7a3d6e0a13cfdef3b485e67fb0f974ae23f5221d2840d9afc61850729f535b0995" +
        "8b3147db829efe0522af7e74f50cdb1081d919f8ecb65110e6b16548636aad2490" +
        "055c70440cfc2b48b7a5f97dea9722756c5168407ce207a50f6931d0990c7ebadf" +
        "544efdca499d8d9138cf865d2419bda483a3a66090c3a85ee7a4812a35807c774b" +
        "d8255f1788338fb3a38bdef77c038e6a84eb598c395e67adad3aad439acf100cd3" +
        "29feb55131d58f4573db1fb9b90ff2059ce9c9b393871227c269699c12869b3507" +
        "cbe390e665c3d3a764e39a9ea88b184dbe5723533d8c4dbc760a"
    ),
  },
}

/**
 * Test data that is based on a Bitcoin testnet transaction with multiple inputs
 * https://live.blockcypher.com/btc-testnet/tx/5083822ed0b8d0bc661362b778e666cb572ff6d5152193992dd69d3207995753/
 */
export const multipleInputsProofTestData: ProofTestData = {
  requiredConfirmations: 6,

  bitcoinChainData: {
    transaction: {
      transactionHash: BitcoinTxHash.from(
        "5083822ed0b8d0bc661362b778e666cb572ff6d5152193992dd69d3207995753"
      ),
      inputs: [
        {
          transactionHash: BitcoinTxHash.from(
            "ea4d9e45f8c1b8a187c007f36ba1e9b201e8511182c7083c4edcaf9325b2998f"
          ),
          outputIndex: 0,
          scriptSig: Hex.from(""),
        },
        {
          transactionHash: BitcoinTxHash.from(
            "c844ff4c1781c884bb5e80392398b81b984d7106367ae16675f132bd1a7f33fd"
          ),
          outputIndex: 0,
          scriptSig: Hex.from(""),
        },
        {
          transactionHash: BitcoinTxHash.from(
            "44c568bc0eac07a2a9c2b46829be5b5d46e7d00e17bfb613f506a75ccf86a473"
          ),
          outputIndex: 0,
          scriptSig: Hex.from(""),
        },
        {
          transactionHash: BitcoinTxHash.from(
            "f548c00e464764e112826450a00cf005ca771a6108a629b559b6c60a519e4378"
          ),
          outputIndex: 0,
          scriptSig: Hex.from(""),
        },
      ],
      outputs: [
        {
          outputIndex: 0,
          value: BigNumber.from(39800),
          scriptPubKey: Hex.from(
            "00148db50eb52063ea9d98b3eac91489a90f738986f6"
          ),
        },
      ],
    },
    accumulatedTxConfirmations: 50,
    rawTransaction: {
      transactionHex:
        "010000000001048f99b22593afdc4e3c08c7821151e801b2e9a16bf307c087a1" +
        "b8c1f8459e4dea00000000c9483045022100bb54f2717647b2f2c5370b5f12b5" +
        "5e27f97a6e2009dcd21fca08527df949e1fd022058bc3cd1dd739b89b9e4cda4" +
        "3b13bc59cfb15663b80cbfa3edb4539107bba35d012103989d253b17a6a0f418" +
        "38b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d94c5c14934b98637ca3" +
        "18a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576a9148db50eb5" +
        "2063ea9d98b3eac91489a90f738986f68763ac6776a914e257eccafbc07c3816" +
        "42ce6e7e55120fb077fbed8804e0250162b175ac68fffffffffd337f1abd32f1" +
        "7566e17a3606714d981bb8982339805ebb84c881174cff44c80000000000ffff" +
        "ffff73a486cf5ca706f513b6bf170ed0e7465d5bbe2968b4c2a9a207ac0ebc68" +
        "c5440000000000ffffffff78439e510ac6b659b529a608611a77ca05f00ca050" +
        "648212e16447460ec048f50000000000ffffffff01789b000000000000160014" +
        "8db50eb52063ea9d98b3eac91489a90f738986f6000347304402205199b28a3b" +
        "4a81579fe4ea99925380b298e28ca38a3b14e50f12daec87945449022065c503" +
        "4f96ed785aa10b3817c501ecc59f1abf329fad07229170c3dd5f53bc91012103" +
        "989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9" +
        "5c14934b98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d00039523" +
        "7576a9148db50eb52063ea9d98b3eac91489a90f738986f68763ac6776a914e2" +
        "57eccafbc07c381642ce6e7e55120fb077fbed8804e0250162b175ac68024730" +
        "4402201b2a3b03a1088c6bbc406e96a6017e52ce86c0897541c9bb59d94179da" +
        "a84f8702204b1e665bd43bbe968e1d89b15c5f0b5551011fa4caf2fbb7eb22d8" +
        "9a38fad04d012103989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564" +
        "da4cc29dcf8581d903473044022007ce54f21a2f5233bd046c4600bcb1c874aa" +
        "f9053b1d7ee7d47eb134b695fbed022002e8684548b7a3cdaecb8c6393244c39" +
        "6c15e1ebaedb53e2fcc6c5cea7310490012103989d253b17a6a0f41838b84ff0" +
        "d20e8898f9d7b1a98f2564da4cc29dcf8581d95c14934b98637ca318a4d6e7ca" +
        "6ffd1690b8e77df6377508f9f0c90d000395237576a9148db50eb52063ea9d98" +
        "b3eac91489a90f738986f68763ac6776a914e257eccafbc07c381642ce6e7e55" +
        "120fb077fbed8804e0250162b175ac6800000000",
    },
    latestBlockHeight: 2164335,
    headersChain: Hex.from(
      "04000020642125b3910fdaead521b57955e28893d89f8ce7fd3ba1dd6d0100000" +
        "0000000f9e17a266a2267ee02d5ab82a75a76805db821a13abd2e80e0950d8833" +
        "11e5355dc21c62ed3e031adefc02c4040000205b6de55e069be71b21a62cd140d" +
        "c7031225f7258dc758f19ea01000000000000139966d27d9ed0c0c1ed9162c2fe" +
        "a2ccf0ba212706f6bc421d0a2b6211de040d1ac41c62ed3e031a4726538f04e00" +
        "0208475e15e0314635d32abf04c761fee528d6a3f2db3b3d13798000000000000" +
        "002a3fa06fecd9dd4bf2e25e22a95d4f65435d5c5b42bcf498b4e756f9f4ea67c" +
        "ea1c51c62ed3e031a9d7bf3ac000000203f16d450c51853a4cd9569d225028aa0" +
        "8ab6139eee31f4f67a010000000000004cda79bc48b970de2fb29c3f38626eb9d" +
        "70d8bae7b92aad09f2a0ad2d2f334d35bca1c62ffff001d048fc2170000002068" +
        "7e487acbf5eb375c631a15127fbf7d80ca084461e7f26f92c509b6000000006fa" +
        "d33bd7c8d651bd6dc86c286f0a99340b668f019b9e97a59fd392c36c4f46910cf" +
        "1c62ffff001d407facaa0400002040f4c65610f26f06c4365305b956934501713" +
        "e01c2fc08b919e0bc1b00000000e401a6a884ba015e83c6fe2cd363e877ef0398" +
        "2e81eaff4e2c95af1e23a670f407d41c62ffff001d58c64d180400002038854bd" +
        "62f802e1de14653eceeb7a80290f5e99b8e9db517e36f000000000000a494b803" +
        "4039e7855b75563ab83c9410dd67e89bb58e6cd93b85290a885dd749f4d61c62e" +
        "d3e031ad9a83746"
    ),
    transactionMerkleBranch: {
      blockHeight: 2164155,
      merkle: [
        Hex.from(
          "322cfdf3ca53cf597b6f08e93489b9a1cfa1f5958c3657474b0d8f5efb5ca92e"
        ),
        Hex.from(
          "82aedffef6c9670375effee25740fecce143d21f8abf98307235b7ebd31ad4d1"
        ),
        Hex.from(
          "837fa041b9a8f5b42353fdf8981e3b7a78c61858852e43058bfe6cacf9eab5a3"
        ),
        Hex.from(
          "a51612d3f3f857e95803a4d86aa6dbbe2e756dc2ed6cc0e04630e8baf597e377"
        ),
        Hex.from(
          "a00501650e0c4f8a1e07a5d6d5bc5e75e4c75de61a65f0410cce354bbae78686"
        ),
      ],
      position: 6,
    },
    coinbaseRawTransaction: {
      transactionHex:
        "02000000000101000000000000000000000000000000000000000000000000000" +
        "0000000000000ffffffff4803bb05210445c21c62425443506f6f6cfabe6d6d97" +
        "92ca7580b0dccdb4465ab26f697e165c536838032a466ef25b25bb7bebb3ae040" +
        "000000d6531d503040db15755000000000000ffffffff0212304d000000000017" +
        "a9147bef0b4a4dafa77b2ec52b81659cbcf0d9a91487870000000000000000266" +
        "a24aa21a9ed8a716e1e3e8691cfc14df968505d88fae2e240b7f4ca4d59871992" +
        "a63c9900640120000000000000000000000000000000000000000000000000000" +
        "000000000000000000000",
    },
    coinbaseMerkleBranch: {
      blockHeight: 2164155,
      merkle: [
        Hex.from(
          "d654db76daa53b61becba19a542c6156a725d0bce3d0f3a57d713c9a9498ab95"
        ),
        Hex.from(
          "df2a8c9cded17679ecacc119d92bfa5dc795bb80284e320e80e4f9f93d0e5ba4"
        ),
        Hex.from(
          "b7d63f60c09609472aa68fbb6380cffc87b4d921a26edc8b2626154145d603be"
        ),
        Hex.from(
          "a51612d3f3f857e95803a4d86aa6dbbe2e756dc2ed6cc0e04630e8baf597e377"
        ),
        Hex.from(
          "a00501650e0c4f8a1e07a5d6d5bc5e75e4c75de61a65f0410cce354bbae78686"
        ),
      ],
      position: 0,
    },
  },
  expectedProof: {
    transactionHash: BitcoinTxHash.from(
      "5083822ed0b8d0bc661362b778e666cb572ff6d5152193992dd69d3207995753"
    ),
    inputs: [
      {
        transactionHash: BitcoinTxHash.from(
          "ea4d9e45f8c1b8a187c007f36ba1e9b201e8511182c7083c4edcaf9325b2998f"
        ),
        outputIndex: 0,
        scriptSig: Hex.from(""),
      },
      {
        transactionHash: BitcoinTxHash.from(
          "c844ff4c1781c884bb5e80392398b81b984d7106367ae16675f132bd1a7f33fd"
        ),
        outputIndex: 0,
        scriptSig: Hex.from(""),
      },
      {
        transactionHash: BitcoinTxHash.from(
          "44c568bc0eac07a2a9c2b46829be5b5d46e7d00e17bfb613f506a75ccf86a473"
        ),
        outputIndex: 0,
        scriptSig: Hex.from(""),
      },
      {
        transactionHash: BitcoinTxHash.from(
          "f548c00e464764e112826450a00cf005ca771a6108a629b559b6c60a519e4378"
        ),
        outputIndex: 0,
        scriptSig: Hex.from(""),
      },
    ],
    outputs: [
      {
        outputIndex: 0,
        value: BigNumber.from(39800),
        scriptPubKey: Hex.from("00148db50eb52063ea9d98b3eac91489a90f738986f6"),
      },
    ],
    merkleProof: Hex.from(
      "2ea95cfb5e8f0d4b4757368c95f5a1cfa1b98934e9086f7b59cf53caf3fd2c32d1d" +
        "41ad3ebb735723098bf8a1fd243e1ccfe4057e2feef750367c9f6fedfae82a3b5ea" +
        "f9ac6cfe8b05432e855818c6787a3b1e98f8fd5323b4f5a8b941a07f8377e397f5b" +
        "ae83046e0c06cedc26d752ebedba66ad8a40358e957f8f3d31216a58686e7ba4b35" +
        "ce0c41f0651ae65dc7e4755ebcd5d6a5071e8a4f0c0e650105a0"
    ),
    txIndexInBlock: 6,
    bitcoinHeaders: Hex.from(
      "04000020642125b3910fdaead521b57955e28893d89f8ce7fd3ba1dd6d010000000" +
        "00000f9e17a266a2267ee02d5ab82a75a76805db821a13abd2e80e0950d883311e5" +
        "355dc21c62ed3e031adefc02c4040000205b6de55e069be71b21a62cd140dc70312" +
        "25f7258dc758f19ea01000000000000139966d27d9ed0c0c1ed9162c2fea2ccf0ba" +
        "212706f6bc421d0a2b6211de040d1ac41c62ed3e031a4726538f04e000208475e15" +
        "e0314635d32abf04c761fee528d6a3f2db3b3d13798000000000000002a3fa06fec" +
        "d9dd4bf2e25e22a95d4f65435d5c5b42bcf498b4e756f9f4ea67cea1c51c62ed3e0" +
        "31a9d7bf3ac000000203f16d450c51853a4cd9569d225028aa08ab6139eee31f4f6" +
        "7a010000000000004cda79bc48b970de2fb29c3f38626eb9d70d8bae7b92aad09f2" +
        "a0ad2d2f334d35bca1c62ffff001d048fc21700000020687e487acbf5eb375c631a" +
        "15127fbf7d80ca084461e7f26f92c509b6000000006fad33bd7c8d651bd6dc86c28" +
        "6f0a99340b668f019b9e97a59fd392c36c4f46910cf1c62ffff001d407facaa0400" +
        "002040f4c65610f26f06c4365305b956934501713e01c2fc08b919e0bc1b0000000" +
        "0e401a6a884ba015e83c6fe2cd363e877ef03982e81eaff4e2c95af1e23a670f407" +
        "d41c62ffff001d58c64d180400002038854bd62f802e1de14653eceeb7a80290f5e" +
        "99b8e9db517e36f000000000000a494b8034039e7855b75563ab83c9410dd67e89b" +
        "b58e6cd93b85290a885dd749f4d61c62ed3e031ad9a83746"
    ),
    coinbasePreimage: Hex.from(
      "0248a67dec36c38a485ad920afd89dcf082e7e570390380890e3a9465662f449"
    ),
    coinbaseProof: Hex.from(
      "95ab98949a3c717da5f3d0e3bcd025a756612c549aa1cbbe613ba5da76db54d6a45" +
        "b0e3df9f9e4800e324e2880bb95c75dfa2bd919c1acec7976d1de9c8c2adfbe03d6" +
        "45411526268bdc6ea221d9b487fccf8063bb8fa62a470996c0603fd6b777e397f5b" +
        "ae83046e0c06cedc26d752ebedba66ad8a40358e957f8f3d31216a58686e7ba4b35" +
        "ce0c41f0651ae65dc7e4755ebcd5d6a5071e8a4f0c0e650105a0"
    ),
  },
}

/**
 * Represents a set of data used for given transaction proof validation scenario.
 */
export interface TransactionProofData {
  requiredConfirmations: number
  bitcoinChainData: {
    transaction: BitcoinTx
    accumulatedTxConfirmations: number
    latestBlockHeight: number
    headersChain: Hex
    transactionMerkleBranch: BitcoinTxMerkleBranch
    coinbaseRawTransaction: BitcoinRawTx
    coinbaseMerkleBranch: BitcoinTxMerkleBranch
    previousDifficulty: BigNumber
    currentDifficulty: BigNumber
  }
}

/**
 * Test data that is based on a random Bitcoin mainnet transaction with all the
 * blocks headers from one difficulty epoch
 * https://live.blockcypher.com/btc/tx/713525ee9d9ab23433cd6ad470566ba1f47cac2d7f119cc50119128a84d718aa/
 */
export const transactionConfirmationsInOneEpochData: TransactionProofData = {
  requiredConfirmations: 6,
  bitcoinChainData: {
    transaction: {
      transactionHash: BitcoinTxHash.from(
        "713525ee9d9ab23433cd6ad470566ba1f47cac2d7f119cc50119128a84d718aa"
      ),
      inputs: [
        {
          transactionHash: BitcoinTxHash.from(
            "91b83d443f32d5a1e87a200eac5d3501af0f156bef3a59d5e8805b4679c4a2a5"
          ),
          outputIndex: 3,
          scriptSig: Hex.from(
            "473044022008bfea0e9b8e24b0ab04de42db2dd8aea9e6f764f9f94aa88e284d" +
              "5c2800706d02200d793f7441ea17802da993914da732e2f4e354e54dd168636b" +
              "e73e6b60a39eab012103e356007964fc225a44c38352899c41e6293a97f8d811" +
              "5998ae7e97184704c092"
          ),
        },
      ],
      outputs: [
        {
          outputIndex: 0,
          value: BigNumber.from(5500),
          scriptPubKey: Hex.from(
            "6a4c5058325b63f33166b9786bdd34b2be8160d5e4fbef9a0a45e773c4201a82" +
              "a4b1eb44793a61d19892a7f8aede51b70953a210e9e8dba54375e4a06d95d68f" +
              "90aa3c6e8914000bd7e50056000bd775012528"
          ),
        },
        {
          outputIndex: 1,
          value: BigNumber.from(48850),
          scriptPubKey: Hex.from(
            "76a914953490146c3ae270d66e09c4d12df4573d24c75b88ac"
          ),
        },
        {
          outputIndex: 2,
          value: BigNumber.from(48850),
          scriptPubKey: Hex.from(
            "a914352481ec2fecfde0c5cdc635a383c4ac27b9f71e87"
          ),
        },
        {
          outputIndex: 3,
          value: BigNumber.from(12614691),
          scriptPubKey: Hex.from(
            "76a914b00de0cc7b5e518f7d1e43d6e5ecbd52e0cd0c2f88ac"
          ),
        },
      ],
    },
    accumulatedTxConfirmations: 1798,
    latestBlockHeight: 777963,
    headersChain: Hex.from(
      "00e0ff2f5ad9c09e1d8aae777a58bf29c41621eb629032598f7900000000000000000" +
        "0004dea17724c3b7e67d4cf1ac41a4c7527b884f7406575eaf5b8efaf2fb12572ecb1" +
        "ace86339300717760098100000ff3fd3ab40174610c286e569edd20fa713bd98bab53" +
        "bee83050000000000000000002345f5ef807cf75de7b30ccfe493c46c6e07aca044aa" +
        "2aa106141637f1bb8500a6ade863393007177fbbd4b300800120646d493817f0ac988" +
        "6a0a194ca3a957f70c3eb642ffd05000000000000000000d95674b737f097f042eebe" +
        "b970c09b274df7e72a9c202ff2292ed72b056ee90967aee863393007172e2bb92e006" +
        "03b27a391d248c258ef628dfb8c710ce44c8017667a07941402000000000000000000" +
        "35214e58eb018dea1efa7eaf1b7f19ff2d6f0310c122be6dc8c0258d9524ae9382aee" +
        "863393007173e82b2000000002003c7003ff9a79f16d956fc764b43b35080efe3a820" +
        "af050000000000000000007808e96809cd46d5898d86faabc8f28a8b6572eb8399796" +
        "70b2851d78fc1f75f17b3e86339300717450f17650400e020fb9b6a28bb2e9cea36d3" +
        "40588f19ffa4e944b050e73f03000000000000000000bbd7534f2550ee99f31efcd77" +
        "564f1b5b3f3966a76847896a8d9f9ee964d670ba2b4e8633930071777b10cfc"
    ),
    transactionMerkleBranch: {
      blockHeight: 776166,
      merkle: [
        Hex.from(
          "f6ce0e34cc5b2a4b8cd4fd02a65d7cf62013206969e8e5cf1df18f994abcf1ff"
        ),
        Hex.from(
          "08899ec43299b324583722f3e7d0938446a1f31a6ab34c8e24cb4ea9ba6cd384"
        ),
        Hex.from(
          "9677b6075dfa2da8bcc98aa10ae7d30f81e6506215eadd3f3739a5d987e62b35"
        ),
        Hex.from(
          "aa6712d8820c06ec8ce99f9c19d580ab54bb45f69b426935153b81e7d412ddba"
        ),
        Hex.from(
          "b38be47e1dd9a7324ad81a395a133f26fc88cb736a4998dbba6cbabca10629a8"
        ),
        Hex.from(
          "13bdefbf92421aa7861528e16e7046b569d25ee0f4b7649492e42e9ea2331c39"
        ),
        Hex.from(
          "df429494c5eef971a7ab80c8a0f7f9cdfa30148afef706f07923bd93d5a7e22a"
        ),
        Hex.from(
          "c8a3f1bc73146bd4a1a0e848f2b0b4a21be86e4930f239d856af8e9646014236"
        ),
        Hex.from(
          "1f514df87fe2c400e508e01cd8967657ef76db9681f65dc82b0bc6d4004b575f"
        ),
        Hex.from(
          "e463950c8efd9114237189f07ddf1cfdb72658bad23bce667c269652bd0ade3c"
        ),
        Hex.from(
          "3d7ae6df787807320fdc397a7055e86c932a7c36ab1d1f942b92c53bf2a1d2f9"
        ),
      ],
      position: 17,
    },
    coinbaseRawTransaction: {
      transactionHex:
        "010000000001010000000000000000000000000000000000000000000000000000000" +
        "000000000ffffffff6003e6d70b192f5669614254432f4d696e656420627920736368" +
        "756c747a2f2cfabe6d6dcb674c098d80e8456c9cebe631a3ae9ec16e47185c0684b0c" +
        "2fbab45827d4b79100000000000000010548e591b518d91e94608772cd43615000000" +
        "0000ffffffff0290519d25000000001976a914536ffa992491508dca0354e52f32a3a" +
        "7a679a53a88ac0000000000000000266a24aa21a9edca238b73df37d6eba6f22606c9" +
        "38f46786f95c861e96acf85fdc6b61d4b3ecc10120000000000000000000000000000" +
        "000000000000000000000000000000000000000000000",
    },
    coinbaseMerkleBranch: {
      blockHeight: 776166,
      merkle: [
        Hex.from(
          "438e7c04ee74dd2e79ffd3ace87c45a7b275e3f95783954ba321081e3f92fe99"
        ),
        Hex.from(
          "02c8dcc4cb7b50857853ff31610700cd538e435002a433b318f4efc976912002"
        ),
        Hex.from(
          "43e1894ff1469105951c529a622370460b666c722c84d05d73712e5af84bfd09"
        ),
        Hex.from(
          "bdd6e6d69540a45185b4ad6dbfd108b7dfebc4d6ae7030d2d3bd139e9b2c1e28"
        ),
        Hex.from(
          "cffed70dd62cab291f132fb90c5d6cd11af589db122df862585c6dd43c667d4f"
        ),
        Hex.from(
          "13bdefbf92421aa7861528e16e7046b569d25ee0f4b7649492e42e9ea2331c39"
        ),
        Hex.from(
          "df429494c5eef971a7ab80c8a0f7f9cdfa30148afef706f07923bd93d5a7e22a"
        ),
        Hex.from(
          "c8a3f1bc73146bd4a1a0e848f2b0b4a21be86e4930f239d856af8e9646014236"
        ),
        Hex.from(
          "1f514df87fe2c400e508e01cd8967657ef76db9681f65dc82b0bc6d4004b575f"
        ),
        Hex.from(
          "e463950c8efd9114237189f07ddf1cfdb72658bad23bce667c269652bd0ade3c"
        ),
        Hex.from(
          "3d7ae6df787807320fdc397a7055e86c932a7c36ab1d1f942b92c53bf2a1d2f9"
        ),
      ],
      position: 0,
    },
    previousDifficulty: BigNumber.from(39156400059293),
    currentDifficulty: BigNumber.from(39350942467772),
  },
}

/**
 * Test data that is based on a random Bitcoin mainnet transaction with the
 * blocks headers spanning two difficulty epochs
 * https://live.blockcypher.com/btc/tx/e073636400e132b8c1082133ab2b48866919153998f4f04877b580e9932d5a17/
 */
export const transactionConfirmationsInTwoEpochsData: TransactionProofData = {
  requiredConfirmations: 6,
  bitcoinChainData: {
    transaction: {
      transactionHash: BitcoinTxHash.from(
        "e073636400e132b8c1082133ab2b48866919153998f4f04877b580e9932d5a17"
      ),
      inputs: [
        {
          transactionHash: BitcoinTxHash.from(
            "f160a6565d07fd2e8f1d0aaaff538f3150b7f9d2bc64f191076f45c92725b990"
          ),
          outputIndex: 0,
          scriptSig: Hex.from(""),
        },
      ],
      outputs: [
        {
          outputIndex: 0,
          value: BigNumber.from(38385795),
          scriptPubKey: Hex.from(
            "00145ade2be870b440e171644f22973db748a2002305"
          ),
        },
        {
          outputIndex: 1,
          value: BigNumber.from(2181468),
          scriptPubKey: Hex.from(
            "76a914dbdbe7f1c2ba3dfe38c32b9261f5d8fcb36b689788ac"
          ),
        },
      ],
    },
    accumulatedTxConfirmations: 3838,
    latestBlockHeight: 777979,
    headersChain: Hex.from(
      "0040f224871a401b605e02c475e05e147bd418e5e2ae9eb599e200000000000000000" +
        "000193dc07aea4388a163ed0e3e5234ef54594cfc046bce727d2d6b3445d3ce0e8c44" +
        "0dd663e27c07170c0d54de00e0682c9c27df3b2a1b011753c986c290ce22c60d09a05" +
        "3707100000000000000000000ddf3b023ed6368bdac8578bd55d0c3fad7f234ae971b" +
        "902b155bee7318bf0919b30dd663e27c0717be025f2b00000020514a9bd87c51caedd" +
        "45a20c495f0ba1983b6f3f51639050000000000000000001f4c60a97f4127b4f90fbb" +
        "7a6a1041881b10d4f7351340b6770301f62b36725ce10dd66320270717c11c5e7b002" +
        "0002043e99cc906d52209796ecb37b252e4514f197d727ea701000000000000000000" +
        "274ecaf37779be81c23748d33ef4a0cad36a8abd935a11f0e0a71640c6dd1deaf10dd" +
        "66320270717846927aa0000c02090a4a88ab1ad55e235932fe0adc7b4c822b4322f58" +
        "9305000000000000000000decc945dc9cdf595715ffeee3bffc0ec0c8c5ff77e43b8e" +
        "91213e21a9975c99ddc10d663202707179f93251000203229e618c1eb9274a1acbb74" +
        "d44bfe9a4ecfae236ea35e8b0300000000000000000029a9f7b4f6671dec5d6ba05ac" +
        "b060fcd2ffc6e46a992189c6f60d770d9c5a5cda31cd66320270717542691a2"
    ),
    transactionMerkleBranch: {
      blockHeight: 774142,
      merkle: [
        Hex.from(
          "e80f706f53d5abd77070ea6c8a60c141748400e09fc9b373d5cdb0129cbce5ec"
        ),
        Hex.from(
          "20d22506199cf00caf2e32e240c77a23c226d5a74de4dc9150ccd6f5200b4dd7"
        ),
        Hex.from(
          "8b446693fadaae7479725f0e98430c24f8bf8936f5a5cab7c725692cd78e61e3"
        ),
        Hex.from(
          "93e61f1ac82cf6a66e321c60410ae4bdfcc0ab45b7efd50353d7b08104758403"
        ),
        Hex.from(
          "1dc52561092701978f1e48a10bc4da5464e668f0f4b3a940853c941474ee52de"
        ),
        Hex.from(
          "84aca5ec5b339b69a50b93d35c2fd7b146c037842ca76b33cbf835b9e6c86f0c"
        ),
        Hex.from(
          "ebcd1bb7039d40ac0d477af58964b4582c6741d1c901ab4a2b0de15e600cba69"
        ),
        Hex.from(
          "38d458a70805902a52342cfc552d374bdb217cd389e9550adfc4f86df6fdce82"
        ),
        Hex.from(
          "07781ff50552aefea962f0f4972fe882cb38a281ebdd533c2886d5137b80fbeb"
        ),
        Hex.from(
          "e7e530e181683d272293f19fe18a33f1dc05eded12ec27945b49311b2e14ee42"
        ),
      ],
      position: 262,
    },
    coinbaseRawTransaction: {
      transactionHex:
        "010000000001010000000000000000000000000000000000000000000000000000000" +
        "000000000ffffffff5003fecf0b1362696e616e63652f383235f10213007dfea192fa" +
        "be6d6def5afc5d3971282911709ed7cb7d9142bb531ae9cc453036b2b77afa95dc878" +
        "304000000000000000000d483e700000000000000ffffffff03599476250000000017" +
        "a914ca35b1f4d02907314852f09935b9604507f8d700870000000000000000266a24a" +
        "a21a9eddfad2eae7dcecafd0a22651c8e9d197143b7811e503dc77d7fe70931d2fd7f" +
        "7600000000000000002b6a2952534b424c4f434b3aed6626f157d5eaf68037ee382bd" +
        "47af82d62aab3b7aab4b79058b234004c6cf401200000000000000000000000000000" +
        "00000000000000000000000000000000000000000000",
    },
    coinbaseMerkleBranch: {
      blockHeight: 774142,
      merkle: [
        Hex.from(
          "294dca224d25b5637e2520e07a5b5942a1e56a91532927f9611b49ce73e8e674"
        ),
        Hex.from(
          "69e58cb5e60eafa3faff8a4a691bb80d6bf541c40eba3d06868a28873b29089d"
        ),
        Hex.from(
          "12b7ab7aae471f8a2208ffb88e2624a9107e99dfe52d653e0237149c08505794"
        ),
        Hex.from(
          "11df9abc347cb8ae1f61e86b5713966780cc052704b145e26ec9591c3c6b819e"
        ),
        Hex.from(
          "19ca1d35c20828cde2e933e0058f7666c2f5b428d135392bc4c444046f06831f"
        ),
        Hex.from(
          "d112040dc1d4952db1f6079f9a79cd18e695495adac9e742b8b28f0adb30f2eb"
        ),
        Hex.from(
          "ea5cbc9f966c8c69e0ecca2719d26fe834dd308e6fe620036d200f0c46454804"
        ),
        Hex.from(
          "5bd7afaed89f37bf36978b52d634c57451215eecdf1780de3b5274f27ce5508b"
        ),
        Hex.from(
          "73a7ab1687e76798fb48089d3965f678b72c74d8dee7d814761f08fa489e15f9"
        ),
        Hex.from(
          "e7e530e181683d272293f19fe18a33f1dc05eded12ec27945b49311b2e14ee42"
        ),
      ],
      position: 0,
    },
    previousDifficulty: BigNumber.from(37590453655497),
    currentDifficulty: BigNumber.from(39350942467772),
  },
}

/**
 * Test data that is based on a random Bitcoin testnet transaction
 * https://live.blockcypher.com/btc-testnet/tx/b78636ae08e6c17261a9f3134109c13c2eb69f6df52e591cc0e0780f5ebf6472/
 */
export const testnetTransactionData: TransactionProofData = {
  requiredConfirmations: 6,
  bitcoinChainData: {
    transaction: {
      transactionHash: BitcoinTxHash.from(
        "b78636ae08e6c17261a9f3134109c13c2eb69f6df52e591cc0e0780f5ebf6472"
      ),
      inputs: [
        {
          transactionHash: BitcoinTxHash.from(
            "b230eb52608287da6320fa0926b3ada60f8979fa662d878494d11909d9841aba"
          ),
          outputIndex: 1,
          scriptSig: Hex.from(""),
        },
      ],
      outputs: [
        {
          outputIndex: 0,
          value: BigNumber.from(1342326),
          scriptPubKey: Hex.from(
            "0014ffadb0a5ab3f58e651383b478acdc7cd0008e351"
          ),
        },
        {
          outputIndex: 1,
          value: BigNumber.from(7218758882),
          scriptPubKey: Hex.from(
            "00143c258d94e7abf4695585911b0420c24c1c78213e"
          ),
        },
      ],
    },
    accumulatedTxConfirmations: 18,
    latestBlockHeight: 2421198,
    headersChain: Hex.from(
      "000000203528cf6e8112d970a1adeb9743937d2e980afb43cb8ce3600100000000000" +
        "0007bacd9aa2249c74fdba75dd651a16755e9b4dc3c1953f2baa01d657f317e3eb936" +
        "62f763ffff001d7045e837000040207184a40ae97e64b2bce8fed41f967eac210e036" +
        "9a66855bd2b37c86200000000fe261c184d19c15c7b66c284d5f65e79595f65d576cc" +
        "40f20cccf0fcbae3c063a866f7639cde2c193ed763b904e000209885f5bb4bc96f8ff" +
        "ed3bf31c6f526f1f71fc6dd3f9bb0ed0200000000000000720c67b13ee8805763110f" +
        "b345cbfb5369836344e6a990e4ac0c363211362b2c6168f7639cde2c19294a1006000" +
        "040200aafa9b9e947a9bd6fe2e9f04dece7753863d59b11e5c63b1500000000000000" +
        "7a63f980ffc1f993c0d7dbe0670e71be2eeae8710a7906f758d3b400dd6a1e6b3c69f" +
        "7639cde2c1940a3735000008020ba335b0d58de55cf227fdd35ba380a4a288d4f7926" +
        "8be6a01800000000000000ffdc211cb41a97249e18a54aa4861a77f43093d6716995a" +
        "9f659370ee1cf8aea406af7639cde2c19254197450000002069b318d3a7c7c154651f" +
        "23ac4c3a51c7ec5158f40a62783c0400000000000000f452ef784d467c9f541331552" +
        "32d005bdd0f2d323933646976ef2b7275206d7ff96ef763ffff001db18d224b"
    ),
    transactionMerkleBranch: {
      blockHeight: 2421181,
      merkle: [
        Hex.from(
          "33610df4f460e1338d9f6a055de18d5c694edf590722211b6feeec77a9479846"
        ),
        Hex.from(
          "0fd7e0afdde99bdfbfdc0d0e6f5ccda4cd1873eee315bb989622fd58bd5c4446"
        ),
        Hex.from(
          "2d4ab6c53cedc1a447e21ad2f38c6d9d0d9c761426975a65f83fe10f12e3c9e0"
        ),
        Hex.from(
          "0eebd6daa03f6db4a27541a91bcf86612c97d100bc37c3eb321d64d943adb2a5"
        ),
        Hex.from(
          "b25854f31fc046eb0f53cddbf2b6de3d54d52710acd79a796c78c3be235f031a"
        ),
        Hex.from(
          "1fc5ab77039f59ac2494791fc05c75fb53e2dacf57a20f67e7d6727b38778825"
        ),
        Hex.from(
          "5b0acfdbb89af64a583a88e92252b8634bd4da06ee102ecd34c2662955e9f1c7"
        ),
      ],
      position: 4,
    },
    coinbaseRawTransaction: {
      transactionHex:
        "010000000001010000000000000000000000000000000000000000000000000000000" +
        "000000000ffffffff0403bdf124ffffffff02c92638000000000016001416761a41f7" +
        "452e32f987702b6deb87f68cd7aa7a0000000000000000266a24aa21a9ed270d869bd" +
        "7697384d2e4810cb6a24ba31390e2cc3c02fd60fd3f70e1997d63ec01200000000000" +
        "00000000000000000000000000000000000000000000000000000000000000",
    },
    coinbaseMerkleBranch: {
      blockHeight: 2421181,
      merkle: [
        Hex.from(
          "9f6f47ff0bc14890fe99236695c3cf5dde83ee93f196737618a81480a3232bc3"
        ),
        Hex.from(
          "6938bd629f8e0fc641d6438ee0d0f5100931cb68f48abf28a8b9a34321904d8b"
        ),
        Hex.from(
          "27598cb2cc1e2131cd718bc8ecc1388d3b2f04c0e641bbb59876267ea465d5c7"
        ),
        Hex.from(
          "0eebd6daa03f6db4a27541a91bcf86612c97d100bc37c3eb321d64d943adb2a5"
        ),
        Hex.from(
          "b25854f31fc046eb0f53cddbf2b6de3d54d52710acd79a796c78c3be235f031a"
        ),
        Hex.from(
          "1fc5ab77039f59ac2494791fc05c75fb53e2dacf57a20f67e7d6727b38778825"
        ),
        Hex.from(
          "5b0acfdbb89af64a583a88e92252b8634bd4da06ee102ecd34c2662955e9f1c7"
        ),
      ],
      position: 0,
    },
    previousDifficulty: BigNumber.from(1),
    currentDifficulty: BigNumber.from(1),
  },
}
