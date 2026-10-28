// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Directed test for the untrusted-vault credit branch of
// `submitReservationAcceptanceProof` (contracts/bridge/ReservationProofs.sol,
// credit routing at :620-625):
//
//   address vault = deposit.vault;
//   if (vault != address(0) && self.isVaultTrusted[vault]) {
//       self.bank.increaseBalanceAndCall(vault, depositors, amounts);
//   } else {
//       self.bank.increaseBalances(depositors, amounts);   // line 624
//   }
//
// The else branch is reachable and intended: governance can call
// `bridge.setVaultStatus(reservationVault, false)` (no timelock, no tie to
// reservation state) after a reserved reveal and before the acceptance proof.
// The proof then credits the depositor directly in the Bank, with no
// initiation fee (docs/RESERVATION_CAPS_DEPLOYMENT.md, "Fee Fallback When
// Vault Trust Is Revoked"). This file exists so that replacing line 624 with
// `revert();` fails a test.
//
// Governance path: `bridge.setVaultStatus` pranked as `governance`, the same
// call as `_bridge_setVaultStatus` in
// test/fizz/handlers/BridgeHandler.sol:669-671.
//
// Test 1 passes on the PR code and fails when line 624 reverts. Test 2 is the
// control: with trust intact the default branch runs and both tests pass on
// either code version.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract AcceptanceProofUntrustedVault is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    uint64 internal constant DEPOSIT_SAT = 50_000;
    /// @dev Miner fee of the anchor transaction; within the fizz suite's
    ///      reservation tx max fee of 1_000 sat (test/fizz/Base.sol).
    uint64 internal constant ANCHOR_FEE_SAT = 500;
    uint64 internal constant ANCHOR_SAT = DEPOSIT_SAT - ANCHOR_FEE_SAT;

    address internal depositor;
    bytes20 internal w0;

    function setUp() public {
        setup();
        depositor = makeAddr("acceptanceProofUntrustedVault.depositor");
        w0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        // setup() registers wallet 0, makes it the active wallet and trusts
        // the reservation vault.
        assertEq(bridge.activeWalletPubKeyHash(), w0, "w0 starts active");
        assertTrue(
            bridge.isVaultTrusted(address(reservationVault)),
            "reservation vault starts trusted"
        );
    }

    /// @notice Governance revokes the reservation vault's trust after the
    ///         reveal and the acceptance request. The proof succeeds and the
    ///         Bank credits the depositor the full anchor amount directly:
    ///         no vault, no mint, no initiation fee.
    function test_acceptanceProof_creditsDepositorDirectlyWhenVaultUntrusted()
        public
    {
        (
            uint256 key,
            BitcoinTx.Info memory fundingTx,
            uint32 outputIndex
        ) = _reveal(depositor, w0, DEPOSIT_SAT);
        uint64 nonce = _requestAcceptance(depositor, key, w0);

        vm.prank(governance);
        bridge.setVaultStatus(address(reservationVault), false);
        assertFalse(
            bridge.isVaultTrusted(address(reservationVault)),
            "vault trust is revoked"
        );

        uint256 depositorBankBefore = bank.balanceOf(depositor);
        uint256 depositorTbtcBefore = tbtc.balanceOf(depositor);
        uint256 vaultBankBefore = bank.balanceOf(address(reservationVault));
        uint256 supplyBefore = tbtc.totalSupply();

        _submitAcceptanceProof(fundingTx, outputIndex, key, nonce, w0);

        assertEq(
            bank.balanceOf(depositor),
            depositorBankBefore + ANCHOR_SAT,
            "depositor Bank balance rises by exactly the anchor amount"
        );
        assertEq(
            tbtc.balanceOf(depositor),
            depositorTbtcBefore,
            "depositor receives no TBTC"
        );
        assertEq(
            bank.balanceOf(address(reservationVault)),
            vaultBankBefore,
            "reservation vault Bank balance unchanged"
        );
        assertEq(
            tbtc.totalSupply(),
            supplyBefore,
            "TBTC total supply unchanged"
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "reservation is Active"
        );
    }

    /// @notice Control: same flow with trust intact. The Bank credits the
    ///         reservation vault, which mints TBTC to the depositor net of
    ///         the initiation fee. The depositor's Bank balance does not
    ///         rise, so test 1 observes the fallback branch and not the
    ///         default one.
    function test_acceptanceProof_routesThroughVaultWhenTrusted() public {
        (
            uint256 key,
            BitcoinTx.Info memory fundingTx,
            uint32 outputIndex
        ) = _reveal(depositor, w0, DEPOSIT_SAT);
        uint64 nonce = _requestAcceptance(depositor, key, w0);

        assertTrue(
            bridge.isVaultTrusted(address(reservationVault)),
            "vault is still trusted"
        );

        uint256 depositorBankBefore = bank.balanceOf(depositor);
        uint256 depositorTbtcBefore = tbtc.balanceOf(depositor);
        uint256 vaultBankBefore = bank.balanceOf(address(reservationVault));
        uint256 supplyBefore = tbtc.totalSupply();

        _submitAcceptanceProof(fundingTx, outputIndex, key, nonce, w0);

        uint256 grossTbtc = uint256(ANCHOR_SAT) * SATOSHI_MULTIPLIER;
        uint256 feeTbtc = (grossTbtc * reservationVault.initiationFeeBps()) /
            10_000;

        assertEq(
            bank.balanceOf(depositor),
            depositorBankBefore,
            "depositor Bank balance does not rise directly"
        );
        assertEq(
            tbtc.balanceOf(depositor),
            depositorTbtcBefore + grossTbtc - feeTbtc,
            "depositor receives TBTC net of the initiation fee"
        );
        assertEq(
            tbtc.totalSupply(),
            supplyBefore + grossTbtc,
            "TBTC was minted for the anchor amount"
        );
        assertEq(
            bank.balanceOf(address(reservationVault)),
            vaultBankBefore,
            "reservation vault passes its Bank credit on to the TBTC vault"
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "reservation is Active"
        );
    }

    // ------------------------------------------------------------------
    // Helpers (copied in reduced form from SP106PermissionlessMovingFunds)
    // ------------------------------------------------------------------

    uint256 internal salt;

    /// @dev Reveals a reserved deposit of `who` for `wallet`. The funding
    ///      transaction is fabricated: nothing is proven on Bitcoin.
    function _reveal(address who, bytes20 wallet, uint64 amount)
        internal
        returns (
            uint256 key,
            BitcoinTx.Info memory fundingTx,
            uint32 outputIndex
        )
    {
        uint256 s = ++salt;
        Deposit.DepositRevealInfo memory reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: 0,
            blindingFactor: bytes8(keccak256(abi.encode(s, "blinding"))),
            walletPubKeyHash: wallet,
            refundPubKeyHash: bytes20(
                keccak256(abi.encode(s, who, "refund"))
            ),
            refundLocktime: _le32(uint32(block.timestamp + 3 days)),
            vault: address(reservationVault)
        });
        (fundingTx, outputIndex) = BtcBuilder.depositFundingTx(
            reveal,
            who,
            bytes32(0),
            false,
            true,
            amount,
            keccak256(abi.encode("acceptanceProofUntrustedVault.funding", s))
        );
        key = uint256(
            keccak256(
                abi.encodePacked(BtcBuilder.txHash(fundingTx), outputIndex)
            )
        );
        vm.prank(who);
        bridge.revealDeposit(fundingTx, reveal);
    }

    function _requestAcceptance(address who, uint256 key, bytes20 wallet)
        internal
        returns (uint64 nonce)
    {
        vm.prank(who);
        reservationRouter.requestReservationAcceptance(key, wallet);
        nonce = reservationRouter.reservations(key).requestNonce;
    }

    /// @dev Builds the 1-in-1-out anchor transaction spending the deposit
    ///      funding output, proves it with a one-header SPV proof (the relay
    ///      difficulty is configured by `setup()`), and submits it as the
    ///      SPV maintainer.
    function _submitAcceptanceProof(
        BitcoinTx.Info memory fundingTx,
        uint32 outputIndex,
        uint256 key,
        uint64 nonce,
        bytes20 wallet
    ) internal {
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn({
            prevTxHash: BtcBuilder.txHash(fundingTx),
            prevOutIndex: outputIndex
        });
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut({
            value: ANCHOR_SAT,
            script: BtcBuilder.p2wpkh(wallet)
        });
        BitcoinTx.Info memory anchorTx = BtcBuilder.buildTx(ins, outs);
        BitcoinTx.Proof memory proof = BtcBuilder.prove(anchorTx, 1);

        vm.prank(spvMaintainer);
        reservationRouter.submitReservationAcceptanceProof(
            anchorTx,
            proof,
            key,
            nonce
        );
    }

    function _le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | (v >> 24)
            );
    }
}
