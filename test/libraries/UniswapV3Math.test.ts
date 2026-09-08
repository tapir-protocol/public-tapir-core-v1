import { expect } from "chai";
import { ethers } from "hardhat";

describe("UniswapV3Math full-precision regression", function () {
  it("matches bigint division for 512-bit products and rounds down", async function () {
    const math = await (await ethers.getContractFactory("UniswapV3MathTest")).deploy();
    const max = (1n << 256n) - 1n;
    const cases = [
      [1n << 200n, 1n << 100n, (1n << 100n) + 1n],
      [max, max, max],
      [1n << 200n, 1n << 100n, 1n << 100n],
      [max, 2n, 3n], [7n, 11n, 3n], [0n, max, 7n],
    ];
    for (const [a, b, d] of cases) {
      expect(await math.mulDiv(a, b, d)).to.equal(a * b / d);
    }
  });
  it("rejects zero denominators and unrepresentable results", async function () {
    const math = await (await ethers.getContractFactory("UniswapV3MathTest")).deploy();
    await expect(math.mulDiv(1, 2, 0)).to.be.reverted;
    await expect(math.mulDiv(1n << 200n, 1n << 100n, 1)).to.be.reverted;
  });
});
