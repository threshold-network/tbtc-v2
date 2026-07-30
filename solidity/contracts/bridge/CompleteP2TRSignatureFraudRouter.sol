// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./CheckBitcoinBIP340Sigs.sol";
import "./Deposit.sol";
import "./P2TRAuthorizationRegistry.sol";
import "./P2TRFraudEvidenceProtocol.sol";
import "./P2TRSignatureFraudRouter.sol";

interface IBridgeForCompleteP2TRFraud is IBridgeForP2TRFraud {}

interface IP2TRAuthorizationRegistryBinding {
    function bridge() external view returns (address);

    function domainChainID() external view returns (uint256);
}

/// @title Complete P2TR signature-fraud router
/// @notice Gas-constant fraud challenges for every BIP-340 signed 32-byte
///         message, with immutable authorization derived only from Bitcoin
///         transactions reserved by the Bridge before FROST signing begins.
/// @dev A challenge does not reproduce an unbounded Bitcoin transaction. It
///      proves only that the registered wallet (or a deposit key bound to that
///      wallet at reveal) signed a message. The immutable authorization
///      registry independently allowlists exactly the DEFAULT/no-annex digest
///      for every FROST input after 51 sorted wallet seats attest an exact
///      Bridge-derived reservation. Consequently, explicit ALL/NONE/SINGLE,
///      ANYONECANPAY, annex-bearing, script-path, oversized, and arbitrary
///      messages remain challengeable without putting their transaction shape
///      on the EVM adjudication path.
///
///      Activation must preflight that no historical FROST or commitment-only
///      Taproot custody predates exact deposit output-key storage. Otherwise,
///      those keys must be migrated before this router is installed.
contract CompleteP2TRSignatureFraudRouter is P2TRSignatureFraudRouter {
    /// @notice Immutable registry populated only by the bound Bridge.
    address public immutable authorizationRegistry;
    /// @notice Registry deployment domain retained across chain-ID changes.
    uint256 public immutable domainChainID;

    /// @notice Fixed-size identity used by defeat and timeout actions.
    struct ChallengeIdentity {
        bytes32 walletID;
        bytes32 signingKey;
        bytes32 sighash;
    }

    /// @notice Fixed-size BIP-340 submission evidence.
    /// @dev `bindingTxHash` and `bindingOutputIndex` are used only when
    ///      `signingKey != walletID` to bind a tweaked deposit key. They are not
    ///      part of the challenge identity.
    struct ChallengeEvidence {
        bytes32 walletID;
        bytes32 signingKey;
        bytes32 bindingTxHash;
        uint32 bindingOutputIndex;
        bytes32 sighash;
        bytes32 nonceX;
        bytes32 signatureScalar;
    }

    /// @notice Canonical COMPLETE_V2 submission record. It exposes every
    ///         field needed to reconstruct defeat/timeout identity from
    ///         finalized logs alone; signature and deposit-binding fields are
    ///         intentionally excluded because they are not identity fields.
    event CompleteP2TRSignatureFraudChallengeSubmitted(
        bytes32 indexed bridgeChallengeIdentity,
        bytes32 indexed walletID,
        bytes32 indexed signingKey,
        bytes32 sighash,
        uint256 challengeKey,
        bytes20 walletPubKeyHash,
        address challenger,
        uint256 authorizationSequenceCutoff
    );

    uint256 internal constant ChallengeIdentityEncodedLength = 96;
    uint256 internal constant ChallengeEvidenceEncodedLength = 224;

    struct QuarantineContext {
        uint8 previousState;
        bool wasActive;
        bool initialized;
        bool recoveryRequired;
        bool archived;
        bool fraudSeized;
    }

    mapping(bytes20 => QuarantineContext) private quarantineContexts;

    /// @notice Registry authorization sequence observed when a challenge was
    ///         opened. Only an identity whose first authorization sequence is
    ///         nonzero and no greater than this cutoff can defeat it.
    /// @dev Submission also requires the identity sequence to be zero, so an
    ///      admitted COMPLETE_V2 challenge can never be defeated by a
    ///      retroactive pre-sign authorization. The snapshot remains public
    ///      for independent event/state reconciliation.
    mapping(uint256 => uint256) public challengeAuthorizationSequenceCutoff;

    /// @notice Deposits still backing unresolved challenges.
    uint256 public totalChallengeEscrow;

    /// @notice Resolved deposits credited for beneficiary withdrawal.
    uint256 public totalWithdrawablePayouts;

    /// @notice Pull-payment credit keyed by challenger or treasury beneficiary.
    mapping(address => uint256) public withdrawableP2TRFraudPayouts;

    event P2TRFraudPayoutCredited(
        uint256 indexed challengeKey,
        address indexed beneficiary,
        uint256 amount,
        uint256 totalChallengeEscrow,
        uint256 totalWithdrawablePayouts
    );

    event P2TRFraudPayoutWithdrawn(
        address indexed beneficiary,
        address indexed receiver,
        uint256 amount,
        uint256 totalWithdrawablePayouts
    );

    constructor(address _bridge, address _authorizationRegistry)
        P2TRSignatureFraudRouter(_bridge)
    {
        require(
            _authorizationRegistry != address(0),
            "Authorization registry address cannot be zero"
        );
        require(
            IP2TRAuthorizationRegistryBinding(_authorizationRegistry)
                .bridge() == _bridge,
            "Authorization registry bound to another Bridge"
        );
        uint256 registryDomainChainID = IP2TRAuthorizationRegistryBinding(
            _authorizationRegistry
        ).domainChainID();
        require(registryDomainChainID != 0, "Chain ID cannot be zero");
        require(
            registryDomainChainID == block.chainid,
            "Authorization registry bound to another chain"
        );
        authorizationRegistry = _authorizationRegistry;
        domainChainID = registryDomainChainID;
    }

    function evidenceProtocolID() public pure override returns (bytes32) {
        return P2TRFraudEvidenceProtocol.COMPLETE_V2;
    }

    function preauthorizationProtocolID() external pure returns (bytes32) {
        return P2TRAuthorization.ReservationProtocolID;
    }

    function signingPolicyHash() external pure returns (bytes32) {
        return P2TRAuthorization.SigningPolicyHash;
    }

    /// @notice COMPLETE_V2 cannot safely inherit challenge records whose keys
    ///         were derived from a different evidence protocol.
    /// @dev P2TR custody is activated only after this router is installed, so
    ///      there are no legitimate pre-COMPLETE_V2 P2TR records to migrate.
    ///      Accepting them would create unattributed challenges that the
    ///      fixed-size identity API can never resolve.
    function acceptMigration(
        uint256[] calldata challengeKeys,
        Fraud.FraudChallenge[] calldata data
    ) external payable override {
        require(msg.sender == bridge, "Caller is not Bridge");
        require(
            challengeKeys.length == 0 && data.length == 0 && msg.value == 0,
            "COMPLETE_V2 migration must be empty"
        );
    }

    /// @notice Preserves the sidecar's action-dispatch entrypoint while using
    ///         fixed-size COMPLETE_V2 payloads.
    /// @param action 0=Submit, 1=Defeat, 2=Timeout.
    /// @param payload Submit encodes `ChallengeEvidence`; defeat and timeout
    ///        encode `ChallengeIdentity`.
    function processP2TRSignatureFraudChallenge(
        uint8 action,
        bytes calldata payload,
        uint32[] calldata walletMembersIDs
    ) external payable override {
        if (action == uint8(P2TRFraudAction.Submit)) {
            require(
                payload.length == ChallengeEvidenceEncodedLength,
                "Invalid challenge evidence length"
            );
            _submitComplete(abi.decode(payload, (ChallengeEvidence)));
        } else if (action == uint8(P2TRFraudAction.Defeat)) {
            require(msg.value == 0, "ETH not required");
            require(
                payload.length == ChallengeIdentityEncodedLength,
                "Invalid challenge identity length"
            );
            _defeatAuthorized(abi.decode(payload, (ChallengeIdentity)));
        } else if (action == uint8(P2TRFraudAction.Timeout)) {
            require(msg.value == 0, "ETH not required");
            require(
                payload.length == ChallengeIdentityEncodedLength,
                "Invalid challenge identity length"
            );
            _notifyCompleteTimeout(
                abi.decode(payload, (ChallengeIdentity)),
                walletMembersIDs
            );
        } else {
            revert("Unknown P2TR fraud action");
        }
    }

    function submitP2TRSignatureFraudChallenge(
        ChallengeEvidence calldata evidence
    ) external payable {
        _submitComplete(evidence);
    }

    function defeatP2TRSignatureFraudChallenge(
        ChallengeIdentity calldata identity
    ) external {
        _defeatAuthorized(identity);
    }

    function notifyP2TRSignatureFraudChallengeDefeatTimeout(
        ChallengeIdentity calldata identity,
        uint32[] calldata walletMembersIDs
    ) external {
        _notifyCompleteTimeout(identity, walletMembersIDs);
    }

    function challengeIdentity(ChallengeIdentity calldata identity)
        external
        view
        returns (bytes32)
    {
        return _challengeIdentity(identity);
    }

    /// @notice Withdraws all resolved challenge proceeds belonging to the
    ///         caller to an arbitrary receiver. A beneficiary whose fallback
    ///         rejects ETH can therefore use a different receiver without
    ///         blocking challenge resolution or losing its credit.
    function withdrawP2TRFraudPayout(address payable receiver) external {
        require(receiver != address(0), "Payout receiver cannot be zero");
        uint256 amount = withdrawableP2TRFraudPayouts[msg.sender];
        require(amount != 0, "No withdrawable payout");

        withdrawableP2TRFraudPayouts[msg.sender] = 0;
        totalWithdrawablePayouts -= amount;

        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line low-level-calls,arbitrary-send-eth
        (bool success, ) = receiver.call{value: amount}("");
        /* solhint-enable avoid-low-level-calls */
        require(success, "Payout transfer failed");

        emit P2TRFraudPayoutWithdrawn(
            msg.sender,
            receiver,
            amount,
            totalWithdrawablePayouts
        );
    }

    /// @notice Bridge callback after an exact reserved moving-funds proof was
    ///         applied while the source wallet was quarantined. The wallet
    ///         remains quarantined, but a later successful challenge defeat
    ///         must restore Closing rather than the obsolete MovingFunds state.
    function reconcileAuthorizedMovingFundsProof(bytes20 walletPubKeyHash)
        external
    {
        require(msg.sender == bridge, "Caller is not Bridge");
        QuarantineContext storage context = quarantineContexts[
            walletPubKeyHash
        ];
        require(
            context.initialized &&
                !context.recoveryRequired &&
                context.previousState == uint8(Wallets.WalletState.MovingFunds),
            "Invalid quarantine reconciliation"
        );
        context.previousState = uint8(Wallets.WalletState.Closing);
    }

    /// @notice Synchronizes a Bridge-detected reservation conflict with an
    ///         already-open fraud quarantine so later challenge resolution
    ///         cannot restore the wallet. Reservation recovery does not imply
    ///         that the fraud seizure has already occurred.
    function reconcileReservationConflict(bytes20 walletPubKeyHash) external {
        require(msg.sender == bridge, "Caller is not Bridge");
        if (openFraudChallengeCountByWallet[walletPubKeyHash] != 0) {
            QuarantineContext storage context = quarantineContexts[
                walletPubKeyHash
            ];
            require(context.initialized, "Wallet quarantine context missing");
            context.recoveryRequired = true;
        }
    }

    function _submitComplete(ChallengeEvidence memory evidence) internal {
        IBridgeForCompleteP2TRFraud b = IBridgeForCompleteP2TRFraud(bridge);

        (uint96 depositAmount, , , ) = b.fraudParameters();
        require(
            msg.value >= depositAmount,
            "The amount of ETH deposited is too low"
        );

        bytes20 walletPubKeyHash = _resolveFrostChallengeableWallet(
            b,
            evidence.walletID
        );
        _validateSigningKeyBinding(b, evidence);

        ChallengeIdentity memory identity = ChallengeIdentity(
            evidence.walletID,
            evidence.signingKey,
            evidence.sighash
        );
        (bytes32 bridgeChallengeIdentity, uint256 challengeKey) = _challengeKey(
            identity
        );

        IP2TRAuthorizationRegistry registry = IP2TRAuthorizationRegistry(
            authorizationRegistry
        );
        uint256 identityAuthorizationSequence = registry
            .authorizationSequenceByChallengeIdentity(bridgeChallengeIdentity);
        uint256 authorizationSequenceCutoff = registry
            .authorizedChallengeIdentityCount();

        require(
            identityAuthorizationSequence == 0 &&
                !_isAuthorized(bridgeChallengeIdentity),
            "P2TR authorization already accepted"
        );

        Fraud.FraudChallenge storage challenge = fraudChallenges[challengeKey];
        require(challenge.reportedAt == 0, "Fraud challenge already exists");
        require(
            !b.legacyFraudChallengeExists(challengeKey),
            "Legacy fraud challenge exists"
        );

        require(
            CheckBitcoinBIP340Sigs.checkSig(
                evidence.signingKey,
                evidence.sighash,
                evidence.nonceX,
                evidence.signatureScalar
            ),
            "Signature verification failure"
        );

        if (openFraudChallengeCountByWallet[walletPubKeyHash] == 0) {
            Wallets.WalletState walletState = b.wallets(walletPubKeyHash).state;
            if (walletState == Wallets.WalletState.RecoveryRequired) {
                quarantineContexts[walletPubKeyHash] = QuarantineContext(
                    uint8(walletState),
                    false,
                    true,
                    true,
                    false,
                    false
                );
            } else if (
                walletState == Wallets.WalletState.Closed ||
                walletState == Wallets.WalletState.Terminated
            ) {
                quarantineContexts[walletPubKeyHash] = QuarantineContext(
                    uint8(walletState),
                    false,
                    true,
                    false,
                    true,
                    false
                );
            } else {
                (uint8 previousState, bool wasActive) = abi.decode(
                    b.processP2TRWalletLifecycle(
                        abi.encode(uint8(0), abi.encode(walletPubKeyHash))
                    ),
                    (uint8, bool)
                );
                quarantineContexts[walletPubKeyHash] = QuarantineContext(
                    previousState,
                    wasActive,
                    true,
                    false,
                    false,
                    false
                );
            }
        }

        challenge.challenger = msg.sender;
        challenge.depositAmount = msg.value;
        /* solhint-disable-next-line not-rely-on-time */
        challenge.reportedAt = uint32(block.timestamp);
        challenge.resolved = false;
        fraudChallengeWalletPubKeyHash[challengeKey] = walletPubKeyHash;
        challengeAuthorizationSequenceCutoff[
            challengeKey
        ] = authorizationSequenceCutoff;
        openFraudChallengeCount++;
        openFraudChallengeCountByWallet[walletPubKeyHash]++;
        totalChallengeEscrow += msg.value;

        emit P2TRSignatureFraudChallengeSubmitted(
            evidence.walletID,
            walletPubKeyHash,
            bridgeChallengeIdentity,
            challengeKey,
            evidence.sighash
        );
        emit CompleteP2TRSignatureFraudChallengeSubmitted(
            bridgeChallengeIdentity,
            evidence.walletID,
            evidence.signingKey,
            evidence.sighash,
            challengeKey,
            walletPubKeyHash,
            msg.sender,
            authorizationSequenceCutoff
        );
    }

    function _defeatAuthorized(ChallengeIdentity memory identity) internal {
        IBridgeForCompleteP2TRFraud b = IBridgeForCompleteP2TRFraud(bridge);
        bytes20 walletPubKeyHash = _resolveFrostWallet(b, identity.walletID);
        (bytes32 bridgeChallengeIdentity, uint256 challengeKey) = _challengeKey(
            identity
        );
        Fraud.FraudChallenge storage challenge = _unresolvedChallenge(
            challengeKey
        );

        require(
            _wasAuthorizedBeforeChallenge(
                bridgeChallengeIdentity,
                challengeKey
            ),
            "P2TR authorization was not accepted before challenge"
        );

        _resolveCompleteChallenge(
            identity,
            walletPubKeyHash,
            bridgeChallengeIdentity,
            challengeKey,
            challenge
        );
    }

    function _notifyCompleteTimeout(
        ChallengeIdentity memory identity,
        uint32[] calldata walletMembersIDs
    ) internal {
        IBridgeForCompleteP2TRFraud b = IBridgeForCompleteP2TRFraud(bridge);
        bytes20 walletPubKeyHash = _resolveFrostWallet(b, identity.walletID);
        (bytes32 bridgeChallengeIdentity, uint256 challengeKey) = _challengeKey(
            identity
        );
        Fraud.FraudChallenge storage challenge = _unresolvedChallenge(
            challengeKey
        );

        // Only an authorization that predates challenge admission is a valid
        // defense. Registering the signed transaction after it was challenged
        // may still settle its exact reserved Bitcoin proof, but cannot erase
        // evidence that the signer released a signature before authorization.
        if (
            _wasAuthorizedBeforeChallenge(bridgeChallengeIdentity, challengeKey)
        ) {
            _resolveCompleteChallenge(
                identity,
                walletPubKeyHash,
                bridgeChallengeIdentity,
                challengeKey,
                challenge
            );
            return;
        }

        (, uint32 defeatTimeout, , ) = b.fraudParameters();
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= challenge.reportedAt + defeatTimeout,
            "Fraud challenge defeat period did not time out yet"
        );

        challenge.resolved = true;
        _creditPayout(
            challengeKey,
            challenge.challenger,
            challenge.depositAmount
        );

        QuarantineContext storage quarantine = quarantineContexts[
            walletPubKeyHash
        ];
        if (!quarantine.fraudSeized) {
            // Effects precede the callback so same-wallet reentrancy cannot
            // execute the fraud seizure twice.
            quarantine.fraudSeized = true;
            quarantine.recoveryRequired = true;
            b.processP2TRWalletLifecycle(
                abi.encode(
                    quarantine.archived ? uint8(3) : uint8(2),
                    abi.encode(
                        walletPubKeyHash,
                        walletMembersIDs,
                        challenge.challenger
                    )
                )
            );
        }

        _decrementOpenFraudChallengeCount(challengeKey);
        _finalizeQuarantineIfResolved(walletPubKeyHash);

        emit P2TRSignatureFraudChallengeDefeatTimedOut(
            identity.walletID,
            walletPubKeyHash,
            bridgeChallengeIdentity,
            challengeKey,
            identity.sighash
        );
    }

    function _resolveCompleteChallenge(
        ChallengeIdentity memory identity,
        bytes20 walletPubKeyHash,
        bytes32 bridgeChallengeIdentity,
        uint256 challengeKey,
        Fraud.FraudChallenge storage challenge
    ) internal {
        address treasury = IBridgeForCompleteP2TRFraud(bridge).treasury();
        challenge.resolved = true;
        _creditPayout(challengeKey, treasury, challenge.depositAmount);
        _decrementOpenFraudChallengeCount(challengeKey);
        _finalizeQuarantineIfResolved(walletPubKeyHash);

        emit P2TRSignatureFraudChallengeDefeated(
            identity.walletID,
            walletPubKeyHash,
            bridgeChallengeIdentity,
            challengeKey,
            identity.sighash
        );
    }

    function _creditPayout(
        uint256 challengeKey,
        address beneficiary,
        uint256 amount
    ) internal {
        require(beneficiary != address(0), "Payout beneficiary cannot be zero");
        totalChallengeEscrow -= amount;
        withdrawableP2TRFraudPayouts[beneficiary] += amount;
        totalWithdrawablePayouts += amount;
        emit P2TRFraudPayoutCredited(
            challengeKey,
            beneficiary,
            amount,
            totalChallengeEscrow,
            totalWithdrawablePayouts
        );
    }

    function _validateSigningKeyBinding(
        IBridgeForCompleteP2TRFraud b,
        ChallengeEvidence memory evidence
    ) internal view {
        if (evidence.signingKey == evidence.walletID) {
            require(
                evidence.bindingTxHash == bytes32(0) &&
                    evidence.bindingOutputIndex == 0,
                "Base wallet key must not have deposit binding"
            );
            return;
        }

        uint256 depositKey = uint256(
            keccak256(
                abi.encodePacked(
                    evidence.bindingTxHash,
                    evidence.bindingOutputIndex
                )
            )
        );
        bytes32 depositOutputKeyCommitment = b
            .taprootDepositOutputKeyCommitment(depositKey);
        require(
            depositOutputKeyCommitment != bytes32(0),
            "Taproot deposit wallet binding not found"
        );
        require(
            depositOutputKeyCommitment ==
                Deposit.taprootOutputKeyCommitment(
                    evidence.walletID,
                    evidence.signingKey
                ),
            "Taproot deposit wallet binding mismatch"
        );
    }

    function _resolveFrostChallengeableWallet(
        IBridgeForCompleteP2TRFraud b,
        bytes32 walletID
    ) internal view returns (bytes20 walletPubKeyHash) {
        walletPubKeyHash = _resolveWalletPubKeyHash(b, walletID);
        Wallets.Wallet memory wallet = b.wallets(walletPubKeyHash);
        require(wallet.ecdsaWalletID == bytes32(0), "FROST wallet required");
        require(
            wallet.state == Wallets.WalletState.Live ||
                wallet.state == Wallets.WalletState.MovingFunds ||
                wallet.state == Wallets.WalletState.Closing ||
                wallet.state == Wallets.WalletState.Quarantined ||
                wallet.state == Wallets.WalletState.RecoveryRequired ||
                wallet.state == Wallets.WalletState.Closed ||
                wallet.state == Wallets.WalletState.Terminated,
            "Wallet is not challengeable"
        );
    }

    function _resolveFrostWallet(
        IBridgeForCompleteP2TRFraud b,
        bytes32 walletID
    ) internal view returns (bytes20 walletPubKeyHash) {
        walletPubKeyHash = _resolveWalletPubKeyHash(b, walletID);
        require(
            b.wallets(walletPubKeyHash).ecdsaWalletID == bytes32(0),
            "FROST wallet required"
        );
    }

    function _challengeKey(ChallengeIdentity memory identity)
        internal
        view
        returns (bytes32 bridgeChallengeIdentity, uint256 challengeKey)
    {
        bridgeChallengeIdentity = _challengeIdentity(identity);
        challengeKey = uint256(bridgeChallengeIdentity);
    }

    function _challengeIdentity(ChallengeIdentity memory identity)
        internal
        view
        returns (bytes32)
    {
        return
            P2TRAuthorization.challengeIdentity(
                domainChainID,
                bridge,
                identity.walletID,
                identity.signingKey,
                identity.sighash
            );
    }

    function _isAuthorized(bytes32 bridgeChallengeIdentity)
        internal
        view
        returns (bool)
    {
        return
            IP2TRAuthorizationRegistry(authorizationRegistry)
                .authorizedChallengeIdentities(bridgeChallengeIdentity);
    }

    function _wasAuthorizedBeforeChallenge(
        bytes32 bridgeChallengeIdentity,
        uint256 challengeKey
    ) internal view returns (bool) {
        uint256 authorizationSequence = IP2TRAuthorizationRegistry(
            authorizationRegistry
        ).authorizationSequenceByChallengeIdentity(bridgeChallengeIdentity);

        return
            authorizationSequence != 0 &&
            authorizationSequence <=
            challengeAuthorizationSequenceCutoff[challengeKey];
    }

    function _finalizeQuarantineIfResolved(bytes20 walletPubKeyHash) internal {
        if (openFraudChallengeCountByWallet[walletPubKeyHash] != 0) return;
        QuarantineContext memory context = quarantineContexts[walletPubKeyHash];
        require(context.initialized, "Wallet quarantine context missing");
        delete quarantineContexts[walletPubKeyHash];
        if (!context.recoveryRequired && !context.archived) {
            IBridgeForCompleteP2TRFraud(bridge).processP2TRWalletLifecycle(
                abi.encode(
                    uint8(1),
                    abi.encode(
                        walletPubKeyHash,
                        context.previousState,
                        context.wasActive
                    )
                )
            );
        }
    }
}
