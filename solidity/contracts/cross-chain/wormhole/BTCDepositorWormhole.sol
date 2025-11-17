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

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "./Wormhole.sol";
import "../AbstractL1BTCDepositor.sol";
import "../utils/Crosschain.sol";

/// @title BTCDepositorWormhole
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain ERC20 tBTC on the destination chain, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
contract BTCDepositorWormhole is AbstractL1BTCDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice `Wormhole` core contract on L1.
    IWormhole public wormhole;
    /// @notice Wormhole `TokenBridge` contract on L1.
    IWormholeTokenBridge public wormholeTokenBridge;
    /// @notice tBTC `WormholeGateway` program public key on the destination chain.
    bytes32 public destinationChainWormholeGateway;
    /// @notice Wormhole chain ID of the destination chain.
    uint16 public destinationChainId;

    event TokensTransferredWithPayload(
        uint256 amount,
        bytes32 destinationChainReceiver,
        uint64 transferSequence
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _wormhole,
        address _wormholeTokenBridge,
        bytes32 _destinationChainWormholeGateway,
        uint16 _destinationChainId
    ) external initializer {
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();

        require(_wormhole != address(0), "Wormhole address cannot be zero");
        require(
            _wormholeTokenBridge != address(0),
            "WormholeTokenBridge address cannot be zero"
        );
        require(
            _destinationChainWormholeGateway != bytes32(0),
            "WormholeGateway address cannot be zero"
        );

        wormhole = IWormhole(_wormhole);
        wormholeTokenBridge = IWormholeTokenBridge(_wormholeTokenBridge);
        // slither-disable-next-line missing-zero-check
        destinationChainWormholeGateway = _destinationChainWormholeGateway;
        destinationChainId = _destinationChainId;
    }

    /// @notice Quotes the payment that must be attached to the `finalizeDeposit`
    ///         function call. The payment is necessary to cover the cost of
    ///         the Wormhole Relayer that is responsible for executing the
    ///         deposit finalization on the corresponding chain.
    /// @return cost The cost of the `finalizeDeposit` function call in WEI.
    function quoteFinalizeDeposit() external view returns (uint256 cost) {
        cost = wormhole.messageFee();
    }

    /// @notice Transfers ERC20 L1 tBTC to the deposit owner using the Wormhole
    ///         protocol. The function initiates a Wormhole token transfer that
    ///         locks the ERC20 L1 tBTC within the Wormhole Token Bridge contract
    ///         and assigns Wormhole-wrapped tBTC to the corresponding
    ///         `WormholeGateway` contract on the destination chain.
    /// @param amount Amount of tBTC L1 ERC20 to transfer (1e18 precision).
    /// @param destinationChainReceiver Address of the destination chain deposit owner.
    /// @dev Requirements:
    ///      - The normalized amount (1e8 precision) must be greater than 0,
    ///      - The appropriate payment for the Wormhole Relayer must be
    ///        attached to the call (as calculated by `quoteFinalizeDeposit`).
    /// @dev Implemented based on examples presented as part of the Wormhole SDK:
    ///      https://github.com/wormhole-foundation/hello-token/blob/8ec757248788dc12183f13627633e1d6fd1001bb/src/example-extensions/HelloTokenWithoutSDK.sol#L29
    function _transferTbtc(uint256 amount, bytes32 destinationChainReceiver)
        internal
        override
    {
        // Wormhole supports the 1e8 precision at most. tBTC is 1e18 so
        // the amount needs to be normalized.
        amount = WormholeUtils.normalize(amount);

        require(amount > 0, "Amount too low to bridge");

        // Cost of requesting a `finalizeDeposit` message to be sent to the destination chain
        uint256 wormholeMessageFee = wormhole.messageFee();
        require(
            msg.value == wormholeMessageFee,
            "Payment for Wormhole Relayer is too low"
        );

        // The Wormhole Token Bridge will pull the tBTC amount
        // from this contract. We need to approve the transfer first.
        tbtcToken.safeIncreaseAllowance(address(wormholeTokenBridge), amount);

        // Initiate a Wormhole token transfer that will lock L1 tBTC within
        // the Wormhole Token Bridge contract and assign Wormhole-wrapped
        // tBTC to the corresponding `WormholeGateway` contract on the
        // destination chain.
        // slither-disable-next-line arbitrary-send-eth
        uint64 transferSequence = wormholeTokenBridge.transferTokensWithPayload{
            value: wormholeMessageFee
        }(
            address(tbtcToken),
            amount,
            destinationChainId,
            destinationChainWormholeGateway,
            0, // Nonce is a free field that is not relevant in this context.
            abi.encodePacked(destinationChainReceiver) // Set the destination chain receiver address as the transfer payload.
        );

        // slither-disable-next-line reentrancy-events
        emit TokensTransferredWithPayload(
            amount,
            destinationChainReceiver,
            transferSequence
        );
    }
}
