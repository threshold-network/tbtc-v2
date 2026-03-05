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

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../../integrator/IBridge.sol";
import "../wormhole/Wormhole.sol";

/// @title IL2WormholeGateway
/// @notice Interface to the `L2WormholeGateway` contract.
interface IL2WormholeGateway {
    /// @dev See ./L2WormholeGateway.sol#receiveTbtc
    function receiveTbtc(bytes memory vaa) external;
}

/// @title L2BitcoinDepositor
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain ERC20 TBTC on supported L2 chains, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
///
///         `L2BitcoinDepositor` is deployed on the L2 chain and interacts with
///         their L1 counterpart, the `L1BitcoinDepositor`, deployed on the
///         L1 tBTC ledger chain. Each `L1BitcoinDepositor` & `L2BitcoinDepositor`
///         pair is responsible for a specific L2 chain.
///
///         Please consult the `L1BitcoinDepositor` docstring for an
///         outline of the direct bridging mechanism
// slither-disable-next-line locked-ether
contract L2BitcoinDepositor is IWormholeReceiver, OwnableUpgradeable {
    /// @notice `WormholeRelayer` contract on L2.
    IWormholeRelayer public wormholeRelayer;
    /// @notice tBTC `L2WormholeGateway` contract on L2.
    IL2WormholeGateway public l2WormholeGateway;
    /// @notice Wormhole chain ID of the corresponding L1 chain.
    uint16 public l1ChainId;
    /// @notice tBTC `L1BitcoinDepositor` contract on the corresponding L1 chain.
    address public l1BitcoinDepositor;

    event DepositInitialized(
        IBridgeTypes.BitcoinTxInfo fundingTx,
        IBridgeTypes.DepositRevealInfo reveal,
        address indexed l2DepositOwner,
        address indexed l2Sender
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _wormholeRelayer,
        address _l2WormholeGateway,
        uint16 _l1ChainId
    ) external initializer {
        __Ownable_init();

        require(
            _wormholeRelayer != address(0),
            "WormholeRelayer address cannot be zero"
        );
        require(
            _l2WormholeGateway != address(0),
            "L2WormholeGateway address cannot be zero"
        );

        wormholeRelayer = IWormholeRelayer(_wormholeRelayer);
        l2WormholeGateway = IL2WormholeGateway(_l2WormholeGateway);
        l1ChainId = _l1ChainId;
    }

    /// @notice Sets the address of the `L1BitcoinDepositor` contract on the
    ///         corresponding L1 chain. This function solves the chicken-and-egg
    ///         problem of setting the `L1BitcoinDepositor` contract address
    ///         on the `L2BitcoinDepositor` contract and vice versa.
    /// @param _l1BitcoinDepositor Address of the `L1BitcoinDepositor` contract.
    /// @dev Requirements:
    ///      - Can be called only by the contract owner,
    ///      - The address must not be set yet,
    ///      - The new address must not be 0x0.
    function attachL1BitcoinDepositor(address _l1BitcoinDepositor)
        external
        onlyOwner
    {
        require(
            l1BitcoinDepositor == address(0),
            "L1 Bitcoin Depositor already set"
        );
        require(
            _l1BitcoinDepositor != address(0),
            "L1 Bitcoin Depositor must not be 0x0"
        );
        l1BitcoinDepositor = _l1BitcoinDepositor;
    }

    /// @notice Initializes the deposit process on L2 by emitting an event
    ///         containing the deposit data (funding transaction and
    ///         components of the P2(W)SH deposit address). The event is
    ///         supposed to be picked up by the relayer and used to initialize
    ///         the deposit on L1 through the `L1BitcoinDepositor` contract.
    /// @param fundingTx Bitcoin funding transaction data.
    /// @param reveal Deposit reveal data.
    /// @param l2DepositOwner Address of the L2 deposit owner.
    /// @dev The alternative approach of using Wormhole Relayer to send the
    ///      deposit data to L1 was considered. However, it turned out to be
    ///      too expensive. For example, relying deposit data from Base L2 to
    ///      Ethereum L1 costs around ~0.045 ETH (~170 USD at the moment of writing).
    ///      Moreover, the next iteration of the direct bridging mechanism
    ///      assumes that no L2 transaction will be required to initialize the
    ///      deposit and the relayer should obtain the deposit data off-chain.
    ///      There is a high chance this function will be removed then.
    ///      That said, there was no sense to explore another cross-chain
    ///      messaging solutions. Relying on simple on-chain event and custom
    ///      off-chain relayer seems to be the most reasonable way to go. It
    ///      also aligns with the future direction of the direct bridging mechanism.
    function initializeDeposit(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        address l2DepositOwner
    ) external {
        emit DepositInitialized(fundingTx, reveal, l2DepositOwner, msg.sender);
    }

    /// @notice Receives Wormhole messages originating from the corresponding
    ///         `L1BitcoinDepositor` contract that lives on the L1 chain.
    ///         Messages are issued upon deposit finalization on L1 and
    ///         are supposed to carry the VAA of the Wormhole token transfer of
    ///         ERC20 L1 TBTC to the L2 chain. This contract performs some basic
    ///         checks and forwards the VAA to the `L2WormholeGateway` contract
    ///         that is authorized to withdraw the Wormhole-wrapped L2 TBTC
    ///         from the Wormhole Token Bridge (representing the ERC20 TBTC
    ///         locked on L1) and use it to mint the canonical L2 TBTC for the
    ///         deposit owner.
    /// @param additionalVaas Additional VAAs that are part of the Wormhole message.
    /// @param sourceAddress Address of the source of the message (in Wormhole format).
    /// @param sourceChain Wormhole chain ID of the source chain.
    /// @dev Requirements:
    ///      - Can be called only by the Wormhole Relayer contract,
    ///      - The source chain must be the expected L1 chain,
    ///      - The source address must be the corresponding
    ///        `L1BitcoinDepositor` contract,
    ///      - The message must carry exactly 1 additional VAA key representing
    ///        the token transfer.
    function receiveWormholeMessages(
        bytes memory,
        bytes[] memory additionalVaas,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32
    ) external payable {
        require(
            msg.sender == address(wormholeRelayer),
            "Caller is not Wormhole Relayer"
        );

        require(
            sourceChain == l1ChainId,
            "Source chain is not the expected L1 chain"
        );

        require(
            WormholeUtils.fromWormholeAddress(sourceAddress) ==
                l1BitcoinDepositor,
            "Source address is not the expected L1 Bitcoin depositor"
        );

        require(
            additionalVaas.length == 1,
            "Expected 1 additional VAA key for token transfer"
        );

        l2WormholeGateway.receiveTbtc(additionalVaas[0]);
    }
}
