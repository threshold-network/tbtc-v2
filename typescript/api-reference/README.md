# @keep-network/tbtc-v2.ts

## Table of contents

### Namespaces

- [BitcoinNetwork](modules/BitcoinNetwork.md)
- [Chains](modules/Chains.md)
- [GetChainEvents](modules/GetChainEvents.md)
- [WalletState](modules/WalletState.md)

### Enumerations

- [ApiUrl](enums/ApiUrl.md)
- [BitcoinNetwork](enums/BitcoinNetwork-1.md)
- [DepositState](enums/DepositState.md)
- [WalletState](enums/WalletState-1.md)
- [endpointUrl](enums/endpointUrl.md)

### Classes

- [ArbitrumBitcoinDepositor](classes/ArbitrumBitcoinDepositor.md)
- [ArbitrumExtraDataEncoder](classes/ArbitrumExtraDataEncoder.md)
- [ArbitrumTBTCToken](classes/ArbitrumTBTCToken.md)
- [BaseBitcoinDepositor](classes/BaseBitcoinDepositor.md)
- [BaseTBTCToken](classes/BaseTBTCToken.md)
- [BitcoinTxHash](classes/BitcoinTxHash.md)
- [CrossChainDepositor](classes/CrossChainDepositor.md)
- [Deposit](classes/Deposit.md)
- [DepositFunding](classes/DepositFunding.md)
- [DepositRefund](classes/DepositRefund.md)
- [DepositScript](classes/DepositScript.md)
- [DepositsService](classes/DepositsService.md)
- [ElectrumClient](classes/ElectrumClient.md)
- [EthereumAddress](classes/EthereumAddress.md)
- [EthereumBridge](classes/EthereumBridge.md)
- [EthereumDepositorProxy](classes/EthereumDepositorProxy.md)
- [EthereumExtraDataEncoder](classes/EthereumExtraDataEncoder.md)
- [EthereumL1BitcoinDepositor](classes/EthereumL1BitcoinDepositor.md)
- [EthereumL1BitcoinRedeemer](classes/EthereumL1BitcoinRedeemer.md)
- [EthereumTBTCToken](classes/EthereumTBTCToken.md)
- [EthereumTBTCVault](classes/EthereumTBTCVault.md)
- [EthereumWalletRegistry](classes/EthereumWalletRegistry.md)
- [Hex](classes/Hex.md)
- [MaintenanceService](classes/MaintenanceService.md)
- [OptimisticMinting](classes/OptimisticMinting.md)
- [P2TRSignatureFraudBridgeChallengeSubmitter](classes/P2TRSignatureFraudBridgeChallengeSubmitter.md)
- [P2TRSignatureFraudWatchtower](classes/P2TRSignatureFraudWatchtower.md)
- [P2TRSignatureFraudWatchtowerRunner](classes/P2TRSignatureFraudWatchtowerRunner.md)
- [P2TRWatchtowerSerializedChallengeStore](classes/P2TRWatchtowerSerializedChallengeStore.md)
- [P2TRWitnessSignatureError](classes/P2TRWitnessSignatureError.md)
- [RedemptionsService](classes/RedemptionsService.md)
- [SeiAddress](classes/SeiAddress.md)
- [SeiBitcoinDepositor](classes/SeiBitcoinDepositor.md)
- [SeiExtraDataEncoder](classes/SeiExtraDataEncoder.md)
- [SeiTBTCToken](classes/SeiTBTCToken.md)
- [SolanaAddress](classes/SolanaAddress.md)
- [SolanaExtraDataEncoder](classes/SolanaExtraDataEncoder.md)
- [Spv](classes/Spv.md)
- [StarkNetAddress](classes/StarkNetAddress.md)
- [StarkNetBitcoinDepositor](classes/StarkNetBitcoinDepositor.md)
- [StarkNetExtraDataEncoder](classes/StarkNetExtraDataEncoder.md)
- [StarkNetTBTCToken](classes/StarkNetTBTCToken.md)
- [TBTC](classes/TBTC.md)
- [TBTCCore](classes/TBTCCore.md)
- [WalletTx](classes/WalletTx.md)

### Interfaces

- [BitcoinClient](interfaces/BitcoinClient.md)
- [BitcoinDepositor](interfaces/BitcoinDepositor.md)
- [BitcoinHeader](interfaces/BitcoinHeader.md)
- [BitcoinRawTx](interfaces/BitcoinRawTx.md)
- [BitcoinRawTxVectors](interfaces/BitcoinRawTxVectors.md)
- [BitcoinSpvProof](interfaces/BitcoinSpvProof.md)
- [BitcoinTx](interfaces/BitcoinTx.md)
- [BitcoinTxMerkleBranch](interfaces/BitcoinTxMerkleBranch.md)
- [BitcoinTxOutpoint](interfaces/BitcoinTxOutpoint.md)
- [BitcoinTxOutput](interfaces/BitcoinTxOutput.md)
- [Bridge](interfaces/Bridge.md)
- [ChainEvent](interfaces/ChainEvent.md)
- [ChainIdentifier](interfaces/ChainIdentifier.md)
- [CrossChainContractsLoader](interfaces/CrossChainContractsLoader.md)
- [DepositReceipt](interfaces/DepositReceipt.md)
- [DepositRequest](interfaces/DepositRequest.md)
- [DepositorProxy](interfaces/DepositorProxy.md)
- [DestinationChainTBTCToken](interfaces/DestinationChainTBTCToken.md)
- [ElectrumCredentials](interfaces/ElectrumCredentials.md)
- [EthereumContractConfig](interfaces/EthereumContractConfig.md)
- [ExtraDataEncoder](interfaces/ExtraDataEncoder.md)
- [L1BitcoinRedeemer](interfaces/L1BitcoinRedeemer.md)
- [L2BitcoinRedeemer](interfaces/L2BitcoinRedeemer.md)
- [P2TRSignatureFraudBridgeChallengeContract](interfaces/P2TRSignatureFraudBridgeChallengeContract.md)
- [P2TRSignatureFraudChallengeSubmitter](interfaces/P2TRSignatureFraudChallengeSubmitter.md)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource](interfaces/P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource.md)
- [P2TRSignatureFraudWatchtowerTransactionSource](interfaces/P2TRSignatureFraudWatchtowerTransactionSource.md)
- [P2TRWatchtowerChallengeRecordPersistence](interfaces/P2TRWatchtowerChallengeRecordPersistence.md)
- [P2TRWatchtowerChallengeRecordSource](interfaces/P2TRWatchtowerChallengeRecordSource.md)
- [P2TRWatchtowerChallengeReplayStore](interfaces/P2TRWatchtowerChallengeReplayStore.md)
- [P2TRWatchtowerChallengeStore](interfaces/P2TRWatchtowerChallengeStore.md)
- [RedeemerProxy](interfaces/RedeemerProxy.md)
- [RedemptionRequest](interfaces/RedemptionRequest.md)
- [RedemptionWallet](interfaces/RedemptionWallet.md)
- [SeiBitcoinDepositorConfig](interfaces/SeiBitcoinDepositorConfig.md)
- [SerializableWallet](interfaces/SerializableWallet.md)
- [StarkNetBitcoinDepositorConfig](interfaces/StarkNetBitcoinDepositorConfig.md)
- [StarkNetTBTCTokenConfig](interfaces/StarkNetTBTCTokenConfig.md)
- [TBTCToken](interfaces/TBTCToken.md)
- [TBTCVault](interfaces/TBTCVault.md)
- [ValidRedemptionWallet](interfaces/ValidRedemptionWallet.md)
- [Wallet](interfaces/Wallet.md)
- [WalletRegistry](interfaces/WalletRegistry.md)

### Type Aliases

