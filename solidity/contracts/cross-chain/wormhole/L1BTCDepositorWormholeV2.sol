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

/// @title L1BTCDepositorWormholeV2
/// @notice V2 implementation of the L1 tBTC depositor using Wormhole protocol
///         for cross-chain token transfers. This contract replaces the Standard
///         Relaying pattern (`sendVaasToEvm`) used in V1 with a direct
///         `transferTokensWithPayload` call and an explicit event emission for
///         off-chain relayer discovery. Designed as a proxy-compatible upgrade
///         from `L1BTCDepositorWormhole` (V1), preserving the exact storage
///         layout.
contract L1BTCDepositorWormholeV2 is AbstractL1BTCDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // -----------------------------------------------------------------------
    // Storage variables -- MUST match L1BTCDepositorWormhole (V1) exactly.
    // The proxy upgrade depends on identical slot positions. Do NOT reorder,
    // insert, or remove any variable before `l2FinalizeDepositGasLimit`.
    // -----------------------------------------------------------------------

    /// @notice `Wormhole` core contract on L1.
    IWormhole public wormhole;
    /// @notice `WormholeRelayer` contract on L1. Preserved at slot 12 for
    ///         storage layout compatibility with V1. No longer used in V2
    ///         because Standard Relaying has been replaced by direct
    ///         `transferTokensWithPayload` calls.
    IWormholeRelayer public wormholeRelayer;
    /// @notice Wormhole `TokenBridge` contract on L1.
    IWormholeTokenBridge public wormholeTokenBridge;
    /// @notice tBTC `L2WormholeGateway` contract on the corresponding L2 chain.
    address public l2WormholeGateway;
    /// @notice Wormhole chain ID of the corresponding L2 chain.
    uint16 public l2ChainId;
    /// @notice tBTC `L2BTCDepositorWormhole` contract on the corresponding L2 chain.
    address public l2BtcDepositor;
    /// @notice Gas limit field preserved for storage layout compatibility
    ///         with V1. No longer used in V2 because Standard Relaying
    ///         delivery pricing has been removed.
    uint256 public l2FinalizeDepositGasLimit;

    /// @notice Emitted when the gas limit field is updated by the owner.
    ///         Preserved for backward compatibility with V1.
    event L2FinalizeDepositGasLimitUpdated(uint256 l2FinalizeDepositGasLimit);

    /// @notice Emitted when tBTC tokens are transferred via Wormhole
    ///         `transferTokensWithPayload`. Off-chain relayers monitor this
    ///         event to discover the transfer VAA and complete the bridging
    ///         on the destination L2 chain.
    /// @param amount The normalized tBTC amount transferred (1e18 precision,
    ///        Wormhole-normalized to 1e8 granularity).
    /// @param l2Receiver The destination chain deposit owner address.
    /// @param transferSequence The Wormhole sequence number returned by
    ///        `transferTokensWithPayload`, used to locate the transfer VAA.
    event TokensTransferredWithPayload(
        uint256 amount,
        address l2Receiver,
        uint64 transferSequence
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev This initializer mirrors V1 for fresh proxy deployments (e.g. in
    ///      tests). On mainnet, the proxy is already initialized so this
    ///      function cannot be called again (the `initializer` modifier
    ///      prevents re-initialization).
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

    /// @notice Updates the gas limit field. Preserved for backward
    ///         compatibility with V1. The gas limit is no longer used in V2
    ///         for relay delivery pricing.
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
    ///         function call. In V2, only the Wormhole core message fee is
    ///         required (no Standard Relaying delivery cost).
    /// @return cost The cost of the `finalizeDeposit` function call in WEI.
    function quoteFinalizeDeposit() external view returns (uint256 cost) {
        cost = wormhole.messageFee();
    }

    /// @notice Transfers ERC20 L1 tBTC to the L2 deposit owner using the
    ///         Wormhole protocol. The function initiates a Wormhole token
    ///         transfer that locks the ERC20 L1 tBTC within the Wormhole
    ///         Token Bridge contract and assigns Wormhole-wrapped L2 tBTC to
    ///         the corresponding `L2WormholeGateway` contract. An event is
    ///         emitted containing the transfer sequence number, which off-chain
    ///         relayers use to discover the transfer VAA and complete the
    ///         bridging on the destination L2 chain.
    /// @param amount Amount of tBTC L1 ERC20 to transfer (1e18 precision).
    /// @param l2Receiver Address of the L2 deposit owner.
    /// @dev Requirements:
    ///      - The normalized amount (1e8 precision) must be greater than 0,
    ///      - The Wormhole core message fee must be attached to the call
    ///        (as calculated by `quoteFinalizeDeposit`).
    /// @dev The transfer payload uses `abi.encode(l2Receiver)` to match the
    ///      encoding used by V1. The `L2WormholeGateway` on Arbitrum and
    ///      Base expects this specific encoding, which differs from the
    ///      `abi.encodePacked` used by the SUI variant in
    ///      `BTCDepositorWormhole`.
    function _transferTbtc(uint256 amount, bytes32 l2Receiver)
        internal
        override
    {
        // Wormhole supports the 1e8 precision at most. tBTC is 1e18 so
        // the amount needs to be normalized.
        amount = WormholeUtils.normalize(amount);

        require(amount > 0, "Amount too low to bridge");

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

        // slither-disable-next-line reentrancy-events
        emit TokensTransferredWithPayload(
            amount,
            address(uint160(uint256(l2Receiver))),
            transferSequence
        );
    }
}
