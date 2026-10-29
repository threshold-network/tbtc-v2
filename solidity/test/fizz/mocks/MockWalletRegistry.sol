// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {EcdsaDkg} from "@keep-network/ecdsa/contracts/libraries/EcdsaDkg.sol";
import {IWalletRegistry} from "@keep-network/ecdsa/contracts/api/IWalletRegistry.sol";
import {IWalletOwner} from "@keep-network/ecdsa/contracts/api/IWalletOwner.sol";

/// @notice Harness replacement for the keep-network ECDSA `WalletRegistry`.
///
///         The real registry is an external system (DKG, sortition pool,
///         staking, slashing) that is not under test. The Bridge only needs
///         it for:
///         - `requestNewWallet` / `getWalletCreationState` (wallet creation
///           requests),
///         - `closeWallet` / `seize` (wallet lifecycle and slashing),
///         - `isWalletMember` (moving funds commitment authorization),
///         - being the single authorized caller of the Bridge's
///           `__ecdsaWalletCreatedCallback` and
///           `__ecdsaWalletHeartbeatFailedCallback`.
///
///         This mock keeps the registry permissive (DKG is always idle, every
///         address is a wallet member unless toggled) so that every Bridge
///         wallet path is reachable, and records the calls that mutate
///         registry-side state so properties can inspect them. Wallet creation
///         and heartbeat failure are driven by the harness through
///         `createWallet` and `heartbeatFailed`.
contract MockWalletRegistry is IWalletRegistry {
    /// @notice Bridge the registry delivers callbacks to. Set once.
    IWalletOwner public walletOwner;

    /// @notice Account allowed to wire the wallet owner (the harness).
    address public immutable deployer;

    /// @notice State returned by `getWalletCreationState`.
    EcdsaDkg.State public walletCreationState = EcdsaDkg.State.IDLE;

    /// @notice Result returned by `isWalletMember`.
    bool public walletMembershipResult = true;

    uint256 public requestNewWalletCalls;
    uint256 public closeWalletCalls;
    uint256 public seizeCalls;

    /// @notice Sum of all `amount * rewardMultiplier` seized, for ghosts.
    uint256 public totalSeizeRequested;
    address public lastSeizeNotifier;
    bytes32 public lastSeizeWalletID;

    mapping(bytes32 => bytes) internal walletPublicKeys;
    mapping(bytes32 => bool) public closedWallets;

    constructor() {
        deployer = msg.sender;
    }

    // ――――――――――――――――――――― Harness-only entry points ―――――――――――――――――――――

    /// @notice One-shot wiring of the Bridge, which must exist after the
    ///         registry because the Bridge is initialized with this address.
    function setWalletOwner(address _walletOwner) external {
        require(msg.sender == deployer, "Only deployer");
        require(address(walletOwner) == address(0), "Wallet owner already set");
        require(_walletOwner != address(0), "Wallet owner must not be 0x0");
        walletOwner = IWalletOwner(_walletOwner);
    }

    function setWalletCreationState(EcdsaDkg.State _state) external {
        walletCreationState = _state;
    }

    function setWalletMembershipResult(bool _result) external {
        walletMembershipResult = _result;
    }

    /// @notice Simulates a successful DKG: registers the wallet in the Bridge
    ///         through `__ecdsaWalletCreatedCallback`, as the real registry
    ///         does on DKG result approval.
    function createWallet(
        bytes32 walletID,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external {
        walletPublicKeys[walletID] = abi.encodePacked(publicKeyX, publicKeyY);
        walletOwner.__ecdsaWalletCreatedCallback(
            walletID,
            publicKeyX,
            publicKeyY
        );
    }

    /// @notice Simulates a wallet heartbeat failure report, delivered to the
    ///         Bridge through `__ecdsaWalletHeartbeatFailedCallback`.
    function heartbeatFailed(
        bytes32 walletID,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external {
        walletOwner.__ecdsaWalletHeartbeatFailedCallback(
            walletID,
            publicKeyX,
            publicKeyY
        );
    }

    // ――――――――――――――――――――――― IWalletRegistry ――――――――――――――――――――――――

    function requestNewWallet() external override {
        requestNewWalletCalls++;
    }

    function closeWallet(bytes32 walletID) external override {
        closeWalletCalls++;
        closedWallets[walletID] = true;
    }

    function seize(
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        bytes32 walletID,
        uint32[] calldata
    ) external override {
        seizeCalls++;
        totalSeizeRequested += uint256(amount) * rewardMultiplier;
        lastSeizeNotifier = notifier;
        lastSeizeWalletID = walletID;
    }

    function getWalletPublicKey(
        bytes32 walletID
    ) external view override returns (bytes memory) {
        return walletPublicKeys[walletID];
    }

    function getWalletCreationState()
        external
        view
        override
        returns (EcdsaDkg.State)
    {
        return walletCreationState;
    }

    function isWalletMember(
        bytes32,
        uint32[] calldata,
        address,
        uint256
    ) external view override returns (bool) {
        return walletMembershipResult;
    }
}
