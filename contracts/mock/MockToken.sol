// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockToken
 * @dev Configurable mock ERC20 token for testnet deployments
 * @dev Features admin-controlled minting and a public faucet function for testing
 */
contract MockToken is ERC20 {
    address public admin;
    uint8 private immutable _decimals;
    
    /// @notice Maximum amount that can be minted per faucet call (10 tokens)
    uint256 public constant FAUCET_AMOUNT = 10 ether;
    
    /// @notice Cooldown period between faucet calls per address (1 hour)
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    
    /// @notice Tracks last faucet claim time per address
    mapping(address => uint256) public lastFaucetClaim;

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event FaucetClaim(address indexed claimer, uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "MockToken: caller is not admin");
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 decimals_,
        uint256 initialSupply,
        address initialHolder
    ) ERC20(_name, _symbol) {
        admin = msg.sender;
        _decimals = decimals_;
        if (initialSupply > 0 && initialHolder != address(0)) {
            _mint(initialHolder, initialSupply);
        }
    }

    /**
     * @notice Returns the number of decimals
     */
    function decimals() public view override returns (uint8) {
        return _decimals;
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
        require(newAdmin != address(0), "MockToken: new admin is zero address");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC FAUCET (for testnet convenience)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Claims testnet tokens (rate-limited)
     * @dev Anyone can call this to get test tokens, with cooldown protection
     */
    function faucet() external {
        require(
            block.timestamp >= lastFaucetClaim[msg.sender] + FAUCET_COOLDOWN,
            "MockToken: faucet cooldown not elapsed"
        );
        
        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        
        emit FaucetClaim(msg.sender, FAUCET_AMOUNT);
    }

    /**
     * @notice Claims testnet tokens to a specific address (rate-limited by caller)
     * @param to The address to receive the tokens
     */
    function faucetTo(address to) external {
        require(
            block.timestamp >= lastFaucetClaim[msg.sender] + FAUCET_COOLDOWN,
            "MockToken: faucet cooldown not elapsed"
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
