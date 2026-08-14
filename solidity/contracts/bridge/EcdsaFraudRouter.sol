// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "@keep-network/bitcoin-spv-sol/contracts/CheckBitcoinSigs.sol";

import "./BitcoinTx.sol";
import "./IBridgeFraudViews.sol";
import "./Deposit.sol";
import "./EcdsaLib.sol";
import "./EcdsaFraudRouterProtocol.sol";
import "./Fraud.sol";
import "./Heartbeat.sol";
import "./MovingFunds.sol";
import "./Wallets.sol";

/// @notice Read-only views plus the scheme-specific extras that the
///         ECDSA fraud router needs from Bridge while processing
///         fraud lifecycle actions. The shared read-only getters used
///         by both fraud router sidecars are declared on
///         `IBridgeFraudViews`; this interface extends that with the
///         scheme-specific views and the privileged slash callback.
interface IBridgeForFraud is IBridgeFraudViews {
    function ecdsaFraudRouter() external view returns (address);

    function activeWalletPubKeyHash() external view returns (bytes20);

    function activeWalletID() external view returns (bytes32);

    function walletID(bytes20 walletPubKeyHash) external view returns (bytes32);

    /// @dev Returns the full `Deposit.DepositRequest` struct. Bridge
    ///      exposes a struct-returning view (not a Solidity-generated
    ///      tuple getter), so the interface must mirror that shape
    ///      exactly -- omitting fields would shift positions and
    ///      silently decode the wrong slot.
    function deposits(uint256 depositKey)
        external
        view
        returns (Deposit.DepositRequest memory);

    function spentMainUTXOs(uint256 utxoKey) external view returns (bool);

    /// @dev Returns the full `MovingFunds.MovedFundsSweepRequest`
    ///      struct, for the same reason as `deposits` above.
    function movedFundsSweepRequests(uint256 requestKey)
        external
        view
        returns (MovingFunds.MovedFundsSweepRequest memory);

    /// @notice Privileged callback the router invokes from the timeout
    ///         path. Bridge gates this with `onlyEcdsaFraudRouter`.
    function slashWalletForFraud(
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs,
        address challenger
    ) external;
}

