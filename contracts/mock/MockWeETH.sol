// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockWeETH
 * @dev Mock implementation of weETH (Wrapped eETH) for testnet deployments
 * @dev Features admin-controlled minting and a public faucet function for testing
 */
contract MockWeETH is ERC20 {
    address public admin;
    
    /// @notice Maximum amount that can be minted per faucet call (10 weETH)
    uint256 public constant FAUCET_AMOUNT = 10 ether;
    
    /// @notice Cooldown period between faucet calls per address (1 hour)
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    
    /// @notice Tracks last faucet claim time per address
    mapping(address => uint256) public lastFaucetClaim;

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event FaucetClaim(address indexed claimer, uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "MockWeETH: caller is not admin");
        _;
    }

    constructor() ERC20("Mock Wrapped eETH", "weETH") {
        admin = msg.sender;
        // Mint initial supply to deployer for setup
        _mint(msg.sender, 1_000_000 ether);
    }

    /**
     * @notice Returns the number of decimals (18, same as real weETH)
     */
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Mints tokens to a specified address
     * @param to The address to mint tokens to
     * @param amount The amount of tokens to mint
     */
    function mint(address to, uint256 amount) external onlyAdmin {
        _mint(to, amount);
    }

    /**
     * @notice Burns tokens from a specified address (requires allowance)
     * @param from The address to burn tokens from
     * @param amount The amount of tokens to burn
     */
    function burn(address from, uint256 amount) external onlyAdmin {
        _burn(from, amount);
    }

    /**
     * @notice Transfers admin rights to a new address
     * @param newAdmin The address of the new admin
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "MockWeETH: new admin is zero address");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC FAUCET (for testnet convenience)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Claims testnet weETH tokens (rate-limited)
     * @dev Anyone can call this to get test tokens, with cooldown protection
     */
    function faucet() external {
        require(
            block.timestamp >= lastFaucetClaim[msg.sender] + FAUCET_COOLDOWN,
            "MockWeETH: faucet cooldown not elapsed"
        );
        
        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        
        emit FaucetClaim(msg.sender, FAUCET_AMOUNT);
    }

    /**
     * @notice Claims testnet weETH tokens to a specific address (rate-limited by caller)
     * @param to The address to receive the tokens
     */
    function faucetTo(address to) external {
        require(
            block.timestamp >= lastFaucetClaim[msg.sender] + FAUCET_COOLDOWN,
            "MockWeETH: faucet cooldown not elapsed"
        );
        
        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
        
        emit FaucetClaim(to, FAUCET_AMOUNT);
    }

    /**
     * @notice Returns time until next faucet claim is available
     * @param account The address to check
     * @return secondsRemaining Seconds until faucet is available (0 if available now)
     */
    function faucetCooldownRemaining(address account) external view returns (uint256 secondsRemaining) {
        uint256 nextClaim = lastFaucetClaim[account] + FAUCET_COOLDOWN;
        if (block.timestamp >= nextClaim) {
            return 0;
        }
        return nextClaim - block.timestamp;
    }
}

