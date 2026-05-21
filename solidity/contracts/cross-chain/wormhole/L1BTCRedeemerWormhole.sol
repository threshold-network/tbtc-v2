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
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "./Wormhole.sol";
import "../../integrator/AbstractBTCRedeemer.sol";

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
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // Custom errors
    error CallerNotOwner();
    error SourceAddressNotAuthorized();
    /// @dev The allowed sender has no Wormhole chain ID configured.
    error SourceChainNotAuthorized();
    /// @dev The VAA emitter chain does not match the chain bound to the
    ///      allowed sender. Distinct from `SourceChainNotAuthorized` so
    ///      operators can tell "sender not configured" from "sender
    ///      configured but VAA arrived from the wrong chain."
    error WormholeChainMismatch();
    error WormholeTokenBridgeAlreadySet();
    error WormholeAlreadySet();
    error InvalidArrayLength();

    struct L2RedemptionPayloadV2 {
        bytes redeemerOutputScript;
        address l2User;
        address rebateBeneficiary;
        uint64 maxRebateSat;
        bytes rebateAuthorization;
        bytes32 redemptionId;
    }

    struct TimedOutRedemptionRefund {
        address l2User;
        uint256 sourceChainId;
        uint64 amountSat;
        uint32 requestedAt;
    }

    struct TimeoutRefundRoute {
        uint16 wormholeChainId;
        address l2WormholeGateway;
    }

    struct CompletedRedemptionTransfer {
        uint256 amount;
        uint256 sourceChainId;
        bytes payload;
    }

    /// @notice Reference to the Wormhole Token Bridge contract.
    IWormholeTokenBridge public wormholeTokenBridge;
    /// @notice Gas that is meant to balance the overall cost of processing a redemption request via L1.
    ///         Can be updated by the owner based on the current market conditions.
    uint256 public requestRedemptionGasOffset;
    /// @notice Set of addresses that are authorized to receive gas reimbursements
    ///         for relaying redemption requests. The authorization is
    ///         granted by the contract owner.
    mapping(address => bool) public reimbursementAuthorizations;
    /// @notice Maps sender addresses to their authorization status. Only messages
    ///         from authorized senders will be accepted. The addresses are stored
    ///         in Wormhole format (bytes32).
    mapping(bytes32 => bool) public allowedSenders;
    /// @notice EVM source chain ID for each allowed Wormhole sender.
    mapping(bytes32 => uint256) public allowedSenderSourceChainIds;
    /// @notice Pending timeout refund context keyed by Bridge redemption key.
    mapping(uint256 => TimedOutRedemptionRefund)
        public timedOutRedemptionRefunds;
    /// @notice L1-to-L2 routes used to return tBTC after redemption timeouts.
    mapping(uint256 => TimeoutRefundRoute) public timeoutRefundRoutes;
    /// @notice Reference to the Wormhole Core contract. Used to parse the VAA
    ///         header and authenticate the `emitterChainId` of the sender.
    ///         Optional: when address(0) the emitter chain check is skipped to
    ///         preserve backward compatibility for deployments that have not
    ///         yet been configured with a core reference.
    IWormhole public wormhole;
    /// @notice Wormhole chain ID expected for each allowed Wormhole sender.
    ///         Authenticates the origin chain of a VAA independently of
    ///         `transfer.fromAddress`, preventing same-address-spoof attacks
    ///         from foreign chains with a registered Token Bridge.
    mapping(bytes32 => uint16) public allowedSenderWormholeChainIds;

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

    event AllowedSenderUpdated(bytes32 indexed sender, bool allowed);

    event AllowedSenderSourceChainUpdated(
        bytes32 indexed sender,
        bool allowed,
        uint256 sourceChainId
    );

    event TimeoutRefundRouteUpdated(
        uint256 indexed sourceChainId,
        uint16 wormholeChainId,
        address l2WormholeGateway
    );

    event WormholeCoreSet(address indexed wormhole);

    event AllowedSenderWormholeChainUpdated(
        bytes32 indexed sender,
        uint16 wormholeChainId
    );

    event RedemptionRequestedWithRebate(
        uint256 indexed redemptionKey,
        bytes32 indexed redemptionId,
        address indexed rebateBeneficiary,
        address l2User,
        uint64 maxRebateSat
    );

    event TimedOutRedemptionRefundSentToL2(
        uint256 indexed redemptionKey,
        address indexed l2User,
        uint256 amount
    );

    /// @dev This modifier comes from the `Reimbursable` base contract and
    ///      must be overridden to protect the `updateReimbursementPool` call.
    modifier onlyReimbursableAdmin() override {
        if (msg.sender != owner()) revert CallerNotOwner();
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

        if (address(wormholeTokenBridge) != address(0)) {
            revert WormholeTokenBridgeAlreadySet();
        }

        if (_wormholeTokenBridge == address(0)) {
            revert ZeroAddress();
        }

        wormholeTokenBridge = IWormholeTokenBridge(_wormholeTokenBridge);
        requestRedemptionGasOffset = 60_000;
    }

    /// @notice Updates the values of gas offset parameters for redemption processing.
    /// @dev Can be called only by the contract owner. The caller is responsible
    ///      for validating parameters.
    /// @param _requestRedemptionGasOffset New redemption gas offset.
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

    /// @notice Updates the allowed sender status for a given Wormhole sender address.
    /// @param _sender The Wormhole sender address (in bytes32 format).
    /// @param _allowed New allowed status.
    /// @dev Requirements:
    ///      - Can be called only by the contract owner.
    ///
    ///      Clears any bound Wormhole chain ID on revocation so the mapping
    ///      cannot drift out of sync with `allowedSenders`.
    function updateAllowedSender(bytes32 _sender, bool _allowed)
        external
        onlyOwner
    {
        allowedSenders[_sender] = _allowed;
        emit AllowedSenderUpdated(_sender, _allowed);
        if (!_allowed && allowedSenderSourceChainIds[_sender] != 0) {
            delete allowedSenderSourceChainIds[_sender];
            emit AllowedSenderSourceChainUpdated(_sender, false, 0);
        }
        if (!_allowed && allowedSenderWormholeChainIds[_sender] != 0) {
            delete allowedSenderWormholeChainIds[_sender];
            emit AllowedSenderWormholeChainUpdated(_sender, 0);
        }
    }

    /// @notice Updates an allowed sender and binds it to an EVM source chain ID.
    /// @dev Clears any bound Wormhole chain ID on revocation so the mapping
    ///      cannot drift out of sync with `allowedSenders`.
    function updateAllowedSenderWithSourceChain(
        bytes32 _sender,
        bool _allowed,
        uint256 _sourceChainId
    ) external onlyOwner {
        require(!_allowed || _sourceChainId != 0, "Source chain ID is zero");
        allowedSenders[_sender] = _allowed;
        allowedSenderSourceChainIds[_sender] = _allowed ? _sourceChainId : 0;
        emit AllowedSenderUpdated(_sender, _allowed);
        emit AllowedSenderSourceChainUpdated(
            _sender,
            _allowed,
            allowedSenderSourceChainIds[_sender]
        );
        if (!_allowed && allowedSenderWormholeChainIds[_sender] != 0) {
            delete allowedSenderWormholeChainIds[_sender];
            emit AllowedSenderWormholeChainUpdated(_sender, 0);
        }
    }

    /// @notice Sets the Wormhole Core contract reference used for VAA
    ///         emitter-chain authentication and atomically binds every
    ///         currently-allowed sender to the Wormhole chain ID its VAAs
    ///         must originate from.
    /// @dev Can only be called once.
    ///
    ///      Supplying the bindings in the same call prevents the window
    ///      where the core reference is active but one or more existing
    ///      `allowedSenders` entries have no matching Wormhole chain ID --
    ///      in that window every `requestRedemption` reverts with
    ///      `SourceChainNotAuthorized`. Admins must pass every currently
    ///      allowed sender; the contract does not enumerate the allowlist.
    ///
    ///      `_senders` and `_wormholeChainIds` may be empty (pristine
    ///      deployment with no senders yet).
    /// @param _wormhole Wormhole Core contract address.
    /// @param _senders Wormhole sender addresses (bytes32) to bind.
    /// @param _wormholeChainIds Wormhole chain IDs (uint16) to bind,
    ///        matched pairwise with `_senders`.
    function setWormhole(
        address _wormhole,
        bytes32[] calldata _senders,
        uint16[] calldata _wormholeChainIds
    ) external onlyOwner {
        if (_wormhole == address(0)) revert ZeroAddress();
        if (address(wormhole) != address(0)) revert WormholeAlreadySet();
        if (_senders.length != _wormholeChainIds.length) {
            revert InvalidArrayLength();
        }

        wormhole = IWormhole(_wormhole);
        emit WormholeCoreSet(_wormhole);

        for (uint256 i = 0; i < _senders.length; i++) {
            allowedSenderWormholeChainIds[_senders[i]] = _wormholeChainIds[i];
            emit AllowedSenderWormholeChainUpdated(
                _senders[i],
                _wormholeChainIds[i]
            );
        }
    }

    /// @notice Binds an allowed Wormhole sender to the Wormhole chain ID that
    ///         its VAAs must originate from. Used to amend the mapping after
    ///         `setWormhole`; prefer the atomic `setWormhole` constructor for
    ///         the initial bindings.
    /// @dev Passing `_wormholeChainId == 0` clears the binding.
    function updateAllowedSenderWormholeChain(
        bytes32 _sender,
        uint16 _wormholeChainId
    ) external onlyOwner {
        allowedSenderWormholeChainIds[_sender] = _wormholeChainId;
        emit AllowedSenderWormholeChainUpdated(_sender, _wormholeChainId);
    }

    /// @notice Updates the L2 route used for timeout refunds.
    function updateTimeoutRefundRoute(
        uint256 _sourceChainId,
        uint16 _wormholeChainId,
        address _l2WormholeGateway
    ) external onlyOwner {
        require(_sourceChainId != 0, "Source chain ID is zero");
        if (_l2WormholeGateway == address(0)) {
            revert ZeroAddress();
        }

        timeoutRefundRoutes[_sourceChainId] = TimeoutRefundRoute(
            _wormholeChainId,
            _l2WormholeGateway
        );

        emit TimeoutRefundRouteUpdated(
            _sourceChainId,
            _wormholeChainId,
            _l2WormholeGateway
        );
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
    ///      - The VAA must originate from an allowed sender address.
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

        // Parse the full transfer data to validate the source
        IWormholeTokenBridge.TransferWithPayload
            memory transfer = wormholeTokenBridge.parseTransferWithPayload(
                encoded
            );

        // Validate that the message came from an authorized sender on the
        // expected source chain. `fromAddress` alone is insufficient because
        // the same contract address can exist on any chain that has a
        // registered Wormhole Token Bridge; without an `emitterChainId` check
        // such foreign contracts could impersonate the authorized sender.
        bytes32 sender = transfer.fromAddress;
        if (!allowedSenders[sender]) revert SourceAddressNotAuthorized();
        _requireExpectedEmitterChain(encodedVm, sender);

        bytes memory redemptionOutputScript = transfer.payload;
        uint256 redemptionKey = _getRedemptionKey(
            walletPubKeyHash,
            redemptionOutputScript
        );
        _requireNoPendingTimedOutRedemptionRefund(redemptionKey);

        // Input parameters do not have to be validated in any way.
        // The tBTC Bridge is responsible for validating whether the provided
        // redemption data is correct.
        (redemptionKey, ) = _requestRedemption(
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

    /// @notice Initiates a rebate-aware redemption on L1 using a V2 L2 payload.
    function requestRedemptionWithRebate(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes calldata encodedVm
    ) external nonReentrant {
        uint256 gasStart = gasleft();

        CompletedRedemptionTransfer
            memory completedTransfer = _completeTransfer(encodedVm);

        _requestRedemptionWithRebatePayload(
            walletPubKeyHash,
            mainUtxo,
            completedTransfer
        );

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

    /// @dev Parses the Wormhole VAA header and verifies its `emitterChainId`
    ///      matches the chain configured for `sender`. No-op when the Wormhole
    ///      Core reference has not been set, preserving behaviour for
    ///      deployments that have not yet migrated. Once the core is set,
    ///      senders without a configured wormhole chain ID are rejected so
    ///      admins cannot silently skip the check by forgetting to configure.
    ///
    ///      Wormhole chain ID 0 is unallocated by convention in the Wormhole
    ///      chain registry, so treating 0 as the "not configured" sentinel
    ///      is safe today; if Wormhole ever allocates chain 0, the code
    ///      would have to carry a separate configured-flag.
    function _requireExpectedEmitterChain(
        bytes calldata encodedVm,
        bytes32 sender
    ) internal view {
        IWormhole _wormhole = wormhole;
        if (address(_wormhole) == address(0)) {
            return;
        }

        uint16 expected = allowedSenderWormholeChainIds[sender];
        if (expected == 0) revert SourceChainNotAuthorized();

        IWormhole.VM memory vm = _wormhole.parseVM(encodedVm);
        if (vm.emitterChainId != expected) revert WormholeChainMismatch();
    }

    function _completeTransfer(bytes calldata encodedVm)
        internal
        returns (CompletedRedemptionTransfer memory completedTransfer)
    {
        uint256 balanceBefore = tbtcToken.balanceOf(address(this));
        bytes memory encoded = wormholeTokenBridge.completeTransferWithPayload(
            encodedVm
        );
        uint256 balanceAfter = tbtcToken.balanceOf(address(this));

        IWormholeTokenBridge.TransferWithPayload
            memory transfer = wormholeTokenBridge.parseTransferWithPayload(
                encoded
            );

        bytes32 sender = transfer.fromAddress;
        if (!allowedSenders[sender]) revert SourceAddressNotAuthorized();
        _requireExpectedEmitterChain(encodedVm, sender);

        uint256 sourceChainId = allowedSenderSourceChainIds[sender];
        require(sourceChainId != 0, "Source chain ID is not set");

        completedTransfer = CompletedRedemptionTransfer({
            amount: balanceAfter - balanceBefore,
            sourceChainId: sourceChainId,
            payload: transfer.payload
        });
    }

    function _requestRedemptionWithRebatePayload(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo,
        CompletedRedemptionTransfer memory completedTransfer
    ) internal {
        L2RedemptionPayloadV2 memory payload = abi.decode(
            completedTransfer.payload,
            (L2RedemptionPayloadV2)
        );

        require(
            payload.rebateAuthorization.length != 0,
            "Signed auth required"
        );

        IBridgeTypes.BeneficiaryRebateContext
            memory rebateContext = IBridgeTypes.BeneficiaryRebateContext({
                sourceChainId: completedTransfer.sourceChainId,
                l2User: payload.l2User,
                flowType: IBridgeTypes.RebateFlowType.Redemption,
                actionId: payload.redemptionId,
                maxRebateSat: payload.maxRebateSat,
                authorization: payload.rebateAuthorization
            });

        uint256 redemptionKey = _getRedemptionKey(
            walletPubKeyHash,
            payload.redeemerOutputScript
        );
        _requireNoPendingTimedOutRedemptionRefund(redemptionKey);

        (redemptionKey, ) = _requestRedemptionWithRebate(
            walletPubKeyHash,
            mainUtxo,
            payload.redeemerOutputScript,
            completedTransfer.amount,
            payload.rebateBeneficiary,
            rebateContext
        );

        IBridgeTypes.RedemptionRequest memory redemption = thresholdBridge
            .pendingRedemptions(redemptionKey);

        uint256 amountSat = completedTransfer.amount / SATOSHI_MULTIPLIER;
        require(amountSat <= type(uint64).max, "Amount too large");
        timedOutRedemptionRefunds[redemptionKey] = TimedOutRedemptionRefund({
            l2User: payload.l2User,
            sourceChainId: completedTransfer.sourceChainId,
            amountSat: uint64(amountSat),
            requestedAt: redemption.requestedAt
        });

        emit RedemptionRequested(
            redemptionKey,
            walletPubKeyHash,
            mainUtxo,
            payload.redeemerOutputScript,
            completedTransfer.amount
        );

        emit RedemptionRequestedWithRebate(
            redemptionKey,
            payload.redemptionId,
            payload.rebateBeneficiary,
            payload.l2User,
            payload.maxRebateSat
        );
    }

    function _requireNoPendingTimedOutRedemptionRefund(uint256 redemptionKey)
        internal
        view
    {
        TimedOutRedemptionRefund memory refund = timedOutRedemptionRefunds[
            redemptionKey
        ];
        if (refund.amountSat == 0) {
            return;
        }

        IBridgeTypes.RedemptionRequest
            memory timedOutRedemption = thresholdBridge.timedOutRedemptions(
                redemptionKey
            );
        require(
            timedOutRedemption.redeemer != address(this) ||
                timedOutRedemption.requestedAt != refund.requestedAt,
            "Timeout refund pending"
        );
    }

    /// @notice Sends a Bridge timeout refund held by this contract back to the
    ///         original L2 user through the configured Wormhole route.
    function refundTimedOutRedemptionToL2(uint256 redemptionKey)
        external
        payable
        nonReentrant
        returns (uint64 transferSequence)
    {
        TimedOutRedemptionRefund memory refund = timedOutRedemptionRefunds[
            redemptionKey
        ];
        require(refund.amountSat != 0, "Timeout refund not found");

        IBridgeTypes.RedemptionRequest
            memory timedOutRedemption = thresholdBridge.timedOutRedemptions(
                redemptionKey
            );
        require(
            timedOutRedemption.redeemer == address(this),
            "Redemption not timed out"
        );
        require(
            timedOutRedemption.requestedAmount == refund.amountSat,
            "Wrong timeout refund amount"
        );
        require(
            timedOutRedemption.requestedAt == refund.requestedAt,
            "Wrong timeout refund request"
        );

        TimeoutRefundRoute memory route = timeoutRefundRoutes[
            refund.sourceChainId
        ];
        require(route.l2WormholeGateway != address(0), "Refund route not set");
        require(
            bank.balanceAvailable(address(this)) >= refund.amountSat,
            "Refund balance not available"
        );

        delete timedOutRedemptionRefunds[redemptionKey];

        uint256 amount = uint256(refund.amountSat) * SATOSHI_MULTIPLIER;

        emit TimedOutRedemptionRefundSentToL2(
            redemptionKey,
            refund.l2User,
            WormholeUtils.normalize(amount)
        );

        bank.increaseBalanceAllowance(address(tbtcVault), refund.amountSat);
        tbtcVault.mint(amount);

        amount = WormholeUtils.normalize(amount);
        tbtcToken.safeIncreaseAllowance(address(wormholeTokenBridge), amount);

        transferSequence = wormholeTokenBridge.transferTokensWithPayload{
            value: msg.value
        }(
            address(tbtcToken),
            amount,
            route.wormholeChainId,
            WormholeUtils.toWormholeAddress(route.l2WormholeGateway),
            0,
            abi.encode(WormholeUtils.toWormholeAddress(refund.l2User))
        );
    }
}
