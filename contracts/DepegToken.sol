// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./interfaces/IDepegToken.sol";

/**
 * @title DepegToken
 * @dev Generic ERC20 token for depeg pool assets (both DP and YB tokens).
 *      This unified contract replaces the previously separate DPasset and YBasset contracts.
 *      Allows only the associated DepegPool to mint and burn tokens.
 */
contract DepegToken is ERC20, IDepegToken {
    /// CUSTOM ERRORS
    ////////////////////
    error OnlyDepegPoolCanCall();

    // ===== VARIABLES =====
    ////////////////////////

    /// @notice Address of the DepegPool contract that manages minting and burning.
    address public immutable depegPool;

    /// @notice Number of decimals for this token (matches the base asset)
    uint8 private immutable _DECIMALS;

    /**
     * @dev Constructor initializes the ERC20 token.
     * @param _name The name of the token (e.g., "YB_wETH_250301" or "DP_wETH_250301").
     * @param _symbol The symbol of the token (e.g., "YB_wETH" or "DP_wETH").
     * @param _decimals The number of decimals for this token (should match base asset decimals).
     */
    constructor(string memory _name, string memory _symbol, uint8 _decimals) ERC20(_name, _symbol) {
        _DECIMALS = _decimals;
        depegPool = msg.sender;
    }

    /**
     * @notice Returns the number of decimals used for token amounts.
     * @dev Overrides the default ERC20 decimals (18) to match the base asset.
     * @return The number of decimals.
     */
    function decimals() public view virtual override(ERC20, IDepegToken) returns (uint8) {
        return _DECIMALS;
    }

    // ===== FUNCTIONS =====
    ////////////////////////

    /**
     * @notice Mint tokens to a specific account.
     * @dev Can only be called by the DepegPool contract.
     * @param _account Address to receive the minted tokens.
     * @param _value Amount of tokens to mint.
     */
    function mint(address _account, uint256 _value) external onlyDepegPool {
        _mint(_account, _value);
    }

    /**
     * @notice Burn tokens from a specific account.
     * @dev Can only be called by the DepegPool contract.
     * @param _account Address from which tokens will be burned.
     * @param _value Amount of tokens to burn.
     */
    function burn(address _account, uint256 _value) external onlyDepegPool {
        _burn(_account, _value);
    }

    // ====== MODIFIERS ======
    //////////////////////////

    /**
     * @notice Restricts access to functions that can only be called by the DepegPool contract.
     * @dev Ensures that only the DepegPool contract can mint or burn tokens.
     */
    modifier onlyDepegPool() {
        if (msg.sender != depegPool) revert OnlyDepegPoolCanCall();
        _;
    }
}
