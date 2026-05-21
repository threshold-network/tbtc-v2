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
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/SignatureCheckerUpgradeable.sol";

/// @title Contract for staking T token to get rebate on minting/redemption fees
contract RebateStaking is Initializable, OwnableUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    error CallerNotBridge();
    error ParametersCannotBeZero();
    error RollingWindowCannotBeZero();
    error AmountCannotBeZero();
    error UnstakingAlreadyStarted();
    error AmountTooBig();
    error NoUnstakingProcess();
    error UnstakingNotFinished();
    error ZeroAddress();
    error NotAStaker();
    error WrongDelegatee();
    error AddressAlreadyTaken();
    error UnsupportedSourceChain();
    error InvalidCrossChainRebateContext();
    error InvalidRebateAuthorization();
    error RebateAuthorizationExpired();
    error RebateAuthorizationAlreadyUsed();
    error CrossChainRebateAlreadyUsed();
    error CrossChainRebateMinExceedsMax();

    enum RebateTreasuryFeeMode {
        Both,
        DepositOnly,
        RedemptionOnly
    }

    enum TreasuryFeeType {
        Deposit,
        Redemption
    }

    enum RebateFlowType {
        Deposit,
        Redemption
    }

    struct BeneficiaryRebateContext {
        uint256 sourceChainId;
        address l2User;
        RebateFlowType flowType;
        bytes32 actionId;
        uint64 maxRebateSat;
        bytes authorization;
    }

    struct Rebate {
        uint32 timestamp;
        uint64 feeRebate;
        bytes32 actionId;
        // Reserved storage space in case we need to add more variables.
        // The convention from OpenZeppelin suggests the storage space should
        // add up to 50 slots. Here we want to have more slots as there are
        // planned upgrades of the Bridge contract. If more entires are added to
        // the struct in the upcoming versions we need to reduce the array size.
        // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
        // slither-disable-next-line unused-state
        uint256[49] __gap;
    }

    struct Stake {
        uint96 stakedAmount;
        uint96 unstakingAmount;
        uint32 unstakingTimestamp;
        uint256 rollingWindowStartIndex;
        Rebate[] rebates;
        RebateTreasuryFeeMode rebateTreasuryFeeMode;
        address delegatee;
    }

    IERC20Upgradeable public token;
    address public bridge;

    uint256 public rollingWindow;
    uint256 public unstakingPeriod;
    uint256 public rebatePerToken;

    mapping(address => Stake) public stakes;
    mapping(address => address) public delegates;
    bool public crossChainRebatesEnabled;
    mapping(uint256 => bool) public supportedSourceChains;
    mapping(uint256 => bool) public implicitSameAddressEnabled;
    mapping(uint256 => mapping(TreasuryFeeType => uint64))
        public maxCrossChainRebateSat;
    mapping(uint256 => mapping(TreasuryFeeType => uint64))
        public minCrossChainRebateSat;
    mapping(address => mapping(uint256 => uint256))
        public usedAuthorizationNonceBitmap;
    mapping(bytes32 => bool) public usedImplicitCrossChainActions;

    bytes32 public constant BENEFICIARY_REBATE_AUTHORIZATION_TYPEHASH =
        keccak256(
            "BeneficiaryRebateAuthorization(address beneficiary,uint256 sourceChainId,address l2User,uint8 flowType,bytes32 actionId,uint64 maxRebateSat,uint256 nonce,uint256 deadline)"
        );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant EIP712_NAME_HASH = keccak256("RebateStaking");
    bytes32 private constant EIP712_VERSION_HASH = keccak256("1");

    // Reserved storage space in case we need to add more variables.
    // The convention from OpenZeppelin suggests the storage space should
    // add up to 50 slots. Here we want to have more slots as there are
    // planned upgrades of the Bridge contract. If more entires are added to
    // the struct in the upcoming versions we need to reduce the array size.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[42] private __gap;

    event RollingWindowUpdated(uint256 rollingWindow);
    event UnstakingPeriodUpdated(uint256 unstakingPeriod);
    event RebatePerTokenUpdated(uint256 rebatePerToken);
    event RebateReceived(address staker, uint64 rebate);
    event RebateCanceled(address staker, uint256 requestedAt);
    event CrossChainRebateApplied(
        address indexed beneficiary,
        address indexed l2User,
        bytes32 indexed actionId,
        uint256 sourceChainId,
        TreasuryFeeType feeType,
        uint64 rebate,
        uint64 treasuryFeeBefore,
        uint64 treasuryFeeAfter
    );
    event CrossChainRebateAuthorizationUsed(
        address indexed beneficiary,
        uint256 indexed sourceChainId,
        uint256 nonce,
        bytes32 indexed actionId
    );
    event CrossChainRebateCanceled(
        address indexed beneficiary,
        bytes32 indexed actionId,
        uint64 rebate
    );
    event CrossChainRebatesEnabledUpdated(bool enabled);
    event SupportedSourceChainUpdated(
        uint256 indexed sourceChainId,
        bool supported
    );
    event ImplicitSameAddressAuthorizationUpdated(
        uint256 indexed sourceChainId,
        bool enabled
    );
    event CrossChainRebateCapUpdated(
        uint256 indexed sourceChainId,
        TreasuryFeeType indexed treasuryFeeType,
        uint64 maxRebateSat,
        uint64 minRebateSat
    );
    event RebateTreasuryFeeModeUpdated(
        address indexed staker,
        RebateTreasuryFeeMode rebateTreasuryFeeMode
    );
    event Staked(address staker, uint256 amount);
    event UnstakeStarted(address staker, uint256 amount);
    event UnstakeFinished(address staker, uint256 amount);
    event DelegateeSet(address staker, address delegatee);
    event TransferFinished(address oldStaker, address newStaker);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlyBridge() {
        if (msg.sender != address(bridge)) revert CallerNotBridge();
        _;
    }

    /// @dev Initializes upgradable contract on deployment.
    function initialize(
        address _bridge,
        address _token,
        uint256 _rollingWindow,
        uint256 _unstakingPeriod,
        uint256 _rebatePerToken
    ) external initializer {
        if (
            _bridge == address(0) || _token == address(0) || _rollingWindow == 0
        ) {
            revert ParametersCannotBeZero();
        }
        bridge = _bridge;
        token = IERC20Upgradeable(_token);
        rollingWindow = _rollingWindow;
        unstakingPeriod = _unstakingPeriod;
        rebatePerToken = _rebatePerToken;

        __Ownable_init();
    }

    /// @notice Updates the rolling window.
    /// @param _newRollingWindow Duration of the rolling window.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - The new rolling window cannot be zero
    function updateRollingWindow(uint256 _newRollingWindow) external onlyOwner {
        if (_newRollingWindow == 0) revert RollingWindowCannotBeZero();
        rollingWindow = _newRollingWindow;
        emit RollingWindowUpdated(rollingWindow);
    }

    /// @notice Updates the unstaking period.
    /// @param _newUnstakingPeriod Duration of the unstaking period.
    /// @dev Requirements:
    ///      - The caller must be the contract owner
    function updateUnstakingPeriod(uint256 _newUnstakingPeriod)
        external
        onlyOwner
    {
        unstakingPeriod = _newUnstakingPeriod;
        emit UnstakingPeriodUpdated(unstakingPeriod);
    }

    /// @notice Updates the rebate per token.
    /// @param _newRebatePerToken Rebate coefficient.
    /// @dev Requirements:
    ///      - The caller must be the contract owner
    function updateRebatePerToken(uint256 _newRebatePerToken)
        external
        onlyOwner
    {
        rebatePerToken = _newRebatePerToken;
        emit RebatePerTokenUpdated(rebatePerToken);
    }

    /// @notice Enables or pauses cross-chain rebate application.
    /// @dev When disabled, beneficiary-aware rebate calls return the original
    ///      treasury fee without reverting. Direct L1 rebates are unaffected.
    function setCrossChainRebatesEnabled(bool enabled) external onlyOwner {
        crossChainRebatesEnabled = enabled;
        emit CrossChainRebatesEnabledUpdated(enabled);
    }

    /// @notice Updates support for an EVM source chain.
    function setSupportedSourceChain(uint256 sourceChainId, bool supported)
        external
        onlyOwner
    {
        if (sourceChainId == 0) revert ParametersCannotBeZero();
        supportedSourceChains[sourceChainId] = supported;
        emit SupportedSourceChainUpdated(sourceChainId, supported);
    }

    /// @notice Updates implicit same-address authorization for a source chain.
    function setImplicitSameAddressAuthorization(
        uint256 sourceChainId,
        bool enabled
    ) external onlyOwner {
        if (sourceChainId == 0) revert ParametersCannotBeZero();
        implicitSameAddressEnabled[sourceChainId] = enabled;
        emit ImplicitSameAddressAuthorizationUpdated(sourceChainId, enabled);
    }

    /// @notice Updates per-chain cross-chain rebate caps.
    function setCrossChainRebateCap(
        uint256 sourceChainId,
        TreasuryFeeType treasuryFeeType,
        uint64 maxRebateSat,
        uint64 minRebateSat
    ) external onlyOwner {
        if (sourceChainId == 0) revert ParametersCannotBeZero();
        if (minRebateSat > maxRebateSat) {
            revert CrossChainRebateMinExceedsMax();
        }
        maxCrossChainRebateSat[sourceChainId][treasuryFeeType] = maxRebateSat;
        minCrossChainRebateSat[sourceChainId][treasuryFeeType] = minRebateSat;
        emit CrossChainRebateCapUpdated(
            sourceChainId,
            treasuryFeeType,
            maxRebateSat,
            minRebateSat
        );
    }

    /// @notice Sets the rebate treasury fee mode for caller.
    /// @param _rebateTreasuryFeeMode New rebate treasury fee mode:
    ///        - 0: rebates for both deposits and redemptions,
    ///        - 1: rebates for deposits only,
    ///        - 2: rebates for redemptions only.
    function setRebateTreasuryFeeMode(
        RebateTreasuryFeeMode _rebateTreasuryFeeMode
    ) external {
        stakes[msg.sender].rebateTreasuryFeeMode = _rebateTreasuryFeeMode;
        emit RebateTreasuryFeeModeUpdated(msg.sender, _rebateTreasuryFeeMode);
    }

    /// @notice Sets a delegatee for a rebate.
    /// @param _delegatee Delegatee address.
    function setDelegatee(address _delegatee) external {
        Stake storage stakeInfo = stakes[msg.sender];
        if (stakeInfo.stakedAmount == 0) {
            revert NotAStaker();
        }
        if (stakeInfo.delegatee != address(0)) {
            delegates[stakeInfo.delegatee] = address(0);
        }
        if (_delegatee == address(0) || _delegatee == msg.sender) {
            stakeInfo.delegatee = address(0);
            emit DelegateeSet(msg.sender, msg.sender);
            return;
        }

        if (
            delegates[_delegatee] != address(0) ||
            stakes[_delegatee].stakedAmount != 0
        ) {
            revert WrongDelegatee();
        }
        stakeInfo.delegatee = _delegatee;
        delegates[_delegatee] = msg.sender;
        emit DelegateeSet(msg.sender, _delegatee);
    }

    /// @notice Calculates cap for rebate for the specified user.
    /// @param user Address of depositor or redeemer
    function getRebateCap(address user) external view returns (uint64) {
        Stake storage stakeInfo = stakes[user];
        return getRebateCap(stakeInfo);
    }

    /// @notice Calculates cap for rebate for the specified user.
    /// @param stakeInfo Staker struct
    function getRebateCap(Stake storage stakeInfo)
        internal
        view
        returns (uint64)
    {
        if (rebatePerToken == 0) {
            return 0;
        }
        return
            SafeCastUpgradeable.toUint64(
                (stakeInfo.stakedAmount - stakeInfo.unstakingAmount) /
                    rebatePerToken
            );
    }

    /// @notice Calculates available rebate for the specified user.
    /// @param user Address of depositor or redeemer
    function getAvailableRebate(address user)
        external
        view
        returns (uint64 rebateInWindow)
    {
        Stake storage stakeInfo = stakes[user];
        uint64 rebateCap = getRebateCap(stakeInfo);
        if (rebateCap == 0) {
            return 0;
        }

        if (stakeInfo.rebates.length == 0) {
            return rebateCap;
        }

        /* solhint-disable-next-line not-rely-on-time */
        uint256 windowStart = block.timestamp - rollingWindow;
        for (
            uint256 i = stakeInfo.rollingWindowStartIndex;
            i < stakeInfo.rebates.length;
            i++
        ) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp >= windowStart) {
                rebateInWindow += rebate.feeRebate;
            }
        }

        return rebateCap - rebateInWindow;
    }

    /// @notice Calculates used rebate in the rolling window.
    /// @param stakeInfo Staker struct
    /// @return rebateInWindow Used rebate in the rolling window
    function getRebateInRollingWindow(Stake storage stakeInfo)
        internal
        returns (uint64 rebateInWindow)
    {
        if (stakeInfo.rebates.length == 0) {
            return 0;
        }

        /* solhint-disable-next-line not-rely-on-time */
        uint256 windowStart = block.timestamp - rollingWindow;
        uint256 rebatesLength = stakeInfo.rebates.length;
        for (
            uint256 i = stakeInfo.rollingWindowStartIndex;
            i < rebatesLength;
            i++
        ) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp < windowStart) {
                stakeInfo.rollingWindowStartIndex++;
            } else {
                rebateInWindow += rebate.feeRebate;
            }
        }

        return rebateInWindow;
    }

    /// @notice Checks if user is eligible for rebate
    /// @param user Address of depositor or redeemer
    /// @param treasuryFee Original fees
    /// @param treasuryFeeType Type of treasury fee:
    ///        - 0: deposit treasury fee,
    ///        - 1: redemption treasury fee.
    /// @return Updated fees considering rebate if applicable
    /// @dev Requirements:
    ///      - The caller must be the bridge contract
    function applyForRebate(
        address user,
        uint64 treasuryFee,
        TreasuryFeeType treasuryFeeType
    ) external onlyBridge returns (uint64) {
        user = getStaker(user);
        uint64 rebate = _calculateRebate(
            user,
            treasuryFee,
            treasuryFeeType,
            type(uint64).max
        );

        if (rebate == 0) {
            return treasuryFee;
        }

        _recordRebate(user, rebate, bytes32(0));
        return treasuryFee - rebate;
    }

    /// @notice Applies a rebate to a cross-chain fee on behalf of a beneficiary.
    /// @param beneficiary L1 staker or delegatee whose rebate capacity is used.
    /// @param treasuryFee Original treasury fee.
    /// @param treasuryFeeType Type of treasury fee.
    /// @param context Cross-chain origin and authorization context.
    /// @return reducedTreasuryFee Treasury fee after applying an eligible rebate.
    /// @dev Requirements:
    ///      - The caller must be the bridge contract.
    ///      - The source chain and context must be valid when a rebate can be
    ///        applied. If cross-chain rebates are paused or capacity is zero,
    ///        this function returns the original fee.
    ///      - If the calculated rebate is below the source chain's minimum
    ///        rebate, this function returns the original fee and does not
    ///        consume the authorization.
    function applyForRebateFor(
        address beneficiary,
        uint64 treasuryFee,
        TreasuryFeeType treasuryFeeType,
        BeneficiaryRebateContext calldata context
    ) external onlyBridge returns (uint64 reducedTreasuryFee) {
        if (treasuryFee == 0) {
            return treasuryFee;
        }

        if (!crossChainRebatesEnabled) {
            return treasuryFee;
        }

        _validateCrossChainContext(beneficiary, treasuryFeeType, context);

        uint64 maxRebate = maxCrossChainRebateSat[context.sourceChainId][
            treasuryFeeType
        ];
        if (maxRebate == 0 || context.maxRebateSat == 0) {
            return treasuryFee;
        }
        if (maxRebate > context.maxRebateSat) {
            maxRebate = context.maxRebateSat;
        }

        address staker = getStaker(beneficiary);
        uint64 rebate = _calculateRebate(
            staker,
            treasuryFee,
            treasuryFeeType,
            maxRebate
        );

        uint64 minRebate = minCrossChainRebateSat[context.sourceChainId][
            treasuryFeeType
        ];
        if (rebate == 0 || (minRebate > 0 && rebate < minRebate)) {
            return treasuryFee;
        }

        _validateAndConsumeAuthorization(beneficiary, context);
        _recordRebate(staker, rebate, context.actionId);
        reducedTreasuryFee = treasuryFee - rebate;

        emit CrossChainRebateApplied(
            beneficiary,
            context.l2User,
            context.actionId,
            context.sourceChainId,
            treasuryFeeType,
            rebate,
            treasuryFee,
            reducedTreasuryFee
        );
    }

    /// @notice Calculates available rebate capacity for a treasury fee.
    function _calculateRebate(
        address staker,
        uint64 treasuryFee,
        TreasuryFeeType treasuryFeeType,
        uint64 maxRebate
    ) internal returns (uint64 rebate) {
        Stake storage stakeInfo = stakes[staker];

        if (!isRebateEnabled(staker, treasuryFeeType)) {
            return 0;
        }

        uint64 rebateCap = getRebateCap(stakeInfo);
        if (rebateCap == 0) {
            return 0;
        }

        uint64 currentRebate = getRebateInRollingWindow(stakeInfo);
        if (rebateCap <= currentRebate) {
            return 0;
        }

        rebate = rebateCap - currentRebate;
        if (rebate > treasuryFee) {
            rebate = treasuryFee;
        }
        if (rebate > maxRebate) {
            rebate = maxRebate;
        }
    }

    /// @notice Records an applied rebate in the staker rolling window.
    function _recordRebate(
        address staker,
        uint64 rebate,
        bytes32 actionId
    ) internal {
        Stake storage stakeInfo = stakes[staker];
        Rebate storage value = stakeInfo.rebates.push();
        /* solhint-disable-next-line not-rely-on-time */
        value.timestamp = uint32(block.timestamp);
        value.feeRebate = rebate;
        value.actionId = actionId;
        emit RebateReceived(staker, rebate);
    }

    /// @notice Returns true if rebate is enabled for given user and fee type.
    function isRebateEnabled(address user, TreasuryFeeType treasuryFeeType)
        internal
        view
        returns (bool)
    {
        RebateTreasuryFeeMode mode = stakes[user].rebateTreasuryFeeMode;

        // slither-disable-next-line incorrect-equality
        return
            mode == RebateTreasuryFeeMode.Both ||
            (mode == RebateTreasuryFeeMode.DepositOnly &&
                treasuryFeeType == TreasuryFeeType.Deposit) ||
            (mode == RebateTreasuryFeeMode.RedemptionOnly &&
                treasuryFeeType == TreasuryFeeType.Redemption);
    }

    /// @notice Returns address of delegating staker or user itself if there is no delegating staker.
    function getStaker(address user) internal view returns (address) {
        address staker = delegates[user];
        // slither-disable-next-line incorrect-equality
        if (stakes[user].stakedAmount == 0 && staker != address(0)) {
            return staker;
        }
        return user;
    }

    /// @notice Returns the EIP-712 domain separator used by rebate authorizations.
    /* solhint-disable-next-line func-name-mixedcase */
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    EIP712_NAME_HASH,
                    EIP712_VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
    }

    function _validateCrossChainContext(
        address beneficiary,
        TreasuryFeeType treasuryFeeType,
        BeneficiaryRebateContext calldata context
    ) internal view {
        if (
            beneficiary == address(0) ||
            context.l2User == address(0) ||
            context.actionId == bytes32(0) ||
            uint8(context.flowType) != uint8(treasuryFeeType)
        ) {
            revert InvalidCrossChainRebateContext();
        }

        if (!supportedSourceChains[context.sourceChainId]) {
            revert UnsupportedSourceChain();
        }
    }

    function _validateAndConsumeAuthorization(
        address beneficiary,
        BeneficiaryRebateContext calldata context
    ) internal {
        if (context.authorization.length == 0) {
            _validateAndConsumeImplicitAuthorization(beneficiary, context);
            return;
        }

        (uint256 nonce, uint256 deadline, bytes memory signature) = abi.decode(
            context.authorization,
            (uint256, uint256, bytes)
        );

        /* solhint-disable-next-line not-rely-on-time */
        if (deadline < block.timestamp) {
            revert RebateAuthorizationExpired();
        }

        uint256 wordIndex = nonce >> 8;
        uint256 bitIndex = nonce & 0xff;
        uint256 bitMask = 1 << bitIndex;
        if (
            (usedAuthorizationNonceBitmap[beneficiary][wordIndex] & bitMask) !=
            0
        ) {
            revert RebateAuthorizationAlreadyUsed();
        }

        bytes32 structHash = keccak256(
            abi.encode(
                BENEFICIARY_REBATE_AUTHORIZATION_TYPEHASH,
                beneficiary,
                context.sourceChainId,
                context.l2User,
                uint8(context.flowType),
                context.actionId,
                context.maxRebateSat,
                nonce,
                deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash)
        );

        if (
            !SignatureCheckerUpgradeable.isValidSignatureNow(
                beneficiary,
                digest,
                signature
            )
        ) {
            revert InvalidRebateAuthorization();
        }

        usedAuthorizationNonceBitmap[beneficiary][wordIndex] |= bitMask;
        emit CrossChainRebateAuthorizationUsed(
            beneficiary,
            context.sourceChainId,
            nonce,
            context.actionId
        );
    }

    function _validateAndConsumeImplicitAuthorization(
        address beneficiary,
        BeneficiaryRebateContext calldata context
    ) internal {
        if (
            !implicitSameAddressEnabled[context.sourceChainId] ||
            beneficiary != context.l2User ||
            beneficiary.code.length != 0
        ) {
            revert InvalidRebateAuthorization();
        }

        bytes32 implicitActionKey = keccak256(
            abi.encode(
                context.sourceChainId,
                context.l2User,
                context.flowType,
                context.actionId
            )
        );
        if (usedImplicitCrossChainActions[implicitActionKey]) {
            revert CrossChainRebateAlreadyUsed();
        }

        usedImplicitCrossChainActions[implicitActionKey] = true;
    }

    /// @notice Cancels rebate in case of reedem request was timed out
    /// @param user Address of depositor or redeemer
    /// @param requestedAt Timestamp when redeem was requested
    /// @dev Requirements:
    ///      - The caller must be the bridge contract
    function cancelRebate(address user, uint256 requestedAt)
        external
        onlyBridge
    {
        user = getStaker(user);
        Stake storage stakeInfo = stakes[user];
        if (stakeInfo.stakedAmount == 0) {
            return;
        }

        /* solhint-disable-next-line not-rely-on-time */
        uint256 windowStart = block.timestamp - rollingWindow;
        uint256 rebatesLength = stakeInfo.rebates.length;
        for (
            uint256 i = stakeInfo.rollingWindowStartIndex;
            i < rebatesLength;
            i++
        ) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp > requestedAt) {
                break;
            } else if (rebate.timestamp < windowStart) {
                stakeInfo.rollingWindowStartIndex++;
            } else if (requestedAt == rebate.timestamp) {
                rebate.feeRebate = 0;
                emit RebateCanceled(user, requestedAt);
                break;
            }
        }
    }

    /// @notice Cancels a cross-chain rebate by beneficiary and action ID.
    /// @param beneficiary L1 staker or delegatee whose rebate capacity was used.
    /// @param actionId Non-zero cross-chain deposit key or redemption ID.
    /// @dev Requirements:
    ///      - The caller must be the bridge contract.
    function cancelCrossChainRebate(address beneficiary, bytes32 actionId)
        external
        onlyBridge
    {
        if (actionId == bytes32(0)) {
            revert InvalidCrossChainRebateContext();
        }

        address staker = getStaker(beneficiary);
        Stake storage stakeInfo = stakes[staker];
        if (stakeInfo.stakedAmount == 0) {
            return;
        }

        /* solhint-disable-next-line not-rely-on-time */
        uint256 windowStart = block.timestamp - rollingWindow;
        uint256 rebatesLength = stakeInfo.rebates.length;
        for (
            uint256 i = stakeInfo.rollingWindowStartIndex;
            i < rebatesLength;
            i++
        ) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp < windowStart) {
                stakeInfo.rollingWindowStartIndex++;
            } else if (rebate.actionId == actionId) {
                uint64 canceledRebate = rebate.feeRebate;
                rebate.feeRebate = 0;
                emit CrossChainRebateCanceled(
                    beneficiary,
                    actionId,
                    canceledRebate
                );
                break;
            }
        }
    }

    /// @notice Stake T token to be eligible for rebate
    /// @param amount Amount of tokens to stake
    function stake(uint96 amount) external {
        if (amount == 0) revert AmountCannotBeZero();

        address otherStaker = delegates[msg.sender];
        if (otherStaker != address(0)) {
            stakes[otherStaker].delegatee = address(0);
            delegates[msg.sender] = address(0);
            emit DelegateeSet(otherStaker, otherStaker);
        }

        Stake storage stakeInfo = stakes[msg.sender];
        stakeInfo.stakedAmount += amount;
        emit Staked(msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Start unstaking process
    /// @param amount Amount of tokens to unstake
    function startUnstaking(uint96 amount) external {
        if (amount == 0) revert AmountCannotBeZero();
        Stake storage stakeInfo = stakes[msg.sender];
        if (stakeInfo.unstakingTimestamp != 0) revert UnstakingAlreadyStarted();
        if (amount > stakeInfo.stakedAmount) revert AmountTooBig();
        /* solhint-disable-next-line not-rely-on-time */
        stakeInfo.unstakingTimestamp = uint32(block.timestamp);
        stakeInfo.unstakingAmount = amount;
        emit UnstakeStarted(msg.sender, amount);
    }

    /// @notice Finalize unstaking and withdraw tokens
    /// @param receiver Address of stake receiver
    function finalizeUnstaking(address receiver) external {
        if (receiver == address(0)) revert ZeroAddress();

        Stake storage stakeInfo = stakes[msg.sender];
        if (stakeInfo.unstakingTimestamp == 0) revert NoUnstakingProcess();
        if (
            /* solhint-disable-next-line not-rely-on-time */
            stakeInfo.unstakingTimestamp + unstakingPeriod > block.timestamp
        ) revert UnstakingNotFinished();

        stakeInfo.stakedAmount -= stakeInfo.unstakingAmount;
        uint96 amount = stakeInfo.unstakingAmount;
        stakeInfo.unstakingTimestamp = 0;
        stakeInfo.unstakingAmount = 0;
        if (stakeInfo.stakedAmount == 0 && stakeInfo.delegatee != address(0)) {
            delegates[stakeInfo.delegatee] = address(0);
            stakeInfo.delegatee = address(0);
        }

        emit UnstakeFinished(msg.sender, amount);
        token.safeTransfer(receiver, amount);
    }

    /// @notice Returns size of rebate array
    /// @param user Address of depositor or redeemer
    function getRebateLength(address user) external view returns (uint256) {
        return stakes[user].rebates.length;
    }

    /// @notice Returns timestamp and amount of rebate
    /// @param user Address of depositor or redeemer
    /// @param index Index of the element in the array
    /// @return timestamp Timestamp of rebate
    /// @return feeRebate Amount of rebate
    function getRebate(address user, uint256 index)
        external
        view
        returns (uint32 timestamp, uint64 feeRebate)
    {
        Rebate storage rebateInfo = stakes[user].rebates[index];
        timestamp = rebateInfo.timestamp;
        feeRebate = rebateInfo.feeRebate;
    }

    /// @notice Returns the cross-chain action ID for a rebate record.
    /// @param user Address of staker.
    /// @param index Index of the element in the array.
    /// @return actionId Cross-chain action ID or bytes32(0) for direct L1 rebates.
    function getRebateActionId(address user, uint256 index)
        external
        view
        returns (bytes32 actionId)
    {
        actionId = stakes[user].rebates[index].actionId;
    }

    /// @notice Returns information about stake
    /// @param user Address of depositor or redeemer
    /// @return stakedAmount Amount of stake
    function getStake(address user)
        external
        view
        returns (uint96 stakedAmount)
    {
        Stake storage stakeInfo = stakes[user];
        stakedAmount = stakeInfo.stakedAmount;
    }

    /// @notice Returns information about unstaking
    /// @param user Address of depositor or redeemer
    /// @return unstakingAmount Amount that is currently unstaking
    /// @return unstakingTimestamp Amount of rebate
    function getUnstakingAmount(address user)
        external
        view
        returns (uint96 unstakingAmount, uint32 unstakingTimestamp)
    {
        Stake storage stakeInfo = stakes[user];
        unstakingAmount = stakeInfo.unstakingAmount;
        unstakingTimestamp = stakeInfo.unstakingTimestamp;
    }

    /// @notice Returns the rebate treasury fee mode for a user.
    /// @param user Address of the staker
    /// @return rebateTreasuryFeeMode Current mode:
    ///         - 0: rebates for both deposits and redemptions,
    ///         - 1: rebates for deposits only,
    ///         - 2: rebates for redemptions only.
    function getRebateTreasuryFeeMode(address user)
        external
        view
        returns (RebateTreasuryFeeMode rebateTreasuryFeeMode)
    {
        Stake storage stakeInfo = stakes[user];
        rebateTreasuryFeeMode = stakeInfo.rebateTreasuryFeeMode;
    }

    /// @notice Returns information about stake
    /// @param user Address of depositor or redeemer
    /// @return delegatee Delegatee address.
    function getDelegatee(address user)
        external
        view
        returns (address delegatee)
    {
        Stake storage stakeInfo = stakes[user];
        delegatee = stakeInfo.delegatee;
    }

    /// @notice Transfers ownership of stake from one address to another
    /// @param oldStaker Old staker address
    /// @param newStaker New staker address
    function forceStakeTransfer(address oldStaker, address newStaker)
        external
        onlyOwner
    {
        if (oldStaker == address(0)) revert ZeroAddress();
        if (newStaker == address(0)) revert ZeroAddress();

        Stake storage oldStake = stakes[oldStaker];
        if (oldStake.stakedAmount == 0) {
            revert NotAStaker();
        }

        Stake storage newStake = stakes[newStaker];
        if (newStake.stakedAmount != 0) {
            revert AddressAlreadyTaken();
        }
        if (delegates[newStaker] != address(0)) {
            revert WrongDelegatee();
        }

        newStake.stakedAmount = oldStake.stakedAmount;
        newStake.unstakingAmount = oldStake.unstakingAmount;
        newStake.unstakingTimestamp = oldStake.unstakingTimestamp;
        newStake.rebateTreasuryFeeMode = oldStake.rebateTreasuryFeeMode;
        // Only migrate the active rebate window. The start index is updated
        // lazily during rebate operations, so use timestamps to find the first
        // active entry even for stakers that have been inactive for a long time.
        newStake.rollingWindowStartIndex = 0;
        uint256 rebatesLength = oldStake.rebates.length;

        /* solhint-disable-next-line not-rely-on-time */
        uint256 windowStart = block.timestamp - rollingWindow;
        uint256 low = oldStake.rollingWindowStartIndex;
        uint256 high = rebatesLength;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (oldStake.rebates[mid].timestamp < windowStart) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        for (uint256 i = low; i < rebatesLength; i++) {
            newStake.rebates.push(oldStake.rebates[i]);
        }
        if (oldStake.delegatee != address(0)) {
            address delegatee = oldStake.delegatee;
            newStake.delegatee = delegatee;
            delegates[delegatee] = newStaker;
            oldStake.delegatee = address(0);
            emit DelegateeSet(newStaker, delegatee);
        }

        oldStake.stakedAmount = 0;
        oldStake.unstakingAmount = 0;
        oldStake.unstakingTimestamp = 0;
        oldStake.rebateTreasuryFeeMode = RebateTreasuryFeeMode.Both;
        oldStake.rollingWindowStartIndex = 0;

        emit TransferFinished(oldStaker, newStaker);
    }
}
