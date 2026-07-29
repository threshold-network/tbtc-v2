// SPDX-License-Identifier: GPL-3.0-only
//
// ▓▓▌ ▓▓ ▐▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▄
// ▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
//   ▓▓▓▓▓▓    ▓▓▓▓▓▓▓▀    ▐▓▓▓▓▓▓    ▐▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
//   ▓▓▓▓▓▓▄▄▓▓▓▓▓▓▓▀      ▐▓▓▓▓▓▓▄▄▄▄         ▓▓▓▓▓▓▄▄▄▄         ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
//   ▓▓▓▓▓▓▓▓▓▓▓▓▓▀        ▐▓▓▓▓▓▓▓▓▓▓         ▓▓▓▓▓▓▓▓▓▓         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
//   ▓▓▓▓▓▓▀▀▓▓▓▓▓▓▄       ▐▓▓▓▓▓▓▀▀▀▀         ▓▓▓▓▓▓▀▀▀▀         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▀
//   ▓▓▓▓▓▓   ▀▓▓▓▓▓▓▄     ▐▓▓▓▓▓▓     ▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌
// ▓▓▓▓▓▓▓▓▓▓ █▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
// ▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
//
//                           Trust math, not hardware.

// Initial version copied from Keep Network Random Beacon:
// https://github.com/keep-network/keep-core/blob/5138c7628868dbeed3ae2164f76fccc6c1fbb9e8/solidity/random-beacon/contracts/DKGValidator.sol
//
// With the following differences:
// - group public key length,
// - group size and related thresholds,
// - documentation.

pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@keep-network/random-beacon/contracts/libraries/BytesLib.sol";
import "@keep-network/sortition-pools/contracts/SortitionPool.sol";
import "./libraries/FrostDkg.sol";

