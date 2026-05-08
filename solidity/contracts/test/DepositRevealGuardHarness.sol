// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BitcoinTx.sol";
import "../bridge/BridgeState.sol";
import "../bridge/Deposit.sol";
import "../bridge/MigrationExtraData.sol";
import "../bridge/Wallets.sol";

contract DepositRevealGuardHarness {
    using Deposit for BridgeState.Storage;

    BridgeState.Storage private self;

    constructor(uint64 depositDustThreshold_, uint32 depositRevealAheadPeriod_) {
        self.depositDustThreshold = depositDustThreshold_;
        self.depositRevealAheadPeriod = depositRevealAheadPeriod_;
    }

    function setWalletState(bytes20 walletPubKeyHash, Wallets.WalletState state)
        external
    {
        self.registeredWallets[walletPubKeyHash].state = state;
    }

    function setVaultStatus(address vault, bool isTrusted) external {
        self.isVaultTrusted[vault] = isTrusted;
    }

    function setMigrationDebtVault(address vault) external {
        self.migrationDebtVault = vault;
    }

    function setDepositDustThreshold(uint64 depositDustThreshold_) external {
        self.depositDustThreshold = depositDustThreshold_;
    }

    function setDepositRevealAheadPeriod(uint32 depositRevealAheadPeriod_)
        external
    {
        self.depositRevealAheadPeriod = depositRevealAheadPeriod_;
    }

    function revealDeposit(
        BitcoinTx.Info calldata fundingTx,
        Deposit.DepositRevealInfo calldata reveal
    ) external {
        self.revealDeposit(fundingTx, reveal);
    }

    function revealDepositWithExtraData(
        BitcoinTx.Info calldata fundingTx,
        Deposit.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
        self.revealDepositWithExtraData(fundingTx, reveal, extraData);
    }

    function getDeposit(uint256 depositKey)
        external
        view
        returns (Deposit.DepositRequest memory)
    {
        return self.deposits[depositKey];
    }

    function isMigrationReveal(bytes32 extraData)
        external
        pure
        returns (bool)
    {
        return MigrationExtraData.isMigrationReveal(extraData);
    }

    function decodeMigrationRevealer(bytes32 extraData)
        external
        pure
        returns (address)
    {
        return Deposit.decodeMigrationRevealer(extraData);
    }
}
