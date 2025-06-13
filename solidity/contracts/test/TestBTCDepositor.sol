// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.0;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

import "../integrator/AbstractBTCDepositor.sol";
import "../integrator/IBridge.sol";
import "../integrator/ITBTCVault.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TestBTCDepositor is AbstractBTCDepositor {
    event InitializeDepositReturned(
        uint256 depositKey,
        uint256 initialDepositAmount
    );

    event FinalizeDepositReturned(
        uint256 initialDepositAmount,
        uint256 tbtcAmount,
        bytes32 extraData
    );

    function initialize(address _bridge, address _tbtcVault) external {
        __AbstractBTCDepositor_initialize(_bridge, _tbtcVault);
    }

    function initializeDepositPublic(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
        (uint256 depositKey, uint256 initialDepositAmount) = _initializeDeposit(
            fundingTx,
            reveal,
            extraData
        );
        emit InitializeDepositReturned(depositKey, initialDepositAmount);
    }

    function finalizeDepositPublic(uint256 depositKey) external {
        (
            uint256 initialDepositAmount,
            uint256 tbtcAmount,
            bytes32 extraData
        ) = _finalizeDeposit(depositKey);
        emit FinalizeDepositReturned(
            initialDepositAmount,
            tbtcAmount,
            extraData
        );
    }

    function calculateTbtcAmountPublic(
        uint64 depositAmountSat,
        uint64 depositTreasuryFeeSat
    ) external view returns (uint256) {
        return _calculateTbtcAmount(depositAmountSat, depositTreasuryFeeSat);
    }

    function minDepositAmountPublic() external view returns (uint256) {
        return _minDepositAmount();
    }
}

