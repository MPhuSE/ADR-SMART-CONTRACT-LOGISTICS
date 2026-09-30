> Historical evaluation of source commit `48d4c854955d80449a0c94386e0084188973e12a`. These results are not measurements of the security-remediation contracts. See [security-remediation.md](security-remediation.md) and the separate `results/security-remediation-seed42/` run.

# Evaluation Notes for ADR Prototype

This document provides guidance on how to integrate the generated data (`results.csv`, `gas-report.csv`, `summary.json`) into your research paper for the **"Automated Multi-Tier Dispute Resolution for Supply-Chain Logistics"** protocol.

## Data Extraction

1. **Gas Cost Evaluation**:
   - Use the `results/gas-report.csv` file to populate the "Smart Contract Gas Costs" table in your paper. This clearly shows the overhead introduced by each function.
   - You can cross-reference this with the "Average Gas by Tier" from `results/summary.json` to illustrate how Tier 1 saves gas compared to Tier 2 and Tier 3.

2. **Simulation Results**:
   - The file `results/summary.json` contains aggregate metrics: `correctnessRate`, `tier1Rate`, `tier2Rate`, `tier3Rate`, and `slashingCount`. 
   - Highlight the `tier1Rate` (percentage of disputes resolved automatically) as your primary efficiency metric.
   - Mention the `correctnessRate` (percentage of correct final rulings) and note that the synthetic testing simulates an 80% honest arbitrator pool for Tier 2, which is corrected by Tier 3 appeals.

3. **Performance & Comparison**:
   - Run `node scripts/analyzeResults.js` to view a terminal-based comparison table. You can directly copy this layout into your LaTeX or Word manuscript.
   - Ensure you clarify in your paper that the "Traditional baseline" metrics are illustrative assumptions based on existing literature (e.g., 30+ days resolution time for legal arbitration).

## Slither Static Analysis
- Run `slither . 2> results/slither-report.txt` or simply output the analysis into `results/slither-report.txt`.
- In the paper, summarize the Slither report. Discuss any false positives or acknowledged warnings (like `block.timestamp` usage, which is acceptable in our case since deadlines are in days). This demonstrates a rigorous security-first approach to protocol design.

## Integrating to the Manuscript
- **Section: Experimental Setup**: Mention Hardhat local node simulation with 1000 synthetic disputes following the specified probability distribution (LateDelivery 30%, etc.).
- **Section: Results - Gas Optimization**: Cite the numbers from `gas-report.csv`.
- **Section: Results - Protocol Fairness**: Cite `slashingCount` and `fairnessScore` from `summary.json`. Explain how minority slashing prevents malicious voting.
- **Section: Results - Resolution Time**: Compare the auto-resolve (< 5 minutes) vs Tier 3 (up to 4 days), showing massive improvements over traditional arbitration.
