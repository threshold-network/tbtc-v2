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

pragma solidity 0.8.17;

import "@keep-network/sortition-pools/contracts/SortitionPool.sol";

import "../api/IFrostAuthorizationSource.sol";
import "../../staking/api/IWalletExposureLedger.sol";

/// @title FROST wallet exposure notification
/// @notice Resolves a registered wallet's signing group member IDs to their
///         staking providers and notifies the wallet exposure ledger. Kept
///         as an externally linked library (like `FrostInactivity`) so the
///         resolution and encoding code lives outside the
///         `FrostWalletRegistry` bytecode — the registry runs close to the
///         contract size limit.
library FrostWalletExposure {
    struct Data {
        // Wallet exposure ledger notified about wallet registrations and
        // closures. Zero address while unset — notifications are skipped.
        IWalletExposureLedger ledger;
    }

    /// @notice Emitted when the wallet exposure ledger address is set.
    /// @dev Emitted via delegatecall, so the log is attributed to the
    ///      `FrostWalletRegistry` address.
    event WalletExposureLedgerSet(address walletExposureLedger);

    /// @notice Emitted when a notification call to the wallet exposure
    ///         ledger reverted. The failure is swallowed on purpose —
    ///         neither DKG result approval nor wallet closure may be
    ///         bricked by the ledger. Emitted via delegatecall, so the
    ///         log is attributed to the `FrostWalletRegistry` address.
    event WalletExposureLedgerCallFailed(bytes32 indexed walletID);

    /// @notice Raised when `setLedger` is called after the ledger address
    ///         has already been set. The ledger wiring is one-shot;
    ///         migrating to a new ledger is upgrade-only.
    error WalletExposureLedgerAlreadySet();

    /// @notice Raised when `setLedger` is called with the zero address.
    error WalletExposureLedgerAddressZero();

    /// @notice Raised when `setLedger` is called with an address that has
    ///         no deployed code. A codeless ledger would make the
    ///         compiler-inserted extcodesize check on the notification
    ///         calls revert OUTSIDE the try/catch, bricking DKG result
    ///         approval and wallet closure.
    error WalletExposureLedgerNotContract();

    /// @notice Sets the wallet exposure ledger address. One-shot: reverts
    ///         if the ledger has already been set, if the given address
    ///         is zero, or if it carries no code. Access control
    ///         (governance-only) is enforced by the calling registry
    ///         function.
    /// @param _ledger Address of the wallet exposure ledger.
    function setLedger(Data storage self, address _ledger) external {
        if (address(self.ledger) != address(0)) {
            revert WalletExposureLedgerAlreadySet();
        }
        if (_ledger == address(0)) {
            revert WalletExposureLedgerAddressZero();
        }
        if (_ledger.code.length == 0) {
            revert WalletExposureLedgerNotContract();
        }
        self.ledger = IWalletExposureLedger(_ledger);
        emit WalletExposureLedgerSet(_ledger);
    }

    /// @notice Resolves the wallet signing group member IDs to their staking
    ///         providers (same member-ID → operator → staking provider
    ///         resolution as the registry's `seize`), aggregates them into
    ///         unique provider / seat-count arrays, and notifies the wallet
    ///         exposure ledger about the registered wallet. No-op when the
    ///         ledger is not wired (zero address).
    /// @dev The ledger call is wrapped in try/catch: DKG result approval
    ///      MUST NOT be bricked by the ledger, so a failure only emits
    ///      `WalletExposureLedgerCallFailed`.
    /// @param sortitionPool Sortition pool resolving member IDs to operator
    ///        addresses.
    /// @param operatorToStakingProvider Registry mapping from operator
    ///        address to staking provider address.
    /// @param walletID ID of the newly registered wallet.
    /// @param walletMembersIDs Sortition pool IDs of the wallet signing
    ///        group members, as carried by the approved DKG result.
    function notifyWalletRegistered(
        Data storage self,
        SortitionPool sortitionPool,
        mapping(address => address) storage operatorToStakingProvider,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs
    ) external {
        IWalletExposureLedger walletExposureLedger = self.ledger;
        if (address(walletExposureLedger) == address(0)) {
            return;
        }
        // A ledger that lost its code after wiring (selfdestruct) would
        // make the compiler-inserted extcodesize check on the external
        // call below revert OUTSIDE the try/catch — treat it as a failed
        // notification instead.
        if (address(walletExposureLedger).code.length == 0) {
            emit WalletExposureLedgerCallFailed(walletID);
            return;
        }

        address[] memory groupMembersAddresses = sortitionPool.getIDOperators(
            walletMembersIDs
        );

        // Scratch arrays sized for the worst case (all members unique);
        // `uniqueCount` tracks the filled prefix.
        address[] memory uniqueProviders = new address[](
            groupMembersAddresses.length
        );
        uint32[] memory uniqueSeatCounts = new uint32[](
            groupMembersAddresses.length
        );
        uint256 uniqueCount = 0;

        for (uint256 i = 0; i < groupMembersAddresses.length; i++) {
            address stakingProvider = operatorToStakingProvider[
                groupMembersAddresses[i]
            ];

            bool found = false;
            for (uint256 j = 0; j < uniqueCount; j++) {
                if (uniqueProviders[j] == stakingProvider) {
                    uniqueSeatCounts[j]++;
                    found = true;
                    break;
                }
            }

            if (!found) {
                uniqueProviders[uniqueCount] = stakingProvider;
                uniqueSeatCounts[uniqueCount] = 1;
                uniqueCount++;
            }
        }

        // Truncate the scratch arrays to the filled prefix; the ledger
        // interface expects `stakingProviders` and `seatCounts` to be
        // aligned and to contain unique providers only. Safe because the
        // arrays are only shrunk and are not used again after the external
        // call below.
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(uniqueProviders, uniqueCount)
            mstore(uniqueSeatCounts, uniqueCount)
        }

        try
            walletExposureLedger.onWalletRegistered(
                walletID,
                uniqueProviders,
                uniqueSeatCounts
            )
        // solhint-disable-next-line no-empty-blocks
        {

        } catch {
            emit WalletExposureLedgerCallFailed(walletID);
        }
    }

    /// @notice Verbatim relocation of the registry's `seize` body: verifies
    ///         the member IDs against the stored hash, resolves them to
    ///         staking providers (member ID → operator → staking provider),
    ///         and forwards the report to the authorization source's
    ///         misbehavior hook. Lives here so the resolution and encoding
    ///         code stays outside the `FrostWalletRegistry` bytecode — the
    ///         registry runs close to the contract size limit. Access
    ///         control (lifecycle owner) and the wallet lookup are enforced
    ///         by the calling registry function; requires and their order
    ///         are unchanged from the original registry body.
    /// @param sortitionPool Sortition pool resolving member IDs to operator
    ///        addresses.
    /// @param operatorToStakingProvider Registry mapping from operator
    ///        address to staking provider address.
    /// @param authorizationSource The registry's authorization source; the
    ///        original body resolved it through
    ///        `_currentAuthorizationSource()` after the resolution loop, so
    ///        the not-initialized check is repeated here at the same point.
    /// @param memberIdsHash Members IDs hash stored for the wallet.
    /// @param amount Compatibility amount forwarded to the authorization
    ///        source.
    /// @param rewardMultiplier Compatibility reward multiplier forwarded to
    ///        the authorization source.
    /// @param notifier Address of the misbehavior notifier.
    /// @param walletMembersIDs Identifiers of the wallet signing group
    ///        members.
    function seize(
        SortitionPool sortitionPool,
        mapping(address => address) storage operatorToStakingProvider,
        IFrostAuthorizationSource authorizationSource,
        bytes32 memberIdsHash,
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        uint32[] calldata walletMembersIDs
    ) external {
        require(
            memberIdsHash == keccak256(abi.encode(walletMembersIDs)),
            "Invalid wallet members identifiers"
        );

        address[] memory groupMembersAddresses = sortitionPool.getIDOperators(
            walletMembersIDs
        );
        address[] memory stakingProvidersAddresses = new address[](
            walletMembersIDs.length
        );
        for (uint256 i = 0; i < groupMembersAddresses.length; i++) {
            stakingProvidersAddresses[i] = operatorToStakingProvider[
                groupMembersAddresses[i]
            ];
        }

        require(
            address(authorizationSource) != address(0),
            "Authorization source is not initialized"
        );
        authorizationSource.reportMaliciousBehavior(
            amount,
            rewardMultiplier,
            notifier,
            stakingProvidersAddresses
        );
    }

    /// @notice Notifies the wallet exposure ledger that the given wallet
    ///         has been closed. No-op when the ledger is not wired (zero
    ///         address).
    /// @dev The ledger call is wrapped in try/catch: `closeWallet` is
    ///      driven by the Bridge lifecycle and MUST NOT revert because of
    ///      the ledger, so a failure only emits
    ///      `WalletExposureLedgerCallFailed`.
    /// @param walletID ID of the closed wallet.
    function notifyWalletClosed(Data storage self, bytes32 walletID) external {
        IWalletExposureLedger walletExposureLedger = self.ledger;
        if (address(walletExposureLedger) == address(0)) {
            return;
        }
        // See `notifyWalletRegistered` — a codeless ledger must not brick
        // wallet closure via the pre-call extcodesize check.
        if (address(walletExposureLedger).code.length == 0) {
            emit WalletExposureLedgerCallFailed(walletID);
            return;
        }

        try walletExposureLedger.onWalletClosed(walletID) {
            // solhint-disable-previous-line no-empty-blocks
        } catch {
            emit WalletExposureLedgerCallFailed(walletID);
        }
    }
}
