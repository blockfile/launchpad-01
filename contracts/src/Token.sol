// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Token
/// @notice Fixed-supply ERC20 with on-chain metadata. Full supply is minted
///         once, in the constructor, to `mintTo`; there is no post-construction
///         mint path.
contract Token is ERC20 {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenMeta {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
    }

    string private _logo;
    string private _description;
    Socials private _socials;

    constructor(TokenMeta memory meta, uint256 supply, address mintTo) ERC20(meta.name, meta.symbol) {
        _logo = meta.logo;
        _description = meta.description;
        _socials = meta.socials;
        _mint(mintTo, supply);
    }

    function logo() public view returns (string memory) {
        return _logo;
    }

    function description() public view returns (string memory) {
        return _description;
    }

    function socials() public view returns (Socials memory) {
        return _socials;
    }
}
