// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title Api3ReaderProxyMock
 * @dev Mock implementation of IApi3ReaderProxy for testing
 */
contract Api3ReaderProxyMock {
    int224 private _value;
    uint32 private _timestamp;

    constructor(int224 initialValue, uint32 initialTimestamp) {
        _value = initialValue;
        _timestamp = initialTimestamp;
    }

    /// @notice Reads the current value and timestamp
    /// @dev Mimics the API3 ReaderProxy interface
    /// @return value The price value
    /// @return timestamp The timestamp when the price was recorded
    function read() external view returns (int224 value, uint32 timestamp) {
        return (_value, _timestamp);
    }

    /// @notice Updates the mock price value
    /// @param newValue The new price value
    function setValue(int224 newValue) external {
        _value = newValue;
    }

    /// @notice Updates the mock timestamp
    /// @param newTimestamp The new timestamp
    function setTimestamp(uint32 newTimestamp) external {
        _timestamp = newTimestamp;
    }

    /// @notice Updates both value and timestamp
    /// @param newValue The new price value
    /// @param newTimestamp The new timestamp
    function setData(int224 newValue, uint32 newTimestamp) external {
        _value = newValue;
        _timestamp = newTimestamp;
    }
}
