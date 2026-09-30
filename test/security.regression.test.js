const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ADR security regression", function () {
    let sla, vault, registry, resolution, users, buyer, seller, outsider;
    const stake = ethers.parseEther("1"), expertStake = ethers.parseEther("2"), bond = ethers.parseEther("0.5");
    const salt = ethers.id("regression-salt");
    const commit = (vote) => ethers.solidityPackedKeccak256(["uint8", "bytes32"], [vote, salt]);
    const signer = (address) => users.find((user) => user.address === address);

    beforeEach(async function () {
        users = await ethers.getSigners();
        [, buyer, seller, outsider] = users;
        sla = await (await ethers.getContractFactory("SLAContract")).deploy();
        vault = await (await ethers.getContractFactory("EvidenceVault")).deploy();
        registry = await (await ethers.getContractFactory("DisputeRegistry")).deploy();
        resolution = await (await ethers.getContractFactory("DisputeResolution")).deploy(
            await sla.getAddress(), await vault.getAddress(), await registry.getAddress());
        await vault.setResolution(await resolution.getAddress());
        await registry.grantRole(await registry.RESOLUTION_ROLE(), await resolution.getAddress());
        await registry.grantRole(await registry.RESOLUTION_ROLE(), users[0].address);
        for (let i = 4; i < 8; i++) await registry.connect(users[i]).registerArbitrator({ value: stake });
        for (let i = 8; i < 14; i++) await registry.connect(users[i]).registerExpert({ value: expertStake });
        await sla.createSLA(buyer.address, seller.address, 10000, [
            { disputeType: 0, operator: 0, threshold: 100, penaltyBps: 1000 },
            { disputeType: 2, operator: 0, threshold: 0, penaltyBps: 1000 }
        ]);
    });

    async function open(clause = 1, cid = "") {
        await resolution.connect(buyer).createDispute(1, clause, cid);
        return await resolution.disputeCounter();
    }
    async function start(id = 1n) { await resolution.connect(buyer).escalateToTier2(id); }
    async function finish(id = 1n, votes = [1, 1, 2], tier3 = false) {
        const panel = tier3 ? await resolution.getTier3Panel(id) : await resolution.getTier2Jury(id);
        for (let i = 0; i < panel.length; i++) {
            if (votes[i] != null) await resolution.connect(signer(panel[i])).commitVote(id, commit(votes[i]));
        }
        await time.increaseTo(Number((await resolution.disputes(id)).deadline) + 1);
        await resolution.transitionToReveal(id);
        for (let i = 0; i < panel.length; i++) {
            if (votes[i] != null) await resolution.connect(signer(panel[i])).revealVote(id, votes[i], salt);
        }
        await time.increaseTo(Number((await resolution.disputes(id)).deadline) + 1);
        await resolution.finalizeVote(id);
        return panel;
    }

    it("B1 removes withdrawn identities and re-registers without duplicate jury seats", async function () {
        await registry.connect(users[4]).unstake();
        expect(await registry.selectJury(0, 3)).not.to.include(users[4].address);
        await registry.connect(users[4]).registerArbitrator({ value: stake });
        const panel = await registry.selectJury(3, 4);
        expect(new Set(panel).size).to.equal(4);
    });
    it("B1 applies the same uniqueness invariant to experts", async function () {
        await registry.connect(users[8]).unstake();
        expect(await registry.hasRole(await registry.EXPERT_ROLE(), users[8].address)).to.equal(false);
        await registry.connect(users[8]).registerExpert({ value: expertStake });
        expect(new Set(await registry.selectExpertPanel(5, 6)).size).to.equal(6);
    });
    it("B3 rejects under-staked selection and restores eligibility after top-up", async function () {
        await registry.slash(users[4].address, ethers.parseEther("0.1"));
        expect(await registry.selectJury(0, 3)).not.to.include(users[4].address);
        await expect(registry.lockArbitrator(users[4].address)).to.be.revertedWith("Insufficient stake");
        await registry.connect(users[4]).topUpStake({ value: ethers.parseEther("0.1") });
        expect(await registry.selectJury(0, 4)).to.include(users[4].address);
        await expect(registry.connect(users[4]).topUpStake({ value: 1 })).to.be.revertedWith("Invalid top-up");
    });
    it("B3 filters under-staked experts and fails when an eligible panel cannot be filled", async function () {
        await registry.slash(users[8].address, 1);
        expect(await registry.selectExpertPanel(0, 5)).not.to.include(users[8].address);
        await registry.slash(users[9].address, 1);
        await expect(registry.selectExpertPanel(0, 5)).to.be.revertedWith("Not enough experts");
    });
    it("B2 rejects zero commitments", async function () {
        await open(); await start();
        const panel = await resolution.getTier2Jury(1);
        await expect(resolution.connect(signer(panel[0])).commitVote(1, ethers.ZeroHash)).to.be.revertedWith("Empty commitment");
    });
    it("B2 rejects None revealed votes", async function () {
        await open(); await start();
        const panel = await resolution.getTier2Jury(1);
        await resolution.connect(signer(panel[0])).commitVote(1, commit(0));
        await time.increaseTo(Number((await resolution.disputes(1)).deadline) + 1);
        await resolution.transitionToReveal(1);
        await expect(resolution.connect(signer(panel[0])).revealVote(1, 0, salt)).to.be.revertedWith("Invalid ruling");
    });
    for (const [label, votes] of [["no reveals", [null, null, null]], ["one reveal", [1, null, null]], ["split reveals", [1, 2, null]]]) {
        it(`B2 never enforces ${label}; permits expert review or timeout cancellation`, async function () {
            await open(); await start(); const panel = await finish(1n, votes);
            expect((await resolution.disputes(1)).finalRuling).to.equal(0);
            await expect(resolution.enforce(1)).to.be.revertedWith("No substantive ruling");
            for (const address of panel) expect((await registry.arbitrators(address)).activeDisputes).to.equal(0);
            await expect(resolution.cancelDispute(1)).to.be.revertedWith("Window active");
            await time.increaseTo(Number((await resolution.disputes(1)).deadline) + 1);
            await resolution.cancelDispute(1);
            expect((await resolution.disputes(1)).state).to.equal(10);
            await expect(resolution.enforce(1)).to.be.revertedWith("Not resolved");
        });
    }
    it("B2 accepts two coherent votes, releases all locks, slashes only non-revelation", async function () {
        await open(); await start(); const panel = await finish(1n, [1, 1, null]);
        expect((await resolution.disputes(1)).finalRuling).to.equal(1);
        expect((await registry.arbitrators(panel[2])).stakedAmount).to.equal(stake - ethers.parseEther("0.1"));
        expect((await registry.arbitrators(panel[0])).stakedAmount).to.equal(stake);
        for (const address of panel) expect((await registry.arbitrators(address)).activeDisputes).to.equal(0);
        await expect(resolution.finalizeVote(1)).to.be.revertedWith("Not in reveal phase");
    });
    it("B4 allows only a party to request bounded Tier 1 review", async function () {
        await sla.updateMeasuredValue(1, 0, 110); await open(0); await resolution.resolveTier1(1);
        await expect(resolution.escalateToTier2(1)).to.be.revertedWith("Not an SLA party");
        await expect(resolution.enforce(1)).to.be.revertedWith("Appeal window active");
        await resolution.connect(seller).escalateToTier2(1);
        expect((await resolution.disputes(1)).state).to.equal(3);
        await expect(resolution.enforce(1)).to.be.revertedWith("Not resolved");
    });
    it("B4 closes Tier 1 review before permissionless enforcement", async function () {
        await sla.updateMeasuredValue(1, 0, 110); await open(0); await resolution.resolveTier1(1);
        const deadline = Number((await resolution.disputes(1)).deadline);
        await time.setNextBlockTimestamp(deadline);
        await expect(resolution.enforce(1)).to.be.revertedWith("Appeal window active");
        await expect(resolution.connect(buyer).escalateToTier2(1)).to.be.revertedWith("Review window closed");
        await resolution.enforce(1);
        await expect(resolution.enforce(1)).to.be.revertedWith("Not resolved");
    });
    it("B5 validates SLA, clause and party before incrementing the counter", async function () {
        await expect(resolution.connect(outsider).createDispute(1, 1, "")).to.be.revertedWith("Not an SLA party");
        await expect(resolution.connect(buyer).createDispute(0, 0, "")).to.be.revertedWith("SLA not active");
        await expect(resolution.connect(buyer).createDispute(1, 2, "")).to.be.revertedWith("Invalid clauseId");
        expect(await resolution.disputeCounter()).to.equal(0);
        await expect(resolution.resolveTier1(999)).to.be.revertedWith("Invalid state");
    });
    it("B5 rejects outsider appeals and enforces the Tier 2 appeal window", async function () {
        await open(); await start(); await finish();
        await expect(resolution.connect(outsider).appealToTier3(1, { value: bond })).to.be.revertedWith("Not an SLA party");
        await expect(resolution.enforce(1)).to.be.revertedWith("Appeal window active");
        await time.increaseTo(Number((await resolution.disputes(1)).deadline) + 1);
        await expect(resolution.connect(seller).appealToTier3(1, { value: bond })).to.be.revertedWith("Appeal window closed");
        await resolution.enforce(1);
    });
    it("B6 preserves the original initial-evidence submitter", async function () {
        await open(0, "initial");
        const entry = await vault.getEvidence(1, 0);
        expect(entry.submitter).to.equal(buyer.address);
        expect(entry.evidenceHash).to.equal(ethers.id("initial"));
    });
    it("B6 rejects unbound, nonexistent, outsider and forged-forwarder submissions", async function () {
        const fresh = await (await ethers.getContractFactory("EvidenceVault")).deploy();
        await expect(fresh.submitEvidence(1, "x", ethers.id("x"))).to.be.revertedWith("Resolution not configured");
        await expect(vault.connect(buyer).submitEvidence(1, "x", ethers.id("x"))).to.be.revertedWith("Evidence not authorized");
        await open();
        await expect(vault.connect(outsider).submitEvidence(1, "x", ethers.id("x"))).to.be.revertedWith("Evidence not authorized");
        await expect(vault.submitEvidenceFor(1, buyer.address, "x", ethers.id("x"))).to.be.revertedWith("Only resolution");
        await expect(vault.connect(outsider).setResolution(await resolution.getAddress())).to.be.reverted;
        await expect(vault.setResolution(await resolution.getAddress())).to.be.revertedWith("Resolution already configured");
    });
    it("B6 scopes duplicate evidence by party and freezes submissions during voting", async function () {
        await open();
        await vault.connect(buyer).submitEvidence(1, "x", ethers.id("x"));
        await vault.connect(seller).submitEvidence(1, "x", ethers.id("x"));
        await expect(vault.connect(buyer).submitEvidence(1, "x", ethers.id("x"))).to.be.revertedWith("Evidence already submitted");
        expect(await vault.getEvidenceCount(1)).to.equal(2);
        expect(await vault.verifyEvidence(1, 0, ethers.id("x"))).to.equal(true);
        expect(await vault.verifyEvidence(1, 0, ethers.id("wrong"))).to.equal(false);
        await start();
        await expect(vault.connect(buyer).submitEvidence(1, "new", ethers.id("new"))).to.be.revertedWith("Evidence not authorized");
    });
    it("B7 rejects concurrent cross-role registration", async function () {
        await expect(registry.connect(users[4]).registerExpert({ value: expertStake })).to.be.revertedWith("Already registered");
        await expect(registry.connect(users[8]).registerArbitrator({ value: stake })).to.be.revertedWith("Already registered");
    });
    it("B7 excludes original jurors even if they change roles before appeal", async function () {
        await open(); await start(); const jury = await finish();
        await registry.connect(signer(jury[0])).unstake();
        await registry.connect(signer(jury[0])).registerExpert({ value: expertStake });
        await resolution.connect(seller).appealToTier3(1, { value: bond });
        const panel = await resolution.getTier3Panel(1);
        for (const address of jury) expect(panel).not.to.include(address);
    });
    it("B7 excludes SLA parties from both panel types", async function () {
        await registry.connect(buyer).registerArbitrator({ value: stake });
        await registry.connect(seller).registerExpert({ value: expertStake });
        await open(); await start(); const jury = await finish();
        expect(jury).not.to.include(buyer.address);
        await resolution.connect(seller).appealToTier3(1, { value: bond });
        expect(await resolution.getTier3Panel(1)).not.to.include(seller.address);
    });
    it("B8 snapshots oracle status, version, value and timestamp at creation", async function () {
        await sla.updateMeasuredValue(1, 0, 110); await open(0);
        const first = await resolution.measurementSnapshots(1);
        expect(first.status).to.equal(2); expect(first.value).to.equal(110); expect(first.version).to.equal(1);
        expect(first.timestamp).to.equal(await sla.measurementTimestamps(1, 0));
        await sla.updateMeasuredValue(1, 0, 90); await resolution.resolveTier1(1);
        expect((await resolution.disputes(1)).finalRuling).to.equal(1);
        await open(0); await resolution.resolveTier1(2);
        expect((await resolution.disputes(2)).finalRuling).to.equal(2);
        expect((await resolution.measurementSnapshots(2)).version).to.equal(2);
    });
    it("B8 keeps an unmeasured snapshot unevaluable after a later oracle write", async function () {
        await open(0); await sla.updateMeasuredValue(1, 0, 110);
        await expect(resolution.resolveTier1(1)).to.be.revertedWith("Clause not measured");
        await start(); expect((await resolution.disputes(1)).state).to.equal(3);
    });
    it("locks prevent withdrawal and remain correct across concurrent disputes", async function () {
        await open(); await start(); await open(); await start(2n);
        const first = await resolution.getTier2Jury(1), second = await resolution.getTier2Jury(2);
        const shared = first.find((address) => second.includes(address));
        expect((await registry.arbitrators(shared)).activeDisputes).to.equal(2);
        await expect(registry.connect(signer(shared)).unstake()).to.be.revertedWith("Active disputes");
        for (const [id, panel] of [[1, first], [2, second]]) {
            for (const address of panel) await resolution.connect(signer(address)).commitVote(id, commit(1));
        }
        await time.increaseTo(Number((await resolution.disputes(2)).deadline) + 1);
        await resolution.transitionToReveal(1); await resolution.transitionToReveal(2);
        for (const [id, panel] of [[1, first], [2, second]]) {
            for (const address of panel) await resolution.connect(signer(address)).revealVote(id, 1, salt);
        }
        await time.increaseTo(Number((await resolution.disputes(2)).deadline) + 1);
        await resolution.finalizeVote(1); expect((await registry.arbitrators(shared)).activeDisputes).to.equal(1);
        await resolution.finalizeVote(2); expect((await registry.arbitrators(shared)).activeDisputes).to.equal(0);
        await registry.connect(signer(shared)).unstake();
    });
    it("credits and withdraws the appeal bond exactly once after a substantive expert ruling", async function () {
        await open(); await start(); await finish();
        await resolution.connect(seller).appealToTier3(1, { value: bond });
        await expect(resolution.connect(seller).withdrawAppealBond()).to.be.revertedWith("No refundable bond");
        const panel = await finish(1n, [2, 2, 2, 1, 1], true);
        expect((await resolution.disputes(1)).finalRuling).to.equal(2);
        expect((await resolution.disputes(1)).appealBond).to.equal(0);
        expect(await resolution.refundableBonds(seller.address)).to.equal(bond);
        for (const address of panel) expect((await registry.experts(address)).activeDisputes).to.equal(0);
        await resolution.enforce(1);
        await expect(resolution.connect(seller).withdrawAppealBond()).to.changeEtherBalances([resolution, seller], [-bond, bond]);
        await expect(resolution.connect(seller).withdrawAppealBond()).to.be.revertedWith("No refundable bond");
    });
    it("cancels failed expert quorum, releases members and refunds bond even while paused", async function () {
        await open(); await start(); await finish(1n, [null, null, null]);
        await resolution.connect(buyer).appealToTier3(1, { value: bond });
        const panel = await finish(1n, [1, 1, 2, null, null], true);
        expect((await resolution.disputes(1)).state).to.equal(10);
        expect((await resolution.disputes(1)).finalRuling).to.equal(0);
        for (const address of panel) expect((await registry.experts(address)).activeDisputes).to.equal(0);
        await expect(resolution.enforce(1)).to.be.revertedWith("Not resolved");
        await resolution.pause();
        await resolution.connect(buyer).withdrawAppealBond();
        expect(await ethers.provider.getBalance(await resolution.getAddress())).to.equal(0);
    });
    it("rejects an unfillable appeal atomically, preserving its prior ruling and bond balance", async function () {
        await open(); await start(); await finish();
        await registry.connect(users[8]).unstake(); await registry.connect(users[9]).unstake();
        await expect(resolution.connect(seller).appealToTier3(1, { value: bond })).to.be.revertedWith("Not enough experts");
        expect((await resolution.disputes(1)).state).to.equal(5);
        expect((await resolution.disputes(1)).appealBond).to.equal(0);
        expect(await ethers.provider.getBalance(await resolution.getAddress())).to.equal(0);
    });
    it("caps slash events at actual balance and protects all other stakers' principal", async function () {
        await expect(registry.slash(users[4].address, stake * 2n)).to.emit(registry, "Slashed").withArgs(users[4].address, stake);
        expect(await registry.slashedFunds()).to.equal(stake);
        await expect(registry.connect(outsider).withdrawSlashedFunds(outsider.address, stake)).to.be.reverted;
        await expect(registry.withdrawSlashedFunds(users[0].address, stake + 1n)).to.be.revertedWith("Invalid withdrawal");
        await registry.withdrawSlashedFunds(users[0].address, stake);
        expect(await registry.slashedFunds()).to.equal(0);
        const liabilities = 3n * stake + 6n * expertStake;
        expect(await ethers.provider.getBalance(await registry.getAddress())).to.equal(liabilities);
        await registry.connect(users[4]).unstake();
    });
    it("permits timeout cancellation of an unopened voting path and disallows late resolution", async function () {
        await open(0);
        await time.increaseTo(Number((await resolution.disputes(1)).deadline) + 1);
        await expect(resolution.resolveTier1(1)).to.be.revertedWith("Dispute window closed");
        await expect(resolution.connect(buyer).escalateToTier2(1)).to.be.revertedWith("Review window closed");
        await resolution.connect(outsider).cancelDispute(1);
        expect((await resolution.disputes(1)).state).to.equal(10);
    });
    it("gives voters a full reveal window after a late permissionless transition", async function () {
        await open(); await start(); const deadline = (await resolution.disputes(1)).deadline;
        await time.increaseTo(Number(deadline) + 2 * 86400);
        await resolution.transitionToReveal(1);
        expect((await resolution.disputes(1)).deadline).to.equal(BigInt(await time.latest()) + 86400n);
        await time.increaseTo(Number((await resolution.disputes(1)).deadline) + 1);
        await resolution.finalizeVote(1);
        expect((await resolution.disputes(1)).finalRuling).to.equal(0);
    });
    it("validates SLA parties, penalties and clause getters", async function () {
        const clause = [{ disputeType: 0, operator: 0, threshold: 100, penaltyBps: 10001 }];
        await expect(sla.createSLA(buyer.address, buyer.address, 0, clause)).to.be.revertedWith("Invalid parties");
        await expect(sla.createSLA(ethers.ZeroAddress, seller.address, 0, clause)).to.be.revertedWith("Invalid parties");
        await expect(sla.createSLA(buyer.address, seller.address, 0, [])).to.be.revertedWith("No clauses");
        await expect(sla.createSLA(buyer.address, seller.address, 0, clause)).to.be.revertedWith("Invalid penalty");
        await expect(sla.getClause(1, 2)).to.be.revertedWith("Invalid clauseId");
    });
    it("C6 exercises all clause operators and threshold boundaries across additional SLAs", async function () {
        for (let operator = 0; operator < 4; operator++) {
            await sla.createSLA(buyer.address, seller.address, 10000, [{ disputeType: 0, operator, threshold: 100, penaltyBps: 1000 }]);
            const id = 2 + operator;
            expect((await sla.evaluateClause(id, 0))[0]).to.equal(0);
            for (const offset of [-1, 0, 1]) {
                await sla.updateMeasuredValue(id, 0, 100 + offset);
                const breach = [offset > 0, offset < 0, offset === 0, offset !== 0][operator];
                expect((await sla.evaluateClause(id, 0))[0]).to.equal(breach ? 2 : 1);
            }
        }
    });
    it("supports contract-wallet unstaking and rolls back a rejected transfer", async function () {
        const wallet = await (await ethers.getContractFactory("PaymentReceiver")).deploy();
        const address = await wallet.getAddress();
        await wallet.execute(await registry.getAddress(), registry.interface.encodeFunctionData("registerArbitrator"), { value: stake });
        await wallet.configure(true, false, ethers.ZeroAddress, "0x");
        await expect(wallet.execute(await registry.getAddress(), registry.interface.encodeFunctionData("unstake"))).to.be.revertedWith("Stake transfer failed");
        expect((await registry.arbitrators(address)).stakedAmount).to.equal(stake);
        expect(await registry.selectJury(0, 5)).to.include(address);
        await wallet.configure(false, true, await registry.getAddress(), registry.interface.encodeFunctionData("unstake"));
        await wallet.execute(await registry.getAddress(), registry.interface.encodeFunctionData("unstake"));
        expect(await wallet.receipts()).to.equal(1);
        expect(await wallet.reentrySucceeded()).to.equal(false);
        expect((await registry.arbitrators(address)).isRegistered).to.equal(false);
    });
    it("preserves a rejected bond refund and blocks refund reentry from a contract appellant", async function () {
        const wallet = await (await ethers.getContractFactory("PaymentReceiver")).deploy();
        const address = await wallet.getAddress();
        await sla.createSLA(buyer.address, address, 0, [{ disputeType: 2, operator: 0, threshold: 0, penaltyBps: 0 }]);
        await resolution.connect(buyer).createDispute(2, 0, "");
        await start(); await finish();
        await wallet.execute(await resolution.getAddress(), resolution.interface.encodeFunctionData("appealToTier3", [1]), { value: bond });
        await finish(1n, [1, 1, 1, 2, 2], true);
        await wallet.configure(true, false, ethers.ZeroAddress, "0x");
        await expect(wallet.execute(await resolution.getAddress(), resolution.interface.encodeFunctionData("withdrawAppealBond"))).to.be.revertedWith("Bond transfer failed");
        expect(await resolution.refundableBonds(address)).to.equal(bond);
        await wallet.configure(false, true, await resolution.getAddress(), resolution.interface.encodeFunctionData("withdrawAppealBond"));
        await wallet.execute(await resolution.getAddress(), resolution.interface.encodeFunctionData("withdrawAppealBond"));
        expect(await wallet.reentrySucceeded()).to.equal(false);
        expect(await resolution.refundableBonds(address)).to.equal(0);
        expect(await ethers.provider.getBalance(await resolution.getAddress())).to.equal(0);
    });

});
