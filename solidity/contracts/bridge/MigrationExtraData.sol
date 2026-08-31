// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

library MigrationExtraData {
    bytes12 internal constant TAG = bytes12("AC_MIGRATEV1");

    /// @notice Returns true when `extraData` carries the migration reveal
    ///         tag in its high-order 12 bytes.
    /// @dev Migration extraData packs the 12-byte tag in the high bits and
    ///      the revealer address in the low 20 bytes. A non-matching tag
    ///      identifies a regular (non-migration) reveal.
    function isMigrationReveal(bytes32 extraData) internal pure returns (bool) {
        return bytes12(extraData) == TAG;
    }
}
