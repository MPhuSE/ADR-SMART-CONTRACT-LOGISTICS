const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Invariant tests", function () {
    let slaContract, evidenceVault, registry, resolution;
    let owner, buyer, seller, oracle, arbitrator1;
    
    beforeEach(async function () {
        [owner, buyer, seller, oracle, arbitrator1] = await ethers.getSigners();
        
        const SLAContract = await ethers.getContractFactory("SLAContract");
        slaContract = await SLAContract.deploy();
        
        const EvidenceVault = await ethers.getContractFactory("EvidenceVault");
        evidenceVault = await EvidenceVault.deploy();
        
        const DisputeRegistry = await ethers.getContractFactory("DisputeRegistry");
        registry = await DisputeRegistry.deploy();
        
        const DisputeResolution = await ethers.getContractFactory("DisputeResolution");
        resolution = await DisputeResolution.deploy(
            await slaContract.getAddress(),
            await evidenceVault.getAddress(),
            await registry.getAddress()
        );

        await registry.grantRole(await registry.RESOLUTION_ROLE(), await resolution.getAddress());
        await slaContract.grantRole(await slaContract.ORACLE_ROLE(), oracle.address);
        await registry.connect(arbitrator1).registerArbitrator({ value: ethers.parseEther("1") });
    });

    it("Safety: A dispute cannot simultaneously be BuyerWins and SellerWins", async function () {
        await slaContract.createSLA(buyer.address, seller.address, 0, [{
            disputeType: 0, operator: 0, threshold: 100, penaltyBps: 1000
        }]);
        await slaContract.connect(oracle).updateMeasuredValue(1, 0, 110);
        await resolution.connect(buyer).createDispute(1, 0, "");
        await resolution.resolveTier1(1);
        
        const d = await resolution.disputes(1);
        expect(d.finalRuling).to.be.oneOf([0n, 1n, 2n]); // Must be exact one state
        expect(d.finalRuling).to.equal(1n); // Specifically BuyerWins, meaning it cannot be SellerWins
    });

    it("Accounting: authorized slash decreases stake and records the actual amount", async function () {
        // Direct registry accounting check, not evidence that minority voters are penalized.
        const initialStake = (await registry.arbitrators(arbitrator1.address)).stakedAmount;
        
        // Let's directly simulate slashing via registry for the invariant test
        await registry.connect(owner).grantRole(await registry.RESOLUTION_ROLE(), owner.address);
        await registry.slash(arbitrator1.address, ethers.parseEther("0.1"));

        const prof = await registry.arbitrators(arbitrator1.address);
        expect(prof.wrongVotes).to.equal(1);
        expect(prof.stakedAmount).to.equal(initialStake - ethers.parseEther("0.1"));
    });
});
