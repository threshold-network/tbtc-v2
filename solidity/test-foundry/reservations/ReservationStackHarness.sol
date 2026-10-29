// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@keep-network/random-beacon/contracts/Governable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

import {Bank} from "../../contracts/bank/Bank.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Bridge} from "../../contracts/bridge/Bridge.sol";
import {BridgeState} from "../../contracts/bridge/BridgeState.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {ReservationProofs} from "../../contracts/bridge/ReservationProofs.sol";
import {ReservationRouter} from "../../contracts/bridge/ReservationRouter.sol";
import {WalletProposalValidator} from "../../contracts/bridge/WalletProposalValidator.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";
import {IReservationBridge} from "../../contracts/bridge/IReservationBridge.sol";
import {TBTC} from "../../contracts/token/TBTC.sol";
import {TBTCVault} from "../../contracts/vault/TBTCVault.sol";
import {ReservationVault} from "../../contracts/vault/ReservationVault.sol";
import {IReservationFeeFinancer} from "../../contracts/vault/IReservationFeeFinancer.sol";

/// @notice The harness for the reservation *surface* contracts the
///         accounting campaign never reaches: the `ReservationVault`, the
///         `ReservationRouter` and the `WalletProposalValidator`.
/// @dev The storage layout is the point of this contract. It inherits
///      `Governable` and `Initializable` in the same order as `Bridge` and
///      `ReservationRouter` do, and declares the single
///      `BridgeState.Storage internal self` variable as its only storage,
///      so the anchor lands in the same slot (51) in all three contracts.
///      The router is then reached the way production reaches it: the
///      harness's fallback `delegatecall`s the router, so the router's code
///      executes on the harness's storage, with the harness's governance and
///      the harness's SPV-maintainer set. That is the production model of
///      the Bridge's own fallback, and it is the only way the router can
///      act on the reservation records the harness writes.
///
///      The vault stack (`Bank`, `TBTC`, `TBTCVault`, `ReservationVault`) is
///      the production one, wired so the harness is the Bank's Bridge and
///      the vault's trusted Bridge caller. The validator is the production
///      contract pointed at the harness, so it reads the same reservation
///      records.
contract ReservationStackHarness is Governable, Initializable {
    uint256 private constant SATOSHI_MULTIPLIER = 1e10;
    using BTCUtils for bytes;
    using BitcoinTx for BridgeState.Storage;
    using Reservation for BridgeState.Storage;
    using ReservationProofs for BridgeState.Storage;

    // Mirror of the Bridge's storage anchor. `Governable` contributes slots
    // 0-49 (governance + gap) and `Initializable` the following slot, so
    // `self` starts at the same slot as in the Bridge. See the Bridge's
    // storage-layout parity test for the same invariant.
    BridgeState.Storage internal self;

    Bank public immutable bank;
    TBTC public immutable tbtcToken;
    TBTCVault public immutable tbtcVault;
    ReservationVault public immutable reservationVault;
    ReservationRouter public immutable router;
    WalletProposalValidator public immutable validator;

    /// @dev The reveal-time facts the `WalletProposalValidator` needs to
    ///      re-derive a deposit's script. Kept per deposit key so the
    ///      validator's `validateDepositExtraInfo` check can pass.
    struct DepositFixture {
        BitcoinTx.Info fundingTx;
        bytes8 blindingFactor;
        bytes20 walletPubKeyHash;
        bytes20 refundPubKeyHash;
        bytes4 refundLocktime;
        bool present;
    }

    mapping(uint256 => DepositFixture) public depositFixtures;

    /// @dev Pool-deposit slot => its (non-reserved) deposit key, once
    ///      revealed. See `revealOrGetPoolDeposit`.
    mapping(uint8 => uint256) public poolDepositKey;

    /// @dev The handler that deployed this harness. The setup entry points
    ///      are deployer-only so the fuzzer cannot reach an ungated copy of a
    ///      router mutator: every post-deployment parameter change goes
    ///      through the router's own governance gate.
    address public immutable deployer;

    modifier onlyDeployer() {
        require(msg.sender == deployer, "Caller is not the deployer");
        _;
    }

    constructor() {
        deployer = msg.sender;
        Bank newBank = new Bank();
        newBank.updateBridge(address(this));
        bank = newBank;

        tbtcToken = new TBTC();
        tbtcVault = new TBTCVault(newBank, tbtcToken, Bridge(address(this)));
        tbtcToken.transferOwnership(address(tbtcVault));

        reservationVault = new ReservationVault(
            newBank,
            tbtcVault,
            IReservationBridge(address(this))
        );

        router = new ReservationRouter();
        validator = new WalletProposalValidator(Bridge(address(this)));

        // The reservation vault the deposits are revealed to, and the
        // trust flag that routes an acceptance credit through the vault
        // instead of straight to the depositor's Bank balance.
        self.bank = newBank;
        self.reservationVault = address(reservationVault);
        self.isVaultTrusted[address(reservationVault)] = true;
        self.treasury = address(this);
        // The deposit parameters the sweep validator reads: the deployment
        // values of `deploy/` (`DEPOSIT_TX_MAX_FEE` is what bounds a sweep
        // proposal's fee).
        self.depositDustThreshold = 10_000;
        self.depositTreasuryFeeDivisor = 2000;
        self.depositTxMaxFee = 1_000;
        self.depositRevealAheadPeriod = 1 days;

        // The harness is the router's governance.
        _transferGovernance(address(this));
    }

    // ---------------------------------------------------------------------
    // Bridge fallback: the production route into the router
    // ---------------------------------------------------------------------

    /// @dev Mirrors `Bridge.fallback`: unmatched selectors are
    ///      `delegatecall`ed to the router, so the router's code runs on
    ///      this contract's storage. The revert reason is bubbled up.
    // solhint-disable-next-line no-complex-fallback
    fallback() external {
        (bool success, bytes memory result) = address(router).delegatecall(
            msg.data
        );
        if (!success) {
            /* solhint-disable-next-line no-inline-assembly */
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }
        /* solhint-disable-next-line no-inline-assembly */
        assembly {
            returndatacopy(0, 0, returndatasize())
            return(0, returndatasize())
        }
    }

    /// @dev Marks an address as a trusted SPV maintainer, so the
    ///      `onlySpvMaintainer` modifier on the router's proof entry
    ///      points accepts it.
    function setSpvMaintainer(address maintainer, bool trusted) external {
        self.isSpvMaintainer[maintainer] = trusted;
    }

    // ---------------------------------------------------------------------
    // The Bridge view surface the `WalletProposalValidator` reads
    // ---------------------------------------------------------------------

    function deposits(
        uint256 depositKey
    ) external view returns (Deposit.DepositRequest memory) {
        return self.deposits[depositKey];
    }

    function wallets(
        bytes20 walletPubKeyHash
    ) external view returns (Wallets.Wallet memory) {
        return self.registeredWallets[walletPubKeyHash];
    }

    function isReservedDeposit(
        uint256 depositKey
    ) external view returns (bool) {
        return self.pendingReservedDeposit[depositKey].isReserved;
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
        return (
            self.depositDustThreshold,
            self.depositTreasuryFeeDivisor,
            self.depositTxMaxFee,
            self.depositRevealAheadPeriod
        );
    }

    function treasury() external view returns (address) {
        return self.treasury;
    }

    /// @dev The reservation position record. Named `reservationRecord` rather
    ///      than `reservations` on purpose: the harness must NOT declare a
    ///      selector the router also declares, because the fallback only
    ///      sees unmatched calls. Declaring `reservations`,
    ///      `reservationActions` or `reservationParameters` here would shadow
    ///      the router's own getters forever, and those getters are part of
    ///      the surface the campaign has to reach.
    function reservationRecord(
        uint256 reservationKey
    ) external view returns (Reservation.ReservationRequest memory) {
        return self.reservations[reservationKey];
    }

    /// @dev See `reservationRecord` for why this is not `reservationActions`.
    function reservationActionRecord(
        uint256 reservationKey,
        uint64 requestNonce
    ) external view returns (Reservation.ReservationAction memory) {
        return
            self.reservationActions[
                Reservation.actionKey(reservationKey, requestNonce)
            ];
    }

    // ---------------------------------------------------------------------
    // Vault operations
    // ---------------------------------------------------------------------

    /// @dev The production credit path: the Bank credits the vault and
    ///      calls `receiveBalanceIncrease`, which mints the gross amount
    ///      and forwards it to the depositor minus the initiation fee.
    function creditVault(address depositor, uint64 amountSat) external {
        address[] memory depositors = new address[](1);
        depositors[0] = depositor;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amountSat;
        bank.increaseBalanceAndCall(
            address(reservationVault),
            depositors,
            amounts
        );
    }

    /// @dev The same production credit path with an empty depositor list.
    ///      The Bank forwards the empty arrays unchanged, so the vault's own
    ///      `No depositors specified` guard is the one that answers. The
    ///      Bank rejects a zero-length credit before it calls, so a credit
    ///      of one satoshi funds the call and an empty list of depositors is
    ///      what reaches the vault.
    function creditVaultEmpty(uint64 amountSat) external {
        address[] memory depositors = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        bank.increaseBalanceAndCall(
            address(reservationVault),
            depositors,
            amounts
        );
    }

    /// @dev The harness is the vault's trusted Bridge caller, so this is
    ///      the same call the Bridge makes when it finances an in-kind
    ///      miner fee at a re-anchor settlement.
    function financeInKindFee(uint64 feeSat) external {
        reservationVault.financeInKindFee(feeSat);
    }

    /// @dev Pays outstanding in-kind fee debt with the harness's own TBTC.
    ///      The vault pulls the TBTC from its caller, so the harness has to
    ///      approve it first, exactly as any repayer would.
    function repayInKindFeeDebt(uint64 amountSat) external {
        tbtcToken.approve(
            address(reservationVault),
            uint256(amountSat) * SATOSHI_MULTIPLIER
        );
        reservationVault.repayInKindFeeDebt(amountSat);
    }

    /// @dev Sweeps the fee revenue above the reserve target to the
    ///      recipient.
    function sweepFees(address recipient) external {
        reservationVault.sweepFees(recipient);
    }

    function updateFeeReserveTarget(uint256 feeReserveTarget) external {
        reservationVault.updateFeeReserveTarget(feeReserveTarget);
    }

    function updateInitiationFee(uint16 initiationFeeBps) external {
        reservationVault.updateInitiationFee(initiationFeeBps);
    }

    // ---------------------------------------------------------------------
    // Reservation state setup
    // ---------------------------------------------------------------------

    function registerLiveWallet(bytes20 walletPubKeyHash) external {
        self.registeredWallets[walletPubKeyHash].state = Wallets
            .WalletState
            .Live;
        self.liveWalletsCount += 1;
    }

    function setWalletState(
        bytes20 walletPubKeyHash,
        Wallets.WalletState newState
    ) external {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        if (
            wallet.state == Wallets.WalletState.Live &&
            newState != Wallets.WalletState.Live
        ) {
            self.liveWalletsCount -= 1;
        }
        wallet.state = newState;
    }

    /// @dev Reveals a reserved deposit together with the reveal-time facts
    ///      the validator needs: a real Bitcoin funding transaction whose
    ///      single output pays a P2SH script that the validator's
    ///      `validateDepositExtraInfo` re-derives from those same facts.
    ///      The deposit key is derived from the funding transaction's hash,
    ///      exactly as `Deposit.revealDeposit` derives it.
    function revealReservedDeposit(
        address depositor,
        bytes20 walletPubKeyHash,
        bytes8 blindingFactor,
        bytes20 refundPubKeyHash,
        uint32 refundLocktime,
        uint64 amount,
        uint32 refundDeadline
    ) external returns (uint256 depositKey) {
        return
            _revealDeposit(
                depositor,
                walletPubKeyHash,
                blindingFactor,
                refundPubKeyHash,
                refundLocktime,
                amount,
                refundDeadline,
                true
            );
    }

    /// @dev Reveals a deposit that is NOT reserved: it is routed to no vault
    ///      and carries no pending-reserved record, which is what an ordinary
    ///      deposit sweep proposal must see. The fixture is recorded the same
    ///      way, so the validator can still re-derive the deposit's script.
    function revealPoolDeposit(
        address depositor,
        bytes20 walletPubKeyHash,
        bytes8 blindingFactor,
        bytes20 refundPubKeyHash,
        uint32 refundLocktime,
        uint64 amount
    ) external returns (uint256 depositKey) {
        return
            _revealDeposit(
                depositor,
                walletPubKeyHash,
                blindingFactor,
                refundPubKeyHash,
                refundLocktime,
                amount,
                0,
                false
            );
    }

    function _revealDeposit(
        address depositor,
        bytes20 walletPubKeyHash,
        bytes8 blindingFactor,
        bytes20 refundPubKeyHash,
        uint32 refundLocktime,
        uint64 amount,
        uint32 refundDeadline,
        bool reserved
    ) internal returns (uint256 depositKey) {
        BitcoinTx.Info memory fundingTx = buildFundingTx(
            depositor,
            walletPubKeyHash,
            refundPubKeyHash,
            refundLocktime,
            blindingFactor,
            amount
        );
        bytes32 fundingTxHash = abi
            .encodePacked(
                fundingTx.version,
                fundingTx.inputVector,
                fundingTx.outputVector,
                fundingTx.locktime
            )
            .hash256View();

        depositKey = uint256(
            keccak256(abi.encodePacked(fundingTxHash, uint32(0)))
        );
        require(
            self.deposits[depositKey].revealedAt == 0,
            "Deposit already revealed"
        );

        self.deposits[depositKey] = Deposit.DepositRequest({
            depositor: depositor,
            amount: amount,
            /* solhint-disable-next-line not-rely-on-time */
            revealedAt: uint32(block.timestamp),
            vault: reserved ? address(reservationVault) : address(0),
            treasuryFee: 0,
            sweptAt: 0,
            extraData: bytes32(0)
        });
        if (reserved) {
            self.pendingReservedDeposit[depositKey] = BridgeState
                .PendingReservedDeposit({
                    isReserved: true,
                    walletPubKeyHash: walletPubKeyHash,
                    refundDeadline: refundDeadline,
                    refundDeadlineValidated: true
                });
            self.pendingReservedDeposits += 1;
        }
        self.reservations[depositKey].owner = depositor;

        depositFixtures[depositKey] = DepositFixture({
            fundingTx: fundingTx,
            blindingFactor: blindingFactor,
            walletPubKeyHash: walletPubKeyHash,
            refundPubKeyHash: refundPubKeyHash,
            refundLocktime: bytes4(BTCUtils.reverseUint32(refundLocktime)),
            present: true
        });
    }

    /// @dev Idempotent pool-deposit fixture: each of the eight slots owns
    ///      one non-reserved deposit with a recorded reveal fixture,
    ///      revealed on first use. The depositor, blinding factor and refund
    ///      key are derived from the slot, so the funding transactions never
    ///      collide while the number of pool deposits stays bounded.
    function revealOrGetPoolDeposit(
        uint8 slot,
        bytes20 walletPubKeyHash,
        uint64 amount
    ) external returns (uint256 depositKey) {
        slot = slot % 8;
        depositKey = poolDepositKey[slot];
        if (depositKey != 0) {
            return depositKey;
        }
        depositKey = _revealDeposit(
            address(uint160(0xF00D0000 + slot)),
            walletPubKeyHash,
            bytes8(uint64(0xB1000000 + slot)),
            bytes20(uint160(0xBEEF0000 + slot)),
            /* solhint-disable-next-line not-rely-on-time */
            uint32(block.timestamp + 90 days),
            amount,
            0,
            false
        );
        poolDepositKey[slot] = depositKey;
    }

    /// @dev Marks a deposit swept, which is what a settled sweep or an
    ///      acceptance leaves behind. Used to reach the validator's
    ///      "Deposit already swept" rule.
    function markDepositSwept(uint256 depositKey) external {
        self.deposits[depositKey].sweptAt = uint32(block.timestamp);
    }

    /// @dev The reveal-time facts, for the validator's proposal.
    function depositFixture(
        uint256 depositKey
    )
        external
        view
        returns (
            BitcoinTx.Info memory fundingTx,
            bytes8 blindingFactor,
            bytes20 walletPubKeyHash,
            bytes20 refundPubKeyHash,
            bytes4 refundLocktime
        )
    {
        DepositFixture storage f = depositFixtures[depositKey];
        return (
            f.fundingTx,
            f.blindingFactor,
            f.walletPubKeyHash,
            f.refundPubKeyHash,
            f.refundLocktime
        );
    }

    /// @dev The funding transaction hash of a revealed deposit.
    function fundingTxHash(uint256 depositKey) external view returns (bytes32) {
        DepositFixture storage f = depositFixtures[depositKey];
        return
            abi
                .encodePacked(
                    f.fundingTx.version,
                    f.fundingTx.inputVector,
                    f.fundingTx.outputVector,
                    f.fundingTx.locktime
                )
                .hash256View();
    }

    // ---------------------------------------------------------------------
    // Production library entry points
    // ---------------------------------------------------------------------

    /// @dev Deploy-time setup only.
    function setupReservationCaps(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations,
        uint32 maxThirdPartyReanchorHoldsPerWallet,
        uint32 handoffReserveWallets
    ) external onlyDeployer {
        Reservation.updateReservationCaps(
            self,
            maxReservationsAmountPerWallet,
            reservationMaxSingleAmount,
            maxActiveReservations,
            maxThirdPartyReanchorHoldsPerWallet,
            handoffReserveWallets
        );
    }

    function setupReservationParameters(
        address vaultAddress,
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationDissolutionDelay,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint32 reservationActionTimeout,
        uint32 reservationRenewalWindowSeconds
    ) external onlyDeployer {
        Reservation.updateReservationParameters(
            self,
            vaultAddress,
            reservationMinAmount,
            reservationTxMaxFee,
            reservationTermSeconds,
            reservationDissolutionDelay,
            reservationMaxTotalAmount,
            maxReservationsPerWallet,
            reservationActionTimeout,
            reservationRenewalWindowSeconds
        );
    }

    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external {
        Reservation.requestReservationAcceptance(
            self,
            reservationKey,
            walletPubKeyHash
        );
    }

    function requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash,
        bool privileged
    ) external {
        Reservation.requestReservationReanchor(
            self,
            reservationKey,
            targetWalletPubKeyHash,
            privileged,
            new uint32[](0),
            0
        );
    }

    /// @dev Funds the vault's Bank balance without minting TBTC, so the burn
    ///      path in `_burnFromReserve` has a Bank side to decrease.
    ///      `receiveBalanceIncrease` moves the whole Bank credit into the
    ///      TBTC vault, so after a credit the vault holds the retained fee in
    ///      TBTC and nothing in the Bank.
    function fundVaultBank(uint64 amountSat) external {
        bank.increaseBalance(address(reservationVault), amountSat);
    }

    /// @dev Routes a call through the production fallback into the router.
    ///      Only selectors the harness does not declare reach the router,
    ///      exactly as in the Bridge.
    function callRouter(bytes memory data) external returns (bool ok) {
        (ok, ) = address(this).call(data);
    }

    /// @dev `callRouter` that bubbles the router's revert reason, so a test
    ///      can assert on it.
    function callRouterStrict(
        bytes memory data
    ) external returns (bytes memory) {
        (bool ok, bytes memory result) = address(this).call(data);
        if (!ok) {
            /* solhint-disable-next-line no-inline-assembly */
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }
        return result;
    }

    // ---------------------------------------------------------------------
    // Storage probes: the same slots the router's views read, so a router
    // view that disagrees with these is reading a different slot.
    // ---------------------------------------------------------------------

    function reservationVaultAddress() external view returns (address) {
        return self.reservationVault;
    }

    function pendingReservedDepositsProbe() external view returns (uint64) {
        return self.pendingReservedDeposits;
    }

    function activeReservationsCountProbe() external view returns (uint32) {
        return self.activeReservationsCount;
    }

    function reservationCapsProbe()
        external
        view
        returns (
            uint64 maxReservationsAmountPerWallet,
            uint64 reservationMaxSingleAmount,
            uint32 maxActiveReservations,
            uint32 maxThirdPartyReanchorHoldsPerWallet
        )
    {
        return (
            self.maxReservationsAmountPerWallet,
            self.reservationMaxSingleAmount,
            self.maxActiveReservations,
            self.maxThirdPartyReanchorHoldsPerWallet
        );
    }

    function walletState(
        bytes20 walletPubKeyHash
    ) external view returns (Wallets.WalletState) {
        return self.registeredWallets[walletPubKeyHash].state;
    }

    function depositRevealedAt(
        uint256 depositKey
    ) external view returns (uint32) {
        return self.deposits[depositKey].revealedAt;
    }

    function walletReservationInfoProbe(
        bytes20 walletPubKeyHash
    ) external view returns (uint32 count, uint64 amount) {
        return (
            self.walletReservationInfo[walletPubKeyHash].count,
            self.walletReservationInfo[walletPubKeyHash].amount
        );
    }

    function reservedDepositWalletProbe(
        uint256 depositKey
    ) external view returns (bytes20) {
        return self.pendingReservedDeposit[depositKey].walletPubKeyHash;
    }

    function isReservedDepositProbe(
        uint256 depositKey
    ) external view returns (bool) {
        return self.pendingReservedDeposit[depositKey].isReserved;
    }

    // ---------------------------------------------------------------------
    // Proof settlement without the SPV check
    // ---------------------------------------------------------------------

    /// @dev Body of `ReservationProofs.submitReservationAcceptanceProof`
    ///      with `validateProof` replaced by the given transaction hash.
    function proveAcceptance(
        uint256 reservationKey,
        uint64 requestNonce,
        bytes32 anchorTxHash,
        uint64 anchorAmount
    ) external returns (bool late) {
        Reservation.ReservationAction storage action;
        (action, late) = ReservationProofs.loadSettleableAction(
            self,
            reservationKey,
            requestNonce,
            Reservation.ActionType.Acceptance
        );
        require(
            self.reservations[reservationKey].state ==
                Reservation.ReservationState.Unknown,
            "Reservation already exists"
        );
        require(
            self.pendingReservedDeposit[reservationKey].isReserved,
            "Deposit was not revealed as reserved"
        );

        ReservationProofs.consumeAcceptedDeposit(
            self,
            singleInputVector(this.fundingTxHash(reservationKey), 0),
            reservationKey
        );
        uint64 provenAmount = ReservationProofs.validateAnchorOutput(
            self,
            singleP2WPKHOutputVector(
                anchorAmount,
                action.targetWalletPubKeyHash
            ),
            action
        );
        ReservationProofs.settleAcceptance(
            self,
            reservationKey,
            requestNonce,
            action,
            late,
            anchorTxHash,
            provenAmount
        );
    }

    /// @dev Body of `ReservationProofs.submitReservationReanchorProof` with
    ///      `validateProof` replaced by the given transaction hash. The
    ///      re-anchor settlement is the path that finances an in-kind miner
    ///      fee, so it is the path that reaches `ReservationVault` in
    ///      production: `IReservationFeeFinancer(vault).financeInKindFee` is
    ///      called on the real vault.
    function proveReanchor(
        uint256 reservationKey,
        uint64 requestNonce,
        bytes32 reanchorTxHash,
        uint64 newAnchorAmount
    ) external returns (bool late) {
        Reservation.ReservationAction storage action;
        (action, late) = ReservationProofs.loadSettleableAction(
            self,
            reservationKey,
            requestNonce,
            Reservation.ActionType.Reanchor
        );
        Reservation.ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        bool evidenceAlreadyEmitted =
            reservation.state == Reservation.ReservationState.Stranded;
        ReservationProofs.prepareReservationForSettlement(
            self,
            reservation,
            late
        );
        if (!late) {
            require(
                reservation.requestNonce == requestNonce,
                "Not the current generation"
            );
        }
        ReservationProofs.requireCurrentSourceAnchor(reservation, action);

        ReservationProofs.consumeAnchor(
            self,
            reservation,
            singleInputVector(
                reservation.anchorTxHash,
                reservation.anchorTxOutputIndex
            )
        );

        (
            bytes20 newWalletPubKeyHash,
            uint64 provenAmount
        ) = validateReanchorOutput(action, newAnchorAmount);

        if (late) {
            self.walletReservationInfo[newWalletPubKeyHash].count += 1;
            self
                .walletReservationInfo[newWalletPubKeyHash]
                .amount += reservation.anchorAmount;
            if (
                reservation.state == Reservation.ReservationState.ActionPending
            ) {
                ReservationProofs.unwindPendingAction(
                    self,
                    reservation,
                    reservationKey,
                    true
                );
            }
        }

        uint64 minerFee = ReservationProofs.settleReanchorAccounting(
            self,
            reservation,
            reservationKey,
            newWalletPubKeyHash,
            provenAmount,
            reanchorTxHash
        );
        action.state = Reservation.ActionState.Settled;
        if (!late) {
            Reservation.releaseThirdPartyReanchorHold(
                self,
                action.targetWalletPubKeyHash,
                action.thirdPartyHold
            );
        }
        ReservationProofs.strandLateSettlementIfTargetWalletClosed(
            self,
            reservation,
            reservationKey,
            evidenceAlreadyEmitted
        );
        if (minerFee > 0) {
            IReservationFeeFinancer(self.deposits[reservationKey].vault)
                .financeInKindFee(minerFee);
        }
    }

    /// @dev The output checks of `submitReservationReanchorProof`.
    function validateReanchorOutput(
        Reservation.ReservationAction storage action,
        uint64 newAnchorAmount
    ) internal view returns (bytes20 newWalletPubKeyHash, uint64 provenAmount) {
        bytes memory output = ReservationProofs.parseSingleOutput(
            singleP2WPKHOutputVector(
                newAnchorAmount,
                action.targetWalletPubKeyHash
            )
        );
        newWalletPubKeyHash = self.extractPubKeyHash(output);
        provenAmount = output.extractValue();

        require(
            newWalletPubKeyHash == action.targetWalletPubKeyHash,
            "Output must pay the authorized target wallet"
        );
        require(
            action.amount - provenAmount <= action.txMaxFee,
            "Transaction fee is too high"
        );
        require(
            provenAmount > action.txMaxFee,
            "Re-anchor amount below the dust floor"
        );
    }

    // ---------------------------------------------------------------------
    // Bitcoin vector builders
    // ---------------------------------------------------------------------

    /// @dev One input spending `txHash:outputIndex`, empty script, final
    ///      sequence. The outpoint index is little-endian on the wire.
    function singleInputVector(
        bytes32 txHash,
        uint32 outputIndex
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(1),
                txHash,
                BTCUtils.reverseUint32(outputIndex),
                uint8(0),
                uint32(0xffffffff)
            );
    }

    /// @dev One P2WPKH output with a little-endian 8-byte value.
    function singleP2WPKHOutputVector(
        uint64 value,
        bytes20 walletPubKeyHash
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(1),
                reverseUint64(value),
                hex"160014",
                walletPubKeyHash
            );
    }

    function reverseUint64(uint64 value) internal pure returns (uint64 r) {
        for (uint256 i = 0; i < 8; i++) {
            r = (r << 8) | (value & 0xff);
            value >>= 8;
        }
    }

    /// @dev Builds the funding transaction of a reserved deposit: one
    ///      input, one P2SH output paying the script the validator
    ///      re-derives from the same reveal-time facts.
    function buildFundingTx(
        address depositor,
        bytes20 walletPubKeyHash,
        bytes20 refundPubKeyHash,
        uint32 refundLocktime,
        bytes8 blindingFactor,
        uint64 amount
    ) internal view returns (BitcoinTx.Info memory fundingTx) {
        bytes memory script = expectedDepositScript(
            depositor,
            walletPubKeyHash,
            refundPubKeyHash,
            bytes4(BTCUtils.reverseUint32(refundLocktime)),
            blindingFactor
        );
        bytes memory outputVector = abi.encodePacked(
            uint8(1),
            reverseUint64(amount),
            hex"17a914",
            script.hash160View(),
            hex"87"
        );

        fundingTx.version = hex"01000000";
        fundingTx.inputVector = singleInputVector(
            keccak256(abi.encodePacked(depositor, walletPubKeyHash)),
            0
        );
        fundingTx.outputVector = outputVector;
        fundingTx.locktime = hex"00000000";
    }

    /// @dev The reveal script the `WalletProposalValidator` re-derives in
    ///      `validateDepositExtraInfo` for a deposit with no extra data.
    ///      Kept byte-for-byte in step with that function.
    function expectedDepositScript(
        address depositor,
        bytes20 walletPubKeyHash,
        bytes20 refundPubKeyHash,
        bytes4 refundLocktime,
        bytes8 blindingFactor
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                hex"14",
                depositor,
                hex"75",
                hex"08",
                blindingFactor,
                hex"75",
                hex"76",
                hex"a9",
                hex"14",
                walletPubKeyHash,
                hex"87",
                hex"63",
                hex"ac",
                hex"67",
                hex"76",
                hex"a9",
                hex"14",
                refundPubKeyHash,
                hex"88",
                hex"04",
                refundLocktime,
                hex"b1",
                hex"75",
                hex"ac",
                hex"68"
            );
    }
}
