// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity ^0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

import "./BitcoinTx.sol";
import "./BridgeState.sol";
import "./Redemption.sol";
import "./Wallets.sol";

/// @title Moving Bridge wallet funds
/// @notice The library handles the logic for moving Bitcoin between Bridge
///         wallets.
/// @dev A wallet that failed a heartbeat, did not process requested redemption
///      on time, or qualifies to be closed, begins the procedure of moving
///      funds to other wallets in the Bridge. The wallet needs to commit to
///      which other Live wallets it is moving the funds to and then, provide an
///      SPV proof of moving funds to the previously committed wallets.
///      Once the proof is submitted, all target wallets are supposed to
///      sweep the received UTXOs with their own main UTXOs in order to
///      update their BTC balances.
library MovingFunds {
    using BridgeState for BridgeState.Storage;
    using Wallets for BridgeState.Storage;
    using BitcoinTx for BridgeState.Storage;

    using BTCUtils for bytes;
    using BytesLib for bytes;

    /// @notice Represents temporary information needed during the processing
    ///         of the moving funds Bitcoin transaction outputs. This structure
    ///         is an internal one and should not be exported outside of the
    ///         moving funds transaction processing code.
    /// @dev Allows to mitigate "stack too deep" errors on EVM.
    struct MovingFundsTxOutputsProcessingInfo {
        // 32-byte hash of the moving funds Bitcoin transaction.
        bytes32 movingFundsTxHash;
        // Output vector of the moving funds Bitcoin transaction. It is
        // assumed the vector's structure is valid so it must be validated
        // using e.g. `BTCUtils.validateVout` function before being used
        // during the processing. The validation is usually done as part
        // of the `BitcoinTx.validateProof` call that checks the SPV proof.
        bytes movingFundsTxOutputVector;
        // This struct doesn't contain `__gap` property as the structure is not
        // stored, it is used as a function's memory argument.
    }

    /// @notice Represents moved funds sweep request state.
    enum MovedFundsSweepRequestState {
        /// @dev The request is unknown to the Bridge.
        Unknown,
        /// @dev Request is pending and can become either processed or timed out.
        Pending,
        /// @dev Request was processed by the target wallet.
        Processed,
        /// @dev Request was not processed in the given time window and
        ///      the timeout was reported.
        TimedOut
    }

    /// @notice Represents a moved funds sweep request. The request is
    ///         registered in `submitMovingFundsProof` where we know funds
    ///         have been moved to the target wallet and the only step left is
    ///         to have the target wallet sweep them.
    struct MovedFundsSweepRequest {
        // 20-byte public key hash of the wallet supposed to sweep the UTXO
        // representing the received funds with their own main UTXO
        bytes20 walletPubKeyHash;
        // Value of the received funds.
        uint64 value;
        // UNIX timestamp the request was created at.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 createdAt;
        // The current state of the request.
        MovedFundsSweepRequestState state;
        // This struct doesn't contain `__gap` property as the structure is stored
        // in a mapping, mappings store values in different slots and they are
        // not contiguous with other values.
    }

    event MovingFundsCommitmentSubmitted(
        bytes20 indexed walletPubKeyHash,
        bytes20[] targetWallets,
        address submitter
    );

    event MovingFundsTimeoutReset(bytes20 indexed walletPubKeyHash);

    event MovingFundsCompleted(
        bytes20 indexed walletPubKeyHash,
        bytes32 movingFundsTxHash
    );

    event MovingFundsTimedOut(bytes20 indexed walletPubKeyHash);

    event MovingFundsBelowDustReported(bytes20 indexed walletPubKeyHash);

    event MovedFundsSwept(
        bytes20 indexed walletPubKeyHash,
        bytes32 sweepTxHash
    );

    event MovedFundsSweepTimedOut(
        bytes20 indexed walletPubKeyHash,
        bytes32 movingFundsTxHash,
        uint32 movingFundsTxOutputIndex
    );

    /// @notice Submits the moving funds target wallets commitment.
    ///         Once all requirements are met, that function registers the
    ///         target wallets commitment and opens the way for moving funds
    ///         proof submission.
    /// @param walletPubKeyHash 20-byte public key hash of the source wallet.
    /// @param walletMainUtxo Data of the source wallet's main UTXO, as
    ///        currently known on the Ethereum chain.
    /// @param walletMembersIDs Identifiers of the source wallet signing group
    ///        members.
    /// @param walletMemberIndex Position of the caller in the source wallet
    ///        signing group members list.
    /// @param targetWallets List of 20-byte public key hashes of the target
    ///        wallets that the source wallet commits to move the funds to.
    /// @dev Requirements:
    ///      - The source wallet must be in the MovingFunds state,
    ///      - The source wallet must not have pending redemption requests,
    ///      - The source wallet must not have pending moved funds sweep requests,
    ///      - The source wallet must not have submitted its commitment already,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given source wallet in the ECDSA registry. Those IDs are
    ///        not directly stored in the contract for gas efficiency purposes
    ///        but they can be read from appropriate `DkgResultSubmitted`
    ///        and `DkgResultApproved` events,
    ///      - The `walletMemberIndex` must be in range [1, walletMembersIDs.length],
    ///      - The caller must be the member of the source wallet signing group
    ///        at the position indicated by `walletMemberIndex` parameter,
    ///      - The `walletMainUtxo` components must point to the recent main
    ///        UTXO of the source wallet, as currently known on the Ethereum
    ///        chain,
    ///      - Source wallet BTC balance must be greater than zero,
    ///      - At least one Live wallet must exist in the system,
    ///      - Submitted target wallets count must match the expected count
    ///        `N = min(liveWalletsCount, ceil(walletBtcBalance / walletMaxBtcTransfer))`
    ///        where `N > 0`,
    ///      - Each target wallet must be not equal to the source wallet,
    ///      - Each target wallet must follow the expected order i.e. all
    ///        target wallets 20-byte public key hashes represented as numbers
    ///        must form a strictly increasing sequence without duplicates,
    ///      - Each target wallet must be in Live state.
    function submitMovingFundsCommitment(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata walletMainUtxo,
        uint32[] calldata walletMembersIDs,
        uint256 walletMemberIndex,
        bytes20[] calldata targetWallets
    ) external {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];

        require(
            wallet.state == Wallets.WalletState.MovingFunds,
            "Source wallet must be in MovingFunds state"
        );

        require(
            wallet.pendingRedemptionsValue == 0,
            "Source wallet must handle all pending redemptions first"
        );

        require(
            wallet.pendingMovedFundsSweepRequestsCount == 0,
            "Source wallet must handle all pending moved funds sweep requests first"
        );

        require(
            wallet.movingFundsTargetWalletsCommitmentHash == bytes32(0),
            "Target wallets commitment already submitted"
        );

        require(
            self.ecdsaWalletRegistry.isWalletMember(
                wallet.ecdsaWalletID,
                walletMembersIDs,
                msg.sender,
                walletMemberIndex
            ),
            "Caller is not a member of the source wallet"
        );

        uint64 walletBtcBalance = self.getWalletBtcBalance(
            walletPubKeyHash,
            walletMainUtxo
        );

        require(walletBtcBalance > 0, "Wallet BTC balance is zero");

        uint256 expectedTargetWalletsCount = Math.min(
            self.liveWalletsCount,
            Math.ceilDiv(walletBtcBalance, self.walletMaxBtcTransfer)
        );

        // This requirement fails only when `liveWalletsCount` is zero. In
        // that case, the system cannot accept the commitment and must provide
        // new wallets first. However, the wallet supposed to submit the
        // commitment can keep resetting the moving funds timeout until then.
        require(expectedTargetWalletsCount > 0, "No target wallets available");

        require(
            targetWallets.length == expectedTargetWalletsCount,
            "Submitted target wallets count is other than expected"
        );

        uint160 lastProcessedTargetWallet = 0;

        for (uint256 i = 0; i < targetWallets.length; i++) {
            bytes20 targetWallet = targetWallets[i];

            require(
                targetWallet != walletPubKeyHash,
                "Submitted target wallet cannot be equal to the source wallet"
            );

            require(
                uint160(targetWallet) > lastProcessedTargetWallet,
                "Submitted target wallet breaks the expected order"
            );

            require(
                self.registeredWallets[targetWallet].state ==
                    Wallets.WalletState.Live,
                "Submitted target wallet must be in Live state"
            );

            lastProcessedTargetWallet = uint160(targetWallet);
        }

        wallet.movingFundsTargetWalletsCommitmentHash = keccak256(
            abi.encodePacked(targetWallets)
        );

        emit MovingFundsCommitmentSubmitted(
            walletPubKeyHash,
            targetWallets,
            msg.sender
        );
    }

    /// @notice Resets the moving funds timeout for the given wallet if the
    ///         target wallet commitment cannot be submitted due to a lack
    ///         of live wallets in the system.
    /// @param walletPubKeyHash 20-byte public key hash of the moving funds wallet
    /// @dev Requirements:
    ///      - The wallet must be in the MovingFunds state,
    ///      - The target wallets commitment must not be already submitted for
    ///        the given moving funds wallet,
    ///      - Live wallets count must be zero,
    ///      - The moving funds timeout reset delay must be elapsed.
    function resetMovingFundsTimeout(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) external {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];

        require(
            wallet.state == Wallets.WalletState.MovingFunds,
            "Wallet must be in MovingFunds state"
        );

        // If the moving funds wallet already submitted their target wallets
        // commitment, there is no point to reset the timeout since the
        // wallet can make the BTC transaction and submit the proof.
        require(
            wallet.movingFundsTargetWalletsCommitmentHash == bytes32(0),
            "Target wallets commitment already submitted"
        );

        require(self.liveWalletsCount == 0, "Live wallets count must be zero");

        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >
                wallet.movingFundsRequestedAt +
                    self.movingFundsTimeoutResetDelay,
            "Moving funds timeout cannot be reset yet"
        );

        /* solhint-disable-next-line not-rely-on-time */
        wallet.movingFundsRequestedAt = uint32(block.timestamp);

        emit MovingFundsTimeoutReset(walletPubKeyHash);
    }

    /// @notice Used by the wallet to prove the BTC moving funds transaction
    ///         and to make the necessary state changes. Moving funds is only
    ///         accepted if it satisfies SPV proof.
    ///
    ///         The function validates the moving funds transaction structure
    ///         by checking if it actually spends the main UTXO of the declared
    ///         wallet and locks the value on the pre-committed target wallets
    ///         using a reasonable transaction fee. If all preconditions are
    ///         met, this functions closes the source wallet.
    ///
    ///         It is possible to prove the given moving funds transaction only
    ///         one time.
    /// @param movingFundsTx Bitcoin moving funds transaction data.
    /// @param movingFundsProof Bitcoin moving funds proof data.
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known on
    ///        the Ethereum chain.
    /// @param walletPubKeyHash 20-byte public key hash (computed using Bitcoin
    ///        HASH160 over the compressed ECDSA public key) of the wallet
    ///        which performed the moving funds transaction.
    /// @dev Requirements:
    ///      - `movingFundsTx` components must match the expected structure. See
    ///        `BitcoinTx.Info` docs for reference. Their values must exactly
    ///        correspond to appropriate Bitcoin transaction fields to produce
    ///        a provable transaction hash,
    ///      - The `movingFundsTx` should represent a Bitcoin transaction with
    ///        exactly 1 input that refers to the wallet's main UTXO. That
    ///        transaction should have 1..n outputs corresponding to the
    ///        pre-committed target wallets. Outputs must be ordered in the
    ///        same way as their corresponding target wallets are ordered
    ///        within the target wallets commitment,
    ///      - `movingFundsProof` components must match the expected structure.
    ///        See `BitcoinTx.Proof` docs for reference. The `bitcoinHeaders`
    ///        field must contain a valid number of block headers, not less
    ///        than the `txProofDifficultyFactor` contract constant,
    ///      - `mainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain.
    ///        Additionally, the recent main UTXO on Ethereum must be set,
    ///      - `walletPubKeyHash` must be connected with the main UTXO used
    ///        as transaction single input,
    ///      - The wallet that `walletPubKeyHash` points to must be in the
    ///        MovingFunds state,
    ///      - The target wallets commitment must be submitted by the wallet
    ///        that `walletPubKeyHash` points to,
    ///      - The total Bitcoin transaction fee must be lesser or equal
    ///        to `movingFundsTxMaxTotalFee` governable parameter.
    function submitMovingFundsProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata movingFundsTx,
        BitcoinTx.Proof calldata movingFundsProof,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes20 walletPubKeyHash
    ) external {
        // Wallet state is validated in `notifyWalletFundsMoved`.

        // The actual transaction proof is performed here. After that point, we
        // can assume the transaction happened on Bitcoin chain and has
        // a sufficient number of confirmations as determined by
        // `txProofDifficultyFactor` constant.
        bytes32 movingFundsTxHash = self.validateProof(
            movingFundsTx,
            movingFundsProof
        );

        // Assert that main UTXO for passed wallet exists in storage.
        bytes32 mainUtxoHash = self
            .registeredWallets[walletPubKeyHash]
            .mainUtxoHash;
        require(mainUtxoHash != bytes32(0), "No main UTXO for given wallet");

        // Assert that passed main UTXO parameter is the same as in storage and
        // can be used for further processing.
        require(
            keccak256(
                abi.encodePacked(
                    mainUtxo.txHash,
                    mainUtxo.txOutputIndex,
                    mainUtxo.txOutputValue
                )
            ) == mainUtxoHash,
            "Invalid main UTXO data"
        );

        // Process the moving funds transaction input. Specifically, check if
        // it refers to the expected wallet's main UTXO.
        OutboundTx.processWalletOutboundTxInput(
            self,
            movingFundsTx.inputVector,
            mainUtxo
        );

        (
            bytes32 targetWalletsHash,
            uint256 outputsTotalValue
        ) = processMovingFundsTxOutputs(
                self,
                MovingFundsTxOutputsProcessingInfo(
                    movingFundsTxHash,
                    movingFundsTx.outputVector
                )
            );

        require(
            mainUtxo.txOutputValue - outputsTotalValue <=
                self.movingFundsTxMaxTotalFee,
            "Transaction fee is too high"
        );

        self.notifyWalletFundsMoved(walletPubKeyHash, targetWalletsHash);
        // slither-disable-next-line reentrancy-events
        emit MovingFundsCompleted(walletPubKeyHash, movingFundsTxHash);
    }

    /// @notice Processes the moving funds Bitcoin transaction output vector
    ///         and extracts information required for further processing.
    /// @param processInfo Processing info containing the moving funds tx
    ///        hash and output vector.
    /// @return targetWalletsHash keccak256 hash over the list of actual
    ///         target wallets used in the transaction.
    /// @return outputsTotalValue Sum of all outputs values.
    /// @dev Requirements:
    ///      - The `movingFundsTxOutputVector` must be parseable, i.e. must
    ///        be validated by the caller as stated in their parameter doc,
    ///      - Each output must refer to a 20-byte public key hash,
    ///      - The total outputs value must be evenly divided over all outputs.
    function processMovingFundsTxOutputs(
        BridgeState.Storage storage self,
        MovingFundsTxOutputsProcessingInfo memory processInfo
    ) internal returns (bytes32 targetWalletsHash, uint256 outputsTotalValue) {
        // Determining the total number of Bitcoin transaction outputs in
        // the same way as for number of inputs. See `BitcoinTx.outputVector`
        // docs for more details.
        (
            uint256 outputsCompactSizeUintLength,
            uint256 outputsCount
        ) = processInfo.movingFundsTxOutputVector.parseVarInt();

        // To determine the first output starting index, we must jump over
        // the compactSize uint which prepends the output vector. One byte
        // must be added because `BtcUtils.parseVarInt` does not include
        // compactSize uint tag in the returned length.
        //
        // For >= 0 && <= 252, `BTCUtils.determineVarIntDataLengthAt`
        // returns `0`, so we jump over one byte of compactSize uint.
        //
        // For >= 253 && <= 0xffff there is `0xfd` tag,
        // `BTCUtils.determineVarIntDataLengthAt` returns `2` (no
        // tag byte included) so we need to jump over 1+2 bytes of
        // compactSize uint.
        //
        // Please refer `BTCUtils` library and compactSize uint
        // docs in `BitcoinTx` library for more details.
        uint256 outputStartingIndex = 1 + outputsCompactSizeUintLength;

        bytes20[] memory targetWallets = new bytes20[](outputsCount);
        uint64[] memory outputsValues = new uint64[](outputsCount);

        // Outputs processing loop. Note that the `outputIndex` must be
        // `uint32` to build proper `movedFundsSweepRequests` keys.
        for (
            uint32 outputIndex = 0;
            outputIndex < outputsCount;
            outputIndex++
        ) {
            uint256 outputLength = processInfo
                .movingFundsTxOutputVector
                .determineOutputLengthAt(outputStartingIndex);

            bytes memory output = processInfo.movingFundsTxOutputVector.slice(
                outputStartingIndex,
                outputLength
            );

            bytes20 targetWalletPubKeyHash = self.extractPubKeyHash(output);

            // Add the wallet public key hash to the list that will be used
            // to build the result list hash. There is no need to check if
            // given output is a change here because the actual target wallet
            // list must be exactly the same as the pre-committed target wallet
            // list which is guaranteed to be valid.
            targetWallets[outputIndex] = targetWalletPubKeyHash;

            // Extract the value from given output.
            outputsValues[outputIndex] = output.extractValue();
            outputsTotalValue += outputsValues[outputIndex];

            // Register a moved funds sweep request that must be handled
            // by the target wallet. The target wallet must sweep the
            // received funds with their own main UTXO in order to update
            // their BTC balance. Worth noting there is no need to check
            // if the sweep request already exists in the system because
            // the moving funds wallet is moved to the Closing state after
            // submitting the moving funds proof so there is no possibility
            // to submit the proof again and register the sweep request twice.
            self.movedFundsSweepRequests[
                uint256(
                    keccak256(
                        abi.encodePacked(
                            processInfo.movingFundsTxHash,
                            outputIndex
                        )
                    )
                )
            ] = MovedFundsSweepRequest(
                targetWalletPubKeyHash,
                outputsValues[outputIndex],
                /* solhint-disable-next-line not-rely-on-time */
                uint32(block.timestamp),
                MovedFundsSweepRequestState.Pending
            );
            // We added a new moved funds sweep request for the target wallet
            // so we must increment their request counter.
            self
                .registeredWallets[targetWalletPubKeyHash]
                .pendingMovedFundsSweepRequestsCount++;

            // Make the `outputStartingIndex` pointing to the next output by
            // increasing it by current output's length.
            outputStartingIndex += outputLength;
        }

        // Compute the indivisible remainder that remains after dividing the
        // outputs total value over all outputs evenly.
        uint256 outputsTotalValueRemainder = outputsTotalValue % outputsCount;
        // Compute the minimum allowed output value by dividing the outputs
        // total value (reduced by the remainder) by the number of outputs.
        uint256 minOutputValue = (outputsTotalValue -
            outputsTotalValueRemainder) / outputsCount;
        // Maximum possible value is the minimum value with the remainder included.
        uint256 maxOutputValue = minOutputValue + outputsTotalValueRemainder;

        for (uint256 i = 0; i < outputsCount; i++) {
            require(
                minOutputValue <= outputsValues[i] &&
                    outputsValues[i] <= maxOutputValue,
                "Transaction amount is not distributed evenly"
            );
        }

        targetWalletsHash = keccak256(abi.encodePacked(targetWallets));

        return (targetWalletsHash, outputsTotalValue);
    }

    /// @notice Notifies about a timed out moving funds process. Terminates
    ///         the wallet and slashes signing group members as a result.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The wallet must be in the MovingFunds state,
    ///      - The moving funds timeout must be actually exceeded,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events of the `WalletRegistry` contract.
    function notifyMovingFundsTimeout(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs
    ) external {
        // Wallet state is validated in `notifyWalletMovingFundsTimeout`.

        uint32 movingFundsRequestedAt = self
            .registeredWallets[walletPubKeyHash]
            .movingFundsRequestedAt;

        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp > movingFundsRequestedAt + self.movingFundsTimeout,
            "Moving funds has not timed out yet"
        );

        self.notifyWalletMovingFundsTimeout(walletPubKeyHash, walletMembersIDs);

        // slither-disable-next-line reentrancy-events
        emit MovingFundsTimedOut(walletPubKeyHash);
    }

    /// @notice Notifies about a moving funds wallet whose BTC balance is
    ///         below the moving funds dust threshold. Ends the moving funds
    ///         process and begins wallet closing immediately.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known
    ///        on the Ethereum chain.
    /// @dev Requirements:
    ///      - The wallet must be in the MovingFunds state,
    ///      - The `mainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain.
    ///        If the wallet has no main UTXO, this parameter can be empty as it
    ///        is ignored,
    ///      - The wallet BTC balance must be below the moving funds threshold.
    function notifyMovingFundsBelowDust(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo
    ) external {
        // Wallet state is validated in `notifyWalletMovingFundsBelowDust`.

        uint64 walletBtcBalance = self.getWalletBtcBalance(
            walletPubKeyHash,
            mainUtxo
        );

        require(
            walletBtcBalance < self.movingFundsDustThreshold,
            "Wallet BTC balance must be below the moving funds dust threshold"
        );

        self.notifyWalletMovingFundsBelowDust(walletPubKeyHash);

        // slither-disable-next-line reentrancy-events
        emit MovingFundsBelowDustReported(walletPubKeyHash);
    }

    /// @notice Used by the wallet to prove the BTC moved funds sweep
    ///         transaction and to make the necessary state changes. Moved
    ///         funds sweep is only accepted if it satisfies SPV proof.
    ///
    ///         The function validates the sweep transaction structure by
    ///         checking if it actually spends the moved funds UTXO and the
    ///         sweeping wallet's main UTXO (optionally), and if it locks the
    ///         value on the sweeping wallet's 20-byte public key hash using a
    ///         reasonable transaction fee. If all preconditions are
    ///         met, this function updates the sweeping wallet main UTXO, thus
    ///         their BTC balance.
    ///
    ///         It is possible to prove the given sweep transaction only
    ///         one time.
    /// @param sweepTx Bitcoin sweep funds transaction data.
    /// @param sweepProof Bitcoin sweep funds proof data.
    /// @param mainUtxo Data of the sweeping wallet's main UTXO, as currently
    ///        known on the Ethereum chain.
    /// @dev Requirements:
    ///      - `sweepTx` components must match the expected structure. See
    ///        `BitcoinTx.Info` docs for reference. Their values must exactly
    ///        correspond to appropriate Bitcoin transaction fields to produce
    ///        a provable transaction hash,
    ///      - The `sweepTx` should represent a Bitcoin transaction with
    ///        the first input pointing to a wallet's sweep Pending request and,
    ///        optionally, the second input pointing to the wallet's main UTXO,
    ///        if the sweeping wallet has a main UTXO set. There should be only
    ///        one output locking funds on the sweeping wallet 20-byte public
    ///        key hash,
    ///      - `sweepProof` components must match the expected structure.
    ///        See `BitcoinTx.Proof` docs for reference. The `bitcoinHeaders`
    ///        field must contain a valid number of block headers, not less
    ///        than the `txProofDifficultyFactor` contract constant,
    ///      - `mainUtxo` components must point to the recent main UTXO
    ///        of the sweeping wallet, as currently known on the Ethereum chain.
    ///        If there is no main UTXO, this parameter is ignored,
    ///      - The sweeping wallet must be in the Live or MovingFunds state,
    ///      - The total Bitcoin transaction fee must be lesser or equal
    ///        to `movedFundsSweepTxMaxTotalFee` governable parameter.
    function submitMovedFundsSweepProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata sweepTx,
        BitcoinTx.Proof calldata sweepProof,
        BitcoinTx.UTXO calldata mainUtxo
    ) external {
        // Wallet state validation is performed in the
        // `resolveMovedFundsSweepingWallet` function.

        // The actual transaction proof is performed here. After that point, we
        // can assume the transaction happened on Bitcoin chain and has
        // a sufficient number of confirmations as determined by
        // `txProofDifficultyFactor` constant.
        bytes32 sweepTxHash = self.validateProof(sweepTx, sweepProof);

        (
            bytes20 walletPubKeyHash,
            uint64 sweepTxOutputValue
        ) = processMovedFundsSweepTxOutput(self, sweepTx.outputVector);

        (
            Wallets.Wallet storage wallet,
            BitcoinTx.UTXO memory resolvedMainUtxo
        ) = resolveMovedFundsSweepingWallet(self, walletPubKeyHash, mainUtxo);

        uint256 sweepTxInputsTotalValue = processMovedFundsSweepTxInputs(
            self,
            sweepTx.inputVector,
            resolvedMainUtxo,
            walletPubKeyHash
        );

        require(
            sweepTxInputsTotalValue - sweepTxOutputValue <=
                self.movedFundsSweepTxMaxTotalFee,
            "Transaction fee is too high"
        );

        // Use the sweep transaction output as the new sweeping wallet's main UTXO.
        // Transaction output index is always 0 as sweep transaction always
        // contains only one output.
        wallet.mainUtxoHash = keccak256(
            abi.encodePacked(sweepTxHash, uint32(0), sweepTxOutputValue)
        );

        // slither-disable-next-line reentrancy-events
        emit MovedFundsSwept(walletPubKeyHash, sweepTxHash);
    }

    /// @notice Processes the Bitcoin moved funds sweep transaction output vector
    ///         by extracting the single output and using it to gain additional
    ///         information required for further processing (e.g. value and
    ///         wallet public key hash).
    /// @param sweepTxOutputVector Bitcoin moved funds sweep transaction output
    ///        vector.
    ///        This function assumes vector's structure is valid so it must be
    ///        validated using e.g. `BTCUtils.validateVout` function before
    ///        it is passed here.
    /// @return walletPubKeyHash 20-byte wallet public key hash.
    /// @return value 8-byte moved funds sweep transaction output value.
    /// @dev Requirements:
    ///      - Output vector must contain only one output,
    ///      - The single output must be of P2PKH or P2WPKH type and lock the
    ///        funds on a 20-byte public key hash.
    function processMovedFundsSweepTxOutput(
        BridgeState.Storage storage self,
        bytes memory sweepTxOutputVector
    ) internal view returns (bytes20 walletPubKeyHash, uint64 value) {
        // To determine the total number of sweep transaction outputs, we need to
        // parse the compactSize uint (VarInt) the output vector is prepended by.
        // That compactSize uint encodes the number of vector elements using the
        // format presented in:
        // https://developer.bitcoin.org/reference/transactions.html#compactsize-unsigned-integers
        // We don't need asserting the compactSize uint is parseable since it
        // was already checked during `validateVout` validation performed as
        // part of the `BitcoinTx.validateProof` call.
        // See `BitcoinTx.outputVector` docs for more details.
        (, uint256 outputsCount) = sweepTxOutputVector.parseVarInt();
        require(
            outputsCount == 1,
            "Moved funds sweep transaction must have a single output"
        );

        bytes memory output = sweepTxOutputVector.extractOutputAtIndex(0);
        walletPubKeyHash = self.extractPubKeyHash(output);
        value = output.extractValue();

        return (walletPubKeyHash, value);
    }

    /// @notice Resolves sweeping wallet based on the provided wallet public key
    ///         hash. Validates the wallet state and current main UTXO, as
    ///         currently known on the Ethereum chain.
    /// @param walletPubKeyHash public key hash of the wallet proving the sweep
    ///        Bitcoin transaction.
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known on
    ///        the Ethereum chain. If no main UTXO exists for the given wallet,
    ///        this parameter is ignored.
    /// @return wallet Data of the sweeping wallet.
    /// @return resolvedMainUtxo The actual main UTXO of the sweeping wallet
    ///         resolved by cross-checking the `mainUtxo` parameter with
    ///         the chain state. If the validation went well, this is the
    ///         plain-text main UTXO corresponding to the `wallet.mainUtxoHash`.
    /// @dev Requirements:
    ///     - Sweeping wallet must be either in Live or MovingFunds state,
    ///     - If the main UTXO of the sweeping wallet exists in the storage,
    ///       the passed `mainUTXO` parameter must be equal to the stored one.
    function resolveMovedFundsSweepingWallet(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo
    )
        internal
        view
        returns (
            Wallets.Wallet storage wallet,
            BitcoinTx.UTXO memory resolvedMainUtxo
        )
    {
        wallet = self.registeredWallets[walletPubKeyHash];

        Wallets.WalletState walletState = wallet.state;
        require(
            walletState == Wallets.WalletState.Live ||
                walletState == Wallets.WalletState.MovingFunds,
            "Wallet must be in Live or MovingFunds state"
        );

        // Check if the main UTXO for given wallet exists. If so, validate
        // passed main UTXO data against the stored hash and use them for
        // further processing. If no main UTXO exists, use empty data.
        resolvedMainUtxo = BitcoinTx.UTXO(bytes32(0), 0, 0);
        bytes32 mainUtxoHash = wallet.mainUtxoHash;
        if (mainUtxoHash != bytes32(0)) {
            require(
                keccak256(
                    abi.encodePacked(
                        mainUtxo.txHash,
                        mainUtxo.txOutputIndex,
                        mainUtxo.txOutputValue
                    )
                ) == mainUtxoHash,
                "Invalid main UTXO data"
            );
            resolvedMainUtxo = mainUtxo;
        }
    }

    /// @notice Processes the Bitcoin moved funds sweep transaction input vector.
    ///         It extracts the first input and tries to match it with one of
    ///         the moved funds sweep requests targeting the sweeping wallet.
    ///         If the sweep request is an existing Pending request, this
    ///         function marks it as Processed. If the sweeping wallet has a
    ///         main UTXO, this function extracts the second input, makes sure
    ///         it refers to the wallet main UTXO, and marks that main UTXO as
    ///         correctly spent.
    /// @param sweepTxInputVector Bitcoin moved funds sweep transaction input vector.
    ///        This function assumes vector's structure is valid so it must be
    ///        validated using e.g. `BTCUtils.validateVin` function before
    ///        it is passed here.
    /// @param mainUtxo Data of the sweeping wallet's main UTXO. If no main UTXO
    ///        exists for the given the wallet, this parameter's fields should
    ///        be zeroed to bypass the main UTXO validation.
    /// @param walletPubKeyHash 20-byte public key hash of the sweeping wallet.
    /// @return inputsTotalValue Total inputs value sum.
    /// @dev Requirements:
    ///      - The input vector must consist of one mandatory and one optional
    ///        input,
    ///      - The mandatory input must be the first input in the vector,
    ///      - The mandatory input must point to a Pending moved funds sweep
    ///        request that is targeted to the sweeping wallet,
    ///      - The optional output must be the second input in the vector,
    ///      - The optional input is required if the sweeping wallet has a
    ///        main UTXO (i.e. the `mainUtxo` is not zeroed). In that case,
    ///        that input must point the the sweeping wallet main UTXO.
    function processMovedFundsSweepTxInputs(
        BridgeState.Storage storage self,
        bytes memory sweepTxInputVector,
        BitcoinTx.UTXO memory mainUtxo,
        bytes20 walletPubKeyHash
    ) internal returns (uint256 inputsTotalValue) {
        // To determine the total number of Bitcoin transaction inputs,
        // we need to parse the compactSize uint (VarInt) the input vector is
        // prepended by. That compactSize uint encodes the number of vector
        // elements using the format presented in:
        // https://developer.bitcoin.org/reference/transactions.html#compactsize-unsigned-integers
        // We don't need asserting the compactSize uint is parseable since it
        // was already checked during `validateVin` validation performed as
        // part of the `BitcoinTx.validateProof` call.
        // See `BitcoinTx.inputVector` docs for more details.
        (
            uint256 inputsCompactSizeUintLength,
            uint256 inputsCount
        ) = sweepTxInputVector.parseVarInt();

        // To determine the first input starting index, we must jump over
        // the compactSize uint which prepends the input vector. One byte
        // must be added because `BtcUtils.parseVarInt` does not include
        // compactSize uint tag in the returned length.
        //
        // For >= 0 && <= 252, `BTCUtils.determineVarIntDataLengthAt`
        // returns `0`, so we jump over one byte of compactSize uint.
        //
        // For >= 253 && <= 0xffff there is `0xfd` tag,
        // `BTCUtils.determineVarIntDataLengthAt` returns `2` (no
        // tag byte included) so we need to jump over 1+2 bytes of
        // compactSize uint.
        //
        // Please refer `BTCUtils` library and compactSize uint
        // docs in `BitcoinTx` library for more details.
        uint256 inputStartingIndex = 1 + inputsCompactSizeUintLength;

        // We always expect the first input to be the swept UTXO. Additionally,
        // if the sweeping wallet has a main UTXO, that main UTXO should be
        // pointed by the second input.
        require(
            inputsCount == (mainUtxo.txHash != bytes32(0) ? 2 : 1),
            "Moved funds sweep transaction must have a proper inputs count"
        );

        // Parse the first input and extract its outpoint tx hash and index.
        (
            bytes32 firstInputOutpointTxHash,
            uint32 firstInputOutpointIndex,
            uint256 firstInputLength
        ) = parseMovedFundsSweepTxInputAt(
                sweepTxInputVector,
                inputStartingIndex
            );

        // Build the request key and fetch the corresponding moved funds sweep
        // request from contract storage.
        MovedFundsSweepRequest storage sweepRequest = self
            .movedFundsSweepRequests[
                uint256(
                    keccak256(
                        abi.encodePacked(
                            firstInputOutpointTxHash,
                            firstInputOutpointIndex
                        )
                    )
                )
            ];

        require(
            sweepRequest.state == MovedFundsSweepRequestState.Pending,
            "Sweep request must be in Pending state"
        );
        // We must check if the wallet extracted from the moved funds sweep
        // transaction output is truly the owner of the sweep request connected
        // with the swept UTXO. This is needed to prevent a case when a wallet
        // handles its own sweep request but locks the funds on another
        // wallet public key hash.
        require(
            sweepRequest.walletPubKeyHash == walletPubKeyHash,
            "Sweep request belongs to another wallet"
        );
        // If the validation passed, the sweep request must be marked as
        // processed and its value should be counted into the total inputs
        // value sum.
        sweepRequest.state = MovedFundsSweepRequestState.Processed;
        inputsTotalValue += sweepRequest.value;

        self
            .registeredWallets[walletPubKeyHash]
            .pendingMovedFundsSweepRequestsCount--;

        // If the main UTXO for the sweeping wallet exists, it must be processed.
        if (mainUtxo.txHash != bytes32(0)) {
            // The second input is supposed to point to that sweeping wallet
            // main UTXO. We need to parse that input.
            (
                bytes32 secondInputOutpointTxHash,
                uint32 secondInputOutpointIndex,

            ) = parseMovedFundsSweepTxInputAt(
                    sweepTxInputVector,
                    inputStartingIndex + firstInputLength
                );
            // Make sure the second input refers to the sweeping wallet main UTXO.
            require(
                mainUtxo.txHash == secondInputOutpointTxHash &&
                    mainUtxo.txOutputIndex == secondInputOutpointIndex,
                "Second input must point to the wallet's main UTXO"
            );

            // If the validation passed, count the main UTXO value into the
            // total inputs value sum.
            inputsTotalValue += mainUtxo.txOutputValue;

            // Main UTXO used as an input, mark it as spent. This is needed
            // to defend against fraud challenges referring to this main UTXO.
            self.spentMainUTXOs[
                uint256(
                    keccak256(
                        abi.encodePacked(
                            secondInputOutpointTxHash,
                            secondInputOutpointIndex
                        )
                    )
                )
            ] = true;
        }

        return inputsTotalValue;
    }

    /// @notice Parses a Bitcoin transaction input starting at the given index.
    /// @param inputVector Bitcoin transaction input vector.
    /// @param inputStartingIndex Index the given input starts at.
    /// @return outpointTxHash 32-byte hash of the Bitcoin transaction which is
    ///         pointed in the given input's outpoint.
    /// @return outpointIndex 4-byte index of the Bitcoin transaction output
    ///         which is pointed in the given input's outpoint.
    /// @return inputLength Byte length of the given input.
    /// @dev This function assumes vector's structure is valid so it must be
    ///      validated using e.g. `BTCUtils.validateVin` function before it
    ///      is passed here.
    function parseMovedFundsSweepTxInputAt(
        bytes memory inputVector,
        uint256 inputStartingIndex
    )
        internal
        pure
        returns (
            bytes32 outpointTxHash,
            uint32 outpointIndex,
            uint256 inputLength
        )
    {
        outpointTxHash = inputVector.extractInputTxIdLeAt(inputStartingIndex);

        outpointIndex = BTCUtils.reverseUint32(
            uint32(inputVector.extractTxIndexLeAt(inputStartingIndex))
        );

        inputLength = inputVector.determineInputLengthAt(inputStartingIndex);

        return (outpointTxHash, outpointIndex, inputLength);
    }

    /// @notice Notifies about a timed out moved funds sweep process. If the
    ///         wallet is not terminated yet, that function terminates
    ///         the wallet and slashes signing group members as a result.
    ///         Marks the given sweep request as TimedOut.
    /// @param movingFundsTxHash 32-byte hash of the moving funds transaction
    ///        that caused the sweep request to be created.
    /// @param movingFundsTxOutputIndex Index of the moving funds transaction
    ///        output that is subject of the sweep request.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The moved funds sweep request must be in the Pending state,
    ///      - The moved funds sweep timeout must be actually exceeded,
    ///      - The wallet must be either in the Live or MovingFunds or
    ///        Terminated state,,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events of the `WalletRegistry` contract.
    function notifyMovedFundsSweepTimeout(
        BridgeState.Storage storage self,
        bytes32 movingFundsTxHash,
        uint32 movingFundsTxOutputIndex,
        uint32[] calldata walletMembersIDs
    ) external {
        // Wallet state is validated in `notifyWalletMovedFundsSweepTimeout`.

        MovedFundsSweepRequest storage sweepRequest = self
            .movedFundsSweepRequests[
                uint256(
                    keccak256(
                        abi.encodePacked(
                            movingFundsTxHash,
                            movingFundsTxOutputIndex
                        )
                    )
                )
            ];

        require(
            sweepRequest.state == MovedFundsSweepRequestState.Pending,
            "Sweep request must be in Pending state"
        );

        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >
                sweepRequest.createdAt + self.movedFundsSweepTimeout,
            "Sweep request has not timed out yet"
        );

        bytes20 walletPubKeyHash = sweepRequest.walletPubKeyHash;

        self.notifyWalletMovedFundsSweepTimeout(
            walletPubKeyHash,
            walletMembersIDs
        );

        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        sweepRequest.state = MovedFundsSweepRequestState.TimedOut;
        wallet.pendingMovedFundsSweepRequestsCount--;

        // slither-disable-next-line reentrancy-events
        emit MovedFundsSweepTimedOut(
            walletPubKeyHash,
            movingFundsTxHash,
            movingFundsTxOutputIndex
        );
    }
}
