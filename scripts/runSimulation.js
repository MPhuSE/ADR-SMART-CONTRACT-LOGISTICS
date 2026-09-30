// Source-aligned synthetic evaluation of the multi-tier ADR prototype.
//
// What this script does and does NOT claim:
//   * It is a LOCAL Hardhat experiment, not a public-chain deployment.
//   * Tier 1 outcomes are deterministic: an oracle writes a measurement that is
//     constructed to match a generated ground truth, so Tier 1 "correctness" is
//     a mechanism sanity check, not a measurement of adjudication quality.
//   * Tier 2 (jury) and Tier 3 (expert panel) outcomes are STOCHASTIC. Each
//     voter is honest with a fixed probability and the on-chain commit-reveal
//     tally decides the ruling. Tier 3 is reached only by a genuine appeal of a
//     Tier 2 result, so the appeal path is exercised, not bypassed.
//
// Reproducibility: all randomness comes from a seeded PRNG (SEED env var,
// default 42). Re-running with the same SEED reproduces the run exactly.

const hre = require("hardhat");
const { ethers } = require("hardhat");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const OUTPUT_DIR = process.env.OUT || "results/security-fix";
const { createObjectCsvWriter } = require("csv-writer");

// ---- Seeded PRNG (mulberry32) -------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- Experiment parameters (documented, overridable) --------------------------
const SEED = parseInt(process.env.SEED || "42", 10);
const NUM_DISPUTES = parseInt(process.env.NUM_DISPUTES || "1000", 10);
const P_ARB_HONEST = parseFloat(process.env.P_ARB_HONEST || "0.8"); // per-vote correctness
const P_EXP_HONEST = parseFloat(process.env.P_EXP_HONEST || "0.9"); // per-vote correctness
const P_APPEAL = parseFloat(process.env.P_APPEAL || "0.4"); // P(losing party appeals a Tier 2 ruling)
const ARBITRATOR_POOL_SIZE = parseInt(process.env.ARBITRATOR_POOL_SIZE || "10", 10);
const EXPERT_POOL_SIZE = parseInt(process.env.EXPERT_POOL_SIZE || "6", 10);

function validateParameters() {
    const probabilities = { P_ARB_HONEST, P_EXP_HONEST, P_APPEAL };
    for (const [name, value] of Object.entries(probabilities)) {
        if (!Number.isFinite(value) || value < 0 || value > 1) {
            throw new Error(`${name} must be a number in [0, 1]; received ${value}`);
        }
    }
    if (!Number.isInteger(SEED) || !Number.isInteger(NUM_DISPUTES) || NUM_DISPUTES <= 0) {
        throw new Error("SEED must be an integer and NUM_DISPUTES must be a positive integer.");
    }
    if (!Number.isInteger(ARBITRATOR_POOL_SIZE) || ARBITRATOR_POOL_SIZE < 3) {
        throw new Error("ARBITRATOR_POOL_SIZE must be an integer >= 3.");
    }
    if (!Number.isInteger(EXPERT_POOL_SIZE) || EXPERT_POOL_SIZE < 5) {
        throw new Error("EXPERT_POOL_SIZE must be an integer >= 5.");
    }
}

const rng = mulberry32(SEED);
const flip = (p) => rng() < p;
const coin = () => (rng() < 0.5 ? 1 : 2); // 1 = Buyer, 2 = Seller

// ---- Statistics helpers -------------------------------------------------------
// Wilson score 95% CI for a binomial proportion (robust for small/extreme p).
function wilson95(correct, n) {
    if (n === 0) return [0, 0];
    const z = 1.959963984540054;
    const phat = correct / n;
    const denom = 1 + (z * z) / n;
    const center = phat + (z * z) / (2 * n);
    const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
    return [(center - margin) / denom, (center + margin) / denom];
}

// Probability that a majority of `n` voters (n odd), each correct w.p. p, is correct.
function majorityCorrect(n, p) {
    function choose(a, b) {
        let r = 1;
        for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1);
        return r;
    }
    let prob = 0;
    const need = Math.floor(n / 2) + 1;
    for (let k = need; k <= n; k++) {
        prob += choose(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
    }
    return prob;
}

