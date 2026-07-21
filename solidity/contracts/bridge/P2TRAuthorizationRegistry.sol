// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./BitcoinTx.sol";
import "./CheckBitcoinBIP341Sighash.sol";
import "./P2TRSignatureFraud.sol";

interface IP2TRAuthorizationRegistry {
    struct PreAuthorization {
        uint8 action;
        bytes20 walletPubKeyHash;
        bytes32 walletID;
        bytes32 membersIDsHash;
        bytes32 snapshotHash;
        bytes32 resourceHash;
        bytes32 orderedInputRoot;
        bytes32 applyPlanHash;
        bytes32 applyPlanData1;
        bytes32 applyPlanData2;
        uint64 feeLimitSnapshot;
    }

    struct SeatAttestation {
        uint32[] walletMembersIDs;
        uint8[] signingMemberIndices;
        bytes signatures;
    }

    function authorizedChallengeIdentities(bytes32 challengeIdentity)
        external
        view
        returns (bool);

    /// @notice Monotonic sequence assigned when an identity is first
    ///         authorized. Zero means the identity has never been authorized.
    function authorizationSequenceByChallengeIdentity(
        bytes32 challengeIdentity
    ) external view returns (uint256);

    function authorizedChallengeIdentityCount()
        external
        view
        returns (uint256);

    function registerPreAuthorizedTransaction(
        PreAuthorization calldata authorization,
        BitcoinTx.Info calldata transaction,
        uint64[] calldata inputValues,
        bytes32[] calldata signingKeys,
        bytes32[] calldata resourceIDs,
        SeatAttestation calldata attestation
    ) external returns (bytes32 reservationID, bytes32 transactionHash);

    function settleAuthorizedProof(
        bytes32 reservationID,
        bytes32 transactionHash
    ) external returns (bytes20 walletPubKeyHash);

    function settleConflictingProof(
        bytes32 transactionHash,
        bytes32 spentResourceID
    ) external returns (bytes32 reservationID, bytes20 walletPubKeyHash);

    function hasActiveReservation(bytes20 walletPubKeyHash)
        external
        view
        returns (bool);

    function isResourceReserved(bytes32 resourceID)
        external
        view
        returns (bool);

    function activeReservationCount() external view returns (uint256);

    function activeReservationAt(uint256 index)
        external
        view
        returns (bytes32);

    function activeReservationSetVersion() external view returns (uint256);

    function activeReservation(bytes20 walletPubKeyHash)
        external
        view
        returns (bytes32);

    function latestAuthorizedVariant(bytes32 reservationID)
        external
        view
        returns (
            bytes32 transactionHash,
            uint256 authorizationSequence,
            bool signingAllowed
        );

    function getAuthorizedVariantStatus(bytes32 transactionHash)
        external
        view
        returns (
            bytes32 reservationID,
            bytes32 authorizationRoot,
            bytes32 applyPlanHash,
            uint256 authorizationSequence,
            bool fraudDefenseAuthorized,
            bool signingAllowed
        );

    function getReservation(bytes32 id)
        external
        view
        returns (
            bytes32 walletID,
            bytes20 walletPubKeyHash,
            bytes32 membersIDsHash,
            bytes32 snapshotHash,
            bytes32 resourceHash,
            bytes32 orderedInputRoot,
            bytes32 applyPlanData1,
            bytes32 applyPlanData2,
            uint64 feeLimitSnapshot,
            uint8 action,
            uint8 status
        );

    function proposalValidator() external view returns (address);
}

interface IP2TRAuthorizationRouter {
    function authorizationRegistry() external view returns (address);
}

interface IBridgeForP2TRPreAuthorization {
    function frostLifecycleContext(bytes20 walletPubKeyHash)
        external
        view
        returns (address frostRegistry, bytes32 walletID);
}

interface IProposalValidatorForP2TRPreAuthorization {
    function bridge() external view returns (address);
}

interface IFrostRegistryForP2TRPreAuthorization {
    function getWallet(bytes32 walletID)
        external
        view
        returns (bytes32 membersIdsHash, bytes32 xOnlyOutputKey);

    function sortitionPool() external view returns (address);
}

interface ISortitionPoolForP2TRPreAuthorization {
    function getIDOperators(uint32[] calldata ids)
        external
        view
        returns (address[] memory);
}

