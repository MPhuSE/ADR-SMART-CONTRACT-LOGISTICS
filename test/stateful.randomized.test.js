const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Bounded, reproducible state-sequence exploration on the frozen artifact.
// Not a substitute for Echidna/Foundry or exhaustive model checking.
describe("Seeded state-sequence safety exploration (I1–I5)", function () {
  const mulberry32=(seed)=>{let a=seed>>>0;return()=>{a|=0;a=a+0x6d2b79f5|0;let t=Math.imul(a^a>>>15,1|a);t=(t+Math.imul(t^t>>>7,61|t))^t;return ((t^t>>>14)>>>0)/4294967296;}};
  let s,sla,vault,reg,res;
  beforeEach(async () => {
    s=await ethers.getSigners();
    sla=await (await ethers.getContractFactory("SLAContract")).deploy();
    vault=await (await ethers.getContractFactory("EvidenceVault")).deploy();
    reg=await (await ethers.getContractFactory("DisputeRegistry")).deploy();
    res=await (await ethers.getContractFactory("DisputeResolution")).deploy(await sla.getAddress(),await vault.getAddress(),await reg.getAddress());
    await reg.grantRole(await reg.RESOLUTION_ROLE(),await res.getAddress());
    await reg.grantRole(await reg.RESOLUTION_ROLE(),s[0].address);
    await sla.grantRole(await sla.ORACLE_ROLE(),s[4].address);
    await sla.createSLA(s[1].address,s[2].address,0,[{disputeType:2,operator:0,threshold:100,penaltyBps:1000}]);
  });
  it("P1: no-reveal states can terminate with None over multiple committee rotations",async()=>{
    for (const v of s.slice(5,8)) await reg.connect(v).registerArbitrator({value:ethers.parseEther("1")});
    for(let i=0;i<4;i++){
      await res.createDispute(1,0,"");
      await res.escalateToTier2(i+1);
      await time.increase(86402);await res.transitionToReveal(i+1);
      await time.increase(86402);await res.finalizeVote(i+1);
      await res.enforce(i+1);
      expect((await res.disputes(i+1)).finalRuling).to.equal(0n);
    }
  });
  it("P2: seeded panel rotations expose duplicate registrations",async()=>{
    for (const v of s.slice(5,8))await reg.connect(v).registerArbitrator({value:ethers.parseEther("1")});
    const r=mulberry32(102);
    for(let k=0;k<4;k++){
      await reg.connect(s[5]).unstake();
      await reg.connect(s[5]).registerArbitrator({value:ethers.parseEther("1")});
      const panel=await reg.selectJury(Math.floor(r()*100),3);
      // The history includes duplicate entries even when this offset does not select both.
      expect((await reg.registeredArbitrators(3+k)).toLowerCase()).to.equal(s[5].address.toLowerCase());
      expect(panel.length).to.equal(3);
    }
  });
  it("P3: unrelated accounts can create cases under a third-party SLA",async()=>{
    const r=mulberry32(103);
    for(let i=0;i<6;i++){
      const outsider=s[3+Math.floor(r()*6)];
      await res.connect(outsider).createDispute(1,0,"");
      expect((await res.disputes(i+1)).state).to.equal(1n);
    }
  });
  it("P4: oracle can repeatedly change the predicate result",async()=>{
    await sla.createSLA(s[1].address,s[2].address,0,[{disputeType:0,operator:0,threshold:100,penaltyBps:1000}]);
    const r=mulberry32(104);
    for(let i=0;i<12;i++){
      const breach=r()<0.5;
      await sla.connect(s[4]).updateMeasuredValue(2,0,breach?110:90);
      expect((await sla.evaluateClause(2,0))[0]).to.equal(breach?2n:1n);
    }
  });
  it("P5: finalization permits immediate enforce with no appeal waiting period",async()=>{
    for (const v of s.slice(5,8))await reg.connect(v).registerArbitrator({value:ethers.parseEther("1")});
    for(let i=0;i<3;i++){
      await res.createDispute(1,0,"");
      await res.escalateToTier2(i+1);
      await time.increase(86402);await res.transitionToReveal(i+1);
      await time.increase(86402);await res.finalizeVote(i+1);
      await res.connect(s[3]).enforce(i+1);
      await expect(res.connect(s[2]).appealToTier3(i+1,{value:ethers.parseEther("0.5")})).to.be.revertedWith("Not resolved in Tier 2");
    }
  });
});
