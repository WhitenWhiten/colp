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
