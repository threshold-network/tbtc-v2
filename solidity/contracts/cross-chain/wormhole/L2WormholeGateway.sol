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

pragma solidity ^0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import "./Wormhole.sol";
import "./L2TBTC.sol";

/// @title L2WormholeGateway
/// @notice Selected cross-ecosystem bridges are given the minting authority for
///         tBTC token on L2 and sidechains. This contract gives a minting
///         authority to the Wormhole Bridge.
///
///         The process of bridging from L1 to L2 (or sidechain) looks as
///         follows:
///         1. There is a tBTC holder on L1. The holder goes to the Wormhole
///            Portal and selects the chain they want to bridge to.
///         2. The holder submits one transaction to L1 locking their tBTC
///            tokens in the bridge’s smart contract. After the transaction is
///            mined, they wait about 15 minutes for the Ethereum block
///            finality.
///         3. The holder submits one transaction to L2 that is minting tokens.
///            After that transaction is mined, they have their tBTC on L2.
///
///         The process of bridging from L2 (or sidechain) to L1 looks as
///         follows:
///         1. There is a tBTC holder on L2. That holder goes to the Wormhole
///            Portal and selects one of the L2 chains they want to bridge from.
///         2. The holder submits one transaction to L2 that is burning the
///            token. After the transaction is mined, they wait about 15 minutes
///            for the L2 block finality.
///         3. The holder submits one transaction to L1 unlocking their tBTC
///            tokens from the bridge’s smart contract. After that transaction
///            is mined, they have their tBTC on L1.
///
///         This smart contract is integrated with step 3 of L1->L2 bridging and
///         step 1 of L2->L1 or L2->L2 bridging. When the user redeems token on
///         L2, this contract receives the Wormhole tBTC representation and
///         mints the canonical tBTC in an equal amount. When user sends their
///         token from L1, this contract burns the canonical tBTC and sends
///         Wormhole tBTC representation through the bridge in an equal amount.
/// @dev This contract is supposed to be deployed behind a transparent
///      upgradeable proxy.
// slither-disable-next-line missing-inheritance
contract L2WormholeGateway is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Reference to the Wormhole Token Bridge contract.
    IWormholeTokenBridge public bridge;

    /// @notice Wormhole tBTC token representation.
    IERC20Upgradeable public bridgeToken;

    /// @notice Canonical tBTC token.
    L2TBTC public tbtc;

    /// @notice Maps Wormhole chain ID to the Wormhole tBTC gateway address on
    ///         that chain. For example, this chain's ID should be mapped to
    ///         this contract's address. If there is no Wormhole tBTC gateway
    ///         address on the given chain, there is no entry in this mapping.
    ///         The mapping holds addresses in a Wormhole-specific format, where
    ///         Ethereum address is left-padded with zeros.
    mapping(uint16 => bytes32) public gateways;

    /// @notice Minting limit for this gateway. Useful for early days of testing
    ///         the system. The gateway can not mint more canonical tBTC than
    ///         this limit.
    uint256 public mintingLimit;

    /// @notice The amount of tBTC minted by this contract. tBTC burned by this
    ///         contract decreases this amount.
    uint256 public mintedAmount;

    event WormholeTbtcReceived(address receiver, uint256 amount);

    event WormholeTbtcSent(
        uint256 amount,
        uint16 recipientChain,
        bytes32 gateway,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    );

    event WormholeTbtcDeposited(address depositor, uint256 amount);

    event GatewayAddressUpdated(uint16 chainId, bytes32 gateway);

    event MintingLimitUpdated(uint256 mintingLimit);

    function initialize(
        IWormholeTokenBridge _bridge,
        IERC20Upgradeable _bridgeToken,
        L2TBTC _tbtc
    ) external initializer {
        __Ownable_init();
        __ReentrancyGuard_init();

        require(
            address(_bridge) != address(0),
            "Wormhole bridge address must not be 0x0"
        );
        require(
            address(_bridgeToken) != address(0),
            "Bridge token address must not be 0x0"
        );
        require(
            address(_tbtc) != address(0),
            "L2TBTC token address must not be 0x0"
        );

        bridge = _bridge;
        bridgeToken = _bridgeToken;
        tbtc = _tbtc;
        mintingLimit = type(uint256).max;
    }

    /// @notice This function is called when the user sends their token from L2.
    ///         The contract burns the canonical tBTC from the user and sends
    ///         wormhole tBTC representation over the bridge.
    ///         Keep in mind that when multiple bridges receive a minting
    ///         authority on the canonical tBTC, this function may not be able
    ///         to send all amounts of tBTC through the Wormhole bridge. The
    ///         capability of Wormhole Bridge to send tBTC from the chain is
    ///         limited to the amount of tBTC bridged through Wormhole to that
    ///         chain.
    /// @dev Requirements:
    ///      - The sender must have at least `amount` of the canonical tBTC and
    ///        it has to be approved for L2WormholeGateway.
    ///      - The L2WormholeGateway must have at least `amount` of the wormhole
    ///        tBTC.
    ///      - The recipient must not be 0x0.
    ///      - The amount to transfer must not be 0,
    ///      - The amount to transfer must be >= 10^10 (1e18 precision).
    ///      Depending if Wormhole tBTC gateway is registered on the target
    ///      chain, this function uses transfer or transfer with payload over
    ///      the Wormhole bridge.
    /// @param amount The amount of tBTC to be sent.
    /// @param recipientChain The Wormhole recipient chain ID.
    /// @param recipient The address of the recipient in the Wormhole format.
    /// @param arbiterFee The Wormhole arbiter fee. Ignored if sending
    ///                   tBTC to chain with Wormhole tBTC gateway.
    /// @param nonce The Wormhole nonce used to batch messages together.
    /// @return The Wormhole sequence number.
    function sendTbtc(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    ) external payable nonReentrant returns (uint64) {
        require(recipient != bytes32(0), "0x0 recipient not allowed");
        require(amount != 0, "Amount must not be 0");

        // Normalize the amount to bridge. The dust can not be bridged due to
        // the decimal shift in the Wormhole Bridge contract.
        amount = WormholeUtils.normalize(amount);

        // Check again after dropping the dust.
        require(amount != 0, "Amount too low to bridge");

        require(
            bridgeToken.balanceOf(address(this)) >= amount,
            "Not enough wormhole tBTC in the gateway to bridge"
        );

        bytes32 gateway = gateways[recipientChain];

        emit WormholeTbtcSent(
            amount,
            recipientChain,
            gateway,
            recipient,
            arbiterFee,
            nonce
        );

        mintedAmount -= amount;
        tbtc.burnFrom(msg.sender, amount);
        bridgeToken.safeApprove(address(bridge), amount);

        if (gateway == bytes32(0)) {
            // No Wormhole tBTC gateway on the target chain. The token minted
            // by Wormhole should be considered canonical.
            return
                bridge.transferTokens{value: msg.value}(
                    address(bridgeToken),
                    amount,
                    recipientChain,
                    recipient,
                    arbiterFee,
                    nonce
                );
        } else {
            // There is a Wormhole tBTC gateway on the target chain.
            // The gateway needs to mint canonical tBTC for the recipient
            // encoded in the payload.
            return
                bridge.transferTokensWithPayload{value: msg.value}(
                    address(bridgeToken),
                    amount,
                    recipientChain,
                    gateway,
                    nonce,
                    abi.encode(recipient)
                );
        }
    }

    /// @notice This function is called when the user sends their token from L2.
    ///         The contract burns the canonical tBTC from the user and sends
    ///         wormhole tBTC representation over the bridge.
    ///         Keep in mind that when multiple bridges receive a minting
    ///         authority on the canonical tBTC, this function may not be able
    ///         to send all amounts of tBTC through the Wormhole bridge. The
    ///         capability of Wormhole Bridge to send tBTC from the chain is
    ///         limited to the amount of tBTC bridged through Wormhole to that
    ///         chain.
    /// @dev Requirements:
    ///      - The sender must have at least `amount` of the canonical tBTC and
    ///        it has to be approved for L2WormholeGateway.
    ///      - The L2WormholeGateway must have at least `amount` of the wormhole
    ///        tBTC.
    ///      - The recipient must not be 0x0.
    ///      - The amount to transfer must not be 0,
    ///      - The amount to transfer must be >= 10^10 (1e18 precision).
    ///      This function uses `transferTokensWithPayload` to send tBTC directly
    ///      to the `recipient` contract address on the recipient chain. The `arbiterFee` is
    ///      not applicable and implicitly 0.
    /// @param amount The amount of tBTC to be sent.
    /// @param recipientChain The Wormhole chain ID of the recipient chain.
    /// @param recipient The Wormhole-formatted address of the target contract on the recipient chain
    ///                  that will receive the tokens and process the payload.
    /// @param nonce The Wormhole nonce used to batch messages together.
    /// @param payload The arbitrary data to be passed to and processed by the `recipient`
    ///                contract on the recipient chain.
    /// @return The Wormhole sequence number.
    function sendTbtcWithPayload(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint32 nonce,
        bytes calldata payload
    ) external payable nonReentrant returns (uint64) {
        require(recipient != bytes32(0), "0x0 recipient not allowed");
        require(amount != 0, "Amount must not be 0");

        // Normalize the amount to bridge. The dust can not be bridged due to
        // the decimal shift in the Wormhole Bridge contract.
        amount = WormholeUtils.normalize(amount);

        // Check again after dropping the dust.
        require(amount != 0, "Amount too low to bridge");

        require(
            bridgeToken.balanceOf(address(this)) >= amount,
            "Not enough wormhole tBTC in the gateway to bridge"
        );

        emit WormholeTbtcSent(
            amount,
            recipientChain,
            bytes32(0), // No specific tBTC gateway from 'gateways' mapping is used; 'recipient' is the direct target contract.
            recipient,
            0, // arbiterFee is 0 as this function sends with payload
            nonce
        );

        mintedAmount -= amount;
        tbtc.burnFrom(msg.sender, amount);
        bridgeToken.safeApprove(address(bridge), amount);

        return
            bridge.transferTokensWithPayload{value: msg.value}(
                address(bridgeToken),
                amount,
                recipientChain,
                recipient,
                nonce,
                payload
            );
    }

    /// @notice This function is called when the user redeems their token on L2.
    ///         The contract receives Wormhole tBTC representation and mints the
    ///         canonical tBTC for the user.
    ///         If the tBTC minting limit has been reached by this contract,
    ///         instead of minting tBTC the receiver address receives Wormhole
    ///         tBTC representation.
    /// @dev Requirements:
    ///      - The receiver of Wormhole tBTC should be the L2WormholeGateway
    ///        contract.
    ///      - The receiver of the canonical tBTC should be abi-encoded in the
    ///        payload.
    ///      - The receiver of the canonical tBTC must not be the zero address.
    ///
    ///      The Wormhole Token Bridge contract has protection against redeeming
    ///      the same VAA again. When a Token Bridge VAA is redeemed, its
    ///      message body hash is stored in a map. This map is used to check
    ///      whether the hash has already been set in this map. For this reason,
    ///      this function does not have to be nonReentrant in theory. However,
    ///      to make this function non-dependent on Wormhole Bridge implementation,
    ///      we are making it nonReentrant anyway.
    /// @param encodedVm A byte array containing a Wormhole VAA signed by the
    ///        guardians.
    function receiveTbtc(bytes calldata encodedVm) external nonReentrant {
        // ITokenBridge.completeTransferWithPayload completes a contract-controlled
        // transfer of an ERC20 token. Calling this function is not enough to
        // ensure L2WormholeGateway received Wormhole tBTC representation.
        // Instead of going too deep into the ITokenBridge implementation,
        // asserting who is the receiver of the token, and which token it is,
        // we check the balance before the ITokenBridge call and the balance
        // after ITokenBridge call. This way, we are sure this contract received
        // Wormhole tBTC token in the given amount. This is transparent to
        // all potential upgrades of ITokenBridge implementation and no other
        // validations are needed.
        uint256 balanceBefore = bridgeToken.balanceOf(address(this));
        bytes memory encoded = bridge.completeTransferWithPayload(encodedVm);
        uint256 balanceAfter = bridgeToken.balanceOf(address(this));

        uint256 amount = balanceAfter - balanceBefore;
        // Protect against the custody of irrelevant tokens.
        require(amount > 0, "No tBTC transferred");

        address receiver = fromWormholeAddress(
            bytes32(bridge.parseTransferWithPayload(encoded).payload)
        );
        require(receiver != address(0), "0x0 receiver not allowed");

        // We send wormhole tBTC OR mint canonical tBTC. We do not want to send
        // dust. Sending wormhole tBTC is an exceptional situation and we want
        // to keep it simple.
        if (mintedAmount + amount > mintingLimit) {
            bridgeToken.safeTransfer(receiver, amount);
        } else {
            // The function is non-reentrant.
            // slither-disable-next-line reentrancy-benign
            mintedAmount += amount;
            tbtc.mint(receiver, amount);
        }

        // The function is non-reentrant.
        // slither-disable-next-line reentrancy-events
        emit WormholeTbtcReceived(receiver, amount);
    }

    /// @notice Lets the governance to update the tBTC gateway address on the
    ///         chain with the given Wormhole ID.
    /// @dev Use toWormholeAddress function to convert between Ethereum and
    ///      Wormhole address formats.
    /// @param chainId Wormhole ID of the chain.
    /// @param gateway Address of tBTC gateway on the given chain in a Wormhole
    ///                format.
    function updateGatewayAddress(uint16 chainId, bytes32 gateway)
        external
        onlyOwner
    {
        gateways[chainId] = gateway;
        emit GatewayAddressUpdated(chainId, gateway);
    }

    /// @notice Lets the governance to update the tBTC minting limit for this
    ///         contract.
    /// @param _mintingLimit The new minting limit.
    function updateMintingLimit(uint256 _mintingLimit) external onlyOwner {
        mintingLimit = _mintingLimit;
        emit MintingLimitUpdated(_mintingLimit);
    }

    /// @notice Converts Ethereum address into Wormhole format.
    /// @param _address The address to convert.
    function toWormholeAddress(address _address)
        external
        pure
        returns (bytes32)
    {
        return WormholeUtils.toWormholeAddress(_address);
    }

    /// @notice Converts Wormhole address into Ethereum format.
    /// @param _address The address to convert.
    function fromWormholeAddress(bytes32 _address)
        public
        pure
        returns (address)
    {
        return WormholeUtils.fromWormholeAddress(_address);
    }
}
