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

import "@openzeppelin/contracts/access/Ownable.sol";
import "@keep-network/random-beacon/contracts/Reimbursable.sol";
import "@keep-network/random-beacon/contracts/ReimbursementPool.sol";

import "./LightRelay.sol";

/// @title LightRelayMaintainerProxy
/// @notice The proxy contract that allows the relay maintainers to be refunded
///         for the spent gas from the `ReimbursementPool`. When proving the
///         next Bitcoin difficulty epoch, the maintainer calls the
///         `LightRelayMaintainerProxy` which in turn calls the actual `LightRelay`
///         contract.
contract LightRelayMaintainerProxy is Ownable, Reimbursable {
    ILightRelay public lightRelay;

    /// @notice Stores the addresses that can maintain the relay. Those
    ///         addresses are attested by the DAO.
    /// @dev The goal is to prevent a griefing attack by frontrunning relay
    ///      maintainer which is responsible for retargetting the relay in the
    ///      given round. The maintainer's transaction would revert with no gas
    ///      refund. Having the ability to restrict maintainer addresses is also
    ///      important in case the underlying relay contract has authorization
    ///      requirements for callers.
    mapping(address => bool) public isAuthorized;

    /// @notice Gas that is meant to balance the retarget overall cost. Can be
    //          updated by the governance based on the current market conditions.
    uint256 public retargetGasOffset;

    event LightRelayUpdated(address newRelay);

    event MaintainerAuthorized(address indexed maintainer);

    event MaintainerDeauthorized(address indexed maintainer);

    event RetargetGasOffsetUpdated(uint256 retargetGasOffset);

    modifier onlyRelayMaintainer() {
        require(isAuthorized[msg.sender], "Caller is not authorized");
        _;
    }

    modifier onlyReimbursableAdmin() override {
        require(owner() == msg.sender, "Caller is not the owner");
        _;
    }

    constructor(ILightRelay _lightRelay, ReimbursementPool _reimbursementPool) {
        require(
            address(_lightRelay) != address(0),
            "Light relay must not be zero address"
        );
        require(
            address(_reimbursementPool) != address(0),
            "Reimbursement pool must not be zero address"
        );

        lightRelay = _lightRelay;
        reimbursementPool = _reimbursementPool;

        retargetGasOffset = 54000;
    }

    /// @notice Allows the governance to upgrade the `LightRelay` address.
    /// @dev The function does not implement any governance delay and does not
    ///      check the status of the `LightRelay`. The Governance implementation
    ///      needs to ensure all requirements for the upgrade are satisfied
    ///      before executing this function.
    function updateLightRelay(ILightRelay _lightRelay) external onlyOwner {
        require(
            address(_lightRelay) != address(0),
            "New light relay must not be zero address"
        );

        lightRelay = _lightRelay;
        emit LightRelayUpdated(address(_lightRelay));
    }

    /// @notice Authorizes the given address as a maintainer. Can only be called
    ///         by the owner and the address of the maintainer must not be
    ///         already authorized.
    /// @dev The function does not implement any governance delay.
    /// @param maintainer The address of the maintainer to be authorized.
    function authorize(address maintainer) external onlyOwner {
        require(!isAuthorized[maintainer], "Maintainer is already authorized");

        isAuthorized[maintainer] = true;
        emit MaintainerAuthorized(maintainer);
    }

    /// @notice Deauthorizes the given address as a maintainer. Can only be
    ///         called by the owner and the address of the maintainer must be
    ///         authorized.
    /// @dev The function does not implement any governance delay.
    /// @param maintainer The address of the maintainer to be deauthorized.
    function deauthorize(address maintainer) external onlyOwner {
        require(isAuthorized[maintainer], "Maintainer is not authorized");

        isAuthorized[maintainer] = false;
        emit MaintainerDeauthorized(maintainer);
    }

    /// @notice Updates the values of retarget gas offset.
    /// @dev Can be called only by the contract owner. The caller is responsible
    ///      for validating the parameter. The function does not implement any
    ///      governance delay.
    /// @param newRetargetGasOffset New retarget gas offset.
    function updateRetargetGasOffset(uint256 newRetargetGasOffset)
        external
        onlyOwner
    {
        retargetGasOffset = newRetargetGasOffset;
        emit RetargetGasOffsetUpdated(retargetGasOffset);
    }

    /// @notice Wraps `LightRelay.retarget` call and reimburses the caller's
    ///         transaction cost. Can only be called by an authorized relay
    ///         maintainer.
    /// @dev See `LightRelay.retarget` function documentation.
    function retarget(bytes memory headers) external onlyRelayMaintainer {
        uint256 gasStart = gasleft();

        lightRelay.retarget(headers);

        reimbursementPool.refund(
            (gasStart - gasleft()) + retargetGasOffset,
            msg.sender
        );
    }
}
