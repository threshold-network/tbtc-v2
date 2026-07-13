// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";

import "../vault/ILegacyTBTCVaultMigrationCoordinator.sol";
import "../vault/IVault.sol";

/// @notice Minimal view of the mintable, `Ownable` TBTC token the sweep callback
///         drives. Mirrors the mainnet TBTC surface the legacy vault used: `mint`
///         is owner-gated, so a vault that no longer owns the token cannot mint.
interface IMintableOwnableToken {
    function mint(address account, uint256 amount) external;

    function owner() external view returns (address);

    function transferOwnership(address newOwner) external;
}

/// @notice Minimal view of the Bank's two sweep-routing entry points, mirroring
///         the trusted-vault (`increaseBalanceAndCall`, with callback) and
///         untrusted-vault (`increaseBalances`, no callback) branches of
///         `DepositSweep.submitDepositSweepProof`.
interface ISweepRoutingBank {
    function increaseBalances(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external;

    function increaseBalanceAndCall(
        address vault,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external;
}

/// @notice Minimal `Ownable` contract standing in for the TBTC token and for
///         successor vaults in legacy-retirement tests.
contract MockOwnableToken is Ownable {

}

/// @notice Minimal Bank stand-in exposing only the balance read and transfer the
///         legacy vault's `finalizeUpgrade` uses.
contract MockRetirementBank {
    mapping(address => uint256) public balances;

    function setBalance(address account, uint256 amount) external {
        balances[account] = amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function transferBalance(address recipient, uint256 amount) external {
        balances[msg.sender] -= amount;
        balances[recipient] += amount;
    }
}

/// @notice Faithful stand-in for the immutable mainnet legacy `TBTCVault`
///         surface the migration coordinator observes and drives: an `Ownable`
///         with pausable optimistic minting and the 24-hour-delayed
///         `initiateUpgrade`/`finalizeUpgrade` flow that moves TBTC ownership and
///         the Bank balance to the successor. It deliberately does NOT implement
///         `hasOutstandingOptimisticMintingDebt()`, matching the legacy vault
///         that predates that selector.
contract MockLegacyTBTCVault is Ownable {
    uint256 public constant UPGRADE_GOVERNANCE_DELAY = 24 hours;

    bool public isOptimisticMintingPaused;
    address public newVault;
    uint256 public upgradeInitiatedTimestamp;
    address public immutable tbtcToken;
    address public immutable bank;

    constructor(address _tbtcToken, address _bank) {
        tbtcToken = _tbtcToken;
        bank = _bank;
    }

    function setOptimisticMintingPaused(bool paused) external onlyOwner {
        isOptimisticMintingPaused = paused;
    }

    function initiateUpgrade(address _newVault) external onlyOwner {
        require(_newVault != address(0), "New vault address cannot be zero");
        newVault = _newVault;
        // solhint-disable-next-line not-rely-on-time
        upgradeInitiatedTimestamp = block.timestamp;
    }

    function finalizeUpgrade() external onlyOwner {
        require(upgradeInitiatedTimestamp != 0, "Upgrade not initiated");
        require(
            // solhint-disable-next-line not-rely-on-time
            block.timestamp - upgradeInitiatedTimestamp >=
                UPGRADE_GOVERNANCE_DELAY,
            "Governance delay has not elapsed"
        );

        address successor = newVault;
        Ownable(tbtcToken).transferOwnership(successor);
        if (bank != address(0)) {
            uint256 balance = MockRetirementBank(bank).balanceOf(address(this));
            MockRetirementBank(bank).transferBalance(successor, balance);
        }

        newVault = address(0);
        upgradeInitiatedTimestamp = 0;
    }
}

/// @notice Adversarial stand-in that returns fully controllable raw bytes (or
///         reverts) per selector. Used to prove the fail-closed exact-32-byte
///         staticcall helpers reject malformed responses: oversized
///         (`[value, junk]`), undersized (31 bytes), a non-boolean word, or a
///         dirty-high-bits address. Unconfigured selectors return empty data,
///         standing in for the "absent selector" case.
contract MockRawReturner {
    mapping(bytes4 => bytes) private rawResponse;
    mapping(bytes4 => bool) private selectorReverts;

    /// @notice Makes `selector` return exactly `data` (any length), unmodified.
    function setRawResponse(bytes4 selector, bytes calldata data) external {
        rawResponse[selector] = data;
        selectorReverts[selector] = false;
    }

    /// @notice Makes `selector` revert.
    function setSelectorReverts(bytes4 selector) external {
        selectorReverts[selector] = true;
    }

    // Returns the configured raw bytes verbatim so tests control the exact
    // returndatasize/contents the fail-closed helpers observe. Reads only, so it
    // is safe under the helpers' `staticcall`.
    // solhint-disable-next-line no-complex-fallback, payable-fallback
    fallback() external {
        bytes4 selector = msg.sig;
        require(!selectorReverts[selector], "MockRawReturner: reverting");
        bytes memory data = rawResponse[selector];
        // solhint-disable-next-line no-inline-assembly
        assembly {
            return(add(data, 0x20), mload(data))
        }
    }
}

/// @notice Settable stand-in for the Bridge reads the coordinator performs
///         during finalization (`isVaultTrusted` and the attestation getter).
contract MockRetirementBridge is ILegacyRetirementBridge {
    mapping(address => bool) public trusted;
    mapping(address => address) public coordinatorOf;

    function setVaultTrusted(address vault, bool isTrusted) external {
        trusted[vault] = isTrusted;
    }

    function setCoordinator(address vault, address coordinator) external {
        coordinatorOf[vault] = coordinator;
    }

    function isVaultTrusted(address vault)
        external
        view
        override
        returns (bool)
    {
        return trusted[vault];
    }

    function legacyVaultOptimisticMintingDebtCoordinator(address vault)
        external
        view
        override
        returns (address)
    {
        return coordinatorOf[vault];
    }
}

/// @notice Stand-in for the `BridgeGovernance` controller of the coordinator. It
///         exposes an `owner()` (the Council) and forwards the two mutating
///         calls, so tests can exercise the coordinator's `onlyController` guard
///         and its controller-owner checks.
contract MockCoordinatorController {
    address public owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function setOwner(address _owner) external {
        owner = _owner;
    }

    function initiateUpgrade(address coordinator, address successor) external {
        ILegacyTBTCVaultMigrationCoordinator(coordinator).initiateUpgrade(
            successor
        );
    }

    function finalizeUpgrade(address coordinator) external {
        ILegacyTBTCVaultMigrationCoordinator(coordinator).finalizeUpgrade();
    }
}

/// @notice Settable stand-in for the migration coordinator consumed by
///         `BridgeGovernance.initiateLegacyVaultUpgrade` and
///         `finalizeLegacyVaultMigration`. Records the calls it receives and can
///         be made to revert on `finalizeUpgrade` to prove atomic rollback.
contract MockMigrationCoordinator is ILegacyTBTCVaultMigrationCoordinator {
    address public override controller;
    address public override bridge;
    address public override legacyVault;
    address public override successorVault;
    bool public override migrationLocked;

    address public initiatedSuccessor;
    bool public initiateCalled;
    bool public finalizeCalled;
    bool public revertOnFinalize;

    constructor(
        address _controller,
        address _bridge,
        address _legacyVault,
        address _successorVault
    ) {
        controller = _controller;
        bridge = _bridge;
        legacyVault = _legacyVault;
        successorVault = _successorVault;
        migrationLocked = true;
    }

    function setBindings(
        address _controller,
        address _bridge,
        address _legacyVault,
        address _successorVault
    ) external {
        controller = _controller;
        bridge = _bridge;
        legacyVault = _legacyVault;
        successorVault = _successorVault;
    }

    function setRevertOnFinalize(bool value) external {
        revertOnFinalize = value;
    }

    function initiateUpgrade(address successor) external override {
        initiateCalled = true;
        initiatedSuccessor = successor;
        successorVault = successor;
    }

    function finalizeUpgrade() external override {
        require(!revertOnFinalize, "Coordinator finalize reverted");
        finalizeCalled = true;
    }
}

/// @notice Records the ordered Bridge calls that
///         `BridgeGovernance.finalizeLegacyVaultMigration` makes, so tests can
///         assert the exact five-step sequence and prove atomic rollback by
///         forcing any single step to revert. It implements only the Bridge
///         selectors that `BridgeGovernance` forwards.
contract MockOrchestrationBridge {
    enum Step {
        Attestation,
        UntrustLegacy,
        TrustSuccessor,
        SetMigrationDebtVault
    }

    // Bitmask of steps configured to revert.
    uint256 public revertMask;
    uint256[] public callOrder;

    // Recorded attestation arguments.
    address public attestedVault;
    address public attestedCoordinator;

    function setRevertOnStep(Step step, bool value) external {
        if (value) {
            revertMask |= (1 << uint256(step));
        } else {
            revertMask &= ~(1 << uint256(step));
        }
    }

    function _maybeRevert(Step step) private view {
        require(
            revertMask & (1 << uint256(step)) == 0,
            "Bridge step reverted"
        );
    }

    function callOrderLength() external view returns (uint256) {
        return callOrder.length;
    }

    function setLegacyVaultOptimisticMintingDebtAttestation(
        address vault,
        address coordinator,
        uint256,
        bytes32,
        bytes32
    ) external {
        _maybeRevert(Step.Attestation);
        attestedVault = vault;
        attestedCoordinator = coordinator;
        callOrder.push(uint256(Step.Attestation));
    }

    function setVaultStatus(address, bool isTrusted) external {
        if (isTrusted) {
            _maybeRevert(Step.TrustSuccessor);
            callOrder.push(uint256(Step.TrustSuccessor));
        } else {
            _maybeRevert(Step.UntrustLegacy);
            callOrder.push(uint256(Step.UntrustLegacy));
        }
    }

    function setMigrationDebtVault(address) external {
        _maybeRevert(Step.SetMigrationDebtVault);
        callOrder.push(uint256(Step.SetMigrationDebtVault));
    }
}

/// @notice Faithful stand-in for a TBTCVault-style vault's Bank sweep callback.
///         On `receiveBalanceIncrease` it repays the depositor's optimistic
///         minting debt first and then mints the remainder of TBTC — the exact
///         `repayOptimisticMintingDebt`-then-`_mint` core of
///         `TBTCVault.receiveBalanceIncrease` (migration debt is omitted because
///         it is irrelevant to the two retirement branches). Like the real vault
///         it ALWAYS routes through the owner-gated TBTC `mint`, so once the
///         token owner moves to a successor this vault can no longer mint and the
///         whole sweep callback reverts. Amounts are used as-is (the fixed
///         1e10 satoshi scaling is elided; it does not affect the branch logic).
contract MockLegacyMintingVault is IVault {
    address public immutable bank;
    address public immutable tbtcToken;
    mapping(address => uint256) public optimisticMintingDebt;

    constructor(address _bank, address _tbtcToken) {
        bank = _bank;
        tbtcToken = _tbtcToken;
    }

    /// @notice Seeds the depositor's finalized optimistic-minting debt, standing
    ///         in for an optimistic mint that was minted but not yet swept.
    function setOptimisticMintingDebt(address depositor, uint256 amount)
        external
    {
        optimisticMintingDebt[depositor] = amount;
    }

    /// @notice Hands the TBTC token ownership to `to`, standing in for the legacy
    ///         `finalizeUpgrade` that moves token ownership to the successor. This
    ///         vault must currently own the token.
    function transferTokenOwnership(address to) external {
        IMintableOwnableToken(tbtcToken).transferOwnership(to);
    }

    function receiveBalanceApproval(
        address,
        uint256,
        bytes calldata
    ) external override {}

    function receiveBalanceIncrease(
        address[] calldata depositors,
        uint256[] calldata depositedAmounts
    ) external override {
        require(msg.sender == bank, "Caller is not the Bank");
        require(
            depositors.length == depositedAmounts.length,
            "Arrays must have the same length"
        );
        for (uint256 i = 0; i < depositors.length; i++) {
            address depositor = depositors[i];
            uint256 amount = depositedAmounts[i];
            uint256 debt = optimisticMintingDebt[depositor];
            uint256 toMint;
            if (amount > debt) {
                optimisticMintingDebt[depositor] = 0;
                toMint = amount - debt;
            } else {
                optimisticMintingDebt[depositor] = debt - amount;
                toMint = 0;
            }
            // Mirror TBTCVault._mint: always route through the owner-gated TBTC
            // mint (even for a zero remainder), so a vault that no longer owns
            // the token bricks the sweep callback and reverts the proof tx.
            IMintableOwnableToken(tbtcToken).mint(depositor, toMint);
        }
    }
}

/// @notice Faithful stand-in for the `DepositSweep.submitDepositSweepProof` Bank
///         routing decision. Set as the Bank's `bridge`, its `route` reproduces
///         `DepositSweep.sol` exactly: a nonzero trusted vault takes the
///         `increaseBalanceAndCall` callback path (the vault repays optimistic
///         debt and mints), while a zero or untrusted vault takes the
///         `increaseBalances` no-callback path (depositor Bank balances are
///         credited with no optimistic-debt repayment).
contract MockSweepRouter {
    ISweepRoutingBank public immutable bank;
    mapping(address => bool) public isVaultTrusted;

    constructor(address _bank) {
        bank = ISweepRoutingBank(_bank);
    }

    function setVaultTrusted(address vault, bool trusted) external {
        isVaultTrusted[vault] = trusted;
    }

    function route(
        address vault,
        address[] calldata depositors,
        uint256[] calldata amounts
    ) external {
        if (vault != address(0) && isVaultTrusted[vault]) {
            // Trusted-vault branch: credit the vault and invoke its callback.
            bank.increaseBalanceAndCall(vault, depositors, amounts);
        } else {
            // Untrusted/zero-vault branch: credit depositor Bank balances with no
            // vault callback, so optimistic-minting debt is never repaid.
            bank.increaseBalances(depositors, amounts);
        }
    }
}
