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
//

// Initial version copied from Keep Network Random Beacon:
// https://github.com/keep-network/keep-core/blob/5138c7628868dbeed3ae2164f76fccc6c1fbb9e8/solidity/random-beacon/contracts/libraries/DKG.sol
//
// With the following differences:
// - the group size was set to 100,
// - offchainDkgTimeout was removed,
// - submission eligibility verification is not performed on-chain,
// - submission eligibility delay was replaced with a submission timeout,
// - seed timeout notification requires seedTimeout period to pass.

pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import "@keep-network/sortition-pools/contracts/SortitionPool.sol";
import "@keep-network/random-beacon/contracts/libraries/BytesLib.sol";
import "../FrostDkgValidator.sol";

library FrostDkg {
    using BytesLib for bytes;
    using ECDSAUpgradeable for bytes32;

    struct Parameters {
        // Time in blocks during which a seed is expected to be delivered.
        // DKG starts only after a seed is delivered. The time the contract
        // awaits for a seed is not included in the DKG timeout.
        uint256 seedTimeout;
        // Time in blocks during which a submitted result can be challenged.
        uint256 resultChallengePeriodLength;
        // Extra gas required to be left at the end of the challenge DKG result
        // transaction.
        uint256 resultChallengeExtraGas;
        // Time in blocks during which a result is expected to be submitted.
        uint256 resultSubmissionTimeout;
        // Time in blocks during which only the result submitter is allowed to
        // approve it. Once this period ends and the submitter have not approved
        // the result, anyone can do it.
        uint256 submitterPrecedencePeriodLength;
        // This struct doesn't contain `__gap` property as the structure is
        // stored inside `Data` struct, that already have a gap that can be used
        // on upgrade.
    }

    struct Data {
        // Address of the Sortition Pool contract.
        SortitionPool sortitionPool;
        // Address of the FrostDkgValidator contract.
        FrostDkgValidator dkgValidator;
        // DKG parameters. The parameters should persist between DKG executions.
        // They should be updated with dedicated set functions only when DKG is not
        // in progress.
        Parameters parameters;
        // Time in block at which DKG state was locked.
        uint256 stateLockBlock;
        // Time in blocks at which DKG started.
        uint256 startBlock;
        // Seed used to start DKG.
        uint256 seed;
        // Time in blocks that should be added to result submission eligibility
        // delay calculation. Retained for storage and in-flight DKG
        // compatibility; new challenges do not increase this value.
        uint256 resultSubmissionStartBlockOffset;
        // Hash of submitted DKG result.
        bytes32 submittedResultHash;
        // Block number from the moment of the DKG result submission.
        uint256 submittedResultBlock;
        // RFC v4 digest binding: bridge address baked into the
        // DKG result digest the off-chain coordinator + on-chain
        // validator compute. The companion `registry` address
        // (also in the digest) is sourced from `address(this)` at
        // the inlined-library call site — FrostDkg's internal
        // functions execute in the FrostWalletRegistry's context,
        // so `address(this)` evaluates to the registry's address
        // without needing a stored field. (Optimization noted
        // during PR #441 review.)
        address bridge;
        // Start block of the DKG in which an operator's result was successfully
        // challenged. Entries do not need to be iterated or deleted when a DKG
        // completes because every challenged round has a distinct start block.
        mapping(uint32 => uint256) challengedSubmitterDkgStartBlocks;
        // Reserved storage space in case we need to add more variables.
        // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
        // slither-disable-next-line unused-state
        uint256[36] __gap;
    }

    /// @notice DKG result.
    struct Result {
        // Claimed submitter candidate group member index.
        // Must be in range [1, groupSize].
        uint256 submitterMemberIndex;
        // FROST DKG result: the 32-byte x-only Taproot output key
        // produced by the off-chain FROST DKG (BIP-340 / BIP-341).
        // Replaces the ECDSA `bytes groupPubKey` field (64B
        // uncompressed pubkey).
        bytes32 xOnlyOutputKey;
        // Array of misbehaved members indices (disqualified or inactive).
        // Indices must be in range [1, groupSize], unique, and sorted in ascending
        // order.
        uint8[] misbehavedMembersIndices;
        // Concatenation of signatures from members supporting the
        // result. The message each member signs is the v4 RFC
        // (frost-migration/wallet-registry-trust-model-rfc.md)
        // result digest:
        //   keccak256(abi.encode(
        //     "tbtc-frost-dkg-result-v1",
        //     block.chainid,
        //     address(bridge),
        //     address(registry),
        //     seed,
        //     xOnlyOutputKey,
        //     keccak256(abi.encode(members)),
        //     keccak256(abi.encode(misbehavedMembersIndices))
        //   ))
        // EIP-191-prefixed (`\x19Ethereum signed message:\n32` +
        // digest) before signing. The digest is computed by
        // `FrostDkgValidator.resultDigest(...)`. See the RFC for
        // why each field is required for replay safety.
        bytes signatures;
        // Indices of members corresponding to each signature. Indices must be
        // be in range [1, groupSize], unique, and sorted in ascending order.
        uint256[] signingMembersIndices;
        // Identifiers of candidate group members as outputted by the group
        // selection protocol.
        uint32[] members;
        // Keccak256 hash of group members identifiers that actively took part
        // in DKG (excluding IA/DQ members).
        bytes32 membersHash;
        // This struct doesn't contain `__gap` property as the structure is not
        // stored, it is used as a function's calldata argument.
    }

    /// @notice States for phases of group creation. The states doesn't include
    ///         timeouts which should be tracked and notified individually.
    enum State {
        // Group creation is not in progress. It is a state set after group creation
        // completion either by timeout or by a result approval.
        IDLE,
        // Group creation is awaiting the seed and sortition pool is locked.
        AWAITING_SEED,
        // DKG protocol execution is in progress. A result is being calculated
        // by the clients in this state and the contract awaits a result submission.
        // This is a state to which group creation returns in case of a result
        // challenge notification.
        AWAITING_RESULT,
        // DKG result was submitted and awaits an approval or a challenge. If a result
        // gets challenge the state returns to `AWAITING_RESULT`. If a result gets
        // approval the state changes to `IDLE`.
        CHALLENGE
    }

    /// @dev Size of a group in ECDSA wallet.
    uint256 public constant groupSize = 100;

    event DkgStarted(uint256 indexed seed);

    // To recreate the members that actively took part in dkg, the selected members
    // array should be filtered out from misbehavedMembersIndices.
    event DkgResultSubmitted(
        bytes32 indexed resultHash,
        uint256 indexed seed,
        Result result
    );

    event DkgTimedOut();

    event DkgResultApproved(
        bytes32 indexed resultHash,
        address indexed approver
    );

    event DkgResultChallenged(
        bytes32 indexed resultHash,
        address indexed challenger,
        string reason
    );

    event DkgStateLocked();

    event DkgSeedTimedOut();

    error InvalidGroupMembers();
    error SubmitterChallengedForCurrentDkg();

    /// @notice Initializes SortitionPool, FrostDkgValidator, and the
    ///         `bridge` digest-binding address. Can be performed
    ///         only once.
    /// @param _sortitionPool Sortition Pool reference
    /// @param _dkgValidator FrostDkgValidator reference
    /// @param _bridge Bridge contract address (used in the RFC v4
    ///        DKG result digest for cross-deployment replay safety).
    ///        The companion `registry` address is sourced from
    ///        `address(this)` at the inlined-library call sites
    ///        and so is not stored on `Data` (per PR #441 review
    ///        feedback).
    function init(
        Data storage self,
        SortitionPool _sortitionPool,
        FrostDkgValidator _dkgValidator,
        address _bridge
    ) internal {
        require(
            address(self.sortitionPool) == address(0),
            "Sortition Pool address already set"
        );

        require(
            address(self.dkgValidator) == address(0),
            "DKG Validator address already set"
        );

        require(_bridge != address(0), "Bridge address required");

        self.sortitionPool = _sortitionPool;
        self.dkgValidator = _dkgValidator;
        self.bridge = _bridge;
    }

    /// @notice Determines the current state of group creation. It doesn't take
    ///         timeouts into consideration. The timeouts should be tracked and
    ///         notified separately.
    function currentState(Data storage self)
        internal
        view
        returns (State state)
    {
        state = State.IDLE;

        if (self.sortitionPool.isLocked()) {
            state = State.AWAITING_SEED;

            if (self.startBlock > 0) {
                state = State.AWAITING_RESULT;

                if (self.submittedResultBlock > 0) {
                    state = State.CHALLENGE;
                }
            }
        }
    }

    /// @notice Locks the sortition pool and starts awaiting for the
    ///         group creation seed.
    function lockState(Data storage self) internal {
        require(currentState(self) == State.IDLE, "Current state is not IDLE");

        emit DkgStateLocked();

        self.sortitionPool.lock();

        self.stateLockBlock = block.number;
    }

    function start(Data storage self, uint256 seed) internal {
        require(
            currentState(self) == State.AWAITING_SEED,
            "Current state is not AWAITING_SEED"
        );

        emit DkgStarted(seed);

        self.startBlock = block.number;
        self.seed = seed;
    }

    /// @notice Allows to submit a DKG result. The submitted result does not go
    ///         through full validation and before it gets accepted, it needs
    ///         to wait through the challenge period during which everyone has
    ///         a chance to challenge the result as invalid one. Submitter of
    ///         the result needs to be in the sortition pool and if the result
    ///         gets challenged, the submitter will get slashed.
    function submitResult(Data storage self, Result calldata result) internal {
        require(
            currentState(self) == State.AWAITING_RESULT,
            "Current state is not AWAITING_RESULT"
        );
        require(!hasDkgTimedOut(self), "DKG timeout already passed");

        SortitionPool sortitionPool = self.sortitionPool;

        // Submitter must be an operator in the sortition pool.
        // Declared submitter's member index in the DKG result needs to match
        // the address calling this function.
        require(
            sortitionPool.isOperatorInPool(msg.sender),
            "Submitter not in the sortition pool"
        );

        // The caller-authored members array must be the exact group selected
        // for this seed before it can lock the DKG in the challenge state.
        if (!self.dkgValidator.validateGroupMembers(result, self.seed)) {
            revert InvalidGroupMembers();
        }

        uint32 submitter = result.members[result.submitterMemberIndex - 1];
        require(
            sortitionPool.getIDOperator(submitter) == msg.sender,
            "Unexpected submitter index"
        );
        if (
            self.challengedSubmitterDkgStartBlocks[submitter] == self.startBlock
        ) {
            revert SubmitterChallengedForCurrentDkg();
        }

        self.submittedResultHash = keccak256(abi.encode(result));
        self.submittedResultBlock = block.number;

        emit DkgResultSubmitted(self.submittedResultHash, self.seed, result);
    }

    /// @notice Checks if awaiting seed timed out.
    /// @return True if awaiting seed timed out, false otherwise.
    function hasSeedTimedOut(Data storage self) internal view returns (bool) {
        return
            currentState(self) == State.AWAITING_SEED &&
            block.number > (self.stateLockBlock + self.parameters.seedTimeout);
    }

    /// @notice Checks if DKG timed out. The DKG timeout period includes time required
    ///         for off-chain protocol execution and time for the result publication.
    ///         After this time a result cannot be submitted and DKG can be notified
    ///         about the timeout. A compatibility offset may already exist for a
    ///         DKG started before an upgrade, but challenges never increase it.
    /// @return True if DKG timed out, false otherwise.
    function hasDkgTimedOut(Data storage self) internal view returns (bool) {
        return
            currentState(self) == State.AWAITING_RESULT &&
            block.number >
            (self.startBlock +
                self.resultSubmissionStartBlockOffset +
                self.parameters.resultSubmissionTimeout);
    }

    /// @notice Notifies about the seed was not delivered and restores the
    ///         initial DKG state (IDLE).
    function notifySeedTimeout(Data storage self) internal {
        require(hasSeedTimedOut(self), "Awaiting seed has not timed out");

        emit DkgSeedTimedOut();

        complete(self);
    }

    /// @notice Notifies about DKG timeout.
    function notifyDkgTimeout(Data storage self) internal {
        require(hasDkgTimedOut(self), "DKG has not timed out");

        emit DkgTimedOut();

        complete(self);
    }

    /// @notice Approves DKG result. Can be called when the challenge period for
    ///         the submitted result is finished. Considers the submitted result
    ///         as valid. For the first `submitterPrecedencePeriodLength`
    ///         blocks after the end of the challenge period can be called only
    ///         by the DKG result submitter. After that time, can be called by
    ///         anyone.
    /// @dev Can be called after a challenge period for the submitted result.
    /// @param result Result to approve. Must match the submitted result stored
    ///        during `submitResult`.
    /// @return misbehavedMembers Identifiers of members who misbehaved during DKG.
    function approveResult(Data storage self, Result calldata result)
        internal
        returns (uint32[] memory misbehavedMembers)
    {
        require(
            currentState(self) == State.CHALLENGE,
            "Current state is not CHALLENGE"
        );

        uint256 challengePeriodEnd = self.submittedResultBlock +
            self.parameters.resultChallengePeriodLength;

        require(
            block.number > challengePeriodEnd,
            "Challenge period has not passed yet"
        );

        require(
            keccak256(abi.encode(result)) == self.submittedResultHash,
            "Result under approval is different than the submitted one"
        );

        // Extract submitter member address. Submitter member index is in
        // range [1, groupSize] so we need to -1 when fetching identifier from members
        // array.
        address submitterMember = self.sortitionPool.getIDOperator(
            result.members[result.submitterMemberIndex - 1]
        );

        require(
            msg.sender == submitterMember ||
                block.number >
                challengePeriodEnd +
                    self.parameters.submitterPrecedencePeriodLength,
            "Only the DKG result submitter can approve the result at this moment"
        );

        // Extract misbehaved members identifiers. Misbehaved members indices
        // are in range [1, groupSize], so we need to -1 when fetching identifiers from
        // members array.
        misbehavedMembers = new uint32[](
            result.misbehavedMembersIndices.length
        );
        for (uint256 i = 0; i < result.misbehavedMembersIndices.length; i++) {
            misbehavedMembers[i] = result.members[
                result.misbehavedMembersIndices[i] - 1
            ];
        }

        emit DkgResultApproved(self.submittedResultHash, msg.sender);

        return misbehavedMembers;
    }

    /// @notice Challenges DKG result. If the submitted result is proved to be
    ///         invalid it reverts the DKG back to the result submission phase.
    /// @dev Can be called during a challenge period for the submitted result.
    /// @param result Result to challenge. Must match the submitted result
    ///        stored during `submitResult`.
    /// @return maliciousResultHash Hash of the malicious result.
    /// @return maliciousSubmitter Identifier of the malicious submitter.
    function challengeResult(Data storage self, Result calldata result)
        internal
        returns (bytes32 maliciousResultHash, uint32 maliciousSubmitter)
    {
        require(
            currentState(self) == State.CHALLENGE,
            "Current state is not CHALLENGE"
        );

        require(
            block.number <=
                self.submittedResultBlock +
                    self.parameters.resultChallengePeriodLength,
            "Challenge period has already passed"
        );

        require(
            keccak256(abi.encode(result)) == self.submittedResultHash,
            "Result under challenge is different than the submitted one"
        );

        // https://github.com/crytic/slither/issues/982
        // slither-disable-next-line unused-return
        try
            self.dkgValidator.validate(
                result,
                self.seed,
                self.startBlock,
                self.bridge,
                address(this)
            )
        returns (
            // slither-disable-next-line uninitialized-local,variable-scope
            bool isValid,
            // slither-disable-next-line uninitialized-local,variable-scope
            string memory errorMsg
        ) {
            if (isValid) {
                revert("unjustified challenge");
            }

            emit DkgResultChallenged(
                self.submittedResultHash,
                msg.sender,
                errorMsg
            );
        } catch {
            // if the validation reverted we consider the DKG result as invalid
            emit DkgResultChallenged(
                self.submittedResultHash,
                msg.sender,
                "validation reverted"
            );
        }

        // Consider result hash as malicious.
        maliciousResultHash = self.submittedResultHash;
        maliciousSubmitter = result.members[result.submitterMemberIndex - 1];

        // Prevent the identified submitter from reacquiring the challenge-state
        // lock in this DKG. Other selected members may still submit before the
        // original fixed deadline.
        self.challengedSubmitterDkgStartBlocks[maliciousSubmitter] = self
            .startBlock;

        submittedResultCleanup(self);

        return (maliciousResultHash, maliciousSubmitter);
    }

    /// @notice Due to EIP150, 1/64 of the gas is not forwarded to the call, and
    ///         will be kept to execute the remaining operations in the function
    ///         after the call inside the try-catch.
    ///
    ///         To ensure there is no way for the caller to manipulate gas limit
    ///         in such a way that the call inside try-catch fails with out-of-gas
    ///         and the rest of the function is executed with the remaining
    ///         1/64 of gas, we require an extra gas amount to be left at the
    ///         end of the call to the function challenging DKG result and
    ///         wrapping the validator and authorization-source calls inside a
    ///         try-catch.
    function requireChallengeExtraGas(Data storage self) internal view {
        require(
            gasleft() >= self.parameters.resultChallengeExtraGas,
            "Not enough extra gas left"
        );
    }

    /// @notice Checks if DKG result is valid for the current DKG.
    /// @param result DKG result.
    /// @return True if the result is valid. If the result is invalid it returns
    ///         false and an error message.
    function isResultValid(Data storage self, Result calldata result)
        internal
        view
        returns (bool, string memory)
    {
        require(self.startBlock > 0, "DKG has not been started");

        return
            self.dkgValidator.validate(
                result,
                self.seed,
                self.startBlock,
                self.bridge,
                address(this)
            );
    }

    /// @notice Set setSeedTimeout parameter.
    function setSeedTimeout(Data storage self, uint256 newSeedTimeout)
        internal
    {
        require(currentState(self) == State.IDLE, "Current state is not IDLE");

        require(newSeedTimeout > 0, "New value should be greater than zero");

        self.parameters.seedTimeout = newSeedTimeout;
    }

    /// @notice Set resultChallengePeriodLength parameter.
    function setResultChallengePeriodLength(
        Data storage self,
        uint256 newResultChallengePeriodLength
    ) internal {
        require(currentState(self) == State.IDLE, "Current state is not IDLE");

        require(
            newResultChallengePeriodLength > 0,
            "New value should be greater than zero"
        );

        self
            .parameters
            .resultChallengePeriodLength = newResultChallengePeriodLength;
    }

    /// @notice Set resultChallengeExtraGas parameter.
    function setResultChallengeExtraGas(
        Data storage self,
        uint256 newResultChallengeExtraGas
    ) internal {
        require(currentState(self) == State.IDLE, "Current state is not IDLE");

        self.parameters.resultChallengeExtraGas = newResultChallengeExtraGas;
    }

    /// @notice Set resultSubmissionTimeout parameter.
    function setResultSubmissionTimeout(
        Data storage self,
        uint256 newResultSubmissionTimeout
    ) internal {
        require(currentState(self) == State.IDLE, "Current state is not IDLE");

        require(
            newResultSubmissionTimeout > 0,
            "New value should be greater than zero"
        );

        self.parameters.resultSubmissionTimeout = newResultSubmissionTimeout;
    }

    /// @notice Set submitterPrecedencePeriodLength parameter.
    function setSubmitterPrecedencePeriodLength(
        Data storage self,
        uint256 newSubmitterPrecedencePeriodLength
    ) internal {
        require(currentState(self) == State.IDLE, "Current state is not IDLE");

        require(
            newSubmitterPrecedencePeriodLength <
                self.parameters.resultSubmissionTimeout,
            "New value should be less than result submission period length"
        );

        self
            .parameters
            .submitterPrecedencePeriodLength = newSubmitterPrecedencePeriodLength;
    }

    /// @notice Completes DKG by cleaning up state.
    /// @dev Should be called after DKG times out or a result is approved.
    function complete(Data storage self) internal {
        delete self.startBlock;
        delete self.seed;
        delete self.resultSubmissionStartBlockOffset;
        submittedResultCleanup(self);
        self.sortitionPool.unlock();
    }

    /// @notice Cleans up submitted result state either after DKG completion
    ///         (as part of `complete` method) or after justified challenge.
    function submittedResultCleanup(Data storage self) private {
        delete self.submittedResultHash;
        delete self.submittedResultBlock;
    }
}
