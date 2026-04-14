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
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "@keep-network/random-beacon/contracts/Reimbursable.sol";

import "../../integrator/AbstractBTCDepositor.sol";
import "../../integrator/IBridge.sol";
import "../../integrator/ITBTCVault.sol";

import "./Wormhole.sol";
import "../utils/Crosschain.sol";

/// @title L1BTCDepositorWormholeV2Arbitrum
/// @notice Arbitrum-specific variant of the L1 tBTC depositor that bridges
///         minted tBTC to an L2 chain via Wormhole `transferTokensWithPayload`.
///         An off-chain relayer monitors the `TokensTransferredWithPayload`
///         event to fetch the signed VAA and complete delivery on the
///         destination L2. This variant lists `Initializable` explicitly in
///         the inheritance, matching the Arbitrum proxy's C3 linearization
///         where `Initializable` storage is packed into slot 0 with `bridge`.
///         See `L1BTCDepositorWormholeV2Base` for the Base variant.
contract L1BTCDepositorWormholeV2Arbitrum is
    Initializable,
    AbstractBTCDepositor,
    OwnableUpgradeable,
    Reimbursable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // -------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------

    /// @notice Reflects the deposit state:
    ///         - Unknown deposit has not been initialized yet.
    ///         - Initialized deposit has been initialized with a call to
    ///           `initializeDeposit` function and is known to this contract.
    ///         - Finalized deposit led to tBTC ERC20 minting and was finalized
    ///           with a call to `finalizeDeposit` function that transferred
    ///           tBTC ERC20 to the destination chain deposit owner.
    enum DepositState {
        Unknown,
        Initialized,
        Finalized
    }

    /// @notice Holds information about a deferred gas reimbursement.
    struct GasReimbursement {
        /// @notice Receiver that is supposed to receive the reimbursement.
        address receiver;
        /// @notice Gas expenditure that is meant to be reimbursed.
        uint96 gasSpent;
    }

    // -------------------------------------------------------------------
    // Storage variables -- MUST match the deployed proxy's storage layout.
    // Do NOT reorder, insert, or remove any variable.
    // -------------------------------------------------------------------

    /// @notice Holds the deposit state, keyed by the deposit key calculated for
    ///         the individual deposit during the call to `initializeDeposit`
    ///         function.
    mapping(uint256 => DepositState) public deposits;

    /// @notice ERC20 L1 tBTC token contract.
    IERC20Upgradeable public tbtcToken;

    /// @notice `Wormhole` core contract on L1.
    IWormhole public wormhole;

    /// @notice `WormholeRelayer` contract on L1. Preserved for storage layout
    ///         compatibility; not used by this implementation.
    IWormholeRelayer public wormholeRelayer;

    /// @notice Wormhole `TokenBridge` contract on L1.
    IWormholeTokenBridge public wormholeTokenBridge;

    /// @notice tBTC `L2WormholeGateway` contract on the corresponding L2 chain.
    address public l2WormholeGateway;

    /// @notice Wormhole chain ID of the corresponding L2 chain.
    uint16 public l2ChainId;

    /// @notice tBTC depositor contract on the corresponding L2 chain.
    address public l2BitcoinDepositor;

    /// @notice Gas limit field preserved for storage layout compatibility;
    ///         not used by this implementation.
    uint256 public l2FinalizeDepositGasLimit;

    /// @notice Holds deferred gas reimbursements for deposit initialization
    ///         (indexed by deposit key). Reimbursement for deposit
    ///         initialization is paid out upon deposit finalization.
    mapping(uint256 => GasReimbursement) public gasReimbursements;

    /// @notice Gas that is meant to balance the overall cost of deposit
    ///         initialization. Can be updated by the owner based on the
    ///         current market conditions.
    uint256 public initializeDepositGasOffset;

    /// @notice Gas that is meant to balance the overall cost of deposit
    ///         finalization. Can be updated by the owner based on the
    ///         current market conditions.
    uint256 public finalizeDepositGasOffset;

    /// @notice Set of addresses that are authorized to receive gas
    ///         reimbursements for deposit initialization and finalization.
    mapping(address => bool) public reimbursementAuthorizations;

    /// @notice Feature flag controlling whether the deposit transaction max fee
    ///         is reimbursed (added to the user's tBTC) or deducted.
    ///         - `true`  => Add `txMaxFee` to the minted tBTC amount
    ///         - `false` => Subtract `txMaxFee` from the minted tBTC amount
    bool public reimburseTxMaxFee;

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------

    event DepositInitialized(
        uint256 indexed depositKey,
        bytes32 indexed destinationChainDepositOwner,
        address indexed l1Sender
    );

    event DepositFinalized(
        uint256 indexed depositKey,
        bytes32 indexed destinationChainDepositOwner,
        address indexed l1Sender,
        uint256 initialAmount,
        uint256 tbtcAmount
    );

    event GasOffsetParametersUpdated(
        uint256 initializeDepositGasOffset,
        uint256 finalizeDepositGasOffset
    );

    event ReimbursementAuthorizationUpdated(
        address indexed _address,
        bool authorization
    );

    event ReimburseTxMaxFeeUpdated(bool reimburseTxMaxFee);

    /// @notice Emitted when the gas limit field is updated by the owner.
    ///         Preserved for backward compatibility.
    event L2FinalizeDepositGasLimitUpdated(uint256 l2FinalizeDepositGasLimit);

    /// @notice Emitted when tBTC tokens are transferred via Wormhole
    ///         `transferTokensWithPayload`. Off-chain relayers monitor this
    ///         event to discover the transfer VAA and complete the bridging
    ///         on the destination L2 chain.
    event TokensTransferredWithPayload(
        uint256 amount,
        address l2Receiver,
        uint64 transferSequence
    );

    // -------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------

    /// @dev Restricts `updateReimbursementPool` in Reimbursable to the owner.
    modifier onlyReimbursableAdmin() override {
        require(msg.sender == owner(), "Caller is not the owner");
        _;
    }

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // -------------------------------------------------------------------
    // Initializer
    // -------------------------------------------------------------------

    /// @dev Intended for fresh proxy deployments (e.g. tests). Existing
    ///      proxies are already initialized; the `initializer` modifier
    ///      prevents re-initialization.
    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _wormhole,
        address _wormholeRelayer,
        address _wormholeTokenBridge,
        address _l2WormholeGateway,
        uint16 _l2ChainId
    ) external initializer {
        __AbstractBTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();

        tbtcToken = IERC20Upgradeable(ITBTCVault(_tbtcVault).tbtcToken());

        initializeDepositGasOffset = 60_000;
        finalizeDepositGasOffset = 20_000;
        reimburseTxMaxFee = false;

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

    // -------------------------------------------------------------------
    // Admin functions
    // -------------------------------------------------------------------

    /// @notice Updates the values of gas offset parameters.
    /// @dev Can be called only by the contract owner. The caller is responsible
    ///      for validating parameters.
    /// @param _initializeDepositGasOffset New initialize deposit gas offset.
    /// @param _finalizeDepositGasOffset New finalize deposit gas offset.
    function updateGasOffsetParameters(
        uint256 _initializeDepositGasOffset,
        uint256 _finalizeDepositGasOffset
    ) external onlyOwner {
        initializeDepositGasOffset = _initializeDepositGasOffset;
        finalizeDepositGasOffset = _finalizeDepositGasOffset;

        emit GasOffsetParametersUpdated(
            _initializeDepositGasOffset,
            _finalizeDepositGasOffset
        );
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

    /// @notice Toggles whether the deposit transaction max fee is reimbursed
    ///         or deducted. Only callable by the contract owner.
    /// @param _reimburseTxMaxFee `true` => reimburse (add) the deposit tx max fee,
    ///                        `false` => deduct the deposit tx max fee.
    function setReimburseTxMaxFee(bool _reimburseTxMaxFee) external onlyOwner {
        reimburseTxMaxFee = _reimburseTxMaxFee;
        emit ReimburseTxMaxFeeUpdated(_reimburseTxMaxFee);
    }

    /// @notice Sets the address of the tBTC depositor contract on the
    ///         corresponding L2 chain. This function solves the chicken-and-egg
    ///         problem of setting the depositor contract address on both chains.
    /// @param _l2BitcoinDepositor Address of the L2 depositor contract.
    /// @dev Requirements:
    ///      - Can be called only by the contract owner,
    ///      - The address must not be set yet,
    ///      - The new address must not be 0x0.
    function attachL2BitcoinDepositor(address _l2BitcoinDepositor)
        external
        onlyOwner
    {
        require(
            l2BitcoinDepositor == address(0),
            "L2 Bitcoin Depositor already set"
        );
        require(
            _l2BitcoinDepositor != address(0),
            "L2 Bitcoin Depositor must not be 0x0"
        );
        l2BitcoinDepositor = _l2BitcoinDepositor;
    }

    /// @notice Updates the gas limit field. Preserved for backward
    ///         compatibility; not used by this implementation.
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

    // -------------------------------------------------------------------
    // Deposit lifecycle
    // -------------------------------------------------------------------

    /// @notice Initializes the deposit process on L1 by revealing the deposit
    ///         data (funding transaction and components of the P2(W)SH deposit
    ///         address) to the tBTC Bridge.
    /// @param fundingTx Bitcoin funding transaction data.
    /// @param reveal Deposit reveal data.
    /// @param destinationChainDepositOwner Address of the destination chain
    ///        deposit owner in Bytes32 format.
    /// @dev Requirements:
    ///      - The destination chain deposit owner address must not be 0x0,
    ///      - The function can be called only one time for the given Bitcoin
    ///        funding transaction,
    ///      - All the requirements of tBTC Bridge.revealDepositWithExtraData
    ///        must be met.
    function initializeDeposit(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 destinationChainDepositOwner
    ) external {
        uint256 gasStart = gasleft();

        require(
            destinationChainDepositOwner != bytes32(0),
            "L2 deposit owner must not be 0x0"
        );

        (uint256 depositKey, ) = _initializeDeposit(
            fundingTx,
            reveal,
            destinationChainDepositOwner
        );

        require(
            deposits[depositKey] == DepositState.Unknown,
            "Wrong deposit state"
        );

        // slither-disable-next-line reentrancy-benign
        deposits[depositKey] = DepositState.Initialized;

        // slither-disable-next-line reentrancy-events
        emit DepositInitialized(
            depositKey,
            destinationChainDepositOwner,
            msg.sender
        );

        // Record a deferred gas reimbursement if the reimbursement pool is
        // attached and the caller is authorized to receive reimbursements.
        if (
            address(reimbursementPool) != address(0) &&
            reimbursementAuthorizations[msg.sender]
        ) {
            uint256 gasSpent = (gasStart - gasleft()) +
                initializeDepositGasOffset;

            // Should not happen as long as initializeDepositGasOffset is
            // set to a reasonable value. If it happens, it's better to
            // omit the reimbursement than to revert the transaction.
            if (gasSpent > type(uint96).max) {
                return;
            }

            // slither-disable-next-line reentrancy-benign
            gasReimbursements[depositKey] = GasReimbursement({
                receiver: msg.sender,
                gasSpent: uint96(gasSpent)
            });
        }
    }

    /// @notice Finalizes the deposit process by transferring ERC20 L1 tBTC
    ///         to the destination chain deposit owner.
    /// @param depositKey The deposit key, as emitted in the `DepositInitialized`
    ///        event emitted by the `initializeDeposit` function for the deposit.
    /// @dev Requirements:
    ///      - `initializeDeposit` was called for the given deposit before,
    ///      - ERC20 L1 tBTC was minted by tBTC Bridge to this contract,
    ///      - The function was not called for the given deposit before,
    ///      - The call must carry a payment equal to `quoteFinalizeDeposit`.
    function finalizeDeposit(uint256 depositKey) external payable {
        uint256 gasStart = gasleft();

        require(
            deposits[depositKey] == DepositState.Initialized,
            "Wrong deposit state"
        );

        deposits[depositKey] = DepositState.Finalized;

        (
            uint256 initialDepositAmount,
            uint256 tbtcAmount,
            bytes32 destinationChainDepositOwner
        ) = _finalizeDeposit(depositKey);

        // Reimburse or deduct the deposit transaction max fee.
        if (reimburseTxMaxFee) {
            (, , uint64 depositTxMaxFee, ) = bridge.depositParameters();
            uint256 txMaxFee = depositTxMaxFee * SATOSHI_MULTIPLIER;
            tbtcAmount += txMaxFee;
        }

        // slither-disable-next-line reentrancy-events
        emit DepositFinalized(
            depositKey,
            destinationChainDepositOwner,
            msg.sender,
            initialDepositAmount,
            tbtcAmount
        );

        _transferTbtc(tbtcAmount, destinationChainDepositOwner);

        // `ReimbursementPool` calls the untrusted receiver address using a
        // low-level call. Reentrancy risk is mitigated by making sure that
        // `ReimbursementPool.refund` is a non-reentrant function and executing
        // reimbursements as the last step of the deposit finalization.
        if (address(reimbursementPool) != address(0)) {
            GasReimbursement memory reimbursement = gasReimbursements[
                depositKey
            ];
            if (reimbursement.receiver != address(0)) {
                // slither-disable-next-line reentrancy-benign
                delete gasReimbursements[depositKey];

                reimbursementPool.refund(
                    reimbursement.gasSpent,
                    reimbursement.receiver
                );
            }

            if (reimbursementAuthorizations[msg.sender]) {
                uint256 msgValueOffset = _refundToGasSpent(msg.value);
                reimbursementPool.refund(
                    (gasStart - gasleft()) +
                        msgValueOffset +
                        finalizeDepositGasOffset,
                    msg.sender
                );
            }
        }
    }

    // -------------------------------------------------------------------
    // View functions
    // -------------------------------------------------------------------

    /// @notice Quotes the payment that must be attached to the `finalizeDeposit`
    ///         function call. Only the Wormhole core message fee is required.
    /// @return cost The cost of the `finalizeDeposit` function call in WEI.
    function quoteFinalizeDeposit() external view returns (uint256 cost) {
        cost = wormhole.messageFee();
    }

    // -------------------------------------------------------------------
    // Internal functions
    // -------------------------------------------------------------------

    /// @notice The `ReimbursementPool` contract issues refunds based on
    ///         gas spent. If there is a need to get a specific refund based
    ///         on WEI value, such a value must be first converted to gas spent.
    /// @param refund Refund value in WEI.
    /// @return Refund value as gas spent.
    function _refundToGasSpent(uint256 refund)
        internal
        virtual
        returns (uint256)
    {
        uint256 maxGasPrice = reimbursementPool.maxGasPrice();
        uint256 staticGas = reimbursementPool.staticGas();

        uint256 gasPrice = tx.gasprice < maxGasPrice
            ? tx.gasprice
            : maxGasPrice;

        if (gasPrice == 0) {
            return 0;
        }

        uint256 gasSpent = (refund / gasPrice);

        if (staticGas > gasSpent) {
            return 0;
        }

        return gasSpent - staticGas;
    }

    /// @notice Transfers ERC20 L1 tBTC to the L2 deposit owner using the
    ///         Wormhole protocol. The function initiates a Wormhole token
    ///         transfer that locks the ERC20 L1 tBTC within the Wormhole
    ///         Token Bridge contract and assigns Wormhole-wrapped L2 tBTC to
    ///         the corresponding `L2WormholeGateway` contract.
    /// @param amount Amount of tBTC L1 ERC20 to transfer (1e18 precision).
    /// @param l2Receiver Address of the L2 deposit owner.
    function _transferTbtc(uint256 amount, bytes32 l2Receiver) internal {
        // Wormhole supports the 1e8 precision at most. tBTC is 1e18 so
        // the amount needs to be normalized.
        amount = WormholeUtils.normalize(amount);

        require(amount > 0, "Amount too low to bridge");

        uint256 wormholeMessageFee = wormhole.messageFee();
        require(
            msg.value == wormholeMessageFee,
            "msg.value must equal wormhole.messageFee()"
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
