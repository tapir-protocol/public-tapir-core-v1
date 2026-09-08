// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract WtETHMock is ERC20 {
    constructor() ERC20("test", "test") {}

    // testing mint
    function mint(address _account, uint256 _amount) public {
        _mint(_account, _amount);
    }
}
