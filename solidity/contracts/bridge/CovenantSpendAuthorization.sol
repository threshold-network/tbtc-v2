// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./ICovenantSpendAuthorization.sol";

/// @title Covenant spend authorization registry
/// @notice On-chain reflection of the account-control covenant proof flow.
///         The covenant signer produces a normal Bitcoin `SIGHASH_ALL`
///         signature over a covenant active UTXO using a tBTC wallet key. That
///         UTXO is neither a swept deposit, a spent main UTXO, nor a processed
///         moved-funds sweep, so the Bridge `Fraud` library cannot recognize
///         the spend as honest on its own; a fraud challenge replaying the
///         signature would otherwise slash a wallet for a legitimate covenant
///         migration.
///
///         This registry lets the account-control covenant authority attest,
///         before the covenant signer signs, that a specific covenant active
///         outpoint is legitimate and may be spent by a specific wallet, for a
///         specific value, into a specific set of transaction outputs. The
///         Bridge consults `isAuthorized` when defeating a covenant-spend fraud
///         challenge (`Bridge.defeatFraudChallengeWithCovenantSpend`). The
///         attestation is keyed by the source outpoint and bound to the signing
///         wallet, the UTXO value, and the migration outputs, so a defeat is
///         confined to the exact spend the authority attested and an authorized
///         covenant UTXO cannot be diverted to other outputs. This registry
///         does not itself prove covenant provenance on-chain; it is the
///         authority that vouches an outpoint is a genuine covenant active UTXO
///         (see the trust note below). The Bridge additionally rejects any
///         outpoint it already tracks (a deposit, a spent main UTXO, a
///         moved-funds output, or the wallet's current main UTXO), which a
///         genuine external covenant UTXO never is, so the most obvious
///         wallet-controlled backing UTXO cannot be laundered through this path
///         even against a mis-issued attestation.
///
///         Authorizations are write-once and permanent: an outpoint can be
///         authorized only once and can never be overwritten or revoked. This
///         is deliberate. A tBTC wallet can stay challengeable (Live,
///         MovingFunds, or Closing) for an unbounded time after it signs a
///         covenant migration, and a public observer can open a fraud challenge
///         at any point in that window. If an authorization could be revoked or
///         overwritten, the authority (or a compromised authority key) could
///         pull the defense out from under a legitimate signature and let the
///         wallet be slashed — the very TOB-TBTCACEXT-1 outcome this defense
///         exists to prevent. Immutability guarantees that once a covenant
///         spend is authorized, the wallet stays defensible for that spend
///         forever. A mistaken authorization cannot be undone; the affected
///         covenant outpoint is simply migrated through a different UTXO.
/// @dev The owner is the on-chain representative of the account-control
///      covenant authority (the same authority whose approval certificate the
///      covenant signer already validates). Ownership is expected to be
///      transferred to that authority (or the Threshold governance, ideally a
///      timelocked multisig) after deployment. The covenant signer must not
///      release a covenant signature until the corresponding authorization
///      exists here and is sufficiently confirmed, mirroring the keep-core
///      fail-closed gate.
///
///      TRUST NOTE: the owner is a fraud-defense root. A `true` from
///      `isAuthorized` makes the Bridge treat the challenged wallet signature
///      as an honest covenant spend, so the owner can make any wallet signature
///      over the authorized `(outpoint, wallet, value, outputsHash)` tuple
///      immune to fraud slashing. The registry trusts the owner to attest only
///      genuine covenant active UTXOs; it does not itself verify covenant
///      provenance on-chain. A malicious owner acting alone cannot forge a
///      wallet signature or move BTC, and (because authorizations are
///      immutable) cannot revoke a legitimate defense; but a malicious owner
///      colluding with a compromised threshold wallet could pardon a theft —
///      the same double-compromise the account-control covenant feature already
///      assumes when it trusts the covenant approval flow. A design that
///      removes even this residual trust would replace the owner with an
///      on-chain account-control proof verifier that derives the tuple from a
///      verified covenant proof rather than accepting it from the owner.
contract CovenantSpendAuthorization is Ownable, ICovenantSpendAuthorization {
    struct Authorization {
        // 20-byte public key hash of the tBTC wallet authorized to spend the
        // covenant active UTXO.
        bytes20 walletPubKeyHash;
        // Value in satoshi of the covenant active UTXO as validated by the
        // covenant proof flow. A zero value is never authorized.
        uint64 value;
        // True once the outpoint has been authorized. Set once by
        // `authorizeCovenantSpend` and never cleared; the authorization is
        // permanent so a legitimate covenant signature stays defensible for the
        // wallet's whole challengeable lifetime.
        bool active;
        // BIP-143 `hashOutputs` of the covenant migration transaction the
        // covenant spend must fund — the `hash256` of the serialized outputs.
        // Binds the authorization to the exact migration destination and anchor
        // so an authorized covenant UTXO cannot be diverted to other outputs
        // and still defeat a fraud challenge.
        bytes32 outputsHash;
    }

    /// @notice Maps a covenant active UTXO key to its authorization. The key
    ///         matches the Bridge UTXO key:
    ///         `uint256(keccak256(abi.encodePacked(fundingTxHash, fundingOutputIndex)))`,
    ///         with the funding transaction hash in Bitcoin internal
    ///         (little-endian) byte order.
    mapping(uint256 => Authorization) public authorizations;

    event CovenantSpendAuthorized(
        uint256 indexed utxoKey,
        bytes20 indexed walletPubKeyHash,
        uint64 value,
        bytes32 outputsHash
    );

    /// @notice Authorizes a covenant active UTXO to be spent by the given
    ///         wallet for the given value into the given transaction outputs.
    ///         Write-once: an outpoint that already has an authorization cannot
    ///         be re-authorized, so the attestation can never be overwritten.
    /// @param fundingTxHash Hash of the covenant active UTXO's transaction in
    ///        Bitcoin internal (little-endian) byte order.
    /// @param fundingOutputIndex Index of the covenant active output within
    ///        that transaction.
    /// @param walletPubKeyHash 20-byte public key hash of the tBTC wallet
    ///        authorized to spend the covenant active UTXO.
    /// @param value Value in satoshi of the covenant active UTXO, as validated
    ///        by the covenant proof flow. Must equal the input value the
    ///        wallet signs over.
    /// @param outputsHash BIP-143 `hashOutputs` of the covenant migration
    ///        transaction — the `hash256` of the serialized transaction
    ///        outputs the covenant spend must fund.
    /// @dev Requirements:
    ///      - The caller must be the owner (the covenant authority),
    ///      - the outpoint must not already be authorized,
    ///      - `walletPubKeyHash` must not be zero,
    ///      - `value` must be positive.
    function authorizeCovenantSpend(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex,
        bytes20 walletPubKeyHash,
        uint64 value,
        bytes32 outputsHash
    ) external onlyOwner {
        require(
            walletPubKeyHash != bytes20(0),
            "Wallet public key hash must not be zero"
        );
        require(value > 0, "Value must be positive");

        uint256 utxoKey = uint256(
            keccak256(abi.encodePacked(fundingTxHash, fundingOutputIndex))
        );

        // Write-once. Overwriting an existing authorization could strip a
        // legitimate, still-challengeable covenant signature of its defense, so
        // it is forbidden. A covenant active UTXO is spent at most once, so a
        // single authorization per outpoint is sufficient.
        require(
            !authorizations[utxoKey].active,
            "Covenant spend already authorized"
        );

        authorizations[utxoKey] = Authorization(
            walletPubKeyHash,
            value,
            true,
            outputsHash
        );

        emit CovenantSpendAuthorized(
            utxoKey,
            walletPubKeyHash,
            value,
            outputsHash
        );
    }

    /// @inheritdoc ICovenantSpendAuthorization
    function isAuthorized(
        uint256 utxoKey,
        bytes20 walletPubKeyHash,
        uint64 value,
        bytes32 outputsHash
    ) external view override returns (bool) {
        Authorization storage authorization = authorizations[utxoKey];
        return
            authorization.active &&
            authorization.walletPubKeyHash == walletPubKeyHash &&
            authorization.value == value &&
            authorization.outputsHash == outputsHash;
    }
}
