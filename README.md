# Multi-tier ADR for logistics — security remediation

This research prototype links SLA clause evaluation, evidence metadata, a three-person jury and a five-person expert appeal. This branch repairs the reproducible Solidity defects found while reviewing the manuscript. It is based on `revise-adr-per-review` at commit `48d4c854955d80449a0c94386e0084188973e12a`.

## Install and validate

Use Node 24.19.0 (`.nvmrc`). The original lockfile pins Hardhat 2.28.6 and OpenZeppelin Contracts 5.6.1. Compilation uses Solidity 0.8.20, optimizer 200 runs, Paris EVM target and a local Shanghai hardfork.

```bash
npm ci
npm run compile
npm test
npx hardhat run scripts/deploy.js
SEED=42 NUM_DISPUTES=1000 npm run simulate
```

There are 45 passing tests: 12 original functional/accounting tests and 33 security regression tests. `contracts/test/PaymentReceiver.sol` is a test fixture only; the deployment script deploys the four production prototype contracts. GitHub Actions runs compilation, tests and a 20-case smoke simulation.

Deployment now calls `EvidenceVault.setResolution(resolutionAddress)` once and grants `DisputeRegistry.RESOLUTION_ROLE` to the resolution contract. Use a **new deployment**: existing contracts are not upgradeable, and this repository change does not patch already-deployed bytecode. `scripts/deploy.js` defaults to an ephemeral local Hardhat network; publishing this code is not a public-chain deployment.

## Repaired behavior

| Review group | New behavior |
|---|---|
| B1: duplicate membership | Unstaking removes the address from its pool; re-registration adds one unique entry. |
| B2: None, ties, quorum | Reveals accept BuyerWins/SellerWins only; a ruling requires 2 of 3 or 3 of 5 assigned members to agree. None is never Enforced. |
| B3: withdrawn/under-staked selection | Selection and locking check live registration and the full required stake. `topUpStake` restores eligibility after slashing. |
| B4: Tier 1 review | Review remains an explicit party right within one day; outsiders and late review are rejected. Enforcement must wait for that window. |
| B5: authorization | Creation validates SLA and clause existence and requires a party. Jury escalation and expert appeal require a party. Expert appeal expires after one day. |
| B6: evidence provenance/front-running | The once-bound resolver can forward the actual submitter; direct submissions require a party and an open evidence window. Duplicate keys include submitter identity. |
| B7: overlapping panels | Concurrent cross-role registration is rejected; expert selection excludes original jurors even after a role change. Both panels exclude the SLA parties. |
| B8: mutable oracle | Creation captures evaluated status, measured value, version and timestamp. Later oracle writes cannot change that dispute's Tier 1 ruling. |
| Bond and stake accounting | Completed/failed expert rounds credit a refundable appeal bond; pull withdrawals work during pause and reject reentry. Slashes emit the actual capped amount; tracked slash proceeds cannot consume other voters' stake. |

The checked seed-42 run is committed separately in [results/security-remediation-seed42](results/security-remediation-seed42); [validation metadata](docs/security-validation.json) records the test, coverage, deployment and data checks.

Details, timeout behavior and remaining design limits are in [docs/security-remediation.md](docs/security-remediation.md).

## Historical and new research results

The top-level `results/results.csv`, `results/summary.json`, gas report, figures and `docs/evaluation-notes.md` describe the **old source revision**. The delivered manuscript and its 65,000-case supplement likewise evaluate that old revision. Do not label these as measurements of repaired contracts.

`npm run simulate` writes new measurements into `results/security-fix/` (override with `OUT`). Its summary records the SHA-256 hashes of the four evaluated Solidity files. Per-case gas includes the dispute/evidence/ruling/enforcement path but excludes deployment, oracle updates, registry setup and bond withdrawal. The default harness uses full revelation; non-revelation and quorum failures are covered by regression tests rather than this performance workload.

Legacy analysis/manuscript-generation scripts continue reading the historical top-level `results/` files. Regenerate and validate research tables explicitly before updating manuscript claims. Correctness still means agreement with a constructed synthetic winner, not human adjudication accuracy.

## Remaining scope

Panel selection is still deterministic and predictable; this patch does not provide VRF, Sybil resistance or an independent audit. Evidence is public metadata, not confidential storage or verified commercial truth. `escrowValue` is an SLA parameter, not funded escrow; `enforce` records a ruling but does not transfer commercial compensation. Vote rewards are majority-coherence counters only. Identity governance, a forfeiture/reward policy, legal enforceability and a real settlement design remain separate work.
