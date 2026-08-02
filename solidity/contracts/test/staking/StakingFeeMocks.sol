// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../../staking/api/IRewardsDistributor.sol";

/// @dev Open-mint 18-decimal ERC-20 standing in for TBTC (and T) in staking
///      module unit tests.
contract StakingTestToken is ERC20 {
    constructor() ERC20("Test TBTC", "TestTBTC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mock of the Bank subset used by the FeeRouter. Mirrors the exact
///      semantics of `contracts/bank/Bank.sol`:
///      - `balanceOf` is a public mapping getter denominated in satoshis;
///      - `approveBalance` enforces the non-atomic allowance rule (a
///        non-zero allowance cannot be overwritten with a non-zero value);
///      - `transferBalanceFrom` consumes the spender allowance (unless it is
///        `type(uint256).max`) and moves the balance.
contract StakingMockBank {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }

    function increaseBalance(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approveBalance(address spender, uint256 amount) external {
        require(
            amount == 0 || allowance[msg.sender][spender] == 0,
            "Non-atomic allowance change not allowed"
        );
        allowance[msg.sender][spender] = amount;
    }

    function transferBalanceFrom(
        address spender,
        address recipient,
        uint256 amount
    ) external {
        uint256 currentAllowance = allowance[spender][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(
                currentAllowance >= amount,
                "Transfer amount exceeds allowance"
            );
            allowance[spender][msg.sender] = currentAllowance - amount;
        }
        uint256 spenderBalance = balanceOf[spender];
        require(spenderBalance >= amount, "Transfer amount exceeds balance");
        balanceOf[spender] = spenderBalance - amount;
        balanceOf[recipient] += amount;
    }
}

/// @dev Mock of the TBTC vault subset used by the FeeRouter. Mirrors the
///      exact semantics of `TBTCVault.mint(uint256)`: `amount` is in TBTC
///      precision; the non-convertible remainder is left on the caller's
///      Bank balance; the vault pulls `amount / SATOSHI_MULTIPLIER` satoshis
///      from the caller's Bank balance via the allowance mechanism and mints
///      the convertible amount of TBTC to the caller (1 sat -> 1e10 wei).
contract StakingMockTBTCVault {
    uint256 public constant SATOSHI_MULTIPLIER = 10**10;

    StakingMockBank public bank;
    StakingTestToken public tbtcToken;

    constructor(StakingMockBank _bank, StakingTestToken _tbtcToken) {
        bank = _bank;
        tbtcToken = _tbtcToken;
    }

    function mint(uint256 amount) external {
        uint256 remainder = amount % SATOSHI_MULTIPLIER;
        uint256 convertibleAmount = amount - remainder;
        uint256 satoshis = convertibleAmount / SATOSHI_MULTIPLIER;

        require(
            bank.balanceOf(msg.sender) >= satoshis,
            "Amount exceeds balance in the bank"
        );
        tbtcToken.mint(msg.sender, convertibleAmount);
        bank.transferBalanceFrom(msg.sender, address(this), satoshis);
    }
}

/// @dev Records `notifyReward` calls made by the FeeRouter.
contract StakingFeeMockRewardsDistributor is IRewardsDistributor {
    uint256 public notifyCount;
    uint256 public lastNotifiedAmount;
    uint256 public totalNotified;

    function onWeightChanged(address, uint96) external override {}

    function notifyReward(uint256 tbtcAmount) external override {
        notifyCount += 1;
        lastNotifiedAmount = tbtcAmount;
        totalNotified += tbtcAmount;
    }

    function settleOperator(address) external override {}
}

/// @dev Records `creditReward` calls made by the RewardsDistributor. The
///      TBTC backing the credit is expected to sit on this contract's token
///      balance at call time.
contract StakingFeeMockStakeVault {
    uint256 public creditCount;
    address public lastCreditProvider;
    uint256 public lastCreditAmount;
    mapping(address => uint256) public creditedTo;

    function creditReward(address stakingProvider, uint256 tbtcAmount)
        external
    {
        creditCount += 1;
        lastCreditProvider = stakingProvider;
        lastCreditAmount = tbtcAmount;
        creditedTo[stakingProvider] += tbtcAmount;
    }
}

/// @dev Minimal signer registry mock exposing only the two functions the
///      RewardsDistributor consumes: `commissionBpsOf` and `beneficiaryOf`.
contract StakingMockSignerRegistryLite {
    mapping(address => uint16) public commissionBpsOf;
    mapping(address => uint16) public pendingCommissionBpsOf;
    mapping(address => uint64) public commissionEffectiveAtOf;
    mapping(address => address payable) internal beneficiaries;

    function setCommissionBps(address stakingProvider, uint16 bps) external {
        commissionBpsOf[stakingProvider] = bps;
        pendingCommissionBpsOf[stakingProvider] = 0;
        commissionEffectiveAtOf[stakingProvider] = 0;
    }

    function setCommissionSchedule(
        address stakingProvider,
        uint16 currentBps,
        uint16 pendingBps,
        uint64 effectiveAt
    ) external {
        commissionBpsOf[stakingProvider] = currentBps;
        pendingCommissionBpsOf[stakingProvider] = pendingBps;
        commissionEffectiveAtOf[stakingProvider] = effectiveAt;
    }

    function setBeneficiary(
        address stakingProvider,
        address payable beneficiary
    ) external {
        beneficiaries[stakingProvider] = beneficiary;
    }

    function beneficiaryOf(address stakingProvider)
        external
        view
        returns (address payable)
    {
        return beneficiaries[stakingProvider];
    }

    function commissionScheduleOf(address stakingProvider)
        external
        view
        returns (
            uint16,
            uint16,
            uint64
        )
    {
        return (
            commissionBpsOf[stakingProvider],
            pendingCommissionBpsOf[stakingProvider],
            commissionEffectiveAtOf[stakingProvider]
        );
    }
}

/// @dev Forwards ETH to a target with exactly the 100k gas stipend the
///      Bridge's `Fraud.sol` uses when sending defeated-challenge ETH to the
///      treasury. Records the gas consumed by the call so tests can assert
///      the target's `receive()` stays within the stipend.
contract StakingGasStipendForwarder {
    error ForwardFailed();

    uint256 public lastGasUsed;

    function forward(address payable target) external payable {
        uint256 gasBefore = gasleft();
        // slither-disable-next-line arbitrary-send-eth,low-level-calls
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = target.call{value: msg.value, gas: 100_000}("");
        lastGasUsed = gasBefore - gasleft();
        if (!success) revert ForwardFailed();
    }
}

/// @dev ETH receiver that always reverts; used to assert the FeeRouter's
///      require-success behavior on the DAO treasury ETH leg.
contract StakingRevertingEthReceiver {
    receive() external payable {
        revert("no ETH accepted");
    }
}
