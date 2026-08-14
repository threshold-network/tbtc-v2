// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./Wallets.sol";

/// @notice Read-only views that both fraud router sidecars
///         (`EcdsaFraudRouter` and `P2TRSignatureFraudRouter`) need from
///         Bridge while processing their respective fraud lifecycles.
///
/// @dev Extracted from the previously-duplicated `IBridgeForFraud`
///      (`EcdsaFraudRouter.sol`) and `IBridgeForP2TRFraud`
///      (`P2TRSignatureFraudRouter.sol`) so the two routers share one
///      declaration of the views they both call. Each router retains
///      its own slash-callback surface (separately gated on Bridge
///      via `onlyEcdsaFraudRouter` / `onlyP2TRFraudRouter`) and any
///      scheme-specific helpers; only the read-only getters are
///      deduplicated here. The extraction is bytecode-neutral on the
///      routers (interfaces don't emit runtime code) and keeps the
///      security rationale for separate callbacks intact.
interface IBridgeFraudViews {
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

    function legacyFraudChallengeExists(uint256 challengeKey)
        external
        view
        returns (bool);

    /// @notice Bridge treasury address used by both fraud routers to
    ///      route defeated-challenge deposits / challenger refunds /
    ///      notifier bounties. Shared because the deposit and the
    ///      refund paths on either side read the same on-chain
    ///      treasury pointer.
    function treasury() external view returns (address);
}