- [BitcoinTxInput](README.md#bitcointxinput)
- [BitcoinUtxo](README.md#bitcoinutxo)
- [ChainMapping](README.md#chainmapping)
- [CrossChainContracts](README.md#crosschaincontracts)
- [CrossChainDepositorMode](README.md#crosschaindepositormode)
- [CrossChainExtraDataEncoder](README.md#crosschainextradataencoder)
- [CrossChainInterfaces](README.md#crosschaininterfaces)
- [DepositRevealedEvent](README.md#depositrevealedevent)
- [DepositScriptOptions](README.md#depositscriptoptions)
- [DepositScriptType](README.md#depositscripttype)
- [DestinationChainInterfaces](README.md#destinationchaininterfaces)
- [DestinationChainName](README.md#destinationchainname)
- [DkgResultApprovedEvent](README.md#dkgresultapprovedevent)
- [DkgResultChallengedEvent](README.md#dkgresultchallengedevent)
- [DkgResultSubmittedEvent](README.md#dkgresultsubmittedevent)
- [ElectrumClientOptions](README.md#electrumclientoptions)
- [ErrorMatcherFn](README.md#errormatcherfn)
- [EthereumSigner](README.md#ethereumsigner)
- [ExecutionLoggerFn](README.md#executionloggerfn)
- [L1BitcoinDepositor](README.md#l1bitcoindepositor)
- [L1CrossChainContracts](README.md#l1crosschaincontracts)
- [L2BitcoinDepositor](README.md#l2bitcoindepositor)
- [L2Chain](README.md#l2chain)
- [L2CrossChainContracts](README.md#l2crosschaincontracts)
- [L2TBTCToken](README.md#l2tbtctoken)
- [NewWalletRegisteredEvent](README.md#newwalletregisteredevent)
- [OptimisticMintingCancelledEvent](README.md#optimisticmintingcancelledevent)
- [OptimisticMintingFinalizedEvent](README.md#optimisticmintingfinalizedevent)
- [OptimisticMintingRequest](README.md#optimisticmintingrequest)
- [OptimisticMintingRequestedEvent](README.md#optimisticmintingrequestedevent)
- [P2TRKeyPathInputWitnessSignature](README.md#p2trkeypathinputwitnesssignature)
- [P2TRKeyPathWitnessSignature](README.md#p2trkeypathwitnesssignature)
- [P2TRSignatureFraudBridgeChallengeDomain](README.md#p2trsignaturefraudbridgechallengedomain)
- [P2TRSignatureFraudBridgeChallengeIdentity](README.md#p2trsignaturefraudbridgechallengeidentity)
- [P2TRSignatureFraudBridgeChallengeKey](README.md#p2trsignaturefraudbridgechallengekey)
- [P2TRSignatureFraudBridgeChallengePayload](README.md#p2trsignaturefraudbridgechallengepayload)
- [P2TRSignatureFraudBridgeChallengePayloadInput](README.md#p2trsignaturefraudbridgechallengepayloadinput)
- [P2TRSignatureFraudBridgeChallengePayloadOutput](README.md#p2trsignaturefraudbridgechallengepayloadoutput)
- [P2TRSignatureFraudBridgeChallengePayloadPrevout](README.md#p2trsignaturefraudbridgechallengepayloadprevout)
- [P2TRSignatureFraudBridgeChallengeSubmitterOptions](README.md#p2trsignaturefraudbridgechallengesubmitteroptions)
- [P2TRSignatureFraudBridgeFraudParameters](README.md#p2trsignaturefraudbridgefraudparameters)
- [P2TRSignatureFraudBridgeTransaction](README.md#p2trsignaturefraudbridgetransaction)
- [P2TRSignatureFraudBridgeTransactionReceipt](README.md#p2trsignaturefraudbridgetransactionreceipt)
- [P2TRSignatureFraudChallengeSubmissionPolicy](README.md#p2trsignaturefraudchallengesubmissionpolicy)
- [P2TRSignatureFraudDraftChallenge](README.md#p2trsignaturefrauddraftchallenge)
- [P2TRSignatureFraudPayloadBounds](README.md#p2trsignaturefraudpayloadbounds)
- [P2TRSignatureFraudSpendType](README.md#p2trsignaturefraudspendtype)
- [P2TRSignatureFraudSpendTypeClassifier](README.md#p2trsignaturefraudspendtypeclassifier)
- [P2TRSignatureFraudSpendTypeClassifierContext](README.md#p2trsignaturefraudspendtypeclassifiercontext)
- [P2TRSignatureFraudSpendTypeClassifierRule](README.md#p2trsignaturefraudspendtypeclassifierrule)
- [P2TRSignatureFraudWatchtowerBatchResult](README.md#p2trsignaturefraudwatchtowerbatchresult)
- [P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget](README.md#p2trsignaturefraudwatchtowerbridgechallengelifecycleeventtarget)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult](README.md#p2trsignaturefraudwatchtowerbridgelifecyclebatchresult)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleCycleResult](README.md#p2trsignaturefraudwatchtowerbridgelifecyclecycleresult)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleEvent](README.md#p2trsignaturefraudwatchtowerbridgelifecycleevent)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence](README.md#p2trsignaturefraudwatchtowerbridgelifecycleeventevidence)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleEventTarget](README.md#p2trsignaturefraudwatchtowerbridgelifecycleeventtarget)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleFailure](README.md#p2trsignaturefraudwatchtowerbridgelifecyclefailure)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleIgnored](README.md#p2trsignaturefraudwatchtowerbridgelifecycleignored)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleResult](README.md#p2trsignaturefraudwatchtowerbridgelifecycleresult)
- [P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure](README.md#p2trsignaturefraudwatchtowerbridgelifecyclesourcefailure)
- [P2TRSignatureFraudWatchtowerBridgeProofLifecycleEventTarget](README.md#p2trsignaturefraudwatchtowerbridgeprooflifecycleeventtarget)
- [P2TRSignatureFraudWatchtowerCycleResult](README.md#p2trsignaturefraudwatchtowercycleresult)
- [P2TRSignatureFraudWatchtowerIntegratedCycleResult](README.md#p2trsignaturefraudwatchtowerintegratedcycleresult)
- [P2TRSignatureFraudWatchtowerIntegratedSourceFailure](README.md#p2trsignaturefraudwatchtowerintegratedsourcefailure)
- [P2TRSignatureFraudWatchtowerObservationResult](README.md#p2trsignaturefraudwatchtowerobservationresult)
- [P2TRSignatureFraudWatchtowerProcessingFailure](README.md#p2trsignaturefraudwatchtowerprocessingfailure)
- [P2TRSignatureFraudWatchtowerRunnerOptions](README.md#p2trsignaturefraudwatchtowerrunneroptions)
- [P2TRSignatureFraudWatchtowerSourceFailure](README.md#p2trsignaturefraudwatchtowersourcefailure)
- [P2TRSignatureFraudWatchtowerSubmissionResult](README.md#p2trsignaturefraudwatchtowersubmissionresult)
- [P2TRSignatureFraudWatchtowerTransactionSourceName](README.md#p2trsignaturefraudwatchtowertransactionsourcename)
- [P2TRSignatureFraudWitnessObservation](README.md#p2trsignaturefraudwitnessobservation)
- [P2TRSignatureFraudWitnessObservationConsistencyContext](README.md#p2trsignaturefraudwitnessobservationconsistencycontext)
- [P2TRSignatureFraudWitnessObservationJSON](README.md#p2trsignaturefraudwitnessobservationjson)
- [P2TRSupportedSighashType](README.md#p2trsupportedsighashtype)
- [P2TRWalletInputObservationPrevout](README.md#p2trwalletinputobservationprevout)
- [P2TRWalletInputObservationPrevoutJSON](README.md#p2trwalletinputobservationprevoutjson)
- [P2TRWalletInputPrevout](README.md#p2trwalletinputprevout)
- [P2TRWalletInputWitnessCandidate](README.md#p2trwalletinputwitnesscandidate)
- [P2TRWalletInputWitnessObservation](README.md#p2trwalletinputwitnessobservation)
- [P2TRWatchtowerBitcoinStatus](README.md#p2trwatchtowerbitcoinstatus)
- [P2TRWatchtowerChallengeEvent](README.md#p2trwatchtowerchallengeevent)
- [P2TRWatchtowerChallengeRecord](README.md#p2trwatchtowerchallengerecord)
- [P2TRWatchtowerChallengeRecordJSON](README.md#p2trwatchtowerchallengerecordjson)
- [P2TRWatchtowerChallengeRecordSummary](README.md#p2trwatchtowerchallengerecordsummary)
- [P2TRWatchtowerChallengeStatus](README.md#p2trwatchtowerchallengestatus)
- [P2TRWatchtowerConfirmedTransaction](README.md#p2trwatchtowerconfirmedtransaction)
- [P2TRWatchtowerMempoolTransaction](README.md#p2trwatchtowermempooltransaction)
- [P2TRWatchtowerOperatorAlert](README.md#p2trwatchtoweroperatoralert)
- [P2TRWatchtowerOperatorAlertStatus](README.md#p2trwatchtoweroperatoralertstatus)
- [P2TRWitnessSignatureErrorCode](README.md#p2trwitnesssignatureerrorcode)
- [RedemptionRequestedEvent](README.md#redemptionrequestedevent)
- [RetrierFn](README.md#retrierfn)
- [SeiProvider](README.md#seiprovider)
- [SeiSigner](README.md#seisigner)
- [StarkNetDepositorConfig](README.md#starknetdepositorconfig)
- [StarkNetProvider](README.md#starknetprovider)
- [TBTCContracts](README.md#tbtccontracts)
- [TaprootDepositReceipt](README.md#taprootdepositreceipt)
- [TaprootDepositRevealedEvent](README.md#taprootdepositrevealedevent)

### Variables

- [ArbitrumCrossChainExtraDataEncoder](README.md#arbitrumcrosschainextradataencoder)
- [ArbitrumL2BitcoinDepositor](README.md#arbitruml2bitcoindepositor)
- [ArbitrumL2TBTCToken](README.md#arbitruml2tbtctoken)
- [BaseL2BitcoinDepositor](README.md#basel2bitcoindepositor)
- [BaseL2TBTCToken](README.md#basel2tbtctoken)
- [BitcoinAddressConverter](README.md#bitcoinaddressconverter)
- [BitcoinCompactSizeUint](README.md#bitcoincompactsizeuint)
- [BitcoinHashUtils](README.md#bitcoinhashutils)
- [BitcoinHeaderSerializer](README.md#bitcoinheaderserializer)
- [BitcoinLocktimeUtils](README.md#bitcoinlocktimeutils)
- [BitcoinPrivateKeyUtils](README.md#bitcoinprivatekeyutils)
- [BitcoinPublicKeyUtils](README.md#bitcoinpublickeyutils)
- [BitcoinScriptUtils](README.md#bitcoinscriptutils)
- [BitcoinTaprootUtils](README.md#bitcointaprootutils)
- [BitcoinTargetConverter](README.md#bitcointargetconverter)
- [ChainMappings](README.md#chainmappings)
- [DepositScriptType](README.md#depositscripttype-1)
- [EthereumCrossChainExtraDataEncoder](README.md#ethereumcrosschainextradataencoder)
- [P2TR\_SIGHASH\_ALL](README.md#p2tr_sighash_all)
- [P2TR\_SIGHASH\_DEFAULT](README.md#p2tr_sighash_default)
- [P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_ACTION\_SUBMIT](README.md#p2tr_signature_fraud_bridge_action_submit)
- [P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_ID\_DOMAIN](README.md#p2tr_signature_fraud_bridge_challenge_id_domain)
- [P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_KEY\_DOMAIN](README.md#p2tr_signature_fraud_bridge_challenge_key_domain)
- [P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_PAYLOAD\_ABI\_TYPE](README.md#p2tr_signature_fraud_bridge_challenge_payload_abi_type)
- [P2TR\_SIGNATURE\_FRAUD\_DRAFT\_CHALLENGE\_ID\_DOMAIN](README.md#p2tr_signature_fraud_draft_challenge_id_domain)
- [P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_DEPOSIT\_SWEEP](README.md#p2tr_signature_fraud_spend_type_deposit_sweep)
- [P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_HEARTBEAT](README.md#p2tr_signature_fraud_spend_type_heartbeat)
- [P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_MOVED\_FUNDS\_SWEEP](README.md#p2tr_signature_fraud_spend_type_moved_funds_sweep)
- [P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_MOVING\_FUNDS](README.md#p2tr_signature_fraud_spend_type_moving_funds)
- [P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_REDEMPTION](README.md#p2tr_signature_fraud_spend_type_redemption)
- [P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_UNCLASSIFIED](README.md#p2tr_signature_fraud_spend_type_unclassified)
- [P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_WALLET\_CLOSING](README.md#p2tr_signature_fraud_spend_type_wallet_closing)
- [P2TR\_WATCHTOWER\_OBSERVATION\_ID\_DOMAIN](README.md#p2tr_watchtower_observation_id_domain)
- [SeiL2TBTCToken](README.md#seil2tbtctoken)
- [SolanaCrossChainExtraDataEncoder](README.md#solanacrosschainextradataencoder)
- [StarkNetCrossChainExtraDataEncoder](README.md#starknetcrosschainextradataencoder)
- [StarkNetDepositor](README.md#starknetdepositor)
- [WORMHOLE\_CHAIN\_IDS](README.md#wormhole_chain_ids)
- [tbtcABI](README.md#tbtcabi)

### Functions

- [amountToSatoshi](README.md#amounttosatoshi)
- [applyP2TRWatchtowerChallengeEvent](README.md#applyp2trwatchtowerchallengeevent)
- [assembleBitcoinSpvProof](README.md#assemblebitcoinspvproof)
- [backoffRetrier](README.md#backoffretrier)
- [buildP2TRSignatureFraudBridgeChallengePayload](README.md#buildp2trsignaturefraudbridgechallengepayload)
- [chainIdFromSigner](README.md#chainidfromsigner)
- [computeElectrumScriptHash](README.md#computeelectrumscripthash)
- [computeP2TRKeyPathSighash](README.md#computep2trkeypathsighash)
- [computeP2TRSignatureFraudBridgeChallengeIdentity](README.md#computep2trsignaturefraudbridgechallengeidentity)
- [computeP2TRSignatureFraudBridgeChallengeKey](README.md#computep2trsignaturefraudbridgechallengekey)
- [computeP2TRSignatureFraudDraftChallengeIdentity](README.md#computep2trsignaturefrauddraftchallengeidentity)
- [computeP2TRWalletInputWitnessObservationID](README.md#computep2trwalletinputwitnessobservationid)
- [createP2TRSignatureFraudSpendTypeClassifier](README.md#createp2trsignaturefraudspendtypeclassifier)
- [createP2TRWatchtowerChallengeRecord](README.md#createp2trwatchtowerchallengerecord)
- [decodeDestinationReceiver](README.md#decodedestinationreceiver)
- [deserializeP2TRSignatureFraudWitnessObservation](README.md#deserializep2trsignaturefraudwitnessobservation)
- [deserializeP2TRWatchtowerChallengeRecord](README.md#deserializep2trwatchtowerchallengerecord)
- [encodeDestinationReceiver](README.md#encodedestinationreceiver)
- [encodeP2TRSignatureFraudBridgeChallengePayload](README.md#encodep2trsignaturefraudbridgechallengepayload)
- [ethereumAddressFromSigner](README.md#ethereumaddressfromsigner)
- [ethereumCrossChainContractsLoader](README.md#ethereumcrosschaincontractsloader)
- [extractBitcoinRawTxVectors](README.md#extractbitcoinrawtxvectors)
- [extractP2TRKeyPathInputWitnessSignature](README.md#extractp2trkeypathinputwitnesssignature)
- [extractP2TRSignatureFraudWitnessObservations](README.md#extractp2trsignaturefraudwitnessobservations)
- [extractP2TRWalletIDFromScriptPubKey](README.md#extractp2trwalletidfromscriptpubkey)
- [extractP2TRWalletInputWitnessCandidates](README.md#extractp2trwalletinputwitnesscandidates)
- [getChainIdFromEncodedReceiver](README.md#getchainidfromencodedreceiver)
- [getRecipientFromEncodedReceiver](README.md#getrecipientfromencodedreceiver)
- [isValidEncodedReceiver](README.md#isvalidencodedreceiver)
- [listP2TRWatchtowerUnresolvedOperatorAlerts](README.md#listp2trwatchtowerunresolvedoperatoralerts)
- [loadArbitrumCrossChainContracts](README.md#loadarbitrumcrosschaincontracts)
- [loadArbitrumCrossChainInterfaces](README.md#loadarbitrumcrosschaininterfaces)
- [loadBaseCrossChainContracts](README.md#loadbasecrosschaincontracts)
- [loadBaseCrossChainInterfaces](README.md#loadbasecrosschaininterfaces)
- [loadEthereumCoreContracts](README.md#loadethereumcorecontracts)
- [loadSolanaCrossChainInterfaces](README.md#loadsolanacrosschaininterfaces)
- [loadStarkNetCrossChainContracts](README.md#loadstarknetcrosschaincontracts)
- [loadStarkNetCrossChainInterfaces](README.md#loadstarknetcrosschaininterfaces)
- [packRevealDepositParameters](README.md#packrevealdepositparameters)
- [parseP2TRKeyPathWitnessSignature](README.md#parsep2trkeypathwitnesssignature)
- [recordP2TRWatchtowerChallengeEvent](README.md#recordp2trwatchtowerchallengeevent)
- [resolveP2TRInputPrevouts](README.md#resolvep2trinputprevouts)
- [resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType](README.md#resolvep2trwatchtowerobservationidforbitcointxhashandspendtype)
- [resolveP2TRWatchtowerObservationIDForBridgeChallengeKey](README.md#resolvep2trwatchtowerobservationidforbridgechallengekey)
- [retryAll](README.md#retryall)
- [serializeP2TRSignatureFraudWitnessObservation](README.md#serializep2trsignaturefraudwitnessobservation)
- [serializeP2TRWatchtowerChallengeRecord](README.md#serializep2trwatchtowerchallengerecord)
- [skipRetryWhenMatched](README.md#skipretrywhenmatched)
- [stripWitnessesFromBitcoinRawTransaction](README.md#stripwitnessesfrombitcoinrawtransaction)
- [summarizeP2TRWatchtowerChallengeRecords](README.md#summarizep2trwatchtowerchallengerecords)
- [toBitcoinJsLibNetwork](README.md#tobitcoinjslibnetwork)
- [validateBitcoinHeadersChain](README.md#validatebitcoinheaderschain)
- [validateBitcoinSpvProof](README.md#validatebitcoinspvproof)
- [validateDepositReceipt](README.md#validatedepositreceipt)
- [validateP2TRSignatureFraudPayloadBounds](README.md#validatep2trsignaturefraudpayloadbounds)
- [validateP2TRSignatureFraudWitnessObservationConsistency](README.md#validatep2trsignaturefraudwitnessobservationconsistency)

## Type Aliases

### BitcoinTxInput

Ƭ **BitcoinTxInput**: [`BitcoinTxOutpoint`](interfaces/BitcoinTxOutpoint.md) & \{ `scriptSig`: [`Hex`](classes/Hex.md)  }

Data about a Bitcoin transaction input.

#### Defined in

[src/lib/bitcoin/tx.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L63)

___

### BitcoinUtxo

Ƭ **BitcoinUtxo**: [`BitcoinTxOutpoint`](interfaces/BitcoinTxOutpoint.md) & \{ `value`: `BigNumber`  }

Data about a Bitcoin unspent transaction output.

#### Defined in

[src/lib/bitcoin/tx.ts:93](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L93)

___

### ChainMapping

Ƭ **ChainMapping**: `Object`

Type representing a mapping between specific L1 and L2 chains.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `arbitrum?` | [`Arbitrum`](enums/Chains.Arbitrum.md) | Identifier of the Arbitrum L2 chain. |
| `base?` | [`Base`](enums/Chains.Base.md) | Identifier of the Base L2 chain. |
| `ethereum?` | [`Ethereum`](enums/Chains.Ethereum.md) | Identifier of the Ethereum L1 chain. |
| `sei?` | [`Sei`](enums/Chains.Sei.md) | Identifier of the Sei L2 chain. |
| `solana?` | [`Solana`](enums/Chains.Solana.md) | Identifier of the Arbitrum L2 chain. |
| `starknet?` | [`StarkNet`](enums/Chains.StarkNet.md) | Identifier of the StarkNet L2 chain. |
| `sui?` | [`Sui`](enums/Chains.Sui.md) | Identifier of the SUI L2 chain. |

#### Defined in

[src/lib/contracts/chain.ts:88](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain.ts#L88)

___

### CrossChainContracts

Ƭ **CrossChainContracts**: [`CrossChainInterfaces`](README.md#crosschaininterfaces)

**`Deprecated`**

Use CrossChainInterfaces instead

#### Defined in

[src/lib/contracts/cross-chain.ts:252](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L252)

___

### CrossChainDepositorMode

Ƭ **CrossChainDepositorMode**: ``"L2Transaction"`` \| ``"L1Transaction"``

Mode of operation for the cross-chain depositor proxy:
- [L2Transaction]: The proxy will reveal the deposit using a transaction on
  the L2 chain. The tBTC system is responsible for relaying the deposit to
  the tBTC L1 chain.
- [L1Transaction]: The proxy will directly reveal the deposit using a
  transaction on the tBTC L1 chain.

#### Defined in

[src/services/deposits/cross-chain.ts:21](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L21)

___

### CrossChainExtraDataEncoder

Ƭ **CrossChainExtraDataEncoder**: [`ExtraDataEncoder`](interfaces/ExtraDataEncoder.md)

**`Deprecated`**

Use ExtraDataEncoder instead

#### Defined in

[src/lib/contracts/cross-chain.ts:272](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L272)

___

### CrossChainInterfaces

Ƭ **CrossChainInterfaces**: [`DestinationChainInterfaces`](README.md#destinationchaininterfaces) & [`L1CrossChainContracts`](README.md#l1crosschaincontracts)

Convenience type aggregating TBTC cross-chain contracts forming a connector
between TBTC L1 ledger chain and a specific supported destination chain.

#### Defined in

[src/lib/contracts/cross-chain.ts:13](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L13)

___

### DepositRevealedEvent

Ƭ **DepositRevealedEvent**: [`DepositReceipt`](interfaces/DepositReceipt.md) & `Pick`\<[`DepositRequest`](interfaces/DepositRequest.md), ``"amount"`` \| ``"vault"``\> & \{ `fundingOutputIndex`: `number` ; `fundingTxHash`: [`BitcoinTxHash`](classes/BitcoinTxHash.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted on deposit reveal to the on-chain bridge.

#### Defined in

[src/lib/contracts/bridge.ts:385](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L385)

___

### DepositScriptOptions

Ƭ **DepositScriptOptions**: `boolean` \| [`DepositScriptType`](README.md#depositscripttype) \| \{ `scriptType?`: [`DepositScriptType`](README.md#depositscripttype)  }

#### Defined in

[src/services/deposits/deposit.ts:31](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L31)

___

### DepositScriptType

Ƭ **DepositScriptType**: typeof [`DepositScriptType`](README.md#depositscripttype-1)[keyof typeof [`DepositScriptType`](README.md#depositscripttype-1)]

#### Defined in

[src/services/deposits/deposit.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L22)

[src/services/deposits/deposit.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L28)

___

### DestinationChainInterfaces

Ƭ **DestinationChainInterfaces**: `Object`

Aggregates destination chain-specific TBTC cross-chain contracts.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `destinationChainBitcoinDepositor` | [`BitcoinDepositor`](interfaces/BitcoinDepositor.md) |
| `destinationChainTbtcToken` | [`DestinationChainTBTCToken`](interfaces/DestinationChainTBTCToken.md) |
| `l2BitcoinRedeemer?` | [`L2BitcoinRedeemer`](interfaces/L2BitcoinRedeemer.md) |

#### Defined in

[src/lib/contracts/cross-chain.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L19)

___

### DestinationChainName

Ƭ **DestinationChainName**: `Exclude`\<keyof typeof [`Chains`](modules/Chains.md), ``"Ethereum"``\>

Destination chains supported by tBTC v2 contracts.
These are chains other than the main Ethereum L1 chain.

#### Defined in

[src/lib/contracts/chain.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain.ts#L78)

___

### DkgResultApprovedEvent

Ƭ **DkgResultApprovedEvent**: \{ `approver`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `resultHash`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted when a DKG result is approved on the on-chain
wallet registry.

#### Defined in

[src/lib/contracts/wallet-registry.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L64)

___

### DkgResultChallengedEvent

Ƭ **DkgResultChallengedEvent**: \{ `challenger`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `reason`: `string` ; `resultHash`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted when a DKG result is challenged on the on-chain
wallet registry.

#### Defined in

[src/lib/contracts/wallet-registry.ts:79](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L79)

___

### DkgResultSubmittedEvent

Ƭ **DkgResultSubmittedEvent**: \{ `result`: `DkgResult` ; `resultHash`: [`Hex`](classes/Hex.md) ; `seed`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted when a DKG result is submitted to the on-chain
wallet registry.

#### Defined in

[src/lib/contracts/wallet-registry.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L45)

___

### ElectrumClientOptions

Ƭ **ElectrumClientOptions**: `object`

Additional options used by the Electrum server.

#### Defined in

[src/lib/electrum/client.ts:53](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L53)

___

### ErrorMatcherFn

Ƭ **ErrorMatcherFn**: (`err`: `unknown`) => `boolean`

#### Type declaration

▸ (`err`): `boolean`

##### Parameters

| Name | Type |
| :------ | :------ |
| `err` | `unknown` |

##### Returns

`boolean`

#### Defined in

[src/lib/utils/backoff.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L42)

___

### EthereumSigner

Ƭ **EthereumSigner**: `Signer` \| `providers.Provider`

Represents an Ethereum signer. This type is a wrapper for Ethers-specific
types and can be either a Signer that can make write transactions
or a Provider that works only in the read-only mode.

#### Defined in

[src/lib/ethereum/index.ts:26](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L26)

___

### ExecutionLoggerFn

Ƭ **ExecutionLoggerFn**: (`msg`: `string`) => `void`

A function that is called with execution status messages.

#### Type declaration

▸ (`msg`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `msg` | `string` |

##### Returns

`void`

#### Defined in

[src/lib/utils/backoff.ts:56](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L56)

___

### L1BitcoinDepositor

Ƭ **L1BitcoinDepositor**: [`BitcoinDepositor`](interfaces/BitcoinDepositor.md) & \{ `extraDataEncoder`: () => [`ExtraDataEncoder`](interfaces/ExtraDataEncoder.md) ; `getChainIdentifier`: () => [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `getDepositState`: (`depositId`: `string`) => `Promise`\<[`DepositState`](enums/DepositState.md)\> ; `initializeDeposit`: (`depositTx`: [`BitcoinRawTxVectors`](interfaces/BitcoinRawTxVectors.md), `depositOutputIndex`: `number`, `deposit`: [`DepositReceipt`](interfaces/DepositReceipt.md), `vault?`: [`ChainIdentifier`](interfaces/ChainIdentifier.md)) => `Promise`\<`any`\>  }

Interface for communication with the L1BitcoinDepositor on-chain contract
specific to the given L2 chain, deployed on the L1 chain.

#### Defined in

[src/lib/contracts/cross-chain.ts:163](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L163)

___

### L1CrossChainContracts

Ƭ **L1CrossChainContracts**: `Object`

Aggregates L1-specific TBTC cross-chain contracts.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `l1BitcoinDepositor` | [`L1BitcoinDepositor`](README.md#l1bitcoindepositor) |
| `l1BitcoinRedeemer` | [`L1BitcoinRedeemer`](interfaces/L1BitcoinRedeemer.md) \| ``null`` |

#### Defined in

[src/lib/contracts/cross-chain.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L28)

___

### L2BitcoinDepositor

Ƭ **L2BitcoinDepositor**: [`BitcoinDepositor`](interfaces/BitcoinDepositor.md)

**`Deprecated`**

Use BitcoinDepositor instead

#### Defined in

[src/lib/contracts/cross-chain.ts:267](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L267)

___

### L2Chain

Ƭ **L2Chain**: [`DestinationChainName`](README.md#destinationchainname)

**`Deprecated`**

Use DestinationChainName instead

#### Defined in

[src/lib/contracts/chain.ts:83](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain.ts#L83)

___

### L2CrossChainContracts

Ƭ **L2CrossChainContracts**: [`DestinationChainInterfaces`](README.md#destinationchaininterfaces)

**`Deprecated`**

Use DestinationChainInterfaces instead

#### Defined in

[src/lib/contracts/cross-chain.ts:257](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L257)

___

### L2TBTCToken

Ƭ **L2TBTCToken**: [`DestinationChainTBTCToken`](interfaces/DestinationChainTBTCToken.md)

**`Deprecated`**

Use DestinationChainTBTCToken instead

#### Defined in

[src/lib/contracts/cross-chain.ts:262](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L262)

___

### NewWalletRegisteredEvent

Ƭ **NewWalletRegisteredEvent**: \{ `ecdsaWalletID`: [`Hex`](classes/Hex.md) ; `walletID?`: [`Hex`](classes/Hex.md) ; `walletPublicKeyHash`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted when new wallet is registered on the on-chain bridge.

#### Defined in

[src/lib/contracts/bridge.ts:563](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L563)

___

### OptimisticMintingCancelledEvent

Ƭ **OptimisticMintingCancelledEvent**: \{ `depositKey`: [`Hex`](classes/Hex.md) ; `guardian`: [`ChainIdentifier`](interfaces/ChainIdentifier.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event that is emitted when an optimistic minting request
is cancelled on chain.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:170](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L170)

___

### OptimisticMintingFinalizedEvent

Ƭ **OptimisticMintingFinalizedEvent**: \{ `depositKey`: [`Hex`](classes/Hex.md) ; `depositor`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `minter`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `optimisticMintingDebt`: `BigNumber`  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event that is emitted when an optimistic minting request
is finalized on chain.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:186](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L186)

___

### OptimisticMintingRequest

Ƭ **OptimisticMintingRequest**: `Object`

Represents optimistic minting request for the given deposit revealed to the
Bridge.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `finalizedAt` | `number` | UNIX timestamp at which the optimistic minting was finalized. 0 if not yet finalized. |
| `requestedAt` | `number` | UNIX timestamp at which the optimistic minting was requested. |

#### Defined in

[src/lib/contracts/tbtc-vault.ts:120](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L120)

___

### OptimisticMintingRequestedEvent

Ƭ **OptimisticMintingRequestedEvent**: \{ `amount`: `BigNumber` ; `depositKey`: [`Hex`](classes/Hex.md) ; `depositor`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `fundingOutputIndex`: `number` ; `fundingTxHash`: [`BitcoinTxHash`](classes/BitcoinTxHash.md) ; `minter`: [`ChainIdentifier`](interfaces/ChainIdentifier.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event that is emitted when a new optimistic minting is requested
on chain.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:136](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L136)

___

### P2TRKeyPathInputWitnessSignature

Ƭ **P2TRKeyPathInputWitnessSignature**: [`P2TRKeyPathWitnessSignature`](README.md#p2trkeypathwitnesssignature) & \{ `inputIndex`: `number`  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:58](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L58)

___

### P2TRKeyPathWitnessSignature

Ƭ **P2TRKeyPathWitnessSignature**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `sighashType` | [`P2TRSupportedSighashType`](README.md#p2trsupportedsighashtype) |
| `signature` | [`Hex`](classes/Hex.md) |
| `witnessSignature` | [`Hex`](classes/Hex.md) |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:52](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L52)

___

### P2TRSignatureFraudBridgeChallengeDomain

Ƭ **P2TRSignatureFraudBridgeChallengeDomain**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeAddress` | `string` |
| `chainID` | `BigNumberish` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:113](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L113)

___

### P2TRSignatureFraudBridgeChallengeIdentity

Ƭ **P2TRSignatureFraudBridgeChallengeIdentity**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[] |
| `sighash` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `sighashType` | [`P2TRSupportedSighashType`](README.md#p2trsupportedsighashtype) |
| `signature` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `signedInputIndex` | `number` |
| `unsignedTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |
| `walletID` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:97](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L97)

___

### P2TRSignatureFraudBridgeChallengeKey

Ƭ **P2TRSignatureFraudBridgeChallengeKey**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeAddress` | `string` |
| `bridgeChallengeIdentity` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `chainID` | `BigNumberish` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:107](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L107)

___

### P2TRSignatureFraudBridgeChallengePayload

Ƭ **P2TRSignatureFraudBridgeChallengePayload**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `annexPresent` | `boolean` |
| `inputs` | [`P2TRSignatureFraudBridgeChallengePayloadInput`](README.md#p2trsignaturefraudbridgechallengepayloadinput)[] |
| `locktime` | `number` |
| `outputs` | [`P2TRSignatureFraudBridgeChallengePayloadOutput`](README.md#p2trsignaturefraudbridgechallengepayloadoutput)[] |
| `prevouts` | [`P2TRSignatureFraudBridgeChallengePayloadPrevout`](README.md#p2trsignaturefraudbridgechallengepayloadprevout)[] |
| `signedInputIndex` | `number` |
| `version` | `number` |
| `walletID` | `string` |
| `witnessSignature` | `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:393](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L393)

___

### P2TRSignatureFraudBridgeChallengePayloadInput

Ƭ **P2TRSignatureFraudBridgeChallengePayloadInput**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `sequence` | `number` |
| `txid` | `string` |
| `vout` | `number` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:377](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L377)

___

### P2TRSignatureFraudBridgeChallengePayloadOutput

Ƭ **P2TRSignatureFraudBridgeChallengePayloadOutput**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `scriptPubKey` | `string` |
| `valueSats` | `BigNumberish` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:388](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L388)

___

### P2TRSignatureFraudBridgeChallengePayloadPrevout

Ƭ **P2TRSignatureFraudBridgeChallengePayloadPrevout**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `scriptPubKey` | `string` |
| `valueSats` | `BigNumberish` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:383](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L383)

___

### P2TRSignatureFraudBridgeChallengeSubmitterOptions

Ƭ **P2TRSignatureFraudBridgeChallengeSubmitterOptions**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `challengeDepositAmount?` | `BigNumberish` |
| `confirmations?` | `number` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:456](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L456)

___

### P2TRSignatureFraudBridgeFraudParameters

Ƭ **P2TRSignatureFraudBridgeFraudParameters**: `Object`

#### Index signature

▪ [index: `number`]: `unknown`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `fraudChallengeDepositAmount?` | `BigNumberish` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:408](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L408)

___

### P2TRSignatureFraudBridgeTransaction

Ƭ **P2TRSignatureFraudBridgeTransaction**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `hash` | `string` |
| `wait?` | (`confirmations?`: `number`) => `Promise`\<[`P2TRSignatureFraudBridgeTransactionReceipt`](README.md#p2trsignaturefraudbridgetransactionreceipt)\> |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:417](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L417)

___

### P2TRSignatureFraudBridgeTransactionReceipt

Ƭ **P2TRSignatureFraudBridgeTransactionReceipt**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `status?` | `number` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:413](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L413)

___

### P2TRSignatureFraudChallengeSubmissionPolicy

Ƭ **P2TRSignatureFraudChallengeSubmissionPolicy**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `allowedSpendTypes?` | [`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype)[] |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:461](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L461)

___

### P2TRSignatureFraudDraftChallenge

Ƭ **P2TRSignatureFraudDraftChallenge**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[] |
| `sighash` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `sighashType` | [`P2TRSupportedSighashType`](README.md#p2trsupportedsighashtype) |
| `signature` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `signedInputIndex` | `number` |
| `unsignedTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |
| `walletID` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:87](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L87)

___

### P2TRSignatureFraudPayloadBounds

Ƭ **P2TRSignatureFraudPayloadBounds**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `maxInputs?` | `number` |
| `maxOutputs?` | `number` |
| `maxRawTransactionBytes?` | `number` |
| `maxScriptPubKeyBytes?` | `number` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:118](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L118)

___

### P2TRSignatureFraudSpendType

Ƭ **P2TRSignatureFraudSpendType**: typeof [`P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED`](README.md#p2tr_signature_fraud_spend_type_unclassified) \| typeof [`P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP`](README.md#p2tr_signature_fraud_spend_type_deposit_sweep) \| typeof [`P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS`](README.md#p2tr_signature_fraud_spend_type_moving_funds) \| typeof [`P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVED_FUNDS_SWEEP`](README.md#p2tr_signature_fraud_spend_type_moved_funds_sweep) \| typeof [`P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION`](README.md#p2tr_signature_fraud_spend_type_redemption) \| typeof [`P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING`](README.md#p2tr_signature_fraud_spend_type_wallet_closing) \| typeof [`P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT`](README.md#p2tr_signature_fraud_spend_type_heartbeat)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L23)

___

### P2TRSignatureFraudSpendTypeClassifier

Ƭ **P2TRSignatureFraudSpendTypeClassifier**: (`context`: [`P2TRSignatureFraudSpendTypeClassifierContext`](README.md#p2trsignaturefraudspendtypeclassifiercontext)) => [`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype)

#### Type declaration

▸ (`context`): [`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype)

##### Parameters

| Name | Type |
| :------ | :------ |
| `context` | [`P2TRSignatureFraudSpendTypeClassifierContext`](README.md#p2trsignaturefraudspendtypeclassifiercontext) |

##### Returns

[`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:473](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L473)

___

### P2TRSignatureFraudSpendTypeClassifierContext

Ƭ **P2TRSignatureFraudSpendTypeClassifierContext**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeIdentifier?` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `candidate` | [`P2TRWalletInputWitnessCandidate`](README.md#p2trwalletinputwitnesscandidate) |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[] |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |
| `unsignedTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:465](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L465)

___

### P2TRSignatureFraudSpendTypeClassifierRule

Ƭ **P2TRSignatureFraudSpendTypeClassifierRule**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `spendType` | [`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype) |
| `matches` | (`context`: [`P2TRSignatureFraudSpendTypeClassifierContext`](README.md#p2trsignaturefraudspendtypeclassifiercontext)) => `boolean` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:477](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L477)

___

### P2TRSignatureFraudWatchtowerBatchResult

Ƭ **P2TRSignatureFraudWatchtowerBatchResult**\<`T`\>: `Object`

#### Type parameters

| Name |
| :------ |
| `T` |

#### Type declaration

| Name | Type |
| :------ | :------ |
| `failures` | [`P2TRSignatureFraudWatchtowerProcessingFailure`](README.md#p2trsignaturefraudwatchtowerprocessingfailure)\<`T`\>[] |
| `submissions` | [`P2TRSignatureFraudWatchtowerSubmissionResult`](README.md#p2trsignaturefraudwatchtowersubmissionresult)[] |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:190](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L190)

___

### P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget

Ƭ **P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget**: \{ `bitcoinTxHash?`: `never` ; `bridgeChallengeKey?`: `never` ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `spendType?`: `never`  } \| \{ `bitcoinTxHash?`: `never` ; `bridgeChallengeKey`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `observationID?`: `never` ; `spendType?`: `never`  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:218](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L218)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `failures` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleFailure`](README.md#p2trsignaturefraudwatchtowerbridgelifecyclefailure)[] |
| `ignored` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleIgnored`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleignored)[] |
| `records` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleResult`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleresult)[] |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:302](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L302)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleCycleResult

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleCycleResult**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeLifecycle` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult`](README.md#p2trsignaturefraudwatchtowerbridgelifecyclebatchresult) |
| `sourceFailures` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure`](README.md#p2trsignaturefraudwatchtowerbridgelifecyclesourcefailure)[] |
| `summary` | [`P2TRWatchtowerChallengeRecordSummary`](README.md#p2trwatchtowerchallengerecordsummary) |
| `unresolvedOperatorAlerts` | [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)[] |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:313](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L313)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleEvent

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleEvent**: \{ `defeatTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"defeated"``  } & [`P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget`](README.md#p2trsignaturefraudwatchtowerbridgechallengelifecycleeventtarget) & [`P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleeventevidence) \| \{ `type`: ``"honest-spend-proven"``  } & [`P2TRSignatureFraudWatchtowerBridgeProofLifecycleEventTarget`](README.md#p2trsignaturefraudwatchtowerbridgeprooflifecycleeventtarget) & [`P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleeventevidence) \| \{ `type`: ``"timeout-eligible"``  } & [`P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget`](README.md#p2trsignaturefraudwatchtowerbridgechallengelifecycleeventtarget) & [`P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleeventevidence) \| \{ `slashingTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"slashed"``  } & [`P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget`](README.md#p2trsignaturefraudwatchtowerbridgechallengelifecycleeventtarget) & [`P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleeventevidence) \| \{ `rewardTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"rewarded"``  } & [`P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget`](README.md#p2trsignaturefraudwatchtowerbridgechallengelifecycleeventtarget) & [`P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleeventevidence)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:256](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L256)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeChallengeIdentity?` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `sighash?` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `walletID?` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:250](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L250)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleEventTarget

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleEventTarget**: [`P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget`](README.md#p2trsignaturefraudwatchtowerbridgechallengelifecycleeventtarget) \| [`P2TRSignatureFraudWatchtowerBridgeProofLifecycleEventTarget`](README.md#p2trsignaturefraudwatchtowerbridgeprooflifecycleeventtarget)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:246](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L246)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleFailure

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleFailure**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `error` | `string` |
| `event` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleEvent`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleevent) |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:292](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L292)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleIgnored

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleIgnored**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `event` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleEvent`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleevent) |
| `reason` | `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:297](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L297)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleResult

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleResult**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `event` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleEvent`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleevent) |
| `record` | [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord) |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:287](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L287)

___

### P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure

Ƭ **P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `error` | `string` |
| `source` | ``"bridge-lifecycle"`` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:308](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L308)

___

### P2TRSignatureFraudWatchtowerBridgeProofLifecycleEventTarget

Ƭ **P2TRSignatureFraudWatchtowerBridgeProofLifecycleEventTarget**: \{ `bitcoinTxHash?`: `never` ; `bridgeChallengeKey?`: `never` ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `spendType?`: `never`  } \| \{ `bitcoinTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `bridgeChallengeKey?`: `never` ; `observationID?`: `never` ; `spendType`: [`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype)  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:232](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L232)

___

### P2TRSignatureFraudWatchtowerCycleResult

Ƭ **P2TRSignatureFraudWatchtowerCycleResult**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `confirmed` | [`P2TRSignatureFraudWatchtowerBatchResult`](README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](README.md#p2trwatchtowerconfirmedtransaction)\> |
| `mempool` | [`P2TRSignatureFraudWatchtowerBatchResult`](README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerMempoolTransaction`](README.md#p2trwatchtowermempooltransaction)\> |
| `replayed` | [`P2TRSignatureFraudWatchtowerSubmissionResult`](README.md#p2trsignaturefraudwatchtowersubmissionresult)[] |
| `sourceFailures` | [`P2TRSignatureFraudWatchtowerSourceFailure`](README.md#p2trsignaturefraudwatchtowersourcefailure)[] |
| `summary` | [`P2TRWatchtowerChallengeRecordSummary`](README.md#p2trwatchtowerchallengerecordsummary) |
| `unresolvedOperatorAlerts` | [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)[] |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:209](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L209)

___

### P2TRSignatureFraudWatchtowerIntegratedCycleResult

Ƭ **P2TRSignatureFraudWatchtowerIntegratedCycleResult**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeLifecycle` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult`](README.md#p2trsignaturefraudwatchtowerbridgelifecyclebatchresult) |
| `confirmed` | [`P2TRSignatureFraudWatchtowerBatchResult`](README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](README.md#p2trwatchtowerconfirmedtransaction)\> |
| `mempool` | [`P2TRSignatureFraudWatchtowerBatchResult`](README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerMempoolTransaction`](README.md#p2trwatchtowermempooltransaction)\> |
| `replayed` | [`P2TRSignatureFraudWatchtowerSubmissionResult`](README.md#p2trsignaturefraudwatchtowersubmissionresult)[] |
| `sourceFailures` | [`P2TRSignatureFraudWatchtowerIntegratedSourceFailure`](README.md#p2trsignaturefraudwatchtowerintegratedsourcefailure)[] |
| `summary` | [`P2TRWatchtowerChallengeRecordSummary`](README.md#p2trwatchtowerchallengerecordsummary) |
| `unresolvedOperatorAlerts` | [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)[] |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:324](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L324)

___

### P2TRSignatureFraudWatchtowerIntegratedSourceFailure

Ƭ **P2TRSignatureFraudWatchtowerIntegratedSourceFailure**: [`P2TRSignatureFraudWatchtowerSourceFailure`](README.md#p2trsignaturefraudwatchtowersourcefailure) \| [`P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure`](README.md#p2trsignaturefraudwatchtowerbridgelifecyclesourcefailure)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:320](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L320)

___

### P2TRSignatureFraudWatchtowerObservationResult

Ƭ **P2TRSignatureFraudWatchtowerObservationResult**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) |
| `record` | [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord) |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:163](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L163)

___

### P2TRSignatureFraudWatchtowerProcessingFailure

Ƭ **P2TRSignatureFraudWatchtowerProcessingFailure**\<`T`\>: `Object`

#### Type parameters

| Name |
| :------ |
| `T` |

#### Type declaration

| Name | Type |
| :------ | :------ |
| `error` | `string` |
| `transaction` | `T` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:185](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L185)

___

### P2TRSignatureFraudWatchtowerRunnerOptions

Ƭ **P2TRSignatureFraudWatchtowerRunnerOptions**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `maxSubmissionAttempts?` | `number` |
| `submissionAttemptLimitAlert?` | [`P2TRWatchtowerOperatorAlert`](README.md#p2trwatchtoweroperatoralert) |
| `submissionPolicy?` | [`P2TRSignatureFraudChallengeSubmissionPolicy`](README.md#p2trsignaturefraudchallengesubmissionpolicy) |
| `submitChallenges?` | `boolean` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:178](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L178)

___

### P2TRSignatureFraudWatchtowerSourceFailure

Ƭ **P2TRSignatureFraudWatchtowerSourceFailure**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `error` | `string` |
| `source` | [`P2TRSignatureFraudWatchtowerTransactionSourceName`](README.md#p2trsignaturefraudwatchtowertransactionsourcename) |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:199](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L199)

___

### P2TRSignatureFraudWatchtowerSubmissionResult

Ƭ **P2TRSignatureFraudWatchtowerSubmissionResult**: [`P2TRSignatureFraudWatchtowerObservationResult`](README.md#p2trsignaturefraudwatchtowerobservationresult) & \{ `submissionRecord`: [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:168](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L168)

___

### P2TRSignatureFraudWatchtowerTransactionSourceName

Ƭ **P2TRSignatureFraudWatchtowerTransactionSourceName**: ``"mempool"`` \| ``"confirmed"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:195](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L195)

___

### P2TRSignatureFraudWitnessObservation

Ƭ **P2TRSignatureFraudWitnessObservation**: [`P2TRWalletInputWitnessCandidate`](README.md#p2trwalletinputwitnesscandidate) & \{ `bridgeChallengeIdentity`: [`Hex`](classes/Hex.md) ; `bridgeChallengeKey?`: [`Hex`](classes/Hex.md) ; `draftChallengeIdentity`: [`Hex`](classes/Hex.md) ; `inputPrevouts`: [`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[] ; `observationID`: [`Hex`](classes/Hex.md) ; `rawTransaction`: [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) ; `sighash`: [`Hex`](classes/Hex.md) ; `spendType`: [`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype) ; `unsignedTransaction`: [`BitcoinRawTx`](interfaces/BitcoinRawTx.md)  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:125](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L125)

___

### P2TRSignatureFraudWitnessObservationConsistencyContext

Ƭ **P2TRSignatureFraudWitnessObservationConsistencyContext**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeChallengeDomain?` | [`P2TRSignatureFraudBridgeChallengeDomain`](README.md#p2trsignaturefraudbridgechallengedomain) |
| `bridgeIdentifier?` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `payloadBounds?` | [`P2TRSignatureFraudPayloadBounds`](README.md#p2trsignaturefraudpayloadbounds) |
| `spendTypeClassifier?` | [`P2TRSignatureFraudSpendTypeClassifier`](README.md#p2trsignaturefraudspendtypeclassifier) |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:482](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L482)

___

### P2TRSignatureFraudWitnessObservationJSON

Ƭ **P2TRSignatureFraudWitnessObservationJSON**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeChallengeIdentity?` | `string` |
| `bridgeChallengeKey?` | `string` |
| `draftChallengeIdentity` | `string` |
| `inputIndex` | `number` |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevoutJSON`](README.md#p2trwalletinputobservationprevoutjson)[] |
| `observationID` | `string` |
| `rawTransactionHex` | `string` |
| `scriptPubKey` | `string` |
| `sighash` | `string` |
| `sighashType` | [`P2TRSupportedSighashType`](README.md#p2trsupportedsighashtype) |
| `signature` | `string` |
| `spendType?` | [`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype) |
| `unsignedTransactionHex` | `string` |
| `walletID` | `string` |
| `witnessSignature` | `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:145](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L145)

___

### P2TRSupportedSighashType

Ƭ **P2TRSupportedSighashType**: typeof [`P2TR_SIGHASH_DEFAULT`](README.md#p2tr_sighash_default) \| typeof [`P2TR_SIGHASH_ALL`](README.md#p2tr_sighash_all)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:10](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L10)

___

### P2TRWalletInputObservationPrevout

Ƭ **P2TRWalletInputObservationPrevout**: [`P2TRWalletInputPrevout`](README.md#p2trwalletinputprevout) & \{ `txid`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `valueSats`: `BigNumberish` ; `vout`: `number`  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:66](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L66)

___

### P2TRWalletInputObservationPrevoutJSON

Ƭ **P2TRWalletInputObservationPrevoutJSON**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `scriptPubKey` | `string` |
| `txid` | `string` |
| `valueSats` | `string` |
| `vout` | `number` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:138](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L138)

___

### P2TRWalletInputPrevout

Ƭ **P2TRWalletInputPrevout**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `scriptPubKey` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L62)

___

### P2TRWalletInputWitnessCandidate

Ƭ **P2TRWalletInputWitnessCandidate**: [`P2TRKeyPathInputWitnessSignature`](README.md#p2trkeypathinputwitnesssignature) & \{ `scriptPubKey`: [`Hex`](classes/Hex.md) ; `walletID`: [`Hex`](classes/Hex.md)  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L72)

___

### P2TRWalletInputWitnessObservation

Ƭ **P2TRWalletInputWitnessObservation**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridgeIdentifier?` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `inputIndex` | `number` |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[] |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |
| `walletID` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `witnessSignature` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L78)

___

### P2TRWatchtowerBitcoinStatus

Ƭ **P2TRWatchtowerBitcoinStatus**: ``"mempool"`` \| ``"confirmed"`` \| ``"evicted"`` \| ``"reorged"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:512](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L512)

___

### P2TRWatchtowerChallengeEvent

Ƭ **P2TRWatchtowerChallengeEvent**: \{ `observation?`: [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"observed"``  } \| \{ `bitcoinTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `observation?`: [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"mempool-observed"``  } \| \{ `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"mempool-evicted"``  } \| \{ `bitcoinBlockHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `bitcoinBlockHeight`: `number` ; `bitcoinTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `observation?`: [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"bitcoin-confirmed"``  } \| \{ `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"bitcoin-reorged"``  } \| \{ `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"submission-started"``  } \| \{ `challengeTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"submission-accepted"``  } \| \{ `error`: `string` ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"submission-rejected"``  } \| \{ `defeatTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"defeated"``  } \| \{ `bitcoinTxHash?`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"honest-spend-proven"``  } \| \{ `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"timeout-eligible"``  } \| \{ `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `slashingTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"slashed"``  } \| \{ `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `rewardTxHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"rewarded"``  } \| \{ `code`: `string` ; `message`: `string` ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"operator-alert-raised"``  } \| \{ `acknowledgedBy`: `string` ; `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"operator-alert-acknowledged"``  } \| \{ `observationID`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `type`: ``"operator-alert-cleared"``  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:593](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L593)

___

### P2TRWatchtowerChallengeRecord

Ƭ **P2TRWatchtowerChallengeRecord**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bitcoinBlockHash?` | [`Hex`](classes/Hex.md) |
| `bitcoinBlockHeight?` | `number` |
| `bitcoinStatus?` | [`P2TRWatchtowerBitcoinStatus`](README.md#p2trwatchtowerbitcoinstatus) |
| `bitcoinTxHash?` | [`Hex`](classes/Hex.md) |
| `challengeTxHash?` | [`Hex`](classes/Hex.md) |
| `defeatTxHash?` | [`Hex`](classes/Hex.md) |
| `lastError?` | `string` |
| `observation?` | [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) |
| `observationID` | [`Hex`](classes/Hex.md) |
| `operatorAlertAcknowledgedBy?` | `string` |
| `operatorAlertCode?` | `string` |
| `operatorAlertMessage?` | `string` |
| `operatorAlertStatus?` | [`P2TRWatchtowerOperatorAlertStatus`](README.md#p2trwatchtoweroperatoralertstatus) |
| `rewardTxHash?` | [`Hex`](classes/Hex.md) |
| `slashingTxHash?` | [`Hex`](classes/Hex.md) |
| `status` | [`P2TRWatchtowerChallengeStatus`](README.md#p2trwatchtowerchallengestatus) |
| `submissionAttempts` | `number` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:523](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L523)

___

### P2TRWatchtowerChallengeRecordJSON

Ƭ **P2TRWatchtowerChallengeRecordJSON**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bitcoinBlockHash?` | `string` |
| `bitcoinBlockHeight?` | `number` |
| `bitcoinStatus?` | [`P2TRWatchtowerBitcoinStatus`](README.md#p2trwatchtowerbitcoinstatus) |
| `bitcoinTxHash?` | `string` |
| `challengeTxHash?` | `string` |
| `defeatTxHash?` | `string` |
| `lastError?` | `string` |
| `observation?` | [`P2TRSignatureFraudWitnessObservationJSON`](README.md#p2trsignaturefraudwitnessobservationjson) |
| `observationID` | `string` |
| `operatorAlertAcknowledgedBy?` | `string` |
| `operatorAlertCode?` | `string` |
| `operatorAlertMessage?` | `string` |
| `operatorAlertStatus?` | [`P2TRWatchtowerOperatorAlertStatus`](README.md#p2trwatchtoweroperatoralertstatus) |
| `rewardTxHash?` | `string` |
| `slashingTxHash?` | `string` |
| `status` | [`P2TRWatchtowerChallengeStatus`](README.md#p2trwatchtowerchallengestatus) |
| `submissionAttempts` | `number` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:543](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L543)

___

### P2TRWatchtowerChallengeRecordSummary

Ƭ **P2TRWatchtowerChallengeRecordSummary**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `byBitcoinStatus` | `Record`\<[`P2TRWatchtowerBitcoinStatus`](README.md#p2trwatchtowerbitcoinstatus), `number`\> |
| `byOperatorAlertStatus` | `Record`\<[`P2TRWatchtowerOperatorAlertStatus`](README.md#p2trwatchtoweroperatoralertstatus), `number`\> |
| `byStatus` | `Record`\<[`P2TRWatchtowerChallengeStatus`](README.md#p2trwatchtowerchallengestatus), `number`\> |
| `total` | `number` |
| `unresolvedOperatorAlerts` | `number` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:563](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L563)

___

### P2TRWatchtowerChallengeStatus

Ƭ **P2TRWatchtowerChallengeStatus**: ``"observed"`` \| ``"submitting"`` \| ``"submitted"`` \| ``"rejected"`` \| ``"defeat-eligible"`` \| ``"defeated"`` \| ``"timeout-eligible"`` \| ``"slashed"`` \| ``"rewarded"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:501](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L501)

___

### P2TRWatchtowerConfirmedTransaction

Ƭ **P2TRWatchtowerConfirmedTransaction**: [`P2TRWatchtowerMempoolTransaction`](README.md#p2trwatchtowermempooltransaction) & \{ `bitcoinBlockHash`: [`Hex`](classes/Hex.md) \| `Buffer` \| `string` ; `bitcoinBlockHeight`: `number`  }

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:363](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L363)

___

### P2TRWatchtowerMempoolTransaction

Ƭ **P2TRWatchtowerMempoolTransaction**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bitcoinTxHash` | [`Hex`](classes/Hex.md) \| `Buffer` \| `string` |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:358](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L358)

___

### P2TRWatchtowerOperatorAlert

Ƭ **P2TRWatchtowerOperatorAlert**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `code` | `string` |
| `message` | `string` |

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:173](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L173)

___

### P2TRWatchtowerOperatorAlertStatus

Ƭ **P2TRWatchtowerOperatorAlertStatus**: ``"open"`` \| ``"acknowledged"`` \| ``"cleared"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:518](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L518)

___

### P2TRWitnessSignatureErrorCode

Ƭ **P2TRWitnessSignatureErrorCode**: ``"invalid-observation-payload"`` \| ``"invalid-input-index"`` \| ``"invalid-length"`` \| ``"invalid-prevout-map"`` \| ``"invalid-watchtower-state"`` \| ``"missing-witness"`` \| ``"unsupported-sighash"`` \| ``"unsupported-witness-form"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L32)

___

### RedemptionRequestedEvent

Ƭ **RedemptionRequestedEvent**: `Omit`\<[`RedemptionRequest`](interfaces/RedemptionRequest.md), ``"requestedAt"``\> & \{ `walletPublicKeyHash`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted on redemption request.

#### Defined in

[src/lib/contracts/bridge.ts:446](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L446)

___

### RetrierFn

Ƭ **RetrierFn**\<`T`\>: (`fn`: () => `Promise`\<`T`\>) => `Promise`\<`T`\>

#### Type parameters

| Name |
| :------ |
| `T` |

#### Type declaration

▸ (`fn`): `Promise`\<`T`\>

##### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `fn` | () => `Promise`\<`T`\> | The function to be retried. |

##### Returns

`Promise`\<`T`\>

#### Defined in

[src/lib/utils/backoff.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L51)

___

### SeiProvider

Ƭ **SeiProvider**: `ethers.providers.Provider`

Sei provider type - uses standard Ethereum provider since Sei is EVM-compatible

#### Defined in

[src/lib/sei/types.ts:6](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/types.ts#L6)

___

### SeiSigner

Ƭ **SeiSigner**: `ethers.Signer`

Sei signer type - uses standard Ethereum signer

#### Defined in

[src/lib/sei/types.ts:11](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/types.ts#L11)

___

### StarkNetDepositorConfig

Ƭ **StarkNetDepositorConfig**: [`StarkNetBitcoinDepositorConfig`](interfaces/StarkNetBitcoinDepositorConfig.md)

**`Deprecated`**

Use StarkNetBitcoinDepositorConfig instead

#### Defined in

[src/lib/starknet/starknet-depositor.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L67)

___

### StarkNetProvider

Ƭ **StarkNetProvider**: `Provider` \| `Account`

Represents a StarkNet provider that can be either a Provider or Account instance.
This follows the pattern similar to Solana's Connection type.

- Provider: For read-only operations (e.g., balance queries)
- Account: For write operations (e.g., transactions)

#### Defined in

[src/lib/starknet/types.ts:10](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/types.ts#L10)

___

### TBTCContracts

Ƭ **TBTCContracts**: `Object`

Convenience type aggregating all TBTC core contracts.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridge` | [`Bridge`](interfaces/Bridge.md) |
| `tbtcToken` | [`TBTCToken`](interfaces/TBTCToken.md) |
| `tbtcVault` | [`TBTCVault`](interfaces/TBTCVault.md) |
| `walletRegistry` | [`WalletRegistry`](interfaces/WalletRegistry.md) |

#### Defined in

[src/lib/contracts/index.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/index.ts#L19)

___

### TaprootDepositReceipt

Ƭ **TaprootDepositReceipt**: [`DepositReceipt`](interfaces/DepositReceipt.md) & \{ `refundXOnlyPublicKey`: [`Hex`](classes/Hex.md) ; `walletXOnlyPublicKey`: [`Hex`](classes/Hex.md)  }

Represents a Taproot-native deposit receipt. The receipt holds all
information required to build a unique P2TR deposit address on Bitcoin chain.

#### Defined in

[src/lib/contracts/bridge.ts:296](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L296)

___

### TaprootDepositRevealedEvent

Ƭ **TaprootDepositRevealedEvent**: [`TaprootDepositReceipt`](README.md#taprootdepositreceipt) & `Pick`\<[`DepositRequest`](interfaces/DepositRequest.md), ``"amount"`` \| ``"vault"``\> & \{ `fundingOutputIndex`: `number` ; `fundingTxHash`: [`BitcoinTxHash`](classes/BitcoinTxHash.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted on Taproot-native deposit reveal to the on-chain
bridge.

#### Defined in

[src/lib/contracts/bridge.ts:395](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L395)

## Variables

### ArbitrumCrossChainExtraDataEncoder

• `Const` **ArbitrumCrossChainExtraDataEncoder**: typeof [`ArbitrumExtraDataEncoder`](classes/ArbitrumExtraDataEncoder.md) = `ArbitrumExtraDataEncoder`

**`Deprecated`**

Use ArbitrumExtraDataEncoder instead

#### Defined in

[src/lib/arbitrum/l2-bitcoin-depositor.ts:159](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/l2-bitcoin-depositor.ts#L159)

___

### ArbitrumL2BitcoinDepositor

• `Const` **ArbitrumL2BitcoinDepositor**: typeof [`ArbitrumBitcoinDepositor`](classes/ArbitrumBitcoinDepositor.md) = `ArbitrumBitcoinDepositor`

**`Deprecated`**

Use ArbitrumBitcoinDepositor instead

#### Defined in

[src/lib/arbitrum/l2-bitcoin-depositor.ts:154](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/l2-bitcoin-depositor.ts#L154)

___

### ArbitrumL2TBTCToken

• `Const` **ArbitrumL2TBTCToken**: typeof [`ArbitrumTBTCToken`](classes/ArbitrumTBTCToken.md) = `ArbitrumTBTCToken`

**`Deprecated`**

Use ArbitrumTBTCToken instead

#### Defined in

[src/lib/arbitrum/l2-tbtc-token.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/l2-tbtc-token.ts#L63)

___

### BaseL2BitcoinDepositor

• `Const` **BaseL2BitcoinDepositor**: typeof [`BaseBitcoinDepositor`](classes/BaseBitcoinDepositor.md) = `BaseBitcoinDepositor`

**`Deprecated`**

Use BaseBitcoinDepositor instead

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:124](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L124)

___

### BaseL2TBTCToken

• `Const` **BaseL2TBTCToken**: typeof [`BaseTBTCToken`](classes/BaseTBTCToken.md) = `BaseTBTCToken`

**`Deprecated`**

Use BaseTBTCToken instead

#### Defined in

[src/lib/base/l2-tbtc-token.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-tbtc-token.ts#L64)

___

### BitcoinAddressConverter

• `Const` **BitcoinAddressConverter**: `Object`

Utility functions allowing to perform Bitcoin address conversions.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `addressToOutputScript` | (`address`: `string`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => [`Hex`](classes/Hex.md) |
| `addressToPublicKeyHash` | (`address`: `string`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => [`Hex`](classes/Hex.md) |
| `addressToTaprootOutputKey` | (`address`: `string`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => [`Hex`](classes/Hex.md) |
| `outputScriptToAddress` | (`script`: [`Hex`](classes/Hex.md), `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => `string` |
| `publicKeyHashToAddress` | (`publicKeyHash`: [`Hex`](classes/Hex.md), `witness`: `boolean`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => `string` |
| `publicKeyToAddress` | (`publicKey`: [`Hex`](classes/Hex.md), `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md), `witness`: `boolean`) => `string` |
| `taprootOutputKeyToAddress` | (`outputKey`: [`Hex`](classes/Hex.md), `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => `string` |
| `taprootOutputKeyToWalletPublicKeyHash` | (`outputKey`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |

#### Defined in

[src/lib/bitcoin/address.ts:206](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/address.ts#L206)

___

### BitcoinCompactSizeUint

• `Const` **BitcoinCompactSizeUint**: `Object`

Utility functions allowing to deal with Bitcoin compact size uints.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `read` | (`varLenData`: [`Hex`](classes/Hex.md)) => \{ `byteLength`: `number` ; `value`: `number`  } |

#### Defined in

[src/lib/bitcoin/csuint.ts:50](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/csuint.ts#L50)

___

### BitcoinHashUtils

• `Const` **BitcoinHashUtils**: `Object`

Utility functions allowing to deal with Bitcoin hashes.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `computeHash160` | (`text`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |
| `computeHash256` | (`text`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |
| `computeSha256` | (`text`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |
| `hashLEToBigNumber` | (`hash`: [`Hex`](classes/Hex.md)) => `BigNumber` |

#### Defined in

[src/lib/bitcoin/hash.ts:52](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/hash.ts#L52)

___

### BitcoinHeaderSerializer

• `Const` **BitcoinHeaderSerializer**: `Object`

Utility functions allowing to serialize and deserialize Bitcoin block headers.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `deserializeHeader` | (`rawHeader`: [`Hex`](classes/Hex.md)) => [`BitcoinHeader`](interfaces/BitcoinHeader.md) |
| `deserializeHeadersChain` | (`rawHeadersChain`: [`Hex`](classes/Hex.md)) => [`BitcoinHeader`](interfaces/BitcoinHeader.md)[] |
| `serializeHeader` | (`header`: [`BitcoinHeader`](interfaces/BitcoinHeader.md)) => [`Hex`](classes/Hex.md) |

#### Defined in

[src/lib/bitcoin/header.ts:109](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L109)

___

### BitcoinLocktimeUtils

• `Const` **BitcoinLocktimeUtils**: `Object`

Utility functions allowing to deal with Bitcoin locktime.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `calculateLocktime` | (`locktimeStartedAt`: `number`, `locktimeDuration`: `number`) => [`Hex`](classes/Hex.md) |
| `locktimeToNumber` | (`locktimeLE`: `string` \| `Buffer`\<`ArrayBufferLike`\>) => `number` |

#### Defined in

[src/lib/bitcoin/tx.ts:234](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L234)

___

### BitcoinPrivateKeyUtils

• `Const` **BitcoinPrivateKeyUtils**: `Object`

Utility functions allowing to perform operations on Bitcoin ECDSA private keys.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `createKeyPair` | (`privateKey`: `string`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => `ECPairInterface` |

#### Defined in

[src/lib/bitcoin/ecdsa-key.ts:118](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/ecdsa-key.ts#L118)

___

### BitcoinPublicKeyUtils

• `Const` **BitcoinPublicKeyUtils**: `Object`

Utility functions allowing to perform operations on Bitcoin ECDSA public keys.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `compressPublicKey` | (`publicKey`: [`Hex`](classes/Hex.md)) => `string` |
| `isCompressedPublicKey` | (`publicKey`: [`Hex`](classes/Hex.md)) => `boolean` |
| `walletKeyToPublicKeyHash` | (`walletKey`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |
| `xOnlyToCompressedPublicKey` | (`walletID`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |

#### Defined in

[src/lib/bitcoin/ecdsa-key.ts:90](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/ecdsa-key.ts#L90)

___

### BitcoinScriptUtils

• `Const` **BitcoinScriptUtils**: `Object`

Utility functions allowing to deal with Bitcoin scripts.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `isP2PKHScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |
| `isP2SHScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |
| `isP2TRScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |
| `isP2WPKHScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |
| `isP2WSHScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |

#### Defined in

[src/lib/bitcoin/script.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/script.ts#L78)

___

### BitcoinTaprootUtils

• `Const` **BitcoinTaprootUtils**: `Object`

Utility functions for BIP-341 Taproot key and script tree derivation.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `TAPROOT_LEAF_VERSION` | `number` |
| `compactSizeUint` | (`value`: `number`) => `Buffer` |
| `deriveTaprootOutputKey` | (`internalKey`: [`Hex`](classes/Hex.md), `merkleRoot?`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |
| `deriveTaprootOutputKeyWithParity` | (`internalKey`: [`Hex`](classes/Hex.md), `merkleRoot?`: [`Hex`](classes/Hex.md)) => \{ `outputKey`: [`Hex`](classes/Hex.md) ; `parity`: `number`  } |
| `taggedHash` | (`tag`: `string`, `payload`: `Buffer`\<`ArrayBufferLike`\>) => `Buffer` |
| `tapLeafHash` | (`script`: [`Hex`](classes/Hex.md), `leafVersion`: `number`) => [`Hex`](classes/Hex.md) |
| `tapTweak` | (`internalKey`: [`Hex`](classes/Hex.md), `merkleRoot?`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |

#### Defined in

[src/lib/bitcoin/taproot.ts:140](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/taproot.ts#L140)

___

### BitcoinTargetConverter

• `Const` **BitcoinTargetConverter**: `Object`

Utility functions allowing to perform Bitcoin target conversions.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bitsToTarget` | (`bits`: `number`) => `BigNumber` |
| `targetToDifficulty` | (`target`: `BigNumber`) => `BigNumber` |

#### Defined in

[src/lib/bitcoin/header.ts:268](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L268)

___

### ChainMappings

• `Const` **ChainMappings**: [`ChainMapping`](README.md#chainmapping)[]

List of chain mappings supported by tBTC v2 contracts.

#### Defined in

[src/lib/contracts/chain.ts:124](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain.ts#L124)

___

### DepositScriptType

• `Const` **DepositScriptType**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `P2SH` | ``"p2sh"`` |
| `P2TR` | ``"p2tr"`` |
| `P2WSH` | ``"p2wsh"`` |

#### Defined in

[src/services/deposits/deposit.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L22)

[src/services/deposits/deposit.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L28)

___

### EthereumCrossChainExtraDataEncoder

• `Const` **EthereumCrossChainExtraDataEncoder**: typeof [`EthereumExtraDataEncoder`](classes/EthereumExtraDataEncoder.md) = `EthereumExtraDataEncoder`

**`Deprecated`**

Use EthereumExtraDataEncoder instead

#### Defined in

[src/lib/ethereum/l1-bitcoin-depositor.ts:221](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L221)

___

### P2TR\_SIGHASH\_ALL

• `Const` **P2TR\_SIGHASH\_ALL**: ``1``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:8](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L8)

___

### P2TR\_SIGHASH\_DEFAULT

• `Const` **P2TR\_SIGHASH\_DEFAULT**: ``0``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:7](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L7)

___

### P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_ACTION\_SUBMIT

• `Const` **P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_ACTION\_SUBMIT**: ``0``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:375](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L375)

___

### P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_ID\_DOMAIN

• `Const` **P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_ID\_DOMAIN**: ``"tbtc-p2tr-signature-fraud-bridge-challenge-v0"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:495](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L495)

___

### P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_KEY\_DOMAIN

• `Const` **P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_KEY\_DOMAIN**: ``"tbtc-p2tr-signature-fraud-bridge-key-v0"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:498](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L498)

___

### P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_PAYLOAD\_ABI\_TYPE

• `Const` **P2TR\_SIGNATURE\_FRAUD\_BRIDGE\_CHALLENGE\_PAYLOAD\_ABI\_TYPE**: ``"tuple(bytes32 walletID,uint32 version,uint32 locktime,tuple(bytes32 txid,uint32 vout,uint32 sequence)[] inputs,tuple(uint64 valueSats,bytes scriptPubKey)[] prevouts,tuple(uint64 valueSats,bytes scriptPubKey)[] outputs,uint32 signedInputIndex,bool annexPresent,bytes witnessSignature)"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:405](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L405)

___

### P2TR\_SIGNATURE\_FRAUD\_DRAFT\_CHALLENGE\_ID\_DOMAIN

• `Const` **P2TR\_SIGNATURE\_FRAUD\_DRAFT\_CHALLENGE\_ID\_DOMAIN**: ``"tbtc-p2tr-signature-fraud-challenge-v0"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:492](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L492)

___

### P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_DEPOSIT\_SWEEP

• `Const` **P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_DEPOSIT\_SWEEP**: ``"deposit-sweep"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:15](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L15)

___

### P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_HEARTBEAT

• `Const` **P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_HEARTBEAT**: ``"heartbeat"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:21](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L21)

___

### P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_MOVED\_FUNDS\_SWEEP

• `Const` **P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_MOVED\_FUNDS\_SWEEP**: ``"moved-funds-sweep"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:17](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L17)

___

### P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_MOVING\_FUNDS

• `Const` **P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_MOVING\_FUNDS**: ``"moving-funds"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:16](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L16)

___

### P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_REDEMPTION

• `Const` **P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_REDEMPTION**: ``"redemption"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L19)

___

### P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_UNCLASSIFIED

• `Const` **P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_UNCLASSIFIED**: ``"unclassified"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L14)

___

### P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_WALLET\_CLOSING

• `Const` **P2TR\_SIGNATURE\_FRAUD\_SPEND\_TYPE\_WALLET\_CLOSING**: ``"wallet-closing"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L20)

___

### P2TR\_WATCHTOWER\_OBSERVATION\_ID\_DOMAIN

• `Const` **P2TR\_WATCHTOWER\_OBSERVATION\_ID\_DOMAIN**: ``"tbtc-p2tr-watchtower-observation-v0"``

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:489](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L489)

___

### SeiL2TBTCToken

• `Const` **SeiL2TBTCToken**: typeof [`SeiTBTCToken`](classes/SeiTBTCToken.md) = `SeiTBTCToken`

**`Deprecated`**

Use SeiTBTCToken instead

#### Defined in

[src/lib/sei/l2-tbtc-token.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/l2-tbtc-token.ts#L64)

___

### SolanaCrossChainExtraDataEncoder

• `Const` **SolanaCrossChainExtraDataEncoder**: typeof [`SolanaExtraDataEncoder`](classes/SolanaExtraDataEncoder.md) = `SolanaExtraDataEncoder`

**`Deprecated`**

Use SolanaExtraDataEncoder instead

#### Defined in

[src/lib/solana/extra-data-encoder.ts:60](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/extra-data-encoder.ts#L60)

___

### StarkNetCrossChainExtraDataEncoder

• `Const` **StarkNetCrossChainExtraDataEncoder**: typeof [`StarkNetExtraDataEncoder`](classes/StarkNetExtraDataEncoder.md) = `StarkNetExtraDataEncoder`

**`Deprecated`**

Use StarkNetExtraDataEncoder instead

#### Defined in

[src/lib/starknet/extra-data-encoder.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/extra-data-encoder.ts#L67)

___

### StarkNetDepositor

• `Const` **StarkNetDepositor**: typeof [`StarkNetBitcoinDepositor`](classes/StarkNetBitcoinDepositor.md) = `StarkNetBitcoinDepositor`

**`Deprecated`**

Use StarkNetBitcoinDepositor instead

#### Defined in

[src/lib/starknet/starknet-depositor.ts:527](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L527)

___

### WORMHOLE\_CHAIN\_IDS

• `Const` **WORMHOLE\_CHAIN\_IDS**: `Object`

Mapping of chain identifiers to their corresponding Wormhole chain IDs.
Use these constants instead of hardcoded chain IDs when encoding destination
receivers for NTT (Native Token Transfer) bridges.

**`Example`**

```typescript
import { WORMHOLE_CHAIN_IDS, Chains, encodeDestinationReceiver } from "@keep-network/tbtc-v2"

const encoded = encodeDestinationReceiver(
  WORMHOLE_CHAIN_IDS[Chains.Sei.Testnet],
  "0x1234567890123456789012345678901234567890"
)
```

#### Type declaration

| Name | Type |
| :------ | :------ |
| `1` | `number` |
| `11155111` | `number` |
| `1328` | `number` |
| `1329` | `number` |

#### Defined in

[src/lib/utils/wormhole.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/wormhole.ts#L20)

___

### tbtcABI

• `Const` **tbtcABI**: `StarkNetABIEntry`[]

tBTC token ABI for StarkNet
Includes standard ERC20 functions needed for tBTC operations

#### Defined in

[src/lib/starknet/abi.ts:26](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/abi.ts#L26)

## Functions

### amountToSatoshi

▸ **amountToSatoshi**(`value`): `BigNumber`

Converts the amount to Satoshi precision.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `value` | `BigNumber` | The amount to be converted. |

#### Returns

`BigNumber`

The amount in Satoshi precision.

#### Defined in

[src/lib/utils/bitcoin.ts:8](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/bitcoin.ts#L8)

___

### applyP2TRWatchtowerChallengeEvent

▸ **applyP2TRWatchtowerChallengeEvent**(`record`, `event`): [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord) |
| `event` | [`P2TRWatchtowerChallengeEvent`](README.md#p2trwatchtowerchallengeevent) |

#### Returns

[`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1817](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1817)

___

### assembleBitcoinSpvProof

▸ **assembleBitcoinSpvProof**(`transactionHash`, `requiredConfirmations`, `bitcoinClient`): `Promise`\<[`BitcoinTx`](interfaces/BitcoinTx.md) & [`BitcoinSpvProof`](interfaces/BitcoinSpvProof.md)\>

Assembles a proof that a given transaction was included in the blockchain and
has accumulated the required number of confirmations.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](classes/BitcoinTxHash.md) | Hash of the transaction being proven. |
| `requiredConfirmations` | `number` | Required number of confirmations. |
| `bitcoinClient` | [`BitcoinClient`](interfaces/BitcoinClient.md) | Bitcoin client used to interact with the network. |

#### Returns

`Promise`\<[`BitcoinTx`](interfaces/BitcoinTx.md) & [`BitcoinSpvProof`](interfaces/BitcoinSpvProof.md)\>

Bitcoin transaction along with the inclusion proof.

#### Defined in

[src/lib/bitcoin/spv.ts:75](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L75)

___

### backoffRetrier

▸ **backoffRetrier**\<`T`\>(`retries`, `backoffStepMs?`, `logger?`, `errorMatcher?`): [`RetrierFn`](README.md#retrierfn)\<`T`\>

Returns a retrier that can be passed a function to be retried `retries`
number of times, with exponential backoff. The result will return the
function's return value if no exceptions are thrown. It will only retry if
the function throws an exception matched by `matcher`; {@see retryAll} can
be used to retry no matter the exception, though this is not necessarily
recommended in production.

Example usage:

     await url.get("https://example.com/") // may transiently fail
     // Retries 3 times with exponential backoff, no matter what error is
     // reported by `url.get`.
     backoffRetrier(3)(async () => url.get("https://example.com"))
     // Retries 3 times with exponential backoff, but only if the error
     // message includes "server unavailable".
     backoffRetrier(3, (_) => _.message.includes('server unavailable'))(
       async () => url.get("https://example.com"))
     )

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `retries` | `number` | `undefined` | The number of retries to perform before bubbling the failure out. |
| `backoffStepMs` | `number` | `1000` | Initial backoff step in milliseconds that will be increased exponentially for subsequent retry attempts. (default = 1000 ms) |
| `logger` | [`ExecutionLoggerFn`](README.md#executionloggerfn) | `console.debug` | A logger function to pass execution messages. |
| `errorMatcher?` | [`ErrorMatcherFn`](README.md#errormatcherfn) | `retryAll` | A matcher function that receives the error when an exception is thrown, and returns true if the error should lead to a retry. A false return will rethrow the error and terminate the retry loop. |

#### Returns

[`RetrierFn`](README.md#retrierfn)\<`T`\>

A function that can retry any function.

#### Defined in

[src/lib/utils/backoff.ts:89](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L89)

___

### buildP2TRSignatureFraudBridgeChallengePayload

▸ **buildP2TRSignatureFraudBridgeChallengePayload**(`observation`): [`P2TRSignatureFraudBridgeChallengePayload`](README.md#p2trsignaturefraudbridgechallengepayload)

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) |

#### Returns

[`P2TRSignatureFraudBridgeChallengePayload`](README.md#p2trsignaturefraudbridgechallengepayload)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2698](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2698)

___

### chainIdFromSigner

▸ **chainIdFromSigner**(`signer`): `Promise`\<`string`\>

Resolves the chain ID from the given signer.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | The signer whose chain ID should be resolved. |

#### Returns

`Promise`\<`string`\>

Chain ID as a string.

#### Defined in

[src/lib/ethereum/index.ts:33](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L33)

___

### computeElectrumScriptHash

▸ **computeElectrumScriptHash**(`script`): `string`

Converts a Bitcoin script to an Electrum script hash. See
[Electrum protocol][https://electrumx.readthedocs.io/en/stable/protocol-basics.html#script-hashes](https://electrumx.readthedocs.io/en/stable/protocol-basics.html#script-hashes)

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `script` | [`Hex`](classes/Hex.md) | Bitcoin script as hex string |

#### Returns

`string`

Electrum script hash as a hex string.

#### Defined in

[src/lib/electrum/client.ts:696](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L696)

___

### computeP2TRKeyPathSighash

▸ **computeP2TRKeyPathSighash**(`rawTransaction`, `inputIndex`, `inputPrevouts`, `sighashType`): [`Hex`](classes/Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |
| `inputIndex` | `number` |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[] |
| `sighashType` | [`P2TRSupportedSighashType`](README.md#p2trsupportedsighashtype) |

#### Returns

[`Hex`](classes/Hex.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2299](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2299)

___

### computeP2TRSignatureFraudBridgeChallengeIdentity

▸ **computeP2TRSignatureFraudBridgeChallengeIdentity**(`challenge`): [`Hex`](classes/Hex.md)

Computes the Bridge-facing challenge identity from the structured Taproot
payload fields the Bridge verifier can reconstruct and validate.

Unlike the draft vector identity, this identity does not rely on a raw
unsigned transaction blob that the Bridge does not parse. It commits to the
transaction version, locktime, input outpoints/sequences, prevout values and
scripts, outputs, signed input, reconstructed BIP-341 sighash, and the
BIP-340 signature.

 Bridge integration identity for the P2TR signature-fraud path.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `challenge` | [`P2TRSignatureFraudBridgeChallengeIdentity`](README.md#p2trsignaturefraudbridgechallengeidentity) | Structured Bridge challenge payload: version, locktime, input outpoints/sequences, prevouts, outputs, signed input index, reconstructed BIP-341 sighash, and BIP-340 signature. |

#### Returns

[`Hex`](classes/Hex.md)

32-byte Bridge challenge identity (keccak256 over the canonical
         ABI-encoded payload).

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2512](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2512)

___

### computeP2TRSignatureFraudBridgeChallengeKey

▸ **computeP2TRSignatureFraudBridgeChallengeKey**(`challenge`): [`Hex`](classes/Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `challenge` | [`P2TRSignatureFraudBridgeChallengeKey`](README.md#p2trsignaturefraudbridgechallengekey) |

#### Returns

[`Hex`](classes/Hex.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2652](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2652)

___

### computeP2TRSignatureFraudDraftChallengeIdentity

▸ **computeP2TRSignatureFraudDraftChallengeIdentity**(`challenge`): [`Hex`](classes/Hex.md)

Computes the shared draft challenge identity used by the P2TR
signature-fraud vector corpus.

This identity intentionally mirrors the current Node/Rust/Solidity test
harnesses. It is not a final production Bridge challenge key.

 Draft vector-conformance helper for the P2TR signature-fraud
              watchtower path.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `challenge` | [`P2TRSignatureFraudDraftChallenge`](README.md#p2trsignaturefrauddraftchallenge) | Draft challenge payload: wallet input, witness signature, raw transaction, prevout map, optional Bridge/domain identifier. |

#### Returns

[`Hex`](classes/Hex.md)

32-byte draft challenge identity matching the cross-language
         vector corpus.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2609](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2609)

___

### computeP2TRWalletInputWitnessObservationID

▸ **computeP2TRWalletInputWitnessObservationID**(`observation`): [`Hex`](classes/Hex.md)

Computes a deterministic off-chain observation ID for watchtower
deduplication.

This ID is intentionally separate from the future production Bridge
challenge key. It commits to the observed wallet input, witness signature,
raw transaction, prevout map, and optional Bridge/domain identifier so
duplicate mempool/confirmed observations can be collapsed before submission.

 This is an idempotency primitive for the draft P2TR
              signature-fraud watchtower path. It is not a production
              challenge key.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `observation` | [`P2TRWalletInputWitnessObservation`](README.md#p2trwalletinputwitnessobservation) | Observation tuple (wallet input, witness signature, raw transaction, prevouts, optional domain) being deduplicated. |

#### Returns

[`Hex`](classes/Hex.md)

32-byte deterministic observation ID for off-chain dedup.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2434](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2434)

___

### createP2TRSignatureFraudSpendTypeClassifier

▸ **createP2TRSignatureFraudSpendTypeClassifier**(`rules`): [`P2TRSignatureFraudSpendTypeClassifier`](README.md#p2trsignaturefraudspendtypeclassifier)

#### Parameters

| Name | Type |
| :------ | :------ |
| `rules` | [`P2TRSignatureFraudSpendTypeClassifierRule`](README.md#p2trsignaturefraudspendtypeclassifierrule)[] |

#### Returns

[`P2TRSignatureFraudSpendTypeClassifier`](README.md#p2trsignaturefraudspendtypeclassifier)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:930](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L930)

___

### createP2TRWatchtowerChallengeRecord

▸ **createP2TRWatchtowerChallengeRecord**(`observationID`): [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

[`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1020](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1020)

___

### decodeDestinationReceiver

▸ **decodeDestinationReceiver**(`encodedReceiver`): `Object`

Decodes destination chain ID and recipient address from encoded receiver data.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `encodedReceiver` | `string` \| [`Hex`](classes/Hex.md) | The encoded receiver data (32 bytes) |

#### Returns

`Object`

Object containing the decoded chain ID and recipient address

| Name | Type |
| :------ | :------ |
| `chainId` | `number` |
| `recipient` | `string` |

**`Example`**

```typescript
const { chainId, recipient } = decodeDestinationReceiver("0x00000000000000000000000000000000000000000000000000000000000000281234567890123456789012345678901234567890")
// Returns: { chainId: 40, recipient: "0x1234567890123456789012345678901234567890" }
```

#### Defined in

[src/lib/utils/ntt.ts:59](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/ntt.ts#L59)

___

### deserializeP2TRSignatureFraudWitnessObservation

▸ **deserializeP2TRSignatureFraudWitnessObservation**(`observation`): [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation)

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservationJSON`](README.md#p2trsignaturefraudwitnessobservationjson) |

#### Returns

[`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1092](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1092)

___

### deserializeP2TRWatchtowerChallengeRecord

▸ **deserializeP2TRWatchtowerChallengeRecord**(`record`): [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecordJSON`](README.md#p2trwatchtowerchallengerecordjson) |

#### Returns

[`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1194](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1194)

___

### encodeDestinationReceiver

▸ **encodeDestinationReceiver**(`chainId`, `recipient`): [`Hex`](classes/Hex.md)

Encodes destination chain ID and recipient address into a 32-byte value.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `chainId` | `number` | Wormhole chain ID of the destination chain (uint16) |
| `recipient` | `string` | Recipient address on the destination chain (20 bytes) |

#### Returns

[`Hex`](classes/Hex.md)

The encoded receiver data as a 32-byte hex string

**`Example`**

```typescript
const encoded = encodeDestinationReceiver(40, "0x1234567890123456789012345678901234567890")
// Returns: "0x00000000000000000000000000000000000000000000000000000000000000281234567890123456789012345678901234567890"
```

#### Defined in

[src/lib/utils/ntt.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/ntt.ts#L23)

___

### encodeP2TRSignatureFraudBridgeChallengePayload

▸ **encodeP2TRSignatureFraudBridgeChallengePayload**(`observation`): `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) |

#### Returns

`string`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2748](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2748)

___

### ethereumAddressFromSigner

▸ **ethereumAddressFromSigner**(`signer`): `Promise`\<[`EthereumAddress`](classes/EthereumAddress.md) \| `undefined`\>

Resolves the Ethereum address tied to the given signer. The address
cannot be resolved for signers that works in the read-only mode

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | The signer whose address should be resolved. |

#### Returns

`Promise`\<[`EthereumAddress`](classes/EthereumAddress.md) \| `undefined`\>

Ethereum address or undefined for read-only signers.

**`Throws`**

Throws an error if the address of the signer is not a proper
        Ethereum address.

#### Defined in

[src/lib/ethereum/index.ts:55](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L55)

___

### ethereumCrossChainContractsLoader

▸ **ethereumCrossChainContractsLoader**(`signer`, `chainId`): `Promise`\<[`CrossChainContractsLoader`](interfaces/CrossChainContractsLoader.md)\>

Creates the Ethereum implementation of tBTC cross-chain contracts loader.
The provided signer is attached to loaded L1 contracts. The given
Ethereum chain ID is used to load the L1 contracts and resolve the chain
mapping that provides corresponding L2 chains IDs.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | Ethereum L1 signer. |
| `chainId` | [`Ethereum`](enums/Chains.Ethereum.md) | Ethereum L1 chain ID. |

#### Returns

`Promise`\<[`CrossChainContractsLoader`](interfaces/CrossChainContractsLoader.md)\>

Loader for tBTC cross-chain contracts.

**`Throws`**

Throws an error if the signer's Ethereum chain ID is other than
        the one used to construct the loader.

#### Defined in

[src/lib/ethereum/cross-chain.ts:29](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/cross-chain.ts#L29)

___

### extractBitcoinRawTxVectors

▸ **extractBitcoinRawTxVectors**(`rawTransaction`): [`BitcoinRawTxVectors`](interfaces/BitcoinRawTxVectors.md)

Decomposes a transaction in the raw representation into version, vector of
inputs, vector of outputs and locktime.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) | Transaction in the raw format. |

#### Returns

[`BitcoinRawTxVectors`](interfaces/BitcoinRawTxVectors.md)

Transaction data with fields represented as un-prefixed hex strings.

#### Defined in

[src/lib/bitcoin/tx.ts:133](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L133)

___

### extractP2TRKeyPathInputWitnessSignature

▸ **extractP2TRKeyPathInputWitnessSignature**(`rawTransaction`, `inputIndex`): [`P2TRKeyPathInputWitnessSignature`](README.md#p2trkeypathinputwitnesssignature)

Extracts and parses a single-input Taproot key-path witness signature from a
raw Bitcoin transaction.

The caller must first identify that the input spends a registered tBTC P2TR
wallet UTXO. This function intentionally rejects annex/script-path/malformed
witness forms and does not classify honest spend types or submit challenges.

 This is a parser primitive for the draft P2TR signature-fraud
              watchtower path. It is not production challenge submission.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) | Raw Bitcoin transaction containing the candidate input. |
| `inputIndex` | `number` | Zero-based index of the input whose key-path witness signature should be parsed. |

#### Returns

[`P2TRKeyPathInputWitnessSignature`](README.md#p2trkeypathinputwitnesssignature)

Parsed witness signature for the input, with sighash type resolved.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2123](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2123)

___

### extractP2TRSignatureFraudWitnessObservations

▸ **extractP2TRSignatureFraudWitnessObservations**(`rawTransaction`, `inputPrevouts`, `registeredWalletIDs`, `bridgeIdentifier?`, `spendTypeClassifier?`, `payloadBounds?`, `bridgeChallengeDomain?`): [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[] |
| `registeredWalletIDs` | (`string` \| [`Hex`](classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\>)[] |
| `bridgeIdentifier?` | `string` \| [`Hex`](classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `spendTypeClassifier?` | [`P2TRSignatureFraudSpendTypeClassifier`](README.md#p2trsignaturefraudspendtypeclassifier) |
| `payloadBounds?` | [`P2TRSignatureFraudPayloadBounds`](README.md#p2trsignaturefraudpayloadbounds) |
| `bridgeChallengeDomain?` | [`P2TRSignatureFraudBridgeChallengeDomain`](README.md#p2trsignaturefraudbridgechallengedomain) |

#### Returns

[`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation)[]

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2883](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2883)

___

### extractP2TRWalletIDFromScriptPubKey

▸ **extractP2TRWalletIDFromScriptPubKey**(`scriptPubKey`): `undefined` \| [`Hex`](classes/Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `scriptPubKey` | `string` \| [`Hex`](classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`undefined` \| [`Hex`](classes/Hex.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2347](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2347)

___

### extractP2TRWalletInputWitnessCandidates

▸ **extractP2TRWalletInputWitnessCandidates**(`rawTransaction`, `inputPrevouts`, `registeredWalletIDs`): [`P2TRWalletInputWitnessCandidate`](README.md#p2trwalletinputwitnesscandidate)[]

Finds registered tBTC P2TR wallet inputs in a raw Bitcoin transaction and
parses their key-path witness signatures.

Unknown P2TR outputs and non-P2TR inputs are ignored. Registered wallet
inputs with unsupported witness forms are rejected fail-closed.

 This is a parser primitive for the draft P2TR signature-fraud
              watchtower path. It is not production challenge submission.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) | Raw Bitcoin transaction whose inputs are being screened for P2TR wallet key-path spends. |
| `inputPrevouts` | [`P2TRWalletInputPrevout`](README.md#p2trwalletinputprevout)[] | Per-input prevout records (script, amount). Length must equal the transaction's input vector length. |
| `registeredWalletIDs` | (`string` \| [`Hex`](classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\>)[] | Canonical FROST wallet identifiers whose P2TR outputs are considered "registered" for this scan. |

#### Returns

[`P2TRWalletInputWitnessCandidate`](README.md#p2trwalletinputwitnesscandidate)[]

Candidate witness records for each input whose prevout script
         matches a registered wallet's P2TR output key.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2381](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2381)

___

### getChainIdFromEncodedReceiver

▸ **getChainIdFromEncodedReceiver**(`encodedReceiver`): `number`

Gets the chain ID from encoded receiver data without full decoding.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `encodedReceiver` | `string` \| [`Hex`](classes/Hex.md) | The encoded receiver data |

#### Returns

`number`

The chain ID

#### Defined in

[src/lib/utils/ntt.ts:133](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/ntt.ts#L133)

___

### getRecipientFromEncodedReceiver

▸ **getRecipientFromEncodedReceiver**(`encodedReceiver`): `string`

Gets the recipient address from encoded receiver data without full decoding.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `encodedReceiver` | `string` \| [`Hex`](classes/Hex.md) | The encoded receiver data |

#### Returns

`string`

The recipient address

#### Defined in

[src/lib/utils/ntt.ts:159](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/ntt.ts#L159)

___

### isValidEncodedReceiver

▸ **isValidEncodedReceiver**(`encodedReceiver`): `boolean`

Validates that an encoded receiver has the correct format.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `encodedReceiver` | `string` \| [`Hex`](classes/Hex.md) | The encoded receiver data to validate |

#### Returns

`boolean`

True if the format is valid, false otherwise

#### Defined in

[src/lib/utils/ntt.ts:100](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/ntt.ts#L100)

___

### listP2TRWatchtowerUnresolvedOperatorAlerts

▸ **listP2TRWatchtowerUnresolvedOperatorAlerts**(`recordSource`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1335](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1335)

___

### loadArbitrumCrossChainContracts

▸ **loadArbitrumCrossChainContracts**(`signer`, `chainId`): `Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) |
| `chainId` | [`Arbitrum`](enums/Chains.Arbitrum.md) |

#### Returns

`Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

**`Deprecated`**

Use loadArbitrumCrossChainInterfaces instead

#### Defined in

[src/lib/arbitrum/index.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/index.ts#L62)

___

### loadArbitrumCrossChainInterfaces

▸ **loadArbitrumCrossChainInterfaces**(`signer`, `chainId`): `Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

Loads Arbitrum implementation of tBTC cross-chain interfaces for the given Arbitrum
chain ID and attaches the given signer there.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | Signer that should be attached to the contracts. |
| `chainId` | [`Arbitrum`](enums/Chains.Arbitrum.md) | Arbitrum chain ID. |

#### Returns

`Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

Handle to the contracts.

**`Throws`**

Throws an error if the signer's Arbitrum chain ID is other than
        the one used to load contracts.

#### Defined in

[src/lib/arbitrum/index.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/index.ts#L23)

___

### loadBaseCrossChainContracts

▸ **loadBaseCrossChainContracts**(`signer`, `chainId`): `Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) |
| `chainId` | [`Base`](enums/Chains.Base.md) |

#### Returns

`Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

**`Deprecated`**

Use loadBaseCrossChainInterfaces instead

#### Defined in

[src/lib/base/index.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/index.ts#L63)

___

### loadBaseCrossChainInterfaces

▸ **loadBaseCrossChainInterfaces**(`signer`, `chainId`): `Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

Loads Base implementation of tBTC cross-chain contracts for the given Base
chain ID and attaches the given signer there.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | Signer that should be attached to the contracts. |
| `chainId` | [`Base`](enums/Chains.Base.md) | Base chain ID. |

#### Returns

`Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

Handle to the contracts.

**`Throws`**

Throws an error if the signer's Base chain ID is other than
        the one used to load contracts.

#### Defined in

[src/lib/base/index.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/index.ts#L23)

___

### loadEthereumCoreContracts

▸ **loadEthereumCoreContracts**(`signer`, `chainId`): `Promise`\<[`TBTCContracts`](README.md#tbtccontracts)\>

Loads Ethereum implementation of tBTC core contracts for the given Ethereum
chain ID and attaches the given signer there.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | Signer that should be attached to tBTC contracts. |
| `chainId` | [`Ethereum`](enums/Chains.Ethereum.md) | Ethereum chain ID. |

#### Returns

`Promise`\<[`TBTCContracts`](README.md#tbtccontracts)\>

Handle to tBTC core contracts.

**`Throws`**

Throws an error if the signer's Ethereum chain ID is other than
        the one used to load tBTC contracts.

#### Defined in

[src/lib/ethereum/index.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L74)

___

### loadSolanaCrossChainInterfaces

▸ **loadSolanaCrossChainInterfaces**(`solanaProvider`): `Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

Loads Solana implementation of tBTC cross-chain interfaces using
an AnchorProvider (which includes the connection and the wallet).

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `solanaProvider` | `AnchorProvider` | Anchor provider for Solana. Must include both `connection` and `wallet`. |

#### Returns

`Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

Handle to the cross-chain interfaces for the TBTC interface on Solana.

**`Throws`**

If the connection's genesis hash does not match the expected `genesisHash`.

#### Defined in

[src/lib/solana/index.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/index.ts#L20)

___

### loadStarkNetCrossChainContracts

▸ **loadStarkNetCrossChainContracts**(`walletAddress`, `provider?`, `chainId?`): `Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `walletAddress` | `string` | `undefined` |
| `provider?` | [`StarkNetProvider`](README.md#starknetprovider) | `undefined` |
| `chainId` | `string` | `Chains.StarkNet.Sepolia` |

#### Returns

`Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

**`Deprecated`**

Use loadStarkNetCrossChainInterfaces instead

#### Defined in

[src/lib/starknet/index.ts:109](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/index.ts#L109)

___

### loadStarkNetCrossChainInterfaces

▸ **loadStarkNetCrossChainInterfaces**(`walletAddress`, `provider?`, `chainId?`): `Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

Loads StarkNet implementation of tBTC cross-chain contracts.
Now supports balance queries with deployed tBTC contracts and enhanced configuration.

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `walletAddress` | `string` | `undefined` | The StarkNet wallet address to use as deposit owner |
| `provider?` | [`StarkNetProvider`](README.md#starknetprovider) | `undefined` | Optional StarkNet provider for blockchain interactions |
| `chainId` | `string` | `Chains.StarkNet.Sepolia` | Optional chain ID (defaults to Sepolia) |

#### Returns

`Promise`\<[`DestinationChainInterfaces`](README.md#destinationchaininterfaces)\>

Handle to the contracts

#### Defined in

[src/lib/starknet/index.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/index.ts#L43)

___

### packRevealDepositParameters

▸ **packRevealDepositParameters**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Object`

Packs deposit parameters to match the ABI of the revealDeposit and
revealDepositWithExtraData functions of the Ethereum Bridge contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](interfaces/BitcoinRawTxVectors.md) | Deposit transaction data |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit |
| `deposit` | [`DepositReceipt`](interfaces/DepositReceipt.md) | Data of the revealed deposit |
| `vault?` | [`ChainIdentifier`](interfaces/ChainIdentifier.md) | Optional parameter denoting the vault the given deposit should be routed to |

#### Returns

`Object`

Packed parameters.

| Name | Type |
| :------ | :------ |
| `extraData` | `undefined` \| `string` |
| `fundingTx` | \{ `inputVector`: `string` ; `locktime`: `string` ; `outputVector`: `string` ; `version`: `string`  } |
| `fundingTx.inputVector` | `string` |
| `fundingTx.locktime` | `string` |
| `fundingTx.outputVector` | `string` |
| `fundingTx.version` | `string` |
| `reveal` | \{ `blindingFactor`: `string` ; `fundingOutputIndex`: `number` = depositOutputIndex; `refundLocktime`: `string` ; `refundPubKeyHash`: `string` ; `refundXOnlyPublicKey?`: `string` ; `vault`: `string` ; `walletPubKeyHash`: `string` ; `walletXOnlyPublicKey?`: `string`  } |
| `reveal.blindingFactor` | `string` |
| `reveal.fundingOutputIndex` | `number` |
| `reveal.refundLocktime` | `string` |
| `reveal.refundPubKeyHash` | `string` |
| `reveal.refundXOnlyPublicKey?` | `string` |
| `reveal.vault` | `string` |
| `reveal.walletPubKeyHash` | `string` |
| `reveal.walletXOnlyPublicKey?` | `string` |

#### Defined in

[src/lib/ethereum/bridge.ts:1169](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L1169)

___

### parseP2TRKeyPathWitnessSignature

▸ **parseP2TRKeyPathWitnessSignature**(`witnessSignature`): [`P2TRKeyPathWitnessSignature`](README.md#p2trkeypathwitnesssignature)

Parses the Taproot key-path witness signature encodings currently allowed by
the draft P2TR signature-fraud model.

BIP-341 represents `SIGHASH_DEFAULT` by omitting the trailing sighash byte.
The draft model also allows explicit `SIGHASH_ALL` (`0x01`). Explicit
`SIGHASH_DEFAULT` (`0x00`) and all other sighash bytes are rejected before a
watchtower attempts challenge submission.

 This is a parser primitive for the draft P2TR signature-fraud
              watchtower path. It is not production challenge submission.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `witnessSignature` | `string` \| [`Hex`](classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | Raw witness signature bytes (Hex, Buffer, or hex string) extracted from the Taproot key-path spend. |

#### Returns

[`P2TRKeyPathWitnessSignature`](README.md#p2trkeypathwitnesssignature)

Parsed signature with the 64-byte Schnorr signature and the
         resolved sighash flag.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2070](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2070)

___

### recordP2TRWatchtowerChallengeEvent

▸ **recordP2TRWatchtowerChallengeEvent**(`store`, `event`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `store` | [`P2TRWatchtowerChallengeStore`](interfaces/P2TRWatchtowerChallengeStore.md) |
| `event` | [`P2TRWatchtowerChallengeEvent`](README.md#p2trwatchtowerchallengeevent) |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2032](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2032)

___

### resolveP2TRInputPrevouts

▸ **resolveP2TRInputPrevouts**(`rawTransaction`, `bitcoinClient`): `Promise`\<[`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |
| `bitcoinClient` | [`BitcoinClient`](interfaces/BitcoinClient.md) |

#### Returns

`Promise`\<[`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2267](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2267)

___

### resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType

▸ **resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType**(`recordSource`, `bitcoinTxHash`, `spendType`): `Promise`\<[`Hex`](classes/Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](interfaces/P2TRWatchtowerChallengeRecordSource.md) |
| `bitcoinTxHash` | `string` \| [`Hex`](classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `spendType` | [`P2TRSignatureFraudSpendType`](README.md#p2trsignaturefraudspendtype) |

#### Returns

`Promise`\<[`Hex`](classes/Hex.md)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1428](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1428)

___

### resolveP2TRWatchtowerObservationIDForBridgeChallengeKey

▸ **resolveP2TRWatchtowerObservationIDForBridgeChallengeKey**(`recordSource`, `bridgeChallengeKey`, `lifecycleEvidence?`): `Promise`\<[`Hex`](classes/Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](interfaces/P2TRWatchtowerChallengeRecordSource.md) |
| `bridgeChallengeKey` | `string` \| [`Hex`](classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `lifecycleEvidence?` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence`](README.md#p2trsignaturefraudwatchtowerbridgelifecycleeventevidence) |

#### Returns

`Promise`\<[`Hex`](classes/Hex.md)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1392](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1392)

___

### retryAll

▸ **retryAll**(`error`): ``true``

A convenience matcher for withBackoffRetries that retries irrespective of
the error.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `error` | `any` | The error to match against. Not necessarily an Error instance, since the retriable function may throw a non-Error. |

#### Returns

``true``

Always returns true.

#### Defined in

[src/lib/utils/backoff.ts:9](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L9)

___

### serializeP2TRSignatureFraudWitnessObservation

▸ **serializeP2TRSignatureFraudWitnessObservation**(`observation`): [`P2TRSignatureFraudWitnessObservationJSON`](README.md#p2trsignaturefraudwitnessobservationjson)

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) |

#### Returns

[`P2TRSignatureFraudWitnessObservationJSON`](README.md#p2trsignaturefraudwitnessobservationjson)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1051](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1051)

___

### serializeP2TRWatchtowerChallengeRecord

▸ **serializeP2TRWatchtowerChallengeRecord**(`record`): [`P2TRWatchtowerChallengeRecordJSON`](README.md#p2trwatchtowerchallengerecordjson)

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecord`](README.md#p2trwatchtowerchallengerecord) |

#### Returns

[`P2TRWatchtowerChallengeRecordJSON`](README.md#p2trwatchtowerchallengerecordjson)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1169](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1169)

___

### skipRetryWhenMatched

▸ **skipRetryWhenMatched**(`matchers`): [`ErrorMatcherFn`](README.md#errormatcherfn)

A matcher to specify list of error messages that should abort the retry loop
and throw immediately.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `matchers` | (`string` \| `RegExp`)[] | List of patterns for error matching. |

#### Returns

[`ErrorMatcherFn`](README.md#errormatcherfn)

Matcher function that returns false if error matches one of the patterns.
         True is returned if no matches are found and retry loop should continue

#### Defined in

[src/lib/utils/backoff.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L20)

___

### stripWitnessesFromBitcoinRawTransaction

▸ **stripWitnessesFromBitcoinRawTransaction**(`rawTransaction`): [`BitcoinRawTx`](interfaces/BitcoinRawTx.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |

#### Returns

[`BitcoinRawTx`](interfaces/BitcoinRawTx.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2161](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2161)

___

### summarizeP2TRWatchtowerChallengeRecords

▸ **summarizeP2TRWatchtowerChallengeRecords**(`recordSource`): `Promise`\<[`P2TRWatchtowerChallengeRecordSummary`](README.md#p2trwatchtowerchallengerecordsummary)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecordSummary`](README.md#p2trwatchtowerchallengerecordsummary)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1356](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1356)

___

### toBitcoinJsLibNetwork

▸ **toBitcoinJsLibNetwork**(`bitcoinNetwork`): `networks.Network`

Converts the provided [BitcoinNetwork](enums/BitcoinNetwork-1.md) enumeration to a format expected
by the `bitcoinjs-lib` library.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinNetwork` | [`BitcoinNetwork`](enums/BitcoinNetwork-1.md) | Specified Bitcoin network. |

#### Returns

`networks.Network`

Network representation compatible with the `bitcoinjs-lib` library.

**`Throws`**

An error if the network is not supported by `bitcoinjs-lib`.

#### Defined in

[src/lib/bitcoin/network.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/network.ts#L63)

___

### validateBitcoinHeadersChain

▸ **validateBitcoinHeadersChain**(`headers`, `previousEpochDifficulty`, `currentEpochDifficulty`): `void`

Validates a chain of consecutive block headers by checking each header's
difficulty, hash, and continuity with the previous header. This function can
be used to validate a series of Bitcoin block headers for their validity.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `headers` | [`BitcoinHeader`](interfaces/BitcoinHeader.md)[] | An array of block headers that form the chain to be validated. |
| `previousEpochDifficulty` | `BigNumber` | The difficulty of the previous Bitcoin epoch. |
| `currentEpochDifficulty` | `BigNumber` | The difficulty of the current Bitcoin epoch. |

#### Returns

`void`

An empty return value.

**`Dev`**

The block headers must come from Bitcoin epochs with difficulties marked
     by the previous and current difficulties. If a Bitcoin difficulty relay
     is used to provide these values and the relay is up-to-date, only the
     recent block headers will pass validation. Block headers older than the
     current and previous Bitcoin epochs will fail.

**`Throws`**

If any of the block headers are invalid, or if the block
        header chain is not continuous.

#### Defined in

[src/lib/bitcoin/header.ts:132](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L132)

___

### validateBitcoinSpvProof

▸ **validateBitcoinSpvProof**(`transactionHash`, `requiredConfirmations`, `previousDifficulty`, `currentDifficulty`, `bitcoinClient`): `Promise`\<`void`\>

Proves that a transaction with the given hash is included in the Bitcoin
blockchain by validating the transaction's inclusion in the Merkle tree and
verifying that the block containing the transaction has enough confirmations.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](classes/BitcoinTxHash.md) | The hash of the transaction to be validated. |
| `requiredConfirmations` | `number` | The number of confirmations required for the transaction to be considered valid. The transaction has 1 confirmation when it is in the block at the current blockchain tip. Every subsequent block added to the blockchain is one additional confirmation. |
| `previousDifficulty` | `BigNumber` | The difficulty of the previous Bitcoin epoch. |
| `currentDifficulty` | `BigNumber` | The difficulty of the current Bitcoin epoch. |
| `bitcoinClient` | [`BitcoinClient`](interfaces/BitcoinClient.md) | The client for interacting with the Bitcoin blockchain. |

#### Returns

`Promise`\<`void`\>

An empty return value.

**`Throws`**

If the transaction is not included in the Bitcoin blockchain
       or if the block containing the transaction does not have enough
       confirmations.

**`Dev`**

The function should be used within a try-catch block.

#### Defined in

[src/lib/bitcoin/spv.ts:180](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L180)

___

### validateDepositReceipt

▸ **validateDepositReceipt**(`receipt`): `void`

Validates the given deposit receipt. Throws in case of a validation error.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `receipt` | [`DepositReceipt`](interfaces/DepositReceipt.md) | The validated deposit receipt. |

#### Returns

`void`

**`Dev`**

This function does not validate the depositor's identifier as its
     validity is chain-specific. This parameter must be validated outside.

#### Defined in

[src/lib/contracts/bridge.ts:308](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L308)

___

### validateP2TRSignatureFraudPayloadBounds

▸ **validateP2TRSignatureFraudPayloadBounds**(`rawTransaction`, `inputPrevouts`, `bounds`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](README.md#p2trwalletinputobservationprevout)[] |
| `bounds` | [`P2TRSignatureFraudPayloadBounds`](README.md#p2trsignaturefraudpayloadbounds) |

#### Returns

`void`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2200](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2200)

___

### validateP2TRSignatureFraudWitnessObservationConsistency

▸ **validateP2TRSignatureFraudWitnessObservationConsistency**(`observation`, `context?`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](README.md#p2trsignaturefraudwitnessobservation) |
| `context` | [`P2TRSignatureFraudWitnessObservationConsistencyContext`](README.md#p2trsignaturefraudwitnessobservationconsistencycontext) |

#### Returns

`void`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2972](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2972)
