const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Automated Multi-Tier Dispute Resolution", function () {
    let slaContract, evidenceVault, registry, resolution;
    let owner, buyer, seller, oracle, arbitrator1, arbitrator2, arbitrator3, expert1, expert2, expert3, expert4, expert5;
    
    const ARBITRATOR_STAKE = ethers.parseEther("1");
    const EXPERT_STAKE = ethers.parseEther("2");
    
    before(async function () {
        [owner, buyer, seller, oracle, arbitrator1, arbitrator2, arbitrator3, expert1, expert2, expert3, expert4, expert5] = await ethers.getSigners();
    });

    beforeEach(async function () {
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

        await evidenceVault.setResolution(await resolution.getAddress());

        // Grant Roles
        const ORACLE_ROLE = await slaContract.ORACLE_ROLE();
        const RESOLUTION_ROLE = await registry.RESOLUTION_ROLE();
        await slaContract.grantRole(ORACLE_ROLE, oracle.address);
        await registry.grantRole(RESOLUTION_ROLE, await resolution.getAddress());

        // Register Arbitrators
        for (let arb of [arbitrator1, arbitrator2, arbitrator3]) {
            await registry.connect(arb).registerArbitrator({ value: ARBITRATOR_STAKE });
        }

        // Register Experts
        for (let exp of [expert1, expert2, expert3, expert4, expert5]) {
            await registry.connect(exp).registerExpert({ value: EXPERT_STAKE });
        }
    });

    describe("1. SLA tests", function () {
        it("Should create an SLA successfully", async function () {
            const escrowValue = ethers.parseEther("10");
            const clauses = [{
                disputeType: 0, // LateDelivery
                operator: 0, // GreaterThan
                threshold: 1620000000,
                penaltyBps: 1000 // 10%
            }];

            await slaContract.createSLA(buyer.address, seller.address, escrowValue, clauses);
            const sla = await slaContract.slas(1);
            expect(sla.buyer).to.equal(buyer.address);
            expect(sla.seller).to.equal(seller.address);
            expect(sla.clauseCount).to.equal(1);
        });

        it("Late delivery breach", async function () {
            await slaContract.createSLA(buyer.address, seller.address, ethers.parseEther("10"), [{
                disputeType: 0, operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            
            await slaContract.connect(oracle).updateMeasuredValue(1, 0, 110);
            const [status, penalty] = await slaContract.evaluateClause(1, 0);
            expect(status).to.equal(2); // EvalStatus.Breach
            expect(penalty).to.equal(ethers.parseEther("1"));
        });
        
        it("No breach when data is valid", async function () {
            await slaContract.createSLA(buyer.address, seller.address, ethers.parseEther("10"), [{
                disputeType: 0, operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            
            await slaContract.connect(oracle).updateMeasuredValue(1, 0, 90);
            const [status, penalty] = await slaContract.evaluateClause(1, 0);
            expect(status).to.equal(1); // EvalStatus.NoBreach
            expect(penalty).to.equal(0);
        });
    });

    describe("2. Evidence tests", function () {
        it("Submit and verify evidence", async function () {
            await slaContract.createSLA(buyer.address, seller.address, 0, [{
                disputeType: 2, operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            await resolution.connect(buyer).createDispute(1, 0, "");
            const cid = "Qm123";
            const hash = ethers.keccak256(ethers.toUtf8Bytes(cid));
            
            await evidenceVault.connect(buyer).submitEvidence(1, cid, hash);
            
            const count = await evidenceVault.getEvidenceCount(1);
            expect(count).to.equal(1);
            
            const isVerified = await evidenceVault.verifyEvidence(1, 0, hash);
            expect(isVerified).to.be.true;
        });

        it("Verify evidence wrong hash", async function () {
            await slaContract.createSLA(buyer.address, seller.address, 0, [{
                disputeType: 2, operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            await resolution.connect(buyer).createDispute(1, 0, "");
            const cid = "Qm123";
            const hash = ethers.keccak256(ethers.toUtf8Bytes(cid));
            const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
            
            await evidenceVault.connect(buyer).submitEvidence(1, cid, hash);
            const isVerified = await evidenceVault.verifyEvidence(1, 0, wrongHash);
            expect(isVerified).to.be.false;
        });
    });

    describe("3. Tier 1 tests", function () {
        it("LateDelivery auto-resolve buyer wins", async function () {
            await slaContract.createSLA(buyer.address, seller.address, ethers.parseEther("10"), [{
                disputeType: 0, operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            await slaContract.connect(oracle).updateMeasuredValue(1, 0, 110);
            await resolution.connect(buyer).createDispute(1, 0, "");
            
            await resolution.resolveTier1(1);
            const d = await resolution.disputes(1);
            expect(d.state).to.equal(2); // Tier1Resolved
            expect(d.finalRuling).to.equal(1); // BuyerWins
        });

        it("Cannot auto-resolve an unmeasured objective clause (NotEvaluable)", async function () {
            await slaContract.createSLA(buyer.address, seller.address, ethers.parseEther("10"), [{
                disputeType: 0, // LateDelivery
                operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            // No updateMeasuredValue call -> clause is NotEvaluable
            const [status, penalty] = await slaContract.evaluateClause(1, 0);
            expect(status).to.equal(0); // EvalStatus.NotEvaluable
            expect(penalty).to.equal(0);

            await resolution.connect(buyer).createDispute(1, 0, "");
            await expect(resolution.resolveTier1(1)).to.be.revertedWith("Clause not measured");
        });

        it("Cannot auto-resolve subjective Damage", async function () {
            await slaContract.createSLA(buyer.address, seller.address, ethers.parseEther("10"), [{
                disputeType: 2, // Damage
                operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            await slaContract.connect(oracle).updateMeasuredValue(1, 0, 110);
            await resolution.connect(buyer).createDispute(1, 0, "");
            
            await expect(resolution.resolveTier1(1)).to.be.revertedWith("Cannot auto-resolve subjective disputes");
        });
    });

    describe("4. Tier 2 tests", function () {
        it("Majority buyer wins and reveal timeout", async function () {
            await slaContract.createSLA(buyer.address, seller.address, 0, [{
                disputeType: 2, operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            await resolution.connect(buyer).createDispute(1, 0, "");
            await resolution.connect(buyer).escalateToTier2(1);

            // 3 arbitrators commit
            // Arbitrators: arbitrator1, arbitrator2, arbitrator3
            const voteBuyer = 1; // BuyerWins
            const voteSeller = 2; // SellerWins
            const salt = ethers.encodeBytes32String("salt");
            
            // keccak256(abi.encodePacked(uint8(vote), salt))
            const hashBuyer = ethers.solidityPackedKeccak256(["uint8", "bytes32"], [voteBuyer, salt]);
            const hashSeller = ethers.solidityPackedKeccak256(["uint8", "bytes32"], [voteSeller, salt]);

            const juryAddrs = await resolution.getTier2Jury(1);
            const arbitrators = [arbitrator1, arbitrator2, arbitrator3];
            const jurySigners = juryAddrs.map(addr => arbitrators.find(a => a.address === addr));

            await resolution.connect(jurySigners[0]).commitVote(1, hashBuyer);
            await resolution.connect(jurySigners[1]).commitVote(1, hashBuyer);
            await resolution.connect(jurySigners[2]).commitVote(1, hashSeller);

            // transition to reveal
            await time.increase(86401);
            await resolution.transitionToReveal(1);

            await resolution.connect(jurySigners[0]).revealVote(1, voteBuyer, salt);
            await resolution.connect(jurySigners[1]).revealVote(1, voteBuyer, salt);
            // jurySigners[2] doesn't reveal to test timeout / slash

            await time.increase(86401);
            await resolution.finalizeVote(1);

            const d = await resolution.disputes(1);
            expect(d.finalRuling).to.equal(1n); // BuyerWins

            const arb3Prof = await registry.arbitrators(jurySigners[2].address);
            // SLA amount slashed
            expect(arb3Prof.wrongVotes).to.equal(1n);
        });
    });

    describe("5. Tier 3 tests", function () {
        it("Appeal from Tier 2 to Tier 3", async function () {
            // Assume tier 2 resolved
            await slaContract.createSLA(buyer.address, seller.address, 0, [{
                disputeType: 2, operator: 0, threshold: 100, penaltyBps: 1000
            }]);
            await resolution.connect(buyer).createDispute(1, 0, "");
            await resolution.connect(buyer).escalateToTier2(1);
            await time.increase(86401);
            await resolution.transitionToReveal(1);
            await time.increase(86401);
            await resolution.finalizeVote(1); // None remains unresolved; a party may request expert review

            // Appeal
            await resolution.connect(seller).appealToTier3(1, { value: ethers.parseEther("0.5") });
            const d = await resolution.disputes(1);
            expect(d.state).to.equal(6); // Tier3Commit
        });
    });
});