contract MockBridge is IBridge {
    using BTCUtils for bytes;

    mapping(uint256 => IBridgeTypes.DepositRequest) internal _deposits;
    mapping(uint256 => IBridgeTypes.RedemptionRequest)
        internal _pendingRedemptions;

    uint64 internal _depositDustThreshold = 1000000; // 1000000 satoshi = 0.01 BTC
    uint64 internal _depositTreasuryFeeDivisor = 50; // 1/50 == 100 bps == 2% == 0.02
    uint64 internal _depositTxMaxFee = 1000; // 1000 satoshi = 0.00001 BTC

    uint64 internal _redemptionDustThreshold = 50000; // 0.0005 BTC
    uint64 internal _redemptionTreasuryFeeDivisor = 200; // 0.5%
    uint64 internal _redemptionTxMaxFee = 10000; // 0.0001 BTC
    uint64 internal _redemptionTxMaxTotalFee = 50000; // 0.0005 BTC
    uint32 internal _redemptionTimeout = 6 * 3600; // 6 hours in seconds
    uint96 internal _redemptionTimeoutSlashingAmount = 10**18; // 1 TBTC with 18 decimals
    uint32 internal _redemptionTimeoutNotifierRewardMultiplier = 5; // 5%

    event DepositRevealed(uint256 depositKey);
    event RedemptionRequestedMock(
        bytes20 walletPubKeyHash,
        uint64 amount,
        bytes redeemerOutputScript,
        uint256 redemptionKey
    );

    function revealDepositWithExtraData(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
        bytes32 fundingTxHash = abi
            .encodePacked(
                fundingTx.version,
                fundingTx.inputVector,
                fundingTx.outputVector,
                fundingTx.locktime
            )
            .hash256View();

        uint256 depositKey = uint256(
            keccak256(
                abi.encodePacked(fundingTxHash, reveal.fundingOutputIndex)
            )
        );

        require(
            _deposits[depositKey].revealedAt == 0,
            "Deposit already revealed"
        );

        bytes memory fundingOutput = fundingTx
            .outputVector
            .extractOutputAtIndex(reveal.fundingOutputIndex);

        uint64 fundingOutputAmount = fundingOutput.extractValue();

        IBridgeTypes.DepositRequest memory request;

        request.depositor = msg.sender;
        request.amount = fundingOutputAmount;
        request.revealedAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        request.vault = reveal.vault;
        request.treasuryFee = _depositTreasuryFeeDivisor > 0
            ? fundingOutputAmount / _depositTreasuryFeeDivisor
            : 0;
        request.sweptAt = 0;
        request.extraData = extraData;

        _deposits[depositKey] = request;

        emit DepositRevealed(depositKey);
    }

    function sweepDeposit(uint256 depositKey) public {
        require(_deposits[depositKey].revealedAt != 0, "Deposit not revealed");
        require(_deposits[depositKey].sweptAt == 0, "Deposit already swept");
        _deposits[depositKey].sweptAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    function deposits(uint256 depositKey)
        external
        view
        returns (IBridgeTypes.DepositRequest memory)
    {
        return _deposits[depositKey];
    }

    function depositParameters()
        external
        view
        returns (
            uint64 depositDustThreshold,
            uint64 depositTreasuryFeeDivisor,
            uint64 depositTxMaxFee,
            uint32 depositRevealAheadPeriod
        )
    {
        depositDustThreshold = _depositDustThreshold;
        depositTreasuryFeeDivisor = _depositTreasuryFeeDivisor;
        depositTxMaxFee = _depositTxMaxFee;
        depositRevealAheadPeriod = 0;
    }

    function setDepositDustThreshold(uint64 value) external {
        _depositDustThreshold = value;
    }

    function setDepositTreasuryFeeDivisor(uint64 value) external {
        _depositTreasuryFeeDivisor = value;
    }

    function setDepositTxMaxFee(uint64 value) external {
        _depositTxMaxFee = value;
    }

    // --- Redemption related mock functions ---
    function requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata, /*mainUtxo*/
        bytes calldata redeemerOutputScript,
        uint64 amount
    ) external {
        bytes32 scriptHash = keccak256(redeemerOutputScript);
        uint256 redemptionKey;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(0, scriptHash)
            mstore(32, walletPubKeyHash)
            redemptionKey := keccak256(0, 52)
        }

        require(
            _pendingRedemptions[redemptionKey].requestedAt == 0,
            "Redemption already requested"
        );

        _pendingRedemptions[redemptionKey] = IBridgeTypes.RedemptionRequest({
            redeemer: msg.sender,
            requestedAmount: amount,
            treasuryFee: amount / _redemptionTreasuryFeeDivisor,
            txMaxFee: _redemptionTxMaxFee,
            requestedAt: uint32(block.timestamp) // solhint-disable-line not-rely-on-time
        });

        emit RedemptionRequestedMock(
            walletPubKeyHash,
            amount,
            redeemerOutputScript,
            redemptionKey
        );
    }

    function pendingRedemptions(uint256 redemptionKey)
        external
        view
        returns (IBridgeTypes.RedemptionRequest memory)
    {
        return _pendingRedemptions[redemptionKey];
    }

    function redemptionParameters()
        external
        view
        returns (
            uint64 redemptionDustThreshold,
            uint64 redemptionTreasuryFeeDivisor,
            uint64 redemptionTxMaxFee,
            uint64 redemptionTxMaxTotalFee,
            uint32 redemptionTimeout,
            uint96 redemptionTimeoutSlashingAmount,
            uint32 redemptionTimeoutNotifierRewardMultiplier
        )
    {
        redemptionDustThreshold = _redemptionDustThreshold;
        redemptionTreasuryFeeDivisor = _redemptionTreasuryFeeDivisor;
        redemptionTxMaxFee = _redemptionTxMaxFee;
        redemptionTxMaxTotalFee = _redemptionTxMaxTotalFee;
        redemptionTimeout = _redemptionTimeout;
        redemptionTimeoutSlashingAmount = _redemptionTimeoutSlashingAmount;
        redemptionTimeoutNotifierRewardMultiplier = _redemptionTimeoutNotifierRewardMultiplier;
    }
}

contract MockTBTCVault is ITBTCVault {
    struct Request {
        uint64 requestedAt;
        uint64 finalizedAt;
    }

    mapping(uint256 => Request) internal _requests;

    uint32 public optimisticMintingFeeDivisor = 100; // 1%

    function optimisticMintingRequests(uint256 depositKey)
        external
        returns (uint64 requestedAt, uint64 finalizedAt)
    {
        Request memory request = _requests[depositKey];
        return (request.requestedAt, request.finalizedAt);
    }

    /// @dev The function is virtual to allow other projects using this mock
    ///      for AbtractBTCDepositor-based contract tests to add any custom
    ///      logic needed.
    function createOptimisticMintingRequest(uint256 depositKey) public virtual {
        require(
            _requests[depositKey].requestedAt == 0,
            "Request already exists"
        );
        _requests[depositKey].requestedAt = uint64(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    /// @dev The function is virtual to allow other projects using this mock
    ///      for AbtractBTCDepositor-based contract tests to add any custom
    ///      logic needed.
    function finalizeOptimisticMintingRequest(uint256 depositKey)
        public
        virtual
    {
        require(
            _requests[depositKey].requestedAt != 0,
            "Request does not exist"
        );
        require(
            _requests[depositKey].finalizedAt == 0,
            "Request already finalized"
        );
        _requests[depositKey].finalizedAt = uint64(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    function setOptimisticMintingFeeDivisor(uint32 value) external {
        optimisticMintingFeeDivisor = value;
    }

    function tbtcToken() external view returns (address) {
        revert("Not implemented");
    }
}
