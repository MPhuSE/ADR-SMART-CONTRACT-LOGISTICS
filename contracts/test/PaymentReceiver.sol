// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Test fixture: exercises contract-wallet transfers, rejection and reentry.
contract PaymentReceiver {
    address public immutable controller = msg.sender;
    bool public rejectPayments;
    bool public attemptReentry;
    bool public reentrySucceeded;
    uint256 public receipts;
    address public callbackTarget;
    bytes public callbackData;

    function configure(bool reject, bool reenter, address target, bytes calldata data) external {
        require(msg.sender == controller, "Only controller");
        rejectPayments = reject;
        attemptReentry = reenter;
        callbackTarget = target;
        callbackData = data;
    }
    function execute(address target, bytes calldata data) external payable returns (bytes memory) {
        require(msg.sender == controller, "Only controller");
        (bool ok, bytes memory result) = target.call{value: msg.value}(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        return result;
    }
    receive() external payable {
        require(!rejectPayments, "Payment rejected");
        receipts++;
        if (attemptReentry) (reentrySucceeded, ) = callbackTarget.call(callbackData);
    }
}
