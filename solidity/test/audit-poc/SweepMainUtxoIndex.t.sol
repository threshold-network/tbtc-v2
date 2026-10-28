// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression test for a mutation of `DepositSweep.processDepositSweepTxInputs`
// found by the slither-mutate pass of 2026-10-08 (operator LOR). Before this
// file no Foundry or Hardhat test killed it.
//
// Source lines (solidity/contracts/bridge/DepositSweep.sol:476-498): an input
// that is not a revealed deposit is accepted as the wallet's main UTXO only if
// the main UTXO is still expected AND its txid AND its output index match;
// otherwise the sweep reverts with "Unknown input type". The mutant
// `mainUtxoExpected != mainUtxoFound || txHash == outpointTxHash` drops the
// index check (and lets any input count as the main UTXO while it is still
// expected). Then an input that spends a different output of the main UTXO's
// transaction is counted as the main UTXO: its value is taken from the
// claimed main UTXO, and `spentMainUTXOs` marks the wrong outpoint.
//
// Flow on the fizz deployment (test/fizz/Base.sol): reveal and sweep once so
// the wallet has a main UTXO, reveal one more deposit, then prove a sweep whose
// second input is (main UTXO txid, main UTXO index + 1).

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";

contract SweepMainUtxoIndexTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    string internal constant ERR_UNKNOWN_INPUT = "Unknown input type";

    function setUp() public {
        setup();
    }

    /// @notice An input with the main UTXO's txid but another output index
    ///         is not the main UTXO; the sweep reverts.
    function test_sweep_rejectsMainUtxoTxidWithWrongIndex() public {
        (bridge_SweepPlan memory plan, BitcoinTx.Info memory sweepTx) =
            _sweepWithMainInput(1);
        // Build the proof before the prank: BtcBuilder calls the sha256
        // precompile, which would consume a pending vm.prank.
        BitcoinTx.Proof memory proof = _bridge_prove(sweepTx, 0);
        vm.prank(spvMaintainer);
        vm.expectRevert(bytes(ERR_UNKNOWN_INPUT));
        bridge.submitDepositSweepProof(sweepTx, proof, plan.main, plan.vault);
    }

    /// @notice Control: with the correct index the same sweep succeeds and
    ///         the wallet's main UTXO moves to the sweep output.
    function test_sweep_acceptsCorrectMainUtxo() public {
        (bridge_SweepPlan memory plan, BitcoinTx.Info memory sweepTx) =
            _sweepWithMainInput(0);
        BitcoinTx.Proof memory proof = _bridge_prove(sweepTx, 0);
        vm.prank(spvMaintainer);
        bridge.submitDepositSweepProof(sweepTx, proof, plan.main, plan.vault);
        bytes32 expected = keccak256(
            abi.encodePacked(
                BtcBuilder.txHash(sweepTx),
                uint32(0),
                uint64(plan.inputsTotal)
            )
        );
        assertEq(
            bridge.wallets(plan.wallet).mainUtxoHash,
            expected,
            "main UTXO is the sweep output"
        );
    }

    /// @dev Creates a main UTXO through one real sweep, reveals one more
    ///      deposit and builds a zero-fee sweep of it plus a "main UTXO"
    ///      input whose output index is `main index + indexOffset`.
    function _sweepWithMainInput(uint32 indexOffset)
        internal
        returns (bridge_SweepPlan memory plan, BitcoinTx.Info memory sweepTx)
    {
        // First deposit and sweep: gives wallet 0 a main UTXO.
        bridge_revealDeposit_clamped(0, 100_000, 1);
        bridge_submitDepositSweepProof_zeroFee(0, 0, 0);
        bytes20 wallet = harnessWallets[0];
        (bool hasMain, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(wallet);
        assertTrue(hasMain && main.txHash != bytes32(0), "wallet has a main UTXO");

        // Second deposit, then the plan for sweeping it with the main UTXO.
        bridge_revealDeposit_clamped(0, 100_000, 2);
        bool ok;
        (ok, plan) = _bridge_findSweep(0, 0);
        assertTrue(ok, "sweep plan found");
        assertEq(plan.wallet, wallet, "same wallet");
        assertEq(plan.picked.length, 1, "one unswept deposit");
        assertEq(plan.main.txHash, main.txHash, "plan uses the main UTXO");

        HarnessDeposit storage d = harnessDeposits[plan.picked[0]];
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](2);
        ins[0] = BtcBuilder.TxIn(d.fundingTxHash, d.outputIndex);
        ins[1] = BtcBuilder.TxIn(
            plan.main.txHash,
            plan.main.txOutputIndex + indexOffset
        );
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut(
            uint64(plan.inputsTotal),
            _bridge_scriptFor(wallet, 0)
        );
        sweepTx = BtcBuilder.buildTx(ins, outs);
    }
}
