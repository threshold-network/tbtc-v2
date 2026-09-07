import type { BigNumber, BigNumberish, BytesLike } from "ethers"
import { walletState } from "../fixtures"

// TODO: All explanatory comments regarding redemption math assumes the
//       `redemptionTxMaxFee` is 1000 satoshi. It has been changed to 10000
//       so all comments need to be adjusted accordingly. Preferably, in a
//       way that will eliminate the need of adjustments in case this parameter
//       is changed again (e.g. it can be expressed as a parameter
//       not a specific value).

/**
 * Represents a set of data used for given redemption scenario.
 */
export interface RedemptionTestData {
  /**
   * Wallet that makes the redemption transaction.
   */
  wallet: {
    publicKey?: BytesLike
    pubKeyHash: BytesLike
    state: BigNumberish
    pendingRedemptionsValue: BigNumberish
    ecdsaWalletID: BytesLike
  }

  /**
   * Redemption requests that are handled by the redemption transaction.
   */
  redemptionRequests: {
    redeemer: string
    redeemerOutputScript: BytesLike
    amount: BigNumberish
  }[]

  /**
   * Main UTXO data which are used as `mainUtxo` parameter during
   * `submitRedemptionProof` function call. Main UTXO must exist for given
   * wallet in order to make the redemption proof possible
   */
  mainUtxo: {
    txHash: BytesLike
    txOutputIndex: number
    txOutputValue: BigNumberish
  }

  /**
   * Redemption transaction data passed as `redemptionTx` parameter during
   * `submitRedemptionProof`function call.
   */
  redemptionTx: {
    hash: BytesLike
    version: BytesLike
    inputVector: BytesLike
    outputVector: BytesLike
    locktime: BytesLike
  }

