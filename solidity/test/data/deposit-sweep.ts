import { BytesLike } from "@ethersproject/bytes"
import { BigNumberish } from "ethers"

// TODO: Add some test data which contains a reference to a deposit with
//       `fundingOutputIndex` other than `0`.

/**
 * Represents a set of data used for given sweep scenario.
 */
export interface DepositSweepTestData {
  /**
   * Deposits swept within given sweep. Those fields correspond to the ones
   * which must be passed during deposit reveal. They are actually used to
   * call `revealDeposit` function for each deposit before calling
   * `submitDepositSweepProof` during each test scenario.
   */
  deposits: {
    fundingTx: {
      hash: BytesLike
      version: BytesLike
      inputVector: BytesLike
      outputVector: BytesLike
      locktime: BytesLike
    }
    depositor: string
    reveal: {
      fundingOutputIndex: BigNumberish
      blindingFactor: BytesLike
      walletPubKeyHash: BytesLike
      refundPubKeyHash: BytesLike
      refundLocktime: BytesLike
      vault: string
    }
    ecdsaWallet?: {
      walletPublicKey: BytesLike
      walletID: BytesLike
    }
  }[]

  /**
   * Address that will be passed to the `submitDepositSweepProof` function
   * as the `vault` parameter.
   */
  vault: string

  /**
   * Main UTXO data which are used as `mainUtxo` parameter during
   * `submitDepositSweepProof` function call. If no main UTXO exists for given wallet,
   * `NO_MAIN_UTXO` constant should be used as value.
   */
  mainUtxo: {
    txHash: BytesLike
    txOutputIndex: number
    txOutputValue: BigNumberish
  }

  /**
   * Sweep transaction data passed as `sweepTx` parameter during
   * `submitDepositSweepProof` function call.
   */
  sweepTx: {
    hash: BytesLike
    version: BytesLike
    inputVector: BytesLike
    outputVector: BytesLike
    locktime: BytesLike
  }

  /**
   * Sweep proof data passed as `sweepProof` parameter during `submitDepositSweepProof`
   * function call.
   */
  sweepProof: {
    merkleProof: BytesLike
    txIndexInBlock: BigNumberish
    bitcoinHeaders: BytesLike
    coinbasePreimage: BytesLike
    coinbaseProof: BytesLike
  }

  /**
   * Chain difficulty which was in force at the moment of Bitcoin transaction
   * execution. It is used to mock the difficulty provided by `Relay` contract
   * with a correct value thus making proof validation possible.
   */
  chainDifficulty: number
}

export const NO_MAIN_UTXO = {
  txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  txOutputIndex: 0,
  txOutputValue: 0,
}

/**
 * `SingleP2SHDeposit` test data represents a sweep with following properties:
 * - 1 P2SH deposit input
 * - 1 P2WPKH sweep output
 * - No main UTXO exists for this wallet
 * - 6+ on-chain confirmations of the sweep transaction
 */
export const SingleP2SHDepositWalletID =
  "0x9ff37567d973e4d884bc42d2d1a6cb1ff22676ab64f82c62b58e2b0ffd3fff71"

