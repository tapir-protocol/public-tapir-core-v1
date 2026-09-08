import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const DAY = 86400;
const E = ethers.parseEther;
async function fixture() {
 const [admin, operator, user] = await ethers.getSigners();
 const base = await (await ethers.getContractFactory("MockToken")).deploy("Base", "BASE", 18, E("1000"), admin.address);
 const pt = await (await ethers.getContractFactory("MockPendlePT")).deploy(true);
 const pool = await (await ethers.getContractFactory("MockDepegPoolForOracle")).deploy();
 const feed = await (await ethers.getContractFactory("Api3ReaderProxyMock")).deploy(E("1"), await time.latest());
 const router = await (await ethers.getContractFactory("MockPendleRouter")).deploy(pt, user.address, base, E("0.95"));
 const sources = {
  api3ReaderProxyV1IsActive:true,api3ReaderProxyV1:await feed.getAddress(),api3ReaderProxyV1Decimals:18,api3ReaderProxyV1MaxStaleness:DAY,
  chainlinkAggregatorV3IsActive:false,chainlinkAggregatorV3:ethers.ZeroAddress,chainlinkAggregatorV3Decimals:18,chainlinkAggregatorV3MaxStaleness:DAY,
  redStoneClassicIsActive:false,redStoneClassicAggregator:ethers.ZeroAddress,redStoneClassicDecimals:18,redStoneClassicMaxStaleness:DAY,
  tellorIsActive:false,tellorAdapter:ethers.ZeroAddress,tellorDecimals:18,tellorMaxStaleness:DAY
 };
 const cfg = {minCheckpointSpacing:0,minValidSources:1,closingPriceLookbackPeriod:DAY,depegPool:await pool.getAddress(),xChainMode:false,xDomainMessengerL1:ethers.ZeroAddress};
 const oracle = await (await ethers.getContractFactory("TapirPtrwOracle")).deploy("BASE",base,18,sources,cfg,admin.address,
  {pendleBase:await base.getAddress(),pendleRouter:await router.getAddress(),pendleYT:user.address,pendlePT:await pt.getAddress(),errorTolerance:0});
 await oracle.grantRole(await oracle.OPERATOR_ROLE(),operator.address);
 await base.transfer(router,E("1000"));
 return {admin,operator,user,base,pt,pool,feed,router,oracle};
}
describe("TapirPtrwOracle offline integration",function(){
 it("PTRW redemption pays the operator and scales the closing price",async()=>{
  const {operator,base,pt,pool,feed,oracle}=await fixture();
  for(let i=0;i<3;i++) {
   if(i) await time.increase(DAY);
   await feed.setData(E("1"),await time.latest());
   await oracle.connect(operator).recordApi3Price();
   await oracle.connect(operator).checkpoint();
  }
  await pt.mint(oracle,E("100"));
  await oracle.connect(operator).resolvePtrw();
  expect(await base.balanceOf(operator.address)).eq(E("95"));
  await oracle.connect(operator).writePriceData(0);
  expect(await pool.lastHwmPrice()).eq(E("1"));
  expect(await pool.lastClosingPrice()).eq(E("0.95"));
  // Demonstrate that the closing lookback is not a maximum permitted data age.
  await time.increase(30*DAY);
  await oracle.connect(operator).writePriceData(0);
  expect(await pool.lastClosingPrice()).eq(E("0.95"));
 });
 it("PTRW accepted L-01 permits a funded second resolution",async()=>{
  const {operator,pt,router,oracle}=await fixture();
  await pt.mint(oracle,E("100")); await oracle.connect(operator).resolvePtrw();
  await router.setRedemptionRate(E("0.5"));
  await pt.mint(oracle,E("100")); await oracle.connect(operator).resolvePtrw();
  expect(await oracle.ptrwArv()).eq(E("50"));
 });
 it("zero PTRW redemption permits admin fallback",async()=>{
  const {operator,pt,router,oracle}=await fixture();
  await router.setRedemptionRate(0);await pt.mint(oracle,E("100"));
  await oracle.connect(operator).resolvePtrw();
  expect(await oracle.forceManualResolve()).eq(true);
  expect(await oracle.ptrwResolved()).eq(false);
  await oracle.manualBackupResolvePtrw(E("100"),0);
  expect(await oracle.ptrwResolved()).eq(true);
 });
 it("PTRW rejects nonoperators and pre-maturity resolution",async()=>{
  const {user,operator,pt,oracle}=await fixture();
  await pt.mint(oracle,E("100"));
  await expect(oracle.connect(user).resolvePtrw()).revertedWithCustomError(oracle,"AccessControlUnauthorizedAccount");
  await pt.setExpired(false);
  await expect(oracle.connect(operator).resolvePtrw()).revertedWithCustomError(oracle,"MarketNotExpired");
 });
});
