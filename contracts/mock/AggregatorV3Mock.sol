// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title AggregatorV3Mock
 * @dev Configurable mock implementation of AggregatorV3 interface for testnet deployments
 * @dev Can be used for Chainlink, RedStone Classic (Push), and Tellor (all use AggregatorV3 interface)
 * @dev Designed for persistent testnet deployment with admin controls
 */
contract AggregatorV3Mock {
    int256 private _answer;
    uint256 private _updatedAt;
    uint8 private _decimals;
    uint80 private _roundId;
    
    address public admin;
    string public description;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "AggregatorV3Mock: caller is not admin");
        _;
    }

    /**
     * @notice Initializes the mock with initial values
     * @param initialAnswer The initial price answer (in source decimals)
     * @param decimals_ The number of decimals for the price
     * @param _description A description of what this oracle provides (e.g., "weETH/ETH")
     */
    constructor(int256 initialAnswer, uint8 decimals_, string memory _description) {
        _answer = initialAnswer;
        _decimals = decimals_;
        _updatedAt = block.timestamp;
        _roundId = 1;
        admin = msg.sender;
        description = _description;
        
        emit AnswerUpdated(initialAnswer, _roundId, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AGGREGATOR V3 INTERFACE
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Returns the latest round data
     * @dev Mimics the Chainlink AggregatorV3 interface
     */
    function latestRoundData() 
        external 
        view 
        returns (
            uint80 roundId, 
            int256 answer, 
            uint256 startedAt, 
            uint256 updatedAt, 
            uint80 answeredInRound
        ) 
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    /**
     * @notice Returns the number of decimals
     */
    function decimals() external view returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Returns the latest answer directly
     */
    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    /**
     * @notice Returns the timestamp of the latest round
     */
    function latestTimestamp() external view returns (uint256) {
        return _updatedAt;
    }

    /**
     * @notice Returns the latest round ID
     */
    function latestRound() external view returns (uint256) {
        return _roundId;
    }

    /**
     * @notice Returns historical data for a specific round
     * @dev For simplicity, returns current data for any round
     */
    function getRoundData(uint80 _roundIdParam) 
        external 
        view 
        returns (
            uint80 roundId, 
            int256 answer, 
            uint256 startedAt, 
            uint256 updatedAt, 
            uint80 answeredInRound
        ) 
    {
        require(_roundIdParam <= _roundId, "Round not complete");
        return (_roundIdParam, _answer, _updatedAt, _updatedAt, _roundIdParam);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Updates the mock answer and increments the round
     * @param newAnswer The new price answer
     */
    function updateAnswer(int256 newAnswer) external onlyAdmin {
        _roundId++;
        _answer = newAnswer;
        _updatedAt = block.timestamp;
        
        emit AnswerUpdated(newAnswer, _roundId, block.timestamp);
    }

    /**
     * @notice Updates the mock answer with a specific timestamp
     * @param newAnswer The new price answer
     * @param newTimestamp The timestamp to use (useful for testing staleness)
     */
    function updateAnswerWithTimestamp(int256 newAnswer, uint256 newTimestamp) external onlyAdmin {
        _roundId++;
        _answer = newAnswer;
        _updatedAt = newTimestamp;
        
        emit AnswerUpdated(newAnswer, _roundId, newTimestamp);
    }

    /**
     * @notice Updates only the timestamp (useful for testing staleness scenarios)
     * @param newTimestamp The new timestamp
     */
    function updateTimestamp(uint256 newTimestamp) external onlyAdmin {
        _updatedAt = newTimestamp;
    }

    /**
     * @notice Refreshes the timestamp to current block time (keeps price fresh)
     */
    function refreshTimestamp() external onlyAdmin {
        _updatedAt = block.timestamp;
    }

    /**
     * @notice Transfers admin rights to a new address
     * @param newAdmin The address of the new admin
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "AggregatorV3Mock: new admin is zero address");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Returns all current state in one call (for debugging)
     */
    function getState() external view returns (
        int256 answer,
        uint256 updatedAt,
        uint8 priceDecimals,
        uint80 roundId,
        address adminAddress
    ) {
        return (_answer, _updatedAt, _decimals, _roundId, admin);
    }
}