/// @title DKG result validator
/// @notice FrostDkgValidator allows performing a full validation of DKG result,
///         including checking the format of fields in the result, declared
///         selected group members, and signatures of operators supporting the
///         result. The operator submitting the result should perform the
///         validation using a free contract call before submitting the result
///         to ensure their result is valid and can not be challenged. All other
///         network operators should perform validation of the submitted result
///         using a free contract call and challenge the result if the
///         validation fails.
contract FrostDkgValidator {
    using BytesLib for bytes;
    using ECDSA for bytes32;

    /// @dev Size of a group in DKG.
    uint256 public constant groupSize = 100;

    /// @dev The minimum number of group members needed to interact according to
    ///      the protocol to produce a signature. The adversary can not learn
    ///      anything about the key as long as it does not break into
    ///      groupThreshold+1 of members.
    uint256 public constant groupThreshold = 51;

    /// @dev The minimum number of active and properly behaving group members
    ///      during the DKG needed to accept the result. This number is higher
    ///      than `groupThreshold` to keep a safety margin for members becoming
    ///      inactive after DKG so that the group can still produce signature.
    uint256 public constant activeThreshold = 90; // 90% of groupSize

    /// @dev Size in bytes of the FROST x-only Taproot output key
    ///      produced by group members during DKG (BIP-340 / BIP-341).
    uint256 public constant publicKeyByteSize = 32;

    /// @dev Size in bytes of a single signature produced by operator supporting
    ///      DKG result.
    uint256 public constant signatureByteSize = 65;

    SortitionPool public immutable sortitionPool;

    constructor(SortitionPool _sortitionPool) {
        sortitionPool = _sortitionPool;
    }

    /// @notice Performs a full validation of DKG result, including checking the
    ///         format of fields in the result, declared selected group members,
    ///         and signatures of operators supporting the result.
    /// @param seed seed used to start the DKG and select group members
    /// @param startBlock DKG start block
    /// @return isValid true if the result is valid, false otherwise
    /// @return errorMsg validation error message; empty for a valid result
    function validate(
        FrostDkg.Result calldata result,
        uint256 seed,
        uint256 startBlock,
        address bridge,
        address registry
    ) external view returns (bool isValid, string memory errorMsg) {
        (bool hasValidFields, string memory error) = validateFields(result);
        if (!hasValidFields) {
            return (false, error);
        }

        // validateGroupMembers enforces members.length == groupSize and must
        // run before validateSignatures, which indexes result.members by the
        // [1, groupSize]-bounded signing member indices -- a shorter members
        // array would otherwise cause an out-of-bounds read here.
        if (!validateGroupMembers(result, seed)) {
            return (false, "Invalid group members");
        }

        if (
            !validateSignatures(
                result,
                seed,
                startBlock,
                DigestBinding({bridge: bridge, registry: registry})
            )
        ) {
            return (false, "Invalid signatures");
        }

        // At this point all group members and misbehaved members were verified
        if (!validateMembersHash(result)) {
            return (false, "Invalid members hash");
        }

        return (true, "");
    }

    /// @notice Performs a static validation of DKG result fields: lengths,
    ///         ranges, and order of arrays.
    /// @return isValid true if the result is valid, false otherwise
    /// @return errorMsg validation error message; empty for a valid result
    function validateFields(FrostDkg.Result calldata result)
        public
        pure
        returns (bool isValid, string memory errorMsg)
    {
        // FROST x-only output key is bytes32; the only structural
        // failure mode is the zero value (no possibility of length
        // mismatch as it's a fixed-size type). Treat zero as a
        // sentinel — operators should never sign a DKG result that
        // produced the zero key.
        if (result.xOnlyOutputKey == bytes32(0)) {
            return (false, "Malformed x-only output key");
        }

        // The number of misbehaved members can not exceed the threshold.
        // Misbehaved member indices needs to be unique, between [1, groupSize],
        // and sorted in ascending order.
        uint8[] calldata misbehavedMembersIndices = result
            .misbehavedMembersIndices;
        if (groupSize - misbehavedMembersIndices.length < activeThreshold) {
            return (false, "Too many members misbehaving during DKG");
        }
        if (misbehavedMembersIndices.length > 0) {
            if (
                misbehavedMembersIndices[0] < 1 ||
                misbehavedMembersIndices[misbehavedMembersIndices.length - 1] >
                groupSize
            ) {
                return (false, "Corrupted misbehaved members indices");
            }
            for (uint256 i = 1; i < misbehavedMembersIndices.length; i++) {
                if (
                    misbehavedMembersIndices[i - 1] >=
                    misbehavedMembersIndices[i]
                ) {
                    return (false, "Corrupted misbehaved members indices");
                }
            }
        }

        // Each signature needs to have a correct length and signatures need to
        // be provided.
        uint256 signaturesCount = result.signatures.length / signatureByteSize;
        if (result.signatures.length == 0) {
            return (false, "No signatures provided");
        }
        if (result.signatures.length % signatureByteSize != 0) {
            return (false, "Malformed signatures array");
        }

        // We expect the same amount of signatures as the number of declared
        // group member indices that signed the result.
        uint256[] calldata signingMembersIndices = result.signingMembersIndices;
        if (signaturesCount != signingMembersIndices.length) {
            return (false, "Unexpected signatures count");
        }
        if (signaturesCount < groupThreshold) {
            return (false, "Too few signatures");
        }
        if (signaturesCount > groupSize) {
            return (false, "Too many signatures");
        }

        // Signing member indices needs to be unique, between [1,groupSize],
        // and sorted in ascending order.
        if (
            signingMembersIndices[0] < 1 ||
            signingMembersIndices[signingMembersIndices.length - 1] > groupSize
        ) {
            return (false, "Corrupted signing member indices");
        }
        for (uint256 i = 1; i < signingMembersIndices.length; i++) {
            if (signingMembersIndices[i - 1] >= signingMembersIndices[i]) {
                return (false, "Corrupted signing member indices");
            }
        }

        return (true, "");
    }

    /// @notice Performs validation of group members as declared in DKG
    ///         result against group members selected by the sortition pool.
    /// @param seed seed used to start the DKG and select group members
    /// @return true if group members matches; false otherwise
    function validateGroupMembers(FrostDkg.Result calldata result, uint256 seed)
        public
        view
        returns (bool)
    {
        uint32[] calldata resultMembers = result.members;
        uint32[] memory actualGroupMembers = sortitionPool.selectGroup(
            groupSize,
            bytes32(seed)
        );
        if (resultMembers.length != actualGroupMembers.length) {
            return false;
        }
        for (uint256 i = 0; i < resultMembers.length; i++) {
            if (resultMembers[i] != actualGroupMembers[i]) {
                return false;
            }
        }
        return true;
    }

    /// @notice Computes the RFC v4 DKG result digest. Exposed as a
    ///         view so the off-chain B-2 coordinator can read the
    ///         exact bytes the on-chain validator will compare
    ///         against (preventing format drift between off-chain
    ///         signature collection and on-chain verification).
    /// @param result DKG result.
    /// @param seed Random beacon seed (bound to the request).
    /// @param bridge Bridge contract address.
    /// @param registry FrostWalletRegistry address.
    /// @return digest The pre-EIP-191 keccak256 digest.
    function resultDigest(
        FrostDkg.Result calldata result,
        uint256 seed,
        address bridge,
        address registry
    ) public view returns (bytes32 digest) {
        digest = keccak256(
            abi.encode(
                "tbtc-frost-dkg-result-v1",
                block.chainid,
                bridge,
                registry,
                seed,
                result.xOnlyOutputKey,
                keccak256(abi.encode(result.members)),
                keccak256(abi.encode(result.misbehavedMembersIndices))
            )
        );
    }

    /// @notice Performs validation of signatures supplied in DKG result.
    ///         Note that this function does not check if addresses which
    ///         supplied signatures supporting the result are the ones selected
    ///         to the group by sortition pool. This function should be used
    ///         together with `validateGroupMembers`.
    /// @param result DKG result.
    /// @param seed Random beacon seed that bound the result to a
    ///        specific request (also baked into the digest).
    /// @param bridge Bridge contract address (digest binding).
    /// @param registry FrostWalletRegistry address (digest binding).
    /// @return true if signatures match; false otherwise.
    /// @dev `startBlock` is intentionally accepted but unused — the
    ///      RFC v4 digest binds to (chainid, bridge, registry, seed,
    ///      xOnlyOutputKey, membersHash, misbehavedHash) rather than
    ///      the start block; the start block is implicit in the
    ///      seed binding.
    /// @dev Bundles the digest-binding addresses so
    ///      `validateSignatures` and `validate` can pass them as
    ///      one slot, keeping the function's local-variable count
    ///      under the EVM stack depth limit.
    struct DigestBinding {
        address bridge;
        address registry;
    }

    function validateSignatures(
        FrostDkg.Result calldata result,
        uint256 seed,
        uint256, /* startBlock */
        DigestBinding memory binding
    ) public view returns (bool) {
        // RFC v4 digest format. See
        // `wallet-registry-trust-model-rfc.md` §"DKG result message
        // format" for the field rationale. The digest is computed
        // in a separate `resultDigest` helper to keep this
        // function's local-variable count under the EVM stack
        // depth limit (the bridge + registry params + the
        // signature-verification locals would otherwise exceed
        // the 16-slot scratch space).
        bytes32 hash = resultDigest(
            result,
            seed,
            binding.bridge,
            binding.registry
        ).toEthSignedMessageHash();

        uint256[] calldata signingMembersIndices = result.signingMembersIndices;
        uint32[] memory signingMemberIds = new uint32[](
            signingMembersIndices.length
        );
        for (uint256 i = 0; i < signingMembersIndices.length; i++) {
            signingMemberIds[i] = result.members[signingMembersIndices[i] - 1];
        }

        address[] memory signingMemberAddresses = sortitionPool.getIDOperators(
            signingMemberIds
        );

        bytes memory current; // Current signature to be checked.

        uint256 signaturesCount = result.signatures.length / signatureByteSize;
        for (uint256 i = 0; i < signaturesCount; i++) {
            current = result.signatures.slice(
                signatureByteSize * i,
                signatureByteSize
            );
            address recoveredAddress = hash.recover(current);

            if (signingMemberAddresses[i] != recoveredAddress) {
                return false;
            }
        }

        return true;
    }

    /// @notice Performs validation of hashed group members that actively took
    ///         part in DKG.
    /// @param result DKG result
    /// @return true if calculated result's group members hash matches with the
    /// one that is challenged.
    function validateMembersHash(FrostDkg.Result calldata result)
        public
        pure
        returns (bool)
    {
        if (result.misbehavedMembersIndices.length > 0) {
            // members that generated a group signing key
            uint32[] memory groupMembers = new uint32[](
                result.members.length - result.misbehavedMembersIndices.length
            );
            uint256 k = 0; // misbehaved members counter
            uint256 j = 0; // group members counter
            for (uint256 i = 0; i < result.members.length; i++) {
                // misbehaved member indices start from 1, so we need to -1 on misbehaved
                if (i != result.misbehavedMembersIndices[k] - 1) {
                    groupMembers[j] = result.members[i];
                    j++;
                } else if (k < result.misbehavedMembersIndices.length - 1) {
                    k++;
                }
            }

            return keccak256(abi.encode(groupMembers)) == result.membersHash;
        }

        return keccak256(abi.encode(result.members)) == result.membersHash;
    }
}