  /**
   * Redemption proof data passed as `redemptionProof` parameter during
   * `submitRedemptionProof` function call.
   */
  redemptionProof: {
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

/**
 * Container for TBTC balance change during redemption test scenario.
 */
export interface RedemptionBalanceChange {
  beforeProof: bigint
  afterProof: bigint
}

/**
 * `SinglePendingRequestedRedemption` test data represents a redemption with
 *  the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 1 redemption request handled by 1 output
 * - Redemption dust threshold is 100000 satoshi
 * - Treasury fee for each request is 0% of the requested amount
 * - Maximum transaction fee for each request is 1000 satoshi
 * - Total requested amount for all requests is 1177424 satoshi
 * - Total treasury fee for all requests is 0 satoshi
 * - Total redeemable amount for all requests is 1177424 satoshi
 * - No change output
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const SinglePendingRequestedRedemption: RedemptionTestData = {
  wallet: {
    publicKey:
      "0xee067a0273f2e3ba88d23140a24fdb290f27bbcd0f94117a9c65be3911c5c04efc314aa6ecfea6a43232df446014c41fd7446fe9deed7c2b054f7ea36e396306",
    pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    state: walletState.Live,
    pendingRedemptionsValue: 0,
    // Uncompressed public key for the pubKeyHash `0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726`:
    //    04ee067a0273f2e3ba88d23140a24fdb290f27bbcd0f94117a9c65be3911c5c04efc314aa6ecfea6a43232df446014c41fd7446fe9deed7c2b054f7ea36e396306
    // X: ee067a0273f2e3ba88d23140a24fdb290f27bbcd0f94117a9c65be3911c5c04e
    // Y: fc314aa6ecfea6a43232df446014c41fd7446fe9deed7c2b054f7ea36e396306
    // ecdsaWalletID = keccak256(XY)
    ecdsaWalletID:
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
  },

  redemptionRequests: [
    {
      redeemer: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
      redeemerOutputScript:
        // P2SH with address 2N5WZpig3vgpSdjSherS2Lv7GnPuxCvkQjT
        "0x17a91486884e6be1525dab5ae0b451bd2c72cee67dcf4187",
      amount: 1177424, // Accepts outputs in range [1176424, 1177424]
    },
  ],

  mainUtxo: {
    txHash:
      "0xb69a2869840aa6fdfd143136ff4514ca46ea2d876855040892ad74ab8c527422",
    txOutputIndex: 1,
    txOutputValue: 1177424,
  },

  // https://live.blockcypher.com/btc-testnet/tx/70d4182e795ebb0ddd8339ed9c0213d6e48f7cb6c956ced03c49f554a93a5669
  redemptionTx: {
    hash: "0x69563aa954f5493cd0ce56c9b67c8fe4d613029ced3983dd0dbb5e792e18d470",
    version: "0x01000000",
    inputVector:
      "0x01b69a2869840aa6fdfd143136ff4514ca46ea2d876855040892ad74ab8c527422" +
      "0100000000ffffffff",
    outputVector:
      "0x015cf511000000000017a91486884e6be1525dab5ae0b451bd2c72cee67dcf4187",
    locktime: "0x00000000",
  },

  redemptionProof: {
    merkleProof:
      "0xba19ac24192479ac72000fe4500ec87f7b8cf994e90f42c3e66e70f9decfd81aee" +
      "743b1c3a6935e4d157221fc36e6e24182ed94fc23f4f5268d51c9c7625acebc65c9b" +
      "4a0e8e4eb52a89852aeaa1f935058620ccff4ade5fb5e05524ae727dfcaa9004792a" +
      "281959ca2c8b6839135ee645353783f4c6c7d358acf3f4a83f819dec4effe91462dc" +
      "fbc0d0ed6b4cc38e5470eaf5b450481482d9201a4fd870f9ec81aa88378f3e2aab62" +
      "de93105ed1563a8b3fca7995f9828a9042639680d0e49488cb14eabe41276f4ed8f8" +
      "7527690fb7f83b3b9abb170e1aadac941b53c29ec09e85514a6844e864397ded279e" +
      "f4ace9833195f112cff129626f30a1bbc9b22f",
    txIndexInBlock: 33,
    bitcoinHeaders:
      "0x00000020f47db0755dc684d17088c20b5d0cfdd2a637c0c1d611616f9cd868b100" +
      "00000084349634f8489675c4ac31b82f66f3c6ea369f328e8dc08716d245a0a01bfa" +
      "ba1a161662ffff001dab708bb90000002031b92d92aa302ad2a73058eaaa09ebfad1" +
      "4be89cae782709e197b352000000009e5528a66f13a86be6f61937d478d696c9cae9" +
      "ebce6649bf80b0b0be070f3cb1e51a1662ffff001d55d83989",
    coinbasePreimage:
      "0x1018aff8b5b26a490019baaf21f07537579b2fb1115a98b1d65e8f081daecf8d",
    coinbaseProof:
      "0x3cdb38fcae7871f6556eca26234b0782b2fc2ff9a378a14de87570eb021f3c0733" +
      "714c0422b3998b56e8220a035623dcc0fd215ad3b21762d49e747541f3b59df923e2" +
      "4ed58acc72c65c3b39c42271bac0ac8de235424dfc8273462923da1f8c828c15abfe" +
      "98aa267f51310bc19e0f7c57064d67146649cf2bf33ceaa378eb4724dec7e1eedc6e" +
      "10d070b2c71c04b6a319aefd8a39baef0a5df06d9f0360befee0a0f056d6676e5dcf" +
      "a23f0babb04b955c95cec0e416d8b7b2a71f1e7939c0a788cb14eabe41276f4ed8f8" +
      "7527690fb7f83b3b9abb170e1aadac941b53c29ec09e85514a6844e864397ded279e" +
      "f4ace9833195f112cff129626f30a1bbc9b22f",
  },

  chainDifficulty: 1,
}

/**
 * `SingleNonRequestedRedemption` test data represents a redemption with
 *  the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 0 redemption requests
 * - 1 P2SH output with value 1176924 satoshi and index 0, pointing to a
 *   non-requested output script. This output is not a change output.
 * - 6+ on-chain confirmations of the redemption transaction
 *
 * Basically, this is the `SinglePendingRequestedRedemption` data set with
 * empty `redemptionRequests` array to simulate the situation where the
 * redemption transaction output is non-requested.
 */
export const SingleNonRequestedRedemption: RedemptionTestData = {
  ...SinglePendingRequestedRedemption,
  redemptionRequests: [],
}

/**
 * `SingleP2PKHChange` test data represents a redemption with
 *  the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 0 redemption requests
 * - 1 P2PKH change output with value 1860981 satoshi and index 0.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const SingleP2PKHChange: RedemptionTestData = {
  wallet: {
    pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    state: walletState.Live,
    pendingRedemptionsValue: 0,
    ecdsaWalletID:
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
  },

  redemptionRequests: [],

  mainUtxo: {
    txHash:
      "0x21dd23c4f92f2438dbd793abe8f9614b95c62ec9b3987167414cfb76437d658d",
    txOutputIndex: 0,
    txOutputValue: 1865981,
  },

  // https://live.blockcypher.com/btc-testnet/tx/37a56c64e1c2f98f68445fc4a788e9de14f02d521b6fd2eb9bac7fd9e5c8bf3a
  redemptionTx: {
    hash: "0x3abfc8e5d97fac9bebd26f1b522df014dee988a7c45f44688ff9c2e1646ca537",
    version: "0x01000000",
    inputVector:
      "0x0121dd23c4f92f2438dbd793abe8f9614b95c62ec9b3987167414cfb76437d658d" +
      "0000000000ffffffff",
    outputVector:
      "0x0175651c00000000001976a9147ac2d9378a1c47e589dfb8095ca95ed2140d2726" +
      "88ac",
    locktime: "0x00000000",
  },

  redemptionProof: {
    merkleProof:
      "0x8173541bf1b41a149d5e3af1a03924ac63fd603453bd26ee3a0e1bfc4c7272402b" +
      "aeaf690b864662b21f859e7306d62b0f7217c5534513310627e879c81b9ef3a760cb" +
      "a8efb31548ccba301a743cf2191593cd6aee7c0f46c659a88730fbcbd93d869e69dd" +
      "3d5ea610e6e3a5a7532cb7dfd7ce4178b027ad7b6a43f224139a35f1e379ae391326" +
      "4e23e771f8023a368933dc7701d743b031d53c38d853bedb84a4ad8bb7f8914887f5" +
      "d005fabf461a9fa4bec297bfd9c0b97e4351f9b24f9b6767aa0c6f356050fd9f4f60" +
      "13d3de554b7ea41170c84d6796becfeca6219bce6e",
    txIndexInBlock: 4,
    bitcoinHeaders:
      "0x0400002018bdadfc1236dfb54cb41536f32a89c374b3758f3f73258ce701000000" +
      "0000006e1ef1198d8ab725c9e56673b975e0e120552635040f809030c40b537b2218" +
      "15329e1c62ed3e031a5a6c5ee3040000209c3a847816fd334498120ef00b9375cf63" +
      "ae0fe8312799b09601000000000000c59b48b799e40b3e33bb52e4c05090e4da777d" +
      "bfb6cfa5bdfa9745a4f70758a0bca11c62ed3e031a50e50bb0040000203d750b7791" +
      "e966eaff01bb37f805bf33bc1416d2761b2ed0d902000000000000ebd895e4c2d055" +
      "f159e4ea620b92d82f6f9138c40342bb98138b1f47130a2917fba21c62ed3e031aec" +
      "283a06040000207df899accdbcd2d34fad622e9322e37de0d97ed833c9a90c9a0000" +
      "0000000000338ff96ba92b753253d31c12fa4c5729c0c40fd9198bdcabc22d97e2cb" +
      "4255945fa51c62ed3e031a2b928d570400002025141e65f673c2fb018d715d56357e" +
      "86c67f14c7993e3dcce402000000000000288854f0aef4ca27bffceacbd14124d697" +
      "3a6ab31fb49044344b6131dc52dfd7eca81c62ed3e031a8188640004e00020176fb6" +
      "202fac66facb3155eebc5d9f26155c5f6074d0d298af01000000000000175ff6b2d5" +
      "fd0ec570f00de4b5b8e45862280926762546123a8c70241e069e50d4ad1c62ffff00" +
      "1d7609709f00000020d6a19088bdad8792c1cbc9323b39b5e18fc70742a12bae4397" +
      "65000000000000606a7bf8e8cc10bb75f3b404adaf02ca5cc39b94cddf6cc56c6008" +
      "1dd5012ffe85b21c62ffff001d0178353b",
    coinbasePreimage:
      "0xbe182b81f95921559e214e976ca947eee92589684d37a465a089d611e47ba058",
    coinbaseProof:
      "0x5c3de44ab1941b47887c5cced838b12be88aeeb1ae2827b8ecd569b12b38c61e35" +
      "c06d46c1eafdb2c0c8d25a74964cfaa148c22e6a155dd553331b88f3c5aa11f46ec2" +
      "2905bd12aefbaf49a3c29f88ff5a9ca04cf29f66e59440dc29841abaf53d869e69dd" +
      "3d5ea610e6e3a5a7532cb7dfd7ce4178b027ad7b6a43f224139a35f1e379ae391326" +
      "4e23e771f8023a368933dc7701d743b031d53c38d853bedb84a4ad8bb7f8914887f5" +
      "d005fabf461a9fa4bec297bfd9c0b97e4351f9b24f9b6767aa0c6f356050fd9f4f60" +
      "13d3de554b7ea41170c84d6796becfeca6219bce6e",
  },

  chainDifficulty: 5168815,
}

/**
 * `SingleP2WPKHChange` test data represents a redemption with
 *  the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 0 redemption requests
 * - 1 P2WPKH change output with value 1669207 satoshi and index 0.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const SingleP2WPKHChange: RedemptionTestData = {
  wallet: {
    pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    state: walletState.Live,
    pendingRedemptionsValue: 0,
    ecdsaWalletID:
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
  },

  redemptionRequests: [],

  mainUtxo: {
    txHash:
      "0x4ea443470719332172aad3106f64bb84746a4c7749619106912f70b2999ee674",
    txOutputIndex: 1,
    txOutputValue: 1674207,
  },

  // https://live.blockcypher.com/btc-testnet/tx/6b23f63b19510d2ea6c115757a791ccf196e36c14ae82cd1f9970293af186542
  redemptionTx: {
    hash: "0x426518af930297f9d12ce84ac1366e19cf1c797a7515c1a62e0d51193bf6236b",
    version: "0x01000000",
    inputVector:
      "0x014ea443470719332172aad3106f64bb84746a4c7749619106912f70b2999ee674" +
      "0100000000ffffffff",
    outputVector:
      "0x0157781900000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    locktime: "0x00000000",
  },

  redemptionProof: {
    merkleProof:
      "0x6f259cb4f10f7ebc91cd3a35cda5b8556e4ec5a917c508735db4b44c81ad19ec2d" +
      "eba03ae759d417a88f6a0c32effe91887026ceb0b6d4e0dccb7bfe93aeb1d6232ff0" +
      "ab7143ecb80f6f0f105cfd1a9dfbff1f8c044859b9b0978ba4029a8941d1336f6737" +
      "a694d5bb331e9af4a30d2802b2554d9cae8a42db6f3ebeb82fb016c03995af265559" +
      "b2da3a6aa71280db9ba200ba388138903ff9b6424a9712cc24b7f47dd86fe601e56b" +
      "a3924f08419e394895420a8af4230fa278d82d3acba2fb23926f8cc44b7c955d0473" +
      "694be2b1361431507e3092134e6ce1ce2d3a5d6595",
    txIndexInBlock: 3,
    bitcoinHeaders:
      "0x040000209c3a847816fd334498120ef00b9375cf63ae0fe8312799b09601000000" +
      "000000c59b48b799e40b3e33bb52e4c05090e4da777dbfb6cfa5bdfa9745a4f70758" +
      "a0bca11c62ed3e031a50e50bb0040000203d750b7791e966eaff01bb37f805bf33bc" +
      "1416d2761b2ed0d902000000000000ebd895e4c2d055f159e4ea620b92d82f6f9138" +
      "c40342bb98138b1f47130a2917fba21c62ed3e031aec283a06040000207df899accd" +
      "bcd2d34fad622e9322e37de0d97ed833c9a90c9a00000000000000338ff96ba92b75" +
      "3253d31c12fa4c5729c0c40fd9198bdcabc22d97e2cb4255945fa51c62ed3e031a2b" +
      "928d570400002025141e65f673c2fb018d715d56357e86c67f14c7993e3dcce40200" +
      "0000000000288854f0aef4ca27bffceacbd14124d6973a6ab31fb49044344b6131dc" +
      "52dfd7eca81c62ed3e031a8188640004e00020176fb6202fac66facb3155eebc5d9f" +
      "26155c5f6074d0d298af01000000000000175ff6b2d5fd0ec570f00de4b5b8e45862" +
      "280926762546123a8c70241e069e50d4ad1c62ffff001d7609709f00000020d6a190" +
      "88bdad8792c1cbc9323b39b5e18fc70742a12bae439765000000000000606a7bf8e8" +
      "cc10bb75f3b404adaf02ca5cc39b94cddf6cc56c60081dd5012ffe85b21c62ffff00" +
      "1d0178353b",
    coinbasePreimage:
      "0x188f26561af868b490b38420f0dec3a832087e1f8972c004302c37875ecb069e",
    coinbaseProof:
      "0x73b2f5ca5ab9ca707a351683d1d9ef3a8a0ce7179c96e05fa3708a2766b444bda7" +
      "73cdc166de5592852ba143c115d6488cc3b630468aafeeade7898d7481354d232ff0" +
      "ab7143ecb80f6f0f105cfd1a9dfbff1f8c044859b9b0978ba4029a8941d1336f6737" +
      "a694d5bb331e9af4a30d2802b2554d9cae8a42db6f3ebeb82fb016c03995af265559" +
      "b2da3a6aa71280db9ba200ba388138903ff9b6424a9712cc24b7f47dd86fe601e56b" +
      "a3924f08419e394895420a8af4230fa278d82d3acba2fb23926f8cc44b7c955d0473" +
      "694be2b1361431507e3092134e6ce1ce2d3a5d6595",
  },

  chainDifficulty: 5168815,
}

/**
 * `SingleP2SHChange` test data represents a redemption with
 *  the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 0 redemption requests
 * - 1 illegal P2SH change output with value 1664207 satoshi and index 0.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const SingleP2SHChange: RedemptionTestData = {
  wallet: {
    pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    state: walletState.Live,
    pendingRedemptionsValue: 0,
    ecdsaWalletID:
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
  },

  redemptionRequests: [],

  mainUtxo: {
    txHash:
      "0x426518af930297f9d12ce84ac1366e19cf1c797a7515c1a62e0d51193bf6236b",
    txOutputIndex: 0,
    txOutputValue: 1669207,
  },

  // https://live.blockcypher.com/btc-testnet/tx/588a0e5e68ec8d3cf80d1190e51a68a431737a33c3a09f16303945dd49e369cd
  redemptionTx: {
    hash: "0xcd69e349dd453930169fa0c3337a7331a4681ae590110df83c8dec685e0e8a58",
    version: "0x01000000",
    inputVector:
      "0x01426518af930297f9d12ce84ac1366e19cf1c797a7515c1a62e0d51193bf6236b" +
      "0000000000ffffffff",
    outputVector:
      "0x01cf6419000000000017a9147ac2d9378a1c47e589dfb8095ca95ed2140d272687",
    locktime: "0x00000000",
  },

  redemptionProof: {
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

/**
 * `SingleP2WPKHChangeZeroValue` test data represents a redemption with
 *  the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 0 redemption requests
 * - 1 P2WPKH change output with value 0 satoshi and index 0.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const SingleP2WPKHChangeZeroValue: RedemptionTestData = {
  wallet: {
    pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    state: walletState.Live,
    pendingRedemptionsValue: 0,
    ecdsaWalletID:
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
  },

  redemptionRequests: [],

  mainUtxo: {
    txHash:
      "0x110287e803db207b764a41ac01c98448ed34512eeafce15435c4667775af9ac5",
    txOutputIndex: 1,
    txOutputValue: 1616808,
  },

  // https://live.blockcypher.com/btc-testnet/tx/b8cdeb9f25bac990f233f0c10ccfb4335ca867996a9a7e43d69fa2f730a5b10f
  redemptionTx: {
    hash: "0x0fb1a530f7a29fd6437e9a6a9967a85c33b4cf0cc1f033f290c9ba259febcdb8",
    version: "0x01000000",
    inputVector:
      "0x01110287e803db207b764a41ac01c98448ed34512eeafce15435c4667775af9ac5" +
      "0100000000ffffffff",
    outputVector:
      "0x0100000000000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    locktime: "0x00000000",
  },

  redemptionProof: {
    merkleProof:
      "0x5e7abe1d2ffbeb05646d6af26119f9123142e3bddef55f019dc040a49434abf0f0" +
      "c416f0a505a0b45b138d1ebe22b1864399fd7a79bb8564024a88e3d75ec9a438556b" +
      "409052d83bbea2e19ae9134ddf709c030006524e474bc5ff8ee0d48198e86c92f167" +
      "0878ff5e7bd6c50d8685dfc99775e1addea552e0d0c7d507e6168f77815fd2a8616c" +
      "a48da4c0c82f9b7d6d8523ec31172366536ee4f6fb476409cc2c103aa580e8e304ba" +
      "7888e4d571088d801701c932dbfdb7aa5147089ca042992c69c7a840dfc2830b8f05" +
      "3ed5add244d4a03e995fe3875dbaee5350e03d30f2",
    txIndexInBlock: 1,
    bitcoinHeaders:
      "0x0400002040f4c65610f26f06c4365305b956934501713e01c2fc08b919e0bc1b0000" +
      "0000e401a6a884ba015e83c6fe2cd363e877ef03982e81eaff4e2c95af1e23a670f4" +
      "07d41c62ffff001d58c64d180400002038854bd62f802e1de14653eceeb7a80290f5" +
      "e99b8e9db517e36f000000000000a494b8034039e7855b75563ab83c9410dd67e89b" +
      "b58e6cd93b85290a885dd749f4d61c62ed3e031ad9a8374604000020ace542174988" +
      "4ead62a4c1ab007a064027fa2bfe4772f95f5f010000000000004cc59275b1fafab7" +
      "6df130064ea7b4f5e3fd1975bccac22395de1de47e105ec4abd91c62ed3e031aadb3" +
      "548c04e000209fd2f97b6a59c0ad71482b5f47cf9a2fab73d2335ba76eb48d020000" +
      "000000007c0e5aa9a87938e8466a8f1e662b246ce77784d4d7d9e9786bb7e5586fb3" +
      "d55445da1c62ed3e031a9c24b2d104e000205f34585d5251ffe2fd6590493a12bda6" +
      "1edf72a80256c71d1d010000000000002d61efa332cacb6c46e462907c85bad78b7d" +
      "a1218093061cbc1040d1c1e4db44aedc1c62ed3e031ad3ccc6d404e000209ff4c7e5" +
      "2245adb02a374dc04fa6346f5414057eb34a31f5770100000000000054640481f7e6" +
      "7a6abd11f41447de82c9ab4cfc36c1b08a69eec70c531af406d260dd1c62ed3e031a" +
      "d1cead8e04e000205eb6c71da390799a93d726debb7d2d24234fd10698ea6ac9fd00" +
      "000000000000326f7b757f161a464819a058635a5419d15f7fea715a3520f1cb546a" +
      "f661d3f85ade1c62ed3e031aa446a827",
    coinbasePreimage:
      "0xcc3bb44bcd05333864cc205b3754578cdeaa8f750146da4acc145e74d8e9213b",
    coinbaseProof:
      "0x0fb1a530f7a29fd6437e9a6a9967a85c33b4cf0cc1f033f290c9ba259febcdb8f0" +
      "c416f0a505a0b45b138d1ebe22b1864399fd7a79bb8564024a88e3d75ec9a438556b" +
      "409052d83bbea2e19ae9134ddf709c030006524e474bc5ff8ee0d48198e86c92f167" +
      "0878ff5e7bd6c50d8685dfc99775e1addea552e0d0c7d507e6168f77815fd2a8616c" +
      "a48da4c0c82f9b7d6d8523ec31172366536ee4f6fb476409cc2c103aa580e8e304ba" +
      "7888e4d571088d801701c932dbfdb7aa5147089ca042992c69c7a840dfc2830b8f05" +
      "3ed5add244d4a03e995fe3875dbaee5350e03d30f2",
  },

  chainDifficulty: 1,
}

/**
 * `SingleProvablyUnspendable` test data represents a redemption with
 *  the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 0 redemption requests
 * - 1 provably unspendable output with value 0 satoshi and index 0.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const SingleProvablyUnspendable: RedemptionTestData = {
  wallet: {
    pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    state: walletState.Live,
    pendingRedemptionsValue: 0,
    ecdsaWalletID:
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
  },

  redemptionRequests: [],

  mainUtxo: {
    txHash:
      "0xc83c538a70028dd9fd40d7e8be0d05dc414a95927eb52df895e9d0c424786c53",
    txOutputIndex: 0,
    txOutputValue: 1914700,
  },

  // https://live.blockcypher.com/btc-testnet/tx/58a7d94d019aa658d00dfa2b5d5bb6b5d627b71afefff2bda5db501a75981fd3
  redemptionTx: {
    hash: "0xd31f98751a50dba5bdf2fffe1ab727d6b5b65b5d2bfa0dd058a69a014dd9a758",
    version: "0x01000000",
    inputVector:
      "0x01c83c538a70028dd9fd40d7e8be0d05dc414a95927eb52df895e9d0c424786c53" +
      "0000000000ffffffff",
    outputVector:
      "0x010000000000000000176a0f6d6f6e6579627574746f6e2e636f6d0568656c6c6f",
    locktime: "0x00000000",
  },

  redemptionProof: {
    merkleProof:
      "0x905ff7ee49bf6e4290d4045f19317130044e77241b4b38fb3c8c1f1413b8a89574" +
      "ebfb6efeabf05d65f5ad9cc1f8355d2a00a4ca22d7c7a0e0cabc0d6a4c6c00db10e3" +
      "b9f542c6eeb6ec38df9acba0726e452cf50d19b285b5ebb60e2faafb24ea8a2604cc" +
      "8f08c7ab494f4619e240bcc91e91174432a07809ffbfa579e931c16ccbdff6587298" +
      "eb5a02da3f1afc3d5f0ccc06ddad31690cae99d9261218fa4f76e3bd2c3157089f5f" +
      "4586201fccd2ebcc75db72b46fc7a026de0ac5dd7a8245",
    txIndexInBlock: 1,
    bitcoinHeaders:
      "0x040000201d7a507f86c714fd747e45078096087c65bcabb8e6defa98b433000000" +
      "000000d27279d16f4ef9b10ab2fd0b20be00cf380f9e1d4409d1577822cffbd65989" +
      "d9cb081e62ed3e031ab61e9f5600000020b811a75ec03812f7a0b8580b73282afd59" +
      "6ed9d2b0a9b1c79700000000000000538ba47e9eade7963da25fa640d87a2234489f" +
      "a60741fb2ba89efab52e442b77810d1e62ffff001de0c4afc504e00020342898739f" +
      "1e6ac6e8fe86dc3584fe8f21e5bef01dc714033a20ad3300000000910830b662c217" +
      "5c9a41b3377d072a2b0290d5e44e8a40e038acae63171d216b140f1e62ed3e031a32" +
      "b4b5e000000020345c4a1f645e26da4ec35cbc52543c6871e526b0a6c52070a30200" +
      "00000000002160037975ec5f355cba38f4e9e2a98d8271bba7844a313fb5cb91709a" +
      "4b4c0ee6131e62ffff001da0bddd2404000020667e4f0e217d2f2dd4d5fdcfb27857" +
      "bdd3ae0c643a036897e762a99600000000f189c5237d6d5e15214a7f4d0ad6b82ac1" +
      "522a1b1ee93bc4c76ab169462f26c308161e62ed3e031af4b78af704e00020968648" +
      "2db903e6880604162d4ecedb113e5e0895131dcb608900000000000000d3d4eeb630" +
      "cc71bb0ebf76822c95e19b3d0046ad01b74b6941507b5beaa1cf67db191e62ed3e03" +
      "1a0040a522040000208d370c6f9d47eaf0c1ab779a5b811838a61403def157972e35" +
      "0300000000000080b93554feec4b0c497738f604526bf990bb8924c538f58f030f3a" +
      "ff72bc0347e91b1e62ed3e031a07543bdf",
    coinbasePreimage:
      "0xbe4f2b21aad7b8771a7079791afe7264e8943a1aa1e6587c4bb91440ab841bd5",
    coinbaseProof:
      "0xd31f98751a50dba5bdf2fffe1ab727d6b5b65b5d2bfa0dd058a69a014dd9a75874" +
      "ebfb6efeabf05d65f5ad9cc1f8355d2a00a4ca22d7c7a0e0cabc0d6a4c6c00db10e3" +
      "b9f542c6eeb6ec38df9acba0726e452cf50d19b285b5ebb60e2faafb24ea8a2604cc" +
      "8f08c7ab494f4619e240bcc91e91174432a07809ffbfa579e931c16ccbdff6587298" +
      "eb5a02da3f1afc3d5f0ccc06ddad31690cae99d9261218fa4f76e3bd2c3157089f5f" +
      "4586201fccd2ebcc75db72b46fc7a026de0ac5dd7a8245",
  },

  chainDifficulty: 5168815,
}

/**
 * `MultiplePendingRequestedRedemptions` test data represents a
 * redemption with the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 5 redemption requests handled by 5 outputs
 * - Redemption dust threshold is 100000 satoshi
 * - Treasury fee for each request is 0% of the requested amount
 * - Maximum transaction fee for each request is 1000 satoshi
 * - Total requested amount for all requests is 959845 satoshi
 * - Total treasury fee for all requests is 0 satoshi
 * - Total redeemable amount for all requests is 959845 satoshi
 * - No change output
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const MultiplePendingRequestedRedemptions: RedemptionTestData = {
  wallet: {
    pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
    state: walletState.Live,
    pendingRedemptionsValue: 0,
    ecdsaWalletID:
      "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
  },

  redemptionRequests: [
    {
      redeemer: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
      redeemerOutputScript:
        // P2PKH with address mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc
        "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
      amount: 191969, // Accepts outputs in range [190969, 191969]
    },
    {
      redeemer: "0x208fF63189DF8749780917Cb5901183075Dbabc1",
      redeemerOutputScript:
        // P2WPKH with address tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx
        "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
      amount: 191969, // Accepts outputs in range [190969, 191969]
    },
    {
      redeemer: "0x35D54bC29e0a5170c3Ac73E64c7fA539A867f0FE",
      redeemerOutputScript:
        // P2SH with address 2MsM67NLa71fHvTUBqNENW15P68nHB2vVXb
        "0x17a914011beb6fb8499e075a57027fb0a58384f2d3f78487",
      amount: 191969, // Accepts outputs in range [190969, 191969]
    },
    {
      redeemer: "0x462418b7495561bF2872A0786109A11f5d494aA2",
      redeemerOutputScript:
        // P2WSH with address tb1qau95mxzh2249aa3y8exx76ltc2sq0e7kw8hj04936rdcmnynhswqqz02vv
        "0x220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c",
      amount: 191969, // Accepts outputs in range [190969, 191969]
    },
    {
      redeemer: "0x2219eAC966FbC0454C4A2e122717e4429Dd7608F",
      redeemerOutputScript:
        // P2PKH with address tb1qgzd40jy62dj5wadvmywfsxugq7f40wzek3p2g2
        "0x160014409b57c89a53654775acd91c981b88079357b859",
      amount: 191969, // Accepts outputs in range [190969, 191969]
    },
  ],

  mainUtxo: {
    txHash:
      "0x293fa48ff644e009d77edbab49c42ec0bfb3d5dbc1a63be4a8200a442f3dd910",
    txOutputIndex: 1,
    txOutputValue: 959845,
  },

  // https://live.blockcypher.com/btc-testnet/tx/2724545276df61f43f1e92c4b9f1dd3c9109595c022dbd9dc003efbad8ded38b
  redemptionTx: {
    hash: "0x8bd3ded8baef03c09dbd2d025c5909913cddf1b9c4921e3ff461df7652542427",
    version: "0x01000000",
    inputVector:
      "0x01293fa48ff644e009d77edbab49c42ec0bfb3d5dbc1a63be4a8200a442f3dd910" +
      "0100000000ffffffff",
    outputVector:
      "0x05c1ea0200000000001976a9142cd680318747b720d67bf4246eb7403b476adb34" +
      "88acc1ea020000000000160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0c1" +
      "ea02000000000017a914011beb6fb8499e075a57027fb0a58384f2d3f78487c1ea02" +
      "0000000000220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0" +
      "db8dcc93bc1cc1ea020000000000160014409b57c89a53654775acd91c981b880793" +
      "57b859",
    locktime: "0x00000000",
  },

  redemptionProof: {
    merkleProof:
      "0x2428f139454babb4dd0ade40cda91396939ab1829667366dd4846c038fbbdc75d8" +
      "4a8cd89502647f735744073451608ca65b9c06892bdf5e0c43661c27d65a0ef81d91" +
      "1bd0f872a981db7bb275462c9833ef38947bc3d4e7de5ace761a0b41b5378e1cbb2d" +
      "736a46edf5a1ad468aa43d78ef54a29520f00cdf28055ac6c2d244722c6ce263a149" +
      "11cb822af4f47df841ffd49ad0a71386aa77ee8cf928b1c4eac58c250144d521714f" +
      "1912234352f6b3d2cdb9aa0eb15906e654e614e41f27949890c4dad981a4059b49ae" +
      "453c3a86f3ea4dc4b9cae9448f22dfab86f2c4d8d6",
    txIndexInBlock: 10,
    bitcoinHeaders:
      "0x00e000208e5be9fe4ed15e6c6a7a8cc08097cd0640ffd7366400b5ac9102000000" +
      "0000004e68ad19a9e51e7765e90e2c5294b13815f68cfb5d229da27db5e32ee17811" +
      "81e53e1f62ed3e031a503805b900e0ff3fa13b993888d9b00afe2920b3082b3ee32f" +
      "d3c9129015d2be8e00000000000000734a268c3bf100e3dea62dae18539b95d66979" +
      "03d11f11cc179ac81fcc28eef83e401f62ed3e031aef1334c704000020d1af2de20c" +
      "23ab97a2004d2eee5392e4e5f347b076a5c0e28d010000000000005e9ef6c94f4a36" +
      "d51f3a3fcf5f224ec146ccb62b3d682911b293595f7d933c00f4431f62ed3e031a00" +
      "0623c004e000207128bbf2522463e26b2fc2381e392a5ec4f38e4745803bdd240100" +
      "00000000008a55f861ddfaeafabdc92a2247f42d4f5092ea518ce538c1ddf3d3126d" +
      "bcea0feb481f62ffff001d9024592704e0002092512fbed5e628e84b71a9a2218c3c" +
      "7cb4e4078d2acac285721a0000000000002f3c27c1e3ff97634d16309bdbd8afd33d" +
      "e0bb5a8847d4fcb8c3b8ecde48f60af14c1f62ed3e031acfa38bf804000020edfc36" +
      "9559440cd684a29979886a04b2f6916752ccdd03d62a010000000000006e4051acfe" +
      "63b73a0b7900c2da41f0b92f694f5a0e2982b279fc5ca734070b13d6511f62ffff00" +
      "1ddaf20d1e",
    coinbasePreimage:
      "0xa74d6b6e329da2533eeb508973afbc205aa15ef7175e031182a1bfa4ec97564a",
    coinbaseProof:
      "0x7e86096fa5355d29a760f5670b3673338725f7f3e7bbc79d31d415d82603643578" +
      "64bd5a585002df5bae674fa1d207094cccfba1a61b3e4c99981b4c33612f6897a1b6" +
      "c268417668b10ad46bad565a97253868f7efa4462f865788c026552ec7d28ad77057" +
      "b9bc71fefa8b6ff2e7ed5bc42524be5e9c4efa2c55dfc3ff0dccb8722c6ce263a149" +
      "11cb822af4f47df841ffd49ad0a71386aa77ee8cf928b1c4eac58c250144d521714f" +
      "1912234352f6b3d2cdb9aa0eb15906e654e614e41f27949890c4dad981a4059b49ae" +
      "453c3a86f3ea4dc4b9cae9448f22dfab86f2c4d8d6",
  },

  chainDifficulty: 5168815,
}

/**
 * `MultiplePendingRequestedRedemptionsWithP2WPKHChange` test data represents a
 * redemption with the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 5 redemption requests handled by 5 outputs
 * - Redemption dust threshold is 100000 satoshi
 * - Treasury fee for each request is 0.05% of the requested amount
 * - Maximum transaction fee for each request is 1000 satoshi
 * - Total requested amount for all requests is 6435567 satoshi
 * - Total treasury fee for all requests is 3217 satoshi
 * - Total redeemable amount for all requests is 6432350 satoshi
 * - 1 P2WPKH change output with value 137130866 satoshi and index 5.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const MultiplePendingRequestedRedemptionsWithP2WPKHChange: RedemptionTestData =
  {
    wallet: {
      pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      state: walletState.Live,
      pendingRedemptionsValue: 0,
      ecdsaWalletID:
        "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
    },

    redemptionRequests: [
      {
        redeemer: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
        redeemerOutputScript:
          // P2PKH with address mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc
          "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
        amount: 900000, // Accepts outputs in range [898550, 899550]
      },
      {
        redeemer: "0x208fF63189DF8749780917Cb5901183075Dbabc1",
        redeemerOutputScript:
          // P2WPKH with address tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx
          "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
        amount: 1100000, // Accepts outputs in range [1098450, 1099450]
      },
      {
        redeemer: "0x35D54bC29e0a5170c3Ac73E64c7fA539A867f0FE",
        redeemerOutputScript:
          // P2SH with address 2MsM67NLa71fHvTUBqNENW15P68nHB2vVXb
          "0x17a914011beb6fb8499e075a57027fb0a58384f2d3f78487",
        amount: 1901000, // Accepts outputs in range [1899050, 1900050]
      },
      {
        redeemer: "0x462418b7495561bF2872A0786109A11f5d494aA2",
        redeemerOutputScript:
          // P2WSH with address tb1qau95mxzh2249aa3y8exx76ltc2sq0e7kw8hj04936rdcmnynhswqqz02vv
          "0x220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef27d4b1d0db8dcc93bc1c",
        amount: 1400000, // Accepts outputs in range [1398300, 1399300]
      },
      {
        redeemer: "0x2219eAC966FbC0454C4A2e122717e4429Dd7608F",
        redeemerOutputScript:
          // P2PKH with address tb1qgzd40jy62dj5wadvmywfsxugq7f40wzek3p2g2
          "0x160014409b57c89a53654775acd91c981b88079357b859",
        amount: 1134567, // Accepts outputs in range [1133000, 1134000]
      },
    ],

    mainUtxo: {
      txHash:
        "0x089bd0671a4481c3584919b4b9b6751cb3f8586dab41cb157adec43fd10ccc00",
      txOutputIndex: 5,
      txOutputValue: 143565433,
    },

    // https://live.blockcypher.com/btc-testnet/tx/05dabb0291c0a6aa522de5ded5cb6d14ee2159e7ff109d3ef0f21de128b56b94
    redemptionTx: {
      hash: "0x946bb528e11df2f03e9d10ffe75921ee146dcbd5dee52d52aaa6c09102bbda05",
      version: "0x01000000",
      inputVector:
        "0x01089bd0671a4481c3584919b4b9b6751cb3f8586dab41cb157adec43fd10ccc" +
        "000500000000ffffffff",
      outputVector:
        "0x0680b80d00000000001976a9142cd680318747b720d67bf4246eb7403b476adb" +
        "3488acc0c5100000000000160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1" +
        "d0c0fa1c000000000017a914011beb6fb8499e075a57027fb0a58384f2d3f78487" +
        "a059150000000000220020ef0b4d985752aa5ef6243e4c6f6bebc2a007e7d671ef" +
        "27d4b1d0db8dcc93bc1cc74c110000000000160014409b57c89a53654775acd91c" +
        "981b88079357b85972732c08000000001600147ac2d9378a1c47e589dfb8095ca9" +
        "5ed2140d2726",
      locktime: "0x00000000",
    },

    redemptionProof: {
      merkleProof:
        "0xb7b0a73b2881faf82b260dd5caee7ff9029dd21ee7954ba24a56a67c7b30a70c" +
        "20dcda19b54058448a427c6bf5c5fd4461dbace7f696bd86075b3638cb1c72c73f" +
        "3f1fbe47db0dc97dc7fbe31897f6b90029a2d34c6cbf5690ae1de9b6ff102f9140" +
        "a49dc08c454650297a2c8a60358aab4e81f52bc2fa1086ca29355c96940c",
      txIndexInBlock: 4,
      bitcoinHeaders:
        "0x0400002083e03e3c0c35fa762ece0064ccbb5c06e13d7aba7f07e303f1060000" +
        "0000000081b2e32fb8c258f68fd45fdd940ac23a03b86cb0e5e19c2fdb25229b77" +
        "70ac6d55720e6240b2321aeb12850604e0ff3fe631eefef3624c82ef84af1f3886" +
        "613c5a82c6523ab166b30a1000000000000038978553eace4776a2e57ff1443588" +
        "da6db64a656f99001925218aaf1b42f96e8e720e6240b2321a25c49ab704000020" +
        "8e3e4b82b0a7a6b170299ffbb7f4ffa59fe2882706bd7797f90400000000000058" +
        "fe1967710734d20a222b61a16884a27ce2f0c51638481b6ef4747061346647a672" +
        "0e6240b2321a2fffd42304e0ff2f5cb48be2329a7b7938506f3b4186784a89dac5" +
        "778565e7724e2e000000000000e97ecb1681efad3dae8ed580a23198f418bec19b" +
        "905637d9a77b546e1d6ff6f3ac720e6240b2321a505f792a04e0ff2fc27a057424" +
        "ddc6c5d0709b3c6c0e26cc0eb6b899eb788445bb1b000000000000d6f879319e59" +
        "1caf6498ddd884569f5669699716e684154bedd1ecb1c5ab55c0e4720e6240b232" +
        "1acdd9988904e0ff3fbc46c4f4e9351ec418b7f13dc1e542712efa97071f90ba5c" +
        "ee2e0000000000007805d109ea75113c91759d9d14ed26c0bff6fcb572dc0fdb63" +
        "8c862922ec2b9a05730e6240b2321ab9426ecc",
      coinbasePreimage:
        "0xd8749020ff33503736c84bb817a3c388f5bd9827b60c12a290f910227ce3386b",
      coinbaseProof:
        "0x1b7cbe3f0bbc692d69c45eb93b83cac2c21ea6e77edd2dc78f9c314108fab6b2" +
        "0a9827537d7d8e6b2d7d425998ef0773e7fb01531fce26ff15b8e06d74252547bd" +
        "0546192fecb12f00b512d00406c485c397d55be47c0bb14a4cbd8317d98eb59140" +
        "a49dc08c454650297a2c8a60358aab4e81f52bc2fa1086ca29355c96940c",
    },

    chainDifficulty: 330930,
  }

/**
 * `MultiplePendingRequestedRedemptionsWithP2SHChange` test data represents a
 * redemption with the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 2 redemption requests handled by 2 outputs
 * - Redemption dust threshold is 100000 satoshi
 * - Treasury fee for each request is 0.05% of the requested amount
 * - Maximum transaction fee for each request is 1000 satoshi
 * - Total requested amount for all requests is 600000 satoshi
 * - Total treasury fee for all requests is 600 satoshi
 * - Total redeemable amount for all requests is 599400 satoshi
 * - 1 illegal P2SH change output with value 488167 satoshi and index 2.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const MultiplePendingRequestedRedemptionsWithP2SHChange: RedemptionTestData =
  {
    wallet: {
      pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      state: walletState.Live,
      pendingRedemptionsValue: 0,
      ecdsaWalletID:
        "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
    },

    redemptionRequests: [
      {
        redeemer: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
        redeemerOutputScript:
          // P2PKH with address mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc
          "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
      {
        redeemer: "0x208fF63189DF8749780917Cb5901183075Dbabc1",
        redeemerOutputScript:
          // P2WPKH with address tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx
          "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
    ],

    mainUtxo: {
      txHash:
        "0xaa485c8a2fd30844d085cedb3a1b48d791a85bd7e8b5891f9c9f5c0f232ca1e9",
      txOutputIndex: 1,
      txOutputValue: 1088167,
    },

    // https://live.blockcypher.com/btc-testnet/tx/3ca4ae3f8ee3b48949192bc7a146c8d9862267816258c85e02a44678364551e1
    redemptionTx: {
      hash: "0xe15145367846a4025ec8586281672286d9c846a1c72b194989b4e38e3faea43c",
      version: "0x01000000",
      inputVector:
        "0x01aa485c8a2fd30844d085cedb3a1b48d791a85bd7e8b5891f9c9f5c0f232ca1" +
        "e90100000000ffffffff",
      outputVector:
        "0x03c0900400000000001976a9142cd680318747b720d67bf4246eb7403b476adb" +
        "3488acc090040000000000160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1" +
        "d0e77207000000000017a9147ac2d9378a1c47e589dfb8095ca95ed2140d272687",
      locktime: "0x00000000",
    },

    redemptionProof: {
      merkleProof:
        "0x4f3cb23dd5254f97e8d634146e446929f7cd89cedbcfec1fb906e90043aea6bc" +
        "000b7c2c56a5aedc7d541fdbf771b6dacfecc23357b3eacf76503aaf27e96d0353" +
        "99f1760cd275a63df367eafc927822ef116bdbd2f5e01787a4241cf18f7f04aab5" +
        "9ea8af82dc69574dac8d4f6c55209ac374c7b17812fd75612e700cbb7a75f85274" +
        "f74cfb0b29d02a0a6f155adb30e837094c0c021e2031ca95ee508b8c9e3a933e70" +
        "3aeb35688f95e34b287b456d1b43ed243b4c3ae6343b5a17bce32c4d096fe2344d" +
        "c132b77ab0471010fb0e232aa9e324bee36148cc2dfc3ef9f2afd5",
      txIndexInBlock: 17,
      bitcoinHeaders:
        "0x00e00020973b21115e240ddc4138fd00fa30894983153ac106693b1715030000" +
        "000000001b677579054db7fc5086f5bbc055b689ad6475e8f6923a412635295f4b" +
        "1a9b5a35761f62ed3e031ae418bc6800e00020941598b8dbf959e6c5fb3ee30543" +
        "cfff7a3f870ea021adb67b0200000000000057f7ba3f0d362977746400c45c2b04" +
        "25c7db588928bc46495f39c6f0ba491ad3a4761f62ed3e031ad4c7bfc800e0ff3f" +
        "5cefed259ada69e60f9c5f7a8aeb74ca26b570aff2fb482f1c02000000000000a0" +
        "2922da07092fa5a2f3ef5bd5b03367c905be9396cf259ce48e9a41dff93baa4c78" +
        "1f62ed3e031a598fbd350400002090febb1f07960f6517e7547161d7e0ebf74409" +
        "631fab24ebed00000000000000fd08091a8de63380d16e74756431bb6b466108cb" +
        "ba97844c2a590f7875736f800a791f62ed3e031a1001d4b900e0ff3fc44608aefb" +
        "c90c494c24fa862f108c59bc73fe7b0ff2ea4e1403000000000000fa363d54c518" +
        "f0db80091e5f740ef2041a85f6634450ae0b1c782fd0bb99181254791f62ed3e03" +
        "1ac954134f00e00020e19cce4a22e8484655acea24f356d45043f6b9c3187b5e65" +
        "a10200000000000015627b4873fd393c2c024fde047ba72fc7df5b46f1302711b9" +
        "824fff63b36326f87a1f62ed3e031a500be2d500e0002083eaf4ee8ba45a1f502c" +
        "2e8bbcab9df7abec22a98fe656e8ca01000000000000ab3c1fe5dfca9175141d9e" +
        "7df11dc92c34388a8941eb0097ceff08d7e25b71e2db7b1f62ed3e031af711fffd",
      coinbasePreimage:
        "0x74ca9ceb33e2d8fdb9f3d39c65fa603015d4002eb9a8bf6ebcace9c48c3ceb5c",
      coinbaseProof:
        "0xdd60b880c9cd8fdc702172e79308a2e2ada9b4a997192b50094f8069bc1616be" +
        "9c9f8ac9cb1a8754ec89693b6371f39b8dc0481d815ef3ec7fbb3034f237a7af08" +
        "a3b052b8bb51ae7b0d7629b8a6e69b5dd7076b6ba5eaa22f82f80dcfeed9ede506" +
        "22ba133f4821297299b577357c937398a4727b239a4f5e06c21741c0882e332a0c" +
        "bbd310777a7e23784690e13b2a2cf690b5e20df94899f29b7540b65eae3a933e70" +
        "3aeb35688f95e34b287b456d1b43ed243b4c3ae6343b5a17bce32c4d096fe2344d" +
        "c132b77ab0471010fb0e232aa9e324bee36148cc2dfc3ef9f2afd5",
    },

    chainDifficulty: 5168815,
  }

/**
 * `MultiplePendingRequestedRedemptionsWithMultipleP2WPKHChanges` test data
 * represents a redemption with the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 2 redemption requests handled by 2 outputs
 * - Redemption dust threshold is 100000 satoshi
 * - Treasury fee for each request is 0.05% of the requested amount
 * - Maximum transaction fee for each request is 1000 satoshi
 * - Total requested amount for all requests is 600000 satoshi
 * - Total treasury fee for all requests is 600 satoshi
 * - Total redeemable amount for all requests is 599400 satoshi
 * - 2 P2WPKH change outputs with values 100000 and 136385266 satoshi and
 *   indexes 2 and 3 respectively.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const MultiplePendingRequestedRedemptionsWithMultipleP2WPKHChanges: RedemptionTestData =
  {
    wallet: {
      pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      state: walletState.Live,
      pendingRedemptionsValue: 0,
      ecdsaWalletID:
        "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
    },

    redemptionRequests: [
      {
        redeemer: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
        redeemerOutputScript:
          // P2PKH with address mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc
          "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
      {
        redeemer: "0x208fF63189DF8749780917Cb5901183075Dbabc1",
        redeemerOutputScript:
          // P2WPKH with address tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx
          "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
    ],

    mainUtxo: {
      txHash:
        "0x5a019e75ab13d8e7296ad0365cc0e58585c5420e374d1248a29798db1ada7340",
      txOutputIndex: 1,
      txOutputValue: 137085266,
    },

    // https://live.blockcypher.com/btc-testnet/tx/44863a79ce2b8fec9792403d5048506e50ffa7338191db0e6c30d3d3358ea2f6
    redemptionTx: {
      hash: "0xf6a28e35d3d3306c0edb918133a7ff506e5048503d409297ec8f2bce793a8644",
      version: "0x01000000",
      inputVector:
        "0x015a019e75ab13d8e7296ad0365cc0e58585c5420e374d1248a29798db1ada73" +
        "400100000000ffffffff",
      outputVector:
        "0x04c0900400000000001976a9142cd680318747b720d67bf4246eb7403b476adb" +
        "3488acc090040000000000160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1" +
        "d0a0860100000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726f2" +
        "122108000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    },

    redemptionProof: {
      merkleProof:
        "0xf213cf97732f3757927d80cc878a928c4b78c7fcf3ff766e7996c3cecb463ae9" +
        "94714b7071100f2832a42eb5da51cbab90dee45bc99843c64a3949c6c90ca9df81" +
        "43b6a9f1efc7f6fe31c30c922f4324a8f70b94855a23bbbcdf46793cd0d8661df0" +
        "53867a0982d052818910bcfffb9c89673c190f3d98be4e28d1bb1b641d6f436a46" +
        "0fce14461646563281322379ac74955b34e9e2ac01720949530a99177b92f31b7d" +
        "78aef1f8102e8a5d7926421adfd3fd7b99a3c5bcb3dd67665a0d13b40c2bfcdabc" +
        "9c3937a1ada199558e318bb489f538204b6e1abbe2d7bfe3a765f5",
      txIndexInBlock: 13,
      bitcoinHeaders:
        "0x04e0002065dff02fc7c8c63f89ade8cbb2eaa1143842c1415cb16a5d0a010000" +
        "000000005111c20aba08cc79bc7c9e92ec23de18b4cc4409e5faf0f8d50dc71dd2" +
        "aa340d48821f62ed3e031ac3fc531f04e00020b5a04030b5fb433b7f60f16d88cb" +
        "e4ed31b79623ae8cd59cf001000000000000447655822fda0037f47fd846e85935" +
        "4083b92c4e37ae49837fb22f1fe4949201e0831f62ed3e031aa10a5e8404e00020" +
        "497d88dd624b7c2a7b34c3b57c2a097b2903fa75d1dd4b254b0000000000000006" +
        "eb2c533acddbcd7183c6cfb9b597bd4cea48e786d2412dde2673d9b16262c2d184" +
        "1f62ed3e031a386fe74904e00020dfa80c9d6a1f0e0ad607b988fc2b1a74383009" +
        "144676e9db01030000000000007699362c9b6d275b2c9d0a30edf4a1477bd3eafe" +
        "3943612a4914f7973c3503b086891f62ffff001ddbc7877c04000020417a4020c5" +
        "8042e79f7f20f7df4f5139f38bd32eae2aba2633350000000000002dbe017f7a33" +
        "c4fe18d35f2c967eeea66a27c0287cb3e88944e846f2481cec09f18c1f62ed3e03" +
        "1a34a24c6f04e0002023067b14f24b718e3bcb8c5acf90b8889b2b5f64f9cb86b8" +
        "5c010000000000009ba6f78f391103d1492ffacb7c8b50374e9ee0ead9831b701c" +
        "95de967533985c2f901f62ed3e031ab148c5180000002098f1603b50832f9007c9" +
        "5e46c415d566228a9cb08374dc5b5c0000000000000016a7cdf53f077b555abd09" +
        "9efae3e48dc6a147e58bb8ca107396aefcdbcc5b62e8941f62ffff001d81f351c4",
      coinbasePreimage:
        "0x5824752ede3572c38620cbe3381d4c1e81bb303b63928588e11786b2680bb009",
      coinbaseProof:
        "0x2ec254e962ece5caf9ee4b69812e3ab6bfb2db907fb3ed2a04f0519202c55bf6" +
        "201dd0591f6c6f3f879b0042f2219adbdab2c2707deaac242cd9e1b3d9814068af" +
        "04632884589ca993df61381ed20f57c3a24b4355067bf844d0d79929d6c3ed409a" +
        "a4ac50b6fe587b62e8df74f73bfa8fcfa1c18110002ff70d6e048adcc7c7436a46" +
        "0fce14461646563281322379ac74955b34e9e2ac01720949530a99177b92f31b7d" +
        "78aef1f8102e8a5d7926421adfd3fd7b99a3c5bcb3dd67665a0d13b40c2bfcdabc" +
        "9c3937a1ada199558e318bb489f538204b6e1abbe2d7bfe3a765f5",
    },

    chainDifficulty: 5168815,
  }

/**
 * `MultiplePendingRequestedRedemptionsWithP2WPKHChangeZeroValue` test data
 * represents a redemption with the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 2 redemption requests handled by 2 outputs
 * - Redemption dust threshold is 100000 satoshi
 * - Treasury fee for each request is 0.05% of the requested amount
 * - Maximum transaction fee for each request is 1000 satoshi
 * - Total requested amount for all requests is 600000 satoshi
 * - Total treasury fee for all requests is 600 satoshi
 * - Total redeemable amount for all requests is 599400 satoshi
 * - 1 P2WPKH change output with value 0 satoshi and index 2.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const MultiplePendingRequestedRedemptionsWithP2WPKHChangeZeroValue: RedemptionTestData =
  {
    wallet: {
      pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      state: walletState.Live,
      pendingRedemptionsValue: 0,
      ecdsaWalletID:
        "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
    },

    redemptionRequests: [
      {
        redeemer: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
        redeemerOutputScript:
          // P2PKH with address mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc
          "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
      {
        redeemer: "0x208fF63189DF8749780917Cb5901183075Dbabc1",
        redeemerOutputScript:
          // P2WPKH with address tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx
          "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
    ],

    mainUtxo: {
      txHash:
        "0x5a18b556ae4aab57197fa064a67d33c059efe9fd47c7fe71e18806b9aef6cdf8",
      txOutputIndex: 1,
      txOutputValue: 988586,
    },

    // https://live.blockcypher.com/btc-testnet/tx/f65bc5029251f0042aedb37f90dbb2bfb63a2e81694beef9cae5ec62e954c22e
    redemptionTx: {
      hash: "0x",
      version: "0x01000000",
      inputVector:
        "0x015a18b556ae4aab57197fa064a67d33c059efe9fd47c7fe71e18806b9aef6cd" +
        "f80100000000ffffffff",
      outputVector:
        "0x03c0900400000000001976a9142cd680318747b720d67bf4246eb7403b476adb" +
        "3488acc090040000000000160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1" +
        "d000000000000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    },

    redemptionProof: {
      merkleProof:
        "0xb2eebf6c06a227d25c04000fdc8f123f21206357bef6b0c0476cd1a3e6e87ab5" +
        "201dd0591f6c6f3f879b0042f2219adbdab2c2707deaac242cd9e1b3d9814068af" +
        "04632884589ca993df61381ed20f57c3a24b4355067bf844d0d79929d6c3ed409a" +
        "a4ac50b6fe587b62e8df74f73bfa8fcfa1c18110002ff70d6e048adcc7c7436a46" +
        "0fce14461646563281322379ac74955b34e9e2ac01720949530a99177b92f31b7d" +
        "78aef1f8102e8a5d7926421adfd3fd7b99a3c5bcb3dd67665a0d13b40c2bfcdabc" +
        "9c3937a1ada199558e318bb489f538204b6e1abbe2d7bfe3a765f5",
      txIndexInBlock: 1,
      bitcoinHeaders:
        "0x04e0002065dff02fc7c8c63f89ade8cbb2eaa1143842c1415cb16a5d0a010000" +
        "000000005111c20aba08cc79bc7c9e92ec23de18b4cc4409e5faf0f8d50dc71dd2" +
        "aa340d48821f62ed3e031ac3fc531f04e00020b5a04030b5fb433b7f60f16d88cb" +
        "e4ed31b79623ae8cd59cf001000000000000447655822fda0037f47fd846e85935" +
        "4083b92c4e37ae49837fb22f1fe4949201e0831f62ed3e031aa10a5e8404e00020" +
        "497d88dd624b7c2a7b34c3b57c2a097b2903fa75d1dd4b254b0000000000000006" +
        "eb2c533acddbcd7183c6cfb9b597bd4cea48e786d2412dde2673d9b16262c2d184" +
        "1f62ed3e031a386fe74904e00020dfa80c9d6a1f0e0ad607b988fc2b1a74383009" +
        "144676e9db01030000000000007699362c9b6d275b2c9d0a30edf4a1477bd3eafe" +
        "3943612a4914f7973c3503b086891f62ffff001ddbc7877c04000020417a4020c5" +
        "8042e79f7f20f7df4f5139f38bd32eae2aba2633350000000000002dbe017f7a33" +
        "c4fe18d35f2c967eeea66a27c0287cb3e88944e846f2481cec09f18c1f62ed3e03" +
        "1a34a24c6f04e0002023067b14f24b718e3bcb8c5acf90b8889b2b5f64f9cb86b8" +
        "5c010000000000009ba6f78f391103d1492ffacb7c8b50374e9ee0ead9831b701c" +
        "95de967533985c2f901f62ed3e031ab148c5180000002098f1603b50832f9007c9" +
        "5e46c415d566228a9cb08374dc5b5c0000000000000016a7cdf53f077b555abd09" +
        "9efae3e48dc6a147e58bb8ca107396aefcdbcc5b62e8941f62ffff001d81f351c4",
      coinbasePreimage:
        "0x5824752ede3572c38620cbe3381d4c1e81bb303b63928588e11786b2680bb009",
      coinbaseProof:
        "0x2ec254e962ece5caf9ee4b69812e3ab6bfb2db907fb3ed2a04f0519202c55bf6" +
        "201dd0591f6c6f3f879b0042f2219adbdab2c2707deaac242cd9e1b3d9814068af" +
        "04632884589ca993df61381ed20f57c3a24b4355067bf844d0d79929d6c3ed409a" +
        "a4ac50b6fe587b62e8df74f73bfa8fcfa1c18110002ff70d6e048adcc7c7436a46" +
        "0fce14461646563281322379ac74955b34e9e2ac01720949530a99177b92f31b7d" +
        "78aef1f8102e8a5d7926421adfd3fd7b99a3c5bcb3dd67665a0d13b40c2bfcdabc" +
        "9c3937a1ada199558e318bb489f538204b6e1abbe2d7bfe3a765f5",
    },

    chainDifficulty: 5168815,
  }

/**
 * `MultiplePendingRequestedRedemptionsWithNonRequestedRedemption` test data
 * represents a redemption with the same properties as in
 * `MultiplePendingRequestedRedemptionsWithP2WPKHChange` data but with modified
 *  `redemptionRequests` array that doesn't contain the last request. This
 *  makes the corresponding transaction output a non-requested redemption.
 */
export const MultiplePendingRequestedRedemptionsWithNonRequestedRedemption: RedemptionTestData =
  {
    ...MultiplePendingRequestedRedemptionsWithP2WPKHChange,
    redemptionRequests:
      MultiplePendingRequestedRedemptionsWithP2WPKHChange.redemptionRequests.slice(
        0,
        4
      ),
  }

/**
 * `MultiplePendingRequestedRedemptionsWithProvablyUnspendable` test data
 * represents a redemption with the following properties:
 * - 1 input pointing to the wallet main UTXO
 * - 2 redemption requests handled by 2 outputs
 * - Redemption dust threshold is 100000 satoshi
 * - Treasury fee for each request is 0.05% of the requested amount
 * - Maximum transaction fee for each request is 1000 satoshi
 * - Total requested amount for all requests is 600000 satoshi
 * - Total treasury fee for all requests is 600 satoshi
 * - Total redeemable amount for all requests is 599400 satoshi
 * - 1 provably unspendable output at index 2.
 * - 1 P2WPKH change output with value 275636 satoshi and index 3.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const MultiplePendingRequestedRedemptionsWithProvablyUnspendable: RedemptionTestData =
  {
    wallet: {
      pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      state: walletState.Live,
      pendingRedemptionsValue: 0,
      ecdsaWalletID:
        "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
    },

    redemptionRequests: [
      {
        redeemer: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
        redeemerOutputScript:
          // P2PKH with address mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc
          "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
      {
        redeemer: "0x208fF63189DF8749780917Cb5901183075Dbabc1",
        redeemerOutputScript:
          // P2WPKH with address tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx
          "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
    ],

    mainUtxo: {
      txHash:
        "0x1c2d4f9383d2607e4e369753d086f2b02d65c272b70856c8110c5d6a8c3e1a92",
      txOutputIndex: 1,
      txOutputValue: 875636,
    },

    // https://live.blockcypher.com/btc-testnet/tx/4c6b33b7c0550e0e536a5d119ac7189d71e1296fcb0c258e0c115356895bc0e6
    redemptionTx: {
      hash: "0xe6c05b895653110c8e250ccb6f29e1719d18c79a115d6a530e0e55c0b7336b4c",
      version: "0x01000000",
      inputVector:
        "0x011c2d4f9383d2607e4e369753d086f2b02d65c272b70856c8110c5d6a8c3e1a" +
        "920100000000ffffffff",
      outputVector:
        "0x04c0900400000000001976a9142cd680318747b720d67bf4246eb7403b476adb" +
        "3488acc090040000000000160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1" +
        "d00000000000000000176a0f6d6f6e6579627574746f6e2e636f6d0568656c6c6f" +
        "b4340400000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    },

    redemptionProof: {
      merkleProof:
        "0xc4047d89948706a725d5b7ec92d44fec13797d023bc78199c5500063cfd9b393" +
        "61a6fbac91f9eb8c67d0e9067c158a35bd3ef5b44f46d92550565344b130f0927f" +
        "6673ddef0074cd576465dc4e25252967754f88e1ff8157e2358bea717e983ab71b" +
        "951ee2a0eaa2e6bfa61bed4cddef48c02bba8f8f8035252aa97df9394880eb84c9" +
        "5941be3ea2f667b5b9223bcf7dd09aff1711c090aac450f20746a315eeb29ae5bf" +
        "6a01f97bf8bd4ffb9e3efca33e6e5ec3d8fe82eda7924438f192f834",
      txIndexInBlock: 7,
      bitcoinHeaders:
        "0x00e00020516933fc2a5d8f2dc0c93e84614643e44877d1053e97aac186000000" +
        "00000000094411d177621edf4c06402e7f493a06cf84841d5713d2556859cd5228" +
        "ecd2498a862062ed3e031a38d7169300e0ff3fd742d7788ab7e35c27753eb3689a" +
        "059766b314d39af155fc4a00000000000000e4fb461c8e130d30d44e4c1bb487bd" +
        "cb6818694ba6415752d090859ee5d05c50cc892062ed3e031a06ced8a400e00020" +
        "34247069e603ba4902ffef5789625ebd377838afd331928eef000000000000001b" +
        "98647dde95fa07d85ba91ac16d392bbec9d2440bc1764b6bc99dd76d8d5e86b18a" +
        "2062ed3e031ab67bfd2f00e0ff3fb47ec27d405d0cd9fa745a3ff9dee8b9b2f589" +
        "1edbf8ef10820000000000000042829163fafa65aaccd5afbe2b04f4ae93a585ea" +
        "1c631f3ea2c5cefba791292d058b2062ed3e031af9941d6f00000020f41d5cf0c4" +
        "611f29fe4fb1508d7dc7acad9215ea39d459071e00000000000000fe89f4c7f25d" +
        "54f0047199507ff1bd0d15e4c0955f1f2230d147200836ce52b7138b2062ed3e03" +
        "1aa0f949c0040000207fe7f95bef4018c800f0f0c3d774a5dcde3a102779b648f9" +
        "2b02000000000000f4b7a63190dbe4a149fffed694612e7b35d0310cb4e870e282" +
        "d013b494a83d4def8d2062ed3e031a3f6aea04",
      coinbasePreimage:
        "0xb8b06b82330ec4ebb161160c32cba941d0398a790ef9bcd3c3439f84b750d2ce",
      coinbaseProof:
        "0x6e4f0f66c4225348a08c4ad1fd7ccfcaf219a9dfe3673a8f9878f18dd1a6b6c4" +
        "3af6868121adb8366bbd11041df3764f9de311f285bfd5795c1523eba38da1182a" +
        "466f52023d1c6f103ad594e87a64e17a1d41c068873d806b3cab0b5c804273b71b" +
        "951ee2a0eaa2e6bfa61bed4cddef48c02bba8f8f8035252aa97df9394880eb84c9" +
        "5941be3ea2f667b5b9223bcf7dd09aff1711c090aac450f20746a315eeb29ae5bf" +
        "6a01f97bf8bd4ffb9e3efca33e6e5ec3d8fe82eda7924438f192f834",
    },

    chainDifficulty: 5168815,
  }

/**
 * `MultiplePendingRequestedRedemptionsWithMultipleInputs` test data
 * represents a redemption with the following properties:
 * - 2 inputs where 1 of them points to the main UTXO
 * - 2 redemption requests handled by 2 outputs
 * - Redemption dust threshold is 100000 satoshi
 * - Treasury fee for each request is 0.05% of the requested amount
 * - Maximum transaction fee for each request is 1000 satoshi
 * - Total requested amount for all requests is 600000 satoshi
 * - Total treasury fee for all requests is 600 satoshi
 * - Total redeemable amount for all requests is 599400 satoshi
 * - 1 P2WPKH change output with value 531716 satoshi and index 2.
 * - 6+ on-chain confirmations of the redemption transaction
 */
export const MultiplePendingRequestedRedemptionsWithMultipleInputs: RedemptionTestData =
  {
    wallet: {
      pubKeyHash: "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      state: walletState.Live,
      pendingRedemptionsValue: 0,
      ecdsaWalletID:
        "0x4ad6b3ccbca81645865d8d0d575797a15528e98ced22f29a6f906d3259569863",
    },

    redemptionRequests: [
      {
        redeemer: "0x7F62CddE8A86328d63B9517BC70B255017f25EEa",
        redeemerOutputScript:
          // P2PKH with address mjc2zGWypwpNyDi4ZxGbBNnUA84bfgiwYc
          "0x1976a9142cd680318747b720d67bf4246eb7403b476adb3488ac",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
      {
        redeemer: "0x208fF63189DF8749780917Cb5901183075Dbabc1",
        redeemerOutputScript:
          // P2WPKH with address tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx
          "0x160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1d0",
        amount: 300000, // Accepts outputs in range [298850, 299850]
      },
    ],

    mainUtxo: {
      txHash:
        "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
      txOutputIndex: 1,
      txOutputValue: 718510,
    },

    // https://live.blockcypher.com/btc-testnet/tx/605edd75ae0b4fa7cfc7aae8f1399119e9d7ecc212e6253156b60d60f4925d44
    redemptionTx: {
      hash: "0x445d92f4600db6563125e612c2ecd7e9199139f1e8aac7cfa74f0bae75dd5e60",
      version: "0x01000000",
      inputVector:
        "0x0225a666beb7380a3fa2a0a8f64a562c7f1749a131bfee26ff61e4cee07cb3dd" +
        "030100000000ffffffffc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f" +
        "2a1868ddd917458bdf0100000000ffffffff",
      outputVector:
        "0x03c0900400000000001976a9142cd680318747b720d67bf4246eb7403b476adb" +
        "3488acc090040000000000160014e6f9d74726b19b75f16fe1e9feaec048aa4fa1" +
        "d0041d0800000000001600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    },

    redemptionProof: {
      merkleProof:
        "0x88269e1c322be70bfbefb31c21880716592b5c50cc05daed725278d574c3e472" +
        "6347cd0825a64a705f72133c93a181547d0a27919605ef110aeafc30a88fefdfc1" +
        "c9d3e01fbb6e628ed67c41b5ea533a112883d5a8672d669fe3739ca7b274b3c1f5" +
        "4765886f2444ef13d4c90d72594920df006793362ec6169ae4840be26af17fb255" +
        "5399b14643436ba75f862e4aac9b5e53c68dddc706720ab18f2f46be59a00211d8" +
        "cf4f8e311f49f2a52177c7a21d421e52748d01114e83e13c21ad4131",
      txIndexInBlock: 1,
      bitcoinHeaders:
        "0x000000208ec76388aa580d8fa32ce9becbfd8f140dc33fc5a91fbc00f9020000" +
        "00000000959305797e5c97c81fe38629d01271d3f583f4cebe878ddb3e93547004" +
        "b29f7961952062ed3e031a6bd3f8050000ff3f42a37a9f0d546b1752e712abf607" +
        "ee0d4f63d65e2590ccef4202000000000000ce9a58c9a6f39c18225afd7a7e5591" +
        "423d77620595d4dd264167d889c4ddb7fa28972062ed3e031a75397f0104e00020" +
        "d9cb8a5f9c012c43e9e0ccb4eb2ef134f3deb03a71ec005c8c0000000000000058" +
        "fd6736c2d43ef0e414e31333f08fda58be1046967f412be7033421e4ca87e03997" +
        "2062ed3e031acd8c3dcb04000020bbcf82f0e7a70b2070f7c32e8ac686fa2bef3c" +
        "f735ea7778030200000000000049926ec1e65124db0045942e5e98a323e8c15a9e" +
        "1c6a43139b79618fc7efcece37972062ed3e031ab38bf0fc00e0002055daa8e180" +
        "320777a0b8d9b27f574513720caa0bd4c6f7ae34030000000000009935ad26c911" +
        "4f4b21781b3509a8d106b2b597af2fa41e19469cca843a1c650b49972062ed3e03" +
        "1a6a3ca59100e0002012ea5dafd8e9e4c149da2e3a896281b68b375eb2ea38cdef" +
        "1403000000000000c9e61160c8367db22bbf0f3a0c07acb29ea15ca44cbc92a2dc" +
        "9ea17a971c2e63ad982062ed3e031a3cfc880f00e00020fc72ae375a8cd436d959" +
        "c96b73323c81e2ef11e31d7c98e72e02000000000000711a4b0d4fadef376c37da" +
        "044aa896ea0e7c64008c2d6c3e3eb2d6f1b58e78b5339a2062ed3e031a9b77f2eb",
      coinbasePreimage:
        "0xb55bd9b8bd6c0cb15af97447c6d3fbd74fddfd8402f6fee722b2088d287793bb",
      coinbaseProof:
        "0x445d92f4600db6563125e612c2ecd7e9199139f1e8aac7cfa74f0bae75dd5e60" +
        "6347cd0825a64a705f72133c93a181547d0a27919605ef110aeafc30a88fefdfc1" +
        "c9d3e01fbb6e628ed67c41b5ea533a112883d5a8672d669fe3739ca7b274b3c1f5" +
        "4765886f2444ef13d4c90d72594920df006793362ec6169ae4840be26af17fb255" +
        "5399b14643436ba75f862e4aac9b5e53c68dddc706720ab18f2f46be59a00211d8" +
        "cf4f8e311f49f2a52177c7a21d421e52748d01114e83e13c21ad4131",
    },

    chainDifficulty: 5168815,
  }
