// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Test-only authorization registry with explicit sequencing and
///         settled-reservation configuration. It lets router tests isolate
///         challenge timing from the threshold-attestation machinery covered
///         by P2TRAuthorizationRegistry tests.
contract P2TRAuthorizationRegistryStub {
    address public immutable bridge;
    uint256 public immutable domainChainID;

    mapping(bytes32 => bool) public authorizedChallengeIdentities;
    mapping(bytes32 => uint256) public authorizationSequenceByChallengeIdentity;
    uint256 public authorizedChallengeIdentityCount;

    struct Variant {
        bytes32 reservationID;
        bytes32 authorizationRoot;
        bytes32 applyPlanHash;
        bool authorized;
    }

    struct Reservation {
        bytes20 walletPubKeyHash;
        uint8 action;
        uint8 status;
    }

    mapping(bytes32 => Variant) private variants;
    mapping(bytes32 => Reservation) private reservations;
    mapping(bytes32 => bytes32) private resourceReservations;

    constructor(address _bridge) {
        bridge = _bridge;
        domainChainID = block.chainid;
    }

    function authorize(bytes32 challengeIdentity) external {
        if (!authorizedChallengeIdentities[challengeIdentity]) {
            authorizedChallengeIdentities[challengeIdentity] = true;
            authorizedChallengeIdentityCount++;
            authorizationSequenceByChallengeIdentity[
                challengeIdentity
            ] = authorizedChallengeIdentityCount;
        }
    }

    /// @notice Test-only hook for modeling an authorization sequence that was
    ///         durably committed before the challenge cutoff but becomes
    ///         observable to the router only after challenge admission.
    function setAuthorizationSequence(
        bytes32 challengeIdentity,
        uint256 authorizationSequence
    ) external {
        authorizedChallengeIdentities[challengeIdentity] =
            authorizationSequence != 0;
        authorizationSequenceByChallengeIdentity[
            challengeIdentity
        ] = authorizationSequence;
    }

    function setSettledVariant(
        bytes32 transactionHash,
        bytes32 reservationID,
        bytes20 walletPubKeyHash,
        uint8 action
    ) external {
        variants[transactionHash] = Variant(
            reservationID,
            bytes32(0),
            bytes32(0),
            true
        );
        reservations[reservationID] = Reservation(walletPubKeyHash, action, 2);
    }

    function setConflictingReservation(
        bytes32 resourceID,
        bytes32 reservationID,
        bytes20 walletPubKeyHash,
        uint8 action
    ) external {
        resourceReservations[resourceID] = reservationID;
        reservations[reservationID] = Reservation(walletPubKeyHash, action, 1);
    }

    function getAuthorizedVariant(bytes32 transactionHash)
        external
        view
        returns (
            bytes32 reservationID,
            bytes32 authorizationRoot,
            bytes32 applyPlanHash,
            bool authorized
        )
    {
        Variant memory variant = variants[transactionHash];
        return (
            variant.reservationID,
            variant.authorizationRoot,
            variant.applyPlanHash,
            variant.authorized
        );
    }

    function getReservation(bytes32 reservationID)
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
        )
    {
        Reservation memory reservation = reservations[reservationID];
        return (
            bytes32(0),
            reservation.walletPubKeyHash,
            bytes32(0),
            bytes32(0),
            bytes32(0),
            bytes32(0),
            bytes32(0),
            bytes32(0),
            0,
            reservation.action,
            reservation.status
        );
    }

    function hasActiveReservation(bytes20) external pure returns (bool) {
        return false;
    }

    function reservationForResource(bytes32 resourceID)
        external
        view
        returns (bytes32)
    {
        return resourceReservations[resourceID];
    }

    function settleConflictingProof(bytes32, bytes32 spentResourceID)
        external
        returns (bytes32 reservationID, bytes20 walletPubKeyHash)
    {
        require(msg.sender == bridge, "Caller is not Bridge");
        reservationID = resourceReservations[spentResourceID];
        require(reservationID != bytes32(0), "Resource is not reserved");
        Reservation storage reservation = reservations[reservationID];
        require(reservation.status == 1, "Reservation is not active");
        walletPubKeyHash = reservation.walletPubKeyHash;
        reservation.status = 3;
        delete resourceReservations[spentResourceID];
    }

    function isResourceReserved(bytes32 resourceID)
        external
        view
        returns (bool)
    {
        return resourceReservations[resourceID] != bytes32(0);
    }
}