export const SingleP2SHDeposit: DepositSweepTestData = {
  deposits: [
    {
      // https://live.blockcypher.com/btc-testnet/tx/c580e0e352570d90e303d912a506055ceeb0ee06f97dce6988c69941374f5479
      fundingTx: {
        hash: "0x79544f374199c68869ce7df906eeb0ee5c0506a512d903e3900d5752e3e080c5",
        version: "0x01000000",
        inputVector:
          "0x011d9b71144a3ddbb56dd099ee94e6dd8646d7d1eb37fe1195367e6fa844a3" +
          "88e7010000006a47304402206f8553c07bcdc0c3b906311888103d623ca9096c" +
          "a0b28b7d04650a029a01fcf9022064cda02e39e65ace712029845cfcf58d1b59" +
          "617d753c3fd3556f3551b609bbb00121039d61d62dcd048d3f8550d22eb90b4a" +
          "f908db60231d117aeede04e7bc11907bfaffffffff",
        outputVector:
          "0x02204e00000000000017a9143ec459d0f3c29286ae5df5fcc421e278602427" +
          "7e87a6c2140000000000160014e257eccafbc07c381642ce6e7e55120fb077fb" +
          "ed",
        locktime: "0x00000000",
      },
      depositor: "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0xf9f0c90d00039523",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 039d61d62dcd048d3f8550d22eb90b4af908db60231d117aeede04e7bc11907bfa
        refundPubKeyHash: "0xe257eccafbc07c381642ce6e7e55120fb077fbed",
        refundLocktime: "0xe0250162",
        vault: "0x0000000000000000000000000000000000000000",
      },
      ecdsaWallet: {
        // Uncompressed and un-prefixed public key X and Y coordinates derived from
        // compressed public key 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9
        walletPublicKey:
          "0x989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9d218b65e7d91c752f7b22eaceb771a9af3a6f3d3f010a5d471a1aeef7d7713af",
        // keccak256 hash of 989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9d218b65e7d91c752f7b22eaceb771a9af3a6f3d3f010a5d471a1aeef7d7713af
        walletID: SingleP2SHDepositWalletID,
      },
    },
  ],

  vault: "0x0000000000000000000000000000000000000000",

  mainUtxo: NO_MAIN_UTXO,

  // https://live.blockcypher.com/btc-testnet/tx/f5b9ad4e8cd5317925319ebc64dc923092bef3b56429c6b1bc2261bbdc73f351
  sweepTx: {
    hash: "0x51f373dcbb6122bcb1c62964b5f3be923092dc64bc9e31257931d58c4eadb9f5",
    version: "0x01000000",
    inputVector:
      "0x0179544f374199c68869ce7df906eeb0ee5c0506a512d903e3900d5752e3e080c5" +
      "00000000c847304402205eff3ae003a5903eb33f32737e3442b6516685a1addb1933" +
      "9c2d02d400cf67ce0220707435fc2a0577373c63c99d242c30bea5959ec180169978" +
      "d43ece50618fe0ff012103989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f25" +
      "64da4cc29dcf8581d94c5c14934b98637ca318a4d6e7ca6ffd1690b8e77df6377508" +
      "f9f0c90d000395237576a9148db50eb52063ea9d98b3eac91489a90f738986f68763" +
      "ac6776a914e257eccafbc07c381642ce6e7e55120fb077fbed8804e0250162b175ac" +
      "68ffffffff",
    outputVector:
      "0x0144480000000000001600148db50eb52063ea9d98b3eac91489a90f738986f6",
    locktime: "0x00000000",
  },

  sweepProof: {
    merkleProof:
      "0x75377d34f47e2eb0cfb04459bce58492a84996dc31bf3cba5f08bfea36168d3969" +
      "93fa41ecc498353f332478ae3f964241fa1956f52f09cd6994eb7fbda3341b433477" +
      "45dbcc7ce3902199c31a0fb3c03a21f1f6845480cbbee15e8fbf400cb741b48b8505" +
      "ca54f7c08cd9c2e5c37b03a3eca02af540fc5b9ad90a00c4a1d2cf54fcbcc851c8d4" +
      "7552b8e09f6656a7fb74c488b9869b3247d56cdfe1ecbd4517b6b06c734b78f6c725" +
      "26da3cc4b5219faa48ba7abe403729b958b16cc07c706eb87d6febdbf3b82f1d64b1" +
      "54be0a60cdbbab0de51e0e4743214828f9ee2c0c29",
    txIndexInBlock: 36,
    bitcoinHeaders:
      "0x04000020a5a3501e6ba1f3e2a1ee5d29327a549524ed33f272dfef300045660000" +
      "000000e27d241ca36de831ab17e6729056c14a383e7a3f43d56254f846b496497751" +
      "12939edd612ac0001abbaa602e000000206d9e839a3c97827b5faf845f51a66edc34" +
      "ed32dbb81109f12a00000000000000fee43f9fffe8f2038392fdc69ba05e8825bac4" +
      "cda8c84c3f738d8ba2399a549a54a3dd61ffff001d3c151016000000201f6384713b" +
      "588bb730c51320aa0ab841e1dede512fdc2ed874e324df000000004254fcc35ca3e6" +
      "60d6a325b04755bd4c45b47530aece6ec254a6d84363c9836115a8dd61ffff001dc4" +
      "977aca00004020d6e7417486214ba46562c9bf4cdb973f9924dddee419b80afff181" +
      "d50000000031e301a5250a75e599d3a7e70996d677216cf23f261d513d9ac87296a0" +
      "3046dacdacdd61ffff001de15046e200000020ee071caba9bc64b8d459bfa0080722" +
      "1001f2c632c851d2868fa90600000000004e10814280c8bb5c548d09d4bae08164f7" +
      "3e32fcd35ed31020579b592668280383b1dd61ffff001dc15e6b8104000020382355" +
      "d0078bd0aaf7eb872dfa0f1bb555f8be0c0c219886d1426dfe0000000066555236d3" +
      "bbfb19bf093fe55252f7fb49a75ae99e6415b61ff6c0f8b89d0842b3b1dd612ac000" +
      "1ada9c55300000002031552151fbef8e96a33f979e6253d29edf65ac31b04802319e" +
      "00000000000000e003319fca9082d25815fcca442fe68a5249818abc79302e1b3dfe" +
      "854bf18028c0b2dd612ac0001ac429a1dd",
    coinbasePreimage:
      "0x6433bc0756ae5d456e7ede87ea28e9febda32c931debfde4baba7b30d0d89bb1",
    coinbaseProof:
      "0x06e3be3970c2e96ca71464dbc0f85180a66ad3699c0c494c08ca21d0c9c1e81375" +
      "2695ab27c82eb35d7dfedd71c73aeaf581d322688ad977873d92eb238fc78b01f96a" +
      "00ff72b44fe7d154004bcee087b3781414e72912511f56b451fe60ed9998825bb353" +
      "5a4229597e1ee925b8ab2000838f875bb35de861f54c891a63cc3f1220e54fa87367" +
      "bab3cd8b4630ff2ee540d12bd7792d24fdabe1c16b12292c002182140f51d320cdc9" +
      "e4d728fbb13034e834f4b17336880ec15aca23707d86c6b87d6febdbf3b82f1d64b1" +
      "54be0a60cdbbab0de51e0e4743214828f9ee2c0c29",
  },

  chainDifficulty: 22350181,
}

/**
 * `SingleP2WSHDeposit` test data represents a sweep with following properties:
 * - 1 P2WSH deposit input
 * - 1 P2WPKH sweep output
 * - No main UTXO exists for this wallet
 * - 6+ on-chain confirmations of the sweep transaction
 */
