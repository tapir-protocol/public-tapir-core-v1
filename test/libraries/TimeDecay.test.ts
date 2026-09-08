// Run with: npx hardhat test test/TimeDecay.test.ts 

import { expect } from "chai";
import hre, { ethers } from "hardhat";

describe("TimeDecay", function () {
  let timeDecayTest: any;

  // Deploy a test contract that exposes the library functions
  before(async function () {
    const TimeDecayTest = await hre.ethers.getContractFactory("TimeDecayTest");
    timeDecayTest = await TimeDecayTest.deploy();
    await timeDecayTest.waitForDeployment();
  });

  const PRECISION = ethers.parseEther("1"); // 1e18
  const MIN_DECAY = ethers.parseEther("0.05"); // 5% = 5e16
  const SECONDS_IN_DAY = BigInt(24 * 60 * 60);
  const SECONDS_IN_YEAR = BigInt(365 * 24 * 60 * 60);

  describe("calculateDecay", function () {
    describe("Basic functionality", function () {
      it("Should return PRECISION (1e18) at t=0 (start of period)", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = 0n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        // sqrt(1 * 1e36) = 1e18
        expect(decay).to.equal(PRECISION);
      });

      it("Should return MIN_DECAY in the end (t=T)", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = SECONDS_IN_YEAR;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        // sqrt(0) = 0, but clamped to MIN_DECAY
        expect(decay).to.equal(MIN_DECAY);
      });

      it("Should decrease monotonically over time", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        
        const decay0 = await timeDecayTest.calculateDecay(totalDuration, 0n);
        const decay25 = await timeDecayTest.calculateDecay(totalDuration, totalDuration / 4n);
        const decay50 = await timeDecayTest.calculateDecay(totalDuration, totalDuration / 2n);
        const decay75 = await timeDecayTest.calculateDecay(totalDuration, (totalDuration * 3n) / 4n);
        const decay100 = await timeDecayTest.calculateDecay(totalDuration, totalDuration);

        expect(decay0).to.be.gt(decay25);
        expect(decay25).to.be.gt(decay50);
        expect(decay50).to.be.gt(decay75);
        expect(decay75).to.be.gte(decay100); // May equal MIN_DECAY
      });

      it("Should calculate approximately sqrt(0.5) at t=T/2", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = totalDuration / 2n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        // sqrt(0.5) ≈ 0.707106781... * 1e18
        const expectedDecay = ethers.parseEther("0.707106781186547524");
        
        // Allow for minor rounding differences
        const tolerance = 1000n; // 1e-15 in 1e18 precision
        expect(decay).to.be.closeTo(expectedDecay, tolerance);
      });

      it("Should calculate approximately sqrt(0.25) at t=3T/4", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = (totalDuration * 3n) / 4n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        // sqrt(0.25) = 0.5 * 1e18
        const expectedDecay = ethers.parseEther("0.5");
        
        // Allow for minor rounding differences
        const tolerance = 1000n; // 1e-15 in 1e18 precision
        expect(decay).to.be.closeTo(expectedDecay, tolerance);
      });

      it("Should calculate approximately sqrt(0.75) at t=T/4", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = totalDuration / 4n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        // sqrt(0.75) ≈ 0.866025403... * 1e18
        const expectedDecay = ethers.parseEther("0.866025403784438646");
        
        // Allow for minor rounding differences
        const tolerance = 1000n; // 1e-15 in 1e18 precision
        expect(decay).to.be.closeTo(expectedDecay, tolerance);
      });
    });

    describe("MIN_DECAY threshold", function () {
      it("Should apply MIN_DECAY threshold when decay would be below minimum", async function () {
        const totalDuration = 1000000n;
        const elapsedTime = 999999n; // Very close to end

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        // sqrt(1/1000000) ≈ 0.001, which is below MIN_DECAY (0.05)
        expect(decay).to.equal(MIN_DECAY);
      });

      it("Should find the approximate time when MIN_DECAY threshold is reached", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        
        // MIN_DECAY = 0.05
        // sqrt((T-t)/T) = 0.05
        // (T-t)/T = 0.0025
        // t = T * 0.9975
        const timeForMinDecay = (totalDuration * 9975n) / 10000n;
        
        const decayBefore = await timeDecayTest.calculateDecay(totalDuration, timeForMinDecay - 1000n);
        const decayAt = await timeDecayTest.calculateDecay(totalDuration, timeForMinDecay);
        const decayAfter = await timeDecayTest.calculateDecay(totalDuration, timeForMinDecay + 1000n);

        // Before threshold: should be > MIN_DECAY
        expect(decayBefore).to.be.gt(MIN_DECAY);
        
        // At and after threshold: should be MIN_DECAY
        expect(decayAt).to.equal(MIN_DECAY);
        expect(decayAfter).to.equal(MIN_DECAY);
      });
    });

    describe("Different durations", function () {
      it("Should work with 1 day duration", async function () {
        const totalDuration = SECONDS_IN_DAY;
        const elapsedTime = SECONDS_IN_DAY / 2n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        const expectedDecay = ethers.parseEther("0.707106781186547524");
        const tolerance = 1000n; // 1e-15 in 1e18 precision
        expect(decay).to.be.closeTo(expectedDecay, tolerance);
      });

      it("Should work with 30 days duration", async function () {
        const totalDuration = 30n * SECONDS_IN_DAY;
        const elapsedTime = 15n * SECONDS_IN_DAY;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        const expectedDecay = ethers.parseEther("0.707106781186547524");
        const tolerance = 1000n; // 1e-15 in 1e18 precision
        expect(decay).to.be.closeTo(expectedDecay, tolerance);
      });

      it("Should work with 90 days duration", async function () {
        const totalDuration = 90n * SECONDS_IN_DAY;
        const elapsedTime = 45n * SECONDS_IN_DAY;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        const expectedDecay = ethers.parseEther("0.707106781186547524");
        const tolerance = 1000n; // 1e-15 in 1e18 precision
        expect(decay).to.be.closeTo(expectedDecay, tolerance);
      });

      it("Should work with 365 days duration", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = SECONDS_IN_YEAR / 2n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        const expectedDecay = ethers.parseEther("0.707106781186547524");
        const tolerance = 1000n; // 1e-15 in 1e18 precision
        expect(decay).to.be.closeTo(expectedDecay, tolerance);
      });

      it("Should work with very short duration", async function () {
        const totalDuration = 3600n; // 1 hour
        const elapsedTime = 1800n; // 30 minutes

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        const expectedDecay = ethers.parseEther("0.707106781186547524");
        const tolerance = 1000n; // 1e-15 in 1e18 precision
        expect(decay).to.be.closeTo(expectedDecay, tolerance);
      });
    });

    describe("Precision and scaling", function () {
      it("Should maintain 1e18 precision in result", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = 0n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        // Result should be exactly 1e18
        expect(decay).to.equal(PRECISION);
      });


      it("Should not overflow with maximum practical duration", async function () {
        const totalDuration = SECONDS_IN_YEAR + SECONDS_IN_DAY + 3600n; // Leap year duration + buffer
        const elapsedTime = 0n;

        // Should not revert with overflow
        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        expect(decay).to.equal(PRECISION);
      });

      it("Should handle very small remaining ratios correctly", async function () {
        const totalDuration = 1000000n;
        const elapsedTime = 999990n; // 0.001% remaining

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        
        // Should be clamped to MIN_DECAY
        expect(decay).to.equal(MIN_DECAY);
      });
    });

    describe("Edge cases", function () {
      it("Should handle elapsedTime = 0 correctly", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = 0n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        expect(decay).to.equal(PRECISION);
      });

      it("Should handle elapsedTime = totalDuration correctly", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = SECONDS_IN_YEAR;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        expect(decay).to.equal(MIN_DECAY);
      });

      it("Should handle very small durations (1 second)", async function () {
        const totalDuration = 1n;
        const elapsedTime = 0n;

        const decay = await timeDecayTest.calculateDecay(totalDuration, elapsedTime);
        expect(decay).to.equal(PRECISION);
      });

      it("Should revert if totalDuration is 0", async function () {
        const totalDuration = 0n;
        const elapsedTime = 0n;

        await expect(
          timeDecayTest.calculateDecay(totalDuration, elapsedTime)
        ).to.be.revertedWithCustomError(timeDecayTest, "TotalDurationMustBeGreaterThanZero");
      });

      it("Should revert if elapsedTime > totalDuration", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const elapsedTime = SECONDS_IN_YEAR + 1n;

        await expect(
          timeDecayTest.calculateDecay(totalDuration, elapsedTime)
        ).to.be.revertedWithCustomError(timeDecayTest, "ElapsedTimeExceedsTotalDuration");
      });
    });

    describe("Mathematical properties", function () {
      it("Should satisfy: d(0) = 1", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const decay = await timeDecayTest.calculateDecay(totalDuration, 0n);
        expect(decay).to.equal(PRECISION);
      });

      it("Should satisfy: d(t1) > d(t2) for t1 < t2", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const t1 = totalDuration / 4n;
        const t2 = totalDuration / 2n;

        const decay1 = await timeDecayTest.calculateDecay(totalDuration, t1);
        const decay2 = await timeDecayTest.calculateDecay(totalDuration, t2);

        expect(decay1).to.be.gt(decay2);
      });
    });
  });

  describe("calculateDecayDiff", function () {
    describe("Basic functionality", function () {
      it("Should return positive difference when t1 < t2", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const t1 = totalDuration / 4n;
        const t2 = totalDuration / 2n;

        const diff = await timeDecayTest.calculateDecayDiff(totalDuration, t1, t2);
        
        // d(t1) > d(t2), so d(t1) - d(t2) > 0
        expect(diff).to.be.gt(0);
      });

      it("Should return negative difference when t1 > t2", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const t1 = totalDuration / 2n;
        const t2 = totalDuration / 4n;

        const diff = await timeDecayTest.calculateDecayDiff(totalDuration, t1, t2);
        
        // d(t1) < d(t2), so d(t1) - d(t2) < 0
        expect(diff).to.be.lt(0);
      });

      it("Should return zero when t1 = t2", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const t1 = totalDuration / 2n;
        const t2 = totalDuration / 2n;

        const diff = await timeDecayTest.calculateDecayDiff(totalDuration, t1, t2);
        
        expect(diff).to.equal(0);
      });

      it("Should calculate correct difference between start and halfway", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const t1 = 0n;
        const t2 = totalDuration / 2n;

        const diff = await timeDecayTest.calculateDecayDiff(totalDuration, t1, t2);
        
        // d(0) = 1.0, d(T/2) ≈ 0.707, difference ≈ 0.293
        const decay1 = await timeDecayTest.calculateDecay(totalDuration, t1);
        const decay2 = await timeDecayTest.calculateDecay(totalDuration, t2);
        const expectedDiff = decay1 - decay2;
        
        expect(diff).to.equal(expectedDiff);
      });
    });

    describe("Edge cases", function () {
      it("Should handle both times at start (t=0)", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const diff = await timeDecayTest.calculateDecayDiff(totalDuration, 0n, 0n);
        expect(diff).to.equal(0);
      });

      it("Should handle both times at end (t=T)", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const diff = await timeDecayTest.calculateDecayDiff(
          totalDuration,
          totalDuration,
          totalDuration
        );
        expect(diff).to.equal(0);
      });

      it("Should handle large time difference", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const t1 = 0n;
        const t2 = totalDuration;

        const diff = await timeDecayTest.calculateDecayDiff(totalDuration, t1, t2);
        
        // d(0) = 1.0, d(T) = MIN_DECAY, difference = 1.0 - 0.05 = 0.95
        const expectedDiff = PRECISION - MIN_DECAY;
        expect(diff).to.equal(expectedDiff);
      });

      it("Should handle very small time differences", async function () {
        const totalDuration = SECONDS_IN_YEAR;
        const t1 = SECONDS_IN_YEAR / 2n;
        const t2 = (SECONDS_IN_YEAR / 2n) + 1n;

        const diff = await timeDecayTest.calculateDecayDiff(totalDuration, t1, t2);
        
        // Very small difference, but should be > 0
        expect(diff).to.be.gt(0);
        expect(diff).to.be.lt(ethers.parseEther("0.0001")); // Less than 0.01%
      });
    });
  });
});

