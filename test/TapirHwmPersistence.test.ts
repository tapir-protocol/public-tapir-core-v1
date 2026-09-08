import {expect} from "chai";
import {ethers} from "hardhat";
import {time} from "@nomicfoundation/hardhat-network-helpers";

const DAY = 24 * 60 * 60;
const HALF_HOUR = 30 * 60;
const YEAR = 365 * DAY;
const FOUR_HOURS = 4 * 60 * 60;

describe("Tapir Oracle HWM Persistence (Hashlock M-01 Fix Verification)", function () {
    this.timeout(600_000);

    it("TapirOracle: retains high-water mark after ring wrap", async function () {
        const [deployer, treasury] = await ethers.getSigners();
        const high = ethers.parseEther("2");
        const low = ethers.parseEther("1");

        const Asset = await ethers.getContractFactory("MockToken");
        const asset = await Asset.deploy("Test Token", "TEST", 18, 0, deployer.address);

        const Api3Mock = await ethers.getContractFactory("Api3ReaderProxyMock");
        const api3Source = await Api3Mock.deploy(high, await time.latest());
        
        const ChainlinkMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
        const chainlinkSource = await ChainlinkMock.deploy(high, await time.latest(), 18);

        const RedStoneMock = await ethers.getContractFactory("ChainlinkAggregatorMock");
        const redStoneSource = await RedStoneMock.deploy(high, await time.latest(), 18);

        // Predicted pool address
        const nextNonce = await ethers.provider.getTransactionCount(deployer.address);
        const predictedPool = ethers.getCreateAddress({
            from: deployer.address,
            nonce: nextNonce + 1,
        });

        const sources = {
            api3ReaderProxyV1IsActive: true,
            api3ReaderProxyV1: await api3Source.getAddress(),
            api3ReaderProxyV1Decimals: 18,
            api3ReaderProxyV1MaxStaleness: DAY,
            chainlinkAggregatorV3IsActive: true,
            chainlinkAggregatorV3: await chainlinkSource.getAddress(),
            chainlinkAggregatorV3Decimals: 18,
            chainlinkAggregatorV3MaxStaleness: DAY,
            redStoneClassicIsActive: true,
            redStoneClassicAggregator: await redStoneSource.getAddress(),
            redStoneClassicDecimals: 18,
            redStoneClassicMaxStaleness: DAY,
            tellorIsActive: false,
            tellorAdapter: ethers.ZeroAddress,
            tellorDecimals: 18,
            tellorMaxStaleness: DAY,
        };

        const initialConfig = {
            minCheckpointSpacing: DAY,
            minValidSources: 3,
            closingPriceLookbackPeriod: DAY,
            depegPool: predictedPool,
            xChainMode: false,
            xDomainMessengerL1: ethers.ZeroAddress,
        };

        const Oracle = await ethers.getContractFactory("TapirOracle");
        const oracle = await Oracle.deploy(
            "PP-ASSET",
            await asset.getAddress(),
            18,
            sources,
            initialConfig,
            deployer.address,
        );

        const Pool = await ethers.getContractFactory("DepegPool");
        const pool = await Pool.deploy({
            assetAddress: await asset.getAddress(),
            dpMetadata: {name: "Production Path DP", symbol: "PP-DP"},
            ybMetadata: {name: "Production Path YB", symbol: "PP-YB"},
            oracle: await oracle.getAddress(),
            poolActiveDuration: YEAR,
            name: "Production Path Pool",
            flag: "PP",
            redemptionFeeBp: 0,
            cooldownDuration: FOUR_HOURS,
            poolOwner: deployer.address,
            minPrice: ethers.parseEther("0.5"),
            maxPrice: ethers.parseEther("2"),
            treasury: treasury.address,
            authorisedRouter: ethers.ZeroAddress,
            minPriceAge: FOUR_HOURS,
            xDomainMessengerL2: ethers.ZeroAddress,
        });

        const operatorRole = await oracle.OPERATOR_ROLE();
        await oracle.grantRole(operatorRole, deployer.address);

        async function checkpointAfter(spacing: number) {
            const last = Number(await oracle.lastCheckpointTs());
            const latest = await time.latest();
            const next = last === 0 ? latest + 1 : last + spacing;
            await time.setNextBlockTimestamp(next);
            
            // Update sources to new timestamp
            const [val, ] = await api3Source.read();
            await api3Source.setData(val, next);
            await chainlinkSource.setData(val, next);
            await redStoneSource.setData(val, next);

            await oracle.recordApi3Price();
            await oracle.recordChainlinkPrice();
            await oracle.recordRedStoneClassicPrice();
            await oracle.checkpoint();
        }

        // 3 days of high price
        await checkpointAfter(1);
        await checkpointAfter(DAY);
        await checkpointAfter(DAY);

        // Price falls to 1.0 for 360 days
        await api3Source.setValue(low);
        // Note: chainlink and redstone update in checkpointAfter logic using val from api3Source.read()

        for (let i = 0; i < 360; i++) {
            await checkpointAfter(DAY);
        }

        // Cadence increases
        await oracle.setConfig({...initialConfig, minCheckpointSpacing: HALF_HOUR});
        await checkpointAfter(DAY);
        for (let i = 1; i < 40; i++) {
            await checkpointAfter(HALF_HOUR);
        }

        expect(await oracle.checkpointsCount()).to.equal(400);

        // Resolve
        const activeEnd = Number(await pool.startTime()) + YEAR;
        await time.setNextBlockTimestamp(activeEnd + 1);
        await oracle.writePriceData(0);

        const finalPrice = await pool.finalPriceData();
        expect(finalPrice.hwmPrice).to.equal(high);
        expect(finalPrice.resolutionPrice).to.equal(low);
    });

    it("TapirVrpOracle: retains VRP high-water mark after ring wrap", async function () {
        const [deployer, admin, operator] = await ethers.getSigners();
        const high = ethers.parseUnits("2", 18);
        const low = ethers.parseUnits("1", 18);

        const Vault = await ethers.getContractFactory("Mock4626PreviewVault");
        const vault = await Vault.deploy(high);

        const Api3Mock = await ethers.getContractFactory("Api3ReaderProxyMock");
        const api3Mock = await Api3Mock.deploy(ethers.parseUnits("1", 18), await time.latest());

        const sources = {
            api3ReaderProxyV1IsActive: true,
            api3ReaderProxyV1: await api3Mock.getAddress(),
            api3ReaderProxyV1Decimals: 18,
            api3ReaderProxyV1MaxStaleness: DAY,
            chainlinkAggregatorV3IsActive: false,
            chainlinkAggregatorV3: ethers.ZeroAddress,
            chainlinkAggregatorV3Decimals: 18,
            chainlinkAggregatorV3MaxStaleness: DAY,
            redStoneClassicIsActive: false,
            redStoneClassicAggregator: ethers.ZeroAddress,
            redStoneClassicDecimals: 18,
            redStoneClassicMaxStaleness: DAY,
            tellorIsActive: false,
            tellorAdapter: ethers.ZeroAddress,
            tellorDecimals: 18,
            tellorMaxStaleness: DAY,
        };

        const config = {
            minCheckpointSpacing: DAY,
            minValidSources: 1,
            closingPriceLookbackPeriod: DAY,
            depegPool: deployer.address,
            xChainMode: false,
            xDomainMessengerL1: ethers.ZeroAddress,
        };

        const vaultConfig = {
            vault: await vault.getAddress(),
            witnessShares: ethers.parseUnits("1", 18),
            errorTolerance: 0,
        };

        const Oracle = await ethers.getContractFactory("TapirVrpOracle");
        const oracle = await Oracle.deploy(
            "VRP-ASSET",
            ethers.ZeroAddress,
            18,
            sources,
            config,
            admin.address,
            vaultConfig
        );

        const operatorRole = await oracle.OPERATOR_ROLE();
        await oracle.connect(admin).grantRole(operatorRole, operator.address);

        async function checkpointAfter(spacing: number) {
            const last = Number(await oracle.lastCheckpointTs());
            const latest = await time.latest();
            const next = last === 0 ? latest + 1 : last + spacing;
            await time.setNextBlockTimestamp(next);
            
            const [currentPrice, ] = await api3Mock.read();
            await api3Mock.setData(currentPrice, next);
            await oracle.connect(operator).recordApi3Price();
            await oracle.connect(operator).checkpoint();
        }

        // Establish 2.0 HWM
        await checkpointAfter(1);
        await checkpointAfter(DAY);
        await checkpointAfter(DAY);

        expect(await oracle.vrpHwm()).to.equal(2n * 10n**18n);

        // Drop to 1.0
        await vault.setPreviewPerShare(low);

        for (let i = 0; i < 360; i++) {
            await checkpointAfter(DAY);
        }

        await oracle.connect(admin).setConfig({...config, minCheckpointSpacing: HALF_HOUR});
        await checkpointAfter(DAY);
        for (let i = 1; i < 40; i++) {
            await checkpointAfter(HALF_HOUR);
        }

        expect(await oracle.checkpointsCount()).to.equal(400);
        expect(await oracle.vrpHwm()).to.equal(2n * 10n**18n);
    });
});