/// @notice Canonical representation of one Bridge-approved Taproot key-path
///         signing context.
/// @dev COMPLETE_V2 deliberately authorizes only the FROST signer policy used
///      by the Bridge: key-path SIGHASH_DEFAULT without an annex. Signatures
///      over ALL/NONE/SINGLE, ANYONECANPAY, annex-bearing, or arbitrary
///      messages remain challengeable even when their transaction is otherwise
///      valid Bitcoin. Adding another mode requires an explicit signer-policy
///      change as well as a registry change.
library P2TRAuthorization {
    string internal constant ContextDomain = "tbtc-p2tr-authorized-context-v2";
    string internal constant ChallengeIdentityDomain =
        "tbtc-p2tr-signature-fraud-authorization-v3";
    bytes32 internal constant ReservationProtocolID =
        keccak256("tbtc/p2tr-pre-signing-reservation/threshold-v1");
    bytes32 internal constant SigningPolicyHash =
        keccak256(
            "tbtc/p2tr-pre-signing-policy/default-no-annex-51-seats-v1"
        );

    /// @notice All BIP-341 fields needed to reconstruct an annex-free key-path
    ///         SIGHASH_DEFAULT for one accepted transaction input.
    struct Context {
        bytes4 version;
        bytes4 locktime;
        uint32 inputIndex;
        bytes32 hashPrevouts;
        bytes32 hashAmounts;
        bytes32 hashScriptPubKeys;
        bytes32 hashSequences;
        bytes32 hashOutputs;
    }

    function hashContext(Context memory context)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(ContextDomain, context));
    }

    /// @notice Computes the constant challenge identity for one signing
    ///         authorization.
    /// @dev The identity is bound to its chain and Bridge, and its only
    ///      evidence fields are wallet ID, actual BIP-340 signing key, and
    ///      signed 32-byte message. Signature bytes, witness suffix, binding
    ///      outpoint, and unsigned transaction fields cannot create duplicates.
    function challengeIdentity(
        uint256 chainID,
        address bridge,
        bytes32 walletID,
        bytes32 signingKey,
        bytes32 sighash
    ) internal pure returns (bytes32) {
        require(chainID > 0, "Chain ID must be positive");
        require(bridge != address(0), "Bridge address cannot be zero");

        return
            sha256(
                abi.encodePacked(
                    ChallengeIdentityDomain,
                    chainID,
                    bridge,
                    walletID,
                    signingKey,
                    sighash
                )
            );
    }

    /// @notice Reconstructs annex-free BIP-341 SIGHASH_DEFAULT from an
    ///         accepted Bridge authorization context.
    function computeDefaultSighash(Context memory context)
        internal
        pure
        returns (bytes32)
    {
        return
            CheckBitcoinBIP341Sighash.taggedTapSighash(
                abi.encodePacked(
                    bytes1(0), // SIGHASH_DEFAULT.
                    context.version,
                    context.locktime,
                    context.hashPrevouts,
                    context.hashAmounts,
                    context.hashScriptPubKeys,
                    context.hashSequences,
                    context.hashOutputs,
                    bytes1(0), // Key path, no annex.
                    P2TRSignatureFraud.uint32LE(context.inputIndex)
                )
            );
    }

    function registerPreAuthorizedTransaction(
        address router,
        IP2TRAuthorizationRegistry.PreAuthorization memory authorization,
        BitcoinTx.Info memory transaction,
        uint64[] memory inputValues,
        bytes32[] memory signingKeys,
        bytes32[] memory resourceIDs,
        IP2TRAuthorizationRegistry.SeatAttestation memory attestation
    ) internal returns (bytes32 reservationID, bytes32 transactionHash) {
        require(router != address(0), "P2TR fraud router not configured");
        address registry = IP2TRAuthorizationRouter(router)
            .authorizationRegistry();
        require(
            registry != address(0),
            "Authorization registry not configured"
        );

        return
            IP2TRAuthorizationRegistry(registry)
                .registerPreAuthorizedTransaction(
                    authorization,
                    transaction,
                    inputValues,
                    signingKeys,
                    resourceIDs,
                    attestation
                );
    }
}

