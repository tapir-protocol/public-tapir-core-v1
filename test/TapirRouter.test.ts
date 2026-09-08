import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const E = ethers.parseEther;
const DAY = 86400;
const HOUR = 3600;
async function fixture() {
  const [admin, user, other] = await ethers.getSigners();
  const base = await (await ethers.getContractFactory("MockToken")).deploy("Base", "BASE", 18, E("2000"), admin.address);
  const router = await (await ethers.getContractFactory("TapirRouter")).deploy();
  const swap = await (await ethers.getContractFactory("RouterSwapMock")).deploy();
  const pool = await (await ethers.getContractFactory("DepegPool")).deploy({
    assetAddress: await base.getAddress(), dpMetadata: { name: "DP", symbol: "DP" },
    ybMetadata: { name: "YB", symbol: "YB" }, oracle: admin.address,
    poolActiveDuration: 10 * DAY, name: "Router test", flag: "test", redemptionFeeBp: 0,
    cooldownDuration: 4 * HOUR, poolOwner: admin.address, minPrice: E("0.5"), maxPrice: E("2"),
    treasury: other.address, authorisedRouter: await router.getAddress(), minPriceAge: 4 * HOUR,
    xDomainMessengerL2: ethers.ZeroAddress,
  });
  const dp = await ethers.getContractAt("DepegToken", await pool.DP_ASSET());
  const yb = await ethers.getContractAt("DepegToken", await pool.YB_ASSET());
  await base.approve(pool, E("1000"));
  await pool.splitToken(admin.address, E("1000"));
  await dp.transfer(swap, E("400"));
  await yb.transfer(swap, E("400"));
  await base.transfer(user.address, E("500"));
  await base.connect(user).approve(router, E("500"));
  return { admin, user, other, base, router, swap, pool, dp, yb };
}

