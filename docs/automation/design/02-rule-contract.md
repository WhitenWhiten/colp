# Rule Language, Bindings, State and Examples

**Status:** proposed `colp.automation/v1`. **Version:** 0.2.1-design. JSON is the only stored and transported form. The schemas in [schemas](schemas/) and the examples in [examples](examples/) are machine-readable companions; this document defines the semantic validation that JSON Schema cannot express.

## 1. Three layers, one editor

A **rule definition** describes event selection, conditions, typed roles, initial placement, aggregation, task graph, routing and policy. A **binding set** resolves roles to the Owner's folders and targets. An **execution policy** selects approved executors, allowed data and budgets per task type. Their revisions are independent so that a label refresh or a budget change never resets a batch, and so that templates (M4) can ship logic without bindings.

The Owner never sees three resources. The web editor (AU-01) composes one form and creates a binding set per rule; M1 has no execution policy at all (absent means "no model calls, no fallback"). Agents may author rules through the JSON view or the manager MCP tools (M2+), always through validate and preview.

YAML is not accepted by the server. An agent that prefers YAML converts before calling the API (ADR-A16). Unknown properties are rejected, never ignored.

Natural language is a design-time editing interface only. The runtime never reinterprets prose per bookmark. Task `instruction` text is approved user intent handed to the worker; page content can never replace it.

## 2. Root fields

| Field | Meaning | Semantic requirement |
|---|---|---|
| `apiVersion` | Rule-language contract | Exactly `colp.automation/v1` |
| `name`, `description` | Label and explanation | Never used as identity |
| `roles` | Typed installation parameters | Unique keys; every referenced role exists |
| `on` | Trigger source | Host must support it; see §2.1 |
| `scope` | Collection and optional folder role | No inferred all-tenant scope |
| `match` | Pure predicate | No I/O, no implicit lookups |
| `intake` | Initial placement | Only with `on: bookmark.intake` and `trigger.mode: each` |
| `trigger` | `each` (M1), `countBatch` (M3), `scheduledBatch` (Later) | Stateful modes have one declared authority |
| `tasks` | DAG of output contracts | Unique IDs, acyclic, ≤ 8 in v1 |
| `route` | Empty targets for M1; named worker targets from M2; broadcast M4 | Cardinality checked after binding |
| `policy` | Imports, user edits, privacy, caps | Cannot grant privileges beyond host authorization |
| `priority` | Placement conflict ordering | Equal conflicting winners go to review |

### 2.1 Trigger sources by milestone

| `on` | Meaning | Milestone |
|---|---|---|
| `bookmark.intake` | A new bookmark saved by a person or an agent (browser receipt or server-side intake) | M1 |
| `node.created` | Any creation event, including automation-caused ones | M1 (server), with `policy.sameStageReentry: deny` |
| `intake.completed` | Initial placement settled for a bookmark | M3 (batches) |
| `node.updated` | Field change with before/after facts | M4 |
| `bookmark.link_health.changed` | From the existing link-health module | Later |

## 3. Conditions

### 3.1 Finite predicate profile (the only profile until M4)

A field predicate has `kind: field`, an allowlisted field, an operator and a typed value. Compose with `all`, `any`, `not`; reject depth over 16 or more than 128 nodes.

| Operator | Input | Semantics |
|---|---|---|
| `eq` | scalar field, scalar value | exact normalized equality |
| `in` | scalar field, list | exact membership |
| `contains` | string field, string | literal substring; never a security check |
| `startsWith` | `bookmark.url.path`, string | literal case-sensitive prefix of the normalized path; not substring search |
| `hostSuffix` | `bookmark.url.host`, domain | host equals or ends with `.domain`; `arxiv.org.evil.example` does not match |
| `hasTag` | `bookmark.tags`, string | exact tag key or normalized label |

The web editor exposes these as "site is", "site ends with", "title contains", "URL path starts with" (`startsWith` on normalized `bookmark.url.path`), "has tag". URLs go through one versioned normalizer shared by browser and server: host case, IDNA, terminal dot; query parameters are never domains; malformed URLs and unsupported schemes are `missingInput`, not false.