async function main() {
    validateParameters();
    console.log(`Starting simulation: SEED=${SEED}, N=${NUM_DISPUTES}, ` +
        `P_ARB_HONEST=${P_ARB_HONEST}, P_EXP_HONEST=${P_EXP_HONEST}, P_APPEAL=${P_APPEAL}`);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Per-operation gas accumulator (feeds the reproducible per-operation table).
    const gasReportMap = {};
    function trackGas(fnName, gasUsed) {
        if (!gasReportMap[fnName]) gasReportMap[fnName] = { sum: 0n, count: 0 };
        gasReportMap[fnName].sum += gasUsed;
        gasReportMap[fnName].count++;
    }

    const [owner, buyer, seller, oracle, ...others] = await ethers.getSigners();

    // Deploy
    const slaContract = await (await ethers.getContractFactory("SLAContract")).deploy();
    await slaContract.waitForDeployment();
    const evidenceVault = await (await ethers.getContractFactory("EvidenceVault")).deploy();
    await evidenceVault.waitForDeployment();
    const registry = await (await ethers.getContractFactory("DisputeRegistry")).deploy();
    await registry.waitForDeployment();
    const resolution = await (await ethers.getContractFactory("DisputeResolution")).deploy(
        await slaContract.getAddress(),
        await evidenceVault.getAddress(),
        await registry.getAddress()
    );
    await resolution.waitForDeployment();

    await evidenceVault.setResolution(await resolution.getAddress());

    // Roles
    await slaContract.grantRole(await slaContract.ORACLE_ROLE(), oracle.address);
    await registry.grantRole(await registry.RESOLUTION_ROLE(), await resolution.getAddress());

    // Register staked voters. Hardhat's default 20 accounts leave 16 accounts
    // after owner/buyer/seller/oracle; the reproducible default is therefore
    // 10 arbitrators + 6 experts. Keep these sizes explicit and fail early if
    // a custom network exposes too few signers.
    const ARBITRATOR_STAKE = ethers.parseEther("1");
    const EXPERT_STAKE = ethers.parseEther("2");
    if (others.length < ARBITRATOR_POOL_SIZE + EXPERT_POOL_SIZE) {
        throw new Error(
            `Need ${ARBITRATOR_POOL_SIZE + EXPERT_POOL_SIZE} voter signers after the four role accounts, ` +
            `but only ${others.length} are available.`
        );
    }
    const arbitrators = others.slice(0, ARBITRATOR_POOL_SIZE);
    const experts = others.slice(ARBITRATOR_POOL_SIZE, ARBITRATOR_POOL_SIZE + EXPERT_POOL_SIZE);
    for (const arb of arbitrators) {
        const rc = await (await registry.connect(arb).registerArbitrator({ value: ARBITRATOR_STAKE })).wait();
        trackGas("registerArbitrator", rc.gasUsed);
    }
    for (const exp of experts) {
        const rc = await (await registry.connect(exp).registerExpert({ value: EXPERT_STAKE })).wait();
        trackGas("registerExpert", rc.gasUsed);
    }

    // One reusable SLA with one clause per dispute type.
    {
        const rc = await (await slaContract.createSLA(buyer.address, seller.address, ethers.parseEther("1"), [
            { disputeType: 0, operator: 0, threshold: 100, penaltyBps: 1000 },
            { disputeType: 1, operator: 1, threshold: 1000, penaltyBps: 1000 },
            { disputeType: 2, operator: 0, threshold: 0, penaltyBps: 1000 },
            { disputeType: 3, operator: 0, threshold: 0, penaltyBps: 1000 },
            { disputeType: 4, operator: 0, threshold: 200, penaltyBps: 1000 },
        ])).wait();
        trackGas("createSLA", rc.gasUsed);
    }
    const slaId = 1;
    const salt = ethers.encodeBytes32String("salt");

    // Configured waits for the exercised path, including any unexercised review
    // window that must expire before enforcement. Not human wall-clock latency.
    const TIER_WINDOW_MIN = { 1: 24 * 60, 2: 3 * 24 * 60, 3: 4 * 24 * 60 };

    const csvWriter = createObjectCsvWriter({
        path: path.join(OUTPUT_DIR, "results.csv"),
        header: [
            { id: "disputeId", title: "disputeId" },
            { id: "type", title: "type" },
            { id: "tier", title: "tier" },
            { id: "expectedWinner", title: "expectedWinner" },
            { id: "actualWinner", title: "actualWinner" },
            { id: "correct", title: "correct" },
            { id: "tier2Winner", title: "tier2Winner" },
            { id: "tier2Correct", title: "tier2Correct" },
            { id: "openGas", title: "openGas" },
            { id: "resolveGas", title: "resolveGas" },
            { id: "enforceGas", title: "enforceGas" },
            { id: "totalGas", title: "totalGas" },
            { id: "configuredWindowMinutes", title: "configuredWindowMinutes" },
            { id: "arbitratorCount", title: "arbitratorCount" },
            { id: "expertCount", title: "expertCount" },
            { id: "appealed", title: "appealed" },
        ],
    });

    // Run a commit-reveal voting round on the current tier and return the on-chain
    // majority ruling (1/2/0). `voters` are signer objects; honesty draws decide votes.
    async function votingRound(disputeId, voters, pHonest, expectedWinner, addGas) {
        const votes = [];
        for (const v of voters) {
            const honest = flip(pHonest);
            const vote = honest ? expectedWinner : expectedWinner === 1 ? 2 : 1;
            votes.push(vote);
            const hash = ethers.solidityPackedKeccak256(["uint8", "bytes32"], [vote, salt]);
            const rc = await (await resolution.connect(v).commitVote(disputeId, hash)).wait();
            addGas(rc.gasUsed);
            trackGas("commitVote", rc.gasUsed);
        }
        await hre.network.provider.send("evm_increaseTime", [86401]);
        await hre.network.provider.send("evm_mine");
        const transitionRc = await (await resolution.transitionToReveal(disputeId)).wait();
        addGas(transitionRc.gasUsed);
        trackGas("transitionToReveal", transitionRc.gasUsed);

        for (let j = 0; j < voters.length; j++) {
            const rc = await (await resolution.connect(voters[j]).revealVote(disputeId, votes[j], salt)).wait();
            addGas(rc.gasUsed);
            trackGas("revealVote", rc.gasUsed);
        }
        await hre.network.provider.send("evm_increaseTime", [86401]);
        await hre.network.provider.send("evm_mine");
        const rc = await (await resolution.finalizeVote(disputeId)).wait();
        addGas(rc.gasUsed);
        trackGas("finalizeVote", rc.gasUsed);

        const d = await resolution.disputes(disputeId);
        return Number(d.finalRuling);
    }

    const results = [];
    let appealCount = 0;

    for (let i = 1; i <= NUM_DISPUTES; i++) {
        // Sample dispute type from the documented input distribution.
        const r = rng();
        let type;
        if (r < 0.3) type = 0; // LateDelivery
        else if (r < 0.5) type = 1; // Shortage
        else if (r < 0.7) type = 2; // Damage
        else if (r < 0.85) type = 3; // DeliveryDenial
        else type = 4; // PaymentDelay

        let expectedWinner = coin();
        let openGas = 0n, resolveGas = 0n, enforceGas = 0n;
        const addResolve = (g) => { resolveGas += g; };

        // Tier 1 disputes: oracle writes a measurement consistent with ground truth.
        if (type === 0) {
            await (await slaContract.connect(oracle).updateMeasuredValue(slaId, type, expectedWinner === 1 ? 110 : 90)).wait();
        } else if (type === 1) {
            await (await slaContract.connect(oracle).updateMeasuredValue(slaId, type, expectedWinner === 1 ? 900 : 1100)).wait();
        } else if (type === 4) {
            // Payment delay: breach -> seller wins.
            expectedWinner = flip(0.5) ? 2 : 1;
            await (await slaContract.connect(oracle).updateMeasuredValue(slaId, type, expectedWinner === 2 ? 210 : 190)).wait();
        }

        // Open dispute + anchor one piece of evidence.
        let rc = await (await resolution.connect(buyer).createDispute(slaId, type, "")).wait();
        openGas += rc.gasUsed; trackGas("createDispute", rc.gasUsed);
        rc = await (await evidenceVault.connect(buyer).submitEvidence(i, "QmHash", ethers.keccak256(ethers.toUtf8Bytes("QmHash")))).wait();
        openGas += rc.gasUsed; trackGas("submitEvidence", rc.gasUsed);

        let tier, actualWinner, arbitratorCount = 0, expertCount = 0, appealed = false;
        let tier2Ruling = null; // the jury's own ruling, recorded before any appeal
        const isSubjective = type === 2 || type === 3;

        if (!isSubjective) {
            // Tier 1 deterministic resolution.
            rc = await (await resolution.resolveTier1(i)).wait();
            addResolve(rc.gasUsed); trackGas("resolveTier1", rc.gasUsed);
            actualWinner = Number((await resolution.disputes(i)).finalRuling);
            tier = 1;
        } else {
            // Tier 2 jury (stochastic commit-reveal).
            rc = await (await resolution.connect(buyer).escalateToTier2(i)).wait();
            addResolve(rc.gasUsed); trackGas("escalateToTier2", rc.gasUsed);
            arbitratorCount = 3;
            const jury = (await resolution.getTier2Jury(i)).map((a) => arbitrators.find((s) => s.address === a));
            let ruling = await votingRound(i, jury, P_ARB_HONEST, expectedWinner, addResolve);
            tier2Ruling = ruling; // jury's own ruling, independent of any later appeal
            actualWinner = ruling;
            tier = 2;

            // Genuine appeal: the losing party appeals with probability P_APPEAL.
            if (ruling !== 0 && flip(P_APPEAL)) {
                const loser = ruling === 1 ? seller : buyer; // appellant = party that lost Tier 2
                rc = await (await resolution.connect(loser).appealToTier3(i, { value: ethers.parseEther("0.5") })).wait();
                addResolve(rc.gasUsed); trackGas("appealToTier3", rc.gasUsed);
                appealCount++; appealed = true; expertCount = 5;

                const panel = (await resolution.getTier3Panel(i)).map((a) => experts.find((s) => s.address === a));
                actualWinner = await votingRound(i, panel, P_EXP_HONEST, expectedWinner, addResolve);
                tier = 3;
            }
        }

        const terminal = await resolution.disputes(i);
        if (terminal.state !== 8n) await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(terminal.deadline) + 1]);
        rc = await (await resolution.enforce(i)).wait();
        enforceGas += rc.gasUsed; trackGas("enforce", rc.gasUsed);

        const correct = actualWinner === expectedWinner;
        const totalGas = openGas + resolveGas + enforceGas;
        results.push({
            disputeId: i, type, tier, expectedWinner, actualWinner,
            correct: correct ? "Yes" : "No",
            tier2Winner: tier2Ruling === null ? "" : tier2Ruling,
            tier2Correct: tier2Ruling === null ? "" : (tier2Ruling === expectedWinner ? "Yes" : "No"),
            openGas: openGas.toString(), resolveGas: resolveGas.toString(),
            enforceGas: enforceGas.toString(), totalGas: totalGas.toString(),
            configuredWindowMinutes: TIER_WINDOW_MIN[tier],
            arbitratorCount, expertCount, appealed: appealed ? "Yes" : "No",
        });

        if (i % 100 === 0) console.log(`Processed ${i}/${NUM_DISPUTES} disputes`);
    }

    await csvWriter.writeRecords(results);
    console.log(path.join(OUTPUT_DIR, "results.csv") + " written");

    // ---- Aggregate summary -----------------------------------------------------
    const byTier = { 1: [], 2: [], 3: [] };
    const byType = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    for (const row of results) {
        byTier[row.tier].push(row);
        byType[row.type].push(row);
    }
    const rate = (rows) => (rows.length ? rows.filter((r) => r.correct === "Yes").length / rows.length : 0);
    const meanGas = (rows) => (rows.length ? rows.reduce((s, r) => s + Number(r.totalGas), 0) / rows.length : 0);
    const nCorrect = (rows) => rows.filter((r) => r.correct === "Yes").length;

    const typeNames = ["LateDelivery", "Shortage", "Damage", "DeliveryDenial", "PaymentDelay"];
    const correctnessByType = {};
    for (let t = 0; t < 5; t++) {
        const rows = byType[t];
        const ci = wilson95(nCorrect(rows), rows.length);
        correctnessByType[typeNames[t]] = {
            n: rows.length,
            correct: nCorrect(rows),
            rate: +(rate(rows) * 100).toFixed(1),
            ci95: [+(ci[0] * 100).toFixed(1), +(ci[1] * 100).toFixed(1)],
        };
    }

    // Tier 2 jury accuracy is measured from the jury's OWN ruling (tier2Correct),
    // over every subjective dispute that received a Tier 2 ruling -- including the
    // ones later appealed, whose final outcome reflects the expert panel, not the
    // jury. Using the final `correct` flag here would mix the two and inflate the
    // jury's apparent accuracy.
    const juryRows = results.filter((r) => r.tier2Correct === "Yes" || r.tier2Correct === "No");
    const juryCorrect = juryRows.filter((r) => r.tier2Correct === "Yes").length;
    const tier2Ci = wilson95(juryCorrect, juryRows.length);
    const tier3Ci = wilson95(nCorrect(byTier[3]), byTier[3].length);

    const summary = {
        artifactVersion: "security-fix (new contracts; not the archived manuscript measurements)",
        seed: SEED,
        schemaVersion: 3,
        implementationHashes: Object.fromEntries(["SLAContract", "EvidenceVault", "DisputeRegistry", "DisputeResolution"].map((name) => [name,
            crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "contracts", name + ".sol"))).digest("hex")])),
        params: {
            numDisputes: NUM_DISPUTES,
            pArbHonest: P_ARB_HONEST,
            pExpHonest: P_EXP_HONEST,
            pAppeal: P_APPEAL,
            typeProbabilities: [0.30, 0.20, 0.20, 0.15, 0.15],
            arbitratorPoolSize: arbitrators.length,
            expertPoolSize: experts.length,
        },
        totalDisputes: NUM_DISPUTES,
        routing: {
            tier1: { n: byTier[1].length, rate: +(byTier[1].length / NUM_DISPUTES * 100).toFixed(1) },
            tier2: { n: byTier[2].length, rate: +(byTier[2].length / NUM_DISPUTES * 100).toFixed(1) },
            tier3: { n: byTier[3].length, rate: +(byTier[3].length / NUM_DISPUTES * 100).toFixed(1) },
            note: "Routing is determined by a fixed type->tier map plus genuine appeals; Tier 1/2 shares restate the input type distribution, Tier 3 share is emergent from appeals.",
        },
        appeals: {
            nEligible: juryRows.length,
            nAppealed: appealCount,
            conditionalRate: +(juryRows.length ? appealCount / juryRows.length * 100 : 0).toFixed(1),
            overallShare: +(appealCount / NUM_DISPUTES * 100).toFixed(1),
            note: "conditionalRate uses all Tier 2 jury rulings as the denominator; overallShare uses all disputes.",
        },
        // Backward-compatible alias. This is now the scientifically relevant
        // conditional rate, not the appealed share of all disputes.
        appealRate: +(juryRows.length ? appealCount / juryRows.length * 100 : 0).toFixed(1),
        overallAppealShare: +(appealCount / NUM_DISPUTES * 100).toFixed(1),
        correctness: {
            overall: { rate: +(rate(results) * 100).toFixed(1), n: results.length, correct: nCorrect(results) },
            note: "Tier 1 is deterministic (mechanism check, not adjudication accuracy). Only Tier 2/Tier 3 are stochastic.",
            byType: correctnessByType,
            tier2Jury: {
                n: juryRows.length, correct: juryCorrect,
                observedRate: +(juryRows.length ? juryCorrect / juryRows.length * 100 : 0).toFixed(1),
                ci95: [+(tier2Ci[0] * 100).toFixed(1), +(tier2Ci[1] * 100).toFixed(1)],
                theoreticalRate: +(majorityCorrect(3, P_ARB_HONEST) * 100).toFixed(1),
                note: "Measured from the jury's own ruling over all subjective disputes, independent of appeal.",
            },
            tier3Expert: {
                n: byTier[3].length, correct: nCorrect(byTier[3]),
                observedRate: +(rate(byTier[3]) * 100).toFixed(1),
                ci95: [+(tier3Ci[0] * 100).toFixed(1), +(tier3Ci[1] * 100).toFixed(1)],
                theoreticalRate: +(majorityCorrect(5, P_EXP_HONEST) * 100).toFixed(1),
            },
        },
        gasByTier: {
            1: { meanTotalGas: Math.round(meanGas(byTier[1])), n: byTier[1].length },
            2: { meanTotalGas: Math.round(meanGas(byTier[2])), n: byTier[2].length },
            3: { meanTotalGas: Math.round(meanGas(byTier[3])), n: byTier[3].length },
            note: "meanTotalGas = open + resolve + enforce gas summed over the full on-chain path of disputes whose terminal tier is the key. Tier 3 includes its Tier 2 phase + appeal, so Tier3 >= Tier2 by construction.",
        },
        gasAccounting: {
            includedInPerCase: ["createDispute", "submitEvidence", "resolveTier1 or voting path", "enforce"],
            excludedFromPerCase: ["deployments", "role grants", "vault binding", "updateMeasuredValue", "createSLA", "voter registration", "bond withdrawal"],
            note: "transitionToReveal is included in resolveGas and is also recorded separately in gas-report.csv from schemaVersion 2 onward.",
        },
        configuredWindows: {
            tier1Minutes: TIER_WINDOW_MIN[1], tier2Minutes: TIER_WINDOW_MIN[2], tier3Minutes: TIER_WINDOW_MIN[3],
            note: "Configured waits on the exercised immediate-routing path: Tier 1 includes its review window; Tier 2 includes jury commit/reveal plus appeal window; Tier 3 appeals immediately and includes jury/expert commit/reveal only. NOT measured human latency.",
        },
        slashing: {
            nonRevealSlash: 0,
            note: "Minority voters are not slashed. This choice alone does not establish incentive compatibility or eliminate herding. Slashing applies only to non-revelation; under the independent-vote model all voters reveal, so no slashing events occur in this run.",
        },
    };

    fs.writeFileSync(path.join(OUTPUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(path.join(OUTPUT_DIR, "summary.json") + " written");

    // Per-operation gas table (pure gas units, well-defined denominator = call count).
    let gasCsv = "Function,AverageGas,Calls\n";
    for (const fn in gasReportMap) {
        const avg = Math.round(Number(gasReportMap[fn].sum) / gasReportMap[fn].count);
        gasCsv += `${fn},${avg},${gasReportMap[fn].count}\n`;
    }
    fs.writeFileSync(path.join(OUTPUT_DIR, "gas-report.csv"), gasCsv);
    console.log(path.join(OUTPUT_DIR, "gas-report.csv") + " written");

    console.log("\nDone.");
    console.log(`Tier routing: T1=${summary.routing.tier1.rate}%  T2=${summary.routing.tier2.rate}%  T3=${summary.routing.tier3.rate}%`);
    console.log(`Appeals: ${summary.appeals.nAppealed}/${summary.appeals.nEligible} jury rulings (${summary.appeals.conditionalRate}%); ${summary.appeals.overallShare}% of all disputes`);
    console.log(`Tier 2 jury correctness: observed ${summary.correctness.tier2Jury.observedRate}% (95% CI ${summary.correctness.tier2Jury.ci95.join("-")}%), theoretical ${summary.correctness.tier2Jury.theoreticalRate}%`);
    console.log(`Tier 3 expert correctness: observed ${summary.correctness.tier3Expert.observedRate}% (n=${summary.correctness.tier3Expert.n}), theoretical ${summary.correctness.tier3Expert.theoreticalRate}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
