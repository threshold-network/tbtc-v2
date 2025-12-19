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
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "./integrator/AbstractTBTCDepositor.sol";
import "../../integrator/IBridge.sol";
import "../../integrator/ITBTCVault.sol";
import "../wormhole/Wormhole.sol";

/// @title L1BitcoinDepositor
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain ERC20 TBTC on supported L2 chains, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
///
///         `L1BitcoinDepositor` is deployed on the L1 chain and interacts with
///         their L2 counterpart, the `L2BitcoinDepositor`, deployed on the given
///         L2 chain. Each `L1BitcoinDepositor` & `L2BitcoinDepositor` pair is
///         responsible for a specific L2 chain.
///
///         The outline of the direct bridging mechanism is as follows:
///         1. An L2 user issues a Bitcoin funding transaction to a P2(W)SH
///            deposit address that embeds the `L1BitcoinDepositor` contract
///            and L2 user addresses. The `L1BitcoinDepositor` contract serves
///            as the actual depositor on the L1 chain while the L2 user
///            address is set as the deposit owner who will receive the
///            minted ERC20 TBTC.
///         2. The data about the Bitcoin funding transaction and deposit
///            address are passed to the relayer. In the first iteration of
///            the direct bridging mechanism, this is achieved using an
///            on-chain event emitted by the `L2BitcoinDepositor` contract.
///            Further iterations assumes those data are passed off-chain, e.g.
///            through a REST API exposed by the relayer.
///         3. The relayer uses the data to initialize a deposit on the L1
///            chain by calling the `initializeDeposit` function of the
///            `L1BitcoinDepositor` contract. The `initializeDeposit` function
///            reveals the deposit to the tBTC Bridge so minting of ERC20 L1 TBTC
///            can occur.
///         4. Once minting is complete, the `L1BitcoinDepositor` contract
///            receives minted ERC20 L1 TBTC. The relayer then calls the
///            `finalizeDeposit` function of the `L1BitcoinDepositor` contract
///            to transfer the minted ERC20 L1 TBTC to the L2 user address. This
///            is achieved using the Wormhole protocol. First, the `finalizeDeposit`
///            function initiates a Wormhole token transfer that locks the ERC20
///            L1 TBTC within the Wormhole Token Bridge contract and assigns
///            Wormhole-wrapped L2 TBTC to the corresponding `L2WormholeGateway`
///            contract. Then, `finalizeDeposit` notifies the `L2BitcoinDepositor`
///            contract by sending a Wormhole message containing the VAA
///            of the Wormhole token transfer. The `L2BitcoinDepositor` contract
///            receives the Wormhole message, and calls the `L2WormholeGateway`
///            contract that redeems Wormhole-wrapped L2 TBTC from the Wormhole
///            Token Bridge and uses it to mint canonical L2 TBTC to the L2 user
///            address.
contract L1BitcoinDepositor is
    AbstractTBTCDepositor,
    OwnableUpgradeable,
    Reimbursable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Reflects the deposit state:
    ///         - Unknown deposit has not been initialized yet.
    ///         - Initialized deposit has been initialized with a call to
    ///           `initializeDeposit` function and is known to this contract.
    ///         - Finalized deposit led to TBTC ERC20 minting and was finalized
    ///           with a call to `finalizeDeposit` function that transferred
    ///           TBTC ERC20 to the L2 deposit owner.
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

    /// @notice Holds the deposit state, keyed by the deposit key calculated for
    ///         the individual deposit during the call to `initializeDeposit`
    ///         function.
    mapping(uint256 => DepositState) public deposits;
    /// @notice ERC20 L1 TBTC token contract.
    IERC20Upgradeable public tbtcToken;
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
    /// @notice tBTC `L2BitcoinDepositor` contract on the corresponding L2 chain.
    address public l2BitcoinDepositor;
    /// @notice Gas limit necessary to execute the L2 part of the deposit
    ///         finalization. This value is used to calculate the payment for
    ///         the Wormhole Relayer that is responsible to execute the
    ///         deposit finalization on the corresponding L2 chain. Can be
    ///         updated by the owner.
    uint256 public l2FinalizeDepositGasLimit;
    /// @notice Holds deferred gas reimbursements for deposit initialization
    ///         (indexed by deposit key). Reimbursement for deposit
    ///         initialization is paid out upon deposit finalization. This is
    ///         because the tBTC Bridge accepts all (even invalid) deposits but
    ///         mints ERC20 TBTC only for the valid ones. Paying out the
    ///         reimbursement directly upon initialization would make the
    ///         reimbursement pool vulnerable to malicious actors that could
    ///         drain it by initializing invalid deposits.
    mapping(uint256 => GasReimbursement) public gasReimbursements;
    /// @notice Gas that is meant to balance the overall cost of deposit initialization.
    ///         Can be updated by the owner based on the current market conditions.
    uint256 public initializeDepositGasOffset;
    /// @notice Gas that is meant to balance the overall cost of deposit finalization.
    ///         Can be updated by the owner based on the current market conditions.
    uint256 public finalizeDepositGasOffset;
    /// @notice Set of addresses that are authorized to receive gas reimbursements
    ///         for deposit initialization and finalization. The authorization is
    ///         granted by the contract owner.
    mapping(address => bool) public reimbursementAuthorizations;

    /// @notice **Feature Flag** controlling whether the deposit transaction max fee
    ///         is **reimbursed** (added to the user’s TBTC) or **deducted**.
    ///         - `true`  => Add `txMaxFee` to the minted TBTC amount
    ///         - `false` => Subtract `txMaxFee` from the minted TBTC amount
    bool public reimburseTxMaxFee;

    event DepositInitialized(
        uint256 indexed depositKey,
        address indexed l2DepositOwner,
        address indexed l1Sender
    );

    event DepositFinalized(
        uint256 indexed depositKey,
        address indexed l2DepositOwner,
        address indexed l1Sender,
        uint256 initialAmount,
        uint256 tbtcAmount
    );

    event L2FinalizeDepositGasLimitUpdated(uint256 l2FinalizeDepositGasLimit);

    event GasOffsetParametersUpdated(
        uint256 initializeDepositGasOffset,
        uint256 finalizeDepositGasOffset
    );

    event ReimbursementAuthorizationUpdated(
        address indexed _address,
        bool authorization
    );

    /// @notice Emitted whenever the owner toggles the reimbursement of the deposit
    ///         transaction max fee.
    event ReimburseTxMaxFeeUpdated(bool reimburseTxMaxFee);

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
        address _tbtcBridge,
        address _tbtcVault,
        address _wormhole,
        address _wormholeRelayer,
        address _wormholeTokenBridge,
        address _l2WormholeGateway,
        uint16 _l2ChainId
    ) external initializer {
        __AbstractTBTCDepositor_initialize(_tbtcBridge, _tbtcVault);
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

        tbtcToken = IERC20Upgradeable(ITBTCVault(_tbtcVault).tbtcToken());
        wormhole = IWormhole(_wormhole);
        wormholeRelayer = IWormholeRelayer(_wormholeRelayer);
        wormholeTokenBridge = IWormholeTokenBridge(_wormholeTokenBridge);
        // slither-disable-next-line missing-zero-check
        l2WormholeGateway = _l2WormholeGateway;
        l2ChainId = _l2ChainId;
        l2FinalizeDepositGasLimit = 500_000;
        initializeDepositGasOffset = 60_000;
        finalizeDepositGasOffset = 20_000;
        reimburseTxMaxFee = false;
    }

    /// @notice Sets the address of the `L2BitcoinDepositor` contract on the
    ///         corresponding L2 chain. This function solves the chicken-and-egg
    ///         problem of setting the `L2BitcoinDepositor` contract address
    ///         on the `L1BitcoinDepositor` contract and vice versa.
    /// @param _l2BitcoinDepositor Address of the `L2BitcoinDepositor` contract.
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

    /// @notice Initializes the deposit process on L1 by revealing the deposit
    ///         data (funding transaction and components of the P2(W)SH deposit
    ///         address) to the tBTC Bridge. Once tBTC minting is completed,
    ///         this call should be followed by a call to `finalizeDeposit`.
    ///         Callers of `initializeDeposit` are eligible for a gas refund
    ///         that is paid out upon deposit finalization (only if the
    ///         reimbursement pool is attached and the given caller is
    ///         authorized for refunds).
    ///
    ///         The Bitcoin funding transaction must transfer funds to a P2(W)SH
    ///         deposit address whose underlying script is built from the
    ///         following components:
    ///
    ///         <depositor-address> DROP
    ///         <depositor-extra-data> DROP
    ///         <blinding-factor> DROP
    ///         DUP HASH160 <signingGroupPubkeyHash> EQUAL
    ///         IF
    ///           CHECKSIG
    ///         ELSE
    ///           DUP HASH160 <refundPubkeyHash> EQUALVERIFY
    ///           <locktime> CHECKLOCKTIMEVERIFY DROP
    ///           CHECKSIG
    ///         ENDIF
    ///
    ///         Where:
    ///
    ///         <depositor-address> 20-byte L1 address of the
    ///         `L1BitcoinDepositor` contract.
    ///
    ///         <depositor-extra-data> L2 deposit owner address in the Wormhole
    ///         format, i.e. 32-byte value left-padded with 0.
    ///
    ///         <blinding-factor> 8-byte deposit blinding factor, as used in the
    ///         tBTC bridge.
    ///
    ///         <signingGroupPubkeyHash> The compressed Bitcoin public key (33
    ///         bytes and 02 or 03 prefix) of the deposit's wallet hashed in the
    ///         HASH160 Bitcoin opcode style. This must point to the active tBTC
    ///         bridge wallet.
    ///
    ///         <refundPubkeyHash> The compressed Bitcoin public key (33 bytes
    ///         and 02 or 03 prefix) that can be used to make the deposit refund
    ///         after the tBTC bridge refund locktime passed. Hashed in the
    ///         HASH160 Bitcoin opcode style. This is needed only as a security
    ///         measure protecting the user in case tBTC bridge completely stops
    ///         functioning.
    ///
    ///         <locktime> The Bitcoin script refund locktime (4-byte LE),
    ///         according to tBTC bridge rules.
    ///
    ///         Please consult tBTC `Bridge.revealDepositWithExtraData` function
    ///         documentation for more information.
    /// @param fundingTx Bitcoin funding transaction data.
    /// @param reveal Deposit reveal data.
    /// @param l2DepositOwner Address of the L2 deposit owner.
    /// @dev Requirements:
    ///      - The L2 deposit owner address must not be 0x0,
    ///      - The function can be called only one time for the given Bitcoin
    ///        funding transaction,
    ///      - The L2 deposit owner must be embedded in the Bitcoin P2(W)SH
    ///        deposit script as the <depositor-extra-data> field. The 20-byte
    ///        address must be expressed as a 32-byte value left-padded with 0.
    ///        If the value in the Bitcoin script and the value passed as
    ///        parameter do not match, the function will revert,
    ///      - All the requirements of tBTC Bridge.revealDepositWithExtraData
    ///        must be met.
    function initializeDeposit(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        address l2DepositOwner
    ) external {
        uint256 gasStart = gasleft();

        require(
            l2DepositOwner != address(0),
            "L2 deposit owner must not be 0x0"
        );

        // Convert the L2 deposit owner address into the Wormhole format and
        // encode it as deposit extra data.
        bytes32 extraData = WormholeUtils.toWormholeAddress(l2DepositOwner);

        // Input parameters do not have to be validated in any way.
        // The tBTC Bridge is responsible for validating whether the provided
        // Bitcoin funding transaction transfers funds to the P2(W)SH deposit
        // address built from the reveal data. Despite the tBTC Bridge accepts
        // all transactions that meet the format requirements, it mints ERC20
        // L1 TBTC only for the ones that actually occurred on the Bitcoin
        // network and gathered enough confirmations.
        (uint256 depositKey, ) = _initializeDeposit(
            fundingTx,
            reveal,
            extraData
        );

        require(
            deposits[depositKey] == DepositState.Unknown,
            "Wrong deposit state"
        );

        // slither-disable-next-line reentrancy-benign
        deposits[depositKey] = DepositState.Initialized;

        // slither-disable-next-line reentrancy-events
        emit DepositInitialized(depositKey, l2DepositOwner, msg.sender);

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

            // Do not issue a reimbursement immediately. Record
            // a deferred reimbursement that will be paid out upon deposit
            // finalization. This is because the tBTC Bridge accepts all
            // (even invalid) deposits but mints ERC20 TBTC only for the valid
            // ones. Paying out the reimbursement directly upon initialization
            // would make the reimbursement pool vulnerable to malicious actors
            // that could drain it by initializing invalid deposits.
            // slither-disable-next-line reentrancy-benign
            gasReimbursements[depositKey] = GasReimbursement({
                receiver: msg.sender,
                gasSpent: uint96(gasSpent)
            });
        }
    }

    /// @notice Finalizes the deposit process by transferring ERC20 L1 TBTC
    ///         to the L2 deposit owner. This function should be called after
    ///         the deposit was initialized with a call to `initializeDeposit`
    ///         function and after ERC20 L1 TBTC was minted by the tBTC Bridge
    ///         to the `L1BitcoinDepositor` contract. Please note several hours
    ///         may pass between `initializeDeposit`and `finalizeDeposit`.
    ///         If the reimbursement pool is attached, the function pays out
    ///         a gas and call's value refund to the caller (if the given
    ///         caller is authorized for refunds) as well as the deferred gas
    ///         refund to the caller of `initializeDeposit` corresponding to
    ///         the finalized deposit.
    /// @param depositKey The deposit key, as emitted in the `DepositInitialized`
    ///        event emitted by the `initializeDeposit` function for the deposit.
    /// @dev Requirements:
    ///      - `initializeDeposit` was called for the given deposit before,
    ///      - ERC20 L1 TBTC was minted by tBTC Bridge to this contract,
    ///      - The function was not called for the given deposit before,
    ///      - The call must carry a payment for the Wormhole Relayer that
    ///        is responsible for executing the deposit finalization on the
    ///        corresponding L2 chain. The payment must be equal to the
    ///        value returned by the `quoteFinalizeDeposit` function.
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
            // Deposit extra data is actually the L2 deposit owner
            // address in Wormhole format.
            bytes32 l2DepositOwner
        ) = _finalizeDeposit(depositKey);

        // ----------------------------
        // Reimburse or Deduct Max Fee
        // ----------------------------
        if (reimburseTxMaxFee) {
            // Retrieve deposit tx max fee in 1e8 sat precision -> scale it to 1e18.
            (, , uint64 depositTxMaxFee, ) = bridge.depositParameters();
            uint256 txMaxFee = depositTxMaxFee * SATOSHI_MULTIPLIER;
            // The DAO is "refunding" it by adding it to the TBTC minted.
            tbtcAmount += txMaxFee;
        }

        // slither-disable-next-line reentrancy-events
        emit DepositFinalized(
            depositKey,
            WormholeUtils.fromWormholeAddress(l2DepositOwner),
            msg.sender,
            initialDepositAmount,
            tbtcAmount
        );

        _transferTbtc(tbtcAmount, l2DepositOwner);

        // `ReimbursementPool` calls the untrusted receiver address using a
        // low-level call. Reentrancy risk is mitigated by making sure that
        // `ReimbursementPool.refund` is a non-reentrant function and executing
        // reimbursements as the last step of the deposit finalization.
        if (address(reimbursementPool) != address(0)) {
            // If there is a deferred reimbursement for this deposit
            // initialization, pay it out now. No need to check reimbursement
            // authorization for the initialization caller. If the deferred
            // reimbursement is here, that implies the caller was authorized
            // to receive it.
            GasReimbursement memory reimbursement = gasReimbursements[
                depositKey
            ];
            if (reimbursement.receiver != address(0)) {
                delete gasReimbursements[depositKey];

                reimbursementPool.refund(
                    reimbursement.gasSpent,
                    reimbursement.receiver
                );
            }

            // Pay out the reimbursement for deposit finalization if the caller
            // is authorized to receive reimbursements.
            if (reimbursementAuthorizations[msg.sender]) {
                // As this call is payable and this transaction carries out a
                // msg.value that covers Wormhole cost, we need to reimburse
                // that as well. However, the `ReimbursementPool` issues refunds
                // based on gas spent. We need to convert msg.value accordingly
                // using the `_refundToGasSpent` function.
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

    /// @notice The `ReimbursementPool` contract issues refunds based on
    ///         gas spent. If there is a need to get a specific refund based
    ///         on WEI value, such a value must be first converted to gas spent.
    ///         This function does such a conversion.
    /// @param refund Refund value in WEI.
    /// @return Refund value as gas spent.
    /// @dev This function is the reverse of the logic used
    ///      within `ReimbursementPool.refund`.
    function _refundToGasSpent(uint256 refund) internal returns (uint256) {
        uint256 maxGasPrice = reimbursementPool.maxGasPrice();
        uint256 staticGas = reimbursementPool.staticGas();

        uint256 gasPrice = tx.gasprice < maxGasPrice
            ? tx.gasprice
            : maxGasPrice;

        // Should not happen but check just in case of weird ReimbursementPool
        // configuration.
        if (gasPrice == 0) {
            return 0;
        }

        uint256 gasSpent = (refund / gasPrice);

        // Should not happen but check just in case of weird ReimbursementPool
        // configuration.
        if (staticGas > gasSpent) {
            return 0;
        }

        return gasSpent - staticGas;
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

    /// @notice Transfers ERC20 L1 TBTC to the L2 deposit owner using the Wormhole
    ///         protocol. The function initiates a Wormhole token transfer that
    ///         locks the ERC20 L1 TBTC within the Wormhole Token Bridge contract
    ///         and assigns Wormhole-wrapped L2 TBTC to the corresponding
    ///         `L2WormholeGateway` contract. Then, the function notifies the
    ///         `L2BitcoinDepositor` contract by sending a Wormhole message
    ///         containing the VAA of the Wormhole token transfer. The
    ///         `L2BitcoinDepositor` contract receives the Wormhole message,
    ///         and calls the `L2WormholeGateway` contract that redeems
    ///         Wormhole-wrapped L2 TBTC from the Wormhole Token Bridge and
    ///         uses it to mint canonical L2 TBTC to the L2 deposit owner address.
    /// @param amount Amount of TBTC L1 ERC20 to transfer (1e18 precision).
    /// @param l2Receiver Address of the L2 deposit owner.
    /// @dev Requirements:
    ///      - The normalized amount (1e8 precision) must be greater than 0,
    ///      - The appropriate payment for the Wormhole Relayer must be
    ///        attached to the call (as calculated by `quoteFinalizeDeposit`).
    /// @dev Implemented based on examples presented as part of the Wormhole SDK:
    ///      https://github.com/wormhole-foundation/hello-token/blob/8ec757248788dc12183f13627633e1d6fd1001bb/src/example-extensions/HelloTokenWithoutSDK.sol#L29
    function _transferTbtc(uint256 amount, bytes32 l2Receiver) internal {
        // Wormhole supports the 1e8 precision at most. TBTC is 1e18 so
        // the amount needs to be normalized.
        amount = WormholeUtils.normalize(amount);

        require(amount > 0, "Amount too low to bridge");

        // Cost of requesting a `finalizeDeposit` message to be sent to
        //  `l2ChainId` with a gasLimit of `l2FinalizeDepositGasLimit`.
        uint256 wormholeMessageFee = wormhole.messageFee();
        uint256 cost = _quoteFinalizeDeposit(wormholeMessageFee);

        require(msg.value == cost, "Payment for Wormhole Relayer is too low");

        // The Wormhole Token Bridge will pull the TBTC amount
        // from this contract. We need to approve the transfer first.
        tbtcToken.safeIncreaseAllowance(address(wormholeTokenBridge), amount);

        // Initiate a Wormhole token transfer that will lock L1 TBTC within
        // the Wormhole Token Bridge contract and assign Wormhole-wrapped
        // L2 TBTC to the corresponding `L2WormholeGateway` contract.
        // slither-disable-next-line arbitrary-send-eth
        uint64 transferSequence = wormholeTokenBridge.transferTokensWithPayload{
            value: wormholeMessageFee
        }(
            address(tbtcToken),
            amount,
            l2ChainId,
            WormholeUtils.toWormholeAddress(l2WormholeGateway),
            0, // Nonce is a free field that is not relevant in this context.
            abi.encode(l2Receiver) // Set the L2 receiver address as the transfer payload.
        );

        // Construct the VAA key corresponding to the above Wormhole token transfer.
        WormholeTypes.VaaKey[]
            memory additionalVaas = new WormholeTypes.VaaKey[](1);
        additionalVaas[0] = WormholeTypes.VaaKey({
            chainId: wormhole.chainId(),
            emitterAddress: WormholeUtils.toWormholeAddress(
                address(wormholeTokenBridge)
            ),
            sequence: transferSequence
        });

        // The Wormhole token transfer initiated above must be finalized on
        // the L2 chain. We achieve that by sending the transfer's VAA to the
        // `L2BitcoinDepositor` contract. Once, the `L2BitcoinDepositor`
        // contract receives it, it calls the `L2WormholeGateway` contract
        // that redeems Wormhole-wrapped L2 TBTC from the Wormhole Token
        // Bridge and use it to mint canonical L2 TBTC to the receiver address.
        // slither-disable-next-line arbitrary-send-eth,unused-return
        wormholeRelayer.sendVaasToEvm{value: cost - wormholeMessageFee}(
            l2ChainId,
            l2BitcoinDepositor,
            bytes(""), // No payload needed. The L2 receiver address is already encoded in the Wormhole token transfer payload.
            0, // No receiver value needed.
            l2FinalizeDepositGasLimit,
            additionalVaas,
            l2ChainId, // Set the L2 chain as the refund chain to avoid cross-chain refunds.
            msg.sender // Set the caller as the refund receiver.
        );
    }
}