/// @title Immutable Bridge-approved P2TR authorization registry
/// @notice Stores threshold-attested authorizations before a FROST wallet may
///         release a Bitcoin signature.
/// @dev The immutable Bridge is the only writer. It derives every semantic
///      field from live Bridge state after running the existing wallet proposal
///      validator and an exact transaction-shape validator. The registry then
///      binds the authorization to the chain, Bridge, FROST registry, proposal
///      validator, current wallet membership, immutable resource set, and the
///      canonical key-path SIGHASH_DEFAULT/no-annex policy.
contract P2TRAuthorizationRegistry is IP2TRAuthorizationRegistry {
    using BTCUtils for bytes;
    using BytesLib for bytes;
    using ECDSA for bytes32;

    uint256 public constant groupThreshold = 51;
    /// @notice Maximum retained FROST group size before DKG exclusions.
    /// @dev A successfully registered wallet can contain fewer than 100 seats
    ///      when the DKG validator removes misbehaving members. The retained
    ///      group must still contain the 51 seats required by the threshold.
    uint256 public constant maximumGroupSize = 100;
    uint256 public constant signatureByteSize = 65;
    uint256 public constant maximumAuthorizedInputs = 21;

    address public immutable bridge;
    address public immutable frostRegistry;
    address public immutable override proposalValidator;
    /// @notice Deployment-time chain domain retained across chain-ID changes.
    uint256 public immutable domainChainID;

    mapping(bytes32 => bool) public override authorizedChallengeIdentities;
    /// @notice First-authorization sequence for each challenge identity.
    /// @dev Fraud challenges snapshot `authorizedChallengeIdentityCount` when
    ///      opened. An identity registered after that snapshot is not a valid
    ///      defense for the already-open challenge even though its exact
    ///      reserved Bitcoin proof remains settleable.
    mapping(bytes32 => uint256)
        public
        override authorizationSequenceByChallengeIdentity;
    uint256 public override authorizedChallengeIdentityCount;

    struct Reservation {
        bytes32 walletID;
        bytes20 walletPubKeyHash;
        bytes32 membersIDsHash;
        bytes32 snapshotHash;
        bytes32 resourceHash;
        bytes32 orderedInputRoot;
        bytes32 applyPlanData1;
        bytes32 applyPlanData2;
        uint64 feeLimitSnapshot;
        uint8 action;
        ReservationStatus status;
    }

    enum ReservationStatus {
        Unknown,
        Active,
        Settled,
        Conflicted
    }

    struct AuthorizedVariant {
        bytes32 reservationID;
        bytes32 authorizationRoot;
        bytes32 applyPlanHash;
        uint256 authorizationSequence;
        bool authorized;
    }

    mapping(bytes32 => Reservation) private reservations;
    mapping(bytes32 => AuthorizedVariant) private authorizedVariants;
    mapping(bytes32 => bytes32) private latestVariantByReservation;
    uint256 public authorizedVariantCount;
    mapping(bytes20 => bytes32) private activeReservationByWallet;
    mapping(bytes32 => bytes32) private resourceReservation;
    mapping(bytes32 => bytes32[]) private reservationResources;
    bytes32[] private activeReservationIDs;
    mapping(bytes32 => uint256) private activeReservationIndexPlusOne;

    /// @notice Monotonic revision of the exact enumerable active set.
    /// @dev Runtime reconciliation reads `activeReservationCount` and every
    ///      `activeReservationAt` value at one block tag. This revision and
    ///      the update event provide an independent append-only lifecycle
    ///      journal cursor. It is deliberately not presented as a
    ///      cryptographic multiset commitment.
    uint256 public override activeReservationSetVersion;

    struct InputAggregateHashes {
        bytes32 hashPrevouts;
        bytes32 hashAmounts;
        bytes32 hashScriptPubKeys;
        bytes32 hashSequences;
    }

    struct TransactionAggregateHashes {
        uint256 inputsCount;
        bytes32 hashPrevouts;
        bytes32 hashAmounts;
        bytes32 hashScriptPubKeys;
        bytes32 hashSequences;
        bytes32 hashOutputs;
    }

    struct InputSerializations {
        bytes[] outpoints;
        bytes[] amounts;
        bytes[] scriptPubKeys;
        bytes[] sequences;
    }

    event P2TRAuthorizationRegistered(
        bytes32 indexed challengeIdentity,
        bytes32 indexed contextHash,
        bytes32 indexed walletID,
        bytes32 signingKey,
        bytes32 sighash,
        uint32 inputIndex,
        uint256 authorizationSequence
    );

    event P2TRPreSigningReservationAuthorized(
        bytes32 indexed reservationID,
        bytes32 indexed transactionHash,
        bytes32 indexed walletID,
        bytes32 authorizationRoot,
        bytes32 snapshotHash,
        bytes32 resourceHash,
        uint8 action
    );

    event P2TRAuthorizedVariantAdvanced(
        bytes32 indexed reservationID,
        bytes32 indexed transactionHash,
        uint256 indexed authorizationSequence
    );

    event P2TRPreSigningReservationSettled(
        bytes32 indexed reservationID,
        bytes32 indexed transactionHash,
        bytes32 indexed walletID
    );

    event P2TRPreSigningReservationConflicted(
        bytes32 indexed reservationID,
        bytes32 indexed transactionHash,
        bytes32 indexed walletID,
        bytes32 spentResourceID
    );

    event P2TRActiveReservationAccountingUpdated(
        bytes32 indexed reservationID,
        bool indexed active,
        uint256 activeReservationCount,
        uint256 activeReservationSetVersion
    );

    constructor(
        address _bridge,
        address _frostRegistry,
        address _proposalValidator
    ) {
        require(_bridge != address(0), "Bridge address cannot be zero");
        require(
            _frostRegistry != address(0),
            "FROST registry cannot be zero"
        );
        require(
            _proposalValidator != address(0),
            "Proposal validator cannot be zero"
        );
        require(block.chainid != 0, "Chain ID cannot be zero");
        require(
            IProposalValidatorForP2TRPreAuthorization(_proposalValidator)
                .bridge() == _bridge,
            "Proposal validator Bridge mismatch"
        );
        bridge = _bridge;
        frostRegistry = _frostRegistry;
        proposalValidator = _proposalValidator;
        domainChainID = block.chainid;
    }

    /// @notice Stable configuration tuple consumed by keep-core and activation
    ///         tooling. All addresses are ordinary EVM address values; hashes
    ///         use Solidity/ABI byte order.
    function protocolConfig()
        external
        view
        returns (
            address bridgeAddress,
            address frostRegistryAddress,
            address proposalValidatorAddress,
            uint256 chainID,
            bytes32 protocolID,
            bytes32 policyHash
        )
    {
        return (
            bridge,
            frostRegistry,
            proposalValidator,
            domainChainID,
            P2TRAuthorization.ReservationProtocolID,
            P2TRAuthorization.SigningPolicyHash
        );
    }

    function reservationProtocolID() external pure returns (bytes32) {
        return P2TRAuthorization.ReservationProtocolID;
    }

    function signingPolicyHash() external pure returns (bytes32) {
        return P2TRAuthorization.SigningPolicyHash;
    }

    function reservationID(PreAuthorization calldata authorization)
        public
        view
        returns (bytes32)
    {
        bytes32 walletScopeHash = keccak256(
            abi.encode(
                authorization.action,
                authorization.walletPubKeyHash,
                authorization.walletID,
                authorization.membersIDsHash,
                authorization.snapshotHash
            )
        );
        bytes32 lockedPlanHash = keccak256(
            abi.encode(
                authorization.resourceHash,
                authorization.orderedInputRoot,
                authorization.applyPlanData1,
                authorization.applyPlanData2,
                authorization.feeLimitSnapshot
            )
        );
        return
            keccak256(
                abi.encode(
                    P2TRAuthorization.ReservationProtocolID,
                    domainChainID,
                    bridge,
                    address(this),
                    frostRegistry,
                    proposalValidator,
                    walletScopeHash,
                    lockedPlanHash
                )
            );
    }

    function preAuthorizationDigest(
        PreAuthorization calldata authorization,
        bytes32 transactionHash,
        bytes32 authorizationRoot
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    P2TRAuthorization.ReservationProtocolID,
                    P2TRAuthorization.SigningPolicyHash,
                    domainChainID,
                    bridge,
                    address(this),
                    frostRegistry,
                    proposalValidator,
                    _reservationID(authorization),
                    transactionHash,
                    authorization.applyPlanHash,
                    authorizationRoot
                )
            );
    }

    /// @notice Atomically verifies a threshold of wallet-seat attestations and
    ///         permanently registers every exact DEFAULT/no-annex input digest
    ///         before any Bitcoin signature may be released.
    function registerPreAuthorizedTransaction(
        PreAuthorization calldata authorization,
        BitcoinTx.Info calldata transaction,
        uint64[] calldata inputValues,
        bytes32[] calldata signingKeys,
        bytes32[] calldata resourceIDs,
        SeatAttestation calldata attestation
    ) external override returns (bytes32 id, bytes32 transactionHash) {
        require(msg.sender == bridge, "Caller is not Bridge");
        require(block.chainid == domainChainID, "Chain domain changed");
        require(
            authorization.action > 0 && authorization.action <= 4,
            "Unknown reservation action"
        );
        require(
            authorization.walletID != bytes32(0),
            "Wallet ID cannot be zero"
        );
        require(
            authorization.walletPubKeyHash != bytes20(0),
            "Wallet public key hash cannot be zero"
        );
        require(
            authorization.membersIDsHash ==
                keccak256(abi.encode(attestation.walletMembersIDs)),
            "Wallet members hash mismatch"
        );
        require(
            authorization.snapshotHash != bytes32(0),
            "Snapshot hash cannot be zero"
        );
        require(
            authorization.resourceHash != bytes32(0),
            "Resource hash cannot be zero"
        );
        require(
            authorization.orderedInputRoot != bytes32(0),
            "Ordered input root cannot be zero"
        );
        require(
            authorization.applyPlanHash != bytes32(0),
            "Apply plan hash cannot be zero"
        );
        _validateResourceIDs(authorization.resourceHash, resourceIDs);

        bytes32 authorizationRoot = _computeAuthorizationRoot(
            authorization.walletID,
            transaction,
            inputValues,
            signingKeys
        );
        transactionHash = _transactionHash(transaction);
        id = _reservationID(authorization);

        bytes32 digest = _preAuthorizationDigest(
            authorization,
            transactionHash,
            authorizationRoot
        );
        _verifySeatAttestations(
            authorization.walletPubKeyHash,
            authorization.walletID,
            digest,
            attestation
        );

        _registerAuthorizations(
            authorization.walletID,
            transaction,
            inputValues,
            signingKeys
        );

        _storeReservation(
            authorization,
            id,
            transactionHash,
            authorizationRoot,
            resourceIDs
        );

        _emitPreAuthorization(
            authorization,
            id,
            transactionHash,
            authorizationRoot
        );
    }

    function _transactionHash(BitcoinTx.Info calldata transaction)
        internal
        view
        returns (bytes32)
    {
        return
            abi
                .encodePacked(
                    transaction.version,
                    transaction.inputVector,
                    transaction.outputVector,
                    transaction.locktime
                )
                .hash256View();
    }

    function _reservationID(PreAuthorization calldata authorization)
        internal
        view
        returns (bytes32)
    {
        return reservationID(authorization);
    }

    function _preAuthorizationDigest(
        PreAuthorization calldata authorization,
        bytes32 transactionHash,
        bytes32 authorizationRoot
    ) internal view returns (bytes32) {
        return
            preAuthorizationDigest(
                authorization,
                transactionHash,
                authorizationRoot
            );
    }

    function _emitPreAuthorization(
        PreAuthorization calldata authorization,
        bytes32 id,
        bytes32 transactionHash,
        bytes32 authorizationRoot
    ) internal {
        emit P2TRPreSigningReservationAuthorized(
            id,
            transactionHash,
            authorization.walletID,
            authorizationRoot,
            authorization.snapshotHash,
            authorization.resourceHash,
            authorization.action
        );
    }

    function _validateResourceIDs(
        bytes32 expectedResourceHash,
        bytes32[] calldata resourceIDs
    ) internal pure {
        require(resourceIDs.length > 0, "No reserved resources");
        require(resourceIDs.length <= 64, "Too many reserved resources");
        for (uint256 i = 0; i < resourceIDs.length; i++) {
            require(resourceIDs[i] != bytes32(0), "Resource ID cannot be zero");
            if (i > 0) {
                require(
                    resourceIDs[i - 1] < resourceIDs[i],
                    "Resource IDs must be unique and sorted"
                );
            }
        }
        require(
            keccak256(abi.encode(resourceIDs)) == expectedResourceHash,
            "Resource hash mismatch"
        );
    }

    function _storeReservation(
        PreAuthorization calldata authorization,
        bytes32 id,
        bytes32 transactionHash,
        bytes32 variantAuthorizationRoot,
        bytes32[] calldata resourceIDs
    ) internal {
        AuthorizedVariant storage existingVariant = authorizedVariants[
            transactionHash
        ];
        if (existingVariant.authorized) {
            require(
                existingVariant.reservationID == id &&
                    existingVariant.authorizationRoot ==
                    variantAuthorizationRoot &&
                    existingVariant.applyPlanHash ==
                    authorization.applyPlanHash,
                "Transaction variant already bound"
            );
            require(
                reservations[id].status == ReservationStatus.Active,
                "Reservation is not active"
            );
            return;
        }

        bytes32 activeID = activeReservationByWallet[
            authorization.walletPubKeyHash
        ];
        if (activeID == bytes32(0)) {
            require(
                reservations[id].status == ReservationStatus.Unknown,
                "Reservation already settled"
            );
            reservations[id] = Reservation(
                authorization.walletID,
                authorization.walletPubKeyHash,
                authorization.membersIDsHash,
                authorization.snapshotHash,
                authorization.resourceHash,
                authorization.orderedInputRoot,
                authorization.applyPlanData1,
                authorization.applyPlanData2,
                authorization.feeLimitSnapshot,
                authorization.action,
                ReservationStatus.Active
            );
            activeReservationByWallet[authorization.walletPubKeyHash] = id;
            require(
                activeReservationIndexPlusOne[id] == 0,
                "Reservation set index already exists"
            );
            activeReservationIDs.push(id);
            activeReservationIndexPlusOne[id] = activeReservationIDs.length;
            activeReservationSetVersion++;

            for (uint256 i = 0; i < resourceIDs.length; i++) {
                require(
                    resourceReservation[resourceIDs[i]] == bytes32(0),
                    "Signing resource already reserved"
                );
                resourceReservation[resourceIDs[i]] = id;
                reservationResources[id].push(resourceIDs[i]);
            }

            emit P2TRActiveReservationAccountingUpdated(
                id,
                true,
                activeReservationIDs.length,
                activeReservationSetVersion
            );
        } else {
            require(activeID == id, "Wallet has another active reservation");
            require(
                reservations[id].status == ReservationStatus.Active,
                "Reservation is not active"
            );
            require(
                reservationResources[id].length == resourceIDs.length,
                "Replacement resource set mismatch"
            );
            for (uint256 i = 0; i < resourceIDs.length; i++) {
                require(
                    resourceReservation[resourceIDs[i]] == id &&
                        reservationResources[id][i] == resourceIDs[i],
                    "Replacement resource set mismatch"
                );
            }
        }

        authorizedVariantCount++;
        authorizedVariants[transactionHash] = AuthorizedVariant(
            id,
            variantAuthorizationRoot,
            authorization.applyPlanHash,
            authorizedVariantCount,
            true
        );
        latestVariantByReservation[id] = transactionHash;
        emit P2TRAuthorizedVariantAdvanced(
            id,
            transactionHash,
            authorizedVariantCount
        );
    }

    function settleAuthorizedProof(
        bytes32 id,
        bytes32 transactionHash
    ) external override returns (bytes20 walletPubKeyHash) {
        require(msg.sender == bridge, "Caller is not Bridge");
        Reservation storage reservation = reservations[id];
        require(
            reservation.status == ReservationStatus.Active,
            "Reservation is not active"
        );

        AuthorizedVariant storage variant = authorizedVariants[
            transactionHash
        ];
        require(
            variant.authorized &&
                variant.reservationID == id,
            "Transaction variant is not authorized"
        );

        walletPubKeyHash = reservation.walletPubKeyHash;
        reservation.status = ReservationStatus.Settled;
        _releaseResources(id, walletPubKeyHash);

        emit P2TRPreSigningReservationSettled(
            id,
            transactionHash,
            reservation.walletID
        );
    }

    /// @notice Settles an SPV-authenticated spend of a locked resource that is
    ///         not one of the reservation's additive authorized variants.
    /// @dev The caller supplies one resource derived directly from the proven
    ///      Bitcoin input/output. The registry resolves all remaining locks
    ///      from its own permanent resource list; caller-provided metadata
    ///      cannot choose which reservation is released.
    function settleConflictingProof(
        bytes32 transactionHash,
        bytes32 spentResourceID
    )
        external
        override
        returns (bytes32 id, bytes20 walletPubKeyHash)
    {
        require(msg.sender == bridge, "Caller is not Bridge");
        id = resourceReservation[spentResourceID];
        require(id != bytes32(0), "Resource is not reserved");

        Reservation storage reservation = reservations[id];
        require(
            reservation.status == ReservationStatus.Active,
            "Reservation is not active"
        );
        AuthorizedVariant storage variant = authorizedVariants[
            transactionHash
        ];
        require(
            !variant.authorized || variant.reservationID != id,
            "Authorized variant is not a conflict"
        );

        walletPubKeyHash = reservation.walletPubKeyHash;
        reservation.status = ReservationStatus.Conflicted;
        _releaseResources(id, walletPubKeyHash);

        emit P2TRPreSigningReservationConflicted(
            id,
            transactionHash,
            reservation.walletID,
            spentResourceID
        );
    }

    function _releaseResources(bytes32 id, bytes20 walletPubKeyHash)
        internal
    {
        bytes32[] storage resources = reservationResources[id];
        for (uint256 i = 0; i < resources.length; i++) {
            require(
                resourceReservation[resources[i]] == id,
                "Reserved resource mismatch"
            );
            delete resourceReservation[resources[i]];
        }
        require(
            activeReservationByWallet[walletPubKeyHash] == id,
            "Active reservation mismatch"
        );
        delete activeReservationByWallet[walletPubKeyHash];
        uint256 indexPlusOne = activeReservationIndexPlusOne[id];
        require(indexPlusOne != 0, "Active reservation index missing");
        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = activeReservationIDs.length - 1;
        if (index != lastIndex) {
            bytes32 lastID = activeReservationIDs[lastIndex];
            activeReservationIDs[index] = lastID;
            activeReservationIndexPlusOne[lastID] = indexPlusOne;
        }
        activeReservationIDs.pop();
        delete activeReservationIndexPlusOne[id];
        activeReservationSetVersion++;
        emit P2TRActiveReservationAccountingUpdated(
            id,
            false,
            activeReservationIDs.length,
            activeReservationSetVersion
        );
    }

    /// @notice Exact number of currently active reservations.
    function activeReservationCount()
        external
        view
        override
        returns (uint256)
    {
        return activeReservationIDs.length;
    }

    /// @notice Returns one member of the authoritative enumerable active set.
    /// @dev Consumers must pin all enumeration calls to one block tag. The
    ///      order is authoritative for that state but may change when an entry
    ///      is removed because removal uses swap-and-pop.
    function activeReservationAt(uint256 index)
        external
        view
        override
        returns (bytes32)
    {
        require(index < activeReservationIDs.length, "Index out of bounds");
        return activeReservationIDs[index];
    }

    function hasActiveReservation(bytes20 walletPubKeyHash)
        external
        view
        override
        returns (bool)
    {
        return activeReservationByWallet[walletPubKeyHash] != bytes32(0);
    }

    function isResourceReserved(bytes32 resourceID)
        external
        view
        override
        returns (bool)
    {
        return resourceReservation[resourceID] != bytes32(0);
    }

    /// @notice Stable reservation read ABI. Bitcoin transaction hashes and
    ///         outpoint hashes embedded in the referenced resource IDs use raw
    ///         Bitcoin internal byte order, exactly as serialized on the wire.
    function getReservation(bytes32 id)
        external
        view
        override
        returns (
            bytes32 walletID,
            bytes20 walletPubKeyHash,
            bytes32 membersIDsHash,
            bytes32 snapshotHash,
            bytes32 resourceHash,
            bytes32 orderedInputRoot,
            bytes32 applyPlanData1,
            bytes32 applyPlanData2,
            uint64 feeLimitSnapshot,
            uint8 action,
            uint8 status
        )
    {
        Reservation storage reservation = reservations[id];
        return (
            reservation.walletID,
            reservation.walletPubKeyHash,
            reservation.membersIDsHash,
            reservation.snapshotHash,
            reservation.resourceHash,
            reservation.orderedInputRoot,
            reservation.applyPlanData1,
            reservation.applyPlanData2,
            reservation.feeLimitSnapshot,
            reservation.action,
            uint8(reservation.status)
        );
    }

    function getAuthorizedVariant(bytes32 transactionHash)
        external
        view
        returns (
            bytes32 reservationID_,
            bytes32 authorizationRoot,
            bytes32 applyPlanHash,
            bool authorized
        )
    {
        AuthorizedVariant storage variant = authorizedVariants[
            transactionHash
        ];
        return (
            variant.reservationID,
            variant.authorizationRoot,
            variant.applyPlanHash,
            variant.authorized
        );
    }

    /// @notice Exact current-state variant read for signers and broadcasters.
    /// @dev `fraudDefenseAuthorized` is permanent once set. In contrast,
    ///      `signingAllowed` is true only for the newest variant of a live
    ///      reservation. Consumers must read this at their execution block;
    ///      historical/pinned authorization alone must never release shares.
    function getAuthorizedVariantStatus(bytes32 transactionHash)
        external
        view
        override
        returns (
            bytes32 reservationID_,
            bytes32 authorizationRoot,
            bytes32 applyPlanHash,
            uint256 authorizationSequence,
            bool fraudDefenseAuthorized,
            bool signingAllowed
        )
    {
        AuthorizedVariant storage variant = authorizedVariants[
            transactionHash
        ];
        fraudDefenseAuthorized = variant.authorized;
        reservationID_ = variant.reservationID;
        authorizationRoot = variant.authorizationRoot;
        applyPlanHash = variant.applyPlanHash;
        authorizationSequence = variant.authorizationSequence;
        signingAllowed =
            fraudDefenseAuthorized &&
            latestVariantByReservation[reservationID_] == transactionHash &&
            reservations[reservationID_].status == ReservationStatus.Active;
    }

    function latestAuthorizedVariant(bytes32 id)
        external
        view
        override
        returns (
            bytes32 transactionHash,
            uint256 authorizationSequence,
            bool signingAllowed
        )
    {
        transactionHash = latestVariantByReservation[id];
        AuthorizedVariant storage variant = authorizedVariants[
            transactionHash
        ];
        authorizationSequence = variant.authorizationSequence;
        signingAllowed =
            transactionHash != bytes32(0) &&
            variant.reservationID == id &&
            reservations[id].status == ReservationStatus.Active;
    }

    function activeReservation(bytes20 walletPubKeyHash)
        external
        view
        override
        returns (bytes32)
    {
        return activeReservationByWallet[walletPubKeyHash];
    }

    function reservationForResource(bytes32 resourceID)
        external
        view
        returns (bytes32)
    {
        return resourceReservation[resourceID];
    }

    function getReservationResourceCount(bytes32 id)
        external
        view
        returns (uint256)
    {
        return reservationResources[id].length;
    }

    function getReservationResource(bytes32 id, uint256 index)
        external
        view
        returns (bytes32)
    {
        return reservationResources[id][index];
    }

    function transactionHash(BitcoinTx.Info calldata transaction)
        external
        view
        returns (bytes32)
    {
        return _transactionHash(transaction);
    }

    function authorizationRoot(
        bytes32 walletID,
        BitcoinTx.Info calldata transaction,
        uint64[] calldata inputValues,
        bytes32[] calldata signingKeys
    ) external view returns (bytes32) {
        return
            _computeAuthorizationRoot(
                walletID,
                transaction,
                inputValues,
                signingKeys
            );
    }

    function _registerAuthorizations(
        bytes32 walletID,
        BitcoinTx.Info calldata transaction,
        uint64[] calldata inputValues,
        bytes32[] calldata signingKeys
    ) internal {

        TransactionAggregateHashes memory hashes = _computeTransactionHashes(
            transaction,
            inputValues,
            signingKeys
        );

        for (uint256 i = 0; i < hashes.inputsCount; i++) {
            P2TRAuthorization.Context memory context = P2TRAuthorization
                .Context(
                    transaction.version,
                    transaction.locktime,
                    uint32(i),
                    hashes.hashPrevouts,
                    hashes.hashAmounts,
                    hashes.hashScriptPubKeys,
                    hashes.hashSequences,
                    hashes.hashOutputs
                );

            bytes32 sighash = P2TRAuthorization.computeDefaultSighash(context);
            bytes32 challengeIdentity = P2TRAuthorization.challengeIdentity(
                domainChainID,
                bridge,
                walletID,
                signingKeys[i],
                sighash
            );

            uint256 authorizationSequence = authorizationSequenceByChallengeIdentity[
                    challengeIdentity
                ];
            if (authorizationSequence == 0) {
                require(
                    !authorizedChallengeIdentities[challengeIdentity],
                    "Authorization accounting mismatch"
                );
                authorizedChallengeIdentities[challengeIdentity] = true;
                authorizedChallengeIdentityCount++;
                authorizationSequence = authorizedChallengeIdentityCount;
                authorizationSequenceByChallengeIdentity[
                    challengeIdentity
                ] = authorizationSequence;
            } else {
                require(
                    authorizedChallengeIdentities[challengeIdentity],
                    "Authorization accounting mismatch"
                );
            }

            emit P2TRAuthorizationRegistered(
                challengeIdentity,
                P2TRAuthorization.hashContext(context),
                walletID,
                signingKeys[i],
                sighash,
                uint32(i),
                authorizationSequence
            );
        }
    }

    function _computeAuthorizationRoot(
        bytes32 walletID,
        BitcoinTx.Info calldata transaction,
        uint64[] calldata inputValues,
        bytes32[] calldata signingKeys
    ) internal view returns (bytes32) {
        TransactionAggregateHashes memory hashes = _computeTransactionHashes(
            transaction,
            inputValues,
            signingKeys
        );
        bytes32[] memory identities = new bytes32[](hashes.inputsCount);

        for (uint256 i = 0; i < hashes.inputsCount; i++) {
            P2TRAuthorization.Context memory context = P2TRAuthorization
                .Context(
                    transaction.version,
                    transaction.locktime,
                    uint32(i),
                    hashes.hashPrevouts,
                    hashes.hashAmounts,
                    hashes.hashScriptPubKeys,
                    hashes.hashSequences,
                    hashes.hashOutputs
                );
            identities[i] = P2TRAuthorization.challengeIdentity(
                domainChainID,
                bridge,
                walletID,
                signingKeys[i],
                P2TRAuthorization.computeDefaultSighash(context)
            );
        }

        return keccak256(abi.encode(identities));
    }

    function _verifySeatAttestations(
        bytes20 walletPubKeyHash,
        bytes32 walletID,
        bytes32 digest,
        SeatAttestation calldata attestation
    ) internal view {
        uint256 signaturesCount = attestation.signingMemberIndices.length;
        require(
            signaturesCount == groupThreshold,
            "Exactly 51 seat signatures required"
        );
        require(
            attestation.signatures.length ==
                signaturesCount * signatureByteSize,
            "Malformed signatures array"
        );

        address[] memory signingMembers = _resolveSigningMembers(
            walletPubKeyHash,
            walletID,
            attestation.walletMembersIDs,
            attestation.signingMemberIndices
        );
        _verifyRecoveredSignatures(
            digest,
            attestation.signatures,
            signingMembers
        );
    }

    function _resolveSigningMembers(
        bytes20 walletPubKeyHash,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs,
        uint8[] calldata signingMemberIndices
    ) internal view returns (address[] memory signingMembers) {
        require(
            walletMembersIDs.length >= groupThreshold &&
                walletMembersIDs.length <= maximumGroupSize,
            "Wallet seat count out of range"
        );

        (
            address frostRegistryAddress,
            bytes32 bridgeWalletID
        ) = IBridgeForP2TRPreAuthorization(bridge).frostLifecycleContext(
                walletPubKeyHash
            );
        require(
            frostRegistryAddress == frostRegistry &&
                bridgeWalletID == walletID,
            "Invalid FROST wallet binding"
        );

        (
            bytes32 membersIdsHash,
            bytes32 xOnlyOutputKey
        ) = IFrostRegistryForP2TRPreAuthorization(frostRegistry)
                .getWallet(walletID);
        require(xOnlyOutputKey == walletID, "FROST wallet is not registered");
        require(
            membersIdsHash == keccak256(abi.encode(walletMembersIDs)),
            "Invalid wallet members identifiers"
        );

        uint32[] memory signingMemberIDs = new uint32[](
            signingMemberIndices.length
        );
        uint256 previousIndex;
        for (uint256 i = 0; i < signingMemberIndices.length; i++) {
            uint256 memberIndex = signingMemberIndices[i];
            require(
                memberIndex > previousIndex &&
                    memberIndex <= walletMembersIDs.length,
                "Corrupted signing member indices"
            );
            signingMemberIDs[i] = walletMembersIDs[memberIndex - 1];
            previousIndex = memberIndex;
        }

        address sortitionPool = IFrostRegistryForP2TRPreAuthorization(
            frostRegistry
        ).sortitionPool();
        require(sortitionPool != address(0), "Sortition pool is not set");
        signingMembers = ISortitionPoolForP2TRPreAuthorization(sortitionPool)
            .getIDOperators(signingMemberIDs);
        require(
            signingMembers.length == signingMemberIndices.length,
            "Unexpected signing members count"
        );
    }

    function _verifyRecoveredSignatures(
        bytes32 digest,
        bytes calldata signatures,
        address[] memory signingMembers
    ) internal pure {
        bytes32 signedDigest = digest.toEthSignedMessageHash();
        for (uint256 i = 0; i < signingMembers.length; i++) {
            bytes memory signature = signatures.slice(
                i * signatureByteSize,
                signatureByteSize
            );
            require(
                signedDigest.recover(signature) == signingMembers[i],
                "Invalid seat signature"
            );
        }
    }

    function _computeTransactionHashes(
        BitcoinTx.Info calldata transaction,
        uint64[] calldata inputValues,
        bytes32[] calldata signingKeys
    ) internal pure returns (TransactionAggregateHashes memory result) {
        bytes memory inputVector = transaction.inputVector;
        require(inputVector.validateVin(), "Invalid transaction input vector");
        (, uint256 inputsCount) = inputVector.parseVarInt();
        require(inputsCount > 0, "No transaction inputs");
        require(
            inputsCount <= maximumAuthorizedInputs,
            "Too many transaction inputs"
        );
        require(
            inputValues.length == inputsCount,
            "Input value count mismatch"
        );
        require(
            signingKeys.length == inputsCount,
            "Signing key count mismatch"
        );

        InputAggregateHashes memory inputHashes = _computeInputAggregateHashes(
            inputVector,
            inputValues,
            signingKeys
        );

        bytes memory outputVector = transaction.outputVector;
        require(
            outputVector.validateVout(),
            "Invalid transaction output vector"
        );
        (uint256 outputCountDataLength, uint256 outputsCount) = outputVector
            .parseVarInt();
        require(outputsCount > 0, "No transaction outputs");
        uint256 outputSerializationOffset = 1 + outputCountDataLength;

        result.inputsCount = inputsCount;
        result.hashPrevouts = inputHashes.hashPrevouts;
        result.hashAmounts = inputHashes.hashAmounts;
        result.hashScriptPubKeys = inputHashes.hashScriptPubKeys;
        result.hashSequences = inputHashes.hashSequences;
        result.hashOutputs = sha256(
            outputVector.slice(
                outputSerializationOffset,
                outputVector.length - outputSerializationOffset
            )
        );
    }

    function _computeInputAggregateHashes(
        bytes memory inputVector,
        uint64[] calldata inputValues,
        bytes32[] calldata signingKeys
    ) internal pure returns (InputAggregateHashes memory result) {
        (uint256 inputCountDataLength, uint256 inputsCount) = inputVector
            .parseVarInt();
        uint256 inputOffset = 1 + inputCountDataLength;
        InputSerializations memory serialized;
        serialized.outpoints = new bytes[](inputsCount);
        serialized.amounts = new bytes[](inputsCount);
        serialized.scriptPubKeys = new bytes[](inputsCount);
        serialized.sequences = new bytes[](inputsCount);

        for (uint256 i = 0; i < inputsCount; i++) {
            bytes32 signingKey = signingKeys[i];
            require(signingKey != bytes32(0), "Signing key cannot be zero");

            uint256 inputLength = inputVector.determineInputLengthAt(
                inputOffset
            );
            require(
                inputVector[inputOffset + 36] == bytes1(0) && inputLength == 41,
                "P2TR input scriptSig must be empty"
            );

            serialized.outpoints[i] = inputVector.slice(inputOffset, 36);
            serialized.amounts[i] = P2TRSignatureFraud.uint64LE(inputValues[i]);
            serialized.scriptPubKeys[i] = abi.encodePacked(
                bytes1(0x22),
                bytes1(0x51),
                bytes1(0x20),
                signingKey
            );
            serialized.sequences[i] = abi.encodePacked(
                inputVector.slice4(inputOffset + 37)
            );

            inputOffset += inputLength;
        }
        require(
            inputOffset == inputVector.length,
            "Trailing transaction input data"
        );

        result.hashPrevouts = sha256(
            CheckBitcoinBIP341Sighash.concat(serialized.outpoints)
        );
        result.hashAmounts = sha256(
            CheckBitcoinBIP341Sighash.concat(serialized.amounts)
        );
        result.hashScriptPubKeys = sha256(
            CheckBitcoinBIP341Sighash.concat(serialized.scriptPubKeys)
        );
        result.hashSequences = sha256(
            CheckBitcoinBIP341Sighash.concat(serialized.sequences)
        );
    }
}
