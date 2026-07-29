// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "@keep-network/bitcoin-spv-sol/contracts/CheckBitcoinSigs.sol";

import "./BitcoinTx.sol";
import "./Deposit.sol";
import "./EcdsaLib.sol";
import "./Fraud.sol";
import "./Heartbeat.sol";
import "./MovingFunds.sol";
import "./Wallets.sol";

/// @notice State the router needs to read from Bridge while processing
///         ECDSA fraud lifecycle actions, plus the one privileged
///         callback used for slashing on timeout.
interface IBridgeForFraud {
    function wallets(bytes20 walletPubKeyHash)
        external
        view
        returns (Wallets.Wallet memory);

    function activeWalletPubKeyHash() external view returns (bytes20);

    function activeWalletID() external view returns (bytes32);

    function walletID(bytes20 walletPubKeyHash) external view returns (bytes32);

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

    function legacyFraudChallengeExists(uint256 challengeKey)
        external
        view
        returns (bool);

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

    /// @notice Constructor. Captures the Bridge address for the
    ///         router's lifetime.
    /// @param _bridge Address of the Bridge contract this router
    ///        cooperates with.
    constructor(address _bridge) {
        require(_bridge != address(0), "Bridge address cannot be zero");
        bridge = _bridge;
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

        uint256 totalDeposit;
        for (uint256 i = 0; i < challengeKeys.length; i++) {
            require(
                fraudChallenges[challengeKeys[i]].reportedAt == 0,
                "Challenge already migrated"
            );
            require(data[i].reportedAt > 0, "Challenge not reported");
            require(!data[i].resolved, "Challenge already resolved");
            fraudChallenges[challengeKeys[i]] = data[i];
            openFraudChallengeCount++;
            totalDeposit += data[i].depositAmount;
            emit FraudChallengeMigratedFromBridge(
                challengeKeys[i],
                data[i].challenger,
                data[i].depositAmount
            );
        }
        require(msg.value == totalDeposit, "msg.value != total deposit");
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

        bytes32 activeID = b.activeWalletID();
        require(
            b.activeWalletPubKeyHash() != walletPubKeyHash ||
                activeID == bytes32(0) ||
                activeID == b.walletID(walletPubKeyHash),
            "Legacy ECDSA wallet required"
        );

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

        Fraud.FraudChallenge storage challenge = fraudChallenges[challengeKey];
        require(challenge.reportedAt == 0, "Fraud challenge already exists");
        require(
            !b.legacyFraudChallengeExists(challengeKey),
            "Legacy fraud challenge exists"
        );

        challenge.challenger = msg.sender;
        challenge.depositAmount = msg.value;
        /* solhint-disable-next-line not-rely-on-time */
        challenge.reportedAt = uint32(block.timestamp);
        challenge.resolved = false;
        openFraudChallengeCount++;

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

        _resolveFraudChallenge(walletPublicKey, challenge, sighash);
    }

    /// @notice Defeats a pending ECDSA fraud challenge by proving the
    ///         preimage was a strictly-formatted off-chain heartbeat
    ///         message.
    function defeatFraudChallengeWithHeartbeat(
        bytes calldata walletPublicKey,
        bytes calldata heartbeatMessage
    ) external {
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

        _resolveFraudChallenge(walletPublicKey, challenge, sighash);
    }

    /// @dev Marks the challenge resolved and forwards the escrowed
    ///      deposit to Bridge's treasury. Mirrors the prior
    ///      Fraud.resolveFraudChallenge helper.
    function _resolveFraudChallenge(
        bytes calldata walletPublicKey,
        Fraud.FraudChallenge storage challenge,
        bytes32 sighash
    ) internal {
        challenge.resolved = true;
        openFraudChallengeCount--;

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

    /// @notice Notifies that an open fraud challenge passed its defeat
    ///         timeout. Refunds the challenger from this router's
    ///         escrow and calls back into Bridge to slash the wallet's
    ///         operator stake + terminate the wallet.
    function notifyFraudChallengeDefeatTimeout(
        bytes calldata walletPublicKey,
        uint32[] calldata walletMembersIDs,
        bytes memory preimageSha256
    ) external {
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
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= challenge.reportedAt + defeatTimeout,
            "Fraud challenge defeat period did not time out yet"
        );

        challenge.resolved = true;
        openFraudChallengeCount--;

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

        // slither-disable-next-line reentrancy-events
        emit FraudChallengeDefeatTimedOut(walletPubKeyHash, sighash);
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
