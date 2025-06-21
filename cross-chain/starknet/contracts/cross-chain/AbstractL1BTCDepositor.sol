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

import "../integrator/AbstractBTCDepositor.sol";
import "../integrator/IBridge.sol";
import "../integrator/ITBTCVault.sol";
import "./utils/Crosschain.sol";

/// @title AbstractL1BTCDepositor
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain ERC20 tBTC on supported chains, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
///
///         `AbstractL1BTCDepositor` is deployed on the L1 chain and interacts with
///         their destination chain counterpart, in the case of EVM-compatible
///         chains, the `L2BTCDepositor`, deployed on the given L2 chain. Each
///         `AbstractL1BTCDepositor` & `L2BTCDepositor` pair is  responsible for a
///         specific L2 chain.
///
///         The outline of the direct bridging mechanism is as follows:
///         1. An L2 user issues a Bitcoin funding transaction to a P2(W)SH
///            deposit address that embeds the `AbstractL1BTCDepositor` contract
///            and L2 user addresses. The `AbstractL1BTCDepositor` contract serves
///            as the actual depositor on the L1 chain while the L2 user
///            address is set as the deposit owner who will receive the
///            minted ERC20 tBTC.
///         2. The data about the Bitcoin funding transaction and deposit
///            address are passed to the relayer. In the first iteration of
///            the direct bridging mechanism, this is achieved using an
///            on-chain event emitted by the `L2BTCDepositor` contract.
///            Further iterations assumes those data are passed off-chain, e.g.
///            through a REST API exposed by the relayer.
///         3. Once tBTC is minted on L1, the relayer calls `finalizeDeposit(...)`
///            to have the newly minted tBTC bridged to L2 for the user.
///            The details of that bridging are handled by `_transferTbtc(...)`
///            in whichever specialized child contract extends this abstract one.
///            address.
abstract contract AbstractL1BTCDepositor is
    AbstractBTCDepositor,
    OwnableUpgradeable,
    Reimbursable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

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

    /// @notice Holds the deposit state, keyed by the deposit key calculated for
    ///         the individual deposit during the call to `initializeDeposit`
    ///         function.
    mapping(uint256 => DepositState) public deposits;
    /// @notice ERC20 L1 tBTC token contract.
    IERC20Upgradeable public tbtcToken;
    /// @notice Holds deferred gas reimbursements for deposit initialization
    ///         (indexed by deposit key). Reimbursement for deposit
    ///         initialization is paid out upon deposit finalization. This is
    ///         because the tBTC Bridge accepts all (even invalid) deposits but
    ///         mints ERC20 tBTC only for the valid ones. Paying out the
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
    ///         is **reimbursed** (added to the user’s tBTC) or **deducted**.
    ///         - `true`  => Add `txMaxFee` to the minted tBTC amount
    ///         - `false` => Subtract `txMaxFee` from the minted tBTC amount
    bool public reimburseTxMaxFee;

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

    /// @notice Emitted whenever the owner toggles the reimbursement of the deposit
    ///         transaction max fee.
    event ReimburseTxMaxFeeUpdated(bool reimburseTxMaxFee);

    /// @dev This modifier comes from the `Reimbursable` base contract and
    ///      must be overridden to protect the `updateReimbursementPool` call.
    modifier onlyReimbursableAdmin() override {
        require(msg.sender == owner(), "Caller is not the owner");
        _;
    }

    function __AbstractL1BTCDepositor_initialize(
        address _tbtcBridge,
        address _tbtcVault
    ) internal {
        __AbstractBTCDepositor_initialize(_tbtcBridge, _tbtcVault);

        tbtcToken = IERC20Upgradeable(ITBTCVault(_tbtcVault).tbtcToken());

        initializeDepositGasOffset = 60_000;
        finalizeDepositGasOffset = 20_000;
        reimburseTxMaxFee = false;
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
    ///         Callers of `initializeDeposit` are eligible for a gas dgasd
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
    ///         `` contract.
    ///
    ///         <depositor-extra-data> destination chain deposit owner address in
    ///         the Bytes32 format.
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
    /// @param destinationChainDepositOwner Address of the destination chain deposit owner
    /// in Bytes32 format.
    /// @dev Requirements:
    ///      - The destination chain deposit owner address must not be 0x0,
    ///      - The function can be called only one time for the given Bitcoin
    ///        funding transaction,
    ///      - The destination chain deposit owner must be embedded in the Bitcoin P2(W)SH
    ///        deposit script as the <depositor-extra-data> field. The address must be
    ///        expressed as a 32-byte value left-padded with 0. If the value in the
    ///        Bitcoin script and the value passed as parameter do not match, the function
    ///        will revert,
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

        // Input parameters do not have to be validated in any way.
        // The tBTC Bridge is responsible for validating whether the provided
        // Bitcoin funding transaction transfers funds to the P2(W)SH deposit
        // address built from the reveal data. Despite the tBTC Bridge accepts
        // all transactions that meet the format requirements, it mints ERC20
        // L1 tBTC only for the ones that actually occurred on the Bitcoin
        // network and gathered enough confirmations.
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

            // Do not issue a reimbursement immediately. Record
            // a deferred reimbursement that will be paid out upon deposit
            // finalization. This is because the tBTC Bridge accepts all
            // (even invalid) deposits but mints ERC20 tBTC only for the valid
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

    /// @notice Finalizes the deposit process by transferring ERC20 L1 tBTC
    ///         to the destination chain deposit owner. This function should be
    ///         called after the deposit was initialized with a call to `initializeDeposit`
    ///         function and after ERC20 L1 tBTC was minted by the tBTC Bridge
    ///         to the `AbstractL1BTCDepositor` contract. Please note several hours
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
    ///      - ERC20 L1 tBTC was minted by tBTC Bridge to this contract,
    ///      - The function was not called for the given deposit before,
    ///      - The call must carry a payment for the briding system that
    ///        is responsible for executing the deposit finalization on the
    ///        corresponding destination chain. The payment must be equal to the
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
            // Deposit extra data is actually the destination chain deposit owner
            // address in Bytes32 format.
            bytes32 destinationChainDepositOwner
        ) = _finalizeDeposit(depositKey);

        // ----------------------------
        // Reimburse or Deduct Max Fee
        // ----------------------------
        if (reimburseTxMaxFee) {
            // Retrieve deposit tx max fee in 1e8 sat precision -> scale it to 1e18.
            (, , uint64 depositTxMaxFee, ) = bridge.depositParameters();
            uint256 txMaxFee = depositTxMaxFee * SATOSHI_MULTIPLIER;
            // The DAO is "refunding" it by adding it to the tBTC minted.
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
            // If there is a deferred reimbursement for this deposit
            // initialization, pay it out now. No need to check reimbursement
            // authorization for the initialization caller. If the deferred
            // reimbursement is here, that implies the caller was authorized
            // to receive it.
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

            // Pay out the reimbursement for deposit finalization if the caller
            // is authorized to receive reimbursements.
            if (reimbursementAuthorizations[msg.sender]) {
                // As this call is payable and this transaction carries out a
                // msg.value that covers the Bridging cost, we need to reimburse
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
    function _refundToGasSpent(
        uint256 refund
    ) internal virtual returns (uint256) {
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

    /// @notice Generic function for bridging tBTC to the destination chain. Overridden by child contracts.
    /// @dev In child contracts, this can be LayerZero, Wormhole, or any bridging code.
    /// @param amount Amount of tBTC in 1e18 precision.
    /// @param destinationChainReceiver destination chain deposit owner (32 bytes format).
    function _transferTbtc(
        uint256 amount,
        bytes32 destinationChainReceiver
    ) internal virtual;
}
