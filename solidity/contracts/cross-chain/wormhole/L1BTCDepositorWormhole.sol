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

/// @title L1BTCDepositorWormhole
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain ERC20 tBTC on supported L2 chains, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
contract L1BTCDepositorWormhole is AbstractL1BTCDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice `Wormhole` core contract on L1.
    IWormhole public wormhole;
    /// @notice `WormholeRelayer` contract on L1.
    IWormholeRelayer public wormholeRelayer;
    /// @notice Wormhole `TokenBridge` contract on L1.
    IWormholeTokenBridge public wormholeTokenBridge;
    /// @notice tBTC `L2WormholeGateway` contract on the corresponding L2 chain.
    address public l2WormholeGateway;
    /// @notice Wormhole chain ID of the corresponding L2 chain.
    uint16 public l2ChainId;
    /// @notice tBTC `L2BTCDepositorWormhole` contract on the corresponding L2 chain.
    address public l2BtcDepositor;
    /// @notice Gas limit necessary to execute the L2 part of the deposit
    ///         finalization. This value is used to calculate the payment for
    ///         the Wormhole Relayer that is responsible to execute the
    ///         deposit finalization on the corresponding L2 chain. Can be
    ///         updated by the owner.
    uint256 public l2FinalizeDepositGasLimit;

    event L2FinalizeDepositGasLimitUpdated(uint256 l2FinalizeDepositGasLimit);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _wormhole,
        address _wormholeRelayer,
        address _wormholeTokenBridge,
        address _l2WormholeGateway,
        uint16 _l2ChainId
    ) external initializer {
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();

        require(_wormhole != address(0), "Wormhole address cannot be zero");
        require(
            _wormholeRelayer != address(0),
            "WormholeRelayer address cannot be zero"
        );
        require(
            _wormholeTokenBridge != address(0),
            "WormholeTokenBridge address cannot be zero"
        );
        require(
            _l2WormholeGateway != address(0),
            "L2WormholeGateway address cannot be zero"
        );

        wormhole = IWormhole(_wormhole);
        wormholeRelayer = IWormholeRelayer(_wormholeRelayer);
        wormholeTokenBridge = IWormholeTokenBridge(_wormholeTokenBridge);
        // slither-disable-next-line missing-zero-check
        l2WormholeGateway = _l2WormholeGateway;
        l2ChainId = _l2ChainId;
        l2FinalizeDepositGasLimit = 500_000;
    }

    /// @notice Sets the address of the `L2BTCDepositorWormhole` contract on the
    ///         corresponding L2 chain. This function solves the chicken-and-egg
    ///         problem of setting the `L2BTCDepositorWormhole` contract address
    ///         on the `AbstractL1BTCDepositor` contract and vice versa.
    /// @param _l2BtcDepositor Address of the `L2BTCDepositorWormhole` contract.
    /// @dev Requirements:
    ///      - Can be called only by the contract owner,
    ///      - The address must not be set yet,
    ///      - The new address must not be 0x0.
    function attachL2BtcDepositor(address _l2BtcDepositor) external onlyOwner {
        require(
            l2BtcDepositor == address(0),
            "L2 Bitcoin Depositor already set"
        );
        require(
            _l2BtcDepositor != address(0),
            "L2 Bitcoin Depositor must not be 0x0"
        );
        l2BtcDepositor = _l2BtcDepositor;
    }

    /// @notice Updates the gas limit necessary to execute the L2 part of the
    ///         deposit finalization.
    /// @param _l2FinalizeDepositGasLimit New gas limit.
    /// @dev Requirements:
    ///      - Can be called only by the contract owner.
    function updateL2FinalizeDepositGasLimit(uint256 _l2FinalizeDepositGasLimit)
        external
        onlyOwner
    {
        l2FinalizeDepositGasLimit = _l2FinalizeDepositGasLimit;
        emit L2FinalizeDepositGasLimitUpdated(_l2FinalizeDepositGasLimit);
    }

    /// @notice Quotes the payment that must be attached to the `finalizeDeposit`
    ///         function call. The payment is necessary to cover the cost of
    ///         the Wormhole Relayer that is responsible for executing the
    ///         deposit finalization on the corresponding L2 chain.
    /// @return cost The cost of the `finalizeDeposit` function call in WEI.
    function quoteFinalizeDeposit() external view returns (uint256 cost) {
        cost = _quoteFinalizeDeposit(wormhole.messageFee());
    }

    /// @notice Internal version of the `quoteFinalizeDeposit` function that
    ///         works with a custom Wormhole message fee.
    /// @param messageFee Custom Wormhole message fee.
    /// @return cost The cost of the `finalizeDeposit` function call in WEI.
    /// @dev Implemented based on examples presented as part of the Wormhole SDK:
    ///      https://github.com/wormhole-foundation/hello-token/blob/8ec757248788dc12183f13627633e1d6fd1001bb/src/example-extensions/HelloTokenWithoutSDK.sol#L23
    function _quoteFinalizeDeposit(uint256 messageFee)
        internal
        view
        returns (uint256 cost)
    {
        // Cost of delivering token and payload to `l2ChainId`.
        (uint256 deliveryCost, ) = wormholeRelayer.quoteEVMDeliveryPrice(
            l2ChainId,
            0,
            l2FinalizeDepositGasLimit
        );

        // Total cost = delivery cost + cost of publishing the `sending token`
        // Wormhole message.
        cost = deliveryCost + messageFee;
    }

    /// @notice Transfers ERC20 L1 tBTC to the L2 deposit owner using the Wormhole
    ///         protocol. The function initiates a Wormhole token transfer that
    ///         locks the ERC20 L1 tBTC within the Wormhole Token Bridge contract
    ///         and assigns Wormhole-wrapped L2 tBTC to the corresponding
    ///         `L2WormholeGateway` contract. Then, the function notifies the
    ///         `L2BTCDepositorWormhole` contract by sending a Wormhole message
    ///         containing the VAA of the Wormhole token transfer. The
    ///         `L2BTCDepositorWormhole` contract receives the Wormhole message,
    ///         and calls the `L2WormholeGateway` contract that redeems
    ///         Wormhole-wrapped L2 tBTC from the Wormhole Token Bridge and
    ///         uses it to mint canonical L2 tBTC to the L2 deposit owner address.
    /// @param amount Amount of tBTC L1 ERC20 to transfer (1e18 precision).
    /// @param l2Receiver Address of the L2 deposit owner.
    /// @dev Requirements:
    ///      - The normalized amount (1e8 precision) must be greater than 0,
    ///      - The appropriate payment for the Wormhole Relayer must be
    ///        attached to the call (as calculated by `quoteFinalizeDeposit`).
    /// @dev Implemented based on examples presented as part of the Wormhole SDK:
    ///      https://github.com/wormhole-foundation/hello-token/blob/8ec757248788dc12183f13627633e1d6fd1001bb/src/example-extensions/HelloTokenWithoutSDK.sol#L29
    function _transferTbtc(uint256 amount, bytes32 l2Receiver)
        internal
        override
    {
        // Wormhole supports the 1e8 precision at most. tBTC is 1e18 so
        // the amount needs to be normalized.
        amount = WormholeUtils.normalize(amount);

        require(amount > 0, "Amount too low to bridge");

        // Cost of requesting a `finalizeDeposit` message to be sent to
        //  `l2ChainId` with a gasLimit of `l2FinalizeDepositGasLimit`.
        uint256 wormholeMessageFee = wormhole.messageFee();
        uint256 cost = _quoteFinalizeDeposit(wormholeMessageFee);

        require(msg.value == cost, "Payment for Wormhole Relayer is too low");

        // The Wormhole Token Bridge will pull the tBTC amount
        // from this contract. We need to approve the transfer first.
        tbtcToken.safeIncreaseAllowance(address(wormholeTokenBridge), amount);

        // Initiate a Wormhole token transfer that will lock L1 tBTC within
        // the Wormhole Token Bridge contract and assign Wormhole-wrapped
        // L2 tBTC to the corresponding `L2WormholeGateway` contract.
        // slither-disable-next-line arbitrary-send-eth
        uint64 transferSequence = wormholeTokenBridge.transferTokensWithPayload{
            value: wormholeMessageFee
        }(
            address(tbtcToken),
            amount,
            l2ChainId,
            CrosschainUtils.addressToBytes32(l2WormholeGateway),
            0, // Nonce is a free field that is not relevant in this context.
            abi.encode(l2Receiver) // Set the L2 receiver address as the transfer payload.
        );

        // Construct the VAA key corresponding to the above Wormhole token transfer.
        WormholeTypes.VaaKey[]
            memory additionalVaas = new WormholeTypes.VaaKey[](1);
        additionalVaas[0] = WormholeTypes.VaaKey({
            chainId: wormhole.chainId(),
            emitterAddress: CrosschainUtils.addressToBytes32(
                address(wormholeTokenBridge)
            ),
            sequence: transferSequence
        });

        // The Wormhole token transfer initiated above must be finalized on
        // the L2 chain. We achieve that by sending the transfer's VAA to the
        // `L2BTCDepositorWormhole` contract. Once, the `L2BTCDepositorWormhole`
        // contract receives it, it calls the `L2WormholeGateway` contract
        // that redeems Wormhole-wrapped L2 tBTC from the Wormhole Token
        // Bridge and use it to mint canonical L2 tBTC to the receiver address.
        // slither-disable-next-line arbitrary-send-eth,unused-return
        wormholeRelayer.sendVaasToEvm{value: cost - wormholeMessageFee}(
            l2ChainId,
            l2BtcDepositor,
            bytes(""), // No payload needed. The L2 receiver address is already encoded in the Wormhole token transfer payload.
            0, // No receiver value needed.
            l2FinalizeDepositGasLimit,
            additionalVaas,
            l2ChainId, // Set the L2 chain as the refund chain to avoid cross-chain refunds.
            msg.sender // Set the caller as the refund receiver.
        );
    }
}
