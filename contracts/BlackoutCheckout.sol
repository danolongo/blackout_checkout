// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract BlackoutCheckout {
    event OrderPaid(bytes16 indexed orderId, address indexed vendor, address indexed payer, uint256 amount);
    error InvalidOrder();
    error AlreadyPaid();
    error ForwardFailed();

    mapping(bytes32 => bool) public settled;

    function pay(address payable vendor, bytes16 orderId) external payable {
        if (vendor == address(0) || msg.value == 0 || orderId == bytes16(0)) revert InvalidOrder();
        bytes32 terms = keccak256(abi.encode(vendor, orderId, msg.value));
        if (settled[terms]) revert AlreadyPaid();
        settled[terms] = true;
        (bool sent,) = vendor.call{value: msg.value}("");
        if (!sent) revert ForwardFailed();
        emit OrderPaid(orderId, vendor, msg.sender, msg.value);
    }
}
