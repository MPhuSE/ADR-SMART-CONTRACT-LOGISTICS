# Solidity remediation decisions

## Version boundary

Base source: `48d4c854955d80449a0c94386e0084188973e12a`, branch `revise-adr-per-review`. The manuscript review characterized failures of that version. The regression suite in this branch asserts safe outcomes instead; historical bug-characterization tests from the separate manuscript supplement must not be run as acceptance tests for these repaired contracts.

## Membership, funds and panels

Pools use one-based index maps and swap-and-pop removal. Withdrawn addresses are absent from enumeration. Registration cannot be active in both pools; a user may change roles after all locks are released and they unstake. Expert assignment excludes all original jurors, so changing roles between rounds cannot create overlap. Parties are excluded from both panels.

Every assigned voter must have the full role-specific stake at assignment. An under-staked profile remains registered for accounting and existing obligations, but cannot be selected or newly locked. Top-up restores eligibility; assignment fails atomically if too few eligible voters remain. Existing concurrent assignments retain their locks even if another round slashes that voter. Unstaking cannot occur until all such assignments release them.

Only non-revelation is slashed. Minority disagreement is not penalized. `Slashed.amount` is the actual capped deduction, and `slashedFunds` tracks deductions separately from stake liabilities. The admin may withdraw only those proceeds; no function pays a fictitious monetary vote reward. Contract wallets receive funds by guarded calls, with state rolled back if payment fails.

Selection remains deterministic prototype round-robin over eligible addresses. Unique membership and exclusions do not establish unbiased or unpredictable sortition, economic Sybil resistance or collusion resistance. A verifiable-randomness redesign requires its own threat model and measurements.

## Voting, review and timeouts

- Creation enters Disputed with a seven-day window to resolve/escalate. Any caller may cancel an unprogressed dispute after expiry, with no ruling or escrow transfer.
- Tier 1 uses the creation-time oracle snapshot. Either party may request Tier 2 review within one day of the Tier 1 result. Enforce is blocked through the inclusive deadline.
- Tier 2 uses one-day commit and reveal windows. Anyone may transition/finalize, but only assigned members may commit/reveal. A reveal window starts at the actual transition so a late keeper does not eliminate voters' opportunity to reveal; it is not a hard upper bound on real resolution latency.
- A substantive result needs a majority of the entire assigned panel: 2/3 jurors, 3/5 experts. Zero commitment hashes and None reveals are rejected. All assigned members are released exactly once; non-revealers are slashed.
- Tier 2 without a majority has Ruling.None and cannot be enforced. Either party may appeal within one day; otherwise anyone can cancel it after that deadline.
- Tier 2 with a substantive ruling can also be appealed by a party within one day. Permissionless enforcement is available only after the deadline, preventing enforcement from front-running a timely appeal.
- A Tier 3 majority produces the final substantive ruling. Failed Tier 3 quorum produces Cancelled/None, never Enforced. Both paths release the expert locks and credit the appellant's bond.

Permissionless progress functions do not choose a winner. Pausing still stops new dispute/voting/progression actions, but does not prevent withdrawing an already-credited appeal bond. This is not an autonomous keeper service.

## Evidence and measurements

The vault binds once to the deployed resolver. Direct evidence requires the corresponding SLA party and an open pre-voting/review window. Only that resolver may forward another submitter's identity. Initial CID evidence is attributed to the creator rather than the resolver. The initial hash remains a CID-string hash, not an assertion that the underlying commercial document was downloaded and verified.

Duplicate keys use `abi.encode(disputeId, submitter, cid, hash)`. An outsider cannot pre-submit for a nonexistent dispute or consume a party's duplicate key; two parties can anchor the same material independently. Exact duplicates by the same party are rejected. Submission is frozen during voting and after review expiry or terminal states. Hash comparison authenticates neither the submitter's commercial claim nor the oracle's real-world observation.

Oracle updates carry a monotonically increasing per-clause version and timestamp. Creation snapshots measured value and evaluated status alongside that metadata. Later updates affect new disputes only. If no measurement exists at creation, the snapshot stays NotEvaluable; the party can escalate, or create a new dispute once a measurement is available. No freshness or oracle-challenge policy is implied.

## Appeal bond policy

The 0.5 ETH appeal deposit is now explicitly a **refundable participation bond**. This prototype has no agreed forfeiture rule, so inventing a transfer to the other party would change its economic design. A completed expert round, including failed quorum/cancellation, clears the dispute bond once and adds a pull credit for the appellant. Withdrawal uses checks-effects-interactions and ReentrancyGuard, works during pause, and cannot be repeated. A failed panel assignment rolls back the state and the incoming payment atomically. An unfinished round needs its permissionless timeout transition/finalization before the bond is credited.

## Validation and research implications

Run `npm test` for 45 tests, including B1–B8 regressions, multiple concurrent locks, threshold operators, timeout states, insufficient panels, actual slash accounting, bond refund rejection and contract-wallet reentry attempts. GitHub Actions runs the same suite plus a smoke simulation.

The repaired source changes gas, API setup and timing. New simulation files are separated from archived manuscript results, and summaries record Solidity SHA-256 hashes. No old 65,000-case result is presented as a new security-remediation experiment. Tests are neither an independent security audit nor evidence of legal enforceability, real adjudication accuracy or complete commercial settlement. Use fresh deployments and rerun experiments before updating those manuscript claims.