A predicate returns `matched`, `notMatched`, `missingInput` or `error`. An unusable binding yields `blocked` after matching, never `notMatched`.

### 3.2 CEL profile (M4)

CEL remains the chosen server expression language (W04) for conditions the finite profile cannot express, such as the tag-transition example. It is not built before M4 and is never lowered into the browser bundle. When built: frozen typed environment with event and bookmark facts only, pinned evaluator, parse/check once per revision, CPU and memory bounds, declared dependencies feeding the health index, no network or host APIs. The schema branch exists so that validation can say "unsupported on this server" rather than "unknown".

### 3.3 JavaScript

Deferred. The v1 schema has no JS branch; `node:vm` is not a security boundary (W06).

## 4. Role binding

`FolderRef` is `serverUuid`, `collectionId`, `nodeId`. Labels are looked up for display, never stored as executable paths. `followIdentity` is true in v1. `allowedAncestor` is revalidated at every effect.

Role kinds: `folder`, `executor`, `vocabulary` (M4), `entityMap` (M4). An executor binding names an executor record by `executorId` (M2+), not a target ID. Resolve `executor.target_id`, then check it agrees with the route and policy. M1 root-only rules have no executor role. `targetSelector` pools are M4. Native browser IDs are a device projection and never leave the device.

Required missing bindings block only the stages that need them; a missing intake folder blocks intake completion and the save still happens. Optional role absence has a declared fallback (keep parent, review), never an unapproved model.

## 5. Task and output contracts

| Task | Output kind | Constraints | Milestone |
|---|---|---|---|
| `classify.root` | placement | M1 intake satisfaction marker, not a worker TaskSpec | M1 |
| `classify.refine` | placement | Destination stays inside the bound subtree; `keepParent` and `review` allowed | M2 |
| `tags.generate` | tags | Union with user tags; rejected tags suppressed; evidence required | M2 worker; foreground local tags remain separate existing behavior |
| `summary.generate` | text/summary | Language, coverage, attribution line, no unsupported factual claims | M2 |
| `digest.generate` | text/digest | Pinned member identities, unavailable-member disclosure | M3 |
| `review.generate` | text/review | Separate attribution | M3 |
| `metadata.resolve` | metadata | Stable content ID, sourced candidates, uncertainty kept | M4 |

`outputContract` names a versioned contract in the host registry: `placement.subtree.v1`, `tags.sourced.v1`, `summary.sourced.v1`, `digest.sourced.v1`, `review.sourced.v1`, `metadata.catalog.v1`. Unknown names fail validation. Passing a text schema is not proof of correctness; evidence and optional review stay in force.

`inputFields` lists bookmark fields the host sends or exposes: `url`, `title`, `description`, `note`, `tags`, `metadata`, `readableText`, `folderDefinitions`. The job-scoped input API enforces this allowlist. Stored readableText may be exposed only when available and explicitly allowed; no new per-task page fetcher is implied. A worker fetching outside sources needs its own grants and source evidence. Accepted predecessor metadata is supplied explicitly to dependent task inputs, never guessed from an unrelated live node read.

`allowCreateFolder` defaults false and is unsupported in v1; validation reports the capability as unavailable rather than silently ignoring the flag.

Summaries are written to the bookmark note with an attribution line; digests and reviews are run-level texts shown on the run page (ADR-A18).

## 6. Route compatibility

`targets + single` requires exactly one resolved target for a worker task; a root-only M1 rule has no worker tasks or target; optional foreground local classification is not represented as an external-worker TaskSpec. `targets + firstClaim`, `broadcast + perTarget` and `broadcast + single` (always rejected) are M4 rules kept in the schema. Restricted privacy requires `broadcastAllowed: false`.

Empty `targetIds` is valid for a rule without worker tasks (M1). Semantic validation rejects empty targets for a worker task. A rule may stay a draft before a target exists; activation reports degraded or blocked readiness rather than inventing a target.

Wake mode (`events` or `poll`) is a property of the target, set on the Agents page; a rule never chooses how its target is woken.

