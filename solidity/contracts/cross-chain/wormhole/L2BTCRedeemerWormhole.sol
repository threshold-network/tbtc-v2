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

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import "./Wormhole.sol";
import "../../integrator/IL2WormholeGateway.sol";

/// @title L2BTCRedeemerWormhole
/// @notice This contract enables users on an L2/sidechain to redeem their
///         canonical L2TBTC tokens for actual BTC on L1 (Ethereum). It acts as
///         an intermediary, collecting L2TBTC from users and interfacing with
///         the L2WormholeGateway to initiate the cross-chain redemption process
///         via Wormhole.
///
///         The process of redeeming L2TBTC for L1 BTC via this contract is as follows:
///         1. A user holds L2TBTC on this L2/sidechain and wishes to receive BTC on Bitcoin network.
///         2. The user approves this L2BTCRedeemerWormhole contract to spend their L2TBTC.
///         3. The user calls the `requestRedemption` function on this contract, providing:
///            - The amount of L2TBTC to redeem.
///            - Their Bitcoin output script (e.g., P2PKH, P2WPKH) for receiving BTC on Bitcoin network.
///            - A unique identifier for the transaction..
///         4. This L2BTCRedeemerWormhole contract:
///            a. Takes custody of the specified amount of L2TBTC from the user.
///            b. Calls the `sendTbtcWithPayloadToEthereum` function on the
///               L2WormholeGateway contract.
///         5. The L2WormholeGateway contract then:
///            a. Burns the L2TBTC tokens (now held by L2BTCRedeemerWormhole).
///            b. Sends a Wormhole message to Ethereum (L1). This message includes
///               the user's Bitcoin output script as a payload and targets a
///               pre-configured L1 BTC Redeemer contract (specified by
///               `l1BtcRedeemerWormholeAddress`).
///         6. On L1, the designated L1 BTC Redeemer contract receives the Wormhole
///            message. It is then responsible for processing the payload (the Bitcoin
///            output script) and facilitating the release of actual BTC to the user's
///            specified Bitcoin address.
///
/// @dev This contract is designed to be upgradeable via a transparent proxy.
///      It relies on a configured L2WormholeGateway for Wormhole interactions
///      and an L1 BTC Redeemer contract on Ethereum (L1) for the final BTC
///      settlement. This contract itself does not mint L2TBTC or handle L1->L2
///      bridging; its sole focus is facilitating the L2->L1 tBTC redemption.
// slither-disable-next-line missing-inheritance
contract L2BTCRedeemerWormhole is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using BTCUtils for bytes;

    /// @notice Reference to the Wormhole Gateway contract.
    IL2WormholeGateway public gateway;

    /// @notice Canonical L2 tBTC token.
    IERC20Upgradeable public tbtc;

    /// @notice Minimum amount of tBTC that can be redeemed.
    uint256 public minimumRedemptionAmount;

    /// @notice The address of the L1 Bitcoin redeemer on Wormhole-formatted
    ///         address.
    bytes32 public l1BtcRedeemerWormholeAddress;

    /// @notice The amount of tBTC that has been redeemed by this contract.
    uint256 public redeemedAmount;

    event RedemptionRequestedOnL2(
        uint256 amount,
        bytes redeemerOutputScript,
        uint32 nonce
    );

    event MinimumRedemptionAmountUpdated(uint256 newMinimumAmount);

    function initialize(
        address _tbtc,
        address _gateway,
        bytes32 _l1BtcRedeemerWormholeAddress
    ) external initializer {
        __Ownable_init();
        __ReentrancyGuard_init();

        require(
            address(_tbtc) != address(0),
            "L2TBTC token address must not be 0x0"
        );
        require(
            address(_gateway) != address(0),
            "Gateway address must not be 0x0"
        );
        require(
            _l1BtcRedeemerWormholeAddress != bytes32(0),
            "L1 BTC redeemer Wormhole address must not be 0x0"
        );

        tbtc = IERC20Upgradeable(_tbtc);
        gateway = IL2WormholeGateway(_gateway);
        l1BtcRedeemerWormholeAddress = _l1BtcRedeemerWormholeAddress;
        minimumRedemptionAmount = 1e16; // 0.01 tBTC
    }

    /// @notice This function is called when the user sends their token from L2
    ///         to redeem for BTC on L1. The contract first takes custody of the
    ///         user's canonical tBTC, then instructs the L2WormholeGateway to
    ///         burn these tokens and initiate a Wormhole transfer with a payload
    ///         (the redeemerOutputScript) to the L1 BTC Redeemer.
    /// @dev Requirements:
    ///      - The sender (msg.sender) must have at least `amount` of canonical tBTC.
    ///      - The sender (msg.sender) must have approved this contract (L2BTCRedeemerWormhole)
    ///        to spend at least `amount` of their canonical tBTC.
    ///      - The `redeemerOutputScript` must be a standard Bitcoin script type.
    ///      - The `amount` must meet the `minimumRedemptionAmount`.
    ///      - The `amount` after normalization must not be 0.
    /// @param amount The amount of tBTC to be redeemed.
    /// @param redeemerOutputScript The Bitcoin output script for the L1 BTC recipient.
    /// @param nonce The Wormhole nonce (unique identifier for the transaction).
    /// @return The Wormhole sequence number.
    function requestRedemption(
        uint256 amount,
        bytes calldata redeemerOutputScript,
        uint32 nonce
    ) external payable nonReentrant returns (uint64) {
        // Validate if redeemer output script is a correct standard type
        // (P2PKH, P2WPKH, P2SH or P2WSH). This is done by using
        // `BTCUtils.extractHashAt` on it. Such a function extracts the payload
        // properly only from standard outputs so if it succeeds, we have a
        // guarantee the redeemer output script is proper. The underlying way
        // of validation is the same as in tBTC v1.
        bytes memory redeemerOutputScriptMem = redeemerOutputScript;
        bytes memory redeemerOutputScriptPayload = redeemerOutputScriptMem
            .extractHashAt(0, redeemerOutputScriptMem.length);

        require(
            redeemerOutputScriptPayload.length > 0,
            "Redeemer output script must be a standard type"
        );

        // Normalize the amount to bridge. The dust can not be bridged due to
        // the decimal shift in the Wormhole Bridge contract.
        amount = WormholeUtils.normalize(amount);
        require(amount >= minimumRedemptionAmount, "Amount too low to redeem");

        redeemedAmount += amount;

        // Transfer user's tBTC to this contract.
        // The user must have previously approved this contract to spend this amount.
        tbtc.safeTransferFrom(msg.sender, address(this), amount);

        // Approve the L2WormholeGateway to spend/burn tBTC held by this contract.
        // This allows the gateway's sendTbtcWithPayloadToEthereum function to
        // successfully call tbtc.burnFrom(address(this), amount).
        tbtc.safeIncreaseAllowance(address(gateway), amount);

        // slither-disable-next-line reentrancy-events
        emit RedemptionRequestedOnL2(amount, redeemerOutputScript, nonce);

        return
            gateway.sendTbtcWithPayloadToEthereum{value: msg.value}(
                amount,
                l1BtcRedeemerWormholeAddress,
                nonce,
                redeemerOutputScript
            );
    }

    /// @notice Lets the governance update the minimum redemption amount.
    /// @param _newMinimumRedemptionAmount The new minimum redemption amount.
    function updateMinimumRedemptionAmount(uint256 _newMinimumRedemptionAmount)
        external
        onlyOwner
    {
        require(
            _newMinimumRedemptionAmount != 0,
            "Minimum redemption amount must not be 0"
        );
        minimumRedemptionAmount = _newMinimumRedemptionAmount;
        emit MinimumRedemptionAmountUpdated(_newMinimumRedemptionAmount);
    }
}