export const SingleP2WSHDeposit: DepositSweepTestData = {
  deposits: [
    {
      // https://live.blockcypher.com/btc-testnet/tx/c1082c460527079a84e39ec6481666db72e5a22e473a78db03b996d26fd1dc83
      fundingTx: {
        hash: "0x83dcd16fd296b903db783a472ea2e572db661648c69ee3849a072705462c08c1",
        version: "0x01000000",
        inputVector:
          "0x0189f12fac482d2b036f74378a9c9af7ab17bcc963d4172cec78d01750dd1b" +
          "13e20100000000ffffffff",
        outputVector:
          "0x028038010000000000220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7" +
          "d671ef27d4b1d0db8dcc93bc1c7ad42900000000001600147ac2d9378a1c47e5" +
          "89dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      },
      depositor: "0xf4292022F75ADD9b079b0573d0FD63C376a85F41",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0xb0bb0e4d6083951d",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 02e17803749b7a8af2efd288de313a98e7c77bb0969e220edf25932d97686db83d
        refundPubKeyHash: "0x056514a7032b0b486e56a607fb434756c61d1f74",
        refundLocktime: "0x38421962",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
  ],

  vault: "0x0000000000000000000000000000000000000000",

  mainUtxo: NO_MAIN_UTXO,

  // https://live.blockcypher.com/btc-testnet/tx/9efc9d555233e12e06378a35a7b988d54f7043b5c3156adc79c7af0a0fd6f1a0
  sweepTx: {
    hash: "0xa0f1d60f0aafc779dc6a15c3b543704fd588b9a7358a37062ee13352559dfc9e",
    version: "0x01000000",
    inputVector:
      "0x0183dcd16fd296b903db783a472ea2e572db661648c69ee3849a072705462c08c1" +
      "0000000000ffffffff",
    outputVector:
      "0x01b0300100000000001600148db50eb52063ea9d98b3eac91489a90f738986f6",
    locktime: "0x00000000",
  },

  sweepProof: {
    merkleProof:
      "0x1e385762f7d31965169347c77cdf80b97d9929db5a69c5ed806db32b076148eb5d" +
      "e6c1ecf41b3d5850ddc4734e640055c1196aff7adc62f4142fb325d52f094d9fec4a" +
      "45971e5e57dd7eba7c1a16f800f4d39ca840dde81afc94962fe11666ec25ffb29b0a" +
      "fbf42def26d69660fc59495bfd57a33b3a4ab47efe33dd5d77f018df4c5c181f0c15" +
      "a6fb2e5b6df6699379eb525e3d9f44093efe518f5ac3499850",
    txIndexInBlock: 6,
    bitcoinHeaders:
      "0x04e0ff2ffe53ee270bc727b7b79a51fad230e89ffbe713a3a98e38bf61a6a60000" +
      "000000e2ef3dc664f683c06d97562f7f664fc66524dbb37ef1ba1e961ecd25a6d8d9" +
      "2f6996f261cbcd001a44861d0a0000e0205c5df9ba0f31cdf5ad8c146fb16c1199d2" +
      "7309ed31e34934b8000000000000002c183edd5a6d3e7c2205a8a2c1dab8e0940bd1" +
      "20d4f6fcc5ab4d38d77fbe0e572a9bf261ffff001d2a446a0e000060209727625876" +
      "c086cee161094c5eb7e535dec7064c345c46b2413298000000000050d8a67fef29c6" +
      "b9329257b3fe29e4c24894ee32cbce7c15a67a401169a065f3dc9ff261ffff001d8f" +
      "b08e4100400020b52821b4fd96d162a27d4dcc1aafd6439de4fcec11dca8a4af70bc" +
      "00000000000c76c80b49a7b3549fe8421d365fb31966cd41fe47b067dcc97108db1c" +
      "20a27b8da4f261ffff001d2a74b0a70000002046501508ec2bea6c9d8fd891f1f596" +
      "410068b178005ea5f5f0a7ae130000000070e9a74d4ab00d601c62fa42fd38c1ec5f" +
      "ec628180341f4eaa667d6364fed3b193a5f261cbcd001a78634212d49820001e1adb" +
      "3e29eb4aa11c99e7d5c77dbbe7803760926f57e1f9a50000000000000018182cbc30" +
      "f44efa5eabbb9a2f9888a27feb6d2e2f1e1461534344cf1dafd437e3a6f261cbcd00" +
      "1a8959a5db002000207cddca26ea39dd08f6345c0057300443d7720c5ab4937c2711" +
      "000000000000004eb83f96a1f1ace06832a7eb8b3a407f04b37e211363422bf58dde" +
      "b50f20a8a54ba7f261cbcd001a25011a61",
    coinbasePreimage:
      "0xb23026936fd2bc92379950f84ca6499fca4fb9a7f0743babf9441fb536b9050b",
    coinbaseProof:
      "0x795ee62cf9561d9a7402ca415b436506618b17f4e0a7a3e7a64c592e7a72ccad34" +
      "067108cb7b98cc47a610df571b2f6cd7f1469103b8a69345180320a9d06babe02365" +
      "9a89e6f70dd32d6946b0007642479f25a9c7a7e3904630e929c7e0ea2525ffb29b0a" +
      "fbf42def26d69660fc59495bfd57a33b3a4ab47efe33dd5d77f018df4c5c181f0c15" +
      "a6fb2e5b6df6699379eb525e3d9f44093efe518f5ac3499850",
  },

  chainDifficulty: 20870012,
}

/**
 * `SingleMainUtxo` test data represents a sweep with following properties:
 * - 1 P2WPKH main UTXO input
 * - 1 P2WPKH sweep output
 * - The main UTXO exists for this wallet
 * - 6+ on-chain confirmations of the sweep transaction
 */
export const SingleMainUtxo: DepositSweepTestData = {
  deposits: [],

  vault: "0x0000000000000000000000000000000000000000",

  // https://live.blockcypher.com/btc-testnet/tx/f5b9ad4e8cd5317925319ebc64dc923092bef3b56429c6b1bc2261bbdc73f351
  mainUtxo: {
    txHash:
      "0x51f373dcbb6122bcb1c62964b5f3be923092dc64bc9e31257931d58c4eadb9f5",
    txOutputIndex: 0,
    txOutputValue: 18500,
  },

  // https://live.blockcypher.com/btc-testnet/tx/3c5e414be0a36e7cd8a6b3a554b4bd9bebe3eee4eddd0dd2a182652e5772b1ad
  sweepTx: {
    hash: "0xadb172572e6582a1d20dddede4eee3eb9bbdb454a5b3a6d87c6ea3e04b415e3c",
    version: "0x01000000",
    inputVector:
      "0x0151f373dcbb6122bcb1c62964b5f3be923092dc64bc9e31257931d58c4eadb9f5" +
      "0000000000ffffffff",
    outputVector:
      "0x0174400000000000001600148db50eb52063ea9d98b3eac91489a90f738986f6",
    locktime: "0x00000000",
  },

  sweepProof: {
    merkleProof:
      "0x420b7804b046b62d2c58ed265f1f4c1f5a870cb0dbb1788f251d4377a6ac198cca" +
      "80146dde2a79fab2cdcec6704d3166c1a60cb03b685faf895d171929874798341f0b" +
      "acfd708ccdb0de53fd6f99c56d6b5ecd4f68b9ce33e1ff2f38843671a6b252ef1c80" +
      "e934fd37dba1a508eac0b4f574dee4bd2896d069594c07314c7f5668dd6f681ea181" +
      "bfa9eb1b37825ba05f74fa8ec78f0014dff6d4365cf68697b630254f65249c7909d7" +
      "5ca862aaf2ebb1d7eac6334a68104605ed0f57b7ab5e58744f028d58b36016f2e78c" +
      "b4701aace4a64dcc85e3be1d4db96fe4275658c941",
    txIndexInBlock: 12,
    bitcoinHeaders:
      "0x0000e0205c5df9ba0f31cdf5ad8c146fb16c1199d27309ed31e34934b800000000" +
      "0000002c183edd5a6d3e7c2205a8a2c1dab8e0940bd120d4f6fcc5ab4d38d77fbe0e" +
      "572a9bf261ffff001d2a446a0e000060209727625876c086cee161094c5eb7e535de" +
      "c7064c345c46b2413298000000000050d8a67fef29c6b9329257b3fe29e4c24894ee" +
      "32cbce7c15a67a401169a065f3dc9ff261ffff001d8fb08e4100400020b52821b4fd" +
      "96d162a27d4dcc1aafd6439de4fcec11dca8a4af70bc00000000000c76c80b49a7b3" +
      "549fe8421d365fb31966cd41fe47b067dcc97108db1c20a27b8da4f261ffff001d2a" +
      "74b0a70000002046501508ec2bea6c9d8fd891f1f596410068b178005ea5f5f0a7ae" +
      "130000000070e9a74d4ab00d601c62fa42fd38c1ec5fec628180341f4eaa667d6364" +
      "fed3b193a5f261cbcd001a78634212d49820001e1adb3e29eb4aa11c99e7d5c77dbb" +
      "e7803760926f57e1f9a50000000000000018182cbc30f44efa5eabbb9a2f9888a27f" +
      "eb6d2e2f1e1461534344cf1dafd437e3a6f261cbcd001a8959a5db002000207cddca" +
      "26ea39dd08f6345c0057300443d7720c5ab4937c2711000000000000004eb83f96a1" +
      "f1ace06832a7eb8b3a407f04b37e211363422bf58ddeb50f20a8a54ba7f261cbcd00" +
      "1a25011a6100000020a255594fd7ad6096e47c5b0b3a636cf0ac0dafc0dcf60277a5" +
      "00000000000000d75ff7b7b32573d64219f81e65e61881446f68dcf47a7f5b47444b" +
      "fd35db25f5a3a8f261cbcd001a32960f84",
    coinbasePreimage:
      "0xfd410acfd823548acbdcb9564925a4d20315da45b1dac4104539e69a0c676efc",
    coinbaseProof:
      "0xc2abcae4779f2453e7c1d4d22906b6de052e8b14f565d4833f73b324ca2cc313e0" +
      "f58a7314b4279ddbbd2935851ebb54ec1995b8b4153da4872446e38515607b8223e9" +
      "6427eb6bd79f5e28b7b60e29f6d5b46dc05c7b5e8570d405fa52a3c5a4e47d25865a" +
      "cbe72a6e425616fcd88f5e9ebddee4da156796f6d8e0fcbfd9137e68dd6f681ea181" +
      "bfa9eb1b37825ba05f74fa8ec78f0014dff6d4365cf68697b630254f65249c7909d7" +
      "5ca862aaf2ebb1d7eac6334a68104605ed0f57b7ab5e58744f028d58b36016f2e78c" +
      "b4701aace4a64dcc85e3be1d4db96fe4275658c941",
  },

  chainDifficulty: 1,
}

/**
 * `MultipleDepositsNoMainUtxo` test data represents a sweep with following properties:
 * - 3 P2WSH and 2 P2SH deposit inputs
 * - 1 P2WPKH sweep output
 * - No main UTXO exists for this wallet
 * - 6+ on-chain confirmations of the sweep transaction
 */
export const MultipleDepositsNoMainUtxo: DepositSweepTestData = {
  deposits: [
    {
      // https://live.blockcypher.com/btc-testnet/tx/d6a04c76aab203fe9cd8a2498bb4a8c50eb767fd95719c7790ac675ed5dec526
      fundingTx: {
        hash: "0x26c5ded55e67ac90779c7195fd67b70ec5a8b48b49a2d89cfe03b2aa764ca0d6",
        version: "0x01000000",
        inputVector:
          "0x0101278d2c20437868e49c34bc67ace5646d20c674354e061a1683c8b55cf4" +
          "19c20100000000ffffffff",
        outputVector:
          "0x0230750000000000002200200b636cbcfcde39f846bc1715a9216d53a7b882" +
          "9d8590c54d1a1389dac31e4e125e5c3b00000000001600147ac2d9378a1c47e5" +
          "89dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      },
      depositor: "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
      reveal: {
        fundingOutputIndex: 0,

        blindingFactor: "0x4a6f267c3bfaba7c",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 0300d6f28a2f6bf9836f57fcda5d284c9a8f849316119779f0d6090830d97763a9.
        refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
        refundLocktime: "0x1cdb1462",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
    {
      // https://live.blockcypher.com/btc-testnet/tx/659ea860a4879acba52c1518fb44f71ed8bb0db78074da29eaf0afac6e2d79d1
      fundingTx: {
        hash: "0xd1792d6eacaff0ea29da7480b70dbbd81ef744fb18152ca5cb9a87a460a89e65",
        version: "0x01000000",
        inputVector:
          "0x010ab93f22d004afe73c75e24a9b790854be61f8a262ff7c41022b8cce9c82" +
          "d8730100000000ffffffff",
        outputVector:
          "0x02102700000000000017a914e56ff1445b513721fb0e3981817d1b17d83f95" +
          "b087acb43a00000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d27" +
          "26",
        locktime: "0x00000000",
      },
      depositor: "0x6749bc3837b23da76ccAF0051aa64202f5dDEed3",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0x2c8b4d267ff1d505",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 03c8d218194ff88421589b8cc14de046146519a45fa24be8299696650b86d9a726.
        refundPubKeyHash: "0xde54ea850935dbd54ed886bf8a1f8810021a25c2",
        refundLocktime: "0x4c051562",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
    {
      // https://live.blockcypher.com/btc-testnet/tx/bab571c612c36d764d22f058097d8ece2e3ca255e886d4cb91131ee39823fc48
      fundingTx: {
        hash: "0x48fc2398e31e1391cbd486e855a23c2ece8e7d0958f0224d766dc312c671b5ba",
        version: "0x01000000",
        inputVector:
          "0x01d1792d6eacaff0ea29da7480b70dbbd81ef744fb18152ca5cb9a87a460a8" +
          "9e650100000000ffffffff",
        outputVector:
          "0x025034030000000000220020dfe723baab8a6a87f03eb67a9705bd1b15eb63" +
          "f9b9fd9cc62d8acf7c684432db6c7a3700000000001600147ac2d9378a1c47e5" +
          "89dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      },
      depositor: "0x640EdB9b80ED9FEAc6D20cc80156D71e3eEDc11b",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0x8448912a89f4bf26",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 03ca0ba18104c93b59ae76edb23456efceb4bdc9d53eebc9dd026726c107e2cc2a.
        refundPubKeyHash: "0x90123976988b921aac1218db4254572cc60c233a",
        refundLocktime: "0x6c021662",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
    {
      // https://live.blockcypher.com/btc-testnet/tx/c66e9ef85c94240c76c0372173e2371d746426f30df003b13e8653bf91042ee7
      fundingTx: {
        hash: "0xe72e0491bf53863eb103f00df32664741d37e2732137c0760c24945cf89e6ec6",
        version: "0x01000000",
        inputVector:
          "0x0148fc2398e31e1391cbd486e855a23c2ece8e7d0958f0224d766dc312c671" +
          "b5ba0100000000ffffffff",
        outputVector:
          "0x0250a505000000000017a914b8548576878505342b8cbb0e13ba2c1f4a6999" +
          "db879acf3100000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d27" +
          "26",
        locktime: "0x00000000",
      },
      depositor: "0xC92FC70710558103BD90B6BC9041137c43F86ed7",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0x90fb21f8f58d235a",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 0295e4010377cc051dfb9439cdedc78eba4e592254a829f28ebaeabb997a2b7843.
        refundPubKeyHash: "0xf1f72a500299a14380fe5cfccff6dda3408fb782",
        refundLocktime: "0x1c9d1662",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
    {
      // https://live.blockcypher.com/btc-testnet/tx/e2131bdd5017d078ec2c17d463c9bc17abf79a9c8a37746f032b2d48ac2ff189
      fundingTx: {
        hash: "0x89f12fac482d2b036f74378a9c9af7ab17bcc963d4172cec78d01750dd1b13e2",
        version: "0x01000000",
        inputVector:
          "0x01e72e0491bf53863eb103f00df32664741d37e2732137c0760c24945cf89e" +
          "6ec60100000000ffffffff",
        outputVector:
          "0x02c0b6060000000000220020f8b7d8d06bf387d9be502cf04a9821325b7216" +
          "b5301b9c8f65e6d29649a2108cea122b00000000001600147ac2d9378a1c47e5" +
          "89dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      },
      depositor: "0xEe080E869F094e251E135294539a05b267041122",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0xdd66710eefa37a42",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 021c0f768e18affe50136f487fa69d993facfd9f87040dfa764b32d8090d61a438.
        refundPubKeyHash: "0xf4eedc8f40d4b8e30771f792b065ebec0abaddef",
        refundLocktime: "0x389f1662",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
  ],

  vault: "0x0000000000000000000000000000000000000000",

  mainUtxo: NO_MAIN_UTXO,

  // https://live.blockcypher.com/btc-testnet/tx/2a5d5f472e376dc28964e1b597b1ca5ee5ac042101b5199a3ca8dae2deec3538
  sweepTx: {
    hash: "0x3835ecdee2daa83c9a19b5012104ace55ecab197b5e16489c26d372e475f5d2a",
    version: "0x01000000",
    inputVector:
      "0x0589f12fac482d2b036f74378a9c9af7ab17bcc963d4172cec78d01750dd1b13e2" +
      "0000000000ffffffffe72e0491bf53863eb103f00df32664741d37e2732137c0760c" +
      "24945cf89e6ec600000000c847304402202edd080c332080da520c32afbea2c6e84a" +
      "b0847e7c7b90287294d8c61860f1bf02200c9a2d8bfb534527813e04441f9b2804a9" +
      "224b1a46ee718399abc88628089770012103989d253b17a6a0f41838b84ff0d20e88" +
      "98f9d7b1a98f2564da4cc29dcf8581d94c5c14c92fc70710558103bd90b6bc904113" +
      "7c43f86ed7750890fb21f8f58d235a7576a9148db50eb52063ea9d98b3eac91489a9" +
      "0f738986f68763ac6776a914f1f72a500299a14380fe5cfccff6dda3408fb7828804" +
      "1c9d1662b175ac68ffffffff48fc2398e31e1391cbd486e855a23c2ece8e7d0958f0" +
      "224d766dc312c671b5ba0000000000ffffffff26c5ded55e67ac90779c7195fd67b7" +
      "0ec5a8b48b49a2d89cfe03b2aa764ca0d60000000000ffffffffd1792d6eacaff0ea" +
      "29da7480b70dbbd81ef744fb18152ca5cb9a87a460a89e6500000000c84730440220" +
      "0c5e04ebf5e0f30021d3c52c3c784ef46724183f2783ecd61203fb15f35095540220" +
      "7a988536b2451dad091720466ea1a22f3a3f9d5d415e82be733d764b57d0c6740121" +
      "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d94c" +
      "5c146749bc3837b23da76ccaf0051aa64202f5ddeed375082c8b4d267ff1d5057576" +
      "a9148db50eb52063ea9d98b3eac91489a90f738986f68763ac6776a914de54ea8509" +
      "35dbd54ed886bf8a1f8810021a25c288044c051562b175ac68ffffffff",
    outputVector:
      "0x01d0241000000000001600148db50eb52063ea9d98b3eac91489a90f738986f6",
    locktime: "0x00000000",
  },

  sweepProof: {
    merkleProof:
      "0xe15a60efbeec3dee2cdf38ebd0ffb5f48c230e61f8329a23840d72354d40560ea1" +
      "5dd9fc2856c93626253515d9dee159597a597603142772fb20b38f967a633b11e107" +
      "0eb88c1663303354ff954c6d9f9a67ebac28e4c150a98746d7f27cc07f43cdf29b4e" +
      "2418d2575717beb8f94e129c24aa1a893f706ce89072ef157f2ade",
    txIndexInBlock: 8,
    bitcoinHeaders:
      "0x0000a02037ab97313f296c44650553afaa03eb05757cc8514a1166e42500000000" +
      "0000003355bc5d3708f6a33c8b0a48c794f33855c01016dff40a17781da039d514a1" +
      "b0225ff161cbcd001a65784973000060202de7b5fc1d5283cfdf09f62210a035aaae" +
      "d9d16608d0013f5600000000000000804b0397eae0fba215e67eca1b764f3e052721" +
      "6dda006068a6aaef0353693d528060f161cbcd001a53beb73c00006020f97e400aaf" +
      "c9cb45f4cbff788bc630b1a36f7001a69b68043c00000000000000b6d619e28c36f7" +
      "b13dd2bd3ece559bad352ef8cd65f7ec89d330160d2c190a620e63f161cbcd001a11" +
      "58f632d498200029e4cea651d4eab2f5814d8b37f018069711bcb6e85b8617730000" +
      "0000000000587343c34efb8e4fa0be399a264e37981cf8b0db7dcb079bdc31fe74bb" +
      "8da8d6e363f161cbcd001a035e7125000080207ca61193b74eb860880a1479aaa0de" +
      "c37dd1939729bb5a1e5e000000000000001f69415e61d4917b7d64460250ed743709" +
      "51df01f04da7b7e5f71534c87ba4902064f161cbcd001a75c6ed6b0000a020c7ab47" +
      "2385653a7d341f10719ffa55f1a6f21e0853ac3c2b9400000000000000e50e9ae207" +
      "4024df90936006dd608c06534876db27a10f5851eadb5f579323daa265f161cbcd00" +
      "1a2676b59f0020002016b3f18bda6d1b0b8d27224c11428a6dd52bcb40cdf915fd42" +
      "00000000000000ed8dac80a63d3a5a041231f1adafdbc282fe78ded144c815a66ced" +
      "9a842089ddd965f161cbcd001af9f5886c",
    coinbasePreimage:
      "0xa81ec10a2d8e502975bd52946300a540383b39b7b892ce27964ea1430db846c2",
    coinbaseProof:
      "0x82c6fb9c18aa1aeafb073da60557adb51e1a42e7b9466650c6ff64ad94078e43b9" +
      "fbf359c8b95408a23f2c24dbe79ec7f4eaad2129f9516360732957cd803fd33871a5" +
      "1ef9253c6cbd9845c040df90befb1c5da28f7701dfc810885bfe9e936e129a69c92a" +
      "de622bfb03526eb3075b6831a4b61f767f6ead76f320c54a34dc98",
  },

  chainDifficulty: 20870012,
}

/**
 * `MultipleDepositsWithMainUtxo` test data represents a sweep with following properties:
 * - 3 P2WSH, 2 P2SH, and 1 P2WPKH main UTXO inputs
 * - 1 P2WPKH sweep output
 * - The main UTXO exists for this wallet
 * - 6+ on-chain confirmations of the sweep transaction
 */
export const MultipleDepositsWithMainUtxo: DepositSweepTestData = {
  deposits: [
    {
      // https://live.blockcypher.com/btc-testnet/tx/85eb466ed605916ea764860ceda68fa05e7448cc772558c866a409366b997a85
      fundingTx: {
        hash: "0x857a996b3609a466c8582577cc48745ea08fa6ed0c8664a76e9105d66e46eb85",
        version: "0x01000000",
        inputVector:
          "0x01fd1f9639ef881216e49ff8b15cb042172c942acbc12d6bb4491c2bb16d3b" +
          "d42e0100000000ffffffff",
        outputVector:
          "0x02605b0300000000002200207b154340a9b625709bce586ccc4e46c716f5cd" +
          "42c505f5f50aa7f6b0def024a698731700000000001600147ac2d9378a1c47e5" +
          "89dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      },
      depositor: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0x1d5c0a1bc9528ea2",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 0261b7f5be5c0549d722104f457485a50dd68c18bbd06ac8ed0878513653330af5.
        refundPubKeyHash: "0x64c2b58db5259ecc3c169b76c6bd83f3a9421090",
        refundLocktime: "0xe8fb1862",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
    {
      // https://live.blockcypher.com/btc-testnet/tx/468e0be44cf5b2a529f22c49d8006fb29a147a4f1b6a54326a8c181208560ec6
      fundingTx: {
        hash: "0xc60e560812188c6a32546a1b4f7a149ab26f00d8492cf229a5b2f54ce40b8e46",
        version: "0x01000000",
        inputVector:
          "0x01857a996b3609a466c8582577cc48745ea08fa6ed0c8664a76e9105d66e46" +
          "eb850100000000ffffffff",
        outputVector:
          "0x02c0980b000000000017a91413ce939c44d9bac56d636fd4215a66874c9aea" +
          "688756d50b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d27" +
          "26",
        locktime: "0x00000000",
      },
      depositor: "0x2219eAC966FbC0454C4A2e122717e4429Dd7608F",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0x251c7239917eae29",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 03ecc3fbee48644fb072424d42b109062f0945c2c68cbbeb1852e2ea97277a69ef.
        refundPubKeyHash: "0x032a5188c34f2fb56a4228b2bb2b7165a797eb95",
        refundLocktime: "0x88c61762",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
    {
      // https://live.blockcypher.com/btc-testnet/tx/71b13c7b1e2968f869c832ccdb72bbdccd35d64b78826d251d350d79a7a32f30
      fundingTx: {
        hash:
          "0x302fa3a7790d351d256d82784bd635cddcbb72dbcc32c869f868291e7b" +
          "3cb171",
        version: "0x01000000",
        inputVector:
          "0x0144178e5748d91b995a7f12da068efedb7b404e36be6002a4889b64d11f02" +
          "ee1b0100000000ffffffff",
        outputVector:
          "0x02e0570e00000000002200205bbfa44ea2e4eea99808c4f3beee7fd31f2885" +
          "0c0bff9592319d6306d0a67f330b0b0900000000001600147ac2d9378a1c47e5" +
          "89dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      },
      depositor: "0x208fF63189DF8749780917Cb5901183075Dbabc1",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0x8bdbb150483eb2f2",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 0257acc5233e598c4ea3b2216980833bd46e946a7fbde7a0933b0a122ff0af3789.
        refundPubKeyHash: "0x73f3252d5e6b9f501dfafbfbca40836cc1f505f7",
        refundLocktime: "0xb80f1762",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
    {
      // https://live.blockcypher.com/btc-testnet/tx/68f4041f6bbddb146f672d31e4a2cce6431e1583bb24a33a2c836a7f238625d3
      fundingTx: {
        hash: "0xd32586237f6a832c3aa324bb83151e43e6cca2e4312d676f14dbbd6b1f04f468",
        version: "0x01000000",
        inputVector:
          "0x0140caae8f45d9e3cc703241d68404216ead95cb3b704408a75740f039f8eb" +
          "80e10000000000ffffffff",
        outputVector:
          "0x02806d0d000000000017a914323d36279d8cbb9214c94708d1e5815b24bfb3" +
          "3d871ea90900000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d27" +
          "26",
        locktime: "0x00000000",
      },
      depositor: "0x35D54bC29e0a5170c3Ac73E64c7fA539A867f0FE",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0xdfe75a3a6ed52db6",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 02377a86cd3bd3f23b5b68bc4e0df6bc617cacc189f7ce16ddcaa52574127995c9.
        refundPubKeyHash: "0x11d6c57c31ea78b48020dcbf42c34ccd60d92c8c",
        refundLocktime: "0x28531862",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
    {
      // https://live.blockcypher.com/btc-testnet/tx/8c535793b98f1dbd638773e7ee07ebbbc5f86a55b5ae31ba91f63a67682e95aa
      fundingTx: {
        hash: "0xaa952e68673af691ba31aeb5556af8c5bbeb07eee7738763bd1d8fb99357538c",
        version: "0x01000000",
        inputVector:
          "0x01424a065ba76a455aa14d6dbed205d8742a5b5a9ff05fcd314a4eadea878a" +
          "31720000000000ffffffff",
        outputVector:
          "0x02d06c040000000000220020af802a76c10b6a646fff8d358241c121c9be1c" +
          "53628adb26bd6554631bfc7d8b56a21200000000001600147ac2d9378a1c47e5" +
          "89dfb8095ca95ed2140d2726",
        locktime: "0x00000000",
      },
      depositor: "0x462418b7495561bF2872A0786109A11f5d494aA2",
      reveal: {
        fundingOutputIndex: 0,
        blindingFactor: "0xeca429ef209bf500",
        // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
        walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
        // HASH160 of 02f61c699f77650c5296efe5b9d82844855a2d81ee0b4f70e558ae179425694755.
        refundPubKeyHash: "0x46c5760250ab89b3d4b956cee325561fa7effff8",
        refundLocktime: "0x6c4b1862",
        vault: "0x0000000000000000000000000000000000000000",
      },
    },
  ],

  vault: "0x0000000000000000000000000000000000000000",

  // https://live.blockcypher.com/btc-testnet/tx/2a5d5f472e376dc28964e1b597b1ca5ee5ac042101b5199a3ca8dae2deec3538
  mainUtxo: {
    txHash:
      "0x3835ecdee2daa83c9a19b5012104ace55ecab197b5e16489c26d372e475f5d2a",
    txOutputIndex: 0,
    txOutputValue: 1058000,
  },

  // https://live.blockcypher.com/btc-testnet/tx/4459881f4964ee08dd298a12dfc1f461bf35cca8a105974d8baf0955c830d836/
  sweepTx: {
    hash: "0x36d830c85509af8b4d9705a1a8cc35bf61f4c1df128a29dd08ee64491f885944",
    version: "0x01000000",
    inputVector:
      "0x063835ecdee2daa83c9a19b5012104ace55ecab197b5e16489c26d372e475f5d2a" +
      "0000000000ffffffff302fa3a7790d351d256d82784bd635cddcbb72dbcc32c869f8" +
      "68291e7b3cb1710000000000ffffffffd32586237f6a832c3aa324bb83151e43e6cc" +
      "a2e4312d676f14dbbd6b1f04f46800000000c9483045022100afeb157db4284ab218" +
      "a3d27b6962aabe1905eb205c6c6216dfad7e76615c0bb702205ffd88f2d2dea7509b" +
      "7ea3b01910002544a785efa93c7ecd1cabafbdec508d3f012103989d253b17a6a0f4" +
      "1838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d94c5c1435d54bc29e0a51" +
      "70c3ac73e64c7fa539a867f0fe7508dfe75a3a6ed52db67576a9148db50eb52063ea" +
      "9d98b3eac91489a90f738986f68763ac6776a91411d6c57c31ea78b48020dcbf42c3" +
      "4ccd60d92c8c880428531862b175ac68ffffffffc60e560812188c6a32546a1b4f7a" +
      "149ab26f00d8492cf229a5b2f54ce40b8e4600000000c847304402200abefbc8d4d6" +
      "bbe668c97ee305fde12f3c6c796ab6fbf84f00289ad5910ed8ac02200b81dcd12d45" +
      "a83237569d53bcc629db559ce8c2cfd62d11fe5c58d501f785e0012103989d253b17" +
      "a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d94c5c142219eac9" +
      "66fbc0454c4a2e122717e4429dd7608f7508251c7239917eae297576a9148db50eb5" +
      "2063ea9d98b3eac91489a90f738986f68763ac6776a914032a5188c34f2fb56a4228" +
      "b2bb2b7165a797eb95880488c61762b175ac68ffffffffaa952e68673af691ba31ae" +
      "b5556af8c5bbeb07eee7738763bd1d8fb99357538c0000000000ffffffff857a996b" +
      "3609a466c8582577cc48745ea08fa6ed0c8664a76e9105d66e46eb850000000000ff" +
      "ffffff",
    outputVector:
      "0x01693f3f00000000001600148db50eb52063ea9d98b3eac91489a90f738986f6",
    locktime: "0x00000000",
  },

  sweepProof: {
    merkleProof:
      "0x891ee0728e1813119bd1819c07dd1873812fe0593ef595a4e72e5bc13a03d1c018" +
      "7b8368d83a7ad1cf6e16c0f494c64741c8388535184b56033985e3a9975c5e79e1ec" +
      "3d9c3dd21ed0906c956cc8dda3b16fea011052899016c768bb4aed5c37a11bb23f70" +
      "5acd8778cd99bcdabb4ba94be1c38efa19cc943ba22a53c49647eb8a94b314a5f5f9" +
      "e3a74dff2634e85576c7dfa39832ac5fe8867717b609be985c8e05f1d113d44d985d" +
      "8e21f7375dc6b5707c84939f54df46a46e55e26f2548a37d29d3e3d9e99b6f3f48c5" +
      "92742379c8f5df3d40c4619d56ced461ba1d606d59",
    txIndexInBlock: 25,
    bitcoinHeaders:
      "0x000020204bc3de8c4177bb2e58338b4cbbcc3ec0ea09911f1742618f9600000000" +
      "000000758fd5eb5a6c441f133f43419eeb1501d4f1f366edd196f6791aef9dbd91a9" +
      "d7a7c3f361ffff001d6d7c8cc704e0ff2f31b46af53b2d960711c3e4deaac3f60377" +
      "1d34d405a7087e2ad80800000000003e6e73d828c282e7a4488978a2bd9eebe9940c" +
      "3336afca54f8537fa931ded5e065c8f361ffff001d79f96c5604e0ff2f0a5afa1eb9" +
      "49db8eece69ffeb17fe8d9afcc0ed7be34cd3dc6700000000000000b602522c91666" +
      "be715334699389470c0532f6de5acf4987ff67157a4c2b767119cdf361ffff001de5" +
      "b27822d49820008d4bdd0a66c2232d5c95ed31cd0cfbd1716fa17de7d2c76fbd1f00" +
      "0000000000a98c7af6d25b725937c33588522f79c74042dbe258bc46ba5e2332f778" +
      "111c607ad1f361cbcd001af30153f1040000202b2d25b77060ec4de71a962685ec71" +
      "4cf7703f1c5a569b748000000000000000104e1a758c12069336d732c268603b62d2" +
      "1bcf79d47a1f558d5d5148f048350939d6f361ffff001d8feacc6e04e0ff3ff1f373" +
      "1c82930f615eabe81e3200b6fee728972cadbb56d47342010000000000c676579dd3" +
      "933e14fef681ed72f59e5047b1088d99fd18340290b11f1e760f13ebdaf361ffff00" +
      "1db7fa1d4b",
    coinbasePreimage:
      "0xcadd93d5ce0d0c95abfb3d9d1c0bd6836eb8fdd851ae549ae8fb8a9879267f5a",
    coinbaseProof:
      "0x566dd6922d6dbecb73cd23670ba82bd1ad06c12dd85f615fb2ebbd6050f53a0e1a" +
      "e9383b1becdf09fc86371c2d2d2acfc484de4b9be870f69081d968cfc2065f391c3a" +
      "b2bdb7ef2a9cb3705fa7af19751e214bf6f66001e0ed91eddce8bb6c580146c1aef7" +
      "69311335615388439a3f5054bf2d0d2a4f5812c5ec2043171470721d825f890045f4" +
      "5a7d42012d515bc15ce449db2b664f711515c43660258b88ed8e05f1d113d44d985d" +
      "8e21f7375dc6b5707c84939f54df46a46e55e26f2548a37d29d3e3d9e99b6f3f48c5" +
      "92742379c8f5df3d40c4619d56ced461ba1d606d59",
  },

  chainDifficulty: 1,
}

/**
 * `SingleMainUtxoP2SHOutput` test data represents a sweep with following
 * properties:
 * - 1 P2WPKH main UTXO input
 * - 1 P2SH sweep output
 * - The main UTXO exists for this wallet
 * - 6+ on-chain confirmations of the sweep transaction
 */
export const SingleMainUtxoP2SHOutput: DepositSweepTestData = {
  // Not relevant in this test scenario.
  deposits: [],

  vault: "0x0000000000000000000000000000000000000000",

  mainUtxo: {
    txHash:
      "0x426518af930297f9d12ce84ac1366e19cf1c797a7515c1a62e0d51193bf6236b",
    txOutputIndex: 0,
    txOutputValue: 1669207,
  },

  // https://live.blockcypher.com/btc-testnet/tx/588a0e5e68ec8d3cf80d1190e51a68a431737a33c3a09f16303945dd49e369cd
  sweepTx: {
    hash: "0xcd69e349dd453930169fa0c3337a7331a4681ae590110df83c8dec685e0e8a58",
    version: "0x01000000",
    inputVector:
      "0x01426518af930297f9d12ce84ac1366e19cf1c797a7515c1a62e0d51193bf6236b" +
      "0000000000ffffffff",
    outputVector:
      "0x01cf6419000000000017a9147ac2d9378a1c47e589dfb8095ca95ed2140d272687",
    locktime: "0x00000000",
  },

  sweepProof: {
    merkleProof:
      "0xf6ed9f6ae7235c66ce46e4770aed465ab526375a834bbb651b3e5111ac84e58e42" +
      "6ccb496719c8ba7db243e6e0a7c4f00f1b2a308da73305cb0775a62df99cd26a3996" +
      "c774364ce40571d188d71e0044c42c3d6689b2d9a8a3c23f3a400f69e753330e3fae" +
      "9a71acecb7425e8dbe88cdfd7fc3258bac4e21ca1dec42e5094271c77932609c51fb" +
      "4b82497ed599d3c413c4fd023009716b3e5e885d89c31a1f30bb46106bac1034c65f" +
      "01d80ac402417373daf1fbae0d43041c67b948f47882b27c802a4e791504be4b1b71" +
      "80a788a54659799bedbc712e23a816cae0a12c017b838b1655583043a9c8d30399d3" +
      "f81e7e0fe2121a3c38490845174140a08ff6dc",
    txIndexInBlock: 6,
    bitcoinHeaders:
      "0x04e00020176fb6202fac66facb3155eebc5d9f26155c5f6074d0d298af01000000" +
      "000000175ff6b2d5fd0ec570f00de4b5b8e45862280926762546123a8c70241e069e" +
      "50d4ad1c62ffff001d7609709f00000020d6a19088bdad8792c1cbc9323b39b5e18f" +
      "c70742a12bae439765000000000000606a7bf8e8cc10bb75f3b404adaf02ca5cc39b" +
      "94cddf6cc56c60081dd5012ffe85b21c62ffff001d0178353b0000002047d4e44d16" +
      "4b7e98c15fd6bfc32c4dbb6bd0ef8bf47012d84006405500000000b3d6911ee43df5" +
      "ba0469ec212fcc6f93914df6dbe332c4c3cbb9c2791548e5f136b71c62ffff001dd3" +
      "769b64040000204fd0926c332cee9eaf06c34458d31e4050a2fd784cf9e91168336b" +
      "d8000000000dd4218907211ade52ff92d6bd555e7dd387adfd25963efee347a16325" +
      "1a43321fbc1c62ffff001dc03a633304e00020732d33ea35d62f9488cff5d64c0d70" +
      "2afd5d88092230ddfcc45f000000000000196283ba24a3f5bad91ef95338aa6d214c" +
      "934f2c1392e39a0447377fe5b0a04be7c01c62ffff001df0be0a27040000206c318b" +
      "23e5c42e86ef3edd080e50c9c233b9f0b6d186bd57e41300000000000021fb8cda20" +
      "0bff4fec1338d85a1e005bb4d729d908a7c5c232ecd0713231d0445ec11c62ed3e03" +
      "1a7b43466e04e00020f416898d79d4a46fa6c54f190ad3d502bad8aa3afdec0714aa" +
      "000000000000000603a5cc15e5906cb4eac9f747869fdc9be856e76a110b4f87da90" +
      "db20f9fbe28fc11c62ed3e031a15dfc3db",
    coinbasePreimage:
      "0xabc0ac43547a3a244029426af5c504977e12108c550a66c860ecda9f747c23c9",
    coinbaseProof:
      "0xf39ec977d14627922174b2c244ea624ab78a6e0c2d43d861a8fcedf0023a8d2d6a" +
      "1792d122d5fd4614a4d8a1810a77ff2a4676f8e8ab92b0a5fc4288f5eadd4b372b4e" +
      "9030edd9d92b7125dba777fca86a4d73614ce0e1621b1bf48c1eb0a2c553330e3fae" +
      "9a71acecb7425e8dbe88cdfd7fc3258bac4e21ca1dec42e5094271c77932609c51fb" +
      "4b82497ed599d3c413c4fd023009716b3e5e885d89c31a1f30bb46106bac1034c65f" +
      "01d80ac402417373daf1fbae0d43041c67b948f47882b27c802a4e791504be4b1b71" +
      "80a788a54659799bedbc712e23a816cae0a12c017b838b1655583043a9c8d30399d3" +
      "f81e7e0fe2121a3c38490845174140a08ff6dc",
  },

  chainDifficulty: 1,
}
