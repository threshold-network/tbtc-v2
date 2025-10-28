// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

import "../bridge/BitcoinTx.sol";
import "../bridge/Bridge.sol";
import "../bridge/MovingFunds.sol";
import "../bridge/Wallets.sol";
import "../bridge/ReservedDeposit.sol";

contract BridgeStub is Bridge {
    function setSweptDeposits(BitcoinTx.UTXO[] calldata utxos) external {
        for (uint256 i = 0; i < utxos.length; i++) {
            uint256 utxoKey = uint256(
                keccak256(
                    abi.encodePacked(utxos[i].txHash, utxos[i].txOutputIndex)
                )
            );
            self.deposits[utxoKey].sweptAt = 1641650400;
        }
    }

    function setSpentMainUtxos(BitcoinTx.UTXO[] calldata utxos) external {
        for (uint256 i = 0; i < utxos.length; i++) {
            uint256 utxoKey = uint256(
                keccak256(
                    abi.encodePacked(utxos[i].txHash, utxos[i].txOutputIndex)
                )
            );
            self.spentMainUTXOs[utxoKey] = true;
        }
    }

    function setProcessedMovedFundsSweepRequests(
        BitcoinTx.UTXO[] calldata utxos
    ) external {
        for (uint256 i = 0; i < utxos.length; i++) {
            uint256 utxoKey = uint256(
                keccak256(
                    abi.encodePacked(utxos[i].txHash, utxos[i].txOutputIndex)
                )
            );
            self.movedFundsSweepRequests[utxoKey].state = MovingFunds
                .MovedFundsSweepRequestState
                .Processed;
        }
    }

    function setActiveWallet(bytes20 activeWalletPubKeyHash) external {
        self.activeWalletPubKeyHash = activeWalletPubKeyHash;
    }

    function setWalletMainUtxo(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata utxo
    ) external {
        self.registeredWallets[walletPubKeyHash].mainUtxoHash = keccak256(
            abi.encodePacked(
                utxo.txHash,
                utxo.txOutputIndex,
                utxo.txOutputValue
            )
        );
    }

    function setWallet(bytes20 walletPubKeyHash, Wallets.Wallet calldata wallet)
        external
    {
        self.registeredWallets[walletPubKeyHash] = wallet;

        if (wallet.state == Wallets.WalletState.Live) {
            self.liveWalletsCount++;
        }
    }

    function setDepositDustThreshold(uint64 _depositDustThreshold) external {
        self.depositDustThreshold = _depositDustThreshold;
    }

    function setDepositTxMaxFee(uint64 _depositTxMaxFee) external {
        self.depositTxMaxFee = _depositTxMaxFee;
    }

    function setRedemptionDustThreshold(uint64 _redemptionDustThreshold)
        external
    {
        self.redemptionDustThreshold = _redemptionDustThreshold;
    }

    function setRedemptionTreasuryFeeDivisor(
        uint64 _redemptionTreasuryFeeDivisor
    ) external {
        self.redemptionTreasuryFeeDivisor = _redemptionTreasuryFeeDivisor;
    }

    function setPendingMovedFundsSweepRequest(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata utxo
    ) external {
        uint256 requestKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );

        self.movedFundsSweepRequests[requestKey] = MovingFunds
            .MovedFundsSweepRequest(
                walletPubKeyHash,
                utxo.txOutputValue,
                /* solhint-disable-next-line not-rely-on-time */
                uint32(block.timestamp),
                MovingFunds.MovedFundsSweepRequestState.Pending
            );

        self
            .registeredWallets[walletPubKeyHash]
            .pendingMovedFundsSweepRequestsCount++;
    }

    function processPendingMovedFundsSweepRequest(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata utxo
    ) external {
        uint256 requestKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );

        MovingFunds.MovedFundsSweepRequest storage request = self
            .movedFundsSweepRequests[requestKey];

        require(
            request.state == MovingFunds.MovedFundsSweepRequestState.Pending,
            "Stub sweep request must be in Pending state"
        );

        request.state = MovingFunds.MovedFundsSweepRequestState.Processed;

        self
            .registeredWallets[walletPubKeyHash]
            .pendingMovedFundsSweepRequestsCount--;
    }

    function timeoutPendingMovedFundsSweepRequest(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata utxo
    ) external {
        uint256 requestKey = uint256(
            keccak256(abi.encodePacked(utxo.txHash, utxo.txOutputIndex))
        );

        MovingFunds.MovedFundsSweepRequest storage request = self
            .movedFundsSweepRequests[requestKey];

        require(
            request.state == MovingFunds.MovedFundsSweepRequestState.Pending,
            "Stub sweep request must be in Pending state"
        );

        request.state = MovingFunds.MovedFundsSweepRequestState.TimedOut;

        self
            .registeredWallets[walletPubKeyHash]
            .pendingMovedFundsSweepRequestsCount--;
    }

    function setMovedFundsSweepTxMaxTotalFee(
        uint64 _movedFundsSweepTxMaxTotalFee
    ) external {
        self.movedFundsSweepTxMaxTotalFee = _movedFundsSweepTxMaxTotalFee;
    }

    function setDepositRevealAheadPeriod(uint32 _depositRevealAheadPeriod)
        external
    {
        self.depositRevealAheadPeriod = _depositRevealAheadPeriod;
    }

    function finalizeReservedDepositForTest(
        bytes32 utxoHash,
        uint256 depositTxFee
    ) external {
        BridgeState.ReservedDeposit storage reservation = self
            .reservedDeposits[utxoHash];

        require(reservation.depositor != address(0), "Not reserved");
        require(!reservation.isActive, "Reservation already active");

        uint256 mintBeforeFee = reservation.tbtcMinted;
        uint256 treasuryFee = reservation.treasuryFee;
        uint256 liquidationBonus = reservation.liquidationBonus;

        require(
            mintBeforeFee + treasuryFee + liquidationBonus ==
                reservation.btcAmount,
            "Reserved deposit invariant broken"
        );

        require(mintBeforeFee > depositTxFee, "Fees exceed mint amount");

        uint256 mintAmount = mintBeforeFee - depositTxFee;
        reservation.tbtcMinted = uint64(mintAmount);
        reservation.isActive = true;

        if (mintAmount > 0) {
            self.bank.increaseBalance(reservation.depositor, mintAmount);
        }

        if (treasuryFee > 0) {
            self.bank.increaseBalance(self.treasury, treasuryFee);
        }

        if (liquidationBonus > 0) {
            self.bank.increaseBalance(address(this), liquidationBonus);
        }
    }
}
