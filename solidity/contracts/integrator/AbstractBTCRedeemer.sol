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

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "./IBridge.sol";
import "./IBank.sol";
import "./BitcoinTx.sol";
import "./ITBTCVault.sol";

/// @title Abstract AbstractBTCRedeemer contract.
/// @notice This abstract contract is meant to facilitate integration of protocols
///         aiming to use tBTC as an underlying Bitcoin bridge for redemptions.
///
///         Such an integrator is supposed to:
///         - Create a child contract inheriting from this abstract contract
///         - Call the `__AbstractBTCRedeemer_initialize` initializer function
///         - Use the `_requestRedemption` as part of their
///           business logic in order to request and track redemptions.
///
/// @dev Example usage:
///      ```
///      // Example upgradeable integrator contract.
///      contract ExampleBTCIntegrator is AbstractBTCRedeemer, Initializable {
///          /// @custom:oz-upgrades-unsafe-allow constructor
///          constructor() {
///              // Prevents the contract from being initialized again.
///              _disableInitializers();
///          }
///
///          function initialize(
///              address _bridge,
///              address _tbtcToken
///          ) external initializer {
///              __AbstractBTCRedeemer_initialize(_bridge, _tbtcToken);
///          }
///
///          function startRedemptionProcess(
///              bytes20 walletPubKeyHash,
///              BitcoinTx.UTXO memory mainUtxo,
///              bytes calldata redemptionOutputScript,
///              uint64 amount
///          ) external {
///              (uint256 redemptionKey, uint256 tbtcAmount) = _requestRedemption(
///                  walletPubKeyHash,
///                  mainUtxo,
///                  redemptionOutputScript,
///                  amount
///              );
///
///              // Use the redemptionKey to track the process.
///              // Use tbtcAmount to know the expected Bitcoin amount to be received.
///          }
///      }
abstract contract AbstractBTCRedeemer is OwnableUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using BTCUtils for bytes;

    /// @notice Multiplier to convert satoshi to TBTC token units.
    uint256 public constant SATOSHI_MULTIPLIER = 10**10;

    /// @notice Bridge contract address.
    IBridge public thresholdBridge;
    /// @notice TBTC token contract address.
    IERC20Upgradeable public tbtcToken;
    /// @notice Bank contract address.
    IBank public bank;
    /// @notice TBTC vault contract address.
    ITBTCVault public tbtcVault;

    // Reserved storage space that allows adding more variables without affecting
    // the storage layout of the child contracts. The convention from OpenZeppelin
    // suggests the storage space should add up to 50 slots. If more variables are
    // added in the upcoming versions one need to reduce the array size accordingly.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[46] private __gap;

    /// @notice Initializes the contract. MUST BE CALLED from the child
    ///         contract initializer.
    // slither-disable-next-line dead-code
    function __AbstractBTCRedeemer_initialize(
        address _thresholdBridge,
        address _tbtcToken,
        address _bank,
        address _tbtcVault
    ) internal {
        require(
            address(thresholdBridge) == address(0) &&
                address(tbtcToken) == address(0) &&
                address(bank) == address(0),
            "AbstractBTCRedeemer already initialized"
        );

        require(
            _thresholdBridge != address(0),
            "Threshold Bridge address cannot be zero"
        );
        require(_tbtcToken != address(0), "TBTC token address cannot be zero");
        require(_bank != address(0), "Bank address cannot be zero");
        require(_tbtcVault != address(0), "TBTC vault address cannot be zero");

        thresholdBridge = IBridge(_thresholdBridge);
        tbtcToken = IERC20Upgradeable(_tbtcToken);
        bank = IBank(_bank);
        tbtcVault = ITBTCVault(_tbtcVault);
    }

    /// @notice Requests a redemption from the Bridge.
    /// @param walletPubKeyHash The 20-byte wallet public key hash to redeem from.
    /// @param mainUtxo The main UTXO of the specified wallet.
    /// @param redemptionOutputScript The Bitcoin output script where the BTC should be sent.
    /// @param amount The amount of tBTC (in satoshi equivalent) to redeem.
    /// @return redemptionKey Redemption key computed as
    ///         `keccak256(keccak256(redemptionOutputScript) | walletPubKeyHash)`. This
    ///         key can be used to refer to the redemption in the Bridge.
    /// @return tbtcAmount The net amount of Bitcoin (in tBTC token decimals precision)
    ///         expected to be received by the redeemer after fees.
    /// @dev Requirements:
    ///      - This contract (AbstractBTCRedeemer instance) must have `amount` in its Bank balance.
    ///      - This contract must have approved the `thresholdBridge` to spend `amount` of its Bank balance.
    ///      - All requirements from {Bridge#requestRedemption} must be met.
    // slither-disable-next-line dead-code
    function _requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO memory mainUtxo,
        bytes memory redemptionOutputScript,
        uint256 amount
    ) internal returns (uint256 redemptionKey, uint256 tbtcAmount) {
        // Reset approval to 0 and approve the TBTC vault to pull tBTC tokens from
        // this contract to proceed with unminting.
        tbtcToken.safeApprove(address(tbtcVault), 0);
        tbtcToken.safeApprove(address(tbtcVault), amount);
        // Unmint tBTC tokens. This burns the ERC-20 tokens and credits this
        // contract's balance in the Bank with the corresponding value in satoshis.
        tbtcVault.unmint(amount);

        // Convert the tBTC token amount (1e18 precision) to satoshis
        // (1e8 precision) for Bridge operations.
        uint64 amountInSatoshis = uint64(amount / SATOSHI_MULTIPLIER);

        // This contract (as balanceOwner) approves the Bridge to spend its Bank balance.
        // The amount for Bank allowance is in satoshi units (which is what `amount` already is).
        bank.increaseBalanceAllowance(
            address(thresholdBridge),
            amountInSatoshis
        );

        // This contract calls the Bridge. The Bridge will see `msg.sender` (this contract) as the `balanceOwner`.
        // The Bridge's internal Redemption logic will then call `bank.transferBalanceFrom(address(this), address(bridge_or_redemption_contract), amount)`.
        // The actual `balanceOwner` parameter for Bridge.requestRedemption might be `address(this)` if the Bridge function signature supports it,
        // or it might be implicitly msg.sender for the Bridge. Assuming msg.sender is balanceOwner for the Bridge call.
        thresholdBridge.requestRedemption(
            walletPubKeyHash,
            mainUtxo,
            redemptionOutputScript,
            amountInSatoshis
        );

        redemptionKey = _getRedemptionKey(
            walletPubKeyHash,
            redemptionOutputScript
        );

        IBridgeTypes.RedemptionRequest memory redemption = thresholdBridge
            .pendingRedemptions(redemptionKey);

        tbtcAmount = _calculateTbtcAmount(
            redemption.requestedAmount,
            redemption.treasuryFee
        );
    }

    /// @notice Calculates the net amount of Bitcoin the redeemer will receive.
    /// @param redemptionAmountSat Requested redemption amount in satoshi (1e8 precision).
    ///        This is the gross amount of tBTC the user wants to convert to BTC.
    /// @param redemptionTreasuryFeeSat Redemption treasury fee in satoshi (1e8 precision).
    ///        This is an accurate value of the treasury fee that was actually
    ///        charged for the redemption request.
    /// @return tbtcAmount Net amount of Bitcoin (in tBTC token decimals precision)
    ///         expected to be sent to the redeemer's Bitcoin address.
    /// @dev This function calculates the expected Bitcoin amount by subtracting
    ///      the treasury fee and the maximum Bitcoin transaction fee from the
    ///      requested redemption amount. The actual Bitcoin transaction fee might
    ///      be lower, but using the maximum ensures the user is aware of the
    ///      minimum BTC they will receive.
    // slither-disable-next-line dead-code
    function _calculateTbtcAmount(
        uint64 redemptionAmountSat,
        uint64 redemptionTreasuryFeeSat
    ) internal view virtual returns (uint256) {
        // Both redemption amount and treasury fee are in the 1e8 satoshi precision.
        // We need to convert them to the 1e18 TBTC precision.
        uint256 amountSubTreasury = (redemptionAmountSat -
            redemptionTreasuryFeeSat) * SATOSHI_MULTIPLIER;

        (, , uint64 redemptionTxMaxFee, , , , ) = thresholdBridge
            .redemptionParameters();

        uint256 txMaxFee = redemptionTxMaxFee * SATOSHI_MULTIPLIER;
        return amountSubTreasury - txMaxFee;
    }

    /// @notice Calculate redemption key without allocations.
    /// @param walletPubKeyHash the pubkey hash of the wallet.
    /// @param script the output script of the redemption.
    /// @return The key = keccak256(keccak256(script) | walletPubKeyHash).
    function _getRedemptionKey(bytes20 walletPubKeyHash, bytes memory script)
        internal
        pure
        returns (uint256)
    {
        bytes32 scriptHash = keccak256(script);
        uint256 key;
        /* solhint-disable-next-line no-inline-assembly */
        assembly {
            mstore(0, scriptHash)
            mstore(32, walletPubKeyHash)
            key := keccak256(0, 52)
        }
        return key;
    }

    /// @notice Allows the contract owner to recover tBTC tokens that may
    ///         remain stuck in this contract. This could happen if a redemption
    ///         fails or is canceled, leaving some tBTC behind.
    /// @param recipient The address that will receive the rescued tBTC tokens.
    /// @param amount The amount of tBTC (in 18 decimal precision) to transfer.
    function rescueTbtc(address recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "Cannot rescue to zero address");
        require(
            tbtcToken.balanceOf(address(this)) >= amount,
            "Insufficient tBTC token balance in contract"
        );

        tbtcToken.safeTransfer(recipient, amount);
    }
}