## 7. Matching, effects and arbitration

Evaluate all relevant rules against one input snapshot, then arbitrate by field. Compatible tag additions merge. Higher placement priority wins among compatible authorized effects; equal-priority incompatible destinations go to review. Manual choice and privacy constraints beat priority.

A successful intake decision suppresses only the root classifier request. With an explicit foreground classification gesture, the extension may ask its configured local provider for tags only. An observed-create event, sync replay or deterministic rule hit alone does not authorize a model call (AU-12, R09).

## 8. Versioning and effective state

Four revisions: template (M4), definition, binding set, execution policy. A run pins every applicable revision; executionPolicyRevision is explicitly null in M1. Desired state is `draft`, `enabled`, `paused`, `archived`; effective state adds `active`, `degraded`, `blocked`. Creation produces a draft. Validation never activates or spends. Preview creates an expiring record with `sideEffects: false`. Activation requires an unexpired preview of exactly the current definition, bindings and policy and captures a new source fence.

A server-wide pause (AU-14) is a separate switch above rule state: it stops admission for every rule, holds pending work, and is projected into bundles as a flag.

## 9. Package, install, export (M4)

Templates use `PortableRuleDefinition` in [template.schema.json](schemas/template.schema.json); symbolic collectionSlot/targetSlots are resolved into a live draft RuleDefinition only at installation. The digest covers canonical content. A template cannot contain credentials or a callback. Import stores inert content; install produces a draft; export strips bindings, targets, secrets and private examples. No marketplace browse, purchase or ranking API exists in this contract.

## 10. Structural versus semantic validation

JSON Schema enforces shape, closed objects, lengths and enums. The semantic validator additionally checks operator-field typing, non-empty boolean operands, DAG cycles, role-kind compatibility, same-collection folder constraints, supported contracts and triggers on this server, route cardinality, activation readiness, consent and budgets. [validation/validate.py](validation/validate.py) checks this pack's artifacts and a small offline fixture set; it is not the production evaluator.

## 11. Example inventory

| File | Purpose | Milestone |
|---|---|---|
| `academic-intake.json` | Host rule, root satisfaction, worker enrichment inside Academic | M1 (intake), M2 (tasks) |
| `academic-bindings.json` | Folder and target bindings | M1 |
| `execution-policy.json` | Per-task destination, data and budget policy | M2 |
| `m1-placement.json`, `m1-rule-create.json`, `m1-bindings.json` | M1 placement with no worker or execution policy | M1 |
| `academic-summary-only.json` | Fixed one-worker-job release fixture | M2 |
| `rule-create.json` | Enrichment-enabled create request wrapping the academic definition | M2 |
| `preview-request.json` | Preview with supplied facts | M1 |
| `event-facts.json` | A committed creation event | M1 |
| `local-receipt.json` | Browser receipt before its sync join | M1 |
| `ten-bookmark-digest.json` | Fixed count batch | M3 |
| `github-review.json` | Repository selection workflow on `node.created` | M3 |
| `mcp-subscribe.json`, `mcp-occurrence.json` | Events subscription and wake-up occurrence | M2 |
| `paper-template.json` | Inert portable package | M4 |
| `broadcast-digest.json` and companions | Per-target append-only broadcast | M4 |
| `research-catalog.json` and bindings | Entity-map and vocabulary workflow | M4 |
| `tag-review.json` | Explicit tag transition using CEL | M4 |
| `weekly-digest.json` | Scheduled batch | Later |
| `contract-fixtures.json` | Positive and negative structural fixtures | — |

## 12. Contract completion rules

M1 semantic validation accepts tasks=[] and empty targetIds without executionPolicyId. Worker TaskSpec, nonempty route and execution policy are admitted only at M2+. Maximum tasks and predecessor count are eight. LocalReceiptInput contains canonical identifiers only and may claim only classify.root satisfaction, subject to server proof. A paused bundle carries paused and monotone settingsRevision. Run once starts only from a persisted previewId/previewDigest; source selection is never recomputed silently. `11-execution-contract.md` defines the end-to-end fences and handoffs.
