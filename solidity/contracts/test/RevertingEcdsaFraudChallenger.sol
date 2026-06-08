// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BitcoinTx.sol";

interface IEcdsaFraudRouterForTest {
    function submitFraudChallenge(
        bytes calldata walletPublicKey,
        bytes calldata preimageSha256,
        BitcoinTx.RSVSignature calldata signature
    ) external payable;

    function notifyFraudChallengeDefeatTimeout(
        bytes calldata walletPublicKey,
        uint32[] calldata walletMembersIDs,
        bytes calldata preimageSha256
    ) external;
}

contract RevertingEcdsaFraudChallenger {
    IEcdsaFraudRouterForTest public immutable fraudRouter;

    constructor(address _fraudRouter) {
        fraudRouter = IEcdsaFraudRouterForTest(_fraudRouter);
    }

    receive() external payable {
        revert("refund rejected");
    }

    function submitFraudChallenge(
        bytes calldata walletPublicKey,
        bytes calldata preimageSha256,
        BitcoinTx.RSVSignature calldata signature
    ) external payable {
        fraudRouter.submitFraudChallenge{value: msg.value}(
            walletPublicKey,
            preimageSha256,
            signature
        );
    }

    function notifyFraudChallengeDefeatTimeout(
        bytes calldata walletPublicKey,
        uint32[] calldata walletMembersIDs,
        bytes calldata preimageSha256
    ) external {
        fraudRouter.notifyFraudChallengeDefeatTimeout(
            walletPublicKey,
            walletMembersIDs,
            preimageSha256
        );
    }
}
