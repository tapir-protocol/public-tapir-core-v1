import { expect } from "chai";
import { ethers } from "hardhat";
import { DepegToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("DepegToken", function () {
  // Contracts
  let depegToken: DepegToken;
  let depegToken6Decimals: DepegToken;

  // Signers
  let deployer: SignerWithAddress; // Acts as the DepegPool
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  // Constants
  const TOKEN_NAME = "DP Token Test";
  const TOKEN_SYMBOL = "DPT";
  const TOKEN_DECIMALS = 18;
  const TOKEN_NAME_6 = "Stablecoin DP Token";
  const TOKEN_SYMBOL_6 = "DPSC";
  const STABLECOIN_DECIMALS = 6;

  beforeEach(async function () {
    [deployer, user1, user2, unauthorized] = await ethers.getSigners();

    // Deploy DepegToken directly - deployer becomes the depegPool
    const DepegToken = await ethers.getContractFactory("DepegToken");
    depegToken = await DepegToken.connect(deployer).deploy(TOKEN_NAME, TOKEN_SYMBOL, TOKEN_DECIMALS);
    
    // Deploy a 6-decimal token for stablecoin-like testing
    depegToken6Decimals = await DepegToken.connect(deployer).deploy(TOKEN_NAME_6, TOKEN_SYMBOL_6, STABLECOIN_DECIMALS);
  });

  describe("Deployment", function () {
    it("Should have correct name & symbol", async function () {
      expect(await depegToken.name()).to.equal(TOKEN_NAME);
      expect(await depegToken.symbol()).to.equal(TOKEN_SYMBOL);
    });

    it("Should have correct decimals", async function () {
      expect(await depegToken.decimals()).to.equal(TOKEN_DECIMALS);
    });

    it("Should have correct decimals for 6 decimal token", async function () {
      expect(await depegToken6Decimals.decimals()).to.equal(STABLECOIN_DECIMALS);
    });

    it("Should set DepegPool as the deployer", async function () {
      expect(await depegToken.depegPool()).to.equal(deployer.address);
    });

    it("Should have zero initial total supply", async function () {
      expect(await depegToken.totalSupply()).to.equal(0);
    });
  });

  describe("Minting", function () {
    const mintAmount = ethers.parseEther("100");

    it("Should be mintable by the DepegPool", async function () {
      // Deployer acts as DepegPool
      await depegToken.connect(deployer).mint(user1.address, mintAmount);

      expect(await depegToken.balanceOf(user1.address)).to.equal(mintAmount);
      expect(await depegToken.totalSupply()).to.equal(mintAmount);
    });

    it("Should not be mintable by anyone other than the DepegPool", async function () {
      await expect(
        depegToken.connect(unauthorized).mint(user1.address, mintAmount)
      ).to.be.reverted;

      await expect(
        depegToken.connect(user1).mint(user1.address, mintAmount)
      ).to.be.reverted;

      await expect(
        depegToken.connect(user2).mint(user1.address, mintAmount)
      ).to.be.reverted;
    });

    it("Should correctly update total supply after minting", async function () {
      const firstMint = ethers.parseEther("50");
      const secondMint = ethers.parseEther("75");

      await depegToken.connect(deployer).mint(user1.address, firstMint);
      expect(await depegToken.totalSupply()).to.equal(firstMint);

      await depegToken.connect(deployer).mint(user2.address, secondMint);
      expect(await depegToken.totalSupply()).to.equal(firstMint + secondMint);
    });

    it("Should emit Transfer event when minting", async function () {
      await expect(depegToken.connect(deployer).mint(user1.address, mintAmount))
        .to.emit(depegToken, "Transfer")
        .withArgs(ethers.ZeroAddress, user1.address, mintAmount);
    });

  });

  describe("Burning", function () {
    const mintAmount = ethers.parseEther("100");
    const burnAmount = ethers.parseEther("50");

    beforeEach(async function () {
      // Setup: mint tokens to user1
      await depegToken.connect(deployer).mint(user1.address, mintAmount);
    });

    it("Should be burnable by the DepegPool", async function () {
      const initialBalance = await depegToken.balanceOf(user1.address);
      const initialSupply = await depegToken.totalSupply();

      await depegToken.connect(deployer).burn(user1.address, burnAmount);

      expect(await depegToken.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
      expect(await depegToken.totalSupply()).to.equal(initialSupply - burnAmount);
    });

    it("Should not be burnable by anyone other than the DepegPool", async function () {
      await expect(
        depegToken.connect(unauthorized).burn(user1.address, burnAmount)
      ).to.be.reverted;

      await expect(
        depegToken.connect(user1).burn(user1.address, burnAmount)
      ).to.be.reverted;

      await expect(
        depegToken.connect(user2).burn(user1.address, burnAmount)
      ).to.be.reverted;
    });

    it("Should correctly update total supply after burning", async function () {
      const initialSupply = await depegToken.totalSupply();

      await depegToken.connect(deployer).burn(user1.address, burnAmount);

      expect(await depegToken.totalSupply()).to.equal(initialSupply - burnAmount);
    });

    it("Should emit Transfer event when burning", async function () {
      await expect(depegToken.connect(deployer).burn(user1.address, burnAmount))
        .to.emit(depegToken, "Transfer")
        .withArgs(user1.address, ethers.ZeroAddress, burnAmount);
    });
  });

  describe("Access Control", function () {
    it("Should correctly identify DepegPool", async function () {
      expect(await depegToken.depegPool()).to.equal(deployer.address);
    });
  });
});