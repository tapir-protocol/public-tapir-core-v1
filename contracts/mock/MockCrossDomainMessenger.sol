// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title MockCrossDomainMessenger
 * @dev Mock contract for testing OP Stack cross-domain messaging functionality
 * @dev Implements both L1CrossDomainMessenger and L2CrossDomainMessenger interfaces
 */
contract MockCrossDomainMessenger {
    address private _xDomainMessageSender;

    // Track messages sent for testing verification
    struct Message {
        address target;
        bytes message;
        uint32 minGasLimit;
        uint256 value;
        address sender;
    }

    Message[] public sentMessages;

    // Events matching OP Stack
    event SentMessage(address indexed target, address indexed sender, bytes message, uint256 messageNonce, uint256 gasLimit);

    event RelayedMessage(bytes32 indexed msgHash);
    event FailedRelayedMessage(bytes32 indexed msgHash);

    /**
     * @notice Set the L1/L2 sender address for testing
     * @param sender The address to return as xDomainMessageSender
     */
    function setXDomainMessageSender(address sender) external {
        _xDomainMessageSender = sender;
    }

    /**
     * @notice Returns the address of the cross-domain sender
     * @return The cross-domain sender address
     */
    function xDomainMessageSender() external view returns (address) {
        return _xDomainMessageSender;
    }

    /**
     * @notice Send a message to the target address on the other chain
     * @dev This is the main OP Stack interface used by TapirOracle
     * @param _target Target contract address on the other chain
     * @param _message The calldata to send
     * @param _minGasLimit Minimum gas limit for execution on the other chain
     */
    function sendMessage(address _target, bytes calldata _message, uint32 _minGasLimit) external payable {
        // Store the message for verification in tests
        sentMessages.push(Message({target: _target, message: _message, minGasLimit: _minGasLimit, value: msg.value, sender: msg.sender}));

        emit SentMessage(
            _target,
            msg.sender,
            _message,
            sentMessages.length - 1, // Use array index as nonce
            _minGasLimit
        );
    }

    /**
     * @notice Manually relay a message (simulates the relayer)
     * @dev In production, this is done by the OP Stack infrastructure
     * @dev This mock uses a workaround: it expects the target contract to check if msg.sender is this messenger,
     * @dev and if so, to call xDomainMessageSender() to get the real sender
     * @param messageIndex The index of the message to relay
     */
    function relayMessage(uint256 messageIndex) external {
        require(messageIndex < sentMessages.length, "Message does not exist");

        Message memory msg_ = sentMessages[messageIndex];

        // Set the xDomainMessageSender so the target can verify the sender
        // In the real OP Stack, this is set in the execution context
        _xDomainMessageSender = msg_.sender;

        // Execute the call - msg.sender will be this messenger contract
        // Target contracts should check: if msg.sender == messenger, use xDomainMessageSender()
        (bool success, bytes memory returnData) = msg_.target.call{value: msg_.value}(msg_.message);

        // Reset the xDomainMessageSender
        _xDomainMessageSender = address(0);

        bytes32 msgHash = keccak256(abi.encode(msg_.target, msg_.sender, msg_.message, messageIndex));

        if (!success) {
            emit FailedRelayedMessage(msgHash);
            // Bubble up the revert reason
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            } else {
                revert("MockCrossDomainMessenger: relay failed");
            }
        }

        emit RelayedMessage(msgHash);
    }

    /**
     * @notice Helper function to relay a message and make it appear to come from the original sender
     * @dev Uses low-level manipulation for testing purposes only
     * @dev Allows testing without modifying the target contract
     * @param messageIndex The index of the message to relay
     * @param impersonatedSender The address to impersonate (should match sentMessages[messageIndex].sender)
     */
    function relayMessageImpersonating(uint256 messageIndex, address impersonatedSender) external {
        require(messageIndex < sentMessages.length, "Message does not exist");

        Message memory msg_ = sentMessages[messageIndex];
        require(msg_.sender == impersonatedSender, "Sender mismatch");

        // For testing: we'll use a simple approach - just call the target
        // In a real test environment, you would use Hardhat's impersonation
        // For now, we set xDomainMessageSender and the target should check this
        _xDomainMessageSender = msg_.sender;

        // Make the call - in production OP Stack, msg.sender would be set to the L1 sender
        // For testing, target contracts need to handle this by checking xDomainMessageSender
        (bool success, bytes memory returnData) = msg_.target.call{value: msg_.value}(msg_.message);

        _xDomainMessageSender = address(0);

        bytes32 msgHash = keccak256(abi.encode(msg_.target, msg_.sender, msg_.message, messageIndex));

        if (!success) {
            emit FailedRelayedMessage(msgHash);
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            } else {
                revert("MockCrossDomainMessenger: relay failed");
            }
        }

        emit RelayedMessage(msgHash);
    }

    /**
     * @notice Get the number of messages sent
     * @return The count of sent messages
     */
    function sentMessagesCount() external view returns (uint256) {
        return sentMessages.length;
    }

    /**
     * @notice Get a sent message by index
     * @param index The index of the message
     * @return target The target address
     * @return message The message calldata
     * @return minGasLimit The minimum gas limit
     * @return value The ETH value sent
     * @return sender The sender address
     */
    function getSentMessage(uint256 index) external view returns (address target, bytes memory message, uint32 minGasLimit, uint256 value, address sender) {
        require(index < sentMessages.length, "Message does not exist");
        Message memory msg_ = sentMessages[index];
        return (msg_.target, msg_.message, msg_.minGasLimit, msg_.value, msg_.sender);
    }
}
