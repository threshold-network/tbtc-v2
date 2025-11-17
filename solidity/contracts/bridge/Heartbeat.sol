// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

/// @title Bridge wallet heartbeat
/// @notice The library establishes expected format for heartbeat messages
///         signed by wallet ECDSA signing group. Heartbeat messages are
///         constructed in such a way that they can not be used as a Bitcoin
///         transaction preimages.
/// @dev The smallest Bitcoin non-coinbase transaction is a one spending an
///      OP_TRUE anyonecanspend output and creating 1 OP_TRUE anyonecanspend
///      output. Such a transaction has 61 bytes (see `BitcoinTx` documentation):
///        4  bytes  for version
///        1  byte   for tx_in_count
///        36 bytes  for tx_in.previous_output
///        1  byte   for tx_in.script_bytes (value: 0)
///        0  bytes  for tx_in.signature_script
///        4  bytes  for tx_in.sequence
///        1  byte   for tx_out_count
///        8  bytes  for tx_out.value
///        1  byte   for tx_out.pk_script_bytes
///        1  byte   for tx_out.pk_script
///        4  bytes  for lock_time
///
///
///      The smallest Bitcoin coinbase transaction is a one creating
///      1 OP_TRUE anyonecanspend output and having an empty coinbase script.
///      Such a transaction has 65 bytes:
///        4  bytes  for version
///        1  byte   for tx_in_count
///        32 bytes  for tx_in.hash  (all 0x00)
///        4  bytes  for tx_in.index (all 0xff)
///        1  byte   for tx_in.script_bytes (value: 0)
///        4  bytes  for tx_in.height
///        0  byte   for tx_in.coinbase_script
///        4  bytes  for tx_in.sequence
///        1  byte   for tx_out_count
///        8  bytes  for tx_out.value
///        1  byte   for tx_out.pk_script_bytes
///        1  byte   for tx_out.pk_script
///        4  bytes  for lock_time
///
///
///      A SIGHASH flag is used to indicate which part of the transaction is
///      signed by the ECDSA signature. There are currently 3 flags:
///      SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE, and different combinations
///      of these flags.
///
///      No matter the SIGHASH flag and no matter the combination, the following
///      fields from the transaction are always included in the constructed
///      preimage:
///        4  bytes  for version
///        36 bytes  for tx_in.previous_output (or tx_in.hash + tx_in.index for coinbase)
///        4  bytes  for lock_time
///
///      Additionally, the last 4 bytes of the preimage determines the SIGHASH
///      flag.
///
///      This is enough to say there is no way the preimage could be shorter
///      than 4 + 36 + 4 + 4 = 48 bytes.
///
///      For this reason, we construct the heartbeat message, as a 16-byte
///      message. The first 8 bytes are 0xffffffffffffffff. The last 8 bytes
///      are for an arbitrary uint64, being a signed heartbeat nonce (for
///      example, the last Ethereum block hash).
///
///      The message being signed by the wallet when executing the heartbeat
///      protocol should be Bitcoin's hash256 (double SHA-256) of the heartbeat
///      message:
///        heartbeat_sighash = hash256(heartbeat_message)
library Heartbeat {
    using BytesLib for bytes;

    /// @notice Determines if the signed byte array is a valid, non-fraudulent
    ///         heartbeat message.
    /// @param message Message signed by the wallet. It is a potential heartbeat
    ///        message, Bitcoin transaction preimage, or an arbitrary signed
    ///        bytes.
    /// @dev Wallet heartbeat message must be exactly 16 bytes long with the first
    ///      8 bytes set to 0xffffffffffffffff.
    /// @return True if valid heartbeat message, false otherwise.
    function isValidHeartbeatMessage(bytes calldata message)
        internal
        pure
        returns (bool)
    {
        if (message.length != 16) {
            return false;
        }

        if (message.slice8(0) != 0xffffffffffffffff) {
            return false;
        }

        return true;
    }
}
