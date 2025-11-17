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

pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

import "./BitcoinTx.sol";
import "./Bridge.sol";
import "./Deposit.sol";
import "./Redemption.sol";
import "./MovingFunds.sol";
import "./Wallets.sol";

/// @title Wallet proposal validator.
/// @notice This contract exposes several view functions allowing to validate
///         specific wallet action proposals. This contract is non-upgradeable
///         and does not have any write functions.
contract WalletProposalValidator {
    using BTCUtils for bytes;
    using BytesLib for bytes;

    /// @notice Helper structure representing a deposit sweep proposal.
    struct DepositSweepProposal {
        // 20-byte public key hash of the target wallet.
        bytes20 walletPubKeyHash;
        // Deposits that should be part of the sweep.
        DepositKey[] depositsKeys;
        // Proposed BTC fee for the entire transaction.
        uint256 sweepTxFee;
        // Array containing the reveal blocks of each deposit. This information
        // strongly facilitates the off-chain processing. Using those blocks,
        // wallet operators can quickly fetch corresponding Bridge.DepositRevealed
        // events carrying deposit data necessary to perform proposal validation.
        // This field is not explicitly validated within the validateDepositSweepProposal
        // function because if something is wrong here the off-chain wallet
        // operators will fail anyway as they won't be able to gather deposit
        // data necessary to perform the on-chain validation using the
        // validateDepositSweepProposal function.
        uint256[] depositsRevealBlocks;
    }

    /// @notice Helper structure representing a plain-text deposit key.
    ///         Each deposit can be identified by their 32-byte funding
    ///         transaction hash (Bitcoin internal byte order) an the funding
    ///         output index (0-based).
    /// @dev Do not confuse this structure with the deposit key used within the
    ///      Bridge contract to store deposits. Here we have the plain-text
    ///      components of the key while the Bridge uses a uint representation of
    ///      keccak256(fundingTxHash | fundingOutputIndex) for gas efficiency.
    struct DepositKey {
        bytes32 fundingTxHash;
        uint32 fundingOutputIndex;
    }

    /// @notice Helper structure holding deposit extra info required during
    ///         deposit sweep proposal validation. Basically, this structure
    ///         is a combination of BitcoinTx.Info and relevant parts of
    ///         Deposit.DepositRevealInfo.
    /// @dev These data can be pulled from respective `DepositRevealed` events
    ///      emitted by the `Bridge.revealDeposit` function. The `fundingTx`
    ///      field must be taken directly from the Bitcoin chain, using the
    ///      `DepositRevealed.fundingTxHash` as transaction identifier.
    struct DepositExtraInfo {
        BitcoinTx.Info fundingTx;
        bytes8 blindingFactor;
        bytes20 walletPubKeyHash;
        bytes20 refundPubKeyHash;
        bytes4 refundLocktime;
    }

    /// @notice Helper structure representing a redemption proposal.
    struct RedemptionProposal {
        // 20-byte public key hash of the target wallet.
        bytes20 walletPubKeyHash;
        // Array of the redeemers' output scripts that should be part of
        // the redemption. Each output script MUST BE prefixed by its byte
        // length, i.e. passed in the exactly same format as during the
        // `Bridge.requestRedemption` transaction.
        bytes[] redeemersOutputScripts;
        // Proposed BTC fee for the entire transaction.
        uint256 redemptionTxFee;
    }

    /// @notice Helper structure representing a moving funds proposal.
    struct MovingFundsProposal {
        // 20-byte public key hash of the source wallet.
        bytes20 walletPubKeyHash;
        // List of 20-byte public key hashes of target wallets.
        bytes20[] targetWallets;
        // Proposed BTC fee for the entire transaction.
        uint256 movingFundsTxFee;
    }

    /// @notice Helper structure representing a moved funds sweep proposal.
    struct MovedFundsSweepProposal {
        // 20-byte public key hash of the wallet.
        bytes20 walletPubKeyHash;
        // 32-byte hash of the moving funds transaction that caused the sweep
        // request to be created.
        bytes32 movingFundsTxHash;
        // Index of the moving funds transaction output that is subject of the
        // sweep request.
        uint32 movingFundsTxOutputIndex;
        // Proposed BTC fee for the entire transaction.
        uint256 movedFundsSweepTxFee;
    }

    /// @notice Helper structure representing a heartbeat proposal.
    struct HeartbeatProposal {
        // 20-byte public key hash of the target wallet.
        bytes20 walletPubKeyHash;
        // Message to be signed as part of the heartbeat.
        bytes message;
    }

    /// @notice Handle to the Bridge contract.
    Bridge public immutable bridge;

    /// @notice The minimum time that must elapse since the deposit reveal
    ///         before a deposit becomes eligible for a deposit sweep.
    ///
    ///         For example, if a deposit was revealed at 9 am and DEPOSIT_MIN_AGE
    ///         is 2 hours, the deposit is eligible for sweep after 11 am.
    ///
    /// @dev Forcing deposit minimum age ensures block finality for Ethereum.
    ///      In the happy path case, i.e. where the deposit is revealed immediately
    ///      after being broadcast on the Bitcoin network, the minimum age
    ///      check also ensures block finality for Bitcoin.
    uint32 public constant DEPOSIT_MIN_AGE = 2 hours;

    /// @notice Each deposit can be technically swept until it reaches its
    ///         refund timestamp after which it can be taken back by the depositor.
    ///         However, allowing the wallet to sweep deposits that are close
    ///         to their refund timestamp may cause a race between the wallet
    ///         and the depositor. In result, the wallet may sign an invalid
    ///         sweep transaction that aims to sweep an already refunded deposit.
    ///         Such tx signature may be used to create an undefeatable fraud
    ///         challenge against the wallet. In order to mitigate that problem,
    ///         this parameter determines a safety margin that puts the latest
    ///         moment a deposit can be swept far before the point after which
    ///         the deposit becomes refundable.
    ///
    ///         For example, if a deposit becomes refundable after 8 pm and
    ///         DEPOSIT_REFUND_SAFETY_MARGIN is 6 hours, the deposit is valid
    ///         for a sweep only before 2 pm.
    uint32 public constant DEPOSIT_REFUND_SAFETY_MARGIN = 24 hours;

    /// @notice The maximum count of deposits that can be swept within a
    ///         single sweep.
    uint16 public constant DEPOSIT_SWEEP_MAX_SIZE = 20;

    /// @notice The minimum time that must elapse since the redemption request
    ///         creation before a request becomes eligible for a processing.
    ///
    ///         For example, if a request was created at 9 am and
    ///         REDEMPTION_REQUEST_MIN_AGE is 2 hours, the request is
    ///         eligible for processing after 11 am.
    ///
    /// @dev Forcing request minimum age ensures block finality for Ethereum.
    uint32 public constant REDEMPTION_REQUEST_MIN_AGE = 600; // 10 minutes or ~50 blocks.

    /// @notice Each redemption request can be technically handled until it
    ///         reaches its timeout timestamp after which it can be reported
    ///         as timed out. However, allowing the wallet to handle requests
    ///         that are close to their timeout timestamp may cause a race
    ///         between the wallet and the redeemer. In result, the wallet may
    ///         redeem the requested funds even though the redeemer already
    ///         received back their tBTC (locked during redemption request) upon
    ///         reporting the request timeout. In effect, the redeemer may end
    ///         out with both tBTC and redeemed BTC in their hands which has
    ///         a negative impact on the tBTC <-> BTC peg. In order to mitigate
    ///         that problem, this parameter determines a safety margin that
    ///         puts the latest moment a request can be handled far before the
    ///         point after which the request can be reported as timed out.
    ///
    ///         For example, if a request times out after 8 pm and
    ///         REDEMPTION_REQUEST_TIMEOUT_SAFETY_MARGIN is 2 hours, the
    ///         request is valid for processing only before 6 pm.
    uint32 public constant REDEMPTION_REQUEST_TIMEOUT_SAFETY_MARGIN = 2 hours;

    /// @notice The maximum count of redemption requests that can be processed
    ///         within a single redemption.
    uint16 public constant REDEMPTION_MAX_SIZE = 20;

    constructor(Bridge _bridge) {
        bridge = _bridge;
    }

    /// @notice View function encapsulating the main rules of a valid deposit
    ///         sweep proposal. This function is meant to facilitate the off-chain
    ///         validation of the incoming proposals. Thanks to it, most
    ///         of the work can be done using a single readonly contract call.
    ///         Worth noting, the validation done here is not exhaustive as some
    ///         conditions may not be verifiable within the on-chain function or
    ///         checking them may be easier on the off-chain side. For example,
    ///         this function does not check the SPV proofs and confirmations of
    ///         the deposit funding transactions as this would require an
    ///         integration with the difficulty relay that greatly increases
    ///         complexity. Instead of that, each off-chain wallet member is
    ///         supposed to do that check on their own.
    /// @param proposal The sweeping proposal to validate.
    /// @param depositsExtraInfo Deposits extra info required to perform the validation.
    /// @return True if the proposal is valid. Reverts otherwise.
    /// @dev Requirements:
    ///      - The target wallet must be in the Live or MovingFunds state,
    ///      - The number of deposits included in the sweep must be in
    ///        the range [1, `DEPOSIT_SWEEP_MAX_SIZE`],
    ///      - The length of `depositsExtraInfo` array must be equal to the
    ///        length of `proposal.depositsKeys`, i.e. each deposit must
    ///        have exactly one set of corresponding extra info,
    ///      - The proposed sweep tx fee must be grater than zero,
    ///      - The proposed maximum per-deposit sweep tx fee must be lesser than
    ///        or equal the maximum fee allowed by the Bridge (`Bridge.depositTxMaxFee`),
    ///      - Each deposit must be revealed to the Bridge,
    ///      - Each deposit must be old enough, i.e. at least `DEPOSIT_MIN_AGE
    ///        elapsed since their reveal time,
    ///      - Each deposit must not be swept yet,
    ///      - Each deposit must have valid extra info (see `validateDepositExtraInfo`),
    ///      - Each deposit must have the refund safety margin preserved,
    ///      - Each deposit must be controlled by the same wallet,
    ///      - Each deposit must target the same vault,
    ///      - Each deposit must be unique.
    ///
    ///      The following off-chain validation must be performed as a bare minimum:
    ///      - Inputs used for the sweep transaction have enough Bitcoin confirmations,
    ///      - Deposits revealed to the Bridge have enough Ethereum confirmations.
    function validateDepositSweepProposal(
        DepositSweepProposal calldata proposal,
        DepositExtraInfo[] calldata depositsExtraInfo
    ) external view returns (bool) {
        Wallets.Wallet memory wallet = bridge.wallets(
            proposal.walletPubKeyHash
        );

        require(
            wallet.state == Wallets.WalletState.Live ||
                wallet.state == Wallets.WalletState.MovingFunds,
            "Wallet is not in Live or MovingFunds state"
        );

        require(proposal.depositsKeys.length > 0, "Sweep below the min size");

        require(
            proposal.depositsKeys.length <= DEPOSIT_SWEEP_MAX_SIZE,
            "Sweep exceeds the max size"
        );

        require(
            proposal.depositsKeys.length == depositsExtraInfo.length,
            "Each deposit key must have matching extra info"
        );

        validateSweepTxFee(proposal.sweepTxFee, proposal.depositsKeys.length);

        address proposalVault = address(0);

        uint256[] memory processedDepositKeys = new uint256[](
            proposal.depositsKeys.length
        );

        for (uint256 i = 0; i < proposal.depositsKeys.length; i++) {
            DepositKey memory depositKey = proposal.depositsKeys[i];
            DepositExtraInfo memory depositExtraInfo = depositsExtraInfo[i];

            uint256 depositKeyUint = uint256(
                keccak256(
                    abi.encodePacked(
                        depositKey.fundingTxHash,
                        depositKey.fundingOutputIndex
                    )
                )
            );

            // slither-disable-next-line calls-loop
            Deposit.DepositRequest memory depositRequest = bridge.deposits(
                depositKeyUint
            );

            require(depositRequest.revealedAt != 0, "Deposit not revealed");

            require(
                /* solhint-disable-next-line not-rely-on-time */
                block.timestamp > depositRequest.revealedAt + DEPOSIT_MIN_AGE,
                "Deposit min age not achieved yet"
            );

            require(depositRequest.sweptAt == 0, "Deposit already swept");

            validateDepositExtraInfo(
                depositKey,
                depositRequest.depositor,
                depositRequest.extraData,
                depositExtraInfo
            );

            uint32 depositRefundableTimestamp = BTCUtils.reverseUint32(
                uint32(depositExtraInfo.refundLocktime)
            );
            require(
                /* solhint-disable-next-line not-rely-on-time */
                block.timestamp <
                    depositRefundableTimestamp - DEPOSIT_REFUND_SAFETY_MARGIN,
                "Deposit refund safety margin is not preserved"
            );

            require(
                depositExtraInfo.walletPubKeyHash == proposal.walletPubKeyHash,
                "Deposit controlled by different wallet"
            );

            // Make sure all deposits target the same vault by using the
            // vault of the first deposit as a reference.
            if (i == 0) {
                proposalVault = depositRequest.vault;
            }
            require(
                depositRequest.vault == proposalVault,
                "Deposit targets different vault"
            );

            // Make sure there are no duplicates in the deposits list.
            for (uint256 j = 0; j < i; j++) {
                require(
                    processedDepositKeys[j] != depositKeyUint,
                    "Duplicated deposit"
                );
            }

            processedDepositKeys[i] = depositKeyUint;
        }

        return true;
    }

    /// @notice Validates the sweep tx fee by checking if the part of the fee
    ///         incurred by each deposit does not exceed the maximum value
    ///         allowed by the Bridge. This function is heavily based on
    ///         `DepositSweep.depositSweepTxFeeDistribution` function.
    /// @param sweepTxFee The sweep transaction fee.
    /// @param depositsCount Count of the deposits swept by the sweep transaction.
    /// @dev Requirements:
    ///      - The sweep tx fee must be grater than zero,
    ///      - The maximum per-deposit sweep tx fee must be lesser than or equal
    ///        the maximum fee allowed by the Bridge (`Bridge.depositTxMaxFee`).
    function validateSweepTxFee(uint256 sweepTxFee, uint256 depositsCount)
        internal
        view
    {
        require(sweepTxFee > 0, "Proposed transaction fee cannot be zero");

        // Compute the indivisible remainder that remains after dividing the
        // sweep transaction fee over all deposits evenly.
        uint256 depositTxFeeRemainder = sweepTxFee % depositsCount;
        // Compute the transaction fee per deposit by dividing the sweep
        // transaction fee (reduced by the remainder) by the number of deposits.
        uint256 depositTxFee = (sweepTxFee - depositTxFeeRemainder) /
            depositsCount;

        (, , uint64 depositTxMaxFee, ) = bridge.depositParameters();

        // The transaction fee is incurred by each deposit evenly except for the last
        // deposit that has the indivisible remainder additionally incurred.
        // See `DepositSweep.submitDepositSweepProof`.
        // We must make sure the highest value of the deposit transaction fee does
        // not exceed the maximum value limited by the governable parameter.
        require(
            depositTxFee + depositTxFeeRemainder <= depositTxMaxFee,
            "Proposed transaction fee is too high"
        );
    }

    /// @notice Validates the extra info for the given deposit. This function
    ///         is heavily based on `Deposit.revealDeposit` function.
    /// @param depositKey Key of the given deposit.
    /// @param depositor Depositor that revealed the deposit.
    /// @param extraData 32-byte deposit extra data. Optional, can be bytes32(0).
    /// @param depositExtraInfo Extra info being subject of the validation.
    /// @dev Requirements:
    ///      - The transaction hash computed using `depositExtraInfo.fundingTx`
    ///        must match the `depositKey.fundingTxHash`. This requirement
    ///        ensures the funding transaction data provided in the extra
    ///        data container actually represent the funding transaction of
    ///        the given deposit.
    ///      - The P2(W)SH script inferred from `depositExtraInfo` is actually
    ///        used to lock funds by the `depositKey.fundingOutputIndex` output
    ///        of the `depositExtraInfo.fundingTx` transaction. This requirement
    ///        ensures the reveal data provided in the extra info container
    ///        actually matches the given deposit.
    function validateDepositExtraInfo(
        DepositKey memory depositKey,
        address depositor,
        bytes32 extraData,
        DepositExtraInfo memory depositExtraInfo
    ) internal view {
        bytes32 depositExtraFundingTxHash = abi
            .encodePacked(
                depositExtraInfo.fundingTx.version,
                depositExtraInfo.fundingTx.inputVector,
                depositExtraInfo.fundingTx.outputVector,
                depositExtraInfo.fundingTx.locktime
            )
            .hash256View();

        // Make sure the funding tx provided as part of deposit extra info
        // actually matches the deposit referred by the given deposit key.
        if (depositKey.fundingTxHash != depositExtraFundingTxHash) {
            revert("Extra info funding tx hash does not match");
        }

        bytes memory expectedScript;

        if (extraData == bytes32(0)) {
            // Regular deposit without 32-byte extra data.
            expectedScript = abi.encodePacked(
                hex"14", // Byte length of depositor Ethereum address.
                depositor,
                hex"75", // OP_DROP
                hex"08", // Byte length of blinding factor value.
                depositExtraInfo.blindingFactor,
                hex"75", // OP_DROP
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // Byte length of a compressed Bitcoin public key hash.
                depositExtraInfo.walletPubKeyHash,
                hex"87", // OP_EQUAL
                hex"63", // OP_IF
                hex"ac", // OP_CHECKSIG
                hex"67", // OP_ELSE
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // Byte length of a compressed Bitcoin public key hash.
                depositExtraInfo.refundPubKeyHash,
                hex"88", // OP_EQUALVERIFY
                hex"04", // Byte length of refund locktime value.
                depositExtraInfo.refundLocktime,
                hex"b1", // OP_CHECKLOCKTIMEVERIFY
                hex"75", // OP_DROP
                hex"ac", // OP_CHECKSIG
                hex"68" // OP_ENDIF
            );
        } else {
            // Deposit with 32-byte extra data.
            expectedScript = abi.encodePacked(
                hex"14", // Byte length of depositor Ethereum address.
                depositor,
                hex"75", // OP_DROP
                hex"20", // Byte length of extra data.
                extraData,
                hex"75", // OP_DROP
                hex"08", // Byte length of blinding factor value.
                depositExtraInfo.blindingFactor,
                hex"75", // OP_DROP
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // Byte length of a compressed Bitcoin public key hash.
                depositExtraInfo.walletPubKeyHash,
                hex"87", // OP_EQUAL
                hex"63", // OP_IF
                hex"ac", // OP_CHECKSIG
                hex"67", // OP_ELSE
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // Byte length of a compressed Bitcoin public key hash.
                depositExtraInfo.refundPubKeyHash,
                hex"88", // OP_EQUALVERIFY
                hex"04", // Byte length of refund locktime value.
                depositExtraInfo.refundLocktime,
                hex"b1", // OP_CHECKLOCKTIMEVERIFY
                hex"75", // OP_DROP
                hex"ac", // OP_CHECKSIG
                hex"68" // OP_ENDIF
            );
        }

        bytes memory fundingOutput = depositExtraInfo
            .fundingTx
            .outputVector
            .extractOutputAtIndex(depositKey.fundingOutputIndex);
        bytes memory fundingOutputHash = fundingOutput.extractHash();

        // Path that checks the deposit extra info validity in case the
        // referred deposit is a P2SH.
        if (
            // slither-disable-next-line calls-loop
            fundingOutputHash.length == 20 &&
            fundingOutputHash.slice20(0) == expectedScript.hash160View()
        ) {
            return;
        }

        // Path that checks the deposit extra info validity in case the
        // referred deposit is a P2WSH.
        if (
            fundingOutputHash.length == 32 &&
            fundingOutputHash.toBytes32() == sha256(expectedScript)
        ) {
            return;
        }

        revert("Extra info funding output script does not match");
    }

    /// @notice View function encapsulating the main rules of a valid redemption
    ///         proposal. This function is meant to facilitate the off-chain
    ///         validation of the incoming proposals. Thanks to it, most
    ///         of the work can be done using a single readonly contract call.
    /// @param proposal The redemption proposal to validate.
    /// @return True if the proposal is valid. Reverts otherwise.
    /// @dev Requirements:
    ///      - The target wallet must be in the Live or MovingFunds state,
    ///      - The number of redemption requests included in the redemption
    ///        proposal must be in the range [1, `redemptionMaxSize`],
    ///      - The proposed redemption tx fee must be grater than zero,
    ///      - The proposed redemption tx fee must be lesser than or equal to
    ///        the maximum total fee allowed by the Bridge
    ///        (`Bridge.redemptionTxMaxTotalFee`),
    ///      - The proposed maximum per-request redemption tx fee share must be
    ///        lesser than or equal to the maximum fee share allowed by the
    ///        given request (`RedemptionRequest.txMaxFee`),
    ///      - Each request must be a pending request registered in the Bridge,
    ///      - Each request must be old enough, i.e. at least `REDEMPTION_REQUEST_MIN_AGE`
    ///        OR the delay enforced by the redemption watchtower
    ///        (if the watchtower is set and the returned delay is greater than `REDEMPTION_REQUEST_MIN_AGE`)
    ///        elapsed since their creation time,
    ///      - Each request must have the timeout safety margin preserved,
    ///      - Each request must be unique.
    function validateRedemptionProposal(RedemptionProposal calldata proposal)
        external
        view
        returns (bool)
    {
        Wallets.Wallet memory wallet = bridge.wallets(
            proposal.walletPubKeyHash
        );

        require(
            wallet.state == Wallets.WalletState.Live ||
                wallet.state == Wallets.WalletState.MovingFunds,
            "Wallet is not in Live or MovingFunds state"
        );

        uint256 requestsCount = proposal.redeemersOutputScripts.length;

        require(requestsCount > 0, "Redemption below the min size");

        require(
            requestsCount <= REDEMPTION_MAX_SIZE,
            "Redemption exceeds the max size"
        );

        (
            ,
            ,
            ,
            uint64 redemptionTxMaxTotalFee,
            uint32 redemptionTimeout,
            ,

        ) = bridge.redemptionParameters();

        require(
            proposal.redemptionTxFee > 0,
            "Proposed transaction fee cannot be zero"
        );

        // Make sure the proposed fee does not exceed the total fee limit.
        require(
            proposal.redemptionTxFee <= redemptionTxMaxTotalFee,
            "Proposed transaction fee is too high"
        );

        // Compute the indivisible remainder that remains after dividing the
        // redemption transaction fee over all requests evenly.
        uint256 redemptionTxFeeRemainder = proposal.redemptionTxFee %
            requestsCount;
        // Compute the transaction fee per request by dividing the redemption
        // transaction fee (reduced by the remainder) by the number of requests.
        uint256 redemptionTxFeePerRequest = (proposal.redemptionTxFee -
            redemptionTxFeeRemainder) / requestsCount;

        address redemptionWatchtower = bridge.getRedemptionWatchtower();

        uint256[] memory processedRedemptionKeys = new uint256[](requestsCount);

        for (uint256 i = 0; i < requestsCount; i++) {
            bytes memory script = proposal.redeemersOutputScripts[i];

            // As the wallet public key hash is part of the redemption key,
            // we have an implicit guarantee that all requests being part
            // of the proposal target the same wallet.
            uint256 redemptionKey = uint256(
                keccak256(
                    abi.encodePacked(
                        keccak256(script),
                        proposal.walletPubKeyHash
                    )
                )
            );

            // slither-disable-next-line calls-loop
            Redemption.RedemptionRequest memory redemptionRequest = bridge
                .pendingRedemptions(redemptionKey);

            require(
                redemptionRequest.requestedAt != 0,
                "Not a pending redemption request"
            );

            uint32 minAge = REDEMPTION_REQUEST_MIN_AGE;
            if (redemptionWatchtower != address(0)) {
                // Check the redemption delay enforced by the watchtower.
                // slither-disable-next-line calls-loop
                uint32 delay = IRedemptionWatchtower(redemptionWatchtower)
                    .getRedemptionDelay(redemptionKey);
                // If the delay is greater than the usual minimum age, use it.
                // This way both the min age and the watchtower delay are preserved.
                //
                // We do not need to bother about last-minute objections issued
                // by the watchtower. Objections can be issued up to one second
                // before the min age is achieved while this validation will
                // pass only one second after the min age is achieved. Even if
                // a single objection stays longer in the mempool, this won't
                // be a problem for `Bridge.submitRedemptionProof` which ignores
                // single objections as long as the veto threshold is not reached.
                if (delay > minAge) {
                    minAge = delay;
                }
            }

            require(
                /* solhint-disable-next-line not-rely-on-time */
                block.timestamp > redemptionRequest.requestedAt + minAge,
                "Redemption request min age not achieved yet"
            );

            // Calculate the timeout the given request times out at.
            uint32 requestTimeout = redemptionRequest.requestedAt +
                redemptionTimeout;
            // Make sure we are far enough from the moment the request times out.
            require(
                /* solhint-disable-next-line not-rely-on-time */
                block.timestamp <
                    requestTimeout - REDEMPTION_REQUEST_TIMEOUT_SAFETY_MARGIN,
                "Redemption request timeout safety margin is not preserved"
            );

            uint256 feePerRequest = redemptionTxFeePerRequest;
            // The last request incurs the fee remainder.
            if (i == requestsCount - 1) {
                feePerRequest += redemptionTxFeeRemainder;
            }
            // Make sure the redemption transaction fee share incurred by
            // the given request fits in the limit for that request.
            require(
                feePerRequest <= redemptionRequest.txMaxFee,
                "Proposed transaction per-request fee share is too high"
            );

            // Make sure there are no duplicates in the requests list.
            for (uint256 j = 0; j < i; j++) {
                require(
                    processedRedemptionKeys[j] != redemptionKey,
                    "Duplicated request"
                );
            }

            processedRedemptionKeys[i] = redemptionKey;
        }

        return true;
    }

    /// @notice View function encapsulating the main rules of a valid moving
    ///         funds proposal. This function is meant to facilitate the
    ///         off-chain validation of the incoming proposals. Thanks to it,
    ///         most of the work can be done using a single readonly contract
    ///         call.
    /// @param proposal The moving funds proposal to validate.
    /// @param walletMainUtxo The main UTXO of the source wallet.
    /// @return True if the proposal is valid. Reverts otherwise.
    /// @dev Notice that this function is meant to be invoked after the moving
    ///      funds commitment has already been submitted. This function skips
    ///      some checks related to the moving funds procedure as they were
    ///      already checked on the commitment submission.
    ///      Requirements:
    ///      - The source wallet must be in the MovingFunds state,
    ///      - The target wallets commitment must be submitted,
    ///      - The target wallets commitment hash must match the target wallets
    ///        from the proposal,
    ///      - The source wallet BTC balance must be equal to or greater than
    ///        `movingFundsDustThreshold`,
    ///      - The proposed moving funds transaction fee must be greater than
    ///        zero,
    ///      - The proposed moving funds transaction fee must not exceed the
    ///        maximum total fee allowed for moving funds.
    function validateMovingFundsProposal(
        MovingFundsProposal calldata proposal,
        BitcoinTx.UTXO calldata walletMainUtxo
    ) external view returns (bool) {
        Wallets.Wallet memory sourceWallet = bridge.wallets(
            proposal.walletPubKeyHash
        );

        // Make sure the source wallet is in MovingFunds state.
        require(
            sourceWallet.state == Wallets.WalletState.MovingFunds,
            "Source wallet is not in MovingFunds state"
        );

        // Make sure the moving funds commitment has been submitted and
        // the commitment hash matches the target wallets from the proposal.
        require(
            sourceWallet.movingFundsTargetWalletsCommitmentHash != bytes32(0),
            "Target wallets commitment is not submitted"
        );

        require(
            sourceWallet.movingFundsTargetWalletsCommitmentHash ==
                keccak256(abi.encodePacked(proposal.targetWallets)),
            "Target wallets do not match target wallets commitment hash"
        );

        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,

        ) = bridge.movingFundsParameters();

        // Make sure the source wallet balance is correct.
        uint64 sourceWalletBtcBalance = getWalletBtcBalance(
            sourceWallet.mainUtxoHash,
            walletMainUtxo
        );

        require(
            sourceWalletBtcBalance >= movingFundsDustThreshold,
            "Source wallet BTC balance is below the moving funds dust threshold"
        );

        // Make sure the proposed fee is valid.
        require(
            proposal.movingFundsTxFee > 0,
            "Proposed transaction fee cannot be zero"
        );

        require(
            proposal.movingFundsTxFee <= movingFundsTxMaxTotalFee,
            "Proposed transaction fee is too high"
        );

        return true;
    }

    /// @notice Calculates the Bitcoin balance of a wallet based on its main
    ///         UTXO.
    /// @param walletMainUtxoHash The hash of the wallet's main UTXO.
    /// @param walletMainUtxo The detailed data of the wallet's main UTXO.
    /// @return walletBtcBalance The calculated Bitcoin balance of the wallet.
    function getWalletBtcBalance(
        bytes32 walletMainUtxoHash,
        BitcoinTx.UTXO calldata walletMainUtxo
    ) internal view returns (uint64 walletBtcBalance) {
        // If the wallet has a main UTXO hash set, cross-check it with the
        // provided plain-text parameter and get the transaction output value
        // as BTC balance. Otherwise, the BTC balance is just zero.
        if (walletMainUtxoHash != bytes32(0)) {
            require(
                keccak256(
                    abi.encodePacked(
                        walletMainUtxo.txHash,
                        walletMainUtxo.txOutputIndex,
                        walletMainUtxo.txOutputValue
                    )
                ) == walletMainUtxoHash,
                "Invalid wallet main UTXO data"
            );

            walletBtcBalance = walletMainUtxo.txOutputValue;
        }

        return walletBtcBalance;
    }

    /// @notice View function encapsulating the main rules of a valid moved
    ///         funds sweep proposal. This function is meant to facilitate the
    ///         off-chain validation of the incoming proposals. Thanks to it,
    ///         most of the work can be done using a single readonly contract
    ///         call.
    /// @param proposal The moved funds sweep proposal to validate.
    /// @return True if the proposal is valid. Reverts otherwise.
    /// @dev Requirements:
    ///      - The source wallet must be in the Live or MovingFunds state,
    ///      - The moved funds sweep request identified by the proposed
    ///        transaction hash and output index must be in the Pending state,
    ///      - The transaction hash and output index from the proposal must
    ///        identify a moved funds sweep request in the Pending state,
    ///      - The transaction hash and output index from the proposal must
    ///        identify a moved funds sweep request that belongs to the wallet,
    ///      - The proposed moved funds sweep transaction fee must be greater
    ///        than zero,
    ///      - The proposed moved funds sweep transaction fee must not exceed
    ///        the maximum total fee allowed for moved funds sweep.
    function validateMovedFundsSweepProposal(
        MovedFundsSweepProposal calldata proposal
    ) external view returns (bool) {
        Wallets.Wallet memory wallet = bridge.wallets(
            proposal.walletPubKeyHash
        );

        // Make sure the wallet is in Live or MovingFunds state.
        require(
            wallet.state == Wallets.WalletState.Live ||
                wallet.state == Wallets.WalletState.MovingFunds,
            "Source wallet is not in Live or MovingFunds state"
        );

        // Make sure the moved funds sweep request is valid.
        uint256 sweepRequestKeyUint = uint256(
            keccak256(
                abi.encodePacked(
                    proposal.movingFundsTxHash,
                    proposal.movingFundsTxOutputIndex
                )
            )
        );

        MovingFunds.MovedFundsSweepRequest memory sweepRequest = bridge
            .movedFundsSweepRequests(sweepRequestKeyUint);

        require(
            sweepRequest.state ==
                MovingFunds.MovedFundsSweepRequestState.Pending,
            "Sweep request is not in Pending state"
        );

        require(
            sweepRequest.walletPubKeyHash == proposal.walletPubKeyHash,
            "Sweep request does not belong to the wallet"
        );

        // Make sure the proposed fee is valid.
        (, , , , , , , uint64 movedFundsSweepTxMaxTotalFee, , , ) = bridge
            .movingFundsParameters();

        require(
            proposal.movedFundsSweepTxFee > 0,
            "Proposed transaction fee cannot be zero"
        );

        require(
            proposal.movedFundsSweepTxFee <= movedFundsSweepTxMaxTotalFee,
            "Proposed transaction fee is too high"
        );

        return true;
    }

    /// @notice View function encapsulating the main rules of a valid heartbeat
    ///         proposal. This function is meant to facilitate the off-chain
    ///         validation of the incoming proposals. Thanks to it, most
    ///         of the work can be done using a single readonly contract call.
    /// @param proposal The heartbeat proposal to validate.
    /// @return True if the proposal is valid. Reverts otherwise.
    /// @dev Requirements:
    ///      - The message to sign is a valid heartbeat message.
    function validateHeartbeatProposal(HeartbeatProposal calldata proposal)
        external
        view
        returns (bool)
    {
        require(
            Heartbeat.isValidHeartbeatMessage(proposal.message),
            "Not a valid heartbeat message"
        );

        return true;
    }
}