/// @title EcdsaFraudRouter
/// @notice Sidecar contract that owns the ECDSA fraud challenge surface
///         previously hosted on Bridge.sol. Holds challenge state, escrows
///         the ETH challenge deposits, dispatches BIP-143 sighash
///         reconstruction + ecrecover verification, and calls back into
///         Bridge for the one privileged side-effect: terminating the
///         wallet + seizing operator stake when a fraud challenge times
///         out without defeat.
///
/// Why this exists
///
///     Bridge.sol was hitting the EIP-170 24 KiB deploy limit. Phase A
///     (scheme-aware lifecycle routing) added another ~430 bytes,
///     pushing Bridge to 24.259 KiB. Both Codex and Gemini recommended
///     extracting the legacy ECDSA fraud surface into a sidecar as the
///     restructuring that makes the most strategic sense: (1) it
///     genuinely belongs in a deprecation-aligned sidecar as the
///     protocol migrates to FROST/Schnorr; (2) the entry-point bodies
///     are heavy with BIP-143 parsing and ecrecover math; (3) the
///     fraud state has its own ETH escrow already, which can move
///     wholesale to the sidecar without splitting accounting.
///
/// ETH escrow
///
///     The sidecar holds the ETH deposit for every new fraud challenge
///     (submitFraudChallenge is `payable` here, not on Bridge). On
///     defeat, the sidecar transfers the deposit to the treasury
///     directly. On timeout, the sidecar refunds the challenger
///     directly. Bridge never touches the ETH for any fraud challenge
///     opened after the cutover.
///
///     Existing mainnet fraud challenges that were opened against
///     Bridge before this extraction still have their ETH held on
///     Bridge. Bridge exposes a one-time governance migration helper
///     (migrateFraudChallengesToRouter) that transfers the escrowed
///     ETH for selected legacy challenges and seeds the corresponding
///     records into this sidecar via acceptMigration. Operationally,
///     governance is expected to drain or resolve as many active
///     challenges as possible before the upgrade and then run the
///     migration helper once for any residual entries.
///
/// Bridge integration
///
///     The router reads wallet state from Bridge via the IBridgeForFraud
///     view surface (registered wallet lookup, fraud parameters,
///     treasury address, deposit / spentMainUTXO / movedFundsSweep
///     state). For the one side-effect Bridge must perform on behalf of
///     the router (terminate wallet + seize stake on timeout), the
///     router calls `Bridge.slashWalletForFraud(walletPubKeyHash,
///     walletMembersIDs, challenger)`, gated by Bridge's
///     `onlyEcdsaFraudRouter` modifier.
///
/// Lifecycle and replacement
///
///     The router is stateful (it holds fraudChallenges + ETH) and
///     therefore cannot simply be redeployed. To replace it, a new
///     router would need a one-time governance migration to receive
///     the current router's state. This is the same pattern as any
///     contract with non-trivial state and is intentionally heavier
///     than a stateless dispatcher -- the trade buys the bytecode
///     savings on Bridge.
contract EcdsaFraudRouter {
    using BytesLib for bytes;
    using BTCUtils for bytes;
    using EcdsaLib for bytes;

    /// @notice Reference to the Bridge contract this router cooperates
    ///         with. Set at construction; immutable.
    address public immutable bridge;

    /// @notice Previous authoritative router whose permanent challenge-key
    ///         tombstones this generation inherits. Every replacement points
    ///         to the router it supersedes, forming an immutable ancestry chain.
    ///         Fresh deployments use address(0).
    address public immutable predecessor;

    /// @notice Runtime bytecode hash of `predecessor`, captured before this
    ///         router is deployed. Every inherited lookup verifies this pin so
    ///         a predecessor cannot disappear or change code without making
    ///         the ancestry fail closed. Fresh deployments use bytes32(0).
    bytes32 public immutable predecessorCodeHash;

    /// @notice Number of inherited router generations. It is fixed at deploy
    ///         time and capped so permanent identity lookup has a hard gas
    ///         bound. A first-generation router has depth zero; a router over a
    ///         terminal legacy predecessor has depth one.
    uint8 public immutable ancestryDepth;

    /// @notice Map of fraud challenge records owned by this router.
    ///         Keyed by `keccak256(walletPublicKey | sighash)`. The
    ///         struct is the same `Fraud.FraudChallenge` retained on
    ///         Bridge for the legacy mapping, so the migration helper
    ///         can hand records over without per-field conversion.
    mapping(uint256 => Fraud.FraudChallenge) public fraudChallenges;

    /// @notice Number of unresolved ECDSA fraud challenges currently
    ///         held by this router. Intended for D-2.2 drain runbooks:
    ///         before removing Bridge's ECDSA fraud timeout callback,
    ///         governance can assert this value is zero on-chain.
    uint256 public openFraudChallengeCount;

    /// @notice Number of unresolved, directly submitted challenges for each
    ///         wallet. This is the per-wallet graceful-closure lock.
    mapping(bytes20 => uint256) public openFraudChallengeCountByWallet;

    /// @notice Number of unresolved migrated challenges whose legacy records
    ///         do not carry a wallet identity. While non-zero, graceful
    ///         closure is conservatively locked for every ECDSA wallet.
    uint256 public unattributedOpenFraudChallengeCount;

    /// @notice Exact ETH liability of all unresolved challenges. Unlike the
    ///         raw contract balance, this cannot be distorted by forced ETH and
    ///         therefore provides deterministic post-migration reconciliation.
    uint256 public openFraudChallengeEscrow;

    /// @notice Activation epoch for challenges migrated while this router was
    ///         inactive during a delayed cutover. Timeout accounting starts no
    ///         earlier than this epoch, giving the wallet a full defense window
    ///         after defeat entry points become reachable.
    uint64 public migratedChallengesActivatedAt;

    /// @notice Per-key defense epoch for legacy challenges migrated directly
    ///         into an already-active router outside the delayed cutover.
    mapping(uint256 => uint64) public migrationDefenseStartedAtByChallenge;

    /// @dev Wallet identity for directly submitted challenges. A zero value
    ///      marks an unattributed challenge migrated from Bridge storage.
    mapping(uint256 => bytes20) internal fraudChallengeWalletPubKeyHash;

    error EcdsaFraudRouterNotActive();
    error EcdsaFraudRouterPredecessorUnavailable(address predecessorRouter);
    error EcdsaFraudRouterMigratedChallengeInactive(uint256 challengeKey);

    event FraudChallengeSubmitted(
        bytes20 indexed walletPubKeyHash,
        bytes32 sighash,
        uint8 v,
        bytes32 r,
        bytes32 s
    );

    event FraudChallengeDefeated(
        bytes20 indexed walletPubKeyHash,
        bytes32 sighash
    );

    event FraudChallengeDefeatTimedOut(
        bytes20 indexed walletPubKeyHash,
        bytes32 sighash
    );

    /// @notice Emitted once for each legacy challenge that governance
    ///         migrates from Bridge to this router via
    ///         `acceptMigration`.
    event FraudChallengeMigratedFromBridge(
        uint256 indexed challengeKey,
        address indexed challenger,
        uint256 depositAmount
    );

    event MigratedFraudChallengesActivated(uint64 activatedAt);

    /// @notice Constructor. Captures the Bridge address for the
    ///         router's lifetime.
    /// @param _bridge Address of the Bridge contract this router cooperates with.
    /// @param _predecessor Previous authoritative router, or address(0) for the
    ///        first current-generation router on a fresh Bridge.
    constructor(address _bridge, address _predecessor) {
        require(_bridge != address(0), "Bridge address cannot be zero");
        require(
            _predecessor != address(this),
            "Predecessor cannot be this router"
        );
        bridge = _bridge;
        predecessor = _predecessor;

        uint8 inheritedDepth;
        bytes32 inheritedPredecessorCodeHash;
        if (_predecessor != address(0)) {
            require(
                _predecessor.code.length != 0,
                "Predecessor code unavailable"
            );
            (bool bridgeCallSucceeded, bytes memory bridgeResult) = _predecessor
                .staticcall(
                    abi.encodeWithSelector(
                        IEcdsaFraudRouterProtocol.bridge.selector
                    )
                );
            require(
                bridgeCallSucceeded &&
                    bridgeResult.length == 32 &&
                    abi.decode(bridgeResult, (address)) == _bridge,
                "Predecessor Bridge mismatch"
            );

            (
                bool protocolCallSucceeded,
                bytes memory protocolResult
            ) = _predecessor.staticcall(
                    abi.encodeWithSelector(
                        IEcdsaFraudRouterProtocol.fraudProtocolID.selector
                    )
                );
            require(
                protocolCallSucceeded && protocolResult.length == 32,
                "Predecessor protocol unavailable"
            );
            bytes32 predecessorProtocol = abi.decode(protocolResult, (bytes32));

            (bool depthCallSucceeded, bytes memory depthResult) = _predecessor
                .staticcall(
                    abi.encodeWithSelector(
                        IEcdsaFraudRouterProtocol.ancestryDepth.selector
                    )
                );
            if (depthCallSucceeded) {
                require(
                    depthResult.length == 32,
                    "Malformed predecessor depth"
                );
                require(
                    predecessorProtocol == EcdsaFraudRouterProtocol.CURRENT_V3,
                    "Unsupported predecessor protocol"
                );
                uint256 predecessorDepth = abi.decode(depthResult, (uint256));
                require(
                    predecessorDepth <
                        EcdsaFraudRouterProtocol.MAX_ANCESTRY_DEPTH,
                    "Router ancestry limit reached"
                );
                inheritedDepth = uint8(predecessorDepth + 1);
            } else {
                // The deployed pre-v3 router has no depth selector. It is
                // accepted only as a terminal root with the public challenge
                // mapping required by the compatibility lookup below.
                require(
                    depthResult.length == 0,
                    "Predecessor depth unavailable"
                );
                require(
                    predecessorProtocol == EcdsaFraudRouterProtocol.CURRENT_V2,
                    "Unsupported legacy predecessor protocol"
                );
                (
                    bool legacyCallSucceeded,
                    bytes memory legacyResult
                ) = _predecessor.staticcall(
                        abi.encodeWithSignature("fraudChallenges(uint256)", 0)
                    );
                require(
                    legacyCallSucceeded && legacyResult.length == 128,
                    "Legacy predecessor incompatible"
                );
                inheritedDepth = 1;
            }
            inheritedPredecessorCodeHash = _predecessor.codehash;
        }
        ancestryDepth = inheritedDepth;
        predecessorCodeHash = inheritedPredecessorCodeHash;
    }

    /// @notice Identifies the current, closure-safe ECDSA fraud lifecycle.
    /// @dev Governance checks this exact value together with `bridge()` and an
    ///      empty challenge count before the router can become authoritative.
    function fraudProtocolID() external pure returns (bytes32) {
        return EcdsaFraudRouterProtocol.CURRENT_V3;
    }

    /// @notice Returns true when this router or any immutable predecessor has
    ///         ever accepted the challenge identity, regardless of resolution.
    /// @dev The first predecessor may be the deployed v2 router, which predates
    ///      this selector. In that one compatibility case we read its public
    ///      `fraudChallenges` mapping directly. A v3 predecessor that reverts is
    ///      never treated as an empty legacy router; ancestry failure is
    ///      fail-closed so an unavailable ancestor cannot reopen old evidence.
    function challengeIdentityExists(uint256 challengeKey)
        public
        view
        returns (bool)
    {
        if (fraudChallenges[challengeKey].reportedAt != 0) {
            return true;
        }

        address predecessorRouter = predecessor;
        if (predecessorRouter == address(0)) {
            return false;
        }

        if (
            predecessorCodeHash == bytes32(0) ||
            predecessorRouter.codehash != predecessorCodeHash
        ) {
            revert EcdsaFraudRouterPredecessorUnavailable(predecessorRouter);
        }

        bytes32 predecessorProtocol = _readPredecessorProtocol(
            predecessorRouter
        );
        (bool depthCallSucceeded, bytes memory depthResult) = predecessorRouter
            .staticcall(
                abi.encodeWithSelector(
                    IEcdsaFraudRouterProtocol.ancestryDepth.selector
                )
            );
        if (depthCallSucceeded) {
            uint256 predecessorDepth;
            if (depthResult.length == 32) {
                predecessorDepth = abi.decode(depthResult, (uint256));
            }
            if (
                depthResult.length != 32 ||
                predecessorProtocol != EcdsaFraudRouterProtocol.CURRENT_V3 ||
                uint256(ancestryDepth) == 0 ||
                predecessorDepth >=
                EcdsaFraudRouterProtocol.MAX_ANCESTRY_DEPTH ||
                predecessorDepth != uint256(ancestryDepth) - 1
            ) {
                revert EcdsaFraudRouterPredecessorUnavailable(
                    predecessorRouter
                );
            }

            (
                bool identityCallSucceeded,
                bytes memory identityResult
            ) = predecessorRouter.staticcall(
                    abi.encodeWithSignature(
                        "challengeIdentityExists(uint256)",
                        challengeKey
                    )
                );
            if (!identityCallSucceeded || identityResult.length != 32) {
                revert EcdsaFraudRouterPredecessorUnavailable(
                    predecessorRouter
                );
            }
            uint256 encodedIdentity = abi.decode(identityResult, (uint256));
            if (encodedIdentity > 1) {
                revert EcdsaFraudRouterPredecessorUnavailable(
                    predecessorRouter
                );
            }
            return encodedIdentity == 1;
        }
        if (
            depthResult.length != 0 ||
            ancestryDepth != 1 ||
            predecessorProtocol != EcdsaFraudRouterProtocol.CURRENT_V2
        ) {
            revert EcdsaFraudRouterPredecessorUnavailable(predecessorRouter);
        }

        (
            bool legacyCallSucceeded,
            bytes memory legacyResult
        ) = predecessorRouter.staticcall(
                abi.encodeWithSignature(
                    "fraudChallenges(uint256)",
                    challengeKey
                )
            );
        if (!legacyCallSucceeded || legacyResult.length != 128) {
            revert EcdsaFraudRouterPredecessorUnavailable(predecessorRouter);
        }
        (, , uint32 reportedAt, ) = abi.decode(
            legacyResult,
            (address, uint256, uint32, bool)
        );
        return reportedAt != 0;
    }

    /// @notice Accepts ETH for an existing fraud challenge migrated
    ///         from Bridge. Called once at the migration cutover by
    ///         governance from
    ///         `Bridge.migrateLegacyFraudChallenges(routerKind=0, keys)`.
    ///         The Bridge-side helper transfers the aggregate
    ///         escrowed ETH; this function accepts it and seeds the
    ///         per-challenge records.
    /// @param challengeKeys Identifiers of the migrated challenges.
    /// @param data Migrated challenge state in the same order as
    ///        `challengeKeys`.
    /// @dev Requirements:
    ///      - Caller must be the Bridge contract.
    ///      - msg.value must equal the sum of `data[i].depositAmount`.
    ///      - Each `challengeKey` must not already exist in this
    ///        router's `fraudChallenges` mapping.
    function acceptMigration(
        uint256[] calldata challengeKeys,
        Fraud.FraudChallenge[] calldata data
    ) external payable {
        require(msg.sender == bridge, "Caller is not Bridge");
        require(challengeKeys.length == data.length, "Length mismatch");

        uint64 activeMigrationDefenseStartedAt;
        (bool routerCallSucceeded, bytes memory routerResult) = bridge
            .staticcall(
                abi.encodeWithSelector(
                    IBridgeForFraud.ecdsaFraudRouter.selector
                )
            );
        if (
            routerCallSucceeded &&
            routerResult.length == 32 &&
            abi.decode(routerResult, (address)) == address(this)
        ) {
            /* solhint-disable-next-line not-rely-on-time */
            activeMigrationDefenseStartedAt = uint64(block.timestamp);
        }

        uint256 totalDeposit;
        for (uint256 i = 0; i < challengeKeys.length; i++) {
            require(
                !challengeIdentityExists(challengeKeys[i]),
                "Challenge already migrated"
            );
            require(data[i].reportedAt > 0, "Challenge not reported");
            require(!data[i].resolved, "Challenge already resolved");
            fraudChallenges[challengeKeys[i]] = data[i];
            migrationDefenseStartedAtByChallenge[
                challengeKeys[i]
            ] = activeMigrationDefenseStartedAt;
            openFraudChallengeCount++;
            unattributedOpenFraudChallengeCount++;
            totalDeposit += data[i].depositAmount;
            emit FraudChallengeMigratedFromBridge(
                challengeKeys[i],
                data[i].challenger,
                data[i].depositAmount
            );
        }
        require(msg.value == totalDeposit, "msg.value != total deposit");
        openFraudChallengeEscrow += totalDeposit;
    }

    /// @notice Starts the defense window for challenges migrated into this
    ///         router while it was inactive. Called atomically by Bridge when
    ///         the delayed replacement becomes authoritative.
    function activateMigratedChallenges() external {
        require(msg.sender == bridge, "Caller is not Bridge");
        require(
            migratedChallengesActivatedAt == 0,
            "Migrated challenges already activated"
        );
        require(
            openFraudChallengeCount == unattributedOpenFraudChallengeCount,
            "Unexpected direct challenge state"
        );
        /* solhint-disable-next-line not-rely-on-time */
        migratedChallengesActivatedAt = uint64(block.timestamp);
        emit MigratedFraudChallengesActivated(migratedChallengesActivatedAt);
    }

    /// @notice Returns the effective timeout epoch for a local challenge.
    ///         Migrated challenges fail closed until Bridge activates them.
    function fraudChallengeDefeatTimeoutStartedAt(uint256 challengeKey)
        public
        view
        returns (uint256 startedAt)
    {
        startedAt = fraudChallenges[challengeKey].reportedAt;
        if (
            startedAt == 0 ||
            fraudChallengeWalletPubKeyHash[challengeKey] != bytes20(0)
        ) {
            return startedAt;
        }

        uint256 migrationStartedAt = migrationDefenseStartedAtByChallenge[
            challengeKey
        ];
        if (migrationStartedAt == 0) {
            migrationStartedAt = migratedChallengesActivatedAt;
        }
        if (migrationStartedAt == 0) {
            revert EcdsaFraudRouterMigratedChallengeInactive(challengeKey);
        }
        if (migrationStartedAt > startedAt) {
            startedAt = migrationStartedAt;
        }
    }

    function _readPredecessorProtocol(address predecessorRouter)
        private
        view
        returns (bytes32 protocolID)
    {
        (bool succeeded, bytes memory returnData) = predecessorRouter
            .staticcall(
                abi.encodeWithSelector(
                    IEcdsaFraudRouterProtocol.fraudProtocolID.selector
                )
            );
        if (!succeeded || returnData.length != 32) {
            revert EcdsaFraudRouterPredecessorUnavailable(predecessorRouter);
        }
        protocolID = abi.decode(returnData, (bytes32));
    }

    /// @notice Submits an ECDSA fraud challenge against a wallet.
    ///         Caller must send the configured fraud challenge deposit
    ///         as msg.value.
    /// @dev See the pre-extraction Bridge.submitFraudChallenge entry
    ///      point for the full requirement list. This entry point
    ///      preserves identical semantics; the difference is that ETH
    ///      escrow + record storage live on this router instead of
    ///      Bridge.
    function submitFraudChallenge(
        bytes calldata walletPublicKey,
        bytes memory preimageSha256,
        BitcoinTx.RSVSignature calldata signature
    ) external payable {
        IBridgeForFraud b = IBridgeForFraud(bridge);

        _requireActive();

        (uint96 depositAmount, , , ) = b.fraudParameters();
        require(
            msg.value >= depositAmount,
            "The amount of ETH deposited is too low"
        );

        // sighash MUST be derived inside this function (not passed in)
        // to prevent forged signatures from triggering a wrongful
        // fraud accusation.
        bytes32 sighash = sha256(preimageSha256);

        require(
            CheckBitcoinSigs.checkSig(
                walletPublicKey,
                sighash,
                signature.v,
                signature.r,
                signature.s
            ),
            "Signature verification failure"
        );

        bytes memory compressedWalletPublicKey = EcdsaLib.compressPublicKey(
            walletPublicKey.slice32(0),
            walletPublicKey.slice32(32)
        );
        bytes20 walletPubKeyHash = compressedWalletPublicKey.hash160View();
        Wallets.Wallet memory wallet = b.wallets(walletPubKeyHash);
        require(
            wallet.ecdsaWalletID != bytes32(0),
            "Legacy ECDSA wallet required"
        );
        require(
            wallet.state == Wallets.WalletState.Live ||
                wallet.state == Wallets.WalletState.MovingFunds ||
                wallet.state == Wallets.WalletState.Closing,
            "Wallet must be in Live or MovingFunds or Closing state"
        );

        uint256 challengeKey = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sighash))
        );

        require(
            !challengeIdentityExists(challengeKey),
            "Fraud challenge already exists"
        );
        require(
            !b.legacyFraudChallengeExists(challengeKey),
            "Legacy fraud challenge exists"
        );

        Fraud.FraudChallenge storage challenge = fraudChallenges[challengeKey];
        challenge.challenger = msg.sender;
        challenge.depositAmount = msg.value;
        /* solhint-disable-next-line not-rely-on-time */
        challenge.reportedAt = uint32(block.timestamp);
        challenge.resolved = false;
        fraudChallengeWalletPubKeyHash[challengeKey] = walletPubKeyHash;
        openFraudChallengeCount++;
        openFraudChallengeCountByWallet[walletPubKeyHash]++;
        openFraudChallengeEscrow += msg.value;

        // slither-disable-next-line reentrancy-events
        emit FraudChallengeSubmitted(
            walletPubKeyHash,
            sighash,
            signature.v,
            signature.r,
            signature.s
        );
    }

    /// @notice Defeats a pending ECDSA fraud challenge by providing the
    ///         preimage that produces the same sighash. On defeat the
    ///         escrowed deposit is forwarded to Bridge's treasury.
    function defeatFraudChallenge(
        bytes calldata walletPublicKey,
        bytes calldata preimage,
        bool witness
    ) external {
        _requireActive();
        bytes32 sighash = preimage.hash256();

        uint256 challengeKey = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sighash))
        );

        Fraud.FraudChallenge storage challenge = fraudChallenges[challengeKey];

        require(challenge.reportedAt > 0, "Fraud challenge does not exist");
        require(
            !challenge.resolved,
            "Fraud challenge has already been resolved"
        );

        // SIGHASH_ALL is type 1; anything else is rejected.
        require(Fraud.extractSighashType(preimage) == 1, "Wrong sighash type");

        uint256 utxoKey = witness
            ? Fraud.extractUtxoKeyFromWitnessPreimage(preimage)
            : Fraud.extractUtxoKeyFromNonWitnessPreimage(preimage);

        IBridgeForFraud b = IBridgeForFraud(bridge);

        require(
            b.deposits(utxoKey).sweptAt > 0 ||
                b.spentMainUTXOs(utxoKey) ||
                b.movedFundsSweepRequests(utxoKey).state ==
                MovingFunds.MovedFundsSweepRequestState.Processed,
            "Spent UTXO not found among correctly spent UTXOs"
        );

        _resolveFraudChallenge(
            challengeKey,
            walletPublicKey,
            challenge,
            sighash
        );
    }

    /// @notice Defeats a pending ECDSA fraud challenge by proving the
    ///         preimage was a strictly-formatted off-chain heartbeat
    ///         message.
    function defeatFraudChallengeWithHeartbeat(
        bytes calldata walletPublicKey,
        bytes calldata heartbeatMessage
    ) external {
        _requireActive();
        bytes32 sighash = heartbeatMessage.hash256();

        uint256 challengeKey = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sighash))
        );

        Fraud.FraudChallenge storage challenge = fraudChallenges[challengeKey];

        require(challenge.reportedAt > 0, "Fraud challenge does not exist");
        require(
            !challenge.resolved,
            "Fraud challenge has already been resolved"
        );

        require(
            Heartbeat.isValidHeartbeatMessage(heartbeatMessage),
            "Not a valid heartbeat message"
        );

        _resolveFraudChallenge(
            challengeKey,
            walletPublicKey,
            challenge,
            sighash
        );
    }

    /// @notice Notifies that an open fraud challenge passed its defeat
    ///         timeout. Refunds the challenger from this router's
    ///         escrow and calls back into Bridge to slash the wallet's
    ///         operator stake + terminate the wallet.
    function notifyFraudChallengeDefeatTimeout(
        bytes calldata walletPublicKey,
        uint32[] calldata walletMembersIDs,
        bytes memory preimageSha256
    ) external {
        _requireActive();
        // Wallet state is validated inside Bridge.slashWalletForFraud
        // (delegating to Wallets.notifyWalletFraudChallengeDefeatTimeout).

        bytes32 sighash = sha256(preimageSha256);

        uint256 challengeKey = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sighash))
        );

        Fraud.FraudChallenge storage challenge = fraudChallenges[challengeKey];

        require(challenge.reportedAt > 0, "Fraud challenge does not exist");
        require(
            !challenge.resolved,
            "Fraud challenge has already been resolved"
        );

        IBridgeForFraud b = IBridgeForFraud(bridge);
        (, uint32 defeatTimeout, , ) = b.fraudParameters();
        uint256 timeoutStartedAt = fraudChallengeDefeatTimeoutStartedAt(
            challengeKey
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= timeoutStartedAt + defeatTimeout,
            "Fraud challenge defeat period did not time out yet"
        );

        challenge.resolved = true;

        // Refund the challenger from the router's escrowed deposit.
        // The return value is intentionally ignored: a reverting
        // challenger fallback self-griefs the refund but must not block
        // the fraud timeout slashing path.
        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line low-level-calls,unchecked-lowlevel,arbitrary-send-eth
        challenge.challenger.call{gas: 100000, value: challenge.depositAmount}(
            ""
        );
        /* solhint-enable avoid-low-level-calls */

        bytes memory compressedWalletPublicKey = EcdsaLib.compressPublicKey(
            walletPublicKey.slice32(0),
            walletPublicKey.slice32(32)
        );
        bytes20 walletPubKeyHash = compressedWalletPublicKey.hash160View();

        // Privileged callback into Bridge: perform stake seizure +
        // wallet termination. Gated by Bridge's onlyEcdsaFraudRouter.
        b.slashWalletForFraud(
            walletPubKeyHash,
            walletMembersIDs,
            challenge.challenger
        );

        // Keep the per-wallet counter as the graceful-closure lock across
        // the untrusted refund and Bridge slashing callbacks.
        _decrementOpenFraudChallengeCount(challengeKey);

        // slither-disable-next-line reentrancy-events
        emit FraudChallengeDefeatTimedOut(walletPubKeyHash, sighash);
    }

    /// @notice Returns whether graceful closure of the given wallet must wait
    ///         for an unresolved direct or unattributed migrated challenge.
    function hasOpenFraudChallengeForWallet(bytes20 walletPubKeyHash)
        external
        view
        returns (bool)
    {
        return
            openFraudChallengeCountByWallet[walletPubKeyHash] > 0 ||
            unattributedOpenFraudChallengeCount > 0;
    }

    /// @dev Marks the challenge resolved and forwards the escrowed
    ///      deposit to Bridge's treasury. Mirrors the prior
    ///      Fraud.resolveFraudChallenge helper.
    function _resolveFraudChallenge(
        uint256 challengeKey,
        bytes calldata walletPublicKey,
        Fraud.FraudChallenge storage challenge,
        bytes32 sighash
    ) internal {
        challenge.resolved = true;
        _decrementOpenFraudChallengeCount(challengeKey);

        address treasury = IBridgeForFraud(bridge).treasury();
        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line low-level-calls,unchecked-lowlevel,arbitrary-send-eth
        treasury.call{gas: 100000, value: challenge.depositAmount}("");
        /* solhint-enable avoid-low-level-calls */

        bytes memory compressedWalletPublicKey = EcdsaLib.compressPublicKey(
            walletPublicKey.slice32(0),
            walletPublicKey.slice32(32)
        );
        bytes20 walletPubKeyHash = compressedWalletPublicKey.hash160View();

        // slither-disable-next-line reentrancy-events
        emit FraudChallengeDefeated(walletPubKeyHash, sighash);
    }

    function _decrementOpenFraudChallengeCount(uint256 challengeKey) internal {
        bytes20 walletPubKeyHash = fraudChallengeWalletPubKeyHash[challengeKey];

        openFraudChallengeCount--;
        openFraudChallengeEscrow -= fraudChallenges[challengeKey].depositAmount;
        if (walletPubKeyHash == bytes20(0)) {
            unattributedOpenFraudChallengeCount--;
        } else {
            openFraudChallengeCountByWallet[walletPubKeyHash]--;
            delete fraudChallengeWalletPubKeyHash[challengeKey];
        }
    }

    function _requireActive() internal view {
        if (IBridgeForFraud(bridge).ecdsaFraudRouter() != address(this)) {
            revert EcdsaFraudRouterNotActive();
        }
    }

    // P2TR signature-fraud lives in its own sidecar
    // (`P2TRSignatureFraudRouter`), not here. ECDSA and P2TR signature
    // fraud are entirely distinct lifecycles -- different signature
    // math (BIP-143 + ecrecover vs BIP-341 + Schnorr), different
    // structured payloads, different wallet types. Co-locating them
    // would either (a) push past EIP-170 via inlined helpers or
    // (b) reintroduce the external-linked-library ceremony the
    // structural extraction was designed to escape. Bridge sets the
    // two routers independently via `setEcdsaFraudRouter` and
    // `setP2TRFraudRouter` and gates their callbacks separately.
}
