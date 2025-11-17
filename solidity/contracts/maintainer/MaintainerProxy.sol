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

import "@openzeppelin/contracts/access/Ownable.sol";
import "@keep-network/random-beacon/contracts/Reimbursable.sol";
import "@keep-network/random-beacon/contracts/ReimbursementPool.sol";

import "../bridge/BitcoinTx.sol";
import "../bridge/Bridge.sol";

/// @title Maintainer Proxy
/// @notice Maintainers are the willing off-chain clients approved by the governance.
///         Maintainers proxy calls to the `Bridge` contract via 'MaintainerProxy'
///         and are refunded for the spent gas from the `ReimbursementPool`.
///         There are two types of maintainers: wallet maintainers and SPV
///         maintainers.
contract MaintainerProxy is Ownable, Reimbursable {
    Bridge public bridge;

    /// @notice Authorized wallet maintainers that can interact with the set of
    ///         functions for wallet maintainers only. Authorization can be
    ///         granted and removed by the governance.
    /// @dev    'Key' is the address of the maintainer. 'Value' represents an index+1
    ///         in the 'maintainers' array. 1 was added so the maintainer index can
    ///         never be 0 which is a reserved index for a non-existent maintainer
    ///         in this map.
    mapping(address => uint256) public isWalletMaintainer;

    /// @notice This list of wallet maintainers keeps the order of which wallet
    ///         maintainer should be submitting a next transaction. It does not
    ///         enforce the order but only tracks who should be next in line.
    address[] public walletMaintainers;

    /// @notice Authorized SPV maintainers that can interact with the set of
    ///         functions for SPV maintainers only. Authorization can be
    ///         granted and removed by the governance.
    /// @dev    'Key' is the address of the maintainer. 'Value' represents an index+1
    ///         in the 'maintainers' array. 1 was added so the maintainer index can
    ///         never be 0 which is a reserved index for a non-existent maintainer
    ///         in this map.
    mapping(address => uint256) public isSpvMaintainer;

    /// @notice This list of SPV maintainers keeps the order of which SPV
    ///         maintainer should be submitting a next transaction. It does not
    ///         enforce the order but only tracks who should be next in line.
    address[] public spvMaintainers;

    /// @notice Gas that is meant to balance the submission of deposit sweep proof
    ///         overall cost. Can be updated by the governance based on the current
    ///         market conditions.
    uint256 public submitDepositSweepProofGasOffset;

    /// @notice Gas that is meant to balance the submission of redemption proof
    ///         overall cost. Can be updated by the governance based on the current
    ///         market conditions.
    uint256 public submitRedemptionProofGasOffset;

    /// @notice Gas that is meant to balance the reset of moving funds timeout
    ///         overall cost. Can be updated by the governance based on the current
    ///         market conditions.
    uint256 public resetMovingFundsTimeoutGasOffset;

    /// @notice Gas that is meant to balance the submission of moving funds proof
    ///         overall cost. Can be updated by the governance based on the current
    ///         market conditions.
    uint256 public submitMovingFundsProofGasOffset;

    /// @notice Gas that is meant to balance the notification of moving funds below
    ///         dust overall cost. Can be updated by the governance based on the
    ///         current market conditions.
    uint256 public notifyMovingFundsBelowDustGasOffset;

    /// @notice Gas that is meant to balance the submission of moved funds sweep
    ///         proof overall cost. Can be updated by the governance based on the
    ///         current market conditions.
    uint256 public submitMovedFundsSweepProofGasOffset;

    /// @notice Gas that is meant to balance the request of a new wallet overall
    ///         cost. Can be updated by the governance based on the current
    ///         market conditions.
    uint256 public requestNewWalletGasOffset;

    /// @notice Gas that is meant to balance the notification of closeable wallet
    ///         overall cost. Can be updated by the governance based on the current
    ///         market conditions.
    uint256 public notifyWalletCloseableGasOffset;

    /// @notice Gas that is meant to balance the notification of wallet closing
    ///         period elapsed overall cost. Can be updated by the governance
    ///         based on the current market conditions.
    uint256 public notifyWalletClosingPeriodElapsedGasOffset;

    /// @notice Gas that is meant to balance the defeat fraud challenge
    ///         overall cost. Can be updated by the governance based on the current
    ///         market conditions.
    uint256 public defeatFraudChallengeGasOffset;

    /// @notice Gas that is meant to balance the defeat fraud challenge with heartbeat
    ///         overall cost. Can be updated by the governance based on the current
    ///         market conditions.
    uint256 public defeatFraudChallengeWithHeartbeatGasOffset;

    event WalletMaintainerAuthorized(address indexed maintainer);

    event WalletMaintainerUnauthorized(address indexed maintainer);

    event SpvMaintainerAuthorized(address indexed maintainer);

    event SpvMaintainerUnauthorized(address indexed maintainer);

    event BridgeUpdated(address newBridge);

    event GasOffsetParametersUpdated(
        uint256 submitDepositSweepProofGasOffset,
        uint256 submitRedemptionProofGasOffset,
        uint256 resetMovingFundsTimeoutGasOffset,
        uint256 submitMovingFundsProofGasOffset,
        uint256 notifyMovingFundsBelowDustGasOffset,
        uint256 submitMovedFundsSweepProofGasOffset,
        uint256 requestNewWalletGasOffset,
        uint256 notifyWalletCloseableGasOffset,
        uint256 notifyWalletClosingPeriodElapsedGasOffset,
        uint256 defeatFraudChallengeGasOffset,
        uint256 defeatFraudChallengeWithHeartbeatGasOffset
    );

    modifier onlyWalletMaintainer() {
        require(
            isWalletMaintainer[msg.sender] != 0,
            "Caller is not authorized"
        );
        _;
    }

    modifier onlySpvMaintainer() {
        require(isSpvMaintainer[msg.sender] != 0, "Caller is not authorized");
        _;
    }

    modifier onlyReimbursableAdmin() override {
        require(owner() == msg.sender, "Caller is not the owner");
        _;
    }

    constructor(Bridge _bridge, ReimbursementPool _reimbursementPool) {
        bridge = _bridge;
        reimbursementPool = _reimbursementPool;
        submitDepositSweepProofGasOffset = 30000;
        submitRedemptionProofGasOffset = 4000;
        resetMovingFundsTimeoutGasOffset = 1000;
        submitMovingFundsProofGasOffset = 20000;
        notifyMovingFundsBelowDustGasOffset = 3500;
        submitMovedFundsSweepProofGasOffset = 26000;
        requestNewWalletGasOffset = 3500;
        notifyWalletCloseableGasOffset = 4000;
        notifyWalletClosingPeriodElapsedGasOffset = 3000;
        defeatFraudChallengeGasOffset = 10000;
        defeatFraudChallengeWithHeartbeatGasOffset = 5000;
    }

    /// @notice Wraps `Bridge.submitDepositSweepProof` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.submitDepositSweepProof` function documentation.
    function submitDepositSweepProof(
        BitcoinTx.Info calldata sweepTx,
        BitcoinTx.Proof calldata sweepProof,
        BitcoinTx.UTXO calldata mainUtxo,
        address vault
    ) external onlySpvMaintainer {
        uint256 gasStart = gasleft();

        bridge.submitDepositSweepProof(sweepTx, sweepProof, mainUtxo, vault);

        reimbursementPool.refund(
            (gasStart - gasleft()) + submitDepositSweepProofGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.submitRedemptionProof` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.submitRedemptionProof` function documentation.
    function submitRedemptionProof(
        BitcoinTx.Info calldata redemptionTx,
        BitcoinTx.Proof calldata redemptionProof,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes20 walletPubKeyHash
    ) external onlySpvMaintainer {
        uint256 gasStart = gasleft();

        bridge.submitRedemptionProof(
            redemptionTx,
            redemptionProof,
            mainUtxo,
            walletPubKeyHash
        );

        reimbursementPool.refund(
            (gasStart - gasleft()) + submitRedemptionProofGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.resetMovingFundsTimeout` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.resetMovingFundsTimeout` function documentation.
    function resetMovingFundsTimeout(bytes20 walletPubKeyHash) external {
        uint256 gasStart = gasleft();

        bridge.resetMovingFundsTimeout(walletPubKeyHash);

        reimbursementPool.refund(
            (gasStart - gasleft()) + resetMovingFundsTimeoutGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.submitMovingFundsProof` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.submitMovingFundsProof` function documentation.
    function submitMovingFundsProof(
        BitcoinTx.Info calldata movingFundsTx,
        BitcoinTx.Proof calldata movingFundsProof,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes20 walletPubKeyHash
    ) external onlySpvMaintainer {
        uint256 gasStart = gasleft();

        bridge.submitMovingFundsProof(
            movingFundsTx,
            movingFundsProof,
            mainUtxo,
            walletPubKeyHash
        );

        reimbursementPool.refund(
            (gasStart - gasleft()) + submitMovingFundsProofGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.notifyMovingFundsBelowDust` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.notifyMovingFundsBelowDust` function documentation.
    function notifyMovingFundsBelowDust(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo
    ) external onlyWalletMaintainer {
        uint256 gasStart = gasleft();

        bridge.notifyMovingFundsBelowDust(walletPubKeyHash, mainUtxo);

        reimbursementPool.refund(
            (gasStart - gasleft()) + notifyMovingFundsBelowDustGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.submitMovedFundsSweepProof` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.submitMovedFundsSweepProof` function documentation.
    function submitMovedFundsSweepProof(
        BitcoinTx.Info calldata sweepTx,
        BitcoinTx.Proof calldata sweepProof,
        BitcoinTx.UTXO calldata mainUtxo
    ) external onlySpvMaintainer {
        uint256 gasStart = gasleft();

        bridge.submitMovedFundsSweepProof(sweepTx, sweepProof, mainUtxo);

        reimbursementPool.refund(
            (gasStart - gasleft()) + submitMovedFundsSweepProofGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.requestNewWallet` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.requestNewWallet` function documentation.
    function requestNewWallet(BitcoinTx.UTXO calldata activeWalletMainUtxo)
        external
        onlyWalletMaintainer
    {
        uint256 gasStart = gasleft();

        bridge.requestNewWallet(activeWalletMainUtxo);

        reimbursementPool.refund(
            (gasStart - gasleft()) + requestNewWalletGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.notifyWalletCloseable` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.notifyWalletCloseable` function documentation.
    function notifyWalletCloseable(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata walletMainUtxo
    ) external onlyWalletMaintainer {
        uint256 gasStart = gasleft();

        bridge.notifyWalletCloseable(walletPubKeyHash, walletMainUtxo);

        reimbursementPool.refund(
            (gasStart - gasleft()) + notifyWalletCloseableGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.notifyWalletClosingPeriodElapsed` call and reimburses
    ///         the caller's transaction cost.
    /// @dev See `Bridge.notifyWalletClosingPeriodElapsed` function documentation.
    function notifyWalletClosingPeriodElapsed(bytes20 walletPubKeyHash)
        external
        onlyWalletMaintainer
    {
        uint256 gasStart = gasleft();

        bridge.notifyWalletClosingPeriodElapsed(walletPubKeyHash);

        reimbursementPool.refund(
            (gasStart - gasleft()) + notifyWalletClosingPeriodElapsedGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.defeatFraudChallenge` call and reimburses the
    ///         caller's transaction cost.
    /// @dev See `Bridge.defeatFraudChallenge` function documentation.
    function defeatFraudChallenge(
        bytes calldata walletPublicKey,
        bytes calldata preimage,
        bool witness
    ) external {
        uint256 gasStart = gasleft();

        bridge.defeatFraudChallenge(walletPublicKey, preimage, witness);

        reimbursementPool.refund(
            (gasStart - gasleft()) + defeatFraudChallengeGasOffset,
            msg.sender
        );
    }

    /// @notice Wraps `Bridge.defeatFraudChallengeWithHeartbeat` call and
    ///         reimburses the caller's transaction cost.
    /// @dev See `Bridge.defeatFraudChallengeWithHeartbeat` function documentation.
    function defeatFraudChallengeWithHeartbeat(
        bytes calldata walletPublicKey,
        bytes calldata heartbeatMessage
    ) external {
        uint256 gasStart = gasleft();

        bridge.defeatFraudChallengeWithHeartbeat(
            walletPublicKey,
            heartbeatMessage
        );

        reimbursementPool.refund(
            (gasStart - gasleft()) + defeatFraudChallengeWithHeartbeatGasOffset,
            msg.sender
        );
    }

    /// @notice Authorize a wallet maintainer that can interact with this
    ///         reimbursement pool. Can be authorized by the owner only.
    /// @param maintainer Wallet maintainer to authorize.
    function authorizeWalletMaintainer(address maintainer) external onlyOwner {
        walletMaintainers.push(maintainer);
        isWalletMaintainer[maintainer] = walletMaintainers.length;

        emit WalletMaintainerAuthorized(maintainer);
    }

    /// @notice Authorize an SPV maintainer that can interact with this
    ///         reimbursement pool. Can be authorized by the owner only.
    /// @param maintainer SPV maintainer to authorize.
    function authorizeSpvMaintainer(address maintainer) external onlyOwner {
        spvMaintainers.push(maintainer);
        isSpvMaintainer[maintainer] = spvMaintainers.length;

        emit SpvMaintainerAuthorized(maintainer);
    }

    /// @notice Unauthorize a wallet maintainer that was previously authorized to
    ///         interact with the Maintainer Proxy contract. Can be unauthorized
    ///         by the owner only.
    /// @dev    The last maintainer is swapped with the one to be unauthorized.
    ///         The unauthorized maintainer is then removed from the list. An index
    ///         of the last maintainer is changed with the removed maintainer.
    ///         Ex.
    ///         'walletMaintainers' list: [0x1, 0x2, 0x3, 0x4, 0x5]
    ///         'isWalletMaintainer' map: [0x1 -> 1, 0x2 -> 2, 0x3 -> 3, 0x4 -> 4, 0x5 -> 5]
    ///         unauthorize: 0x3
    ///         new 'walletMaintainers' list: [0x1, 0x2, 0x5, 0x4]
    ///         new 'isWalletMaintainer' map: [0x1 -> 1, 0x2 -> 2, 0x4 -> 4, 0x5 -> 3]
    /// @param maintainerToUnauthorize Maintainer to unauthorize.
    function unauthorizeWalletMaintainer(address maintainerToUnauthorize)
        external
        onlyOwner
    {
        uint256 maintainerIdToUnauthorize = isWalletMaintainer[
            maintainerToUnauthorize
        ];

        require(maintainerIdToUnauthorize != 0, "No maintainer to unauthorize");

        address lastMaintainerAddress = walletMaintainers[
            walletMaintainers.length - 1
        ];

        walletMaintainers[
            maintainerIdToUnauthorize - 1
        ] = lastMaintainerAddress;
        walletMaintainers.pop();

        isWalletMaintainer[lastMaintainerAddress] = maintainerIdToUnauthorize;

        delete isWalletMaintainer[maintainerToUnauthorize];

        emit WalletMaintainerUnauthorized(maintainerToUnauthorize);
    }

    /// @notice Unauthorize an SPV maintainer that was previously authorized to
    ///         interact with the Maintainer Proxy contract. Can be unauthorized
    ///         by the owner only.
    /// @dev    The last maintainer is swapped with the one to be unauthorized.
    ///         The unauthorized maintainer is then removed from the list. An index
    ///         of the last maintainer is changed with the removed maintainer.
    ///         Ex.
    ///         'spvMaintainers' list: [0x1, 0x2, 0x3, 0x4, 0x5]
    ///         'isSpvMaintainer' map: [0x1 -> 1, 0x2 -> 2, 0x3 -> 3, 0x4 -> 4, 0x5 -> 5]
    ///         unauthorize: 0x3
    ///         new 'spvMaintainers' list: [0x1, 0x2, 0x5, 0x4]
    ///         new 'isSpvMaintainer' map: [0x1 -> 1, 0x2 -> 2, 0x4 -> 4, 0x5 -> 3]
    /// @param maintainerToUnauthorize Maintainer to unauthorize.
    function unauthorizeSpvMaintainer(address maintainerToUnauthorize)
        external
        onlyOwner
    {
        uint256 maintainerIdToUnauthorize = isSpvMaintainer[
            maintainerToUnauthorize
        ];

        require(maintainerIdToUnauthorize != 0, "No maintainer to unauthorize");

        address lastMaintainerAddress = spvMaintainers[
            spvMaintainers.length - 1
        ];

        spvMaintainers[maintainerIdToUnauthorize - 1] = lastMaintainerAddress;
        spvMaintainers.pop();

        isSpvMaintainer[lastMaintainerAddress] = maintainerIdToUnauthorize;

        delete isSpvMaintainer[maintainerToUnauthorize];

        emit SpvMaintainerUnauthorized(maintainerToUnauthorize);
    }

    /// @notice Allows the Governance to upgrade the Bridge address.
    /// @dev The function does not implement any governance delay and does not
    ///      check the status of the Bridge. The Governance implementation needs
    ///      to ensure all requirements for the upgrade are satisfied before
    ///      executing this function.
    function updateBridge(Bridge _bridge) external onlyOwner {
        bridge = _bridge;

        emit BridgeUpdated(address(_bridge));
    }

    /// @notice Updates the values of gas offset parameters.
    /// @dev Can be called only by the contract owner. The caller is responsible
    ///      for validating parameters.
    /// @param newSubmitDepositSweepProofGasOffset New submit deposit sweep
    ///        proof gas offset.
    /// @param newSubmitRedemptionProofGasOffset New submit redemption proof gas
    ///        offset.
    /// @param newResetMovingFundsTimeoutGasOffset New reset moving funds
    ///        timeout gas offset.
    /// @param newSubmitMovingFundsProofGasOffset New submit moving funds proof
    ///        gas offset.
    /// @param newNotifyMovingFundsBelowDustGasOffset New notify moving funds
    ///        below dust gas offset.
    /// @param newSubmitMovedFundsSweepProofGasOffset New submit moved funds
    ///        sweep proof gas offset.
    /// @param newRequestNewWalletGasOffset New request new wallet gas offset.
    /// @param newNotifyWalletCloseableGasOffset New notify closeable wallet gas
    ///        offset.
    /// @param newNotifyWalletClosingPeriodElapsedGasOffset New notify wallet
    ///        closing period elapsed gas offset.
    /// @param newDefeatFraudChallengeGasOffset New defeat fraud challenge gas
    ///        offset.
    /// @param newDefeatFraudChallengeWithHeartbeatGasOffset New defeat fraud
    ///        challenge with heartbeat gas offset.
    function updateGasOffsetParameters(
        uint256 newSubmitDepositSweepProofGasOffset,
        uint256 newSubmitRedemptionProofGasOffset,
        uint256 newResetMovingFundsTimeoutGasOffset,
        uint256 newSubmitMovingFundsProofGasOffset,
        uint256 newNotifyMovingFundsBelowDustGasOffset,
        uint256 newSubmitMovedFundsSweepProofGasOffset,
        uint256 newRequestNewWalletGasOffset,
        uint256 newNotifyWalletCloseableGasOffset,
        uint256 newNotifyWalletClosingPeriodElapsedGasOffset,
        uint256 newDefeatFraudChallengeGasOffset,
        uint256 newDefeatFraudChallengeWithHeartbeatGasOffset
    ) external onlyOwner {
        submitDepositSweepProofGasOffset = newSubmitDepositSweepProofGasOffset;
        submitRedemptionProofGasOffset = newSubmitRedemptionProofGasOffset;
        resetMovingFundsTimeoutGasOffset = newResetMovingFundsTimeoutGasOffset;
        submitMovingFundsProofGasOffset = newSubmitMovingFundsProofGasOffset;
        notifyMovingFundsBelowDustGasOffset = newNotifyMovingFundsBelowDustGasOffset;
        submitMovedFundsSweepProofGasOffset = newSubmitMovedFundsSweepProofGasOffset;
        requestNewWalletGasOffset = newRequestNewWalletGasOffset;
        notifyWalletCloseableGasOffset = newNotifyWalletCloseableGasOffset;
        notifyWalletClosingPeriodElapsedGasOffset = newNotifyWalletClosingPeriodElapsedGasOffset;
        defeatFraudChallengeGasOffset = newDefeatFraudChallengeGasOffset;
        defeatFraudChallengeWithHeartbeatGasOffset = newDefeatFraudChallengeWithHeartbeatGasOffset;

        emit GasOffsetParametersUpdated(
            submitDepositSweepProofGasOffset,
            submitRedemptionProofGasOffset,
            resetMovingFundsTimeoutGasOffset,
            submitMovingFundsProofGasOffset,
            notifyMovingFundsBelowDustGasOffset,
            submitMovedFundsSweepProofGasOffset,
            requestNewWalletGasOffset,
            notifyWalletCloseableGasOffset,
            notifyWalletClosingPeriodElapsedGasOffset,
            defeatFraudChallengeGasOffset,
            defeatFraudChallengeWithHeartbeatGasOffset
        );
    }

    /// @notice Gets an entire array of wallet maintainer addresses.
    function allWalletMaintainers() external view returns (address[] memory) {
        return walletMaintainers;
    }

    /// @notice Gets an entire array of SPV maintainer addresses.
    function allSpvMaintainers() external view returns (address[] memory) {
        return spvMaintainers;
    }
}