describe("TapirRouter integration", function () {
  it("splits and unsplits through the authorised wrapper without DP/YB allowances", async function () {
    const { user, base, router, pool, dp, yb } = await loadFixture(fixture);
    await base.connect(user).approve(pool, E("100"));
    await router.connect(user).split(pool, E("100"));
    expect(await dp.balanceOf(user.address)).to.equal(E("50"));
    expect(await yb.balanceOf(user.address)).to.equal(E("50"));
    expect(await dp.allowance(user.address, pool)).to.equal(0);
    await router.connect(user).unsplit(pool, E("50"));
    expect(await base.balanceOf(user.address)).to.equal(E("500"));
  });
  it("requires pool authorisation for direct wrappers and respects pause", async function () {
    const { user, base, router, pool } = await loadFixture(fixture);
    await base.connect(user).approve(pool, E("100"));
    await pool.setAuthorisedRouter(router, false);
    await expect(router.connect(user).split(pool, E("100"))).to.be.revertedWithCustomError(pool, "UnauthorizedCaller");
    await pool.setAuthorisedRouter(router, true);
    await pool.pause();
    await expect(router.connect(user).split(pool, E("100"))).to.be.revertedWithCustomError(pool, "EnforcedPause");
  });
  for (const buyingYb of [true, false]) {
    it(`splitAndBuy delivers only the requested ${buyingYb ? "YB" : "DP"} tranche`, async function () {
      const { user, base, router, swap, pool, dp, yb } = await loadFixture(fixture);
      await pool.setAuthorisedRouter(router, false); // self-counterparty flow
      await router.connect(user).splitAndBuy(pool, swap, 3000, E("50"), E("100"), buyingYb, E("100"), await time.latest() + HOUR);
      expect(await (buyingYb ? yb : dp).balanceOf(user.address)).to.equal(E("100"));
      expect(await (buyingYb ? dp : yb).balanceOf(user.address)).to.equal(0);
      expect(await base.balanceOf(user.address)).to.equal(E("400"));
      expect(await dp.balanceOf(router)).to.equal(0);
      expect(await yb.balanceOf(router)).to.equal(0);
    });
  }
  it("rolls back transfers when swap or combined output slippage fails", async function () {
    const { user, base, router, swap, pool, dp } = await loadFixture(fixture);
    const deadline = await time.latest() + HOUR;
    await expect(router.connect(user).splitAndBuy(pool, swap, 3000, E("51"), E("100"), true, 0, deadline)).to.be.revertedWith("SLIPPAGE");
    await expect(router.connect(user).splitAndBuy(pool, swap, 3000, 0, E("100"), true, E("101"), deadline)).to.be.revertedWithCustomError(router, "InsufficientOutputAmount");
    expect(await base.balanceOf(user.address)).to.equal(E("500"));
    expect(await dp.balanceOf(router)).to.equal(0);
    await swap.setPaused(true);
    await expect(router.connect(user).splitAndBuy(pool, swap, 3000, 0, E("100"), true, 0, deadline)).to.be.revertedWith("PAUSED");
  });
  it("rejects expired deadlines on every swap flow", async function () {
    const { user, router, swap, pool } = await loadFixture(fixture);
    const expired = await time.latest() - 1;
    await expect(router.connect(user).splitAndBuy(pool, swap, 3000, 0, 100, true, 0, expired)).to.be.revertedWithCustomError(router, "DeadlineExceeded");
    await expect(router.connect(user).sellAndUnsplit(pool, swap, 3000, 0, 100, 50, true, 0, expired)).to.be.revertedWithCustomError(router, "DeadlineExceeded");
    await expect(router.connect(user).swapExactIn(pool, swap, 3000, 0, 100, true, expired)).to.be.revertedWithCustomError(router, "DeadlineExceeded");
  });
  it("swaps exact input and enforces the swap minimum", async function () {
    const { admin, user, router, swap, pool, dp, yb } = await loadFixture(fixture);
    await dp.connect(admin).transfer(user.address, E("20"));
    await dp.connect(user).approve(router, E("20"));
    const deadline = await time.latest() + HOUR;
    await expect(router.connect(user).swapExactIn(pool, swap, 3000, E("21"), E("20"), true, deadline)).to.be.revertedWith("SLIPPAGE");
    await router.connect(user).swapExactIn(pool, swap, 3000, E("20"), E("20"), true, deadline);
    expect(await dp.balanceOf(user.address)).to.equal(0);
    expect(await yb.balanceOf(user.address)).to.equal(E("20"));
  });
  for (const sellingYb of [true, false]) {
    it(`sellAndUnsplit exits ${sellingYb ? "YB" : "DP"} and returns the unmatched remainder`, async function () {
      const { user, base, router, swap, pool, dp, yb } = await loadFixture(fixture);
      const token = sellingYb ? yb : dp;
      await token.transfer(user.address, E("100"));
      await token.connect(user).approve(router, E("100"));
      await router.connect(user).sellAndUnsplit(pool, swap, 3000, E("40"), E("100"), E("40"), sellingYb, E("80"), await time.latest() + HOUR);
      expect(await base.balanceOf(user.address)).to.equal(E("580"));
      expect(await token.balanceOf(user.address)).to.equal(E("20"));
    });
  }
  it("records accepted Q-01: a sell also distributes prior router base balances", async function () {
    const { user, base, router, swap, pool, yb } = await loadFixture(fixture);
    await yb.transfer(user.address, E("100"));
    await yb.connect(user).approve(router, E("100"));
    await base.transfer(router, E("7"));
    await router.connect(user).sellAndUnsplit(pool, swap, 3000, 0, E("100"), E("50"), true, E("107"), await time.latest() + HOUR);
    expect(await base.balanceOf(user.address)).to.equal(E("607"));
  });
  it("redeems only after pool resolution, with the fee applied", async function () {
    const { user, base, router, pool, dp, yb } = await loadFixture(fixture);
    await base.connect(user).approve(pool, E("100"));
    await router.connect(user).split(pool, E("100"));
    await expect(router.connect(user).redeem(pool, E("50"), E("50"))).to.be.revertedWithCustomError(pool, "MustBeInRedemptionsState");
    await time.increaseTo(Number(await pool.startTime()) + 10 * DAY);
    await pool.updatePriceData(E("1"), E("0.8"));
    await time.increase(4 * HOUR);
    await pool.resolvePriceDepeg();
    await pool.setRedemptionFeeBp(100);
    await router.connect(user).redeem(pool, E("50"), E("50"));
    expect(await base.balanceOf(user.address)).to.equal(E("499"));
    expect(await dp.balanceOf(user.address)).to.equal(0);
    expect(await yb.balanceOf(user.address)).to.equal(0);
  });
});
