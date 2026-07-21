// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BitcoinTx.sol";
import "../bridge/Bridge.sol";
import "../bridge/EcdsaLib.sol";
import "../bridge/Fraud.sol";
import "../bridge/MovingFunds.sol";
import "../bridge/P2TRReservation.sol";
import "../bridge/RebateStaking.sol";
import "../bridge/Redemption.sol";
import "../bridge/Wallets.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

contract BridgeStub is Bridge {
    using BTCUtils for bytes;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address p2trCoverageAuthority)
        Bridge(p2trCoverageAuthority)
    {}

    function requireP2TRProofWalletStateForTest(
        bytes32 transactionHash,
        bytes20 walletPubKeyHash,
        uint8 expectedAction
    ) external view {
        P2TRReservation.requireProofWalletState(
            self,
            transactionHash,
            walletPubKeyHash,
            expectedAction
        );
    }

    function settleP2TRProofForTest(
        bytes32 transactionHash,
        uint8 expectedAction,
        bytes20 expectedWalletPubKeyHash,
        bytes32[] calldata provenResourceIDs
    ) external returns (uint8 disposition, uint64 reservedFeeLimit) {
        P2TRReservation.ProofSettlement memory settlement = P2TRReservation
            .settleProof(
                self,
                transactionHash,
                expectedAction,
                expectedWalletPubKeyHash,
                provenResourceIDs
            );
        return (uint8(settlement.disposition), settlement.feeLimitSnapshot);
    }

    function reconcileAuthorizedMovingFundsProofForTest(
        bytes20 walletPubKeyHash,
        bytes32 transactionHash,
        bytes32 targetWalletsHash
    ) external returns (bool) {
        return
            P2TRReservation.reconcileAuthorizedMovingFundsProof(
                self,
                walletPubKeyHash,
                transactionHash,
                targetWalletsHash
            );
    }

    function setSweptDeposits(BitcoinTx.UTXO[] calldata utxos) external {
        for (uint256 i = 0; i < utxos.length; i++) {
            uint256 utxoKey = uint256(
                keccak256(
                    abi.encodePacked(utxos[i].txHash, utxos[i].txOutputIndex)
                )
            );
            self.deposits[utxoKey].sweptAt = 1641650400;
        }
    }

    function setTaprootDepositOutputKeyCommitment(
        BitcoinTx.UTXO calldata utxo,
        bytes32 walletID,
        bytes32 outputKey
    ) external {
        uint256 utxoKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );
        self.taprootDepositOutputKeyCommitments[utxoKey] = Deposit
            .taprootOutputKeyCommitment(walletID, outputKey);
        self.taprootDepositOutputKeys[utxoKey] = outputKey;
    }

    function setHistoricalTaprootDepositForCoverage(
        BitcoinTx.UTXO calldata utxo,
        bytes32 walletID,
        bytes32 outputKey
    ) external {
        uint256 utxoKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );
        self.deposits[utxoKey].depositor = msg.sender;
        self.deposits[utxoKey].amount = utxo.txOutputValue;
        self.deposits[utxoKey].revealedAt = 1;
        self.taprootDepositOutputKeyCommitments[utxoKey] = Deposit
            .taprootOutputKeyCommitment(walletID, outputKey);
        delete self.taprootDepositOutputKeys[utxoKey];
    }

    function deleteHistoricalDepositForCoverage(BitcoinTx.UTXO calldata utxo)
        external
    {
        uint256 utxoKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );
        delete self.deposits[utxoKey];
    }

    function setP2TRAuthorizationDepositForTest(
        BitcoinTx.UTXO calldata utxo,
        bytes32 walletID,
        bytes32 outputKey
    ) external {
        uint256 utxoKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );
        self.deposits[utxoKey].amount = utxo.txOutputValue;
        self.deposits[utxoKey].revealedAt = 1;
        self.taprootDepositOutputKeyCommitments[utxoKey] = Deposit
            .taprootOutputKeyCommitment(walletID, outputKey);
        self.taprootDepositOutputKeys[utxoKey] = outputKey;
    }

    function setLiveWalletsForTest(bytes20[] calldata walletPubKeyHashes)
        external
    {
        for (uint256 i = 0; i < walletPubKeyHashes.length; i++) {
            self.registeredWallets[walletPubKeyHashes[i]].state = Wallets
                .WalletState
                .Live;
        }
        self.liveWalletsCount += uint32(walletPubKeyHashes.length);
    }

    function setSpentMainUtxos(BitcoinTx.UTXO[] calldata utxos) external {
        for (uint256 i = 0; i < utxos.length; i++) {
            uint256 utxoKey = uint256(
                keccak256(
                    abi.encodePacked(utxos[i].txHash, utxos[i].txOutputIndex)
                )
            );
            self.spentMainUTXOs[utxoKey] = true;
        }
    }

    function setProcessedMovedFundsSweepRequests(
        BitcoinTx.UTXO[] calldata utxos
    ) external {
        for (uint256 i = 0; i < utxos.length; i++) {
            uint256 utxoKey = uint256(
                keccak256(
                    abi.encodePacked(utxos[i].txHash, utxos[i].txOutputIndex)
                )
            );
            self.movedFundsSweepRequests[utxoKey].state = MovingFunds
                .MovedFundsSweepRequestState
                .Processed;
        }
    }

    function setActiveWallet(bytes20 activeWalletPubKeyHash) external {
        self.activeWalletPubKeyHash = activeWalletPubKeyHash;
        if (activeWalletPubKeyHash == bytes20(0)) {
            delete self.activeWalletID;
        } else {
            self.activeWalletID = Wallets.deriveLegacyWalletID(
                activeWalletPubKeyHash
            );
        }
    }

    function setActiveWalletWithID(
        bytes20 activeWalletPubKeyHash,
        bytes32 activeWalletID
    ) external {
        self.activeWalletPubKeyHash = activeWalletPubKeyHash;
        self.activeWalletID = activeWalletID;
    }

    function setWalletPubKeyHashForWalletID(
        bytes32 walletID,
        bytes20 walletPubKeyHash
    ) external {
        self.walletPubKeyHashByWalletID[walletID] = walletPubKeyHash;
    }

    function setWalletIDForWalletPubKeyHash(
        bytes20 walletPubKeyHash,
        bytes32 walletID
    ) external {
        self.walletIDByWalletPubKeyHash[walletPubKeyHash] = walletID;
    }

    function setWalletMainUtxo(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata utxo
    ) external {
        self.registeredWallets[walletPubKeyHash].mainUtxoHash = keccak256(
            abi.encodePacked(
                utxo.txHash,
                utxo.txOutputIndex,
                utxo.txOutputValue
            )
        );
    }

    function setWallet(bytes20 walletPubKeyHash, Wallets.Wallet calldata wallet)
        external
    {
        self.registeredWallets[walletPubKeyHash] = wallet;

        if (wallet.state == Wallets.WalletState.Live) {
            self.liveWalletsCount++;
        }
    }

    // Test-only setter that bypasses the one-time `FrostWalletRegistryAlreadySet`
    // guard on `setFrostWalletRegistry`. The production setter on Bridge is
    // intentionally one-shot to prevent governance from accidentally rotating
    // the registry mid-DKG; tests that exercise registry → Bridge callback
    // flows need to repoint Bridge at a test-deployed registry after the
    // canonical mirror's no-tags `deployments.fixture()` has already wired
    // the production registry. Only available on the stub.
    function resetFrostWalletRegistryForTest(address frostWalletRegistry)
        external
    {
        self.frostWalletRegistry = frostWalletRegistry;
    }

    function resetLifecycleRouterForTest(address lifecycleRouter) external {
        self.lifecycleRouter = lifecycleRouter;
    }

    function resetEcdsaFraudRouterForTest(address router) external {
        self.ecdsaFraudRouter = router;
    }

    function resetP2TRFraudRouterForTest(address router) external {
        self.p2trFraudRouter = router;
    }

    function emitNewFrostWalletRegisteredForTest() external {
        emit Wallets.NewFrostWalletRegistered(
            bytes32(uint256(1)),
            bytes20(uint160(1)),
            bytes32(uint256(1))
        );
    }

    function emitZeroEcdsaWalletRegisteredV2ForTest() external {
        emit Wallets.NewWalletRegisteredV2(
            bytes32(uint256(1)),
            bytes32(0),
            bytes20(uint160(1))
        );
    }

    function setLegacyFraudChallengeForTest(
        uint256 challengeKey,
        Fraud.FraudChallenge calldata challenge
    ) external payable {
        require(
            msg.value == challenge.depositAmount,
            "msg.value != challenge deposit"
        );
        self.fraudChallenges[challengeKey] = challenge;
    }

    function legacyFraudChallengeForTest(uint256 challengeKey)
        external
        view
        returns (Fraud.FraudChallenge memory)
    {
        return self.fraudChallenges[challengeKey];
    }

    function setDepositDustThreshold(uint64 _depositDustThreshold) external {
        self.depositDustThreshold = _depositDustThreshold;
    }

    function setDepositTxMaxFee(uint64 _depositTxMaxFee) external {
        self.depositTxMaxFee = _depositTxMaxFee;
    }

    function setRedemptionDustThreshold(uint64 _redemptionDustThreshold)
        external
    {
        self.redemptionDustThreshold = _redemptionDustThreshold;
    }

    function setRedemptionTreasuryFeeDivisor(
        uint64 _redemptionTreasuryFeeDivisor
    ) external {
        self.redemptionTreasuryFeeDivisor = _redemptionTreasuryFeeDivisor;
    }

    function setPendingMovedFundsSweepRequest(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata utxo
    ) external {
        uint256 requestKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );

        self.movedFundsSweepRequests[requestKey] = MovingFunds
            .MovedFundsSweepRequest(
                walletPubKeyHash,
                utxo.txOutputValue,
                /* solhint-disable-next-line not-rely-on-time */
                uint32(block.timestamp),
                MovingFunds.MovedFundsSweepRequestState.Pending
            );

        self
            .registeredWallets[walletPubKeyHash]
            .pendingMovedFundsSweepRequestsCount++;
    }

    function processPendingMovedFundsSweepRequest(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata utxo
    ) external {
        uint256 requestKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );

        MovingFunds.MovedFundsSweepRequest storage request = self
            .movedFundsSweepRequests[requestKey];

        require(
            request.state == MovingFunds.MovedFundsSweepRequestState.Pending,
            "Stub sweep request must be in Pending state"
        );

        request.state = MovingFunds.MovedFundsSweepRequestState.Processed;

        self
            .registeredWallets[walletPubKeyHash]
            .pendingMovedFundsSweepRequestsCount--;
    }

    function timeoutPendingMovedFundsSweepRequest(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata utxo
    ) external {
        uint256 requestKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );

        MovingFunds.MovedFundsSweepRequest storage request = self
            .movedFundsSweepRequests[requestKey];

        require(
            request.state == MovingFunds.MovedFundsSweepRequestState.Pending,
            "Stub sweep request must be in Pending state"
        );

        request.state = MovingFunds.MovedFundsSweepRequestState.TimedOut;

        self
            .registeredWallets[walletPubKeyHash]
            .pendingMovedFundsSweepRequestsCount--;
    }

    function setMovedFundsSweepTxMaxTotalFee(
        uint64 _movedFundsSweepTxMaxTotalFee
    ) external {
        self.movedFundsSweepTxMaxTotalFee = _movedFundsSweepTxMaxTotalFee;
    }

    function setDepositRevealAheadPeriod(uint32 _depositRevealAheadPeriod)
        external
    {
        self.depositRevealAheadPeriod = _depositRevealAheadPeriod;
    }

    uint64 public lastTreasuryFee;

    function applyForRebate(address user, uint64 treasuryFee) external {
        lastTreasuryFee = RebateStaking(self.rebateStaking).applyForRebate(
            user,
            treasuryFee,
            RebateStaking.TreasuryFeeType.Deposit
        );
    }

    function applyForRedemptionRebate(address user, uint64 treasuryFee)
        external
    {
        lastTreasuryFee = RebateStaking(self.rebateStaking).applyForRebate(
            user,
            treasuryFee,
            RebateStaking.TreasuryFeeType.Redemption
        );
    }

    function cancelRebate(address user, uint256 requestedAt) external {
        RebateStaking(self.rebateStaking).cancelRebate(user, requestedAt);
    }

    function processRedemptionTxOutputsForTest(
        bytes memory redemptionTxOutputVector,
        bytes20 walletPubKeyHash
    )
        external
        returns (
            uint256 outputsTotalValue,
            uint64 totalBurnableValue,
            uint64 totalTreasuryFee,
            uint32 changeIndex,
            uint64 changeValue
        )
    {
        Redemption.RedemptionTxOutputsInfo memory info = Redemption
            .processRedemptionTxOutputs(
                self,
                redemptionTxOutputVector,
                walletPubKeyHash
            );

        return (
            info.outputsTotalValue,
            info.totalBurnableValue,
            info.totalTreasuryFee,
            info.changeIndex,
            info.changeValue
        );
    }

    /// @notice Test-only setter for the ECDSA retirement flag.
    ///         The production governance path is
    ///         `BridgeGovernance.retireEcdsa()` → `Bridge.retireEcdsa()`
    ///         (added in D-2). This stub helper bypasses
    ///         governance for unit tests that just need to toggle
    ///         the flag.
    function setEcdsaRetiredForTest(bool retired) external {
        self.ecdsaRetired = retired;
    }

    /// @notice Test-only ECDSA wallet creation helper. Replicates the
    ///         body of `Wallets.registerNewWallet` minus the
    ///         `msg.sender == ecdsaWalletRegistry` access
    ///         check so test fixtures can create ECDSA wallets
    ///         for downstream-flow testing (redemptions,
    ///         deposits, fraud, etc.) without needing to
    ///         impersonate the registry.
    /// @dev This helper only bypasses production registry authentication.
    ///      If the library's
    ///      `registerNewWallet` changes in a future PR, this
    ///      helper should be updated to match.
    function __ecdsaWalletCreatedCallbackForTest(
        bytes32 ecdsaWalletID,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external {
        if (ecdsaWalletID == bytes32(0)) {
            revert Wallets.EcdsaWalletIdIsZero();
        }

        bytes20 walletPubKeyHash = bytes20(
            EcdsaLib.compressPublicKey(publicKeyX, publicKeyY).hash160View()
        );
        bytes32 walletID = Wallets.deriveLegacyWalletID(walletPubKeyHash);

        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        require(
            wallet.state == Wallets.WalletState.Unknown,
            "ECDSA wallet has been already registered"
        );
        wallet.ecdsaWalletID = ecdsaWalletID;
        wallet.state = Wallets.WalletState.Live;
        /* solhint-disable-next-line not-rely-on-time */
        wallet.createdAt = uint32(block.timestamp);

        bytes20 activeWalletPubKeyHash = self.activeWalletPubKeyHash;
        if (
            activeWalletPubKeyHash == bytes20(0) ||
            self.registeredWallets[activeWalletPubKeyHash].ecdsaWalletID !=
            bytes32(0)
        ) {
            self.activeWalletPubKeyHash = walletPubKeyHash;
            self.activeWalletID = walletID;
        }
        self.walletPubKeyHashByWalletID[walletID] = walletPubKeyHash;

        self.liveWalletsCount++;
        self.ecdsaWalletCount += 1;

        emit Wallets.NewWalletRegistered(ecdsaWalletID, walletPubKeyHash);
        emit Wallets.NewWalletRegisteredV2(
            walletID,
            ecdsaWalletID,
            walletPubKeyHash
        );
    }
}
