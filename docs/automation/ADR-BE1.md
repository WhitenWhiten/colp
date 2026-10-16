# BE-1 additive Product contract

Product 1.94.0 adds isolated Automation config/preview paths, namespaced components,
and the producer mirror. It preserves all 1.93.0 operations, frozen enums and error
envelopes. Central ProductErrorCode receives Automation codes through the existing
explicit extension union and exhaustive status mapping; original endpoints' enum
is unchanged. The new Automation error envelope matches the reviewed open code
string and existing Product error fields, with no parallel authentication/errors.

Baseline product-v1.1.94.0.yaml is immutable once committed. Producer generation,
old-baseline compatibility, central error registry tests and route coverage checks
are required. No Web generated client is touched.

Product 1.95.0 adds the five health/revalidation/incident operations without changing
1.94.0's shapes. Semantic binding edits pause affected enabled rules; new activation
requires a fresh preview. Pause/resume fences are private ledger transitions, including
when a previously approved source is currently permission-blocked; they grant no authority.

## Evaluation and activation semantics

The reviewed PreviewDecision `conflict` group includes both a higher-priority winner
and equal-priority incompatible destinations (AU-02). These have different activation
semantics: a resolved winner does not prohibit enabling the lower-priority rule;
an unresolved tie does. Application evaluation therefore retains typed internal plans
(`matched`, `placed`, `preserved`, `overridden`, `blocked`, `conflict`, `notMatched`,
`missingInput`). Preview maps plans to the existing wire shape; activation evaluates
the same pinned snapshot and checks blocking plans, never presentation labels.
Planned run counts exclude preserved locations and overridden placements.

One binding assessment supplies validation diagnostics, preview/activation readiness
and health incidents. Required-but-unused roles warn; only consuming stages block.
Role constraints form an acyclic dependency graph, including for transitive resolution.
Older invalid graphs remain readable and blocked so configuration can be repaired.

Private preview fingerprints use `preview-snapshot/v2`: individual facts and competitor
snapshots are hashed before aggregation. This supports the composed 200-bookmark /
128-ancestor bounds without weakening the shared untrusted-JSON guard. Earlier preview
records fail the exact-snapshot check and require a new preview; no database migration or
public wire-schema change is needed. Maximum 500 rules, 32 roles, 200 current bookmarks
and 128 ancestors continue to bound the constituent work; this is not load-test evidence.

## BE-3 contract reconciliation

BE-3 retains the frozen M1 contract and adds Product 1.96.0 surfaces. Policy revisions
are immutable; fallback assignments are explicitly unavailable in the polling slice,
never silently substituted. Optional-work reservations serialize the server daily cap
across Owners and count distinct runs, independently of deterministic placement.
Unknown external cost stays unknown until reported; a zero configured cost limit is
not a claim that an external agent is free.

AW-31's prose says 14 tools, but the pinned catalog has 15 (7 manager + 8 worker,
including bootstrap pairing). The catalog and chapter 11 §6 are authoritative; use
all 15 closed descriptors. AW-02 remains experimental evidence and grants no
production Events readiness or dedicated-credential isolation.

## Rule editing contract reconciliation

Product 1.97.0 records the corrected `AutomationChangeInput.executionPolicyId`
contract: omission preserves the existing policy, an opaque ID assigns a policy,
and explicit `null` removes it. Existing clients sending an ID or omitting the
optional field remain valid. The conservative breaking checker reports the new
nullable union as a shape change, so `product-v1.1.97.0.yaml` freezes the accepted
contract while `product-v1.1.96.0.yaml` remains immutable historical evidence.
Preview also accepts an optional owned `ruleId` to exclude the edited rule from
competition and bind activation to that rule's identity.

## AW-55 waiting work and cost observations

Rule GET/list and Run GET/list expose `usage`, through the additive
`contract-adjustments.json` producer contract. No UI join against private ledgers is
needed. `periodStart`/`periodEnd` cover retained, currently authorized run history;
`admittedRuns`, job-state counts and cost observations describe that scope. Run
usage restricts history to that run. Job counts are a current snapshot, not a daily
success counter. Cancelled pending jobs do not count as waiting, while their
historical external attempts/cost uncertainty remain visible.

`pendingJobs`, `readyJobs`, `leasedJobs`, `committingJobs`, `awaitingApprovalJobs`
and `uncertainJobs` are distinct. `heldJobs` overlays active states under explicit
run hold/global pause; do not sum it into the other counts. `policyBlockedJobs`
counts all blocked work under execution/dependency/constraint policies;
`budgetBlockedJobs` is its explicit optional-budget-exhausted subset. Only actual
succeeded jobs contribute to `succeededJobs`; deterministic placement receipts do
not imply optional worker success.

`budgetDay` is the current UTC date. `dailyRunLimit` is the current rule cap (the
pinned rule cap for a Run); `reservedRuns` counts distinct runs across that rule's
current-day optional-work reservations, even when viewing a single run.
`remainingRuns` is the nonnegative rule allowance. This observation is not a claim
that a call will pass the independent server cap, pinned maxCalls, current
authority or input checks. Historical consumed reservations remain counted after
collection access changes because they still consume the Owner's rule budget.

`optionalCalls`/`unknownCostCalls` count persisted attempts. A nullable per-attempt
cost records the first valid result observation once, on the original call day;
late/repeated submissions cannot shift billing days or double count. Historical
attempts default to null, preserving unknown costs. `reportedCostMicros` is a
decimal string to preserve aggregate precision. Explicit reported zero is known;
one unreported attempt keeps `externalCosts=unknownDisclosed`. Reports are not
verified provider bills and do not assert enforceable external spending limits.

Before AW-29, `deliveryCapability=unavailable` and `acceptedDeliveries=null`.
Never manufacture delivery acceptance, latency or a successful hosted callback.
The projection emits fixed scalar fields only: no titles, output bodies, tokens,
claim secrets, provider request references or callback addresses. Current Owner
and collection authority scope job/cost aggregates as they scope run history.
