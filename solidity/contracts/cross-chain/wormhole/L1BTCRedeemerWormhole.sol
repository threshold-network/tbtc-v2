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

import "@keep-network/random-beacon/contracts/Reimbursable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "./Wormhole.sol";
import "../../integrator/AbstractBTCRedeemer.sol";
import "../utils/Crosschain.sol";

/// @title L1BTCRedeemerWormhole
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to redeem ERC20 tBTC from a supported chain (L2) back to
///         Bitcoin, without the need to interact directly with the L1 tBTC
///         ledger chain where the redemption is processed.
///
///         `L1BTCRedeemerWormhole` is deployed on the L1 chain and interacts with
///         its destination chain counterpart (e.g., `L2BTCRedeemer` on an L2 chain).
///         Each `L1BTCRedeemerWormhole` & `L2BTCRedeemer` (or equivalent)
///         pair is responsible for a specific L2 chain.
///
///         The outline of the direct redemption mechanism is as follows:
///         1. An L2 user initiates a redemption request on the L2 chain, specifying
///            the amount of tBTC to redeem and their Bitcoin destination address.
///         2. The L2 contract sends this request (via a cross-chain message via Wormhole VAA)
///            to the `L1BTCRedeemerWormhole` on L1.
///         3. The `L1BTCRedeemerWormhole` receives the tBTC from the L2 (via the token bridge)
///            and then calls the tBTC `Bridge` contract on L1 to request the redemption,
///            providing the user's Bitcoin address.
///         4. The tBTC `Bridge` handles the redemption process, and the user eventually
///            receives Bitcoin in their specified address.
///         5. Relayers (or other authorized entities) might be involved in facilitating
///            the cross-chain communication and L1 transaction submissions, potentially
///            eligible for gas reimbursement.
contract L1BTCRedeemerWormhole is
    AbstractBTCRedeemer,
    Reimbursable,
    ReentrancyGuardUpgradeable
{
    /// @notice Holds information about a deferred gas reimbursement.
    struct GasReimbursement {
        /// @notice Receiver that is supposed to receive the reimbursement.
        address receiver;
        /// @notice Gas expenditure that is meant to be reimbursed.
        uint96 gasSpent;
    }

    /// @notice Reference to the Wormhole Token Bridge contract.
    IWormholeTokenBridge public wormholeTokenBridge;
    /// @notice Holds deferred gas reimbursements for redemption requests
    ///         (indexed by redemption key). Reimbursement for redemption
    ///         is typically paid out after the request is successfully relayed and processed.
    ///         The specifics depend on the reimbursement strategy.
    mapping(uint256 => GasReimbursement) public gasReimbursements;
    /// @notice Gas that is meant to balance the overall cost of processing a redemption request via L1.
    ///         Can be updated by the owner based on the current market conditions.
    uint256 public requestRedemptionGasOffset;
    /// @notice Set of addresses that are authorized to receive gas reimbursements
    ///         for relaying redemption requests. The authorization is
    ///         granted by the contract owner.
    mapping(address => bool) public reimbursementAuthorizations;

    event RedemptionRequested(
        uint256 indexed redemptionKey,
        bytes20 indexed walletPubKeyHash,
        BitcoinTx.UTXO mainUtxo,
        bytes indexed redemptionOutputScript,
        uint256 amount
    );

    event GasOffsetParametersUpdated(uint256 requestRedemptionGasOffset);

    event ReimbursementAuthorizationUpdated(
        address indexed _address,
        bool authorization
    );

    /// @dev This modifier comes from the `Reimbursable` base contract and
    ///      must be overridden to protect the `updateReimbursementPool` call.
    modifier onlyReimbursableAdmin() override {
        require(msg.sender == owner(), "Caller is not the owner");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _thresholdBridge,
        address _wormholeTokenBridge,
        address _tbtcToken,
        address _bank,
        address _tbtcVault
    ) external initializer {
        __AbstractBTCRedeemer_initialize(
            _thresholdBridge,
            _tbtcToken,
            _bank,
            _tbtcVault
        );
        __Ownable_init();

        require(
            address(wormholeTokenBridge) == address(0),
            "L1BTCRedeemerWormhole already initialized"
        );

        require(
            _wormholeTokenBridge != address(0),
            "Wormhole Token Bridge address cannot be zero"
        );

        wormholeTokenBridge = IWormholeTokenBridge(_wormholeTokenBridge);
        requestRedemptionGasOffset = 60_000;
    }

    /// @notice Updates the values of gas offset parameters for redemption processing.
    /// @dev Can be called only by the contract owner. The caller is responsible
    ///      for validating parameters.
    /// @param _requestRedemptionGasOffset New initialize redemption gas offset.
    function updateGasOffsetParameters(uint256 _requestRedemptionGasOffset)
        external
        onlyOwner
    {
        requestRedemptionGasOffset = _requestRedemptionGasOffset;

        emit GasOffsetParametersUpdated(_requestRedemptionGasOffset);
    }

    /// @notice Updates the reimbursement authorization for the given address.
    /// @param _address Address to update the authorization for.
    /// @param authorization New authorization status.
    /// @dev Requirements:
    ///      - Can be called only by the contract owner.
    function updateReimbursementAuthorization(
        address _address,
        bool authorization
    ) external onlyOwner {
        emit ReimbursementAuthorizationUpdated(_address, authorization);
        reimbursementAuthorizations[_address] = authorization;
    }

    /// @notice Initiates a redemption on L1 using tBTC received from another chain (e.g., L2)
    ///         via a Wormhole VAA. The tBTC is then used to request a Bitcoin redemption
    ///         from the main tBTC Bridge.
    /// @param walletPubKeyHash The 20-byte wallet public key hash of the tBTC wallet
    ///        that will process this redemption on the Bitcoin network.
    ///        This needs to be chosen carefully, usually an active wallet provided by the system.
    /// @param mainUtxo The main UTXO of the `walletPubKeyHash`. This information is critical
    ///        for the Bridge to identify the correct wallet and its state.
    /// @param encodedVm A byte array containing a Wormhole VAA. This VAA should represent
    ///        a transfer of tBTC from an L2 (or other chain) to this L1 contract address,
    ///        with the payload containing the user's destination Bitcoin output script.
    /// @dev Requirements:
    ///      - The Wormhole VAA must be valid and correctly transfer tBTC to this contract.
    ///      - The payload of the VAA must be the user's Bitcoin `redemptionOutputScript`.
    ///      - `walletPubKeyHash` and `mainUtxo` must correspond to a live, funded tBTC wallet.
    ///      - All requirements of tBTC `Bridge.requestRedemption` must be met.
    ///      - Callers (typically relayers) might be eligible for gas reimbursement if authorized
    ///        and the reimbursement pool is funded.
    ///
    ///        The Wormhole Token Bridge contract has protection against redeeming
    ///        the same VAA again. When a Token Bridge VAA is redeemed, its
    ///        message body hash is stored in a map. This map is used to check
    ///        whether the hash has already been set in this map. For this reason,
    ///        this function does not have to be nonReentrant in theory. However,
    ///        to make this function non-dependent on Wormhole Bridge implementation,
    ///        we are making it nonReentrant anyway.
    function requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes calldata encodedVm
    ) external nonReentrant {
        uint256 gasStart = gasleft();
        // WormholeTokenBridge.completeTransferWithPayload completes a contract-controlled
        // transfer of an ERC20 token. Calling this function is not enough to
        // ensure L2WormholeGateway received Wormhole tBTC representation.
        // Instead of going too deep into the WormholeTokenBridge implementation,
        // asserting who is the receiver of the token, and which token it is,
        // we check the balance before the WormholeTokenBridge call and the balance
        // after ITokenBridge call. This way, we are sure this contract received
        // Wormhole tBTC token in the given amount. This is transparent to
        // all potential upgrades of ITokenBridge implementation and no other
        // validations are needed.
        uint256 balanceBefore = tbtcToken.balanceOf(address(this));
        bytes memory encoded = wormholeTokenBridge.completeTransferWithPayload(
            encodedVm
        );
        uint256 balanceAfter = tbtcToken.balanceOf(address(this));

        uint256 amount = balanceAfter - balanceBefore;

        bytes memory redemptionOutputScript = wormholeTokenBridge
            .parseTransferWithPayload(encoded)
            .payload;

        // Input parameters do not have to be validated in any way.
        // The tBTC Bridge is responsible for validating whether the provided
        // redemption data is correct.
        (uint256 redemptionKey, ) = _requestRedemption(
            walletPubKeyHash,
            mainUtxo,
            redemptionOutputScript,
            amount
        );

        // The function is non-reentrant.
        // slither-disable-next-line reentrancy-events
        emit RedemptionRequested(
            redemptionKey,
            walletPubKeyHash,
            mainUtxo,
            redemptionOutputScript,
            amount
        );

        // Record a deferred gas reimbursement if the reimbursement pool is
        // attached and the caller is authorized to receive reimbursements.
        // `ReimbursementPool` calls the untrusted receiver address using a
        // low-level call. Reentrancy risk is mitigated by making sure that
        // `ReimbursementPool.refund` is a non-reentrant function and executing
        // reimbursements as part of this redemption processing step.
        if (
            address(reimbursementPool) != address(0) &&
            reimbursementAuthorizations[msg.sender]
        ) {
            reimbursementPool.refund(
                (gasStart - gasleft()) + requestRedemptionGasOffset,
                msg.sender
            );
        }
    }
}
