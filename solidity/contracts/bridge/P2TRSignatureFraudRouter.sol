// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./CheckBitcoinBIP341Sighash.sol";
import "./CheckBitcoinP2TRSignatureFraud.sol";
import "./Deposit.sol";
import "./Fraud.sol";
import "./MovingFunds.sol";
import "./P2TRSignatureFraud.sol";
import "./Wallets.sol";

/// @notice State the P2TR fraud router needs to read from Bridge while
///         processing P2TR signature-fraud lifecycle actions, plus the
///         one privileged callback used for slashing on timeout.
///
/// @dev This interface intentionally mirrors `IBridgeForFraud` declared
///      in `EcdsaFraudRouter.sol`, with a separate callback name
///      (`slashWalletForP2TRFraud`) so Bridge can gate the two paths
///      independently via separate modifiers.
interface IBridgeForP2TRFraud {
    function wallets(bytes20 walletPubKeyHash)
        external
        view
        returns (Wallets.Wallet memory);

    function walletPubKeyHashForWalletID(bytes32 walletId)
        external
        view
        returns (bytes20);

    function fraudParameters()
        external
        view
        returns (
            uint96 fraudChallengeDepositAmount,
            uint32 fraudChallengeDefeatTimeout,
            uint96 fraudSlashingAmount,
            uint32 fraudNotifierRewardMultiplier
        );

    function treasury() external view returns (address);

    function deposits(uint256 depositKey)
        external
        view
        returns (Deposit.DepositRequest memory);

    function spentMainUTXOs(uint256 utxoKey) external view returns (bool);

    function movedFundsSweepRequests(uint256 requestKey)
        external
        view
        returns (MovingFunds.MovedFundsSweepRequest memory);

    /// @notice Privileged callback the P2TR router invokes from the
    ///         timeout path. Bridge gates this with
    ///         `onlyP2TRFraudRouter`.
    function slashWalletForP2TRFraud(
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs,
        address challenger
    ) external;
}

