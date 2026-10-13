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
