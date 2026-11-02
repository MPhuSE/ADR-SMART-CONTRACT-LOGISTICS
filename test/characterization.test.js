const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Characterization tests deliberately document UNSAFE behavior of the unchanged
// historical contracts. A passing test is a reproduced counterexample, not a fix.
describe("Frozen artifact: ten source-aligned negative-path counterexamples", function () {
  let owner, buyer, seller, outsider, oracle, a, b, c, d, e, f;
  let sla, vault, registry, resolution;
  const salt = ethers.encodeBytes32String("characterization");

  async function registerArbs(signers) {
    for (const s of signers) await registry.connect(s).registerArbitrator({value: ethers.parseEther("1")});
  }
  async function registerExperts(signers) {
    for (const s of signers) await registry.connect(s).registerExpert({value: ethers.parseEther("2")});
  }
  async function createSla(disputeType=2) {
    await sla.createSLA(buyer.address, seller.address, ethers.parseEther("1"),
      [{disputeType,operator:0,threshold:100,penaltyBps:1000}]);
  }
  async function opened(disputeType=2) {
    await createSla(disputeType);
    await resolution.connect(buyer).createDispute(1,0,"");
    return 1;
  }
  async function finishWithoutVotes(disputeId=1) {
    await time.increase(86402);
    await resolution.transitionToReveal(disputeId);
    await time.increase(86402);
    await resolution.finalizeVote(disputeId);
  }
  async function finishWithBuyerWinner(disputeId=1) {
    const jury=await resolution.getTier2Jury(disputeId);
    const voters=[a,b,c,d,e,f];
    const byAddress=x=>voters.find(s=>s.address.toLowerCase()===x.toLowerCase());
    const hash=ethers.solidityPackedKeccak256(["uint8","bytes32"],[1,salt]);
    for(const addr of jury) await resolution.connect(byAddress(addr)).commitVote(disputeId,hash);
    await time.increase(86402);
    await resolution.transitionToReveal(disputeId);
    for(const addr of jury) await resolution.connect(byAddress(addr)).revealVote(disputeId,1,salt);
    await time.increase(86402);
    await resolution.finalizeVote(disputeId);
  }

  beforeEach(async function () {
    [owner,buyer,seller,outsider,oracle,a,b,c,d,e,f] = await ethers.getSigners();
    sla = await (await ethers.getContractFactory("SLAContract")).deploy();
    vault = await (await ethers.getContractFactory("EvidenceVault")).deploy();
    registry = await (await ethers.getContractFactory("DisputeRegistry")).deploy();
    resolution = await (await ethers.getContractFactory("DisputeResolution")).deploy(
      await sla.getAddress(),await vault.getAddress(),await registry.getAddress());
    await registry.grantRole(await registry.RESOLUTION_ROLE(),await resolution.getAddress());
    await registry.grantRole(await registry.RESOLUTION_ROLE(),owner.address);
    await sla.grantRole(await sla.ORACLE_ROLE(),oracle.address);
  });

  it("C01 I1: zero reveals reach Enforced with Ruling.None", async function () {
    await registerArbs([a,b,c]); await opened(); await resolution.escalateToTier2(1);
    await finishWithoutVotes();
    expect((await resolution.disputes(1)).finalRuling).to.equal(0n);
    await resolution.enforce(1);
    expect((await resolution.disputes(1)).state).to.equal(9n);
  });
  it("C02 I1: explicit Ruling.None can be revealed", async function () {
    await registerArbs([a,b,c]); await opened(); await resolution.escalateToTier2(1);
    const members=await resolution.getTier2Jury(1);
    const v=[a,b,c].find(s=>s.address.toLowerCase()===members[0].toLowerCase());
    const hash=ethers.solidityPackedKeccak256(["uint8","bytes32"],[0,salt]);
    await resolution.connect(v).commitVote(1,hash);
    await time.increase(86402); await resolution.transitionToReveal(1);
    await expect(resolution.connect(v).revealVote(1,0,salt)).not.to.be.reverted;
  });
  it("C03 I2: withdrawn address remains selectable", async function () {
    await registerArbs([a,b,c]);
    await registry.connect(a).unstake();
    const panel=await registry.selectJury(0,3);
    expect(panel).to.include(a.address);
    expect((await registry.arbitrators(a.address)).isRegistered).to.equal(false);
  });
  it("C04 I2: repeated registration creates duplicate panel identities", async function () {
    await registerArbs([a,b,c]);await registry.connect(a).unstake();
    await registry.connect(a).registerArbitrator({value:ethers.parseEther("1")});
    const panel=await registry.selectJury(2,3);
    expect(new Set(panel.map(x=>x.toLowerCase())).size).to.be.lessThan(3);
  });
  it("C05 I2: under-staked registered address remains selectable", async function () {
    await registerArbs([a,b,c]);
    await registry.slash(a.address,ethers.parseEther("0.5"));
    expect((await registry.arbitrators(a.address)).stakedAmount).to.be.lessThan(ethers.parseEther("1"));
    expect(await registry.selectJury(0,3)).to.include(a.address);
  });
  it("C06 I3: outsider creates dispute for a third-party SLA", async function () {
    await createSla(2);
    await expect(resolution.connect(outsider).createDispute(1,0,"")).not.to.be.reverted;
    expect((await resolution.disputes(1)).state).to.equal(1n);
  });
  it("C07 I3: outsider starts jury escalation", async function () {
    await registerArbs([a,b,c]); await opened();
    await expect(resolution.connect(outsider).escalateToTier2(1)).not.to.be.reverted;
    expect((await resolution.disputes(1)).state).to.equal(3n);
  });
  it("C08 I3: unrelated outsider posts appeal bond and appeals", async function () {
    await registerArbs([a,b,c]);await registerExperts([d,e,f,owner,buyer]);
    await opened();await resolution.escalateToTier2(1);
    await finishWithoutVotes();
    await expect(resolution.connect(outsider).appealToTier3(1,{value:ethers.parseEther("0.5")})).not.to.be.reverted;
    expect((await resolution.disputes(1)).appellant).to.equal(outsider.address);
  });
  it("C09 I4: oracle updates overwrite an earlier measured value", async function () {
    await createSla(0);
    await sla.connect(oracle).updateMeasuredValue(1,0,110);
    expect((await sla.evaluateClause(1,0))[0]).to.equal(2n);
    await sla.connect(oracle).updateMeasuredValue(1,0,90);
    expect((await sla.evaluateClause(1,0))[0]).to.equal(1n);
  });
  it("C10 I5: immediate enforcement pre-empts a subsequent appeal", async function () {
    await registerArbs([a,b,c]);await opened();await resolution.escalateToTier2(1);
    await finishWithBuyerWinner();
    await resolution.connect(outsider).enforce(1);
    await expect(resolution.connect(seller).appealToTier3(1,{value:ethers.parseEther("0.5")})).to.be.revertedWith("Not resolved in Tier 2");
    expect((await resolution.disputes(1)).state).to.equal(9n);
  });
});
