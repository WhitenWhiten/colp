# Automation finite profile v1

Profile `browser-bounded-v1`; rule apiVersion `colp.automation/v1`;
stored factsVersion `1` (the facts JSON has no apiVersion field); contract `0.2.1-design`.
This is an optional non-conformance subpath of @know-n/colp. Protocol MUST
traceability is unchanged. The backend and future browser consumer use the same exports.

Stored JSON is closed. Unknown keys are shape errors. CEL is recognized structurally
but rejected as unsupported capability. JavaScript is not a language branch.
M1 accepts tasks=[], route.targetIds=[], no executionPolicyId, no credentials.
No worker, target, model, count/scheduled trigger or historical preview is available in BE-1.

Finite predicates: all/any/not/field. Maximum depth 16, 128 nodes, 4096 encoded expression bytes, eight tasks.
Field/operator types follow the reviewed schema. Host normalization uses WHATWG URL,
IDNA, lower case and removes terminal dots; http/https only. Invalid URL is missingInput.
startsWith is literal case-sensitive path prefix: /docs/ accepts /docs/a and
rejects /other/docs/a and /docs. hostSuffix uses a dot boundary and never query text.
Missing fields propagate explicitly; unsupported facts versions are missingInput.
No network, Node builtins, Chrome, React, storage or worker dependencies.

Evaluate one bounded snapshot. Results: matched/notMatched/missingInput/error.
Required unusable bindings produce blocked, never notMatched. Placement priority is
integer [-1000,1000]; equal conflicting destinations go to review. Explicit selection
and privacy override priority. Root satisfaction suppresses only folder classification.
Task graph: unique IDs, known predecessors/contracts, acyclic, role-kind checks, ≤8 tasks.

Positive fixtures: tests/fixtures/automation/m1-placement.json and event-facts.json
copied from the reviewed pack. Negative acceptance: unknown key/version; malformed URL;
spoofed host; non-prefix path; wrong field/operator; depth 17; node count 129; ninth task;
cycle; missing/wrong-kind role; CEL; count batch. These are executable core tests in AW-04–07.

Browser storage/runtime integration and extension installation belong to AW-49.
Store review and actual browser lifecycle remain release gates, not preapproved claims.

BE-1 validates browser-target bundle execution with trusted fixtures. Actual MV3 CSP/store
installation remains AW-49; no Chrome lifecycle or store approval is claimed.