/// @title P2TRSignatureFraudRouter
/// @notice Sister sidecar to `EcdsaFraudRouter`, dedicated to the P2TR
///         signature-fraud lifecycle (BIP-341/BIP-340 evidence). Holds
///         per-challenge state + ETH escrow + dispatches the
///         submit/defeat/timeout actions for the structured P2TR
///         payload format defined by `CheckBitcoinP2TRSignatureFraud`.
///
/// Why a separate sidecar
///
///     The BIP-341/BIP-340 helper machinery
///     (`CheckBitcoinP2TRSignatureFraud`, `P2TRSignatureFraud`,
///     `CheckBitcoinBIP341Sighash`) inlines ~14 KiB of code at every
///     callsite. Inlining it into `EcdsaFraudRouter` pushed that
///     router past EIP-170. Moving the P2TR lifecycle into its own
///     contract gives it a fresh 24 KiB budget and avoids the
///     external-linked-library ceremony we just escaped from on
///     Bridge.
///
///     The two routers are intentionally peers (not parent/child) --
///     they share no storage and they're set on Bridge independently
///     via separate one-time governance setters
///     (setEcdsaFraudRouter / setP2TRFraudRouter). Bridge gates the
///     two privileged callbacks (slashWalletForFraud /
///     slashWalletForP2TRFraud) with separate modifiers so a
///     compromise of one router cannot impersonate the other.
///
/// ETH escrow
///
///     The sidecar holds the ETH deposit for every new P2TR fraud
///     challenge submitted via `processP2TRSignatureFraudChallenge`
///     (action=Submit, payable). On defeat the deposit goes to
///     Bridge's treasury; on timeout it's refunded to the challenger.
///     Bridge never touches the ETH for any P2TR challenge opened
///     after the cutover.
contract P2TRSignatureFraudRouter {
    /// @notice Reference to the Bridge contract this router cooperates
    ///         with. Set at construction; immutable.
    address public immutable bridge;

    /// @notice Map of P2TR fraud challenge records owned by this
    ///         router. Keyed by the chain/contract-bound bridge
    ///         challenge key produced by
    ///         `P2TRSignatureFraud.computeBridgeChallengeKey`. Uses
    ///         the same `Fraud.FraudChallenge` struct shape as the
    ///         ECDSA router for storage-layout consistency and to
    ///         make any future cross-router migration straightforward.
    mapping(uint256 => Fraud.FraudChallenge) public fraudChallenges;

    enum P2TRFraudAction {
        Submit,
        Defeat,
        Timeout
    }

    struct ChallengeContext {
        bytes20 walletPubKeyHash;
        bytes32 bridgeChallengeIdentity;
        bytes32 sighash;
        uint256 challengeKey;
    }

    uint16 internal constant P2TRSignatureFraudMaxInputs = 2;
    uint16 internal constant P2TRSignatureFraudMaxOutputs = 2;
    uint16 internal constant P2TRSignatureFraudMaxScriptPubKeyBytes = 34;
    uint16 internal constant P2TRSignatureFraudMaxPayloadBytes = 4096;

    event P2TRSignatureFraudChallengeSubmitted(
        bytes32 indexed walletID,
        bytes20 indexed walletPubKeyHash,
        bytes32 indexed bridgeChallengeIdentity,
        uint256 challengeKey,
        bytes32 sighash
    );

    event P2TRSignatureFraudChallengeDefeated(
        bytes32 indexed walletID,
        bytes20 indexed walletPubKeyHash,
        bytes32 indexed bridgeChallengeIdentity,
        uint256 challengeKey,
        bytes32 sighash
    );

    event P2TRSignatureFraudChallengeDefeatTimedOut(
        bytes32 indexed walletID,
        bytes20 indexed walletPubKeyHash,
        bytes32 indexed bridgeChallengeIdentity,
        uint256 challengeKey,
        bytes32 sighash
    );

    /// @notice Emitted once for each legacy P2TR challenge that
    ///         governance migrates from Bridge to this router via
    ///         `acceptMigration`.
    event P2TRFraudChallengeMigratedFromBridge(
        uint256 indexed challengeKey,
        address indexed challenger,
        uint256 depositAmount
    );

    constructor(address _bridge) {
        require(_bridge != address(0), "Bridge address cannot be zero");
        bridge = _bridge;
    }

    /// @notice Accepts ETH + challenge records for legacy P2TR fraud
    ///         challenges migrated from Bridge.
    /// @dev Same contract as ECDSA router's `acceptMigration`. Called
    ///      exactly once via
    ///      `Bridge.migrateLegacyFraudChallenges(routerKind=1, keys)`
    ///      during the migration cutover. Governance is responsible
    ///      for classifying which legacy `fraudChallenges` keys
    ///      belong to the P2TR side (the original Bridge-side
    ///      mapping was shared between ECDSA and P2TR; the
    ///      challengeKey derivations don't collide but neither
    ///      tells you which lifecycle owns the key, so off-chain
    ///      classification is required).
    function acceptMigration(
        uint256[] calldata challengeKeys,
        Fraud.FraudChallenge[] calldata data
    ) external payable {
        require(msg.sender == bridge, "Caller is not Bridge");
        require(challengeKeys.length == data.length, "Length mismatch");

        uint256 totalDeposit;
        for (uint256 i = 0; i < challengeKeys.length; i++) {
            require(
                fraudChallenges[challengeKeys[i]].reportedAt == 0,
                "Challenge already migrated"
            );
            fraudChallenges[challengeKeys[i]] = data[i];
            totalDeposit += data[i].depositAmount;
            emit P2TRFraudChallengeMigratedFromBridge(
                challengeKeys[i],
                data[i].challenger,
                data[i].depositAmount
            );
        }
        require(msg.value == totalDeposit, "msg.value != total deposit");
    }

    /// @notice Processes a P2TR signature-fraud challenge lifecycle
    ///         action.
    /// @param action 0=Submit, 1=Defeat, 2=Timeout.
    /// @param payload ABI-encoded
    ///        `CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload`.
    /// @param walletMembersIDs Operators of the wallet's signing
    ///        group. Used only by the timeout action.
    function processP2TRSignatureFraudChallenge(
        uint8 action,
        bytes calldata payload,
        uint32[] calldata walletMembersIDs
    ) external payable {
        require(
            payload.length <= P2TRSignatureFraudMaxPayloadBytes,
            "P2TR payload too large"
        );

        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            memory decodedPayload = abi.decode(
                payload,
                (CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload)
            );

        if (action == uint8(P2TRFraudAction.Submit)) {
            _submit(decodedPayload);
        } else if (action == uint8(P2TRFraudAction.Defeat)) {
            require(msg.value == 0, "ETH not required");
            _defeat(decodedPayload);
        } else if (action == uint8(P2TRFraudAction.Timeout)) {
            require(msg.value == 0, "ETH not required");
            _notifyTimeout(decodedPayload, walletMembersIDs);
        } else {
            revert("Unknown P2TR fraud action");
        }
    }

    function _submit(
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            memory payload
    ) internal {
        IBridgeForP2TRFraud b = IBridgeForP2TRFraud(bridge);

        (uint96 depositAmount, , , ) = b.fraudParameters();
        require(
            msg.value >= depositAmount,
            "The amount of ETH deposited is too low"
        );

        _validatePayloadShape(payload);

        bytes20 walletPubKeyHash = _resolveChallengeableWallet(
            b,
            payload.walletID
        );

        ChallengeContext memory context = _computeChallengeContext(
            walletPubKeyHash,
            payload
        );

        Fraud.FraudChallenge storage challenge = fraudChallenges[
            context.challengeKey
        ];
        require(challenge.reportedAt == 0, "Fraud challenge already exists");

        require(
            CheckBitcoinP2TRSignatureFraud.checkSignature(
                payload.walletID,
                context.sighash,
                payload.witnessSignature
            ),
            "Signature verification failure"
        );

        challenge.challenger = msg.sender;
        challenge.depositAmount = msg.value;
        /* solhint-disable-next-line not-rely-on-time */
        challenge.reportedAt = uint32(block.timestamp);
        challenge.resolved = false;

        emit P2TRSignatureFraudChallengeSubmitted(
            payload.walletID,
            context.walletPubKeyHash,
            context.bridgeChallengeIdentity,
            context.challengeKey,
            context.sighash
        );
    }

    function _defeat(
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            memory payload
    ) internal {
        IBridgeForP2TRFraud b = IBridgeForP2TRFraud(bridge);

        _validatePayloadShape(payload);

        ChallengeContext memory context = _computeChallengeContext(
            _resolveWalletPubKeyHash(b, payload.walletID),
            payload
        );

        Fraud.FraudChallenge storage challenge = _unresolvedChallenge(
            context.challengeKey
        );

        require(
            _isHonestlySpent(b, _signedInputUtxoKey(payload)),
            "Spent UTXO not found among correctly spent UTXOs"
        );

        challenge.resolved = true;

        address treasury = b.treasury();
        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line low-level-calls,unchecked-lowlevel,arbitrary-send
        treasury.call{gas: 100000, value: challenge.depositAmount}("");
        /* solhint-enable avoid-low-level-calls */

        emit P2TRSignatureFraudChallengeDefeated(
            payload.walletID,
            context.walletPubKeyHash,
            context.bridgeChallengeIdentity,
            context.challengeKey,
            context.sighash
        );
    }

    function _notifyTimeout(
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            memory payload,
        uint32[] calldata walletMembersIDs
    ) internal {
        IBridgeForP2TRFraud b = IBridgeForP2TRFraud(bridge);

        _validatePayloadShape(payload);

        ChallengeContext memory context = _computeChallengeContext(
            _resolveWalletPubKeyHash(b, payload.walletID),
            payload
        );

        Fraud.FraudChallenge storage challenge = _unresolvedChallenge(
            context.challengeKey
        );

        (, uint32 defeatTimeout, , ) = b.fraudParameters();
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= challenge.reportedAt + defeatTimeout,
            "Fraud challenge defeat period did not time out yet"
        );

        challenge.resolved = true;

        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line low-level-calls,unchecked-lowlevel
        challenge.challenger.call{gas: 100000, value: challenge.depositAmount}(
            ""
        );
        /* solhint-enable avoid-low-level-calls */

        b.slashWalletForP2TRFraud(
            context.walletPubKeyHash,
            walletMembersIDs,
            challenge.challenger
        );

        emit P2TRSignatureFraudChallengeDefeatTimedOut(
            payload.walletID,
            context.walletPubKeyHash,
            context.bridgeChallengeIdentity,
            context.challengeKey,
            context.sighash
        );
    }

    function _resolveChallengeableWallet(
        IBridgeForP2TRFraud b,
        bytes32 walletId
    ) internal view returns (bytes20 walletPubKeyHash) {
        walletPubKeyHash = _resolveWalletPubKeyHash(b, walletId);

        Wallets.Wallet memory wallet = b.wallets(walletPubKeyHash);
        require(
            wallet.state == Wallets.WalletState.Live ||
                wallet.state == Wallets.WalletState.MovingFunds ||
                wallet.state == Wallets.WalletState.Closing,
            "Wallet must be in Live or MovingFunds or Closing state"
        );
    }

    function _resolveWalletPubKeyHash(IBridgeForP2TRFraud b, bytes32 walletId)
        internal
        view
        returns (bytes20 walletPubKeyHash)
    {
        walletPubKeyHash = b.walletPubKeyHashForWalletID(walletId);
        require(walletPubKeyHash != bytes20(0), "Wallet ID is unknown");
    }

    function _computeChallengeContext(
        bytes20 walletPubKeyHash,
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            memory payload
    ) internal view returns (ChallengeContext memory context) {
        (
            context.bridgeChallengeIdentity,
            context.sighash
        ) = _computeBridgeChallengeIdentity(payload);
        context.walletPubKeyHash = walletPubKeyHash;
        // The challenge key is bound to Bridge's address, not this
        // router's, so legacy keys created via the old Bridge entry
        // point match this router's view of the key after migration.
        context.challengeKey = P2TRSignatureFraud.computeBridgeChallengeKey(
            block.chainid,
            bridge,
            context.bridgeChallengeIdentity
        );
    }

    function _unresolvedChallenge(uint256 challengeKey)
        internal
        view
        returns (Fraud.FraudChallenge storage challenge)
    {
        challenge = fraudChallenges[challengeKey];

        require(challenge.reportedAt > 0, "Fraud challenge does not exist");
        require(
            !challenge.resolved,
            "Fraud challenge has already been resolved"
        );
    }

    function _isHonestlySpent(IBridgeForP2TRFraud b, uint256 utxoKey)
        internal
        view
        returns (bool)
    {
        return
            b.deposits(utxoKey).sweptAt > 0 ||
            b.spentMainUTXOs(utxoKey) ||
            b.movedFundsSweepRequests(utxoKey).state ==
            MovingFunds.MovedFundsSweepRequestState.Processed;
    }

    function _payloadBounds()
        internal
        pure
        returns (CheckBitcoinP2TRSignatureFraud.PayloadBounds memory)
    {
        return
            CheckBitcoinP2TRSignatureFraud.PayloadBounds(
                P2TRSignatureFraudMaxInputs,
                P2TRSignatureFraudMaxOutputs,
                P2TRSignatureFraudMaxScriptPubKeyBytes
            );
    }

    function _validatePayloadShape(
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            memory payload
    ) internal pure {
        CheckBitcoinP2TRSignatureFraud.validatePayloadShape(
            payload,
            _payloadBounds()
        );
    }

    function _computeBridgeChallengeIdentity(
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            memory payload
    ) internal pure returns (bytes32 bridgeChallengeIdentity, bytes32 sighash) {
        (bytes memory signature, uint8 sighashType) = P2TRSignatureFraud
            .parseWitnessSignature(payload.witnessSignature);
        bytes memory transactionPayload = CheckBitcoinP2TRSignatureFraud
            .encodeBridgeChallengeTransactionPayload(payload);
        sighash = CheckBitcoinP2TRSignatureFraud
            .computeBridgeChallengeIdentitySighash(payload);
        bridgeChallengeIdentity = CheckBitcoinP2TRSignatureFraud
            .computeBridgeChallengeIdentityForPayload(
                payload.walletID,
                sighash,
                signature,
                sighashType,
                transactionPayload
            );
    }

    function _signedInputUtxoKey(
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            memory payload
    ) internal pure returns (uint256) {
        CheckBitcoinBIP341Sighash.TransactionInput memory signedInput = payload
            .inputs[payload.signedInputIndex];

        return
            uint256(
                keccak256(abi.encodePacked(signedInput.txid, signedInput.vout))
            );
    }
}
