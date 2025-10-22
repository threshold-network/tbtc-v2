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

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

import "./BitcoinTx.sol";
import "./BridgeState.sol";
import "./Wallets.sol";

/// @title Bridge deposit
/// @notice The library handles the logic for revealing Bitcoin deposits to
///         the Bridge.
/// @dev The depositor puts together a P2SH or P2WSH address to deposit the
///      funds. This script is unique to each depositor and looks like this:
///
///      ```
///      <depositorAddress> DROP
///      <blindingFactor> DROP
///      DUP HASH160 <walletPubKeyHash> EQUAL
///      IF
///        CHECKSIG
///      ELSE
///        DUP HASH160 <refundPubkeyHash> EQUALVERIFY
///        <refundLocktime> CHECKLOCKTIMEVERIFY DROP
///        CHECKSIG
///      ENDIF
///      ```
///
///      Since each depositor has their own Ethereum address and their own
///      blinding factor, each depositor’s script is unique, and the hash
///      of each depositor’s script is unique.
///
///      This library also supports another variant of the deposit script
///      allowing to embed 32-byte extra data. The extra data allows to attach
///      additional context to the deposit. The script with 32-byte extra data
///      looks like this:
///
///      ```
///      <depositorAddress> DROP
///      <extraData> DROP
///      <blindingFactor> DROP
///      DUP HASH160 <walletPubKeyHash> EQUAL
///      IF
///        CHECKSIG
///      ELSE
///        DUP HASH160 <refundPubkeyHash> EQUALVERIFY
///        <refundLocktime> CHECKLOCKTIMEVERIFY DROP
///        CHECKSIG
///      ENDIF
///      ```
library Deposit {
    using BTCUtils for bytes;
    using BytesLib for bytes;

    /// @notice Represents data which must be revealed by the depositor during
    ///         deposit reveal.
    struct DepositRevealInfo {
        // Index of the funding output belonging to the funding transaction.
        uint32 fundingOutputIndex;
        // The blinding factor as 8 bytes. Byte endianness doesn't matter
        // as this factor is not interpreted as uint. The blinding factor allows
        // to distinguish deposits from the same depositor.
        bytes8 blindingFactor;
        // The compressed Bitcoin public key (33 bytes and 02 or 03 prefix)
        // of the deposit's wallet hashed in the HASH160 Bitcoin opcode style.
        bytes20 walletPubKeyHash;
        // The compressed Bitcoin public key (33 bytes and 02 or 03 prefix)
        // that can be used to make the deposit refund after the refund
        // locktime passes. Hashed in the HASH160 Bitcoin opcode style.
        bytes20 refundPubKeyHash;
        // The refund locktime (4-byte LE). Interpreted according to locktime
        // parsing rules described in:
        // https://developer.bitcoin.org/devguide/transactions.html#locktime-and-sequence-number
        // and used with OP_CHECKLOCKTIMEVERIFY opcode as described in:
        // https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki
        bytes4 refundLocktime;
        // Address of the Bank vault to which the deposit is routed to.
        // Optional, can be 0x0. The vault must be trusted by the Bridge.
        address vault;
        // This struct doesn't contain `__gap` property as the structure is not
        // stored, it is used as a function's calldata argument.
    }

    /// @notice Represents tBTC deposit request data.
    struct DepositRequest {
        // Ethereum depositor address.
        address depositor;
        // Deposit amount in satoshi.
        uint64 amount;
        // UNIX timestamp the deposit was revealed at.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 revealedAt;
        // Address of the Bank vault the deposit is routed to.
        // Optional, can be 0x0.
        address vault;
        // Treasury TBTC fee in satoshi at the moment of deposit reveal.
        uint64 treasuryFee;
        // UNIX timestamp the deposit was swept at. Note this is not the
        // time when the deposit was swept on the Bitcoin chain but actually
        // the time when the sweep proof was delivered to the Ethereum chain.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 sweptAt;
        // The 32-byte deposit extra data. Optional, can be bytes32(0).
        bytes32 extraData;
        // This struct doesn't contain `__gap` property as the structure is stored
        // in a mapping, mappings store values in different slots and they are
        // not contiguous with other values.
    }

    event DepositRevealed(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex,
        address indexed depositor,
        uint64 amount,
        bytes8 blindingFactor,
        bytes20 indexed walletPubKeyHash,
        bytes20 refundPubKeyHash,
        bytes4 refundLocktime,
        address vault
    );

    /// @notice Used by the depositor to reveal information about their P2(W)SH
    ///         Bitcoin deposit to the Bridge on Ethereum chain. The off-chain
    ///         wallet listens for revealed deposit events and may decide to
    ///         include the revealed deposit in the next executed sweep.
    ///         Information about the Bitcoin deposit can be revealed before or
    ///         after the Bitcoin transaction with P2(W)SH deposit is mined on
    ///         the Bitcoin chain. Worth noting, the gas cost of this function
    ///         scales with the number of P2(W)SH transaction inputs and
    ///         outputs. The deposit may be routed to one of the trusted vaults.
    ///         When a deposit is routed to a vault, vault gets notified when
    ///         the deposit gets swept and it may execute the appropriate action.
    /// @param fundingTx Bitcoin funding transaction data, see `BitcoinTx.Info`.
    /// @param reveal Deposit reveal data, see `RevealInfo struct.
    /// @dev Requirements:
    ///      - This function must be called by the same Ethereum address as the
    ///        one used in the P2(W)SH BTC deposit transaction as a depositor,
    ///      - `reveal.walletPubKeyHash` must identify a `Live` wallet,
    ///      - `reveal.vault` must be 0x0 or point to a trusted vault,
    ///      - `reveal.fundingOutputIndex` must point to the actual P2(W)SH
    ///        output of the BTC deposit transaction,
    ///      - `reveal.blindingFactor` must be the blinding factor used in the
    ///        P2(W)SH BTC deposit transaction,
    ///      - `reveal.walletPubKeyHash` must be the wallet pub key hash used in
    ///        the P2(W)SH BTC deposit transaction,
    ///      - `reveal.refundPubKeyHash` must be the refund pub key hash used in
    ///        the P2(W)SH BTC deposit transaction,
    ///      - `reveal.refundLocktime` must be the refund locktime used in the
    ///        P2(W)SH BTC deposit transaction,
    ///      - BTC deposit for the given `fundingTxHash`, `fundingOutputIndex`
    ///        can be revealed only one time.
    ///
    ///      If any of these requirements is not met, the wallet _must_ refuse
    ///      to sweep the deposit and the depositor has to wait until the
    ///      deposit script unlocks to receive their BTC back.
    function revealDeposit(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata fundingTx,
        DepositRevealInfo calldata reveal
    ) external {
        _revealDeposit(self, fundingTx, reveal, bytes32(0));
    }

    /// @notice Internal function encapsulating the core logic of the deposit
    ///         reveal process. Handles both regular deposits without extra data
    ///         as well as deposits with 32-byte extra data embedded in the
    ///         deposit script. The behavior is controlled by the `extraData`
    ///         parameter. If `extraData` is bytes32(0), the function triggers
    ///         the flow for regular deposits. If `extraData` is not bytes32(0),
    ///         the function triggers the flow for deposits with 32-byte
    ///         extra data.
    /// @param fundingTx Bitcoin funding transaction data, see `BitcoinTx.Info`.
    /// @param reveal Deposit reveal data, see `RevealInfo struct.
    /// @param extraData 32-byte deposit extra data. Can be bytes32(0).
    /// @dev Requirements are described in the docstrings of `revealDeposit` and
    ///      `revealDepositWithExtraData` external functions.
    function _revealDeposit(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata fundingTx,
        DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) internal {
        require(
            self.registeredWallets[reveal.walletPubKeyHash].state ==
                Wallets.WalletState.Live,
            "Wallet must be in Live state"
        );

        require(
            reveal.vault == address(0) || self.isVaultTrusted[reveal.vault],
            "Vault is not trusted"
        );

        if (self.depositRevealAheadPeriod > 0) {
            validateDepositRefundLocktime(self, reveal.refundLocktime);
        }

        bytes memory expectedScript;

        if (extraData == bytes32(0)) {
            // Regular deposit without 32-byte extra data.
            expectedScript = abi.encodePacked(
                hex"14", // Byte length of depositor Ethereum address.
                msg.sender,
                hex"75", // OP_DROP
                hex"08", // Byte length of blinding factor value.
                reveal.blindingFactor,
                hex"75", // OP_DROP
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // Byte length of a compressed Bitcoin public key hash.
                reveal.walletPubKeyHash,
                hex"87", // OP_EQUAL
                hex"63", // OP_IF
                hex"ac", // OP_CHECKSIG
                hex"67", // OP_ELSE
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // Byte length of a compressed Bitcoin public key hash.
                reveal.refundPubKeyHash,
                hex"88", // OP_EQUALVERIFY
                hex"04", // Byte length of refund locktime value.
                reveal.refundLocktime,
                hex"b1", // OP_CHECKLOCKTIMEVERIFY
                hex"75", // OP_DROP
                hex"ac", // OP_CHECKSIG
                hex"68" // OP_ENDIF
            );
        } else {
            // Deposit with 32-byte extra data.
            expectedScript = abi.encodePacked(
                hex"14", // Byte length of depositor Ethereum address.
                msg.sender,
                hex"75", // OP_DROP
                hex"20", // Byte length of extra data.
                extraData,
                hex"75", // OP_DROP
                hex"08", // Byte length of blinding factor value.
                reveal.blindingFactor,
                hex"75", // OP_DROP
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // Byte length of a compressed Bitcoin public key hash.
                reveal.walletPubKeyHash,
                hex"87", // OP_EQUAL
                hex"63", // OP_IF
                hex"ac", // OP_CHECKSIG
                hex"67", // OP_ELSE
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // Byte length of a compressed Bitcoin public key hash.
                reveal.refundPubKeyHash,
                hex"88", // OP_EQUALVERIFY
                hex"04", // Byte length of refund locktime value.
                reveal.refundLocktime,
                hex"b1", // OP_CHECKLOCKTIMEVERIFY
                hex"75", // OP_DROP
                hex"ac", // OP_CHECKSIG
                hex"68" // OP_ENDIF
            );
        }

        bytes memory fundingOutput = fundingTx
            .outputVector
            .extractOutputAtIndex(reveal.fundingOutputIndex);
        bytes memory fundingOutputHash = fundingOutput.extractHash();

        if (fundingOutputHash.length == 20) {
            // A 20-byte output hash is used by P2SH. That hash is constructed
            // by applying OP_HASH160 on the locking script. A 20-byte output
            // hash is used as well by P2PKH and P2WPKH (OP_HASH160 on the
            // public key). However, since we compare the actual output hash
            // with an expected locking script hash, this check will succeed only
            // for P2SH transaction type with expected script hash value. For
            // P2PKH and P2WPKH, it will fail on the output hash comparison with
            // the expected locking script hash.
            require(
                fundingOutputHash.slice20(0) == expectedScript.hash160View(),
                "Wrong 20-byte script hash"
            );
        } else if (fundingOutputHash.length == 32) {
            // A 32-byte output hash is used by P2WSH. That hash is constructed
            // by applying OP_SHA256 on the locking script.
            require(
                fundingOutputHash.toBytes32() == sha256(expectedScript),
                "Wrong 32-byte script hash"
            );
        } else {
            revert("Wrong script hash length");
        }

        // Resulting TX hash is in native Bitcoin little-endian format.
        bytes32 fundingTxHash = abi
            .encodePacked(
                fundingTx.version,
                fundingTx.inputVector,
                fundingTx.outputVector,
                fundingTx.locktime
            )
            .hash256View();

        DepositRequest storage deposit = self.deposits[
            uint256(
                keccak256(
                    abi.encodePacked(fundingTxHash, reveal.fundingOutputIndex)
                )
            )
        ];
        require(deposit.revealedAt == 0, "Deposit already revealed");

        uint64 fundingOutputAmount = fundingOutput.extractValue();

        require(
            fundingOutputAmount >= self.depositDustThreshold,
            "Deposit amount too small"
        );

        deposit.amount = fundingOutputAmount;
        deposit.depositor = msg.sender;
        /* solhint-disable-next-line not-rely-on-time */
        deposit.revealedAt = uint32(block.timestamp);
        deposit.vault = reveal.vault;
        deposit.treasuryFee = self.depositTreasuryFeeDivisor > 0
            ? fundingOutputAmount / self.depositTreasuryFeeDivisor
            : 0;
        deposit.extraData = extraData;

        if (
            deposit.treasuryFee > 0 && address(self.rebateStaking) != address(0)
        ) {
            deposit.treasuryFee = self.rebateStaking.applyForRebate(
                deposit.depositor,
                deposit.treasuryFee
            );
        }

        _emitDepositRevealedEvent(fundingTxHash, fundingOutputAmount, reveal);
    }

    /// @notice Emits the `DepositRevealed` event.
    /// @param fundingTxHash The funding transaction hash.
    /// @param fundingOutputAmount The funding output amount in satoshi.
    /// @param reveal Deposit reveal data, see `RevealInfo struct.
    /// @dev This function is extracted to overcome the stack too deep error.
    function _emitDepositRevealedEvent(
        bytes32 fundingTxHash,
        uint64 fundingOutputAmount,
        DepositRevealInfo calldata reveal
    ) internal {
        // slither-disable-next-line reentrancy-events
        emit DepositRevealed(
            fundingTxHash,
            reveal.fundingOutputIndex,
            msg.sender,
            fundingOutputAmount,
            reveal.blindingFactor,
            reveal.walletPubKeyHash,
            reveal.refundPubKeyHash,
            reveal.refundLocktime,
            reveal.vault
        );
    }

    /// @notice Sibling of the `revealDeposit` function. This function allows
    ///         to reveal a P2(W)SH Bitcoin deposit with 32-byte extra data
    ///         embedded in the deposit script. The extra data allows to
    ///         attach additional context to the deposit. For example,
    ///         it allows a third-party smart contract to reveal the
    ///         deposit on behalf of the original depositor and provide
    ///         additional services once the deposit is handled. In this
    ///         case, the address of the original depositor can be encoded
    ///         as extra data.
    /// @param fundingTx Bitcoin funding transaction data, see `BitcoinTx.Info`.
    /// @param reveal Deposit reveal data, see `RevealInfo struct.
    /// @param extraData 32-byte deposit extra data.
    /// @dev Requirements:
    ///      - All requirements from `revealDeposit` function must be met,
    ///      - `extraData` must not be bytes32(0),
    ///      - `extraData` must be the actual extra data used in the P2(W)SH
    ///        BTC deposit transaction.
    ///
    ///      If any of these requirements is not met, the wallet _must_ refuse
    ///      to sweep the deposit and the depositor has to wait until the
    ///      deposit script unlocks to receive their BTC back.
    function revealDepositWithExtraData(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata fundingTx,
        DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
        // Strong requirement in order to differentiate from the regular
        // reveal flow and reduce potential attack surface.
        require(extraData != bytes32(0), "Extra data must not be empty");

        _revealDeposit(self, fundingTx, reveal, extraData);
    }

    /// @notice Validates the deposit refund locktime. The validation passes
    ///         successfully only if the deposit reveal is done respectively
    ///         earlier than the moment when the deposit refund locktime is
    ///         reached, i.e. the deposit become refundable. Reverts otherwise.
    /// @param refundLocktime The deposit refund locktime as 4-byte LE.
    /// @dev Requirements:
    ///      - `refundLocktime` as integer must be >= 500M
    ///      - `refundLocktime` must denote a timestamp that is at least
    ///        `depositRevealAheadPeriod` seconds later than the moment
    ///        of `block.timestamp`
    function validateDepositRefundLocktime(
        BridgeState.Storage storage self,
        bytes4 refundLocktime
    ) internal view {
        // Convert the refund locktime byte array to a LE integer. This is
        // the moment in time when the deposit become refundable.
        uint32 depositRefundableTimestamp = BTCUtils.reverseUint32(
            uint32(refundLocktime)
        );
        // According to https://developer.bitcoin.org/devguide/transactions.html#locktime-and-sequence-number
        // the locktime is parsed as a block number if less than 500M. We always
        // want to parse the locktime as an Unix timestamp so we allow only for
        // values bigger than or equal to 500M.
        require(
            depositRefundableTimestamp >= 500 * 1e6,
            "Refund locktime must be a value >= 500M"
        );
        // The deposit must be revealed before it becomes refundable.
        // This is because the sweeping wallet needs to have some time to
        // sweep the deposit and avoid a potential competition with the
        // depositor making the deposit refund.
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp + self.depositRevealAheadPeriod <=
                depositRefundableTimestamp,
            "Deposit refund locktime is too close"
        );
    }
}
