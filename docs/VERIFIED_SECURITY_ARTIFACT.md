# Source-pinned security characterization (2 November 2026)

## Artifact boundary
- Frozen reference contracts: `48d4c854955d80449a0c94386e0084188973e12a`.
- Compare this pinned revision with the reproducibility branch using GitHub's compare API; no changed paths in `contracts/`. No remediation of those Solidity sources is claimed.
- Transaction-level reference execution: GitHub Actions run 41394436363; 20 fresh Hardhat networks, 20,000 cases and 173,250 case-associated receipts. `scripts/audit_multiseed.py` confirms receipt sum against every case's totalGas.
- Source-aligned characterization: `test/characterization.test.js`, cases C01–C10, plus `test/stateful.randomized.test.js`, P1–P5. All 27 Hardhat tests including 12 original cases passed in run 41401476129.
- Solidity coverage measured from the 27-test combined suite: statements 85.08%, branches 47.27%, functions 88.57%, lines 85.29%. Coverage execution must not be used for gas accounting.

## Five business-logic properties versus executed test witnesses
| Property | Target safety condition | Witnesses on frozen prototype |
|---|---|---|
| I1 | Enforced needs a substantive winner | C01,C02,P1 |
| I2 | Panel identities are unique, registered and currently staked | C03,C04,C05,P2 |
| I3 | Only authorized SLA participants initiate cases and reviews | C06,C07,C08,P3 |
| I4 | Decision input is stable and attributable | C09,P4 |
| I5 | Appeal rights protected from immediate enforce | C10,P5 |

These tests affirm the *existence of counterexamples*. Passing means the source behaves unsafely as asserted. They are not regression tests showing a fix.

## Foundry fuzz-parameterized counterexample exploration
- `foundry-tests/FrozenCounterexamples.t.sol`, five `testFuzz_*` methods, 48 runs each (240 parameterized tests). Tests exercise the same known source-level counterexamples with varying inputs.
- This is bounded parameterized fuzzing, **not** a claim that desired invariants hold. None of the tests proves absence of other violations.
- The workflow `.github/workflows/adr-foundry.yml` uses `set -euo pipefail`; `forge` errors cannot be hidden by the log pipe to `tee`.
- Foundry 1.8.7 / Solidity 0.8.20; the compiled 5-test suite passed on GitHub Actions run 41402488796. Reproducibility requires checking the *actual test-output artifact*, not just a green workflow badge.

## Slither 0.11.6 executed output
Executed via run 41394436363, with JSON, stdout/stderr, version and exit code archived in a separate Actions artifact. The raw analyzer returned 92 detector records: High 0, Medium 4, Low 18, Informational 67, Optimization 3. Its process exit code was 255 (nonzero from findings); the CI step intentionally preserved the raw exit code while uploading findings.

**Four Medium finding triage (not confirmed exploits):**
1. `locked-ether` on `DisputeResolution`: `appealToTier3` accepts 0.5 ETH, but the source does not expose a withdrawal or completed settlement path. This is a directly visible economic-completeness defect; its commercial impact depends on the intended bond policy.
2. `reentrancy-no-eth` on `finalizeVote`: external calls to `registry.slash`, `releaseArbitrator`, `reward` precede assignment to the final state. No exploitability is established by static detection. Review the called implementation and checks-effects-interactions ordering; source does not transfer ETH in this call.
3. `unused-return` on `slaContract.evaluateClause` in `resolveTier1`: the penalty amount is not consumed; consistent with absence of real escrow settlement but requires accurate specification of economic semantics.
4. `unused-return` on `slaContract.getClause` in `resolveTier1`: only the dispute class is used. The ignored operator/threshold/penalty are evaluated separately by `evaluateClause`, so static detection alone does not imply a decision defect.

Slither did **not** automatically establish I1–I5 as business-protocol invariants. The source-aligned tests witness them; automatic generic detectors do not replace workflow-specific formal assertions.

## Reproduction
```bash
npm ci
npx hardhat compile
npx hardhat test
npx hardhat coverage
forge test --match-contract FrozenCounterexamplesFoundry -vv
# full reference repeat on a fresh Hardhat network for each seed
for s in $(seq 1 20); do SEED=$s NUM_DISPUTES=1000 npx hardhat run scripts/runSimulationInstrumented.js --network hardhat; done
```
`scripts/audit_multiseed.py` expects per-seed CSVs organized as `validation/runs/seed_<N>/`. GitHub Actions `adr-verify.yml` implements that copy and audit. `adr-scenarios.yml` runs six policy/fault conditions on 20 seeds each when explicitly dispatched.

## Preservation limitation
GitHub Actions artifacts have a 90-day retention configuration; the full data ZIP and SHA-256 manifest should also be deposited in a permanent repository. **No Zenodo DOI is yet available.**
