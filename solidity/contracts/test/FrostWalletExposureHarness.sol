// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "@keep-network/sortition-pools/contracts/SortitionPool.sol";

import "../frost-registry/libraries/FrostWalletExposure.sol";

/// @dev Test harness driving the externally linked `FrostWalletExposure`
///      library directly, mirroring how `FrostWalletRegistry` delegates to
///      it. Used to exercise the codeless-ledger guard: a ledger that
///      self-destructs after wiring must surface as a failed notification
///      (event + return) instead of a revert of the calling registry
///      function.
contract FrostWalletExposureHarness {
    using FrostWalletExposure for FrostWalletExposure.Data;

    FrostWalletExposure.Data internal data;
    mapping(address => address) internal operatorToStakingProvider;

    function setLedger(address _ledger) external {
        data.setLedger(_ledger);
    }

    function ledger() external view returns (address) {
        return address(data.ledger);
    }

    function notifyWalletRegistered(
        SortitionPool sortitionPool,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs
    ) external {
        data.notifyWalletRegistered(
            sortitionPool,
            operatorToStakingProvider,
            walletID,
            walletMembersIDs
        );
    }

    function notifyWalletClosed(bytes32 walletID) external {
        data.notifyWalletClosed(walletID);
    }
}

/// @dev Minimal contract used by `EphemeralLedgerInstaller`. Cancun's
///      EIP-6780 only removes code when selfdestruct runs in the same
///      transaction as contract creation.
contract SelfDestructingLedgerStub {
    function destroy() external {
        selfdestruct(payable(msg.sender));
    }
}

/// @dev Creates, wires, and destroys a ledger stub in one transaction. This
///      produces a genuinely codeless wired address on both pre- and
///      post-Cancun EVMs without changing the production hardfork setting.
contract EphemeralLedgerInstaller {
    address public lastLedger;

    function wireAndDestroy(FrostWalletExposureHarness harness) external {
        SelfDestructingLedgerStub ledger = new SelfDestructingLedgerStub();
        lastLedger = address(ledger);
        harness.setLedger(address(ledger));
        ledger.destroy();
    }
}
