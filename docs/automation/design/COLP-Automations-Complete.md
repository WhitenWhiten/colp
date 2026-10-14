# COLP Automations — Complete Design Book

Version 0.2.1-design | 2026-10-13 | English Markdown

This combined edition is generated from the chapters by `validation/build-docs.py`. Machine-readable OpenAPI, schemas and examples remain companion files. This is a design pack, not implemented software.

## Chapters
- [Architecture](01-architecture.md)
- [Rule Contract](02-rule-contract.md)
- [User Stories](03-user-stories.md)
- [API Guide](04-api-guide.md)
- [MCP Events](05-mcp-events.md)
- [Implementation Handbook](06-implementation-handbook.md)
- [Acceptance Operations](07-acceptance-operations.md)
- [Evidence And Decisions](08-evidence-and-decisions.md)
- [Data Model](09-data-model.md)
- [Module File Map](10-module-file-map.md)
- [Execution Contract](11-execution-contract.md)
- [Delivery Lanes](12-delivery-lanes.md)
- [Backend First](13-backend-first.md)
- [Review Findings](14-review-findings.md)

---

<!-- Source chapter: 01-architecture.md -->

# COLP Automations: Architecture and Product Specification

**Status:** proposed design, not implemented. **Version:** 0.2.1-design. **Date:** 2026-10-13.

This specification covers bookmark automation for COLP Server: deterministic rules that place a bookmark when it is saved, durable server-side runs, and enrichment jobs that the Owner's own agents complete. Academic reading, software evaluation, personal organization and institutional research catalog metadata are examples of the same system; no category-specific workflow defines the architecture.

Read [the user stories](03-user-stories.md) first, then [the rule contract](02-rule-contract.md), [the API guide](04-api-guide.md), [the MCP Events adapter](05-mcp-events.md) and [the implementation handbook](06-implementation-handbook.md). Source identifiers (`R01`, `W01`) refer to [the evidence register](08-evidence-and-decisions.md). MUST and SHOULD describe the proposed implementation, not capabilities already present in either repository.

## 0. Glossary

| Term | Meaning |
|---|---|
| Owner, Browser, Agent | The product plan's actors (`~/known/colp-server/01-user-stories.md`). One Owner per server. |
| Worker | An agent that takes automation jobs: it lists ready jobs, claims one, reads the job’s allowlisted inputs with job-scoped tools, submits a typed result. How it learns that work exists is its target's wake mode. |
| Hosted bot | A worker on a hosted platform that subscribes to MCP Events so the server can wake it. A ChatGPT **dot** is an officially documented candidate: an always-on cloud agent (W09), with MCP Events support documented separately in W01. COLP interoperability and credential isolation remain untested gates; direct-public HTTPS is the selected v1 topology. |
| Wake mode | A per-target setting: `events` (the server wakes the agent through MCP Events; the default when the origin is public HTTPS and the agent subscribed) or `poll` (the agent checks on its own schedule, for example Claude Code on a routine or a cron script against the HTTP work API). The worker contract is identical in both modes. |
| Jev | The classification provider adapter path bundled in the extension (not a guarantee of one fixed model) (`generated/classification/classification-provider-cloudflare-jev.ts`, R09). In the self-hosted edition it runs only through the Owner's own local provider configuration. |
| Rule | When (trigger and match) → where (intake placement) → then (tasks) → who (route) → limits (policy). Stored as JSON, edited through a form. |
| Binding | A rule role (`academicRoot`, `researchEnricher`) resolved to one of the Owner's folders or targets, by identity. |
| Target | A named inbox for one agent ("Research"). Created from the Agents page. |
| Intake | The first placement of a newly saved bookmark. `classify.root` is the task it satisfies. |
| Run, Job, Attempt, Effect | One admitted rule execution; one task of a run for one target; one claimed execution with a lease; one committed mutation linked to a job. |
| Receipt | Browser evidence that a local decision happened, joined to the sync operation that created the bookmark. |
| Fact | The bounded before/after state of a committed mutation, captured in the same transaction. |

## 1. Executive decision

Build one portable rule definition and task model, with separate browser and server hosts. Browser rules decide deterministic initial placement before any configured classifier. The server owns cross-device aggregation, durable workflow state, recipient selection and accepted effects. Agents finish jobs by claiming them; the server wakes them through MCP Events (the primary path, owner decision 2026-10-12) or, where a local or otherwise authorized worker can reach the server, that worker may poll. Wake mode is a per-target setting; the worker contract does not change with it. MCP Events is the wake-up, never the engine: a notification carries references, and the job ledger, claims and effect gateway stay authoritative.

Agent-requested canonical resource mutations use the existing change-plan path (plan → policy or approval → commit/version → guarded Undo). M1 deterministic placement is an Owner-authorized save/move, not an Agent execution policy; run-level text and metadata-only proposals are not canonical mutations. The baseline Undo restores a collection version with content fences, not arbitrary field-level effects (R07). AW-51/AW-25 add conservative effect linkage; they never expose force restore.

A rule match does not mean its action succeeded. A webhook acknowledgment does not mean a task completed. A model's declared confidence does not create write authority. Each boundary has a durable, inspectable state.

### What this revision changed and why

The 0.1.0 pack was a platform specification (44 packets, 60 operations, 24 tables, broadcast, templates, CEL, scheduled batches) wrapped around one hero use case. Version 0.2.0 keeps the invariants and reorders the work so that each milestone is a usable product on its own; the hosted-bot protocol is proven first (AW-02) because it is the primary wake-up path, and polling is kept as a setting so no server is excluded. The full list is in [the README](README.md#what-changed-in-020-design).

## 2. Repository baseline and integration constraints

COLP was inspected at `2ee8397` (main, 2026-10-12); Known-Extension at `28acb4965` (2026-10-12). Rebase before implementation and record drift in AW-01. The original evidence register is retained with review provenance. This review independently re-read selected critical sources, not every listed file; see the evidence register before treating a claim as verified at the implementation checkout.

| Existing boundary | Consequence for this design | Evidence |
|---|---|---|
| Canonical mutation writes resource, operation, audit and Outbox in one transaction under a frozen write order; the collection ordinal advances under a collection lock | Capture automation facts at that boundary by extending the frozen `CANONICAL_MUTATION_WRITE_ORDER`, not in each controller | R03 |
| Outbox routes declare `handlerMode`, `sideEffectDurability` and a closed `routeClass` union; the worker refuses transient routes in production | Add a static durable `delivery_each_event` route and extend the `routeClass` union and readiness | R04 |
| MCP change signals are best-effort re-read hints | Preserve them; never count from them | R05 |
| MCP server uses a versioned SDK boundary with an allowlisted schema set and `2026-07-28` adapters | Add Events methods behind that boundary and a flag; fail closed when the pinned SDK lacks the `events` capability | R06 |
| Change plans: per-agent `manual`/`trusted` policy, reversible operation set, a version per committed plan, Undo that refuses after newer edits | Automation effects are change plans with an automation cause. No new approval system | R07, R20 |
| Extension saves converge on `chrome.bookmarks.create` with a reserved placement intent; native creations are observed by the event ingress | Pre-save rules choose `parentNativeId` before create; observed creations get a settle window | R08, R21 |
| Extension capture pipeline: durable `CaptureTask` with `automaticIntent`, `manualFence`, `classification` state, local provider with spent command markers | Rule placement is a new capture decision kind inside this pipeline, not a parallel store | R22 |
| Extension classification requests folder and tags separately | A rule hit sends `folder:false, tags:true` or nothing | R09 |
| Local provider: missing key never selects cloud | Keep; the server never adds a fallback | R10 |
| Product API conventions: `__Host-known_session` cookie (or `known_session` on acknowledged plain HTTP), `x-csrf-token` header with Origin allowlist on cookie writes, `Known-Command-Id`, closed error envelope, route manifest derived from the OpenAPI | Additive Product routes under `/api/v1/me/automations/*` follow these exactly | R11, R13, R23 |
| OpenAPI sources live in `packages/server/openapi/fragments/*.yaml` and are bundled into `colp-server-v1.yaml`; the web generates types from the bundle; `openapi:ci` checks drift and breaking changes | Add `fragments/automations.yaml`; never edit generated files | R12, R24 |
| Migrations are Kysely files with a sortable UTC prefix; the head is `202610290100`; out-of-order names fail on upgrade | Name automation migrations with a prefix greater than the current head at merge time | R25 |
| Feature flags are `KNOWN_FEATURE_*` even in the self-hosted edition; the server's classification routes are pruned (`CLASSIFICATION_PRUNED_OPERATION_IDS`) | Flags are `KNOWN_FEATURE_AUTOMATION_*`; "no model call" means the extension's local provider | R19, R26 |
| Web is React 19 with `pages/*.tsx`, `api/*Client.ts`, generated types, Know-N palette, toasts for warnings | New `pages/Automations.tsx` and friends, not a `features/` tree | R27 |
| Direct reachability is deployment-specific; callbacks and MCP access are separate paths | Public HTTPS is the v1 hosted test topology. A local worker may poll only if it can actually reach/authenticate to COLP; tunnel Events behavior is not asserted | W01, W10; inherited D26 |

## 3. Deployment reality

| Server origin | Extension rules (M1) | Target in poll mode (M2) | Target in events mode (M2) |
|---|---|---|---|
| `http://127.0.0.1:8080` (D26) | yes | yes, from a worker on that machine with authorized credentials | not in the direct hosted v1 topology |
| `https://<lan-ip>` with `tls-internal` | yes | yes, from a worker with network access and TLS trust | not without separately verified connectivity |
| Public HTTPS with a domain | yes | yes | yes, after AW-02 proves the protocol |

The backend proposes a mode with readiness/reason; the Agents page renders it. An Owner may select a mode but cannot override failed verification, missing authority or unreachable transport (AU-26). M1 depends on neither agent column.

## 4. Scope by milestone and non-goals

| Milestone | The Owner can… | Not yet |
|---|---|---|
| M1 Rules without models | Create a rule from a folder, preview it, save by rule from every entry point, see why a bookmark is where it is, undo one effect, pause everything, keep rules in backup and export | Any agent involvement |
| M2 An agent finishes the job | Turn an existing agent into a worker woken by MCP Events or polling; get summaries and tags written through approvals or trusted commit; see cost and waiting work | Batches, run-once |
| M3 Batches and run-once | Get one digest per ten papers, organize existing folders once with a preview | Templates, broadcast, CEL |
| M4 Share the logic | Install and upgrade templates, bind entity maps and vocabularies, broadcast a batch to several agents | Scheduled batches, replay |
| Later | Weekly schedules, event-time replay, server-model and background browser executors, server scripts | |

Non-goals in every milestone: a marketplace with billing or discovery, arbitrary distributed user code, autonomous changes to sharing or visibility, deleting anything automatically, and support claims for any host (Grok, Muse, Cue, …) before its adapter passes lifecycle tests. Provider names are display data, not proof of protocol support.

## 5. Domain objects

| Object | Meaning | Immutable boundary |
|---|---|---|
| Rule | Definition, priority and policy, with its own revisions | Definition revision |
| Binding set | Role → folder/target/entity-map/vocabulary, by identity | Binding revision (label refresh is not a revision) |
| Execution policy | Which target or executor does which task type, allowed data, budgets, fallback approval. Absent means "no model calls, no fallback" | Policy revision |
| Target | A named inbox bound to one agent's connection authority | Pairing generation |
| Subscription (M2) | Verified callback and secret for a hosted bot | Identity stable across refresh; secret generation changes |
| Fact | Bounded before/after facts of a committed mutation | Event identity and collection ordinal |
| Receipt | Browser evidence joining a local decision to a sync operation | Device, generation, local receipt identity |
| Run | One admitted execution, kind `intake`, `batch` or `manual` (run-once) | Pinned rule, binding and policy revisions, members |
| Job | One task of a run for one target | Input digest and accepted result |
| Attempt | A claimed execution with a lease and generation fence | Attempt generation |
| Effect | A committed change plan linked to a job step | Plan identity and version |
| Incident | A dependency or runtime problem, not a bookmark event | Dependency-change identity |
| Template (M4) | Portable logic, roles, contracts, license, tests | Published version and digest |

Two targets that share one OAuth client are separate queues, not separate security principals. Restricted rules need a dedicated credential.

## 6. Execution path

```text
Popup / shortcut / context menu / Save tabs      Star button      Web library / MCP create
          |                                          |                      |
   pre-save rule (bundle) ──────────► native create (settle window) ──────► canonical mutation
          |                                          |                      |
   intake receipt (durable)                 observed-create receipt         |
          └──────────────────────┬───────────────────┘                      |
                                 ▼                                          ▼
                     receipt join  ◄──────────────  facts + Outbox (same transaction)
                                 |
                      durable admission (ordered per collection)
                                 |
                 intake satisfied → run → dependency-ready jobs
                                 |
    Events wake-up (target in events mode) | ready list (target in poll mode)
                                 |
           agent lists jobs through MCP tools or the HTTP work API
                                 |
                 claim → read allowlisted job inputs → typed result proposal
                                 |
         recheck authority, input revision, manual edits, subtree
                                 |
          change plan (cause automation:…) → policy or approval → commit + version
                                 |
                   effect receipt → ordinary sync projection (no re-intake)
```

`node.created` stays an immutable statement about creation. `intake.completed` is an application event meaning the declared initial placement is settled for a workflow. History is never rewritten to hide an intermediate location.

## 7. Browser host

### 7.1 Pre-save path

Read the installed, validated rule bundle and the device's role→native-folder projection (resolved by the extension from its own colpId↔nativeId mappings; the server never learns native IDs). Normalize URL facts. Evaluate rules before any classifier call. Resolve effects by priority and field. A deterministic placement satisfies `classify.root`; it does not satisfy tags, summary or deep classification.

Reserve the placement intent before `chrome.bookmarks.create` (the existing `bookmark-create-placement` store), bind the native ID afterwards, and record the decision, bundle/rule/binding revisions, input digest and satisfied task types as part of the `CaptureTask`. A crash between create and bind uses the existing identity recovery; a title/URL match alone never establishes identity.

An explicit folder selection in the popup wins over any rule. Remembered last-used folders and defaults are not explicit. The result panel explains the decision in one line.

### 7.2 Observed-create path (star button)

A bookmark created outside the extension is recorded first. The extension waits a settle window (default 3 s) so the star dialog's folder choice is visible, then classifies the observation as new local intent, own echo, inbound projection, import or recovery. Rules apply only to new local intent whose parent is a bookmark root (Bookmarks bar, Other bookmarks, Mobile bookmarks); any other parent is the Owner's choice (ADR-A17). The resulting move is one receipted local operation; the receipt names both native operations so the server treats create+move as one intake.

Imports, restores, bootstrap snapshots and inbound projections never start intake. "Run once" (M3) is the explicit path for existing bookmarks.

### 7.3 Offline and partial capability

A valid bundle evaluates offline. Expired bundles fail closed for automatic effects; saving still works. A missing or unsynced destination blocks the stage, not the save. Receipts and pending work live in IndexedDB. A pause flag in the bundle stops local rules within one refresh.

Local-only use without a server is a Later question (Q7); the bundle format must not preclude local authoring.

### 7.4 Model and provider boundary

Execution location and data destination are separate facts shown separately. A rule hit sends the local provider `folder:false, tags:true` or nothing (R09). Missing local key never selects cloud (R10). Autonomous background inference in the browser is Later work with its own consent (G7).

## 8. Server admission and ordering

Capture a bounded private facts row in the same transaction as the canonical mutation and its source event: `operationId`, `eventId`, `collectionId`, `nodeId`, ordinal, origin, before/after URL, title, tags, parent and ancestors, causation. Never put readable content, tokens or provider responses in the general Outbox payload.

One authoritative producer path: higher-level node events and lower-level resource events describing the same operation must not both admit. A unique `(rule_revision_id, source_event_id, stage)` receipt prevents double admission.

A static `automation.ingest` Outbox route uses `delivery_each_event`; its durable side effect is advancing the automation ledger, never a network send. Each collection has its own ordered source position; scan through a committed high-water ordinal and record the last inspected ordinal including irrelevant operations. Cross-collection order is a server admission sequence, never inferred from collection ordinals or browser clocks.

### 8.1 Activation fence

Draft → preview → enable under an activation fence. Activation acquires the collection locks in stable order, records current ordinals and inserts the activation before releasing. Only operations after those ordinals are watched. Pause stops admission and holds pending runs; resume takes a new fence and does not backfill.

### 8.2 Server-side intake

For `node.created` from the web, MCP or Sync without a browser receipt, the server evaluates intake rules itself after the receipt grace period (default 10 s, configurable) and applies placement through the canonical move with automation causation. A late browser receipt for the same operation satisfies only still-open tasks; it never duplicates a run.

### 8.3 Receipt join and timeout

A receipt can arrive before or after the operation. It waits as `waitingForSync` until identity, owner, replica generation and committed fields match. A receipt whose rule revision is no longer eligible enters review; it is not reinterpreted under current rules.

## 9. Aggregation semantics

`each` creates one run per unique matching event and stage. `countBatch` (M3) consumes N distinct members atomically: nine waiting plus two arrivals make one run of ten and one waiting. Member identities are pinned; "the latest ten" is never queried at execution time. Duplicate sync delivery is not a member. Delete does not subtract; unavailable members are reported, not replaced. Moves and restores count only where the rule selects those event meanings.

A semantic change (destination, count, match) starts a new epoch and resets the unfinished batch, with a preview warning. A label refresh does not. Scheduled batches are Later (AU-32) with the DST and misfire semantics kept from 0.1.0.

## 10. Task coordination and result reuse

`classify.root` chooses the initial folder; `classify.refine` may only select a live destination inside the bound subtree; `tags.generate` merges into the user's tags; `summary.generate` writes an attributed note; `digest.generate` writes a run-level text; `metadata.resolve` returns sourced candidates and mutates nothing.

`inputFields` name bookmark fields COLP holds: `url`, `title`, `description`, `note`, `tags`, `metadata` (from an earlier task), `readableText` (only when the host can supply it) and `folderDefinitions`. There is no `abstract` field: a worker that wants the page or the arXiv abstract fetches it itself under its own permissions and says so in its evidence (ADR-A19).

Reuse an accepted result only when its input digest, output contract, taxonomy semantics and authority are compatible. A rejected tag becomes a negative preference for the rule. Pin the task graph at run creation; reject cycles, unknown IDs and missing roles at validation. `required: true` on a task means the run is not `completed` without it; it does not block sibling tasks.

Executors emit proposals. The effect gateway validates the exact contract and builds a change plan from the permitted effects. A `trusted` agent policy authorizes reversible effects only, as today (D8).

## 11. Claims, retries and writes

Claims bind caller authority, target, job, input digest, lease expiry and an increasing generation. Heartbeats cannot restore a revoked grant; completions from an old generation are rejected. The system promises deduplicated accepted effects, not exactly-once external compute.

Known failures retry within budget. Unknown outcomes become `uncertain` and wait for reconciliation or an explicit retry. Fallback only to pre-approved executors. Before applying, recheck scope, authority, subtree membership, input revisions, manual-edit markers and the proposal digest. Job success and the plan commit happen together; multi-step work checkpoints each effect and shows partial completion.

## 12. Causality and echo suppression

Carry `rootRunId`, job, step, operation, stage and hop count in server-authoritative mutation context. Admit intended next stages, deny same-stage re-entry, bound hops (default 8). Never suppress all automation-origin events. A server move projected to two browsers is not two saves; a new manual save of an existing URL is a new intent.

## 13. Directory and dependency health

Bind by server/collection/node identity; labels are presentation. Keep a reverse dependency index over folders, ancestors, vocabularies, entity maps, targets, subscriptions and effective access. Rename: informational incident. Move: recheck subtree and sync range; out of bounds blocks the stage. Delete: block; a same-name folder never rebinds. Restore: revalidate, never replay. Separate desired state, effective health and executor health: a dead agent never disables a healthy local rule. Deduplicate incidents by dependency revision and category; coalesce notifications.

## 14. Routing and privacy

`targets` resolves bound inboxes. `single` assigns one target. `firstClaim` and `broadcast`/`perTarget` are M4. Restricted rules cannot broadcast. Event payloads (M2) carry opaque IDs and counts only; they still reveal activity, so authority is checked before every send and on every job read.

## 15. Portability (M4)

A package holds logic, typed roles, contracts, license, publisher and synthetic tests; never credentials or callbacks. Install supplies bindings; authors cannot grant permissions. Pin versions; show semantic diffs; export strips personal data. Browser packages accept bounded parameters only; the Chrome remote-logic policy needs an explicit review (G4).

## 16. Defaults and observability

Initial defaults, not measured promises: 100 enabled rules per server, 8 tasks per rule, 1,000 members per run, 50 ms evaluator CPU deadline, daily run cap 100 per rule (held, never dropped), 120 s claims with 30 s heartbeat, bundle expiry 7 days, bundle refresh 5 minutes, receipt grace 10 s, 24 h delivery retry horizon (M2), 30-day redacted run history. Tune through reviewed limits; never make saving depend on an agent.

Retain unfinished members and pending inputs until completion or disclosed expiry. Readiness separates rule engine, ingestion, database, delivery worker and executor availability. Metrics carry low-cardinality labels only.

---

<!-- Source chapter: 02-rule-contract.md -->

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

---

<!-- Source chapter: 03-user-stories.md -->

# User Stories and Traceability

**Status:** proposed behavior for COLP Server automations. **Version:** 0.2.1-design. **Date:** 2026-10-12.

Purpose: no automation function enters COLP Server without a story that needs it. Each story names the actor, what they do, why, and how we know it works. Acceptance criteria are written so that each can become an end-to-end test or a manual checklist item without reinterpretation. Every story names its milestone (`M1`–`M4` or `Later`, defined in [the implementation handbook](06-implementation-handbook.md)), its acceptance tests (`AC-xx`, defined in [acceptance and operations](07-acceptance-operations.md)), its work packets (`AW-xx`) and one configuration example from [examples](examples/).

Story IDs are `AU-xx` so they never collide with the product's `US-xx` stories in `~/known/colp-server/01-user-stories.md`. Task IDs are `AW-xx` so they never collide with the product's lane tasks (`A1`, `E1`, …).

## Actors

| Actor | Who |
|---|---|
| **Owner** | The one person who runs the server and owns every collection on it. Configures rules in the web UI; reads results there and in the extension. |
| **Browser** | A browser profile with the Known extension, signed in to the Owner's server. Several, on several machines. Saves through the popup, the shortcut, the context menu, "Save tabs", and the browser's own star button. |
| **Agent** | An AI assistant the Owner connected over MCP (OAuth client or API key). Three roles in this pack: an **ordinary agent** (reads and organizes on request, unchanged), a **worker** (takes automation jobs: lists, claims, reads, submits), and a **hosted bot** (a worker on a hosted platform, for example a ChatGPT dot, that subscribes to MCP Events so the server can wake it). Each worker target has a wake mode: *events* (woken by the server, the default where possible) or *poll* (the agent checks on its own schedule, for example Claude Code on a routine or a script). |
| **Rule** | Not a person, but it acts: "when a bookmark like this arrives, put it here, then ask this agent to do that". |

Real-world constraints that shape every story below:

- The Owner saves dozens of bookmarks a week, not thousands a day. They will set up one or two rules, forget about them, and judge the feature by whether the right thing happened to the paper they saved last Tuesday, and by whether it ever did something they did not want.
- Many self-hosted servers sit behind NAT or on a loopback origin (decisions D9 and D26 in the product plan). An agent can only be *woken* if the server has a public HTTPS origin; on other servers the target's wake mode falls back to polling (AU-26). Everything in M1 works without agents at all.
- In the self-hosted edition the extension's automatic classification runs only through the Owner's own local provider (the server's classification routes are pruned, see R19). "No model call" therefore means: the extension does not ask that provider to choose a folder.

## Story index

| ID | Story | Milestone | Tests |
|---|---|---|---|
| AU-01 | Create my first rule from a folder in two minutes | M1 | AC-26, AC-41, AC-54, AC-57 |
| AU-02 | See what a rule would have done before I enable it | M1 | AC-26 |
| AU-03 | Rename or move a folder without breaking its rules | M1 | AC-13, AC-14 |
| AU-04 | A deleted folder is never silently replaced | M1 | AC-15 |
| AU-05 | Two rules that disagree are shown to me, not resolved by luck | M1 | AC-08 |
| AU-06 | An arXiv page lands in Academic with no model call | M1 | AC-01, AC-02 |
| AU-07 | The folder I chose myself always wins | M1 | AC-07, AC-49 |
| AU-08 | Bookmarks I star in the browser follow the same rules | M1 | AC-09, AC-49, AC-55 |
| AU-09 | Bookmarks added on the web, from my phone, or by an agent follow the same rules | M1 | AC-42, AC-58 |
| AU-10 | Save offline, continue later | M1 | AC-10, AC-11 |
| AU-11 | Sync between my browsers does not run the rule twice | M1 | AC-12 |
| AU-12 | The rule picks the folder; my local AI may still suggest tags | M1 | AC-04 |
| AU-13 | See why a bookmark is where it is, and undo one thing | M1 | AC-43, AC-59 |
| AU-14 | Pause everything with one switch | M1 | AC-44, AC-56 |
| AU-15 | My research agent writes a summary and tags after I save | M2 | AC-05, AC-45, AC-53 |
| AU-16 | The agent may refine inside Academic, never outside it | M2 | AC-03 |
| AU-17 | When the taxonomy is ambiguous, keep the parent | M2 | AC-06 |
| AU-18 | Edits I make while the agent is thinking are kept | M2 | AC-24, AC-25 |
| AU-19 | Agent proposals use the approvals I already have | M2 | AC-46, AC-63 |
| AU-20 | No silent fallback to another model or provider | M2 | AC-23 |
| AU-21 | Each agent sees only its own jobs; ordinary agents see nothing new | M2 | AC-17, AC-18, AC-19, AC-60 |
| AU-22 | When the agent is down, saving still works and I can see what is waiting | M2 | AC-16, AC-31 |
| AU-23 | See what automation cost this week, and cap it | M2 | AC-47 |
| AU-24 | Every ten new papers, one digest I can actually read | M3 | AC-20, AC-21, AC-48, AC-65, AC-66 |
| AU-25 | Run a rule once over bookmarks I already have | M3 | AC-50, AC-64 |
| AU-26 | Choose how an agent learns about work: woken by events or polling | M2 | AC-34, AC-35, AC-36, AC-51, AC-61, AC-62 |
| AU-27 | Pause, resume, replay and undo mean different things | M3 | AC-32, AC-33, AC-65 |
| AU-28 | Install someone's workflow using my own folders | M4 | AC-27, AC-67 |
| AU-29 | An upgrade that wants more must ask me | M4 | AC-28 |
| AU-30 | Several agents give independent takes on one batch | M4 | AC-22 |
| AU-31 | Catalog enrichment with my own entity map and vocabulary | M4 | AC-30, AC-68 |
| AU-32 | A weekly digest at a time I choose | Later | AC-29 |
| AU-33 | Rules are in my backup and my export, and leave with me | M1 | AC-52, AC-67 |

---

## A. Set up a rule (M1)

### AU-01 Create my first rule from a folder in two minutes — M1

**Execution constraint:** The executable M1 fixture is m1-rule-create.json; no execution policy or worker is required.
**As the Owner**, I want to open my Academic folder and say "pages from arxiv.org go here", without reading a rule language, so that the feature pays off the first time I save a paper.

Acceptance:
1. On the web collection page, a folder's menu offers "Automate…". It opens the Automations page with a new draft rule whose destination is that folder.
2. The editor asks three things, in this order: *when* (one or more conditions: site is / site ends with / title contains / has tag / URL path starts with), *where* (the destination folder, pre-filled), *then* (optional agent tasks, hidden until M2 is enabled on this server).
3. "Preview" (AU-02) runs before "Enable" is offered. Enabling a rule that has never been previewed is impossible from the UI.
4. The whole flow, from "Automate…" to an enabled rule, takes under two minutes and never shows JSON. The JSON view exists behind "Advanced" for copying, pasting, and agents.
5. The Automations page lists rules with a plain-language sentence each: "When the site is arxiv.org, save to Academic. Enabled since 12 Oct, matched 14 bookmarks."
6. The Automations page is reachable from the main navigation next to Agents, and from the extension's Options tab.

Tasks: AW-01, AW-04, AW-06, AW-10, AW-12, AW-49, AW-63, AW-66. Tests: AC-26, AC-41, AC-54, AC-57. Example: [m1-placement.json](examples/m1-placement.json).

### AU-02 See what a rule would have done before I enable it — M1
**As the Owner**, I want a preview over my own recent bookmarks, so that I know a rule is right before it touches anything.

Acceptance:
1. Preview evaluates the draft against the last 200 bookmarks saved into the scoped collection (newest first) and lists them in four groups: would match, would not match, blocked (destination unusable), conflict (another enabled rule wins or ties).
2. Preview changes nothing: no move, no model call, no agent notification. It stores only an expiring preview record bound to the exact rule, bindings and policy it evaluated.
3. Enabling requires an unexpired preview of exactly the configuration being enabled. Any edit after preview disables "Enable" until "Preview" runs again (AC-26).
4. Preview explains each decision in one line: "matched: host arxiv.org", "blocked: folder Academic was deleted", "conflict with rule 'Papers to Work' (same priority)".
5. A preview with no matches says so, and says why that may be fine: "none of your last 200 bookmarks are from arxiv.org".

Tasks: AW-10, AW-12. Tests: AC-26. Example: [preview-request.json](examples/preview-request.json).

### AU-03 Rename or move a folder without breaking its rules — M1
**As the Owner**, I want to rename Academic to Research, or move it under Reading, and keep my rules working, so that organizing my tree never silently turns automation off.

Acceptance:
1. Rules bind the folder's identity, never its name or path. After a rename, the rule sentence shows the new name within one refresh; counters and the unfinished batch (M3) are unchanged (AC-13).
2. After a move that keeps the folder inside the collection and inside any required ancestor, the rule keeps working and the Automations page shows an informational notice: "Academic moved to Reading › Academic".
3. After a move that leaves a required ancestor, or out of the synced range, the dependent stage blocks with a warning that names the folder, the rule and the fix. Unrelated rules are untouched (AC-14).
4. Moving an ancestor re-checks every rule under it; the notice lists all affected rules at once, not one toast per rule.
5. Acknowledging a notice hides it; it does not mark anything repaired. The notice returns if the condition persists at the next check.

Tasks: AW-08, AW-09, AW-11, AW-12. Tests: AC-13, AC-14. Example: [academic-bindings.json](examples/academic-bindings.json).

### AU-04 A deleted folder is never silently replaced — M1
**As the Owner**, I want a rule whose folder I deleted to stop and tell me, not to guess a new folder with the same name, so that bookmarks are never misfiled or exposed because of a lookalike folder.

Acceptance:
1. Deleting a bound folder blocks every stage that needs it. The Automations page shows "Academic was deleted" with two actions: "Restore folder" (from the sync trash when available) and "Choose another folder".
2. Creating a new folder named Academic does not rebind the rule (AC-15).
3. Saving a matching bookmark while the rule is blocked still saves the bookmark, at the location the user chose or the default location, and records "rule blocked: folder deleted" on that bookmark (AU-13).
4. Restoring the original folder revalidates the rule; it does not replay bookmarks saved while it was blocked. Those remain listed under the rule as "missed while blocked" with a "Run once on these" action (AU-25, M3).

Tasks: AW-08, AW-11, AW-12, AW-41. Tests: AC-15. Example: [academic-bindings.json](examples/academic-bindings.json).

### AU-05 Two rules that disagree are shown to me, not resolved by luck — M1
**As the Owner**, I want to see when two rules want different folders for one bookmark, so that behavior never depends on the order I created them in.

Acceptance:
1. Two enabled rules of equal priority that match the same bookmark with different destinations do not move it. The bookmark stays where it was saved and appears under "Needs a decision" on the Automations page with both rules named (AC-08).
2. Giving one rule a higher priority resolves future conflicts; the preview of either rule shows the conflict before enabling.
3. Tag additions from both rules still apply when they do not contradict each other.
4. A manual choice (AU-07) or a privacy restriction always beats priority.

Tasks: AW-06, AW-07, AW-12. Tests: AC-08. Example: [m1-placement.json](examples/m1-placement.json).

---

## B. Saving (M1)

### AU-06 An arXiv page lands in Academic with no model call — M1
**As the Owner**, I want a paper I save from arxiv.org to go straight into Academic, so that I stop dragging papers out of Other Bookmarks and stop paying my classifier to decide something I already know.

Acceptance:
1. With the rule from AU-01 enabled on this server and the extension signed in, saving an arXiv page through the popup, the keyboard shortcut, the context menu and "Save tabs" creates the native bookmark directly under the Academic folder. There is no create-then-move in the browser (AC-01).
2. The extension does not ask its local classification provider for a folder for that save. If tag suggestions are enabled (AU-12), it may still ask for tags only.
3. The popup result panel says: "Saved to Academic by rule 'arXiv papers'". With a worker configured (M2) it adds "summary pending".
4. If the Academic folder is deleted or unsynced at that moment, the save still succeeds at the default location and the panel says why the rule did not apply (AC-02). Nothing is sent to any classifier instead.
5. The server records one intake run for the bookmark, joined to the sync operation that created it, with the rule revision and the decision. The run is visible on the bookmark's page (AU-13).

Tasks: AW-03, AW-04, AW-05, AW-06, AW-13, AW-17, AW-18, AW-19, AW-35, AW-49, AW-56, AW-63. Tests: AC-01, AC-02. Example: [m1-placement.json](examples/m1-placement.json).

### AU-07 The folder I chose myself always wins — M1
**As the Owner**, I want to keep a folder I picked on purpose even when a rule would have chosen another, so that automation never fights me.

Acceptance:
1. In the popup, changing the folder before saving is an explicit choice. A matching rule does not move the bookmark; the result panel says "Saved to Work (your choice); rule 'arXiv papers' skipped" (AC-07).
2. The remembered last-used folder and the server's default location are not explicit choices; a rule may override them.
3. In the browser's own star dialog (AU-08), a folder that is one of the bookmark roots (Bookmarks bar, Other bookmarks, Mobile bookmarks) counts as "unsorted" and a rule may move the bookmark; any other folder counts as the Owner's choice (AC-49).
4. Moving a bookmark by hand after an agent task started invalidates that task's pending placement proposal (AU-18).

Tasks: AW-07, AW-19, AW-20, AW-56, AW-63. Tests: AC-07, AC-49. Example: [m1-placement.json](examples/m1-placement.json).

### AU-08 Bookmarks I star in the browser follow the same rules — M1

**Execution constraint:** A bookmark-root destination is an explicitly documented heuristic, not proof the Owner made no choice. Subsequent manual moves win; observer timers do not establish that the native dialog closed.
**As the Browser's user**, I want a bookmark created with Chrome's star button, drag to the bar, or the bookmark manager to follow the same rules as a popup save, so that behavior does not depend on which button I pressed.

Acceptance:
1. A bookmark created outside the extension inside the synced range is evaluated after a short settle window (default 3 seconds) so the star dialog's folder choice is seen first. If the bookmark sits in a bookmark root and a rule matches, the extension moves it once and records the decision (AC-09).
2. The move is visible in the browser (the bookmark appears, then jumps). The popup is not involved, so the extension shows one toast: "Moved to Academic by rule 'arXiv papers'".
3. The server receives the create and the move as one intake, not as a new save plus an unrelated move: the receipt names both native operations.
4. Imports, restores, bootstrap snapshots and inbound sync projections never count as a star-button creation.
5. A URL that already exists in the collection is still a new bookmark if the user created it; the rule applies to the new copy.

Tasks: AW-17, AW-20, AW-50, AW-56, AW-63. Tests: AC-09, AC-49, AC-55. Example: [local-receipt.json](examples/local-receipt.json).

### AU-09 Bookmarks added on the web, from my phone, or by an agent follow the same rules — M1

**Execution constraint:** Receipt timeout alone never establishes intake intent. Explicit folders, imports/restores and unknown intent are preserved unless a later verified receipt proves the action is still safe.
**As the Owner**, I want a bookmark I add in the web library on my phone, or one an agent creates, to land where my rules say, so that rules are a property of my collection and not of one browser.

Acceptance:
1. Creating a bookmark in the web library under a folder that is a bookmark root or the collection root applies matching intake rules on the server; the bookmark appears in Academic on the next refresh and the collection history shows one version with cause "automation: rule 'arXiv papers'".
2. A bookmark created by an agent through MCP is treated the same way, with the agent named as the saver.
3. A bookmark created directly inside a specific folder on the web (not a root) is an explicit choice; no rule moves it.
4. The resulting move is projected to every browser as an ordinary sync change; no browser starts a second intake (AU-11).
5. Import is excluded by default. The import preview says "Automation rules are not applied to imports; use 'Run once' afterwards".

Tasks: AW-13, AW-14, AW-16, AW-33, AW-63, AW-64, AW-66. Tests: AC-42, AC-58. Example: [event-facts.json](examples/event-facts.json).

### AU-10 Save offline, continue later — M1
**As the Browser's user**, I want to save and route bookmarks on a train, and have everything else happen when I am back online, so that nothing is lost or done twice.

Acceptance:
1. With a valid rule bundle on the device, saving offline places the bookmark by rule and records the decision locally. Restarting the browser or the extension's service worker keeps that record (AC-10).
2. On reconnect the extension sends the recorded decision; the server joins it to the sync operation of that bookmark and starts only tasks that are not already satisfied. There is never a second intake run (AC-10).
3. An expired bundle (older than its expiry, default 7 days) disables automatic placement and shows "Rules are out of date; connect to refresh". Saving keeps working at the chosen or default location (AC-11).
4. A partial, corrupt or unsupported bundle is rejected as a whole; the previous valid bundle stays in force and a notice is shown (AC-11).

Tasks: AW-03, AW-05, AW-17, AW-18, AW-21, AW-44, AW-49, AW-50, AW-56, AW-63. Tests: AC-10, AC-11. Example: [local-receipt.json](examples/local-receipt.json).

### AU-11 Sync between my browsers does not run the rule twice — M1
**As the Owner with two browsers**, I want a move made by a rule or an agent to appear on my other browser as just a move, so that I never get duplicate tags, duplicate runs or duplicate notifications.

Acceptance:
1. One server-side move projected to two browsers creates no new intake run on either (AC-12).
2. The projection carries the causing run; a browser recognizes it from the sync operation identity, not from a client-reported flag.
3. Automation-caused changes are not blanket-ignored: a rule placement legitimately causes the enrichment stage; only same-stage re-entry is denied, and a hop limit (default 8) stops loops.

Tasks: AW-14, AW-16, AW-20, AW-33, AW-50, AW-56, AW-63. Tests: AC-12. Example: [event-facts.json](examples/event-facts.json).

### AU-12 The rule picks the folder; my local AI may still suggest tags — M1
**As the Owner who configured a local classifier in the extension**, I want a rule hit to skip the folder question but keep my tag suggestions, so that I keep the part of the AI I still want and stop paying for the part I do not.

Acceptance:
1. With the extension's AI tag mode set to Suggest or Add and a rule placing the bookmark, the extension sends one classification request with `folder: false, tags: true` (AC-04).
2. With tag mode Off, no request is sent at all.
3. A tags result applied locally is recorded on the intake receipt as satisfying the tags task, so a server-side tags task (M2) is not run again for the same bookmark and the same tag contract.
4. The folder decision and the tag decision are shown as two separate lines in the result panel.

Tasks: AW-07, AW-19, AW-22, AW-62. Tests: AC-04. Example: [execution-policy.json](examples/execution-policy.json).

### AU-13 See why a bookmark is where it is, and undo one thing — M1

**Execution constraint:** The UI selects one effectReceiptId. M1 compensates only a proven placement; M2 requires an isolated plan effect and conservative collection-content fences. No automation force restore is exposed.
**As the Owner**, I want to open a bookmark and see what automation did to it, so that I can trust it, correct it, and stop it from repeating a mistake.

Acceptance:
1. The bookmark page in the web UI has an "Automation" section listing, newest first: what happened (moved to Academic; tags added: ml, nlp; summary written), by which rule and, for agent work, which agent, and when.
2. Each reversible entry has "Undo". Undo reverts only that effect and refuses with an explanation when the field changed afterwards: "You edited the note after the summary was written; nothing was changed" (AC-43).
3. A tag entry has "Don't suggest this tag again for this rule". The rejection is stored with the rule and respected by later tag tasks on this rule.
4. The extension popup, when the current page is a saved bookmark, shows the same list in compact form under the folder pill.
5. Nothing in this section requires the agent that did the work to be online.

Tasks: AW-12, AW-16, AW-25, AW-34, AW-51, AW-52, AW-63, AW-66. Tests: AC-43, AC-59. Example: [m1-placement.json](examples/m1-placement.json).

### AU-14 Pause everything with one switch — M1

**Execution constraint:** Pause is immediate for connected server admission; a disconnected extension learns it only on bundle refresh or expiry. Once learned, pause cannot be undone by a stale bundle.
**As the Owner**, I want one switch that stops all automation on all my devices, so that when something looks wrong at 11 pm I can stop it first and investigate tomorrow.

Acceptance:
1. The Automations page header and the extension's Options tab both have "Pause all automations". Turning it on stops new rule admissions on the server at once and holds work that is pending; running agent tasks finish but their results wait as proposals (AC-44).
2. Every connected extension stops applying local rules within one bundle refresh (default 5 minutes) and shows "Automations paused by you on 12 Oct".
3. Resuming does not process the bookmarks saved while paused. They are listed under "Saved while paused" with a "Run once on these" action (AU-25).
4. A paused server still answers agents' job reads with "paused" so a worker does not spin.

Tasks: AW-10, AW-12, AW-15, AW-18, AW-41, AW-49, AW-63, AW-66. Tests: AC-44, AC-56. Example: [ten-bookmark-digest.json](examples/ten-bookmark-digest.json).

---

## C. An agent finishes the job (M2)

### AU-15 My research agent writes a summary and tags after I save — M2
**As the Owner**, I want the paper that landed in Academic to have a short summary in its note and two or three subject tags within a few minutes, written by the agent I already connected, so that saving a paper is also the start of reading it.

Acceptance:
1. On the Agents page, an agent has a new switch "Can run automation jobs". Turning it on creates a named target for that agent ("Research") and tells me exactly what the agent will be able to read: bookmarks inside the folders bound to rules that use it.
2. The target shows how it learns about work (AU-26): "Woken by events" once the agent has subscribed over MCP Events and the server is reachable, otherwise "Polls on its own schedule". Events is the default whenever both hold.
3. In the rule editor, the *then* step offers tasks (summary into the note, tags, refine into a subfolder) and asks which target does them. A rule can be enabled with tasks even if the agent is offline; its state shows "waiting for Research".
4. When a job becomes ready, a target in events mode receives one signed wake-up within seconds; the agent then lists ready jobs, claims one, reads the bookmark through the ordinary `nodes.get` tool, and submits a typed result. A polling target does the same at its next check. Neither needs any write tool: the server applies the result (AU-19).
5. The summary appears in the bookmark's note with an attribution line ("Summary by Research, 12 Oct"), the tags are merged with mine, and the bookmark's Automation section lists both effects. The browsers receive them as ordinary sync changes.
6. The rule's page shows "last job finished 4 minutes ago" and each target's wake mode; for a polling target it adds the interval the Owner entered ("checks every 15 minutes") so freshness is stated honestly.
7. A result for a job that was already satisfied by another device or a previous attempt is accepted once and ignored afterwards; no duplicate note, no duplicate tags (AC-05).

Tasks: AW-02, AW-22, AW-23, AW-24, AW-26, AW-27, AW-29, AW-31, AW-32, AW-35, AW-64. Tests: AC-05, AC-45, AC-53. Example: [academic-intake.json](examples/academic-intake.json).

### AU-16 The agent may refine inside Academic, never outside it — M2
**As the Owner**, I want an agent that sorts papers into Academic › Post-training to be unable to move a paper into Work, so that my explicit organization constraints hold even when the model is confident.

Acceptance:
1. A refinement task is bound to a subtree root. A proposal whose destination is outside that subtree at commit time is rejected with a boundary diagnostic and recorded on the job (AC-03).
2. A destination that was inside the subtree when the agent read the tree but was moved out before commit is rejected the same way.
3. A valid descendant is applied as a move through the ordinary change-plan path with a collection version (AU-19).

Tasks: AW-07, AW-16, AW-24. Tests: AC-03. Example: [academic-intake.json](examples/academic-intake.json).

### AU-17 When the taxonomy is ambiguous, keep the parent — M2
**As the Owner with overlapping subfolders**, I want a paper that fits two subfolders equally to stay at Academic and get both subject tags, so that I never get a confident but arbitrary choice.

Acceptance:
1. The placement output contract allows `keepParent` and `review` as decisions; a worker that cannot justify a descendant returns `keepParent` with its reasons, and the bookmark stays (AC-06).
2. Tags from the same job still apply.
3. Scores from different models or providers are never compared with each other as probabilities; the server applies contracts, not confidence thresholds.
4. A `review` decision appears under "Needs a decision" with the candidate folders as one-click actions.

Tasks: AW-07, AW-22, AW-24, AW-39. Tests: AC-06. Example: [academic-intake.json](examples/academic-intake.json).

### AU-18 Edits I make while the agent is thinking are kept — M2
**As the Owner**, I want my own move or note edit to stand even when an agent result arrives later for the same bookmark, so that I always have the last word.

Acceptance:
1. A job records the bookmark revision it read. A result that would change a field edited after that revision is not applied; the job ends as "stale" and the proposal is kept for review where it still makes sense (AC-24).
2. A result from a lease that expired and was reassigned is rejected even if the first agent finishes later (AC-25).
3. A tag addition that does not depend on the edited field may still be applied; the job detail explains what was applied and what was dropped.

Tasks: AW-23, AW-24, AW-25, AW-35, AW-64. Tests: AC-24, AC-25. Example: [academic-intake.json](examples/academic-intake.json).

### AU-19 Agent proposals use the approvals I already have — M2
**As the Owner**, I want automation effects to go through the same plan, approval, version and Undo machinery my agents already use, so that there is one place to look and one set of rules to learn.

Acceptance:
1. Every effect (move, tags, note) is committed as a change plan with cause `automation:<ruleId>:<jobId>`; the collection history shows a version per committed plan, exactly like an agent-organize plan today.
2. If the target's agent has the Manual policy, the plan waits on the Approvals page with the rule and job named; approving applies it under current authority and current revisions. If the agent is Trusted, reversible effects commit immediately with Undo (decision D8 of the product plan) (AC-46).
3. Irreversible operations (delete, visibility) are never produced by automation tasks; the effect gateway refuses to build such a plan.
4. The Approvals page filter "Automation" shows only automation plans.

Tasks: AW-24, AW-25, AW-35, AW-52, AW-56, AW-64. Tests: AC-46, AC-63. Example: [academic-intake.json](examples/academic-intake.json).

### AU-20 No silent fallback to another model or provider — M2
**As the Owner**, I want work to wait when my chosen agent or local key is unavailable, so that my data never goes to a provider I did not approve and I never get a surprise bill.

Acceptance:
1. Each task names exactly one target or executor. When it is unavailable, the job waits; no alternate destination is tried (AC-23).
2. In the extension, losing the local key disables the local tags request; it does not switch to any cloud provider (existing behavior, kept).
3. The rule page shows where data goes for each task: "Research (your agent, runs where you run it)", "Local provider (this browser, endpoint you configured)". Execution location and data destination are shown separately.

Tasks: AW-22, AW-23, AW-48, AW-62. Tests: AC-23. Example: [execution-policy.json](examples/execution-policy.json).

### AU-21 Each agent sees only its own jobs; ordinary agents see nothing new — M2

**Execution constraint:** Worker-only bootstrap exposes pair, then queue list/get/inputs/claim/heartbeat/submit/fail after binding. Manager authority is not a prerequisite. Broad separately granted node tools are not restricted by a job-only allowlist.
**As the Owner**, I want agents I did not enable for automation to keep seeing exactly the bookmark tools they see today, and a worker to see only the jobs for its own target, so that my work and personal workflows never mix and no agent gets a surprise tool list.

Acceptance:
1. An agent without "Can run automation jobs" lists the same tools as before this feature; calling an automation tool by name is refused (AC-17).
2. A worker lists its job tools before any job exists and before any subscription exists (AC-18).
3. With two targets ("Research", "Personal") on two agents, a job routed to Research is never listed to Personal. If both targets share one OAuth client, the Agents page says so: "These two inboxes share one login; they are separate queues, not a security boundary" (AC-19).
4. A worker reads bookmark content only through ordinary read tools under its ordinary scopes; the job grant adds nothing beyond the job itself.

Tasks: AW-02, AW-26, AW-30, AW-31, AW-35, AW-53, AW-64. Tests: AC-17, AC-18, AC-19, AC-60. Example: [mcp-subscribe.json](examples/mcp-subscribe.json).

### AU-22 When the agent is down, saving still works and I can see what is waiting — M2
**As the Owner**, I want placement to keep working when my agent has not run for a week, and a clear list of what is waiting, so that a dead agent never degrades basic bookmarking and I know when to go fix it.

Acceptance:
1. With the enrichment target unavailable, intake placement continues locally and on the server; the rule shows "working, 7 jobs waiting for Research (last seen 6 days ago)" (AC-16).
2. The Automations page has "Needs attention" at the top: blocked rules, waiting jobs older than a day, deleted folders, expired subscriptions, each with a repair action. None of it requires the failing agent (AC-31).
3. Zero matches is not an error. A rule with no matches says "no matching bookmarks in the last 30 days", not "broken".
4. Health signals the operator can read on `/ready` and in logs carry only low-cardinality reason codes, never titles, URLs or folder names.

Tasks: AW-11, AW-34, AW-54, AW-55. Tests: AC-16, AC-31. Example: [academic-bindings.json](examples/academic-bindings.json).

### AU-23 See what automation cost this week, and cap it — M2
**As the Owner**, I want to see how many jobs and model calls my rules caused and to cap them per rule and per day, so that a runaway rule or a big import can never produce a big bill.

Acceptance:
1. Each rule shows runs, jobs and calls for the last 7 and 30 days. For agents, cost is shown as "billed by your agent" (unknown to COLP); for the extension's local provider, calls are counted.
2. A rule has a daily run cap (default 100). Reaching it does not drop bookmarks: they are placed by rule (no model involved) and their tasks queue as "held: daily cap"; the cap and the hold are visible (AC-47).
3. A server-wide daily cap on jobs exists in configuration; reaching it pauses enrichment, not placement.

Tasks: AW-22, AW-34, AW-54, AW-55. Tests: AC-47. Example: [execution-policy.json](examples/execution-policy.json).

### AU-26 Choose how an agent learns about work: woken by events or polling — M2

**Execution constraint:** Official dot support is a candidate integration, not proof of a COLP run. The backend decides readiness; mode selection cannot overcome unreachable transport or missing account/permission support.
**As the Owner**, I want each agent to be woken the moment a job is ready when that is possible, and to fall back to polling when my server cannot be reached, so that summaries arrive in minutes on a public server and automation still works on a home server.

Acceptance:
1. Each target has a wake mode: "Events (the server wakes the agent)" or "Poll (the agent checks on its own schedule)". The Agents page proposes the default from the server origin: events on a public HTTPS origin; poll on `http://127.0.0.1:8080` or a `tls-internal` LAN origin, with the reason stated: "Wake-up needs a server the agent's platform can reach over HTTPS". The Owner can override either way (AC-51).
2. Events mode with a hosted bot (a ChatGPT dot): the Owner creates the target and gets a one-use pairing code; the bot pairs over its MCP connection, then subscribes with MCP Events. The server verifies the callback with a signed challenge and afterwards delivers small signed wake-ups carrying job and run references only. Private destinations, redirects and credential forwarding are refused (AC-34, AC-35). An agent that already authenticates on this server needs no code.
3. A wake-up is not the work: the agent still claims the job and submits a result exactly as a polling agent does. A crash after a 2xx delivery may wake the agent twice; it never produces two effects (AC-36).
4. Poll mode: the target page shows the exact MCP tools and the HTTP work API the agent uses, and asks for the agent's polling interval so the rule page can state expected freshness.
5. Switching a target from poll to events requires the agent to subscribe; until then the target shows "events requested, not yet subscribed" and keeps polling semantics. Switching back cancels pending wake-ups and leaves jobs in place.
6. An expired or revoked subscription appears under Needs attention with "ask Research to reconnect"; placement and polling are unaffected.

Tasks: AW-02, AW-26, AW-27, AW-28, AW-29, AW-32, AW-35, AW-46, AW-53. Tests: AC-34, AC-35, AC-36, AC-51, AC-61, AC-62. Example: [mcp-occurrence.json](examples/mcp-occurrence.json).

---

## D. Batches and run-once (M3)

### AU-24 Every ten new papers, one digest I can actually read — M3

**Execution constraint:** AW-57 implements count aggregation; AW-58 implements output/unread persistence; Web AW-45 and extension AW-60 only render those DTOs.
**As the Owner**, I want one reading digest for each ten papers that enter Academic, so that I am interrupted once, not ten times, and I have a place to read the digest.

Acceptance:
1. A count rule with "every 10" admits distinct bookmarks into a batch; when the tenth arrives, one run is created with exactly those ten members. Two arrivals at once with nine waiting produce one run of ten and one waiting (AC-20).
2. A retried sync delivery, a move, or a restore does not count. Deleting a member after admission leaves a hole that is reported, never refilled (AC-21).
3. The digest text lives on the run's page under Automations › Digests, with the ten bookmarks linked and unavailable ones marked. The Automations page shows an unread count; the extension's badge shows "1 new digest" once. A hosted bot may additionally show the digest in its own chat (AC-48).
4. Renaming the folder mid-batch keeps the batch; changing the destination folder or the count starts a new batch and says so in the preview.

Tasks: AW-05, AW-15, AW-16, AW-29, AW-34, AW-44, AW-45, AW-57, AW-58, AW-60. Tests: AC-20, AC-21, AC-48, AC-65, AC-66. Example: [ten-bookmark-digest.json](examples/ten-bookmark-digest.json).

### AU-25 Run a rule once over bookmarks I already have — M3

**Execution constraint:** Start submits previewId and previewDigest for the immutable selection; expiry, changed options/revisions or more than 1000 members require a fresh/smaller preview. Large admitted runs commit in bounded chunks so saves can proceed between them. Cancellation or failure retains completed effects; recovery continues only the original pending members, rechecking their revisions and authority. Start may return a running parent before placement finishes; per-effect Undo remains available.
**As the Owner**, I want to point a rule at a folder I already have (or at a fresh import) and run it once with a preview, so that years of unsorted bookmarks can be organized the same way new ones are.

Acceptance:
1. A rule's page offers "Run once on…" with a folder picker. The preview shows how many bookmarks match, a sample of twenty, and what would happen (placement only, or placement plus tasks), before anything runs (AC-50).
2. Confirming creates one run of kind `manual` with the exact members pinned, capped at 1,000 members per run; larger folders run in pages the Owner starts one at a time.
3. Explicit folder choices are respected the same way as for new saves: bookmarks that already sit in a non-root folder are moved only when the Owner ticks "also move bookmarks already in folders".
4. A run-once run appears in the bookmark's Automation section like any other and can be undone per effect. It never re-runs on its own.
5. This is the documented path for imports and for "Saved while paused" and "missed while blocked" lists.

Tasks: AW-12, AW-16, AW-41, AW-59. Tests: AC-50, AC-64. Example: [academic-intake.json](examples/academic-intake.json).

### AU-27 Pause, resume, replay and undo mean different things — M3
**As the Owner**, I want to pause a rule, resume it later, replay a chosen set of past events on purpose, and undo what a run did, each with a clear and separate meaning, so that I never cause mass processing by accident.

Acceptance:
1. Pause stops new admissions for the rule and holds pending jobs; the partial batch is kept. Resume starts from now with a new fence and does not backfill the paused interval (AC-32).
2. "Run once" (AU-25) is the only way to process past bookmarks in M3; event-time replay from retained facts is a Later capability and is shown as unavailable until then.
3. Undo on a run reverts only effects whose fields were not changed afterwards and lists the ones it left alone (AC-33).

Tasks: AW-15, AW-25, AW-34, AW-44, AW-47, AW-57. Tests: AC-32, AC-33, AC-65. Example: [ten-bookmark-digest.json](examples/ten-bookmark-digest.json).

---

## E. Share the logic (M4)

### AU-28 Install someone's workflow using my own folders — M4
**As the Owner**, I want to install a published paper workflow and bind its roles to my own Research folder and my own agent, so that I reuse the logic without adopting someone else's taxonomy.

Acceptance:
1. Importing a package stores it inert; nothing runs. Installing asks for each declared role (folder, agent, vocabulary) and produces a draft rule with a preview (AC-27).
2. No folder is created on install; a missing optional destination keeps the parent or goes to review as the package declares.
3. Two Owners with unrelated folder names install the same package and get equivalent behavior with their own identities.

Tasks: AW-36, AW-37, AW-61. Tests: AC-27, AC-67. Example: [paper-template.json](examples/paper-template.json).

### AU-29 An upgrade that wants more must ask me — M4
**As the Owner**, I want a template upgrade that adds a task, a destination or broadcasting to show me the difference and ask again, so that I never trust every future change of a publisher.

Acceptance:
1. Upgrading shows a semantic diff: new tasks, new data destinations, new permissions, changed aggregation. Expanded authority requires a new consent (AC-28).
2. In-flight runs stay pinned to the old version; rollback to the previous version is one action and does not replay anything.
3. Export of my installed rule strips my folders, agents, secrets and private examples by default.

Tasks: AW-36, AW-38, AW-61, AW-65. Tests: AC-28. Example: [paper-template.json](examples/paper-template.json).

### AU-30 Several agents give independent takes on one batch — M4
**As the Owner with more than one agent**, I want each agent that opted in to receive its own copy of a batch and write its own analysis, so that I can compare perspectives without the agents fighting over one folder.

Acceptance:
1. A broadcast rule fixes the recipient list when the run is created; each recipient gets its own job and its own append-only result. One recipient failing does not re-notify the others (AC-22).
2. Placement tasks are refused in broadcast mode at validation.
3. A target added later does not receive old private batches.

Tasks: AW-29, AW-42. Tests: AC-22. Example: [broadcast-digest.json](examples/broadcast-digest.json).

### AU-31 Catalog enrichment with my own entity map and vocabulary — M4

**Execution constraint:** The formal example is an institutional research dataset archive: accession ID → evidenced research-group mapping → authorized directory → controlled-vocabulary tags. It is synthetic, restricted and non-broadcast.
**As the Owner of a research catalog collection**, I want a dedicated worker to identify a saved item by its catalog number, fetch permitted text metadata, and file it under the entity folder I mapped with labels from my own vocabulary, so that repetitive metadata work disappears without the system guessing.

Acceptance:
1. The rule binds a private intake folder, a dedicated worker (its own credential), an entity map (entity key → my folder) and a vocabulary (label key → my tag). These are bindings, not product features: the same rule works for books, films or datasets (AC-30).
2. A confirmed single entity is filed and tagged from the map and vocabulary only. Unknown or multiple entities stay in the intake folder under "Needs a decision".
3. Identity is never inferred from images; only text metadata from the sources the worker is allowed to read.
4. The rule is `restricted`: no broadcast, dedicated credential required, and the Agents page shows the isolation status.

Tasks: AW-37, AW-39, AW-61. Tests: AC-30, AC-68. Example: [research-catalog.json](examples/research-catalog.json).

---

## F. Later

### AU-32 A weekly digest at a time I choose — Later
**As the Owner**, I want one non-empty digest every Friday at 18:00 in my timezone, so that collecting turns into a reading habit.

Acceptance:
1. A schedule rule has a five-field cron and an IANA timezone; a missed instant during downtime fires once on recovery (coalesce) or is skipped, as configured; DST gaps and repeats are deterministic (AC-29).
2. A server without the scheduler capability refuses to enable the rule instead of approximating it.

Tasks: AW-40. Tests: AC-29. Example: [weekly-digest.json](examples/weekly-digest.json).

---

## G. Lifecycle (cross-cutting, M1)

### AU-33 Rules are in my backup and my export, and leave with me — M1
**As the Owner**, I want my rules to be part of backup, restore, export and uninstall exactly like my bookmarks, so that automation never becomes the thing that ties me to one installation.

Acceptance:
1. `deploy/backup.sh` includes the automation tables; `deploy/restore.sh` restores them and starts the server with automation paused until the Owner resumes it (AC-52).
2. `colp-server export` and the web Export menu include `automations.json` (rules and folder bindings by path, no agent secrets, no pairing codes).
3. "Disconnect server" in the extension deletes the local rule bundle and local receipts; `docker compose down -v` leaves nothing behind.
4. The CHANGELOG "Upgrade notes" line names the automation migrations and that they are forward-only.

Tasks: AW-01, AW-09, AW-44, AW-63, AW-66. Tests: AC-52, AC-67. Example: [academic-bindings.json](examples/academic-bindings.json).

---

## Worked end-to-end narrative (M2 release proof)

The Owner opens Academic in the web library, chooses "Automate…", adds the condition "site is arxiv.org", previews it against the last 200 bookmarks (three would have matched), and enables it. On the Agents page they turn on "Can run automation jobs" for the ChatGPT dot they connected last week; a target named Research appears with wake mode "Events" proposed, because the server runs on a public HTTPS origin. They copy the pairing code to the dot; it pairs and subscribes, and the target shows "Woken by events, subscription valid until tomorrow". Back in the rule, they add "write a summary into the note" and "add up to three tags" for Research and enable the new revision after a fresh preview.

On the laptop they save an arXiv page with the keyboard shortcut. The bookmark is created directly under Academic; the result panel says "Saved to Academic by rule 'arXiv papers' · summary pending". The extension's local provider is asked for tags only. The desktop browser receives the bookmark under Academic as an ordinary sync change and starts nothing.

Within a minute the dot receives one signed wake-up, lists one ready job for Research, claims it, reads allowlisted inputs with `automation.jobs.inputs`, and submits a summary and three tags. The server applies them through a change plan with cause `automation:…`; the agent is Trusted, so the plan commits and a collection version is saved. Both browsers receive the note and tags. The bookmark's page lists two effects with Undo. The Owner removes one tag by hand; a day later a second attempt (the first lease had expired during a platform outage) is rejected as stale and nothing changes.

On the Owner's second server, which runs on `http://127.0.0.1:8080`, the same rule is installed and the Research target is set to Poll because the page said wake-up is unavailable there. Claude Code's routine runs every 15 minutes, finds the job, and completes it the same way.

The Owner renames Academic to Research Papers; the rule sentence updates and a notice appears. They delete a test folder a second rule pointed at; that rule blocks, the save still works, and the Automations page offers Restore or Choose another. An ordinary agent connected with an API key still lists only the sixteen bookmark tools.

This narrative is the M2 release's principal end-to-end proof. Unit fixtures in this pack do not establish it; capture it against a real browser, a real server database, a real hosted bot on a public origin and a polling agent before release.

## Worked-proof fixture selection

Use academic-summary-only.json when asserting one external job: deterministic root placement is already satisfied and the only worker task is summary.generate. Test tags/refinement with the separate academic-intake.json fixture, which declares three worker tasks and can therefore create three jobs. A retry can repeat an occurrence; a hosted task may group several occurrences. Assert unique accepted effects per job/input/contract, never a one-to-one relation between bookmark, HTTP delivery and ChatGPT run.

---

<!-- Source chapter: 04-api-guide.md -->

# API Guide and OpenAPI Integration

**Status:** design contract, not deployed. **Version:** 0.2.1-design. Two self-contained OpenAPI 3.1.0 documents are supplied: [Product, device and worker API](api/automation.openapi.yaml) and [MCP Events and outbound webhooks](api/mcp-events.openapi.yaml). The existing Product API stays authoritative for session, command and error integration (R11, R13, R23). Operation milestones are tagged `x-delivery-phase` in the YAML and listed in [operations.json](api/operations.json).

## 1. Surface boundaries

| Surface | Authentication | Purpose | Milestone |
|---|---|---|---|
| `/api/v1/me/automations/*` | Owner Product session: cookie `__Host-known_session` (`known_session` on acknowledged plain HTTP), `x-csrf-token` header plus Origin allowlist on writes (R23) | Rules, bindings, policies, targets, health, runs, approvals, pause, run-once, export, templates | M1+ |
| `/api/v1/automation-device/*` | The extension's existing device/replica bearer with a new `automation:device` grant | Rule bundles and intake receipts | M1 |
| `/api/v1/automation-work/*` | Agent bearer (OAuth or API key) with `automation:work` and a target binding | List, claim, heartbeat, submit, fail for workers that prefer HTTP over MCP tools | M2 |
| MCP endpoint (manifest-discovered) | Existing MCP OAuth and resource audience | Worker tools, manager tools and `events/*` methods | M2 |
| Subscriber callback (outbound) | Standard Webhooks signature; no COLP credential forwarded | Wake-up for targets in events mode | M2 |

Device and work bearer routes do not accept cookies and do not use the CSRF header; they still enforce CORS and audience policy. No new authentication issuer is introduced.

## 2. Common Product contract

Every read is current-authorized and private. Cursors are opaque, owner-scoped, bound to the normalized filter and ordering. Lists accept `limit` 1–100 and return `items` with nullable `nextCursor`, ordered by `(created_at, id)` unless the resource says otherwise. No arbitrary filtering in v1; typed filters only.

Every mutation carries `Known-Command-Id`. Same command and body replays the stored result; same command and different body is `409 automation_command_conflict`. Writes that change existing configuration or approve a proposal require `If-Match` with the resource ETag; node and collection revisions are separate fences. GET never runs a model or changes a bookmark. Validate and preview may store expiring diagnostic records; they never classify, deliver, publish or spend.

The verified Product error envelope is reused unchanged (R13):

```json
{
  "error": {
    "code": "automation_binding_unavailable",
    "message": "A required folder binding is unavailable.",
    "requestId": "request_demo",
    "recovery": "user_action",
    "sameRequestRetrySafe": false,
    "precondition": null,
    "currentEtag": null,
    "retryAfterSeconds": null,
    "fieldErrors": [
      {"path": "bindings.academicRoot", "code": "deleted", "message": "Choose a live authorized folder."}
    ]
  }
}
```

`automation_*` codes are additions to the host's closed error registry (`transport/product-codes.ts`). Never return Publication Problem Details from these routes.

## 3. Errors and recovery

| HTTP | Code | Recovery |
|---|---|---|
| 400 | `invalid_request` | Fix the shape; do not retry unchanged |
| 401 | `authentication_required` | Reauthenticate through the existing flow |
| 403 | `automation_mode_disabled`, insufficient scope | Enable the capability or obtain authority; capability alone never authorizes |
| 404 | `resource_not_found` | Foreign, unknown and disabled resources are concealed alike |
| 409 | `automation_rule_conflict`, `automation_binding_unavailable` | Repair the conflict or binding |
| 409 | `automation_command_conflict` | Retry with the original body or a new command ID |
| 409 | `automation_lease_conflict`, `automation_stale_input` | Re-read the job; never force an old result |
| 412 | `precondition_failed` | Read the fresh ETag and rebase explicitly |
| 413 | `payload_too_large` | Reduce bounded content |
| 422 | `automation_unsupported_capability`, `automation_invalid_graph` | Change the rule or install the capability |
| 428 | `precondition_required` | Supply `If-Match` |
| 429 | `automation_budget_exhausted`, `rate_limited` | Respect `Retry-After`; never rotate identity to evade limits |
| 503 | `service_unavailable`, `automation_paused` | Bounded retry when `sameRequestRetrySafe`; a paused server tells workers to back off |

## 4. Lifecycle sequences

### Create and enable (M1)

Create the draft rule (the web editor creates its binding set in the same flow). Validate. Preview over the last 200 bookmarks in scope or over supplied facts. Enable through lifecycle with the rule ETag and the accepted preview ID. Activation recomputes authority and source fences. Desired state and effective state are separate: a rule can be enabled while its worker target is unavailable ("degraded"); a missing intake folder blocks admission.

### Pause all (M1)

`POST /api/v1/me/automations/pause` with `{ "paused": true }` stops admission for every rule, holds pending jobs and sets the bundle flag. Workers that list jobs receive `503 automation_paused` with `Retry-After`. Resume captures fresh source/activation high-water fences and does not backfill. Offline devices learn pause only on refresh or stop when their cached bundle expires; the UI must expose this limit. A previously learned pause cannot be rolled back by an older bundle. Bookmarks saved while paused can later be selected explicitly by M3 run-once; M1 must not imply that action is already available.

### Device handoff (M1)

GET the bounded full bundle; validate digest, profile, version and expiry; install atomically; acknowledge. The bundle references canonical folder identities; the device resolves them to native IDs itself. POST intake receipts with device generation and the sync operation identity; the server may answer `waitingForSync`. Repeating a receipt is idempotent. Bundle replacement carries `removedRuleIds`; an oversized bundle is refused with a diagnostic, never served partially.

### Worker execution (M2)

A worker sees only jobs for its own target. A target in events mode is told when to look; a target in poll mode looks on its own schedule. Either way it lists ready jobs, claims one (atomic; opaque lease token and generation), reads only allowlisted data through `automation.jobs.inputs` or `getAutomationWorkInputs` under current job/source authority, heartbeats, and submits a typed result bound to the original input digest and contract. `succeeded` means the typed result and any required canonical effect have been durably accepted; `awaitingApproval`, `review` and `stale` are not success. A failure report distinguishes `knownRetryable`, `permanent` and `unknownOutcome` before any reassignment.

The same contract is exposed twice: as the `automation.jobs.*` MCP tools (for agents that live in an MCP client) and as `/api/v1/automation-work/*` (for scripts and cron). Neither grants write tools; the server applies results.

### Approve and undo (M1 placement; M2 agent plans)

M1 records deterministic placement effects and permits a proven compensating move without an agent. M2 canonical agent mutations use a change plan with cause `automation:<ruleId>:<jobId>` and existing manual/trusted approvals. `undoAutomationRun` takes one effectReceiptId and digest; the baseline uses collection-content fences, not arbitrary field-level restore. Unknown before-state or newer content returns undo-unavailable/conflict. No automation force-restore flag is exposed. Plan commit and job bookkeeping use durable idempotent orchestration and reconciliation, not an assumed nested transaction.

### Run once (M3)

`POST /api/v1/me/automations/rules/{ruleId}/run-once/preview` returns counts and a sample for a folder; `POST .../run-once` creates a `manual` run using required previewId/previewDigest and exactly the unexpired stored member/revision snapshot (≤ 1,000). Changed options, configuration or source revisions require a new preview. Over-limit previews cannot start; no silent truncation. It never schedules itself again.

### Export (M1)

`GET /api/v1/me/automations/export` returns PortableRuleDefinition with symbolic collection/target slots and optional private folder-path hints, without live target IDs, secrets or pairing codes, for the web Export menu and `colp-server export`.

### Wake-up (M2)

Target created → authenticated worker pairing (or explicit Owner binding of an existing credential) → the agent pairs over MCP → for events mode the agent subscribes with `events/subscribe` → callback verified → ready-job occurrences delivered. A hosted run may handle several occurrences and deliveries may retry. Targets in `poll` mode receive no occurrence; their jobs wait in the ready list. Switching modes is a target update with `If-Match`. Details in [the Events adapter](05-mcp-events.md).

## 5. Operation inventory

Path presence is not a feature claim; the capabilities response lists mounted behavior only. Full list with method and path in [operations.json](api/operations.json).

| Milestone | Operations |
|---|---|
| M0 | `getAutomationCapabilities` |
| M1 | rules: `validateAutomationRule`, `previewAutomationRule`, `listAutomationRules`, `createAutomationRule`, `getAutomationRule`, `replaceAutomationRule`, `setAutomationRuleLifecycle`, `getAutomationRuleHealth`, `getAutomationRuleDependencies`, `revalidateAutomationRule`; binding sets: list, create, get, replace; incidents: list, acknowledge; runs: `listAutomationRuns`, `getAutomationRun`, `cancelAutomationRun`, `undoAutomationRun` (verified placement only); `setAutomationPause`; `exportAutomations`; device: `getAutomationDeviceBundle`, `acknowledgeAutomationDeviceBundle`, `ingestAutomationIntakeReceipt` |
| M2 | execution policies: list, create, get, replace; targets: list, create, get, replace, `createAutomationTargetPairing`, `revokeAutomationTarget`; connection profiles: list, create, get, replace; executors: list, get (created automatically with a target); subscriptions: `listAutomationSubscriptions`, `revokeAutomationSubscription`; deliveries: `listAutomationDeliveries`, `retryAutomationDelivery`; `getAutomationJobForOwner`, `decideAutomationJob`; extends `undoAutomationRun` to linked agent plans; work: `claimAutomationTargetPairing`, `listAutomationWork`, `getAutomationWork`, `getAutomationWorkInputs`, `claimAutomationWork`, `heartbeatAutomationWork`, `submitAutomationWorkResult`, `reportAutomationWorkFailure` |
| M3 | `previewAutomationRunOnce`, `startAutomationRunOnce`, `listAutomationRunOutputs`, `markAutomationRunRead` |
| M4 | templates: list, import, install, export |
| Later | `replayAutomationRule`, `createAutomationExecutor`, `replaceAutomationExecutor` |

## 6. Schema and semantic mapping

`RuleInput` is shared by create, validate and preview. `RuleDefinition` is live deployment logic; `PortableRuleDefinition` is shareable logic before binding; `BindingSetInput` and `ExecutionPolicyInput` are local configuration. Worker results use `TaskOutput` discriminated by kind. Restrictions that JSON Schema cannot express are mandatory in the semantic validator.

`TargetInput.wakeMode` (`events` or `poll`) and `pollIntervalMinutes` are target settings; the backend proposes the selected mode and computes readiness using actual authority/verification/reachability. Owner selection does not override readiness checks. A target created from the Agents page creates its executor record; `Executor.verifiedCapabilities` is what the server has seen the agent complete, not what the agent declares. Provider credentials (Later server-model executors) are host-owned references, never returned.

The example execution policy has zero COLP-billed budget and `externalCosts: unknownDisclosed`: the agent bills its own platform. A strict monetary cap can only be promised for executors whose cost is known; otherwise the UI says "billed by your agent".

## 7. Existing repository integration

Add `packages/server/openapi/fragments/automations.yaml` and reference it from the bundle source so that `colp-server-v1.yaml` includes the new paths and components; prefix component names (`Automation…`) to avoid collisions. Run the existing pipeline; never hand-edit `packages/server/generated/openapi/*` or `packages/web/src/generated/*`:

```sh
npm --prefix packages/server run openapi:lint
npm --prefix packages/server run openapi:generate
npm --prefix packages/server run openapi:ci
npm --prefix packages/web run generate:api-types
```

Routes register through the route manifest derived from the bundle (`transport/product-route-manifest.ts`); feature-gated operations join the existing gate lists so readiness coverage stays honest. MCP tools and Events methods use the same application services with MCP framing. Product DTOs map to application commands; they never become COLP Sync wire types.

## 8. Worked client interaction

```http
POST /api/v1/me/automations/rules
Content-Type: application/json
Known-Command-Id: a1d3bb12-5a80-4e04-8a50-596501da3c8f
Origin: https://colp.example.invalid
x-csrf-token: <host-token>
Cookie: __Host-known_session=<host-session>

<contents of examples/m1-rule-create.json>
```

The 201 response contains a draft Rule and ETag. A separate lifecycle call enables it after preview. A 201 is not proof that any agent will run a job. Companion examples carry synthetic IDs and an unusable all-zero demonstration secret; never treat this pack as a credential bundle.

## 9. Contract ownership

The backend owns OpenAPI, result states and permission decisions; Web/extension consume generated DTOs and versioned fixtures. Catalogs are a composable set; pre-pair worker authority exposes only pairing, not manager functions. The complete worker interface includes queue list and HTTP pairing. Run outputs are paginated backend data; read commands name the last viewed output so concurrent outputs remain unread. See [execution contract](11-execution-contract.md) and [delivery lanes](12-delivery-lanes.md).

---

<!-- Source chapter: 05-mcp-events.md -->

# MCP Events and Conditional Tool Catalog

**Status:** proposed M2 adapter; not a deployed or tested COLP/dot integration. **Version:** 0.2.1-design. **Review date:** 2026-10-13. W01/W02/W09/W10 identify primary references in [the evidence register](08-evidence-and-decisions.md). [The OpenAPI](api/mcp-events.openapi.yaml) describes method payloads, not a second REST endpoint or the complete MCP envelope.

## 1. Keep the chosen architecture

MCP Events is the preferred hosted-worker wake-up path. `automation.jobs.list`, get, inputs, claim, heartbeat, submit and fail are the durable worker contract in either wake mode. A webhook points to work; it neither authorizes an effect nor proves completion. Per-target polling is the alternative for a worker that can reach COLP, not an implementation of protocol `events/poll` and not a way for an unreachable hosted bot to access a LAN.

For v1, the tested hosted topology is an externally reachable HTTPS MCP endpoint and public HTTPS callbacks. These are two different network directions. Official tunnel connectivity exists for other MCP integrations (W10); this pack makes no unverified claim that Events through a tunnel works or is impossible. It is outside v1 acceptance. Origin shape is a setup hint only. The backend returns `wakeMode`, `wakeReadiness` and `wakeReason`; an Owner override cannot bypass reachability, authentication, callback verification or workspace controls.

## 2. Official capability versus integration evidence

W01 documents MCP `2026-07-28`, `server/discover` with `events`, and `events/list`, `events/subscribe`, `events/unsubscribe` on the same authenticated endpoint as tools. The documented OpenAI integration uses webhook delivery and verification; do not mount draft poll, stream, gap or terminated behavior. Work chat support is surface-specific (web, or desktop Work with Cloud); dots are also named. Availability and workspace settings still apply.

W09 defines a dot as an always-on cloud agent, not a COLP executor class or a credential type. Its own computer/browser does not imply unlimited permissions, guaranteed unattended completion, a dot-creation API in COLP, or distinct OAuth identities for two dots. Only AW-02/AW-46 can establish the selected account's actual lifecycle and identity behavior. Neither test was run while reviewing this document pack.

The experimental sketch W02 is a draft with poll/push and provisional errors. Keep the OpenAI compatibility profile separate: W01 uses `-32015 CallbackEndpointError`; the current draft uses a different provisional allocation (`-32027`). Never mechanically renumber the OpenAI adapter from the draft. Pin descriptor and request fixtures plus the COLP SDK boundary. Capability advertisement must fail closed if schemas strip the extension.

## 3. Composable catalogs and bootstrap

`ConnectionProfileInput.catalogs` is an explicit set containing `standard`, `automationManager` and/or `automationWorker`. The two automation choices are independent Owner opt-ins, not ambiguous states of a single radio button. Profile visibility and current scopes are both required.

| Membership/state | Added tools | Required authority |
|---|---|---|
| standard only | None | No automation instructions or resources leak into ordinary clients |
| automationManager | rules.describe, bindings.list, targets.list, rules.validate, rules.preview, rules.save, rules.set_state (all prefixed `automation.`) | Explicit manager opt-in and each tool's read/manage scope |
| automationWorker, not paired | `automation.targets.pair` only | Authenticated worker opt-in, `automation:work`, one-use Owner grant bound to expected client/credential |
| automationWorker, paired | Pair plus `automation.jobs.list`, get, inputs, claim, heartbeat, submit, fail | Current target binding, work scope, job/input authority |

The [catalog](api/mcp-tool-catalog.json) contains 15 descriptors: seven manager and eight worker tools. It is a design registry, not a wire `tools/list` response; prune internal metadata and unreachable definitions when generating the actual catalog. Apply the same authorization on `tools/call`. Include tenant, credential/client binding, scopes, profile revision and host mode in caches. A client name such as “dot” grants nothing.

## 4. Pairing in both transports

The Owner creates the connection profile/target and a short-lived grant. The intended authenticated worker redeems it with `automation.targets.pair` or `POST /api/v1/automation-work/pairings/claim`. The pre-pair request is not required to have a target already and never needs manager scope. Atomically verify and consume the grant, rate-limit failures, bind the target, and make subsequent work tools visible. A server may perform an equivalent explicit Owner binding for an existing known local credential, but it must not infer it from a name, callback or access to the endpoint.

Pairing codes never enter subscription arguments, query strings, exported templates or logs. A target is a logical inbox. Multiple targets sharing a credential are not mutually isolated principals; restricted rules require demonstrably dedicated credential bindings. The job ledger issues `deliveryHandle` in both Events and poll mode; it is an authenticated locator, not a webhook ID or bearer authorization.

## 5. Discovery, subscribe and TTL

Expose `colp.automation.triggered`, filtered by current principal authority, with subscription arguments `{targetId}`. `payloadSchema` describes `data`, not the outer occurrence. Subscription identity is authenticated principal, callback URL, event name and canonical arguments. Refresh preserves that identity and changes neither job membership nor job IDs.

V1 explicitly implements no event replay: request cursor must be null; response cursor is null and truncated is false. A non-null cursor fails validation rather than pretending to restore history. Omitted TTL uses a finite server default; a requested TTL may be shortened or raised to a configured minimum as documented by W01. V1 declines indefinite lifetime by granting a finite `refreshBefore`. Persist the granted deadline and require refresh before it. Changing descriptors requires a platform plugin rescan as applicable, not merely a local cache clear.

## 6. Callback verification and signing

Validate `whsec_` base64 by decoded length (24–64 bytes), current target authority and the HTTPS URL before I/O. Reuse hardened egress only after AW-01 confirms its real API: public address classification at connection time, pinned destination with TLS hostname checks, no redirects, no forwarded COLP credentials, bounded body/time. A DNS check performed only at subscribe time is insufficient.

Sign the verification body and verify the returned challenge under W01. Use short-lived single-use challenges and a bounded successful-verification cache keyed by principal, URL and secret generation. Encrypt secrets at rest and never expose them in Product DTOs. Use Standard Webhooks headers plus `X-MCP-Subscription-Id`; the signature covers the exact body. `webhook-id` equals the occurrence event ID. Serialize once and reuse the same body and event ID across retries, but generate a fresh signing timestamp and signature for every attempt. Secret rotation uses a short explicitly bounded dual-signing window, then deletes the old secret.

## 7. Delivery is not execution

A ready transition persists an occurrence with minimal references: run, job, rule/revision, target, member count and job access handle. One HTTP POST carries one occurrence; a host may group several occurrences into one task run. Iterate all referenced jobs and tolerate duplicate/out-of-order events. The broader academic fixture can create three worker jobs; use academic-summary-only for the deliberately one-job release fixture.

Keep the body near 4 KiB and below the documented 256 KiB maximum. A 2xx acknowledges receipt, not claim, model success or committed effect. `410` and `413` are terminal for automatic retry: in this design, 410 deactivates that subscription path; 413 dead-letters only the oversized occurrence and raises a diagnostic, not every healthy job/target. Other failures use bounded jittered retry and applicable Retry-After caps. Persist delivery leases/generations, send outside database locks, and recheck pause, expiry, authorization and generation before recording the result.

## 8. Lost wake-up and recovery

Non-replayable occurrences missed during an interruption are not recoverable through an event cursor. Ready jobs remain in COLP. The worker lists the authorized queue on initial setup and every reconnect, then claims any remaining jobs. The server may issue a new bounded readiness reminder for still-ready work after a new subscription; that is a new occurrence about current state, never a replay of old history. Do not run a hidden protocol poll loop for an Events target or silently switch its configured mode. A polling worker uses its own explicit schedule.

Read inputs through `automation.jobs.inputs` or its HTTP counterpart. This enforces the declared field allowlist and current source authority; do not instruct a minimally scoped worker to call broad `nodes.get`. A worker separately granted general node read/write permissions is outside the job-only fence and that fact must be disclosed. Page/source contents and metadata are untrusted input, never new instructions or authority.

## 9. Release evidence

AW-02 is an independent backend fixture spike, not a production pairing flow that depends on M2 UI. AW-46 verifies the real hosted lifecycle: discovery, list, challenge, create/refresh/expiry/restart/unsubscribe, schema rescan, identity isolation limits, bad secret, DNS/redirect blocks, duplicate/out-of-order delivery, fresh retry signatures, burst grouping, reconnection and accepted effects. Preserve redacted build/version/date evidence. Missing account access or an unproven platform behavior remains an explicit feature gate. M1 does not depend on that hosted gate.

---

<!-- Source chapter: 06-implementation-handbook.md -->

# Implementation Handbook and Task Breakdown

**Status:** proposed engineering plan. **Version:** 0.2.1-design. The packet sections below are generated from [tasks.json](tasks.json) by `validation/build-docs.py`; edit the JSON, not the generated text. Existing integration paths are evidence-backed where cited (R-ids in [the evidence register](08-evidence-and-decisions.md)); new paths are proposals. The plan is not a promise of background implementation; no repository was modified by creating this pack.

## 1. Milestones

Each milestone is a usable product on its own. A milestone is done when its stories' acceptance tests pass with evidence, not when its packets are merged.

| Milestone | The Owner can… | Exit gate | Stories |
|---|---|---|---|
| M0 Gates and spikes | — | Verified facts recorded (AW-01), browser profile decided (AW-03), Events fixture decisions recorded (AW-02); real hosted proof is required before Events compatibility claims, not before local M1 | — |
| M1 Rules without models | Create and preview a rule from a folder; save by rule from every entry point; see why a bookmark is where it is; pause everything; keep rules in backup and export | AC-01, 02, 04, 07–15, 26, 40–44, 49, 52 pass in a real browser under xvfb against a real database | AU-01–AU-14, AU-33 |
| M2 An agent finishes the job | Turn an agent into a worker woken by events or polling; get summaries and tags through approvals or trusted commit; see waiting work and cost | AC-03, 05, 06, 16–19, 23–25, 31, 34–39, 45–47, 51, 53 pass; the worked narrative is captured with a real hosted bot and a polling agent | AU-15–AU-23, AU-26 |
| M3 Batches and run-once | One digest per ten papers; organize existing folders once | AC-20, 21, 32, 33, 48, 50 pass | AU-24, AU-25, AU-27 |
| M4 Share the logic | Install and upgrade templates; entity maps and vocabularies; broadcast | AC-22, 27, 28, 30 pass | AU-28–AU-31 |
| Later | Weekly schedules, event-time replay, additional executors | Each capability independently verified before it is advertised | AU-32 |

M1 can ship independently through AW-63 without an agent surface. Hosted Events needs its own actual compatibility gate; local polling needs a reachable authenticated worker and does not supply hosted availability or permissions by itself. The full planned acceptance set is in acceptance-tests.json; abbreviated historical ranges in this table are not the complete gate.

## 2. How to work a packet

1. Set the packet's row in the status board (`docs/automation/status.md`, new "Automation" section) to `doing` with your name.
2. Read the **Read first** files before touching anything. They are the existing code the packet integrates with; if a path has moved, record the new path in AW-01's evidence and continue.
3. Do the **Steps** in order. A step that says *verify* means: read the source, and if the plan's assumption is wrong, write what you found in the status board's verify table and adjust the step, do not skip it.
4. Run the **Done when** block exactly; save its output under `docs/automation/evidence/<AW-id>/` and link it from the status board.
5. Land on the repository's integration branch as the product plan prescribes (D25); use the checked repository integration policy and milestone gate. Commit messages carry the packet ID.
6. Set the row to `done`. If a later packet depends on something you changed, note it.

Size S/M/L denotes relative complexity, not a delivery-time estimate. Set COLP_REPO and EXTENSION_REPO explicitly; Known-Extension paths are relative to the Know-N checkout. Product-plan paths are optional evidence inputs, not mandatory hidden workstation directories. Confirm the checkout’s test runner/headless requirements before execution. Stop any test servers started by the packet.

## 3. Repository ownership and lanes

| Layer | Home | Boundary |
|---|---|---|
| Shared rule definitions, schema, normalization, finite evaluator, task contracts | `packages/node/src/automation/` (`@know-n/colp/automation` subpath, ADR-A23) | No Node, Chrome, database or MCP imports; optional and outside conformance; released before the extension consumes it (G10) |
| Automation use cases | `packages/server/src/modules/automation/` | Host-neutral ports and business decisions |
| PostgreSQL, Outbox route, delivery, retention | `packages/server/src/infrastructure/automation/`, `infrastructure/outbox/automation-ingest.ts` | Concrete I/O |
| Product, device and work HTTP | `packages/server/src/transport/product/automation-*-routes.ts`, `transport/automation-device-routes.ts`, `transport/automation-work-routes.ts` | Existing auth, command and error conventions |
| OpenAPI source | `packages/server/openapi/fragments/automations.yaml` | Bundled into `colp-server-v1.yaml`; generated clients never hand-edited |
| MCP catalog, tools, Events methods | `packages/server/src/modules/mcp/automation-*.ts`, `events-adapter.ts`; `packages/node/src/mcp/2026-07-28/events*.ts` | Shared services, per-connection visibility, SDK boundary |
| Web | `packages/web/src/pages/Automations.tsx`, `pages/automations/*`, `api/automationClient.ts`; modifications to `Agents.tsx`, `ResourceDetail.tsx`, `WriteApprovals.tsx`, `App.tsx` | Know-N palette, toasts, existing components |
| Extension | `Known-Extension/src/automation/*`; modifications to `sw/capture.ts`, `capture/contracts.ts`, `classification-intent.ts`, `popup-classification.ts`, `bookmark-event-ingress.ts`, `service-worker.ts` | Browser APIs and IndexedDB only in host adapters |

Work is separated by lane in every packet and [delivery lanes](12-delivery-lanes.md). Backend code never depends on Web or extension implementation. Shared-core code has no host imports. Web/extension can start DTO/mock work after AW-01 freezes the relevant slice; `dependencies` are completion/integration prerequisites, not permission to invent missing API fields. `startAfter` permits preparation only: runtime integration still waits for its producer. Shared files within one lane have ordered ownership; contract changes are handled by AW-01 plus the backend contract owner, not independent frontend edits.

Do not merge a behavior producer before its schema consumer and migrations. Keep each PR to one invariant or one adapter. A feature flag can hide an incomplete composition; readiness must never report a transient handler as durable.

## 4. Task index

| ID | Milestone | Size | Task | Depends on | Stories |
|---|---|---|---|---|---|
| AW-01 | M0 | S | Freeze baselines and record verified integration facts | — | AU-01, AU-33 |
| AW-02 | M0 | M | Backend spike: prove the selected OpenAI Events profile independently of product UI | AW-01 | AU-15, AU-21, AU-26 |
| AW-03 | M0 | S | Shared-core contract: freeze the browser-bounded rule profile | AW-01 | AU-06, AU-10 |
| AW-04 | M1 | M | Add the shared automation core to @know-n/colp as the `automation` subpath | AW-01, AW-03 | AU-01, AU-06 |
| AW-05 | M1 | S | Implement fact normalization and digests | AW-04 | AU-06, AU-10, AU-24 |
| AW-06 | M1 | M | Implement the finite predicate compiler and bounded evaluator | AW-04, AW-05 | AU-01, AU-05, AU-06 |
| AW-07 | M1 | M | Implement effect arbitration and task graph validation | AW-06 | AU-05, AU-07, AU-12, AU-16, AU-17 |
| AW-08 | M1 | M | Implement folder role bindings and the dependency index | AW-04, AW-05, AW-09 | AU-03, AU-04 |
| AW-09 | M1 | M | Create persistence migrations and include automation in backup, restore and export | AW-01, AW-04 | AU-03, AU-33 |
| AW-10 | M1 | L | Implement rule configuration, validation, preview, lifecycle and pause APIs | AW-07, AW-08, AW-09 | AU-01, AU-02, AU-14 |
| AW-11 | M1 | M | Implement dependency health monitoring and incidents | AW-08, AW-09, AW-10 | AU-03, AU-04, AU-22 |
| AW-12 | M1 | L | Build the web Automations page, rule editor, preview, needs-attention list and bookmark Automation section | AW-10, AW-11, AW-51 | AU-01, AU-02, AU-03, AU-04, AU-05, AU-13, AU-14, AU-25 |
| AW-13 | M1 | M | Capture event-time facts at canonical commits | AW-05, AW-09 | AU-06, AU-09 |
| AW-14 | M1 | M | Add the ordered durable automation Outbox route and source positions | AW-13 | AU-09, AU-11 |
| AW-15 | M1 | M | Implement each trigger state, pause and epoch handling (count batches in M3) | AW-07, AW-09, AW-14 | AU-14, AU-24, AU-27 |
| AW-16 | M1 | L | Implement runs, jobs, effect history and run kinds | AW-07, AW-09, AW-15 | AU-09, AU-11, AU-13, AU-16, AU-24, AU-25 |
| AW-17 | M1 | M | Backend: verify canonical device receipts and join Sync operations | AW-13, AW-16 | AU-06, AU-08, AU-10 |
| AW-18 | M1 | M | Backend: compile and serve authenticated rule bundles | AW-03, AW-08, AW-10 | AU-06, AU-10, AU-14 |
| AW-19 | M1 | L | Integrate the extension pre-save rule path | AW-07, AW-49 | AU-06, AU-07, AU-12 |
| AW-20 | M1 | M | Integrate observed-create (star button) and echo suppression | AW-19, AW-50 | AU-07, AU-08, AU-11 |
| AW-21 | M1 | M | Make the local rule and receipt lifecycle durable | AW-20, AW-49, AW-50 | AU-10 |
| AW-33 | M1 | M | Server-side intake placement for web, phone and agent-created bookmarks | AW-07, AW-10, AW-14, AW-16, AW-17, AW-51 | AU-09, AU-11 |
| AW-49 | M1 | M | Extension: install the bounded bundle and canonical/native binding projection | AW-03, AW-04, AW-18 | AU-01, AU-06, AU-10, AU-14 |
| AW-50 | M1 | M | Extension: persist and sync canonical-only placement receipts | AW-17, AW-49 | AU-08, AU-10, AU-11 |
| AW-51 | M1 | M | Backend: M1 placement receipts, explanation and conservative single-effect Undo | AW-10, AW-16, AW-17 | AU-13 |
| AW-63 | M1 | M | Integration: independent M1 release gate, no M2 services | AW-12, AW-19, AW-20, AW-21, AW-33, AW-51, AW-66 | AU-01, AU-06, AU-07, AU-08, AU-09, AU-10, AU-11, AU-13, AU-14, AU-33 |
| AW-66 | M1 | M | Backend M1 gate: configuration, canonical intake and restart proof without UI | AW-11, AW-17, AW-18, AW-33, AW-51 | AU-01, AU-09, AU-13, AU-14, AU-33 |
| AW-22 | M2 | M | Implement execution policy, budgets and output reuse | AW-10, AW-16 | AU-12, AU-15, AU-17, AU-20, AU-23 |
| AW-23 | M2 | M | Implement job claims, heartbeat and uncertainty | AW-16, AW-22 | AU-15, AU-18, AU-20 |
| AW-24 | M2 | L | Implement typed results and the effect gateway through change plans | AW-07, AW-23 | AU-15, AU-16, AU-17, AU-18, AU-19 |
| AW-25 | M2 | M | Backend: adapt agent approvals and plan-scoped Undo | AW-24, AW-51 | AU-13, AU-18, AU-19, AU-27 |
| AW-26 | M2 | M | Backend: targets, composable profiles, pairing and wake readiness | AW-09, AW-10 | AU-15, AU-21, AU-26 |
| AW-27 | M2 | M | Implement Events discovery and method adapters | AW-02, AW-26 | AU-15, AU-26 |
| AW-28 | M2 | M | Implement verified callback and signing | AW-26, AW-27 | AU-26 |
| AW-29 | M2 | M | Implement target routing and the delivery worker | AW-15, AW-23, AW-28 | AU-15, AU-24, AU-26, AU-30 |
| AW-30 | M2 | M | Implement conditional MCP tool catalogs | AW-10, AW-26 | AU-21 |
| AW-31 | M2 | M | Mount worker and manager MCP tools and the HTTP work API | AW-23, AW-24, AW-30 | AU-15, AU-21 |
| AW-32 | M2 | M | Worker reference: setup instructions and a runnable polling adapter | AW-31 | AU-15, AU-26 |
| AW-34 | M2 | M | Web: run history, waiting work, budgets and result states | AW-11, AW-22, AW-25, AW-55 | AU-13, AU-22, AU-23, AU-24, AU-27 |
| AW-35 | M2 | L | Integration: assemble the M2 release proof from lane-owned evidence | AW-25, AW-29, AW-32, AW-33, AW-34, AW-44, AW-46, AW-52, AW-53, AW-56, AW-64 | AU-06, AU-15, AU-18, AU-19, AU-21, AU-26 |
| AW-44 | M2 | M | Retention, restore safety and load evidence | AW-09, AW-16, AW-24, AW-29 | AU-10, AU-24, AU-27, AU-33 |
| AW-46 | M2 | M | Events conformance and lifecycle fixtures | AW-27, AW-28, AW-29, AW-31, AW-64 | AU-26 |
| AW-52 | M2 | M | Web: connect automation plan approvals and effect-specific Undo | AW-12, AW-25 | AU-13, AU-19 |
| AW-53 | M2 | M | Web: Agents automation toggles, pairing and connection guide | AW-26, AW-30, AW-32 | AU-21, AU-26 |
| AW-54 | M2 | M | Extension: show server run status without reimplementing workflow logic | AW-21, AW-31 | AU-22, AU-23 |
| AW-55 | M2 | M | Backend: telemetry and read-model fields for waiting work and budgets | AW-22, AW-23 | AU-22, AU-23 |
| AW-56 | M2 | M | Extension E2E: local intake, sync projection and no feedback loop | AW-19, AW-20, AW-21, AW-54 | AU-06, AU-07, AU-08, AU-10, AU-11, AU-19 |
| AW-64 | M2 | L | Backend E2E: polling and plan recovery, independent of Events and UI | AW-17, AW-23, AW-24, AW-25, AW-31, AW-33 | AU-09, AU-15, AU-18, AU-19, AU-21 |
| AW-41 | M3 | M | Backend: immutable run-once preview and start | AW-10, AW-16, AW-24, AW-51 | AU-04, AU-14, AU-25 |
| AW-45 | M3 | S | Web: Digests list and paginated run-level text output | AW-34, AW-58 | AU-24 |
| AW-57 | M3 | L | Backend: exact count-batch aggregation and durable remainder | AW-15, AW-16, AW-24, AW-29 | AU-24, AU-27 |
| AW-58 | M3 | M | Backend: store/read run-level outputs and durable unread state | AW-24, AW-57 | AU-24 |
| AW-59 | M3 | M | Web: run-once preview and explicit start | AW-12, AW-41 | AU-25 |
| AW-60 | M3 | M | Extension: digest unread indicator and navigation | AW-54, AW-58 | AU-24 |
| AW-36 | M4 | M | Backend: portable template import/export and draft installation | AW-10, AW-61 | AU-28, AU-29 |
| AW-37 | M4 | M | Role-binding install wizard | AW-36 | AU-28, AU-31 |
| AW-38 | M4 | M | Backend: immutable template upgrade, preview and rollback commands | AW-25, AW-36, AW-61 | AU-29 |
| AW-39 | M4 | M | Backend: metadata predecessor, entity-map and vocabulary adapters | AW-22, AW-24, AW-61 | AU-17, AU-31 |
| AW-42 | M4 | M | Broadcast and per-target routing | AW-29, AW-31 | AU-30 |
| AW-43 | M4 | M | Server CEL condition profile | AW-06, AW-36 | — |
| AW-61 | M4 | L | Shared-core: portable templates, semantic diffs and stable entity maps | AW-04, AW-05, AW-07 | AU-28, AU-29, AU-31 |
| AW-65 | M4 | M | Web: semantic template upgrade and rollback review | AW-37, AW-38 | AU-29 |
| AW-40 | Later | M | Durable scheduled batches | AW-57 | AU-32 |
| AW-47 | Later | M | Event-time historical replay | AW-15, AW-25, AW-44 | AU-27 |
| AW-48 | Later | L | Later backend: server-owned model executor adapter | AW-22, AW-24 | AU-20 |
| AW-62 | Later | M | Later extension: explicit-consent background model executor | AW-21, AW-22, AW-24 | AU-12, AU-20 |

## 5. Work packets

### M0 — Gates and spikes

#### AW-01 — Freeze baselines and record verified integration facts — S

**Milestone:** M0. **Lane:** contracts. **Depends on:** —. **Stories:** AU-01, AU-33.

**Handoff:** docs/automation/evidence/aw-01.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `packages/server/src/transport/session-cookie.ts`
- `packages/server/src/transport/auth/origin-csrf.ts`
- `packages/server/src/transport/product-route-manifest.ts`
- `packages/server/openapi/README.md`
- `packages/server/migrations/README.md`
- `packages/server/src/bootstrap/config.ts`
- `packages/web/src/App.tsx`
- `Known-Extension/src/server-edition.ts`

**Files (new or modified):**
- `docs/automation/README.md`

**Steps:**
1. Record the actual checkout commits without automatically rebasing or modifying user work; compare against COLP `2ee8397` and Known-Extension `28acb4965`; record any change to the files in Read first in the evidence register.
2. Verify and write down: session cookie names, `x-csrf-token` plus Origin allowlist on cookie writes, `Known-Command-Id`, the closed error registry in `transport/product-codes.ts`, `KNOWN_FEATURE_*` flag naming, the current migration head name, the OpenAPI fragments pipeline, the web router and page layout, the manifest extension `https://know-n.com/colp/extensions/server` the extension reads.
3. Decide the migration prefix rule: automation migrations use a monotonic sortable prefix greater than the actual migration head (not blindly the calendar date); add a CI check that refuses a new file whose name sorts before the newest applied migration (AC-40).
4. Copy this pack into `docs/automation/` as the living design; link it from the root README.
5. For the backend-only path, COLP_REPO is sufficient. Record extension/product-plan references as deferred when those checkouts are absent. Their absence cannot block a verified backend contract; never label those facts rechecked.

**Done when:**
- Backend integration facts needed by the selected task slice are confirmed/corrected with checkout hashes. Other inherited facts are explicitly deferred, never guessed or labelled verified.
- `npm --prefix packages/server run openapi:ci` and `npm --prefix packages/server run runtime:manifest:check` pass on the rebased baseline before any new route exists.

#### AW-02 — Backend spike: prove the selected OpenAI Events profile independently of product UI — M

**Milestone:** M0. **Lane:** backend. **Depends on:** AW-01. **Stories:** AU-15, AU-21, AU-26.

**Handoff:** docs/automation/evidence/aw-02.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/node/src/shared/mcp-sdk-boundary.ts`
- `packages/node/src/mcp/2026-07-28/request-context.ts`
- `05-mcp-events.md §2`

**Files (new or modified):**
- `packages/node/tests/mcp/automation-events-contract.test.ts`
- `docs/automation/evidence/events-spike.md`

**Steps:**
1. Use a disposable authenticated fixture MCP server with a synthetic target and pre-paired test principal. Reuse the pinned 2026-07-28 envelope boundary; do not depend on unimplemented production target APIs or Web screens.
2. Validate discovery/list/subscribe/unsubscribe, callback challenge, 24–64 decoded-byte secret handling and signed delivery against W01. Keep OpenAI callback error -32015 separate from provisional experimental codes.
3. Run a real Work/dot lifecycle only with an eligible test account and explicit test connection. Record provider surface, date, versions, identity behavior and actual effect evidence. If access or callback compatibility is unavailable, mark the hosted integration blocked, never passed.
4. Publish a redacted fixture transcript and adapter decisions consumed by AW-27. Never claim that docs support proves COLP interoperability or that a dot supplies an independently isolatable credential.

**Done when:**
- Protocol fixture is executable without any M1/M2 production tasks or frontend.
- Actual host proof is either linked with redacted evidence or explicitly blocked; there is no simulated-as-real result.

#### AW-03 — Shared-core contract: freeze the browser-bounded rule profile — S

**Milestone:** M0. **Lane:** shared-core. **Depends on:** AW-01. **Stories:** AU-06, AU-10.

**Handoff:** docs/automation/evidence/aw-03.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `Known-Extension/src/generated/classification/index.ts`
- `02-rule-contract.md §3.1`
- `W03 in 08-evidence-and-decisions.md`

**Files (new or modified):**
- `packages/node/docs/AUTOMATION_BROWSER_PROFILE.md`

**Steps:**
1. Freeze the data-only finite DSL, normalized inputs, limits and unsupported-profile errors. Include startsWith semantics and a maximum of eight tasks.
2. Document extension security/store-review constraints as gates, not preapproved distribution. No browser runtime imports or Chrome API code enter the shared core.
3. Hand the profile specification and positive/negative fixtures to AW-49; implementation of storage and runtime-profile.ts belongs there.

**Done when:**
- One profile specification is versioned and consumed by both hosts.
- No extension implementation file is owned by this task.

### M1 — Rules without models

#### AW-04 — Add the shared automation core to @know-n/colp as the `automation` subpath — M

**Milestone:** M1. **Lane:** shared-core. **Depends on:** AW-01, AW-03. **Stories:** AU-01, AU-06.

**Handoff:** docs/automation/evidence/aw-04.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `packages/node/package.json (exports map)`
- `packages/node/docs/API.md`
- `packages/node/scripts (check:source-size, check:traceability, check:protocol)`
- `schemas/rule-definition.schema.json`

**Files (new or modified):**
- `packages/node/package.json`
- `packages/node/src/automation/index.ts`
- `packages/node/src/automation/schema.ts`
- `packages/node/src/automation/types.ts`
- `packages/node/docs/API.md`

**Steps:**
1. Add the `automation` subpath export to `@know-n/colp` (owner decision 2026-10-12: no new package). The module imports nothing from Node, Chrome, databases or MCP transports; browser and Node test bundles import the same entry.
2. Mark the subpath as an optional, non-conformance module in the package docs so `check:traceability` and `check:protocol` do not require MUST mappings for it; raise the `check:source-size` budget deliberately and record the new number.
3. Generate closed JSON Schemas and TypeScript types from one source; publish schema version, profile IDs and output-contract identifiers.
4. Build and npm-pack the automation subpath for local backend tests, or use the existing workspace dependency mechanism. Record the export/type/runtime fixture results. Public npm publication is a distribution gate before AW-49 consumes a release, not a prerequisite for local backend completion. Extension installation/lockfile edits remain AW-49.

**Done when:**
- Unknown keys and unsupported runtime branches are rejected by the generated validator.
- `npm --prefix packages/node run check && npm --prefix packages/node run test` pass with the subpath present; the extension builds against the published version.

#### AW-05 — Implement fact normalization and digests — S

**Milestone:** M1. **Lane:** shared-core. **Depends on:** AW-04. **Stories:** AU-06, AU-10, AU-24.

**Handoff:** docs/automation/evidence/aw-05.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `Known-Extension/src/bookmark-event-codec.ts`
- `packages/server/src/infrastructure/outbox/collection-mutation-events.ts`

**Files (new or modified):**
- `packages/node/src/automation/normalize.ts`
- `packages/node/src/automation/fingerprint.ts`
- `packages/node/tests/automation/normalization.test.ts`

**Steps:**
1. Normalize host case, IDNA, terminal dot and path deterministically; reject malformed URLs and unsupported schemes as `missingInput`.
2. Define canonical configuration and input digests with version identifiers; unrelated field changes do not change task-specific digests.
3. Golden fixtures shared by browser and server.

**Done when:**
- Host-spoof, terminal-dot, case, IDNA and malformed-URL fixtures agree across hosts.
- Changing the note does not invalidate the placement digest; changing the URL does.

#### AW-06 — Implement the finite predicate compiler and bounded evaluator — M

**Milestone:** M1. **Lane:** shared-core. **Depends on:** AW-04, AW-05. **Stories:** AU-01, AU-05, AU-06.

**Handoff:** docs/automation/evidence/aw-06.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `02-rule-contract.md §3.1`
- `examples/academic-intake.json`

**Files (new or modified):**
- `packages/node/src/automation/predicate.ts`
- `packages/node/src/automation/compile.ts`
- `packages/node/tests/automation/predicate.test.ts`

**Steps:**
1. Validate field/operator typing, depth ≤ 16 and ≤ 128 nodes; compile to a pure evaluator returning matched/notMatched/missingInput/error.
2. Extract field dependencies for the health index.
3. No CEL in this task; the CEL branch validates as `unsupported on this server` (AW-43).
4. Implement literal normalized-path startsWith; /docs/ matches /docs/a but not /other/docs/a. Never use contains as a prefix approximation.

**Done when:**
- Identical decisions for the same normalized facts in browser and server test bundles.
- A 50 ms CPU budget failure isolates one rule; no I/O happens during evaluation.

#### AW-07 — Implement effect arbitration and task graph validation — M

**Milestone:** M1. **Lane:** shared-core. **Depends on:** AW-06. **Stories:** AU-05, AU-07, AU-12, AU-16, AU-17.

**Handoff:** docs/automation/evidence/aw-07.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `01-architecture.md §10`
- `02-rule-contract.md §7`

**Files (new or modified):**
- `packages/node/src/automation/arbitrate.ts`
- `packages/node/src/automation/task-contracts.ts`
- `packages/node/src/automation/validate-graph.ts`

**Steps:**
1. Validate unique task IDs, acyclic `after`, ≤ 8 tasks, known output contracts, role-kind compatibility.
2. Arbitrate placement by priority; equal-priority incompatible destinations yield `conflict`; manual choice and privacy beat priority; compatible tag additions merge.
3. Represent `classify.root` satisfaction separately from tags and summary; `keepParent` and `review` are first-class placement decisions.

**Done when:**
- Fixture: two equal-priority rules → conflict with both rules named.
- Fixture: a satisfied root suppresses only the folder request flag; tags remain requestable.

#### AW-08 — Implement folder role bindings and the dependency index — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-04, AW-05, AW-09. **Stories:** AU-03, AU-04.

**Handoff:** docs/automation/evidence/aw-08.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/modules/collections/application/canonical-mutation.ts`
- `packages/server/src/modules/collections/application/move-collection-node.ts`

**Files (new or modified):**
- `packages/server/src/modules/automation/domain/bindings.ts`
- `packages/server/src/modules/automation/application/resolve-bindings.ts`
- `packages/server/src/modules/automation/application/dependency-index.ts`

**Steps:**
1. Bind `serverUuid/collectionId/nodeId`; look labels up for display only.
2. Index direct and ancestor dependencies; separate label refresh from semantic revision.
3. Validate current subtree membership, write authority and sync range at every effect.

**Done when:**
- Rename preserves identity and counters; a same-name folder never rebinds (AC-13, AC-15).
- Moving an ancestor locates every dependent stage in one query (AC-14).

#### AW-09 — Create persistence migrations and include automation in backup, restore and export — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-01, AW-04. **Stories:** AU-03, AU-33.

**Handoff:** docs/automation/evidence/aw-09.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/migrations/README.md`
- `packages/server/src/infrastructure/database/migrations.ts`
- `deploy/backup.sh`
- `deploy/restore.sh`
- `packages/server/src/modules/collections/application/export (collections.export use case)`

**Files (new or modified):**
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_configuration.ts`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_runtime.ts`
- `packages/server/src/infrastructure/automation/database-types.ts`
- `deploy/backup.sh`
- `deploy/restore.sh`

**Steps:**
1. Create the M1 tables from 09-data-model.md §1 in expand-contract order; the prefix must sort after the current head (`202610290100` at design time).
2. Reuse existing command receipts and the master-key encryption path for later secrets.
3. Confirm `backup.sh` dumps the new tables (it dumps the whole database; verify) and `restore.sh` starts the server with the global pause set.
4. Add `automations.json` (rules and bindings by folder path, no secrets) to `colp-server export` only; the Web Export menu belongs to AW-12.
5. Select a valid monotonic migration prefix greater than the actual repository head, even when its timestamp-like name is ahead of the calendar. Verify upgrade from the pinned head and record names; do not force a merge-day timestamp lower than that head.

**Done when:**
- Fresh install and upgrade from the current head both migrate; unique constraints reject duplicate admissions and effects.
- AC-52 passes: backup → restore → paused server → export contains `automations.json`.

#### AW-10 — Implement rule configuration, validation, preview, lifecycle and pause APIs — L

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-07, AW-08, AW-09. **Stories:** AU-01, AU-02, AU-14.

**Handoff:** docs/automation/evidence/aw-10.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/transport/product/bookmark-preferences-routes.ts`
- `packages/server/src/transport/product-codes.ts`
- `packages/server/src/modules/commands/application/receipt.ts`
- `04-api-guide.md`

**Files (new or modified):**
- `packages/server/openapi/fragments/automations.yaml`
- `packages/server/src/modules/automation/application/rule-service.ts`
- `packages/server/src/modules/automation/application/preview-service.ts`
- `packages/server/src/transport/product/automation-rule-routes.ts`
- `packages/server/src/transport/product/automation-binding-routes.ts`

**Steps:**
1. Rule and BindingSet CRUD with immutable revisions, `Known-Command-Id` idempotency and `If-Match`; creation is always a draft.
2. Preview supplied facts or up to 200 authorized current bookmarks in scope using mode=currentState (no historical facts worker required), with `sideEffects:false` and an expiring preview record bound to the exact configuration.
3. Lifecycle with activation fence; refuse enable without an unexpired exact preview.
4. Server-wide pause switch stored once and projected to bundles and worker reads.
5. Register routes through the manifest and gate lists; add `automation_*` codes to the closed registry; regenerate the server OpenAPI bundle and publish contract fixtures; Web client generation belongs to AW-12.
6. M1 accepts a root-only rule with tasks=[] and no executionPolicyId. Worker tasks require policy/target only when M2 is available. Private export uses PortableRuleDefinition and creates draft on re-import.
7. retainedHistory is a separately capability-gated preview mode requiring persisted facts. Do not silently substitute current state for historical facts. Until the M1 execution composition is installed, keep runtime readiness unavailable and actual bookmark mutation disabled; draft/preview/lifecycle contracts remain testable.

**Done when:**
- AC-26: edited configuration cannot activate with an old preview; API enable without preview is refused.
- `npm --prefix packages/server run openapi:ci && npm --prefix packages/server run runtime:manifest:check && npm --prefix packages/server run test:unit` pass.

#### AW-11 — Implement dependency health monitoring and incidents — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-08, AW-09, AW-10. **Stories:** AU-03, AU-04, AU-22.

**Handoff:** docs/automation/evidence/aw-11.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/infrastructure/outbox/collection-mutation-events.ts`
- `packages/server/src/infrastructure/health.ts`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/health-service.ts`
- `packages/server/src/infrastructure/automation/health-worker.ts`

**Steps:**
1. Revalidate on folder events, startup and before every effect; record stage-level incidents deduplicated by dependency revision and category.
2. Keep desired state independent from observed health; acknowledgment hides, never repairs.
3. Expose low-cardinality reason codes to `/ready` and metrics.

**Done when:**
- Rename → info incident, rule stays active; delete → blocked stage with Restore/Choose another actions (AC-13, AC-15).
- A zero-match rule with eligible activity is not reported as broken (AC-31).

#### AW-12 — Build the web Automations page, rule editor, preview, needs-attention list and bookmark Automation section — L

**Milestone:** M1. **Lane:** web. **Depends on:** AW-10, AW-11, AW-51. **Stories:** AU-01, AU-02, AU-03, AU-04, AU-05, AU-13, AU-14, AU-25.

**Handoff:** docs/automation/evidence/aw-12.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `packages/web/src/App.tsx`
- `packages/web/src/pages/Agents.tsx`
- `packages/web/src/pages/ResourceDetail.tsx`
- `packages/web/src/pages/WriteApprovals.tsx`
- `packages/web/src/api/productClient.ts`
- `packages/web/src/components/AppToast.tsx`
- `memory: Know-N palette and toasts-not-bands rules`

**Files (new or modified):**
- `packages/web/src/pages/Automations.tsx`
- `packages/web/src/pages/automations/RuleEditor.tsx`
- `packages/web/src/pages/automations/PreviewPanel.tsx`
- `packages/web/src/pages/automations/NeedsAttention.tsx`
- `packages/web/src/pages/automations/RuleSentence.tsx`
- `packages/web/src/pages/ResourceDetail.tsx`
- `packages/web/src/api/automationClient.ts`
- `packages/web/src/App.tsx`
- `packages/web/src/components/Layout.tsx`

**Steps:**
1. Route `/automations` with navigation next to Agents; folder menu action 'Automate…' pre-fills the destination.
2. Three-step editor (when, where, then) with typed condition pickers; JSON behind Advanced; Preview before Enable; plain-language rule sentence in the list.
3. Needs attention at the top; Pause all in the header; per-rule pause.
4. Bookmark page Automation section renders effects and availability from AW-51 in M1 and AW-25 in M2. Add tag-feedback controls only when their backend capability is available; never infer Undo from a screen state.
5. Use existing components (`Modal`, `AppToast`, `DataTable`, `RolePick`); warnings are toasts; all strings through the i18n path if the web has one, otherwise plain English consistent with existing pages.
6. Own Web client regeneration and the existing Export-menu integration. Consume backend artifacts; no schema invention, authorization or workflow transitions in React.

**Done when:**
- AC-41 under two minutes without JSON; AC-08 shows both rules; AC-44 pause visible on all pages.
- `npm --prefix packages/web run typecheck && npm --prefix packages/web run lint && npm --prefix packages/web run lint:css && npm --prefix packages/web run test` pass; Playwright for the editor runs under xvfb only.

#### AW-13 — Capture event-time facts at canonical commits — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-05, AW-09. **Stories:** AU-06, AU-09.

**Handoff:** docs/automation/evidence/aw-13.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/modules/collections/application/canonical-mutation.ts (CANONICAL_MUTATION_WRITE_ORDER)`
- `packages/server/src/infrastructure/outbox/collection-mutation-events.ts`

**Files (new or modified):**
- `packages/server/src/modules/collections/application/canonical-mutation.ts`
- `packages/server/src/infrastructure/automation/fact-capture.ts`

**Steps:**
1. Add a bounded facts-capture port and extend the frozen write order; facts are built from the plan and rows already in hand, never from re-reads.
2. Cover Web, MCP, Sync and explicit import origins from one authority; mark origin and causation.
3. Capture before/after URL, title, tags, parent and ancestors; never readable content or tokens in the general Outbox payload.
4. The verified baseline order ends operation -> audit -> outbox. Insert private facts after audit and before outbox in the SAME transaction and extend ports/order tests. Capture before-state from locked planning input before mutation; do not infer it afterwards.

**Done when:**
- A rolled-back transaction emits no facts and no admission.
- Rapid URL change then move is matched against event-time facts, not current rows.

#### AW-14 — Add the ordered durable automation Outbox route and source positions — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-13. **Stories:** AU-09, AU-11.

**Handoff:** docs/automation/evidence/aw-14.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/infrastructure/outbox/router.ts`
- `packages/server/src/infrastructure/outbox/worker.ts`
- `packages/server/src/infrastructure/outbox/sync-conflict.ts`

**Files (new or modified):**
- `packages/server/src/infrastructure/outbox/automation-ingest.ts`
- `packages/server/src/infrastructure/outbox/router.ts`
- `packages/server/src/infrastructure/automation/source-position-store.ts`

**Steps:**
1. Register a static `delivery_each_event` route with `sideEffectDurability: durable` and a new `routeClass: 'automation_ingest'`; extend the union and readiness overlay.
2. Advance the last-inspected ordinal per collection including irrelevant operations; bind completion to the lease generation.
3. Deduplicate higher-level and resource-level representations of one operation.

**Done when:**
- Concurrent and repeated deliveries never double-admit.
- No gap is inferred from non-matching ordinals or latest-only projections.

#### AW-15 — Implement each trigger state, pause and epoch handling (count batches in M3) — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-07, AW-09, AW-14. **Stories:** AU-14, AU-24, AU-27.

**Handoff:** docs/automation/evidence/aw-15.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `01-architecture.md §8.1, §9`
- `09-data-model.md §3`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/admit-event.ts`
- `packages/server/src/infrastructure/automation/aggregate-store.ts`

**Steps:**
1. Commit admission receipt, partition state and run creation atomically under the collection source-position lock.
2. Activation, pause/resume and semantic-revision epochs; the global pause short-circuits admission.
3. `countBatch` member accounting and the 9+2 algorithm land here but are enabled by capability flag in M3.
4. On pause persist skipped-admission fences; resume at a new current high-water activation fence, never replay the paused interval. M1 does not touch M2 policy/usage/subscription tables. Worker budget caps must not stop deterministic placement.

**Done when:**
- Restart and duplicate-source tests keep exact state; pause holds pending runs; resume uses a new fence (AC-32, AC-44).
- M3: AC-20 and AC-21 pass with exact members and remainder.

#### AW-16 — Implement runs, jobs, effect history and run kinds — L

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-07, AW-09, AW-15. **Stories:** AU-09, AU-11, AU-13, AU-16, AU-24, AU-25.

**Handoff:** docs/automation/evidence/aw-16.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/modules/mcp/change-plan-service.ts`
- `packages/server/src/modules/mcp/agent-plan-policy.ts`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/run-service.ts`
- `packages/server/src/modules/automation/application/job-planner.ts`
- `packages/server/src/infrastructure/automation/job-store.ts`
- `packages/server/src/transport/product/automation-run-routes.ts`

**Steps:**
1. Persist pinned rule, binding and policy revisions; run kinds `intake`, `batch`, `manual`.
2. Create jobs once per run, task and target partition; ready them by dependencies; preserve causal continuation without same-stage loops.
3. Per-bookmark effect history query for the Automation section (rule, agent, time, effect, plan id).
4. For M1 use null executionPolicyRevision and no target jobs; represent verified placement effects in the run. A worker DAG is instantiated only in M2. Do not publish job-ready events for unresolved predecessors.

**Done when:**
- Root completion releases only declared downstream jobs; resumed and manual runs are distinguishable from duplicates.
- The bookmark page lists effects newest first with plan identities (AC-43 read side).

#### AW-17 — Backend: verify canonical device receipts and join Sync operations — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-13, AW-16. **Stories:** AU-06, AU-08, AU-10.

**Handoff:** docs/automation/evidence/aw-17.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `Known-Extension/src/classification-create-receipt.ts`
- `Known-Extension/src/bookmark-create-receipt-identity.ts`
- `packages/server/src/transport/colp-sync`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/accept-intake-receipt.ts`
- `packages/server/src/transport/automation-device-routes.ts`

**Steps:**
1. Implement device-authenticated idempotent receipt ingest, with out-of-order arrival and replica generation fences.
2. Join operationId to the canonical create; for observed correction also join placementOperationId to the canonical move. Read committedNode and current authority; reject foreign/mismatched node identities.
3. Verify pinned rule/binding/bundle and placement before accepting advisory classify.root satisfaction. Never accept enrichment task satisfaction from a browser type list. Native observations stay local.
4. Persist waitingForSync/review/rejected/accepted receipts; late receipt or expired-bundle policy must not overwrite a subsequent manual move. Publish the HTTP fixture to AW-50.

**Done when:**
- Pre-save and create-then-move receipts converge once in either arrival order.
- No native browser IDs exist in HTTP, logs, events or exports.
- Client-asserted summary completion or mismatched placement cannot skip a job.

#### AW-18 — Backend: compile and serve authenticated rule bundles — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-03, AW-08, AW-10. **Stories:** AU-06, AU-10, AU-14.

**Handoff:** docs/automation/evidence/aw-18.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `Known-Extension/src/server-edition.ts`
- `Known-Extension/src/manifest-client.ts`
- `packages/server/src/transport/publication/manifest (edition mount extension)`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/compile-bundle.ts`
- `packages/server/src/transport/automation-device-routes.ts`

**Steps:**
1. Compile browser-bounded M1 rules and canonical bindings into one bounded full snapshot. Include paused and monotonically increasing settingsRevision in the signed/authenticated digest.
2. Serve atomic replacements with removedRuleIds, expiry and profile checks. Never emit a partial ruleset as if it were complete.
3. M1 rule compilation requires no target or execution policy. Publish active, paused, expired, oversized and unsupported fixtures to AW-49.

**Done when:**
- Response schema and digest include pause/settings fields.
- M1-only deployment serves bundles without reading M2 tables.

#### AW-19 — Integrate the extension pre-save rule path — L

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-07, AW-49. **Stories:** AU-06, AU-07, AU-12.

**Handoff:** docs/automation/evidence/aw-19.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `Known-Extension/src/save-entry.ts`
- `Known-Extension/src/sw/capture.ts`
- `Known-Extension/src/capture/contracts.ts`
- `Known-Extension/src/capture/automatic.ts`
- `Known-Extension/src/classification-intent.ts`
- `Known-Extension/src/popup-classification.ts`
- `Known-Extension/src/bookmark-create-placement.ts`

**Files (new or modified):**
- `Known-Extension/src/automation/pre-save.ts`
- `Known-Extension/src/sw/capture.ts`
- `Known-Extension/src/capture/contracts.ts`
- `Known-Extension/src/classification-intent.ts`
- `Known-Extension/src/popup-classification.ts`
- `Known-Extension/src/save-status.ts`

**Steps:**
1. Evaluate rules before `chrome.bookmarks.create` on every extension-owned save path; choose `parentNativeId` from the rule so there is no create-then-move.
2. Record the decision as a `CaptureTask` field (rule id, revisions, digest, satisfied task types); respect `manualFence` and the explicit folder pick.
3. When the rule placed the bookmark, request the local provider with `folder:false` (tags per tag mode) or not at all.
4. Result panel line: 'Saved to <folder> by rule <name>'; blocked reason when the binding is unusable.
5. Tags-only model requests remain foreground-user-authorized behavior. Native observed-create and background receipt replay never invoke the currently foreground-only local model provider.

**Done when:**
- AC-01 across popup, shortcut, context menu and Save tabs; AC-02 blocked binding keeps the save; AC-04 tags-only request.
- `cd ~/known/Know-N/Known-Extension && npm run typecheck && npm run test && npm run check:i18n` pass.

#### AW-20 — Integrate observed-create (star button) and echo suppression — M

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-19, AW-50. **Stories:** AU-07, AU-08, AU-11.

**Handoff:** docs/automation/evidence/aw-20.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `Known-Extension/src/bookmark-event-ingress.ts`
- `Known-Extension/src/bookmark-event-create-placement.ts`
- `Known-Extension/src/bookmark-event-eligibility.ts`
- `Known-Extension/src/bookmark-folder-policy.ts`

**Files (new or modified):**
- `Known-Extension/src/automation/observed-create.ts`
- `Known-Extension/src/automation/causation.ts`
- `Known-Extension/src/bookmark-event-ingress.ts`

**Steps:**
1. Classify an observed creation as new local intent, own echo, inbound projection, import or recovery.
2. Apply the settle window (3 s) and the bookmark-root rule (ADR-A17); perform one receipted move; show one toast.
3. Recognize server projections by sync operation identity; allow next-stage continuation; deny same-stage re-entry.
4. Browser root does not prove absence of explicit user choice. Treat it as a documented heuristic; use the settle/manual fence and recheck before any move. Unknown intent or a subsequent manual edit must win, with review rather than forced classification.

**Done when:**
- AC-09 and AC-49 pass in a real browser under xvfb.
- AC-12: two browsers projecting one server move produce no intake.

#### AW-21 — Make the local rule and receipt lifecycle durable — M

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-20, AW-49, AW-50. **Stories:** AU-10.

**Handoff:** docs/automation/evidence/aw-21.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `Known-Extension/src/sync-state-store.ts`
- `Known-Extension/src/service-worker.ts`
- `Known-Extension/src/sync-alarm.ts`

**Files (new or modified):**
- `Known-Extension/src/automation/recovery.ts`
- `Known-Extension/src/automation/indexeddb-store.ts`
- `Known-Extension/src/service-worker.ts`

**Steps:**
1. Persist pending receipts and bundle state in IndexedDB; recover create/receipt binding gaps from existing identity evidence.
2. Resume receipt and bundle synchronization with backoff and generation checks on the existing alarm.
3. Unknown identity or stale generation produces attention, never guessed reassociation.

**Done when:**
- AC-10 survives service-worker kill and browser restart.
- Local-first lifecycle suite `npm run test:local-first-lifecycle` still passes.

#### AW-33 — Server-side intake placement for web, phone and agent-created bookmarks — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-07, AW-10, AW-14, AW-16, AW-17, AW-51. **Stories:** AU-09, AU-11.

**Handoff:** docs/automation/evidence/aw-33.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/modules/collections/application/move-collection-node.ts`
- `packages/server/src/modules/mcp/node-create-execution.ts`
- `packages/server/src/transport/product/node-routes.ts`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/server-intake.ts`

**Steps:**
1. After the receipt grace period, evaluate intake rules for `node.created` with origin web, MCP or Sync and no receipt; parent must be a root or the collection root (explicit folder = Owner's choice).
2. Apply placement through the canonical move with automation causation and a collection version cause `automation:<ruleId>`.
3. Import origin is excluded; the import preview text points to run-once.

**Done when:**
- AC-42: web root create and MCP create are placed; direct-folder create is untouched; projections cause no intake.
- A late browser receipt for the same operation satisfies open tasks only.

#### AW-49 — Extension: install the bounded bundle and canonical/native binding projection — M

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-03, AW-04, AW-18. **Stories:** AU-01, AU-06, AU-10, AU-14.

**Handoff:** docs/automation/evidence/aw-49.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `Known-Extension/src/automation/runtime-profile.ts`
- `Known-Extension/src/automation/bundle-store.ts`
- `Known-Extension/src/automation/binding-projector.ts`
- `Known-Extension/package-lock.json`

**Steps:**
1. Pin the released @know-n/colp automation subpath in the extension; consume profile fixtures without copying the evaluator.
2. Verify and atomically install bundle revision/digest/profile/expiry, pause and settingsRevision. Reject older settingsSequence even when a stale bundle has not expired.
3. Resolve canonical folders to native IDs only in the extension. Unresolved/expired bindings fall back safely and never guess a path.
4. Expose offline last-refresh/expiry state. A disconnected client cannot know a new server pause until refresh; once a pause is learned, never revive an older active bundle.

**Done when:**
- No backend file is edited.
- Pause persistence, expired cache and missing native mappings have deterministic tests.

#### AW-50 — Extension: persist and sync canonical-only placement receipts — M

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-17, AW-49. **Stories:** AU-08, AU-10, AU-11.

**Handoff:** docs/automation/evidence/aw-50.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `Known-Extension/src/automation/receipt-sync.ts`

**Steps:**
1. Keep nativeObservation exclusively in local durable storage. Send canonical create ID, optional corrective move ID, committedNode and pinned revisions.
2. Persist before scheduling network retry; wait until both canonical IDs exist for observed-create correction. Retry safely across worker suspension and sign-out without cross-account mixing.
3. Reflect waitingForSync/review/rejected in local status; do not locally mark enrichment tasks succeeded.

**Done when:**
- Fixtures show no browser native ID in serialized receipts.
- Response handling survives receipt-before-sync and sync-before-receipt.

#### AW-51 — Backend: M1 placement receipts, explanation and conservative single-effect Undo — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-10, AW-16, AW-17. **Stories:** AU-13.

**Handoff:** docs/automation/evidence/aw-51.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/placement-history.ts`
- `packages/server/src/modules/automation/application/placement-undo.ts`

**Steps:**
1. Record a verified owner-authorized deterministic placement as an effect with canonical operation, original destination (when proven), revisions and digest. This is not an Agent policy decision.
2. Expose bounded effects on getAutomationRun. Mount undoAutomationRun in M1 with one effectReceiptId. Return undoAvailable=false and a reason when original destination or fences cannot be proved.
3. Execute a compensating canonical move under current Owner authority and conservative content/resource fences. Never undo the bookmark create itself or restore a collection snapshot over unrelated changes.
4. Provide the extension/web explanation contract. M2 later adds plan receipts through AW-25 without changing the M1 authorization model.

**Done when:**
- M1-only deployment offers safe Undo without creating a target/policy or invoking an agent.
- Newer changes produce a clear conflict, not a destructive restore.

#### AW-63 — Integration: independent M1 release gate, no M2 services — M

**Milestone:** M1. **Lane:** integration. **Depends on:** AW-12, AW-19, AW-20, AW-21, AW-33, AW-51, AW-66. **Stories:** AU-01, AU-06, AU-07, AU-08, AU-09, AU-10, AU-11, AU-13, AU-14, AU-33.

**Handoff:** docs/automation/evidence/aw-63.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `docs/automation/m1-release-evidence.md`

**Steps:**
1. Run the m1-placement fixture with no targets, execution policies, Events or model credentials. Exercise rule CRUD/preview/save, known-manual choices, native observation, offline expiry, sync receipt, pause and conservative Undo.
2. Record exact frontend/backend/extension builds. Fail release if M1 needs a fake agent policy, M2 table read or unimplemented Undo endpoint.

**Done when:**
- M1 is independently useful and its release evidence does not wait for hosted-dot availability.

#### AW-66 — Backend M1 gate: configuration, canonical intake and restart proof without UI — M

**Milestone:** M1. **Lane:** backend. **Depends on:** AW-11, AW-17, AW-18, AW-33, AW-51. **Stories:** AU-01, AU-09, AU-13, AU-14, AU-33.

**Handoff:** docs/automation/evidence/aw-66.md: actual commands, checkout, schema version and database fault results

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/server/tests/integration/automation/m1-backend.test.ts`

**Steps:**
1. Use the M1 fixture with tasks=[], no execution policy, no target and no model credentials. Exercise authorized API configuration/preview/enable, canonical intake, explanations and safe Undo.
2. Use a real test database and fault injection for duplicate/out-of-order receipts, restart after commit, pause/resume fences, stale preview, missing destinations, imports and known manual placement. Device fixtures must prove canonical identities; they are not actual Chrome evidence.
3. Run backup/restore and verify restored automation is paused. Publish backend-only evidence to AW-63; do not wait for or claim Web/extension E2E.

**Done when:**
- All selected backend assertions pass without importing Web or Chrome runtimes and without querying M2 execution-policy, target or Events tables.
- No duplicate canonical move or destructive Undo occurs in the recorded restart and concurrency cases.

### M2 — An agent finishes the job

#### AW-22 — Implement execution policy, budgets and output reuse — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-10, AW-16. **Stories:** AU-12, AU-15, AU-17, AU-20, AU-23.

**Handoff:** docs/automation/evidence/aw-22.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `examples/execution-policy.json`
- `04-api-guide.md §6`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/executor-policy.ts`
- `packages/server/src/modules/automation/application/result-reuse.ts`
- `packages/server/src/transport/product/automation-policy-routes.ts`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_policy_and_attempts.ts`

**Steps:**
1. Absent policy means no model calls and no fallback; a policy names one target or executor per task type.
2. Daily caps per rule (default 100 runs) and server-wide (configuration); reaching a cap holds tasks with a visible reason, never drops placement.
3. Count calls per rule and per target for 7 and 30 days; cost is 'billed by your agent' unless an executor reports it.
4. Reuse accepted results only under compatible digest, contract and authority.
5. Input minimization is enforced on job-scoped input APIs; an agent holding separately granted broad nodes read/write scopes is outside that job-only boundary and the UI must disclose it. Optional work caps never block deterministic root placement.
6. Own the additive migration for the later-milestone tables this task first requires; use chapter 09 and the actual migration head. Do not retroactively make M1 migrations reference an absent later table. Record ordering against concurrent migration PRs.

**Done when:**
- AC-23: no implicit fallback; AC-47: caps hold, counts show.
- Equivalent tasks reuse; incompatible contracts re-execute (AC-05).

#### AW-23 — Implement job claims, heartbeat and uncertainty — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-16, AW-22. **Stories:** AU-15, AU-18, AU-20.

**Handoff:** docs/automation/evidence/aw-23.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/infrastructure/outbox/worker.ts (lease fencing)`
- `09-data-model.md §4`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/claim-job.ts`
- `packages/server/src/infrastructure/automation/lease-store.ts`
- `packages/server/src/transport/automation-work-routes.ts`

**Steps:**
1. Atomic claim with hashed token, 120 s lease, 30 s heartbeat and monotonic generation; recheck authority on heartbeat and completion.
2. `knownRetryable` / `permanent` / `unknownOutcome` failure kinds; uncertain attempts wait for reconciliation or explicit retry.
3. Paused server answers list/claim with `503 automation_paused` and `Retry-After`.

**Done when:**
- Only one claimant can submit; AC-25 old generation fails.
- Revoked principal cannot heartbeat or finish (AC-37).

#### AW-24 — Implement typed results and the effect gateway through change plans — L

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-07, AW-23. **Stories:** AU-15, AU-16, AU-17, AU-18, AU-19.

**Handoff:** docs/automation/evidence/aw-24.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/modules/mcp/change-plan-service.ts`
- `packages/server/src/modules/mcp/change-plan-planner.ts`
- `packages/server/src/modules/mcp/agent-plan-policy.ts`
- `packages/server/src/modules/collections/application/create-annotation.ts`
- `packages/server/src/modules/collections/application/update-annotation.ts`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/submit-result.ts`
- `packages/server/src/modules/automation/application/effect-gateway.ts`

**Steps:**
1. Validate typed output and evidence against the pinned contract before any lock; then verify generation, input revision, manual-edit fence and subtree.
2. Build a change plan of reversible operations only (move_node, update_node tags, create/update annotation note with attribution) with cause `automation:<ruleId>:<jobId>`; refuse irreversible operations at build time.
3. Commit through the existing policy path: trusted → auto-commit with version; manual → awaitingApproval; record effect receipts in the same transaction as job success.
4. Reuse existing idempotent plan/commit APIs and preserve their real transaction boundary. Do not assume an outer job transaction can wrap the MCP coordinator. Record proposal + stable plan/command IDs, commit once, and reconcile a committed canonical operation into effect receipt/job status after crashes; add a same-transaction host hook only where source inspection proves it safe.

**Done when:**
- AC-03, AC-06, AC-24 pass; repeated submission creates no duplicate note, tag or move (AC-05).
- AC-46: manual waits on Approvals; trusted commits with a version.

#### AW-25 — Backend: adapt agent approvals and plan-scoped Undo — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-24, AW-51. **Stories:** AU-13, AU-18, AU-19, AU-27.

**Handoff:** docs/automation/evidence/aw-25.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/web/src/pages/WriteApprovals.tsx`
- `packages/web/src/pages/write-approvals/undo.test.tsx`
- `packages/server/src/modules/mcp/write-approval-api.ts`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/approval-service.ts`
- `packages/server/src/modules/automation/application/undo-service.ts`

**Steps:**
1. Integrate AW-24 with existing manual/trusted plan policy and Owner approvals, rather than adding a parallel approval state store.
2. Extend the AW-51 effect history with plan/version linkage. The existing baseline is collection-version Undo, not proven field-level selective restore. Accept one effectReceiptId and enforce conservative content fences.
3. Each automatically undoable plan contains one reversible effect unit. Reject or explicitly mark grouped/non-isolatable plans unavailable for single-effect Undo; never restore unrelated changes.
4. Publish approved, awaitingApproval, declined, revoked, stale and undo-unavailable contract fixtures to AW-52.

**Done when:**
- Approval, commit and receipt recovery are idempotent and revision-fenced.
- No frontend file is edited in this packet.

#### AW-26 — Backend: targets, composable profiles, pairing and wake readiness — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-09, AW-10. **Stories:** AU-15, AU-21, AU-26.

**Handoff:** docs/automation/evidence/aw-26.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/web/src/pages/Agents.tsx`
- `packages/web/src/pages/agents/AgentCard.tsx`
- `packages/server/src/modules/mcp/application-context.ts`
- `packages/server/src/transport/product/account-credential-routes.ts`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/target-service.ts`
- `packages/server/src/transport/product/automation-target-routes.ts`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_targets_and_profiles.ts`

**Steps:**
1. Implement target and executor identity records, independent catalogs[], scopes, privacy, wake mode and authoritative wakeReadiness/wakeReason.
2. Support worker bootstrap: an opted-in authenticated worker sees only automation.targets.pair until paired. Atomically bind a short-lived single-use grant to Owner, target and expected client/credential binding; no manager scope is needed.
3. Expose the equivalent HTTP pairing-claim endpoint for script workers. Both transports share the application service, rate limits and idempotency behavior.
4. A reachable endpoint and verified subscription establish Events readiness, not URL shape or an Owner override alone. Shared credentials do not establish dot-to-dot isolation; restricted targets require a verified dedicated binding.
5. Return secret-free status fixtures for unpaired, subscription missing, unreachable, active, revoked and polling to AW-53.
6. Own the additive migration for the later-milestone tables this task first requires; use chapter 09 and the actual migration head. Do not retroactively make M1 migrations reference an absent later table. Record ordering against concurrent migration PRs.

**Done when:**
- Worker-only bootstrap succeeds without manager tools; invalid/foreign/replayed grants fail safely.
- UI can render every setup state from the returned DTO without deriving authority locally.

#### AW-27 — Implement Events discovery and method adapters — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-02, AW-26. **Stories:** AU-15, AU-26.

**Handoff:** docs/automation/evidence/aw-27.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/node/src/shared/mcp-sdk-boundary.ts`
- `packages/node/src/mcp/2026-07-28/subscriptions.ts`
- `api/mcp-events.openapi.yaml`

**Files (new or modified):**
- `packages/node/src/mcp/2026-07-28/events.ts`
- `packages/node/src/mcp/2026-07-28/events-schema.ts`
- `packages/server/src/modules/mcp/events-adapter.ts`
- `packages/node/src/shared/mcp-sdk-boundary.ts`
- `packages/node/docs/MCP_SDK_POLICY.md`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_subscriptions.ts`

**Steps:**
1. Add `events/list`, `events/subscribe`, `events/unsubscribe` with pinned method schemas behind `KNOWN_FEATURE_MCP_EVENTS`.
2. One stable event `colp.automation.triggered` with `{ targetId }` filter; deterministic subscription identity; explicit no-replay cursor semantics; finite TTL.
3. Pairing code consumption for hosted bots (`automation.targets.pair`).
4. Own the additive migration for the later-milestone tables this task first requires; use chapter 09 and the actual migration head. Do not retroactively make M1 migrations reference an absent later table. Record ordering against concurrent migration PRs.

**Done when:**
- Refresh and unsubscribe are idempotent; no fake REST paths.
- Fixtures from AW-02 pass against the real envelope adapter.

#### AW-28 — Implement verified callback and signing — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-26, AW-27. **Stories:** AU-26.

**Handoff:** docs/automation/evidence/aw-28.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/infrastructure/egress/hardened-egress.ts`
- `05-mcp-events.md §7`

**Files (new or modified):**
- `packages/server/src/infrastructure/automation/webhook-verifier.ts`
- `packages/server/src/infrastructure/automation/webhook-signer.ts`

**Steps:**
1. Challenge verification through the hardened egress: HTTPS public destinations, pinned address, no redirects, bounded time and body.
2. Standard Webhooks signing of exact bytes with `webhook-id`, `webhook-timestamp`, `webhook-signature`, `X-MCP-Subscription-Id`; dual-key rotation window.
3. Encrypt secrets with the master key; redact everywhere.
4. Validate whsec_ base64 by decoded length 24–64 bytes. Pin public DNS address at connection time and never follow redirects. Every retry uses the identical stored body/event ID but a fresh Unix signing timestamp and signature.

**Done when:**
- AC-34 and AC-35 pass.
- No COLP cookie or bearer ever appears in callback traffic.

#### AW-29 — Implement target routing and the delivery worker — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-15, AW-23, AW-28. **Stories:** AU-15, AU-24, AU-26, AU-30.

**Handoff:** docs/automation/evidence/aw-29.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/infrastructure/outbox/worker.ts`
- `09-data-model.md §6`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/route-run.ts`
- `packages/server/src/infrastructure/automation/delivery-worker.ts`
- `packages/server/src/transport/product/automation-delivery-routes.ts`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_deliveries.ts`

**Steps:**
1. Snapshot eligible recipients at run creation; `single` in M2, `firstClaim`/`perTarget` enabled in M4.
2. For targets in events mode persist one occurrence per ready job before sending; generation-fenced send outside locks; bounded backoff; 410/413 disable the path. Targets in poll mode get no occurrence; their jobs simply wait in the ready list.
3. Deliveries list and retry for the Owner; switching a target to poll cancels its pending occurrences.
4. A 413 makes that oversized occurrence terminal and raises an incident; do not disable all target delivery. A 410 stops that subscription path. Reconciliation through jobs.list on setup/reconnect retrieves durable ready work without pretending to replay historical occurrences.
5. Own the additive migration for the later-milestone tables this task first requires; use chapter 09 and the actual migration head. Do not retroactively make M1 migrations reference an absent later table. Record ordering against concurrent migration PRs.

**Done when:**
- AC-36: duplicate acceptance never duplicates an effect.
- One failed target never re-notifies a successful one (M4, AC-22).

#### AW-30 — Implement conditional MCP tool catalogs — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-10, AW-26. **Stories:** AU-21.

**Handoff:** docs/automation/evidence/aw-30.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/modules/mcp/application-catalog.ts`
- `packages/server/src/modules/mcp/application-context.ts`
- `packages/server/src/modules/mcp/application-facade.ts`

**Files (new or modified):**
- `packages/server/src/modules/mcp/automation-catalog.ts`
- `packages/server/src/modules/mcp/application-catalog.ts`
- `packages/server/src/modules/mcp/application-context.ts`

**Steps:**
1. Derive the catalog from authenticated profile, enablement and scopes; standard profiles see no automation tools, resources or instructions.
2. Apply the same decision to `tools/call`; tenant-aware cache keys; no global list-change hints across profiles.
3. First-time setup works with no job and no subscription.

**Done when:**
- AC-17: pre-feature tool list unchanged for ordinary agents; direct calls refused.
- AC-18: worker tools listed before any job.

#### AW-31 — Mount worker and manager MCP tools and the HTTP work API — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-23, AW-24, AW-30. **Stories:** AU-15, AU-21.

**Handoff:** docs/automation/evidence/aw-31.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/src/modules/mcp/write-tools.ts`
- `packages/server/src/modules/mcp/read-tools.ts`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/server/src/modules/mcp/automation-tools.ts`
- `packages/server/src/modules/mcp/application-facade.ts`
- `packages/server/src/transport/automation-work-routes.ts`

**Steps:**
1. Expose the 14 descriptors with closed schemas; map arguments to the same application services as the HTTP work routes.
2. Bind job inputs and results to the authenticated target; a job reference in an event grants nothing.
3. Worker reads bookmarks with existing `nodes.get`; no write tools are added by the worker profile.
4. Mount automation.jobs.list and worker HTTP pairing as well as get/inputs/claim/heartbeat/submit/fail. Every listed worker job carries a ledger-issued deliveryHandle even with no Events subscription; job-scoped input fields remain allowlisted.

**Done when:**
- `tools/list` and `tools/call` enforce identical permissions.
- `npm --prefix packages/server run test:mcp:write-operations:postgres` and the new automation tool tests pass.

#### AW-32 — Worker reference: setup instructions and a runnable polling adapter — M

**Milestone:** M2. **Lane:** worker-reference. **Depends on:** AW-31. **Stories:** AU-15, AU-26.

**Handoff:** docs/automation/evidence/aw-32.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `packages/web/src/pages/agents/ConnectGuide.tsx`
- `docs/ (agent guide for claude mcp login / codex mcp login)`
- `~/known/known-cli (MCP client with OAuth)`

**Files (new or modified):**
- `docs/automation/agents.md`
- `examples/worker-script/claim-and-summarize.mjs`

**Steps:**
1. Write host-neutral setup instructions for Events-capable hosted agents and reachable local polling workers. Name dots as an officially documented candidate, not a verified COLP integration until AW-46 passes.
2. The script authenticates and pairs via the worker endpoint, lists the ready queue (pagination and target selection), claims, reads allowlisted inputs, heartbeats, submits typed output and reports uncertainty. Configure credentials externally; do not hardcode tokens.
3. The Events guide instructs reconciliation through automation.jobs.list on setup/reconnect and handling multiple events in one host run. Never infer one event means one host task.
4. Run transport fixtures with injected adapters and provide explicit task support limits. The reference worker is not an autonomous deployment guarantee or a new server-owned model executor.

**Done when:**
- Script reference exercises the same typed worker contract as MCP tools.
- No Web or extension runtime files are modified.

#### AW-34 — Web: run history, waiting work, budgets and result states — M

**Milestone:** M2. **Lane:** web. **Depends on:** AW-11, AW-22, AW-25, AW-55. **Stories:** AU-13, AU-22, AU-23, AU-24, AU-27.

**Handoff:** docs/automation/evidence/aw-34.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `packages/web/src/pages/CollectionHistory.tsx`
- `Known-Extension/src/options-tabs.ts`
- `Known-Extension/src/save-status.ts`
- `packages/server/src/infrastructure/telemetry/index.ts`

**Files (new or modified):**
- `packages/web/src/pages/automations/RunDetail.tsx`
- `packages/web/src/pages/automations/RuleDetail.tsx`

**Steps:**
1. Render RunDetail and RuleDetail from generated Product DTOs; distinguish waiting, approval, stale, review, partial and failed.
2. Display server-provided usage/budget uncertainty and wake readiness. Never compute permission, retry safety, effective rule state or claimed completion in the browser.
3. Use fixtures from AW-55 and existing backend APIs for network-free UI tests; link to the existing Approvals and the AW-52 effect view.

**Done when:**
- All backend states have meaningful empty/loading/error/permission renderings.
- Only packages/web source files are changed.

#### AW-35 — Integration: assemble the M2 release proof from lane-owned evidence — L

**Milestone:** M2. **Lane:** integration. **Depends on:** AW-25, AW-29, AW-32, AW-33, AW-34, AW-44, AW-46, AW-52, AW-53, AW-56, AW-64. **Stories:** AU-06, AU-15, AU-18, AU-19, AU-21, AU-26.

**Handoff:** docs/automation/evidence/aw-35.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `03-user-stories.md (worked narrative)`
- `Known-Extension/e2e/mv3-colp-server-sync.spec.ts`
- `deploy/smoke.sh`

**Files (new or modified):**
- `docs/automation/release-evidence.md`

**Steps:**
1. Collect backend E2E evidence from AW-64, extension E2E from AW-56, hosted lifecycle from AW-46 and Web evidence from AW-52/AW-53/AW-34.
2. Run the fixed academic-summary-only fixture: one intake run, one unsatisfied summary job, signed wake (possibly retried), accepted plan, browser sync, and no loop. Run the same worker contract in polling mode.
3. Separately test academic-intake with all three tasks: three jobs may be ready and ChatGPT may group events into one host run. Do not use one-job expectations for that fixture.
4. Publish release evidence and remaining blockers. Do not repair frontend or backend product code in this integration packet; return defects to its owning lane.

**Done when:**
- Release evidence identifies exact builds and executed commands, without credentials.
- A missing real-host lifecycle remains a release blocker for the hosted feature; M1 can still release independently.

#### AW-44 — Retention, restore safety and load evidence — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-09, AW-16, AW-24, AW-29. **Stories:** AU-10, AU-24, AU-27, AU-33.

**Handoff:** docs/automation/evidence/aw-44.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `deploy/restore.sh`
- `packages/server/src/infrastructure/outbox/worker.ts`
- `07-acceptance-operations.md §5 restore runbook`

**Files (new or modified):**
- `packages/server/src/infrastructure/automation/retention-worker.ts`
- `packages/server/src/infrastructure/automation/restore-revalidation.ts`
- `packages/server/tests/integration/automation/load-and-recovery.test.ts`

**Steps:**
1. Protect unfinished members, pending inputs and dedup identities through the supported horizons; expiry creates an incident and a terminal record.
2. Restored servers start paused and mark external attempts uncertain; subscriptions (M3) revalidate.
3. Measure evaluator, Outbox and job workloads at representative sizes before raising defaults (G6).

**Done when:**
- AC-38 and AC-39 pass with measurements recorded.
- Restore never produces a redelivery storm.

#### AW-46 — Events conformance and lifecycle fixtures — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-27, AW-28, AW-29, AW-31, AW-64. **Stories:** AU-26.

**Handoff:** docs/automation/evidence/aw-46.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `05-mcp-events.md §11`
- `docs/automation/evidence/events-spike.md`

**Files (new or modified):**
- `packages/server/tests/integration/automation/events-lifecycle.test.ts`
- `docs/automation/evidence/events-lifecycle.md`

**Steps:**
1. Run the lifecycle list from 05 §9 against the pinned upstream fixtures and a real dot: enabled/disabled catalogs, pairing two targets, discovery, verification, create/refresh/expire/restart/unsubscribe, bad secret and bad challenge, blocked private/redirect/DNS destinations, duplicate and out-of-order delivery, revocation while queued and leased.
2. Prove a delivered occurrence leads to a claimed job and one accepted effect, and that a duplicate delivery does not.
3. Include current OpenAI profile vs draft error codes, fresh retry signatures, 413 terminal occurrence only, host burst grouping, rescanning changed descriptors, and bootstrap/reconnect queue reconciliation. Record actual vs simulated evidence separately.

**Done when:**
- AC-34, AC-35, AC-36 pass with redacted evidence; AW-35 consumes these fixtures.

#### AW-52 — Web: connect automation plan approvals and effect-specific Undo — M

**Milestone:** M2. **Lane:** web. **Depends on:** AW-12, AW-25. **Stories:** AU-13, AU-19.

**Handoff:** docs/automation/evidence/aw-52.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/web/src/pages/WriteApprovals.tsx`
- `packages/web/src/pages/ResourceDetail.tsx`

**Steps:**
1. Reuse Approvals and existing resource Automation view; submit the exact plan/effect ID, digest and ETag provided by backend.
2. Display conservative Undo-unavailable explanations; never promise field-level restore that backend does not support.
3. Do not approve, construct plans, infer policy or calculate authorization on the client.

**Done when:**
- Mocked approved, pending, declined, stale and non-undoable plans render and dispatch correct commands.

#### AW-53 — Web: Agents automation toggles, pairing and connection guide — M

**Milestone:** M2. **Lane:** web. **Depends on:** AW-26, AW-30, AW-32. **Stories:** AU-21, AU-26.

**Handoff:** docs/automation/evidence/aw-53.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/web/src/pages/agents/AgentCard.tsx`
- `packages/web/src/pages/Agents.tsx`
- `packages/web/src/pages/agents/ConnectGuide.tsx`

**Steps:**
1. Render independent manager and worker catalog opt-ins and backend wakeReadiness/wakeReason. A selected events mode is not an active subscription.
2. Show the Owner-issued one-use pairing grant only in the intended setup UI; never persist it in navigation URLs or logs.
3. Explain direct-public HTTPS versus reachable local polling and account/workspace eligibility. No implied dot creation API or per-dot isolation.
4. Use worker-reference guide text; no transport negotiation or grant validation is implemented in React.

**Done when:**
- Unpaired, missing subscription, shared credential, blocked origin, active and polling states have mock tests.

#### AW-54 — Extension: show server run status without reimplementing workflow logic — M

**Milestone:** M2. **Lane:** extension. **Depends on:** AW-21, AW-31. **Stories:** AU-22, AU-23.

**Handoff:** docs/automation/evidence/aw-54.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `Known-Extension/src/automation/status-ui.ts`

**Steps:**
1. Map server DTO states and local receipt state to extension status UI; keep placement success separate from worker completion.
2. Report stale/offline freshness honestly; do not claim model spending, delivery or approval happened locally.

**Done when:**
- No backend or Web files are touched; no workflow state machine is duplicated in UI.

#### AW-55 — Backend: telemetry and read-model fields for waiting work and budgets — M

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-22, AW-23. **Stories:** AU-22, AU-23.

**Handoff:** docs/automation/evidence/aw-55.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/server/src/infrastructure/telemetry/automation-metrics.ts`

**Steps:**
1. Expose bounded aggregate counts and budget observations through documented rule/run views; redact private bodies, credentials and callback destinations.
2. Separate deliveries accepted, jobs succeeded, policy-blocked, awaiting approval and unknown external costs. Frontend does not derive these by joining secret ledgers.
3. Before AW-29, expose delivery capability as unavailable, not a fabricated success/zero-latency status. Add real delivery metrics after the adapter exists; job and budget views remain usable in polling-only deployment.

**Done when:**
- Metrics contain no private payloads and delivery acceptance cannot inflate job success.

#### AW-56 — Extension E2E: local intake, sync projection and no feedback loop — M

**Milestone:** M2. **Lane:** extension. **Depends on:** AW-19, AW-20, AW-21, AW-54. **Stories:** AU-06, AU-07, AU-08, AU-10, AU-11, AU-19.

**Handoff:** docs/automation/evidence/aw-56.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `Known-Extension/e2e/automation.spec.ts`

**Steps:**
1. Run extension tests against versioned backend fixtures/test deployment, covering foreground save, star observer, explicit manual choice, restart, receipt retries and projected effects.
2. Produce redacted evidence for AW-35. Product defects are returned to their owning tasks, not fixed across lanes here.

**Done when:**
- Test logs prove no unexpected folder model request and no re-intake of projected effects.

#### AW-64 — Backend E2E: polling and plan recovery, independent of Events and UI — L

**Milestone:** M2. **Lane:** backend. **Depends on:** AW-17, AW-23, AW-24, AW-25, AW-31, AW-33. **Stories:** AU-09, AU-15, AU-18, AU-19, AU-21.

**Handoff:** docs/automation/evidence/aw-64.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/server/tests/integration/automation/end-to-end.test.ts`

**Steps:**
1. Exercise canonical facts/receipt admission, worker list/claim/input/submit, plan and version persistence, sync causation and uncertain completion with backend test fixtures.
2. Test the one-job and three-task fixtures separately. Repeat list, claim and result commands and crash after canonical commit; accept one effect per pinned job/input/step, never create a second plan to resolve an unknown outcome.
3. Publish backend evidence to AW-35; real extension/host evidence belongs to its own gate.
4. Run on loopback with an authenticated reference worker and injected deterministic typed output; no LLM, callback, public origin, dot account or frontend is required. Actual provider integration and Events parity are separately proved in AW-46/AW-35.

**Done when:**
- Crash windows and repeated commands produce no double accepted canonical effect.

### M3 — Batches and run-once

#### AW-41 — Backend: immutable run-once preview and start — M

**Milestone:** M3. **Lane:** backend. **Depends on:** AW-10, AW-16, AW-24, AW-51. **Stories:** AU-04, AU-14, AU-25.

**Handoff:** docs/automation/evidence/aw-41.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/web/src/pages/SelfHostedImport.tsx`
- `packages/server/src/modules/collections/application (subtree listing)`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/run-once-service.ts`
- `packages/server/src/transport/product/automation-rule-routes.ts`

**Steps:**
1. Persist bounded selected members, revisions, rule/binding/policy digests and all selection options in an expiring preview record.
2. Return canStart=false above 1000 members instead of silent truncation. Start requires previewId and previewDigest, uses exactly that snapshot and rechecks current authority/revisions.
3. A stale or changed preview yields explicit refresh; a duplicate command returns the existing manual run. Nothing schedules itself, backfills activation or bypasses explicit-folder protection.
4. Publish preview, over-limit, stale, denied and started fixtures to AW-59.

**Done when:**
- An unpreviewed start is invalid at schema level.
- Backend has no dependency on Web tasks.

#### AW-45 — Web: Digests list and paginated run-level text output — S

**Milestone:** M3. **Lane:** web. **Depends on:** AW-34, AW-58. **Stories:** AU-24.

**Handoff:** docs/automation/evidence/aw-45.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `packages/web/src/pages/automations/RunDetail.tsx`
- `Known-Extension/src/badge-colors.ts`

**Files (new or modified):**
- `packages/web/src/pages/automations/RunDetail.tsx`
- `packages/web/src/pages/automations/Digests.tsx`

**Steps:**
1. Render Digests and RunDetail from AW-58 output DTOs; render text safely, preserve target/result provenance and distinguish unavailable source content.
2. Use markAutomationRunRead through the viewed output ID. A later concurrent digest must remain unread.
3. Do not count or aggregate bookmarks or use event callback delivery as the digest data source.

**Done when:**
- Unread state survives refresh and later-arriving output remains unread.
- Only Web runtime files are changed.

#### AW-57 — Backend: exact count-batch aggregation and durable remainder — L

**Milestone:** M3. **Lane:** backend. **Depends on:** AW-15, AW-16, AW-24, AW-29. **Stories:** AU-24, AU-27.

**Handoff:** docs/automation/evidence/aw-57.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/count-batch.ts`
- `packages/server/src/infrastructure/automation/aggregate-store.ts`
- `packages/server/tests/integration/automation/count-batch.test.ts`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m3_batches.ts`

**Steps:**
1. Implement countBatch rather than treating each admission as a batch. Lock the rule revision/epoch/partition; deduplicate source membership and remove exactly N ordered members per batch.
2. Atomically write immutable batch members, run and task jobs and persist remainder. Job-ready transition schedules delivery only after task dependencies and target authority pass.
3. Test 9→10, 20 plus remainder, concurrent 10th/11th, duplicate source events, pause/resume, revision edits and crash-before/after commit. Live reads must not recount historical state.
4. Keep batch membership immutable even when a member becomes unavailable at execution; disclose missing inputs or review without silently substituting a new member.
5. Own the additive migration for the later-milestone tables this task first requires; use chapter 09 and the actual migration head. Do not retroactively make M1 migrations reference an absent later table. Record ordering against concurrent migration PRs.

**Done when:**
- The 10-member fixture yields exactly one run, not ten each-runs or a duplicated batch.
- Remainder and unique admission survive retry/restart.

#### AW-58 — Backend: store/read run-level outputs and durable unread state — M

**Milestone:** M3. **Lane:** backend. **Depends on:** AW-24, AW-57. **Stories:** AU-24.

**Handoff:** docs/automation/evidence/aw-58.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/run-output-service.ts`
- `packages/server/src/transport/product/automation-output-routes.ts`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m3_outputs.ts`

**Steps:**
1. Persist accepted digest/review text linked to result/job/target; outputs not writing bookmark fields do not create fake canonical mutation plans.
2. Implement listAutomationRunOutputs and markAutomationRunRead plus Run.outputCount/unread. Stable createdAt,id cursor and throughOutputId prevent concurrent-read races.
3. Honor current Owner/source access and retention; sanitize untrusted text for rendering contracts without rewriting source evidence.
4. Publish paginated output/read fixtures to Web and extension teams.
5. Own the additive migration for the later-milestone tables this task first requires; use chapter 09 and the actual migration head. Do not retroactively make M1 migrations reference an absent later table. Record ordering against concurrent migration PRs.

**Done when:**
- Reading one output cannot mark a later concurrent result read.
- Digest discovery does not depend on webhook replay or a frontend-only cache.

#### AW-59 — Web: run-once preview and explicit start — M

**Milestone:** M3. **Lane:** web. **Depends on:** AW-12, AW-41. **Stories:** AU-25.

**Handoff:** docs/automation/evidence/aw-59.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/web/src/pages/automations/RunOnce.tsx`

**Steps:**
1. Render selection options and preview counts/sample; submit only previewId and previewDigest with command ID on confirmation.
2. Disable start for expired, stale, over-limit or disallowed previews. A user option change discards the old preview.
3. No local member enumeration, batching or automatic restart is authoritative.

**Done when:**
- Frontend cannot submit an unpreviewed or silently changed selection.

#### AW-60 — Extension: digest unread indicator and navigation — M

**Milestone:** M3. **Lane:** extension. **Depends on:** AW-54, AW-58. **Stories:** AU-24.

**Handoff:** docs/automation/evidence/aw-60.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `Known-Extension/src/automation/status-ui.ts`

**Steps:**
1. Display backend unread state and navigate to the run; do not independently count content or mark every output read on badge display.
2. An offline badge exposes staleness and refreshes from the current read model.

**Done when:**
- Badge is a projection of backend state, not a second unread ledger.

### M4 — Share the logic

#### AW-36 — Backend: portable template import/export and draft installation — M

**Milestone:** M4. **Lane:** backend. **Depends on:** AW-10, AW-61. **Stories:** AU-28, AU-29.

**Handoff:** docs/automation/evidence/aw-36.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `schemas/template.schema.json`
- `examples/paper-template.json`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/template-service.ts`
- `packages/server/src/transport/product/automation-template-routes.ts`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m4_templates.ts`

**Steps:**
1. Consume PortableRuleDefinition from AW-61. Resolve collectionSlot and targetSlots only through an Owner-approved installation mapping.
2. Persist templates and create draft rules; strip live IDs, credential references, callbacks and private example values from shareable exports. Folder paths in owner exports remain private hints, not portable authority.
3. Expose template list/import/install/export DTOs; installation cannot activate merely because an exported source desiredState was enabled.
4. Own the additive migration for the later-milestone tables this task first requires; use chapter 09 and the actual migration head. Do not retroactively make M1 migrations reference an absent later table. Record ordering against concurrent migration PRs.

**Done when:**
- No live deployment authority survives a shareable export.
- Frontend wizard uses fixtures; backend does not depend on the wizard.

#### AW-37 — Role-binding install wizard — M

**Milestone:** M4. **Lane:** web. **Depends on:** AW-36. **Stories:** AU-28, AU-31.

**Handoff:** docs/automation/evidence/aw-37.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `packages/web/src/pages/automations/RuleEditor.tsx`

**Files (new or modified):**
- `packages/web/src/pages/automations/TemplateInstall.tsx`

**Steps:**
1. Map typed roles to the Owner's folders, targets, vocabularies and entity maps; explain unsupported stages and missing optional destinations.
2. Produce a validated draft; never create folders.

**Done when:**
- AC-27 passes for two owners with unrelated trees.

#### AW-38 — Backend: immutable template upgrade, preview and rollback commands — M

**Milestone:** M4. **Lane:** backend. **Depends on:** AW-25, AW-36, AW-61. **Stories:** AU-29.

**Handoff:** docs/automation/evidence/aw-38.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/node/src/automation/fingerprint.ts`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/template-upgrade.ts`

**Steps:**
1. Consume the shared semantic diff from AW-61 and the template service from AW-36.
2. Bind upgrade preview to old/new definition digests and role mapping. Retain pinned in-flight runs; require explicit lifecycle policy for pending work.
3. Publish changed-permission, new-role, unsafe-upgrade, stale-preview and rollback fixtures for AW-65; do not implement presentation here.

**Done when:**
- Server checks precede effects and do not depend on a frontend wizard.

#### AW-39 — Backend: metadata predecessor, entity-map and vocabulary adapters — M

**Milestone:** M4. **Lane:** backend. **Depends on:** AW-22, AW-24, AW-61. **Stories:** AU-17, AU-31.

**Handoff:** docs/automation/evidence/aw-39.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `examples/research-catalog.json`
- `examples/research-catalog-bindings.json`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/metadata-proposal.ts`
- `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m4_entity_maps.ts`

**Steps:**
1. Resolve only accepted predecessor output into metadata input snapshots; include folderDefinitions where requested. Do not require the worker to guess predecessor output through a general node read.
2. Apply shared stable-key entity/vocabulary mapping from AW-61. Enforce catalogRoot ancestry, ambiguity review and restricted-target isolation.
3. Use the institutional research dataset catalog fixture with synthetic accession identifiers and research groups. Metadata resolution alone is a typed result, not a bookmark mutation.
4. Own the additive migration for the later-milestone tables this task first requires; use chapter 09 and the actual migration head. Do not retroactively make M1 migrations reference an absent later table. Record ordering against concurrent migration PRs.

**Done when:**
- Mapped destinations are descendants of the bound root; unknown/multiple mappings stay in review.

#### AW-42 — Broadcast and per-target routing — M

**Milestone:** M4. **Lane:** backend. **Depends on:** AW-29, AW-31. **Stories:** AU-30.

**Handoff:** docs/automation/evidence/aw-42.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `01-architecture.md §14`
- `examples/broadcast-digest.json`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/route-run.ts`

**Steps:**
1. Snapshot opted-in authorized targets at run creation; independent jobs and append-only results; placement refused in perTarget mode.
2. `firstClaim` for shared tasks.

**Done when:**
- AC-22 passes.

#### AW-43 — Server CEL condition profile — M

**Milestone:** M4. **Lane:** backend. **Depends on:** AW-06, AW-36. **Stories:** —.

**Handoff:** docs/automation/evidence/aw-43.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `02-rule-contract.md §3.2`
- `W04 and W08 in 08-evidence-and-decisions.md`

**Files (new or modified):**
- `packages/server/src/infrastructure/automation/cel-evaluator.ts`

**Steps:**
1. Do not start before a story needs it (tag transitions or templates that ship CEL).
2. Frozen typed environment, pinned evaluator, CPU and memory bounds, declared dependencies; never lowered to the browser.

**Done when:**
- Fixtures from `tag-review.json` evaluate; unsupported functions fail activation.

#### AW-61 — Shared-core: portable templates, semantic diffs and stable entity maps — L

**Milestone:** M4. **Lane:** shared-core. **Depends on:** AW-04, AW-05, AW-07. **Stories:** AU-28, AU-29, AU-31.

**Handoff:** docs/automation/evidence/aw-61.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/node/src/automation/template.ts`
- `packages/node/src/automation/semantic-diff.ts`
- `packages/node/src/automation/entity-map.ts`

**Steps:**
1. Implement pure data transforms for PortableRuleDefinition symbolic collection/target slots, role validation and digest-preserving template packaging.
2. Compute semantic differences without consulting databases or rendering a wizard; input versions and changes are explicit.
3. Implement stable-key entity and vocabulary lookup with explicit ambiguous/unmapped results. No network, model, browser or database imports.

**Done when:**
- Portable artifacts contain no live authority binding and shared tests run in browser-compatible builds.

#### AW-65 — Web: semantic template upgrade and rollback review — M

**Milestone:** M4. **Lane:** web. **Depends on:** AW-37, AW-38. **Stories:** AU-29.

**Handoff:** docs/automation/evidence/aw-65.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `packages/web/src/pages/automations/TemplateUpgrade.tsx`

**Steps:**
1. Render backend semantic diff, binding changes and authority implications; confirmation submits the pinned preview identity and revision.
2. Do not merge or execute template code in the browser; stale/unsafe previews require new review.

**Done when:**
- Upgrade UI has independent mock tests and never determines effective authorization.

### Later

#### AW-40 — Durable scheduled batches — M

**Milestone:** Later. **Lane:** backend. **Depends on:** AW-57. **Stories:** AU-32.

**Handoff:** docs/automation/evidence/aw-40.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `packages/server/migrations/README.md (digest scheduler revision fence)`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/scheduler.ts`
- `packages/server/src/infrastructure/automation/schedule-store.ts`

**Steps:**
1. Five-field cron with IANA timezone, persisted next-fire, unique fire key; coalesce/skip misfire; DST semantics.
2. Expose the capability only once the scheduler composition is durable.

**Done when:**
- AC-29 passes.

#### AW-47 — Event-time historical replay — M

**Milestone:** Later. **Lane:** backend. **Depends on:** AW-15, AW-25, AW-44. **Stories:** AU-27.

**Handoff:** docs/automation/evidence/aw-47.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `09-data-model.md §8`

**Files (new or modified):**
- `packages/server/src/modules/automation/application/replay-service.ts`

**Steps:**
1. Require retained facts and a preview identity; separately identified replay runs; disclose incomplete coverage; honor current permissions.

**Done when:**
- Replay never restores missing facts from current rows and never double-applies accepted effects.

#### AW-48 — Later backend: server-owned model executor adapter — L

**Milestone:** Later. **Lane:** backend. **Depends on:** AW-22, AW-24. **Stories:** AU-20.

**Handoff:** docs/automation/evidence/aw-48.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No React or Chrome UI changes. Publish contracts and fixtures first so clients can develop against mocks.

**Read first:**
- `Known-Extension/src/classification-local-preview.ts`
- `Known-Extension/src/capture/automatic.ts`

**Files (new or modified):**
- `packages/server/src/infrastructure/automation/executors/server-model.ts`

**Steps:**
1. Implement only the server-model executor using host-managed credentials and execution policy. Keep model network I/O outside database locks.
2. Track billing-known and unknown outcomes, uncertainty, consent, caps and typed result submission through the same effect gateway.
3. No browser background execution is enabled by this task; that is AW-62.

**Done when:**
- Server adapter cannot bypass policy, claims or effect receipts.

#### AW-62 — Later extension: explicit-consent background model executor — M

**Milestone:** Later. **Lane:** extension. **Depends on:** AW-21, AW-22, AW-24. **Stories:** AU-12, AU-20.

**Handoff:** docs/automation/evidence/aw-62.md: commands, schema/fixture version, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No duplicated admission, authorization, workflow aggregation or delivery policy; consume backend DTOs. Extension-only deterministic placement uses the shared evaluator.

**Read first:**
- `11-execution-contract.md`
- `api/automation.openapi.yaml`
- `api/mcp-tool-catalog.json`

**Files (new or modified):**
- `Known-Extension/src/automation/executors/browser-classifier.ts`
- `Known-Extension/src/automation/model-consent.ts`

**Steps:**
1. Implement optional background execution only after explicit consent, applicable extension policy review and capability gating.
2. Reuse local credential no-cloud-fallback semantics; persist spent requests and unknown outcomes before network retry decisions.
3. Foreground-only classification remains unchanged unless this feature is actually enabled; a deterministic rule hit is not background model consent.

**Done when:**
- Worker suspension cannot duplicate a provider request whose result is uncertain.


## 6. Cross-cutting merge requirements

Every source mutation path is traced to exactly one admission. Any new feature that creates or moves bookmarks states whether it is user intake, import, restore, sync projection or an existing causal workflow step. Causation is set by the server effect gateway, never accepted from a client string.

New Product paths update the backend OpenAPI fragment, route manifest and gate lists, examples, drift and breaking checks together; frontend client generation remains in its own lane, and bump `info.version` of `colp-server-v1.yaml` additively with a new baseline snapshot (R24). MCP tools use closed schemas and the same services, with no Product session shortcuts. Webhooks are outbound infrastructure and never forwarded through public feeds.

Migrations follow §0 of the data model: prefix after the current head, forward-only, with operational notes. Rollbacks stop admission and delivery first. No live credentials, tokens, private bookmark bodies or personal examples enter fixtures.

New UI strings follow the existing localization practice of each surface (the extension has `check:i18n`; see Q4 for the web). CHANGELOG "Upgrade notes" names the automation migrations and the new flags.

## 7. Machine-readable handoff

[tasks.json](tasks.json) is the source of §4 and §5. [traceability.json](traceability.json) is generated from it and from [user-stories.json](user-stories.json). [acceptance-tests.json](acceptance-tests.json) is the source of the acceptance matrix. [api/operations.json](api/operations.json) is the HTTP inventory with milestones. `validation/build-docs.py` regenerates the derived sections and fails when the stories chapter disagrees with the JSON.

---

<!-- Source chapter: 07-acceptance-operations.md -->

# Acceptance, Security, Operations and Rollout

**Important:** AC-01–AC-52 are required implementation tests, not tests executed while producing this pack. [validation/report.md](validation/report.md) records the checks actually performed on the artifacts. The matrix in §1 is generated from [acceptance-tests.json](acceptance-tests.json).

## 1. Acceptance matrix

| Test | Milestone | Scenario | Action | Required proof |
|---|---|---|---|---|
| AC-01 | M1 | Pre-save deterministic match | Save an arXiv page through the popup, the shortcut, the context menu and Save tabs with the rule enabled. | The native bookmark is created directly under Academic (no create-then-move); the local provider receives no folder request; the result panel names the rule. |
| AC-02 | M1 | Matched but unusable destination | Delete or unsync the bound folder, then save a matching page. | The save succeeds at the chosen or default location; the rule stage is blocked with a reason; no alternate classifier is called. |
| AC-03 | M2 | Refinement boundary | Have a worker propose a destination outside the bound subtree, and separately move a valid destination out after the worker read it. | Both proposals are rejected at commit with a boundary diagnostic recorded on the job. |
| AC-04 | M1 | Tags-only local request | Enable the local provider with tag mode Suggest, then Add, then Off; save a matching page each time. | Requests carry folder:false,tags:true for Suggest and Add and no request is sent for Off; a local tag result marks the tags task satisfied on the receipt. |
| AC-05 | M2 | Contract-aware reuse and idempotent results | Submit the same result twice from two devices or attempts; then change the summary contract without changing the bookmark. | One note and one tag set exist; the old summary is not reused for a different contract. |
| AC-06 | M2 | Taxonomy ambiguity | Provide overlapping sibling folders and a worker result with keepParent and two subject tags. | The bookmark stays at the parent, both tags apply, and no provider score is compared across models. |
| AC-07 | M1 | Manual choice fencing | Pick a folder explicitly in the popup while a rule matches; later let a late worker placement arrive. | The manual folder is kept in both cases and the panel explains the skipped rule. |
| AC-08 | M1 | Rule conflict | Enable two equal-priority rules with different destinations and save a matching page. | The bookmark is not moved; it appears under Needs a decision with both rules named; tag additions still apply. |
| AC-09 | M1 | Star-button creation | Create a matching bookmark with the browser's star button into a bookmark root. | After the settle window one move is applied, one toast is shown, and the server records one intake covering create and move. |
| AC-10 | M1 | Offline persistence and join | Save offline, kill the service worker, restart the browser, reconnect. | The receipt and native identity survive; the server joins the receipt to the sync operation; no second run exists. |
| AC-11 | M1 | Invalid or expired bundle | Install partial, corrupt, unsupported and expired bundles. | Automatic effects fail closed with a notice; the previous valid bundle stays in force; saving still works. |
| AC-12 | M1 | Projection echo | Project one server move to two browsers. | Neither browser starts an intake; the intended next stage remains allowed. |
| AC-13 | M1 | Rename | Rename a bound folder during a partial batch (M3) or with pending jobs (M1). | The rule sentence refreshes; identity, counters and pending work are unchanged; one informational notice. |
| AC-14 | M1 | Move and ancestry | Move a bound folder inside its allowed scope, then outside, then move an ancestor. | Inside: notice only. Outside: dependent stages block with the fix named. Ancestor: all dependent rules listed in one notice. |
| AC-15 | M1 | Delete and same-name recreation | Delete a bound folder, create another with the same name, then restore the original. | No auto-rebind; Restore and Choose another are offered; restore revalidates without replay. |
| AC-16 | M2 | Partial health | Make the worker target unavailable while saving matching pages. | Placement continues; the rule shows waiting jobs with last-seen time; the rule is degraded, not blocked. |
| AC-17 | M2 | Standard tool catalog | List and call tools with an agent that has no automation switch. | The tool list equals the pre-feature list; direct calls to automation tools are refused. |
| AC-18 | M2 | Bootstrap before first job | Enable a worker and list tools before any job or subscription exists. | Worker tools are listed; nothing requires an active subscription. |
| AC-19 | M2 | Target isolation | Create two targets on one OAuth client and two on separate clients; route jobs to one. | Only the intended target lists the job; the shared-client case is labeled as not a security boundary. |
| AC-20 | M3 | 9 + 2 race | Admit two bookmarks concurrently with nine waiting in a count-10 rule. | Exactly one run of ten and one waiting member commit. |
| AC-21 | M3 | Fixed members and replayed source | Retry a source event, run-once 25 bookmarks, then delete a batch member. | No double count; two runs of ten and five waiting; the deleted member is reported, not replaced. |
| AC-22 | M4 | Broadcast fan-out | Broadcast per-target analysis; fail one receiver; add a target later. | Independent results; successful targets are not re-notified; the new target gets no old private work. |
| AC-23 | M2 | No implicit fallback | Remove the local key; make the configured target unavailable; no fallback approved. | No alternate destination or paid request is attempted; work waits with a visible reason. |
| AC-24 | M2 | Stale input | Edit the note or move the bookmark while a job is leased, then let the result arrive. | The late result is not applied to the edited field; the job ends stale with the proposal kept where it still makes sense. |
| AC-25 | M2 | Stale lease | Expire and reassign a job, then submit from the old generation. | Old completion and heartbeat fail; one accepted effect set exists. |
| AC-26 | M1 | Preview-bound activation | Preview, edit a binding, then try to enable with the old preview; also enable a never-previewed rule from the API. | Both are refused; a fresh preview of the exact configuration is required. |
| AC-27 | M4 | Portable install | Install one template for two owners with unrelated folder names. | Both resolve their own roles; no folder is created on install. |
| AC-28 | M4 | Upgrade disclosure | Upgrade a template to add broadcast or external retrieval. | A semantic diff and new consent are required; old runs stay pinned; rollback works without replay. |
| AC-29 | Later | Scheduled batch | Test downtime, the spring gap and the autumn repeat in an IANA zone. | The stored misfire and DST policy produce deterministic non-empty releases. |
| AC-30 | M4 | Catalog mapping | Submit confirmed, unknown and multi-entity text metadata to a restricted rule. | Confirmed uses the map and vocabulary; others go to review; no image-based identity; no broadcast. |
| AC-31 | M2 | Independent attention channel | Break the worker and create a structural dependency issue. | Needs attention lists both with repair actions without the worker; metrics carry no content. |
| AC-32 | M3 | Pause, resume | Pause a rule with a partial batch, save matching pages, resume. | Admission stops and resumes with a new fence; the partial batch is kept; nothing from the paused interval is backfilled. |
| AC-33 | M3 | Conflict-safe run undo | Apply a run, edit one affected field by hand, undo the run. | Only untouched effects revert; the edited field is kept and listed. |
| AC-34 | M2 | Callback SSRF | Register callbacks on private, mixed-DNS, rebinding, metadata and redirecting hosts. | Verification and every delivery refuse unsafe egress; no COLP credential is forwarded. |
| AC-35 | M2 | Signature and rotation | Sign fixed body bytes; tamper; rotate the secret under concurrent sends. | Authentic signatures verify; tampering fails; rotation stays bounded. |
| AC-36 | M2 | Network crash window | Kill the delivery worker after a remote 2xx and before local acknowledgment. | The same event may be delivered twice; claims and effect receipts prevent a second effect. |
| AC-37 | M2 | Authority revocation | Revoke the agent or the source access while work is queued, leased and about to commit. | Future delivery, read and write stop under fresh checks; already-read data cannot be recalled and is documented as such. |
| AC-38 | M2 | Retention and restore | Expire history and restore a backup with pending attempts. | No silent state loss; the server starts with automation paused; attempts are marked uncertain. |
| AC-39 | M2 | Load and evaluator budgets | Stress many rules, deep predicates, large run-once sets and a slow worker. | Saving stays available; evaluation and queues are bounded; measured capacity is recorded. |
| AC-40 | M1 | Contract and migration drift | Change a schema, example, tool descriptor or generated client; add a migration with a prefix below the current head. | CI catches closed-schema, example, route-catalog, generated-client drift and the out-of-order migration. |
| AC-41 | M1 | Two-minute first rule | From a folder's Automate action, add one condition, preview, enable, as a new user following the shipped docs. | Completed under two minutes without seeing JSON; the rule sentence appears in the list. |
| AC-42 | M1 | Server-side intake | Create a matching bookmark in the web library under a root folder, then one through MCP, then one directly in a specific folder. | The first two are placed by rule with an automation version; the third is untouched; browsers receive projections without new intake. |
| AC-43 | M1 | Why is it here, single undo | Open an automated bookmark; undo one effect; edit a field and undo its effect. | The Automation section lists rule, agent and time; the first undo reverts one effect; the second refuses with an explanation. |
| AC-44 | M1 | Pause all | Turn on Pause all; save matching pages on two browsers; list jobs as a worker; resume. | No admission or local placement after one bundle refresh; workers get paused; resume does not process paused saves; they are listed for run-once. |
| AC-45 | M2 | Polling mode end-to-end | Set a target to poll; run a Claude Code routine and a cron script on the HTTP work API against ready jobs. | Each lists, claims, reads with nodes.get and submits; the note and tags appear with attribution; no write tool was needed; the rule page states the polling interval. |
| AC-46 | M2 | Approvals reuse | Submit results for a Manual agent and a Trusted agent. | Manual waits on Approvals with rule and job named; Trusted commits with a version and Undo; no irreversible plan can be built. |
| AC-47 | M2 | Budget caps hold, never drop | Exceed a rule's daily cap and the server-wide job cap. | Bookmarks are still placed by rule; tasks are held with a visible reason; counts show on the rule page. |
| AC-48 | M3 | Digest landing | Complete a ten-member batch with a digest result. | The digest is readable on the run page with members linked; the Automations page shows an unread count; the extension badge shows it once. |
| AC-49 | M1 | Star dialog folder choice | Star a matching page into Other bookmarks; star another and pick a non-root folder in the dialog. | The first is moved by rule; the second is kept as the Owner's choice. |
| AC-50 | M3 | Run once preview and apply | Run a rule once over an imported folder of 25 matching bookmarks with and without the move-foldered option. | Preview counts match; one manual run with pinned members; effects are undoable; the run never repeats. |
| AC-51 | M2 | Wake mode follows reachability | Open a target on a loopback server, a tls-internal LAN server and a public HTTPS server. | The first two default to poll and state why; the third defaults to events and offers pairing; the Owner can override in both directions and the rule page reflects the mode. |
| AC-52 | M1 | Backup, restore, export include rules | Create rules; run backup.sh, restore.sh on a fresh stack, colp-server export and the web Export menu. | Rules and bindings return; the restored server is paused until resumed; automations.json is present without secrets. |
| AC-53 | M2 | Events wake-up end-to-end | With a target in events mode and a real hosted bot subscribed, save a matching page. | One signed wake-up is delivered within seconds of the job becoming ready; the bot claims, reads with nodes.get and submits; the note and tags appear; a duplicate delivery produces no second effect. |
| AC-54 | M1 | M1-only rule contract | Create m1-rule-create without policy/target | Rule validates, saves and places without querying M2 tables |
| AC-55 | M1 | Canonical-only receipt | Serialize pre-save and corrective-move receipts; inject nativeObservation | Valid receipts join canonical operations; nativeObservation is rejected and summary satisfaction cannot be asserted |
| AC-56 | M1 | Pause cache rollback and offline bound | Install paused settings N, then active N-1; test offline expiry | Older snapshot cannot revive a known pause; disconnected latency is exposed and no model is invoked |
| AC-57 | M1 | Prefix semantics | Compare /docs/a and /other/docs/a with /docs/ | Only the literal prefix matches; contains is not used for startsWith |
| AC-58 | M1 | Manual-intent/receipt race | Delay receipt, make explicit move, then resume ingest | No delayed intake effect overwrites the manual placement |
| AC-59 | M1 | M1 single placement Undo | Select effect ID; repeat after content revision advances | Safe compensation only; stale/unknown prior destination is refused; saved bookmark is never deleted |
| AC-60 | M2 | Worker-only bootstrap and queue enumeration | Pair a worker without manager; list queued jobs via both transports | Only bootstrap pair before binding; authorized list returns deliveryHandle; no manager privilege escalation |
| AC-61 | M2 | Webhook retries versus target health | Retry exact body with later timestamp; return 413 for one item | Fresh timestamp/signature; identical event/body; oversized occurrence terminal without disabling healthy target |
| AC-62 | M2 | No-replay reconnect reconciliation | Lose nonreplayable wake, reconnect, call jobs.list | Durable ready job remains claimable without historical event replay |
| AC-63 | M2 | Plan-commit crash recovery | Crash after canonical commit but before job terminal update | Stable plan/operation identity reconciles receipt; accepted effect not executed twice |
| AC-64 | M3 | Run-once pinned start | Start without preview, change members/options, exceed cap | Shape rejection or stale/over-limit error; no silent re-query/truncation |
| AC-65 | M3 | Count-batch task ownership and concurrency | Replay duplicate 10th event while admitting an 11th | One 10-member batch, one remainder member, no duplicate accepted job |
| AC-66 | M3 | Output pagination/read race | Read through output A while B arrives | A marked read; B remains unread and visible on subsequent page |
| AC-67 | M4 | Portable export authority stripping | Export and reinstall enabled source rule | No live target/collection IDs or secrets; reinstall is draft until rebinding and preview |
| AC-68 | M4 | Research catalog predecessor inputs | Resolve accession then classify with metadata/folderDefinitions | Accepted predecessor evidence available; group destination confined to catalogRoot; ambiguity goes to review |

## 2. Test layers

The shared package has golden normalization, predicate and arbitration fixtures, property tests for distinctness and ordering, and host-equivalence tests (same fixtures in Node and a browser-like runtime). Server unit tests isolate matching, arbitration, health transitions, execution policy and proposal admission with fake clocks. PostgreSQL tests prove transaction, unique-constraint and lease behavior against real storage; a memory sink is not durability evidence.

Browser tests use the real extension lifecycle and native bookmark events under xvfb: popup, shortcut, context-menu and Save-tabs saves, star-button creation, unselected and private mounts, replica rebuild, service-worker suspension and local key loss, in synced and local-only operation.

Contract tests validate the OpenAPI fragment, DTOs, generated clients, route manifest, tool catalogs and Events method fixtures. Integration tests exercise the existing MCP envelope codec and, for M3, a real hosted bot; schema validity alone is never a feature claim.

Fault injection points: before native create; after create before receipt binding; after the canonical resource write before commit; after admission commit before worker acknowledgment; after claim before the worker reads; after the worker's external side effect before submit; after result proposal before approval; during the authority recheck; after a callback 2xx before acceptance persistence.

## 3. Security and scope matrix

Scope names below are proposed automation grants intersected with existing node and collection scopes. They are not added to mandatory COLP scopes.

| Principal and surface | Required grant | Additional constraint |
|---|---|---|
| Owner configuration reads | owner Product session or `automation:read` | current owner namespace; foreign IDs concealed |
| Owner rule, binding, policy writes | owner Product command policy or `automation:manage` | Origin allowlist and `x-csrf-token` on cookie writes; exact revisions |
| Agents page switches, targets, pairing, revoke | ownership, `automation:targets` | existing client binding; one-use code for hosted bots; isolation shown |
| Device bundle and receipts | `automation:device` plus device/replica binding | generation and canonical operation linkage; no cross-device substitution |
| Worker job list, claim, inputs | `automation:work` plus target binding | own target only; no broad queue visibility; bookmark content through ordinary read scopes |
| Submit result | `automation:work` | current lease and input fence; allowed subtree and contract; manual-edit policy; effects built server-side as reversible plans only |
| Approval and Undo | owner command authority and existing agent policy | exact proposal digest and current revisions |
| Events subscription (M2) | `automation:events` plus enabled profile | target binding, verified callback, finite TTL, current authority |

Client-declared flags grant nothing. Model output, page titles and fetched text are untrusted data; a request inside them to change rules, recipients, credentials or permissions is ignored unless it arrives through a separately authorized management command. Encrypt callback credentials with the master key; redact logs and exceptions. Browser local-provider endpoints (possibly private, under user consent) and server callbacks (strict public egress) follow different policies; never reuse the permissive one for callbacks. A general-purpose agent that also holds `nodes:write` is not fenced by the job API; the Agents page shows both facts.

## 4. Matters needing attention

Cross-cutting items that are easy to miss and expensive late. Each names the packet that owns it.

| # | Matter | Owner |
|---|---|---|
| 1 | **Migration ordering.** A prefix below `202610290100` breaks every upgrade (`corrupted migrations`). Use the merge-day prefix; add the CI check. | AW-01, AW-09 |
| 2 | **Reachability and wake mode.** Events wake-up needs a public HTTPS origin; loopback and `tls-internal` servers default to poll. Propose the mode from the origin, say why, allow override. | AW-26 |
| 3 | **Package release order and governance.** The `@know-n/colp` release with the `automation` subpath must be on npm before the extension's lockfile references it; the subpath is exempt from MUST traceability and the source-size budget is raised on purpose. | AW-04 |
| 4 | **Extension compatibility window.** The store extension supports the last two server minors; automation UI appears only when the manifest's edition extension advertises `automation`. | AW-18 |
| 5 | **Star-button flicker.** Native creations land in the default folder and are moved after the settle window; the toast must explain it, and the server must see create+move as one intake. | AW-20, AW-17 |
| 6 | **Explicit versus default folder.** Popup pick, star-dialog non-root folder and web direct-folder create are explicit; roots and remembered defaults are not. One rule, three surfaces. | AW-19, AW-20, AW-33 |
| 7 | **Daily caps hold, never drop.** Placement is free and always happens; only tasks are held. The UI shows the hold. | AW-22 |
| 8 | **Summary attribution and note preservation.** Append below a separator; never replace the Owner's note; Undo removes only the appended block (Q8). | AW-24 |
| 9 | **OpenAPI baseline.** Additive `info.version` bump of `colp-server-v1.yaml` with a new immutable baseline snapshot; `openapi:breaking` must pass. | AW-10 |
| 10 | **Route manifest coverage.** Flag-gated operations join the gate lists so readiness coverage stays honest when a flag is off. | AW-10 |
| 11 | **Outbox route class.** Extending the closed `routeClass` union touches readiness and metrics overlays; keep transient-in-production refusal. | AW-14 |
| 12 | **Frozen write order.** Facts capture extends `CANONICAL_MUTATION_WRITE_ORDER`; its allocator invariants (ordinal +1) must still hold. | AW-13 |
| 13 | **Backup, restore, export, uninstall.** Whole-database dump covers new tables; restore starts paused; `automations.json` in export; "Disconnect server" clears the bundle. | AW-09, AW-44 |
| 14 | **Secrets and the master key.** Subscription secrets (M2) encrypted with `COLP_SERVER_SECRET`; a restore without the same key loses them and must say so. | AW-28, AW-44 |
| 15 | **Worker scopes.** A worker needs `automation:work` plus ordinary read scopes on the collection; no write scope. The Connect guide lists exactly these. | AW-26, AW-32 |
| 16 | **Freshness honesty.** In poll mode latency is the agent's interval, shown on the rule page; in events mode it is seconds plus the agent's own run time. Never show "within a minute" for a poll target. | AW-34 |
| 17 | **i18n.** The extension has `check:i18n`; every new extension string is localized. Web follows its existing practice (Q4). | AW-19, AW-12 |
| 18 | **Playwright under xvfb only; shut dev servers down after packets.** Project rules. | AW-35, AW-46 |
| 19 | **Prompt injection surface.** Page titles and fetched text reach the worker; instructions must come only from the rule; the effect gateway never trusts worker text for anything but the typed output. | AW-24, AW-32 |
| 20 | **Preview truthfulness.** Preview over the last 200 bookmarks uses current rows, not event-time facts; label it "what would happen now". | AW-10 |
| 21 | **Pause propagation.** Global pause reaches extensions within one bundle refresh (5 min); the UI says "within a few minutes on other browsers". | AW-18 |
| 22 | **Audit.** Automation plans appear in the agent's audit log with the rule named (Q9). | AW-24 |
| 23 | **CHANGELOG and INSTALL.** Upgrade notes name migrations and flags; INSTALL documents the reachability matrix. | AW-35 |
| 24 | **Security review before each milestone PR** (`/security-review` on the branch; SSRF, scopes, secrets). | AW-35, AW-46 |

## 5. Operational signals

Metrics: source inspection lag, oldest waiting receipt, oldest waiting job, evaluator failures by reason, rule-stage health counts, held-by-cap count, ready/leased/uncertain jobs, expired claims, result rejection reasons, undo conflicts, delivery retries and dead letters (M3), subscription expirations (M3). Labels are low-cardinality (stage, profile, adapter, reason). Owner UI may show rule detail; shared logs and metrics never contain URLs, titles, folder names, rule text, secrets or entities.

Alert on sustained backlog or failure rises against measured baselines. No matches with no eligible activity is not an alert.

## 6. Runbooks

### A rule matched but nothing happened
Open the bookmark's Automation section. "Rule blocked: folder deleted" → Restore or Choose another. "Explicit choice" → the Owner picked a folder. "Paused" → resume, then run once if needed. "Conflict" → set priorities. No entry at all → check the bundle age in the extension's Options (expired bundle fails closed) and the server's `/ready` automation readiness.

### A worker never picks up jobs
Agents page: is "Can run automation jobs" on and has the agent been seen since? Does the agent list the `automation.jobs.*` tools (profile) and hold read scopes on the collection? Is the server paused (workers receive `automation_paused`)? Is the daily cap holding tasks? For a scheduled worker, is the schedule running at all?

### Deleted or moved binding
Find the incident; confirm the original identity and required subtree; offer restore or explicit rebind; preview the semantic change and the affected pending jobs; commit the binding revision; revalidate. No replay unless the Owner runs once on the listed bookmarks.

### An agent in events mode is never woken (M2)
Check the origin: loopback or private → events cannot work; switch the target to poll. Public → callback verification record, egress classification of the callback URL, subscription state and `refreshBefore`; is the target still in events mode? Never copy a callback from another target by hand.

### Repeated callback failures (M2)
Inspect redacted reason, status and queue age. 410/413 stop retries for that path. Transient failures back off; never mint new event IDs to force duplicate work.

### Unknown worker outcome
Mark the attempt uncertain; keep correlation; no fallback and no second paid call; reconcile from evidence or ask the Owner to retry. Effect deduplication still applies.

### Incorrect placement or tag
Let the Owner move or edit; record the manual decision and, with consent, a scoped negative example; inspect which rule, contract, input and worker produced it; change the rule only through preview. A confidence score never overrules the Owner.

### Restore or rollback
Stop admission and delivery; preserve configuration and ledger tables; restore with the server paused; refresh authority and subscriptions; mark external attempts uncertain; resume for the Owner after inspection. Never reset Outbox completion markers as a generic step.

## 7. Rollout flags

Flags follow the host convention `KNOWN_FEATURE_*` (R26): `KNOWN_FEATURE_AUTOMATION_RULES` (M1 API and UI), `KNOWN_FEATURE_AUTOMATION_CAPTURE` (facts, shadow first), `KNOWN_FEATURE_AUTOMATION_ADMISSION` (runs), `KNOWN_FEATURE_AUTOMATION_WORK` (M2 worker surface), `KNOWN_FEATURE_MCP_EVENTS` (M2), `KNOWN_FEATURE_AUTOMATION_TEMPLATES` (M4), `KNOWN_FEATURE_AUTOMATION_SCHEDULES` (Later). The self-hosted preset turns M1 flags on once M1 ships; later flags default off until their milestone. Bundles carry their runtime profile and the pause flag separately.

Order: capture in shadow mode → preview without effects → deterministic intake for the Owner → runs and server-side intake → worker surface for one agent in poll mode → events wake-up for one target → trusted commit → controlled expansion. A flag that is off has documented behavior: no capability advertisement, no admission, held pending effects. Disabling Events never disables local rules. A kill switch cannot recall events already accepted by a remote host; job authorization still prevents writes.

## 8. Release checklist

M1: AC-01, 02, 04, 07–15, 26, 40–44, 49, 52 with xvfb browser evidence; migrations ordered; backup/restore/export verified; CHANGELOG upgrade notes; `openapi:ci`, `runtime:manifest:check`, server and web unit suites, extension `typecheck`, `test`, `check:i18n` green.

M2: all M1 plus AC-03, 05, 06, 16–19, 23–25, 31, 34–39, 45–47, 51, 53; worked narrative captured with a real hosted bot on a public origin and a polling agent; security review; both agent guides verified by a new user.

M3: AC-20, 21, 32, 33, 48, 50 for batches and run-once. M4 and Later advertise each capability only after its own tests.

Do not call a release complete because schemas parse, a webhook returned 200 or a model said it finished. Verify the intended bookmark state and its effect receipt.

---

<!-- Source chapter: 08-evidence-and-decisions.md -->

# Evidence Register, Design Decisions, Gates and Open Questions

**Review date:** 2026-10-12. **Version:** 0.2.1-design. Repository facts are inspected source evidence; proposed modules, tables, APIs, limits and policies elsewhere in this pack are design decisions. No server, browser integration or hosted-bot lifecycle was executed to produce these documents. The two external references W01 and W02 were re-read on the review date.

## Repository evidence (inherited baseline register; review status below)

| ID | Inspected source | Established fact |
|---|---|---|
| R01 | COLP `main` at `2ee8397` (2026-10-12) | Current reviewed COLP baseline (previous pack: `09334ab`) |
| R02 | Know-N at `28acb4965` (2026-10-12) | Current reviewed extension baseline (previous: `3cbb670`); private repository |
| R03 | `packages/server/src/modules/collections/application/canonical-mutation.ts` | Frozen `CANONICAL_MUTATION_WRITE_ORDER` ending in `outbox`; ordinal advances by exactly one under the collection lock |
| R04 | `packages/server/src/infrastructure/outbox/router.ts` | `handlerMode` `projection_latest_only` / `delivery_each_event`; `sideEffectDurability`; closed `routeClass` union (`projection`, `publication_cache_purge`, `report_public_surface_purge`); transient routes refused in production |
| R05 | `packages/server/src/infrastructure/outbox/mcp-change-signal-sink.ts` | Post-projection best-effort resource hints |
| R06 | `packages/node/src/shared/mcp-sdk-boundary.ts` | Pinned SDK imports, schema allowlist, protocol `2026-07-28` |
| R07 | `packages/server/src/modules/mcp/agent-plan-policy.ts` | `manual`/`trusted` per agent; reversible set `create_node, update_node, move_node, reorder, reorder_children, create_annotation, update_annotation`; version captured per committed plan |
| R08 | `Known-Extension/src/save-entry.ts` | Every popup, shortcut, context-menu and window-tab save creates a native bookmark through one path with a reserved placement intent (`bookmark-create-placement`) |
| R09 | `Known-Extension/src/classification-local-preview.ts` | Folder and tags requested separately (`requested: {folder, tags}`); foreground-only; spent command markers in session storage; Cloudflare Jev provider |
| R10 | `Known-Extension/src/classification-local-session.ts` | Local key in `storage.local`; missing key or grant never selects cloud |
| R11 | `packages/server/openapi/colp-server-v1.yaml` | OpenAPI 3.1.0 Product surface, 16k lines, separate from COLP and MCP |
| R12 | `packages/server/package.json` | `openapi:lint`, `openapi:catalog`, `openapi:examples`, `openapi:generate`, `openapi:drift`, `openapi:breaking`, `openapi:ci`, `runtime:manifest:check`, `check:imports`, `test:unit`, `test:integration:file` |
| R13 | `packages/server/src/transport/product-error.ts`, `product-codes.ts` | Closed `error` envelope with `recovery`, `precondition`, `currentEtag`, `fieldErrors`; closed code registry |
| R14 | `packages/server/src/infrastructure/egress/hardened-egress.ts` | DNS/IP classification, pinned connection, explicit redirect policy |
| R15 | `Known-Extension/src/bookmark-node-identity.ts` | Native/COLP identity separation with generation checks |
| R16 | `packages/server/src/modules/mcp/application-context.ts`, `application-catalog.ts` | Principal, client, binding and scopes boundary; descriptor-based tool catalog; `compatOnly` surface |
| R17 | `packages/server/src/infrastructure/outbox/collection-mutation-events.ts` | Closed node event payloads; creation v1 lacks full URL and ancestry facts |
| R18 | `Known-Extension/src/generated/classification/index.ts` | Backend-generated policy sharing already exists |
| R19 | `packages/server/src/transport/product-route-manifest.ts` | `CLASSIFICATION_PRUNED_OPERATION_IDS`: server classification runs, provider profiles, classify inbox and credits are pruned in the self-hosted edition; BYOK profile routes hard-gated by `KNOWN_FEATURE_CLASSIFICATION_BYOK` |
| R20 | `~/known/colp-server/03-decisions.md` D8, D28(b)(d) | Trusted mode auto-approves reversible plans with a version and Undo; policy keyed `(principal_id, client_id)`; Undo refuses when the content revision moved |
| R21 | `Known-Extension/src/bookmark-event-ingress.ts`, `bookmark-event-create-placement.ts` | Observed creations are classified against mounts, privacy and placement intents; unproven identity freezes recovery instead of guessing |
| R22 | `Known-Extension/src/capture/contracts.ts`, `capture/automatic.ts`, `sw/capture.ts` | Durable `CaptureTask` with `automaticIntent`, `manualFence`, `classification` state, `local` automatic intent with a spent `commandId`; periodic alarm recovers after crash |
| R23 | `packages/server/src/transport/session-cookie.ts`, `transport/auth/origin-csrf.ts`, `bootstrap/config-http-security.ts` | Cookie `__Host-known_session` (TLS) or `known_session` (acknowledged plain HTTP); `requireAllowedOrigin` plus `x-csrf-token` on cookie writes; `Known-Command-Id` header |
| R24 | `packages/server/openapi/README.md`, `openapi/fragments/`, `packages/web/scripts/generate-openapi-types.mjs` | Fragments are bundled into `colp-server-v1.yaml`; the web generates `src/generated/colp-server-v1.ts` from the bundle; baselines and breaking checks govern changes |
| R25 | `packages/server/migrations/README.md`, `migrations.ts`, directory listing | Kysely `FileMigrationProvider`, sortable UTC prefix, forward-only; current head `202610290100_link_preview_object_bytes.ts`; out-of-order names fail with `corrupted migrations` |
| R26 | `packages/server/src/bootstrap/config.ts`, `deploy/.env.example` | Flags are `KNOWN_FEATURE_*`; operator variables are `COLP_*` (`COLP_SERVER_ORIGIN`, `COLP_SERVER_SECRET`, `COLP_INSECURE_HTTP`) |
| R27 | `packages/web/src/App.tsx`, `pages/`, `api/`, `components/` | React 19 + react-router 7; routes `/agents`, `/approvals`, `/r/:id`, `/library/*`; `pages/Agents.tsx` has per-agent Manual/Trusted policy; `WriteApprovals.tsx` has Undo; no `features/` tree |

## External primary references

| ID | Source | Scope used | Re-read |
|---|---|---|---|
| W01 | [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) | Protocol `2026-07-28`; `events/list`, `events/subscribe`, `events/unsubscribe`; available in Work chats and with dots; HTTPS public callbacks, signed challenge, `-32015`; Standard Webhooks headers plus `X-MCP-Subscription-Id`; `whsec_` 24–64 bytes; 256 KiB; 410/413 not retried; no polling or streaming; replay only for replayable events | 2026-10-13 (this review) |
| W02 | [MCP Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md) | Draft dated 2026-02-19; identity `(principal, url, name, arguments)`; provisional error codes; poll and stream modes not adopted by W01 | 2026-10-13 (this review) |
| W03 | [Chrome MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) | Remote-code and interpreted-logic constraints | |
| W04 | [CEL overview](https://cel.dev/overview/cel-overview) | Typed environment, parse/check/evaluate | |
| W05 | [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) | Signature and header conventions | |
| W06 | [Node VM](https://nodejs.org/api/vm.html) | Not a security boundary | |
| W07 | [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html) | Document structure | |
| W08 | [CEL-ES](https://github.com/bufbuild/cel-es/blob/main/README.md) | Candidate implementation, unverified | |

## Accepted design decisions

| ADR | Decision | Rejected alternative |
|---|---|---|
| ADR-A01 | Shared pure rule core with separate host adapters | Two rule languages |
| ADR-A02 | Versioned role bindings by identity, never executable folder names | Auto-rebind by label |
| ADR-A03 | Task-specific satisfaction and typed output contracts | One "AI processed" boolean |
| ADR-A04 | Private facts plus each-event durable admission | Counting resource refresh hints |
| ADR-A05 | Explicit data destination and fallback approval | Silent cloud fallback |
| ADR-A06 | Pin run versions and member identities | Query newest N at execution |
| ADR-A07 | Opt-in connection catalogs plus call-time authorization | Global tools or client-name detection |
| ADR-A08 | Logical inbox distinct from OAuth client; shared-credential limitation stated | Treat a callback or name as a principal |
| ADR-A09 | Reference-only events plus claims and an effect gateway | Instructions and write credentials in payloads |
| ADR-A10 | Finite browser profile, bounded server CEL (M4) | Downloaded browser scripts |
| ADR-A11 | Source and transport contracts separate | JSON-RPC methods modeled as REST |
| ADR-A12 | Owner-scoped v1, optional protocol capabilities | Mandatory automation for every COLP implementation |
| ADR-A13 (revised 2026-10-12, owner decision) | MCP Events is the primary hosted-worker wake-up in M2; polling is a per-target mode for a worker with verified network access; readiness is backend-derived; the worker contract (list, claim, submit) is identical in both modes | Pull-only M2 with Events deferred; Events as the only path |
| ADR-A14 (new) | Agent-requested canonical effects use plans with cause `automation:…` and existing policy/approval/version machinery; M1 placement is Owner-authorized and run-level text is not a canonical mutation | A parallel approval and undo system |
| ADR-A15 (new) | M1 ships rules and folder bindings only; execution policy is created in M2 and absent means "no model calls, no fallback"; the web editor is one form that owns the rule's binding set | Four independently edited resources in the UI |
| ADR-A16 (new) | JSON is the only accepted authoring and storage format; no YAML on the server | YAML authoring with import validation |
| ADR-A17 (new) | Star-button creations: settle window 3 s; a bookmark-root parent is an unsorted heuristic only; known explicit choice, manual fences and later moves always win; unknown input is not forcibly moved | Treat every native folder as explicit, or none |
| ADR-A18 (new) | Digests and reviews are run-level texts shown on the run page and in a Digests list; summaries go to the bookmark note with attribution; no node is created for a digest | Create a bookmark or folder per digest |
| ADR-A19 (new) | `inputFields` name bookmark fields COLP holds (`description`, `note`, no `abstract`); workers fetch pages under their own permissions and declare it in evidence | A server-side page fetcher per task |
| ADR-A20 (new) | Story IDs `AU-xx`, task IDs `AW-xx`, test IDs `AC-xx` to avoid collision with the product plan's `US-xx` and lane tasks | Reuse `US`/`A-` prefixes |
| ADR-A21 (new) | Global pause above rule state; restore starts paused; daily caps hold tasks and never drop placement | Per-rule pause only; caps that drop |
| ADR-A22 (new) | Server intake requires verified command/receipt disposition after any receipt grace period; timeout alone grants no placement authority; imports/restores/unknown intent are not automatically moved | Browser-only rules |
| ADR-A23 (new, owner decision 2026-10-12) | The shared automation core is the `automation` subpath of the existing `@know-n/colp` package, marked optional and outside conformance | A new `@know-n/colp-automation` package |

## Release gates

| Gate | Statement | State |
|---|---|---|
| G1 | The pinned SDK represents `events` capability without schema stripping; a real lifecycle test exists before any compatibility claim | open, AW-02 before hosted Events compatibility claims; not a local M1/polling blocker |
| G2 | Session cookie, CSRF header, error codes, route manifest and CORS bound to the active version | resolved on 2026-10-12 (R23); re-verify at AW-01 |
| G3 | Two logical targets pair and correlate in real host tool calls; shared OAuth credentials give no isolation | open, AW-02 before hosted Events compatibility claims; not a local M1/polling blocker |
| G4 | Browser-store acceptability of the finite rule profile | open, M0 (AW-03) |
| G5 | Local receipts join canonical Sync operations without touching closed wire schemas | open, M1 (AW-17) |
| G6 | Evaluator, Outbox and job workloads measured before raising limits | open, M2 (AW-44) |
| G7 | Background browser inference has its own lifecycle and consent | open, Later (AW-62) |
| G8 (new) | The proposed wake mode follows reachability: direct-public HTTPS is the selected v1 hosted topology; callbacks/host access verified separately, poll requires a reachable worker; the UI renders backend reasons and cannot override security | open, M2 (AW-26) |
| G9 (new) | Automation migrations sort after the current head; CI refuses out-of-order names | open, M0 (AW-01) |
| G10 (new) | The `@know-n/colp` release carrying the `automation` subpath lands before the extension's lockfile changes | open, M1 (AW-04) |

## Open questions (decide at the named gate)

| Q | Question | Default if undecided | Decide by |
|---|---|---|---|
| Q1 | Decided 2026-10-12 by the owner: the core is the `automation` subpath of `@know-n/colp` (ADR-A23). Remaining detail: how `check:traceability`, `check:protocol` and `check:source-size` exempt the module | Document the exemption in `packages/node/docs/API.md`; raise the size budget deliberately | AW-04 |
| Q2 | Settle window for star-button creations: Fixed 3 s observation window, or another tested policy? No native-dialog-close signal is assumed. | 3 s | AW-20 |
| Q3 | Where does a worker running on the Owner's machine get the API key: the Agents page key issuance as today? | Yes; no new credential type | AW-32 |
| Q4 | Does the web have an i18n layer the new pages must use, or English only like the current pages? | Follow the existing pages | AW-12 |
| Q5 | Should run-once be offered in M1 (placement only, no tasks) since imports are an M1 pain point? | Keep in M3; M1 preview covers "what would happen" | AW-12 review |
| Q6 | Can the Go `known` CLI act as a polling worker, or is it a script-only path until the CLI ships for COLP Server? | A hosted bot proves events mode; a script and a Claude Code routine prove poll mode; CLI optional | AW-32 |
| Q7 | Local-only rules without a server (extension users who never connect)? | Out of scope; bundle format must allow local authoring later | after M2 |
| Q8 | Attribution format for summaries in the note ("Summary by Research, 12 Oct") and whether the note's existing text is preserved above or below | Append below a separator; never replace | AW-24 |
| Q9 | Are automation plans counted in the agent's audit log (`/api/v1/me/agents/:id/audit`) as the agent's actions? | Yes, with the rule named | AW-24 |

## Review provenance — 2026-10-13

The uploaded revised pack is the design authority. The supplied ChatGPT share link did not expose a readable conversation body during this review; no claim in this revision relies on reconstructing that conversation. The local product-plan repository `~/known/colp-server` was not supplied. Its D-numbered decisions and R20 assertions are inherited context, not independently verified facts here.

| Evidence group | This review actually checked | Limit |
|---|---|---|
| R01 | COLP commit `2ee8397cc20008e7865f2a080c91be2d38d323ae` exists | No rebase to current main; implementation must compare its own checkout |
| R03 | `packages/server/src/modules/collections/application/canonical-mutation.ts` at that commit | Frozen order ends audit → outbox; private facts are a proposed extension, absent in the inspected file |
| R06 | `packages/node/src/shared/mcp-sdk-boundary.ts` at that commit | Core pin 2.3.1, protocol 2026-07-28, explicit schema boundary; Events production compatibility is not established |
| R07 | `packages/server/src/modules/mcp/agent-plan-policy.ts`, including Undo implementation, at that commit | Existing manual/trusted policy and collection-version/content fences verified; field-level selective Undo is not an existing capability claim. Existing force restore is NOT exposed by automation |
| R09 | `Known-Extension/src/classification-local-preview.ts` at `28acb4965` | Foreground gesture requirement and separate folder/tags requests verified; this is not a background worker |
| W01, W02, W09, W10 | Primary provider/profile/draft documents | Platform documentation, not a live COLP/host integration test |
| Remaining R entries; W03–W08 | Retained original baseline references | Not independently re-read as a complete set in this review; AW-01 rechecks exact assumptions before coding |

Additional primary references: **W09** [OpenAI Meet dots](https://learn.chatgpt.com/docs/dots), reviewed 2026-10-13; defines the cloud-agent surface and rollout/permission caveats. **W10** [OpenAI MCP connectivity guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), reviewed 2026-10-13; private/tunnel connectivity exists in other MCP integrations, but Events through that topology is not verified by this pack.

Direct repository references for the checked files: [canonical mutation](https://github.com/WhitenWhiten/colp/blob/2ee8397cc20008e7865f2a080c91be2d38d323ae/packages/server/src/modules/collections/application/canonical-mutation.ts), [SDK boundary](https://github.com/WhitenWhiten/colp/blob/2ee8397cc20008e7865f2a080c91be2d38d323ae/packages/node/src/shared/mcp-sdk-boundary.ts), [agent plans and Undo](https://github.com/WhitenWhiten/colp/blob/2ee8397cc20008e7865f2a080c91be2d38d323ae/packages/server/src/modules/mcp/agent-plan-policy.ts), [foreground classification](https://github.com/WhitenWhiten/Know-N/blob/28acb4965/Known-Extension/src/classification-local-preview.ts) (private repository access required).

No actual database crash test, browser lifecycle, model call, live subscription, callback or dot run was performed during this artifact review. Every AC test remains planned_not_executed. The validation reports describe only checks executed against this document pack.

---

<!-- Source chapter: 09-data-model.md -->

# Persistence, Transactions and State Machines

**Status:** proposed PostgreSQL design. **Version:** 0.2.1-design. Table names are new. JSONB holds versioned closed documents and never excuses missing integrity checks. Tables are introduced by milestone; a later milestone's tables are not created early "for convenience", so that a server that stops at M1 carries no dead schema.

## 0. Migration naming (G9)

Migrations are Kysely files with a sortable UTC prefix (R25). The head at design time is `202610290100_link_preview_object_bytes.ts`. An automation migration named with a smaller prefix would sort before an already-applied file and fail the next upgrade with `corrupted migrations`. Rule: use the merge-day UTC prefix, confirm it sorts after the newest file in `packages/server/migrations/` at merge time, and add the CI check from AW-01. Forward-only, expand-contract, as `migrations/README.md` requires.

## 1. Table inventory by milestone

All account-owned keys include the owner identity in queries and authorization. Database constraints complement application authorization.

### M1

| Table | Essential columns | Constraints and indexes |
|---|---|---|
| `automation_settings` | owner_id, paused, paused_at, paused_by, revision | one row per owner; read on every admission and bundle compile |
| `automation_rules` | id, owner_id, current_revision_id, desired_state, created_at, updated_at | owner/state index; current revision FK |
| `automation_rule_revisions` | id, rule_id, revision, definition_json, semantic_digest, created_at | unique(rule_id, revision); immutable |
| `automation_binding_sets` | id, owner_id, rule_id (nullable for shared sets), current_revision, name | owner index |
| `automation_binding_revisions` | binding_set_id, revision, values_json, semantic_digest | unique(binding_set_id, revision) |
| `automation_dependencies` | rule_revision_id, role, resource_kind, resource_id, dependency_revision, stage | reverse lookup (resource_kind, resource_id); ancestor closure |
| `automation_incidents` | id, owner_id, rule_id, dependency_key, code, revision, severity, state, first_seen, last_seen | unique active (dependency_key, code, revision) |
| `automation_event_facts` | source_event_id, operation_id, collection_id, node_id, commit_ordinal, occurred_at, origin, facts_json, facts_version, root_run_id | unique source_event_id; (collection_id, commit_ordinal) index; private |
| `automation_intake_receipts` | id, owner_id, device_id, replica_generation, local_receipt_id, operation_id, state, receipt_json | unique(device_id, replica_generation, local_receipt_id); operation/state index |
| `automation_source_positions` | owner_id, collection_id, last_inspected_ordinal | unique(owner_id, collection_id); advanced only after durable admission |
| `automation_activations` | rule_revision_id, collection_id, after_ordinal, disabled_after_ordinal, aggregate_epoch | unique rule/collection/activation generation |
| `automation_admission_receipts` | rule_revision_id, source_event_id, stage, decision, run_id | unique(rule_revision_id, source_event_id, stage) |
| `automation_aggregate_state` | rule_revision_id, epoch, partition_key, sequence, remainder_json | unique(revision, epoch, partition); locked before member changes (used by M3 batches; created in M1 because admission writes it) |
| `automation_runs` | id, kind (`intake`, `batch`, `manual`), rule_revision_id, binding_revision, policy_revision (nullable in M1), member_ids, state, created_at | owner/time/id index |
| `automation_jobs` | id, run_id, task_id, target_id (nullable), input_digest, contract_id, state, active_generation, result_id | unique(run_id, task_id, target_partition); ready-queue index |
| `automation_effect_receipts` | id, run_id, job_id (nullable for M1 placement), step_id, target_partition, plan_id (nullable for M1), operation_id, before_folder, before_revision, after_revision, effect_digest | unique(run_id, step_id, target_partition) with a non-null normalized partition; canonical operation linkage plus idempotent plan reconciliation; never rely on SQL NULL uniqueness |
| `automation_device_bundles` | owner_id, device_id, revision, profile, digest, issued_at, expires_at, paused, settings_revision, status | current bundle index |
| `automation_preview_records` | id, owner_id, config_digest, result_json, expires_at | expiry index |
| `automation_tag_rejections` | owner_id, rule_id, tag_key, rejected_at | unique(rule_id, tag_key) |

### M2

| Table | Essential columns | Constraints and indexes |
|---|---|---|
| `automation_execution_policies` | id, owner_id, current_revision | owner index |
| `automation_execution_policy_revisions` | policy_id, revision, configuration_json | unique(policy_id, revision) |
| `automation_connection_profiles` | id, owner_id, client_id, credential_binding_id, catalogs_json, enabled, revision | unique owner/binding/profile identity; mirrors the Agents page switches |
| `automation_targets` | id, owner_id, connection_profile_id, name, wake_mode (`events`, `poll`), poll_interval_minutes, pairing_generation, privacy, broadcast_opt_in, state, last_seen_at | eligible target index |
| `automation_executors` | id, owner_id, kind, target_id (nullable), config_json, verified_capabilities, credential_ref, revision | created with a target; credential_ref never plaintext |
| `automation_job_attempts` | job_id, generation, executor_id, claim_token_hash, lease_until, outcome, provider_request_ref | unique(job_id, generation); live lease index |
| `automation_results` | id, job_id, generation, input_digest, output_json, proposal_digest, status | one accepted result per job/input/contract |
| `automation_usage_counters` | owner_id, rule_id, target_id, day, runs, jobs, calls | unique(rule_id, target_id, day) |
| `automation_pairings` | id, target_id, code_hash, expires_at, consumed_at | single-use atomic consumption; short retention |
| `automation_subscriptions` | id, owner_id, target_id, identity_digest, event_name, canonical_arguments, encrypted_url, encrypted_secret, secret_generation, state, refresh_before | unique(identity_digest); one active per target/event by default |
| `automation_deliveries` | id (event_id), job_id, target_id, subscription_id, body_bytes_or_ref, generation, state, next_attempt_at | unique(job_id, target_id, subscription_generation, occurrence_kind); due index; rows exist only for targets in events mode |

### M3

| Table | Essential columns | Constraints and indexes |
|---|---|---|
| `automation_run_outputs` | id, run_id, job_id, target_id, result_id, text_json, created_at | unique(result_id); stable run/created_at/id index |
| `automation_digest_reads` | owner_id, run_id, through_output_id, read_at | unread count for the Digests list |

### M4

| Table | Essential columns | Constraints and indexes |
|---|---|---|
| `automation_templates` | id, owner_id, publisher, template_key, version, digest, package_json, review_state | unique publisher/key/version/digest; no private bindings |

Existing tables reused, never duplicated: command receipts, canonical operations and audit, change plans and collection versions (R07), agent policy rows (R20), the master-key encryption path.

## 2. Transaction A: capture committed facts

The verified baseline order is collection-lock → canonical-plan → allocation → resource → operation → audit → outbox. The proposed extension inserts private facts after audit and before outbox, using source event identity allocated within the transaction. Before-state is taken from locked planning inputs before mutation; after-state comes from the resulting plan/rows. Static Outbox scheduling remains last. A rollback removes all of them. No HTTP, no evaluation of user predicates, no model call while collection locks are held. Facts come from the plan and rows already in hand.

An event's after-URL, parent and ancestry are event-time values. For large subtrees capture a versioned ancestry reference, not the tree.

## 3. Transaction B: admit and aggregate

```text
begin
  lock source-position row and applicable admission partition in canonical order
  capture a stable committed high-water ordinal
  if globally paused:
    record/advance inspected and skipped-admission fence through high-water
    commit; stop (no admitted run, model task or delivery)
  for eligible source facts after the active rule fence:
    verify current authority and server-derived intake disposition
    insert unique admission receipt; duplicates perform no new action
    each: create one pinned intake run, with verified placement effect if any
    M3 countBatch: lock revision/epoch/partition; append distinct member;
      remove exactly N ordered members for each run; persist remainder
    M2+ only: instantiate permitted task DAG, policy/budget state and recipients
      transition dependency-ready jobs to ready; persist wake scheduling atomically
  advance inspected source ordinal through irrelevant operations too
commit
```

M1 never reads/writes execution-policy, usage-counter, subscription or delivery tables. Deterministic placement is not dropped by worker cost caps. A rule/global resume fences out the paused interval at a fresh committed high-water; it does not accidentally replay skipped bookmarks. Pending jobs from before pause retain pins and are separately held/cancelled/resumed under the chosen lifecycle policy. New source facts after resume are not lost behind an older inspection cursor.

Pure matching may run outside the lock only when all inputs and versions are pinned and revalidated before committing the decision. A failing evaluator marks that rule blocked; source inspection records a recoverable diagnostic and other rules proceed.

## 4. Transaction C: claim (M2)

Select a ready job for the authenticated target. If an unexpired claimant exists, return conflict. Otherwise increase generation, store a fresh token hash and return the token once with the lease. Heartbeats need the same token and generation plus current authority. Generation is a fencing token. At expiry, distinguish "no known external side effect" from uncertain progress; only a safe retry or an explicit Owner retry reassigns.

## 5. Durable result/plan orchestration (M2)

The existing plan coordinator is not assumed to accept an outer job transaction. Validate a typed proposal, then persist job generation, input/proposal digest, stable plan command identity and `committing` state. Recheck current authority, resource/content revisions and the allowed subtree when planning and again when committing. Manual policy yields `awaitingApproval`; trusted policy follows the existing reversible-plan path.

Call the existing idempotent plan/commit coordinator outside the job lock. Link its canonical operation/version to the effect receipt in a separate short idempotent transaction and mark the job succeeded only after that linkage is durable. A crash after canonical commit but before job completion is recovered by looking up the SAME plan/operation/command, not by executing another effect. A missing or ambiguous commit outcome remains committing/uncertain until reconciled. Any future same-transaction receipt hook needs explicit source verification and a separate contract change; it is not presumed here.

One undoable effect corresponds to one isolated reversible plan unit; multi-step jobs checkpoint effect IDs and remain partial until required steps finish. Metadata-only results and run-level digest/review text are accepted results without fake canonical mutation plans. M1 placement receipts/compensation are the separate Owner-authorized path described in AW-51, not a dummy worker job.

## 6. Transaction E: callback delivery (M2)

A delivery worker leases in a short transaction, rechecks authority, pause and expiry, signs the fixed body and sends outside locks, then records accepted or failed only if it still owns the generation. Never write accepted before sending; never mark a job succeeded because a callback returned 200; never hold a transaction open while a bot runs.

## 7. State transitions

```text
Server:          paused <-> running (automation_settings)
Rule desired:    draft -> enabled <-> paused -> archived
Rule effective:  draft | active | degraded | blocked | paused | archived
Receipt:         waitingForSync -> accepted | review | rejected
Run:             waiting -> running -> completed | partial | review | blocked | cancelled | failed
Job:             pending -> ready -> leased -> committing -> succeeded
                                  |         -> awaitingApproval -> succeeded | cancelled
                                  |         -> uncertain -> ready (explicitly safe) | blocked
                                  |         -> failed | stale | review
Delivery (M2):   pending -> sending -> accepted
                          |        -> retrying -> sending
                          |        -> deadLetter | cancelled | awaitingSubscription
Incident:        open -> acknowledged -> resolved (by revalidation only)
```

Desired state and observed health are independent. No transition from acknowledged to resolved without a passing revalidation.

## 8. Retention, erasure and replay

Never purge unfinished members or active job inputs behind a retention default; when they must expire, create an incident and a terminal record. Historical replay (Later) requires retained facts or declares incomplete coverage. Delete credentials and callback secrets promptly on revocation. Account erasure removes private content; compact tombstones stay only where the product policy permits.

Backups are whole-database dumps (`deploy/backup.sh`); encrypted secrets need the same `COLP_SERVER_SECRET` on restore. A restored server starts with `automation_settings.paused = true`, revalidates bindings and subscriptions, and marks in-flight attempts uncertain.

## 9. Migration sequence

Create tables and indexes first; add nullable source linkage and facts capture behind `KNOWN_FEATURE_AUTOMATION_CAPTURE`; deploy readers before producers; enable capture in shadow mode; verify no missed operation paths against canonical source events; then enable admission for the Owner. No automatic migration of historical bookmarks into runs: run-once is the explicit path. Consumers accept explicitly supported facts versions; old versions yield `missingInput`, not invented metadata. Disable admission and delivery before rolling back code that cannot read current jobs; keep tables during rollback until in-flight work drains.

## 10. Identity and recovery constraints

Normalize nullable target partitions to an explicit sentinel for uniqueness; PostgreSQL NULL values must not permit duplicate M1 effects. Poll and Events workers use the same job handles independent of delivery rows. Source and task digests bind canonical IDs, relevant revisions, input field selection and accepted predecessor outputs. Access lost after admission means unavailable/review, never an authority snapshot that grants future access. An Owner read marker references the final output actually viewed, not a wall-clock time that can swallow a concurrent unread result.

---

<!-- Source chapter: 10-module-file-map.md -->

# Module and File Map

**Version:** 0.2.1-design. Generated from [tasks.json](tasks.json) by `validation/build-docs.py`: every file a packet creates or modifies, with the packet and milestone. Paths under `Known-Extension/` are in the private Know-N repository (EXTENSION_REPO); server/shared/Web paths are in COLP_REPO. State is a recorded baseline claim or verifyAtAW01; absence of a local checkout during documentation generation must never be reported as proof a file is new. Migration prefixes are placeholders resolved at merge time (data model §0).

## Files by repository

### Know-N (private)

| Path | Packets | Milestones | State |
|---|---|---|---|
| `Known-Extension/e2e/automation.spec.ts` | AW-56 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/package-lock.json` | AW-49 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/binding-projector.ts` | AW-49 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/bundle-store.ts` | AW-49 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/causation.ts` | AW-20 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/executors/browser-classifier.ts` | AW-62 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/indexeddb-store.ts` | AW-21 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/model-consent.ts` | AW-62 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/observed-create.ts` | AW-20 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/pre-save.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/receipt-sync.ts` | AW-50 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/recovery.ts` | AW-21 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/runtime-profile.ts` | AW-49 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/automation/status-ui.ts` | AW-54, AW-60 | M2, M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/bookmark-event-ingress.ts` | AW-20 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/capture/contracts.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/classification-intent.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/popup-classification.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/save-status.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/service-worker.ts` | AW-21 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `Known-Extension/src/sw/capture.ts` | AW-19 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |

### colp (public)

| Path | Packets | Milestones | State |
|---|---|---|---|
| `deploy/backup.sh` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `deploy/restore.sh` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/README.md` | AW-01 | M0 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/agents.md` | AW-32 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/evidence/events-lifecycle.md` | AW-46 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/evidence/events-spike.md` | AW-02 | M0 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/m1-release-evidence.md` | AW-63 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `docs/automation/release-evidence.md` | AW-35 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `examples/worker-script/claim-and-summarize.mjs` | AW-32 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/docs/API.md` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/docs/AUTOMATION_BROWSER_PROFILE.md` | AW-03 | M0 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/docs/MCP_SDK_POLICY.md` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/package.json` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/arbitrate.ts` | AW-07 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/compile.ts` | AW-06 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/entity-map.ts` | AW-61 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/fingerprint.ts` | AW-05 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/index.ts` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/normalize.ts` | AW-05 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/predicate.ts` | AW-06 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/schema.ts` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/semantic-diff.ts` | AW-61 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/task-contracts.ts` | AW-07 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/template.ts` | AW-61 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/types.ts` | AW-04 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/automation/validate-graph.ts` | AW-07 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/mcp/2026-07-28/events-schema.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/mcp/2026-07-28/events.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/src/shared/mcp-sdk-boundary.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/tests/automation/normalization.test.ts` | AW-05 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/tests/automation/predicate.test.ts` | AW-06 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/node/tests/mcp/automation-events-contract.test.ts` | AW-02 | M0 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_configuration.ts` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_deliveries.ts` | AW-29 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_policy_and_attempts.ts` | AW-22 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_subscriptions.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m2_targets_and_profiles.ts` | AW-26 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m3_batches.ts` | AW-57 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m3_outputs.ts` | AW-58 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m4_entity_maps.ts` | AW-39 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_m4_templates.ts` | AW-36 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/migrations/<monotonic-prefix-after-current-head>_automation_runtime.ts` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/openapi/fragments/automations.yaml` | AW-10 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/aggregate-store.ts` | AW-15, AW-57 | M1, M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/cel-evaluator.ts` | AW-43 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/database-types.ts` | AW-09 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/delivery-worker.ts` | AW-29 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/executors/server-model.ts` | AW-48 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/fact-capture.ts` | AW-13 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/health-worker.ts` | AW-11 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/job-store.ts` | AW-16 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/lease-store.ts` | AW-23 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/restore-revalidation.ts` | AW-44 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/retention-worker.ts` | AW-44 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/schedule-store.ts` | AW-40 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/source-position-store.ts` | AW-14 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/webhook-signer.ts` | AW-28 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/automation/webhook-verifier.ts` | AW-28 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/outbox/automation-ingest.ts` | AW-14 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/outbox/router.ts` | AW-14 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/infrastructure/telemetry/automation-metrics.ts` | AW-55 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/accept-intake-receipt.ts` | AW-17 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/admit-event.ts` | AW-15 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/approval-service.ts` | AW-25 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/claim-job.ts` | AW-23 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/compile-bundle.ts` | AW-18 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/count-batch.ts` | AW-57 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/dependency-index.ts` | AW-08 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/effect-gateway.ts` | AW-24 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/executor-policy.ts` | AW-22 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/health-service.ts` | AW-11 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/job-planner.ts` | AW-16 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/metadata-proposal.ts` | AW-39 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/placement-history.ts` | AW-51 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/placement-undo.ts` | AW-51 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/preview-service.ts` | AW-10 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/replay-service.ts` | AW-47 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/resolve-bindings.ts` | AW-08 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/result-reuse.ts` | AW-22 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/route-run.ts` | AW-29, AW-42 | M2, M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/rule-service.ts` | AW-10 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/run-once-service.ts` | AW-41 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/run-output-service.ts` | AW-58 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/run-service.ts` | AW-16 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/scheduler.ts` | AW-40 | Later | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/server-intake.ts` | AW-33 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/submit-result.ts` | AW-24 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/target-service.ts` | AW-26 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/template-service.ts` | AW-36 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/template-upgrade.ts` | AW-38 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/application/undo-service.ts` | AW-25 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/automation/domain/bindings.ts` | AW-08 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/collections/application/canonical-mutation.ts` | AW-13 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/application-catalog.ts` | AW-30 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/application-context.ts` | AW-30 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/application-facade.ts` | AW-31 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/automation-catalog.ts` | AW-30 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/automation-tools.ts` | AW-31 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/modules/mcp/events-adapter.ts` | AW-27 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/automation-device-routes.ts` | AW-17, AW-18 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/automation-work-routes.ts` | AW-23, AW-31 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-binding-routes.ts` | AW-10 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-delivery-routes.ts` | AW-29 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-output-routes.ts` | AW-58 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-policy-routes.ts` | AW-22 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-rule-routes.ts` | AW-10, AW-41 | M1, M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-run-routes.ts` | AW-16 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-target-routes.ts` | AW-26 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/src/transport/product/automation-template-routes.ts` | AW-36 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/count-batch.test.ts` | AW-57 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/end-to-end.test.ts` | AW-64 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/events-lifecycle.test.ts` | AW-46 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/load-and-recovery.test.ts` | AW-44 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/server/tests/integration/automation/m1-backend.test.ts` | AW-66 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/App.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/api/automationClient.ts` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/components/Layout.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/Agents.tsx` | AW-53 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/Automations.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/ResourceDetail.tsx` | AW-12, AW-52 | M1, M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/WriteApprovals.tsx` | AW-52 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/agents/AgentCard.tsx` | AW-53 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/agents/ConnectGuide.tsx` | AW-53 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/Digests.tsx` | AW-45 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/NeedsAttention.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/PreviewPanel.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RuleDetail.tsx` | AW-34 | M2 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RuleEditor.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RuleSentence.tsx` | AW-12 | M1 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RunDetail.tsx` | AW-34, AW-45 | M2, M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/RunOnce.tsx` | AW-59 | M3 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/TemplateInstall.tsx` | AW-37 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |
| `packages/web/src/pages/automations/TemplateUpgrade.tsx` | AW-65 | M4 | verify at AW-01 (not inferred from reviewer filesystem) |


## Import rules

The shared package imports no `node:*`, `chrome`, database client, model SDK, Fastify or MCP transport. Application automation code imports typed ports, not infrastructure instances. MCP adapters translate wire data into application inputs. Browser code resolves native identity locally and imports the shared package through its published dependency. Only infrastructure adapters fetch remote pages, call providers or deliver callbacks.

## Contract and test locations

OpenAPI source: `packages/server/openapi/fragments/automations.yaml`, bundled into `colp-server-v1.yaml` with prefixed component names; generated clients under `packages/server/generated/openapi/` and `packages/web/src/generated/` are never edited by hand. Events fixtures under `packages/node/tests/mcp/`; server tests under `packages/server/tests/`; extension e2e under `Known-Extension/e2e/`. This pack lives in `docs/automation/` once AW-01 copies it; the root README links to it.

---

<!-- Source chapter: 11-execution-contract.md -->

# Execution Contract: Boundaries That Must Not Drift

**Status:** normative design constraints for the proposed implementation; not evidence of deployed behavior. **Review date:** 2026-10-13. Preserve the architecture in chapter 01. Machine payloads live in the OpenAPI/JSON Schemas; task ownership lives in tasks.json. A conflict between them blocks the affected change until both are corrected. Neither a model nor a frontend may silently invent a third contract.

## 1. Scope and capability gates

M1 is deterministic placement with no agent. It accepts an intake rule with tasks=[], an empty target list and no executionPolicyId. Store a null execution-policy revision for an M1 run. Do not manufacture a worker, an execution policy, a model call, a zero-cost inference job or a subscription to satisfy an implementation shortcut. Shared definitions may describe later task kinds, but an M1 host rejects attempts to activate unsupported M2/M3/M4 functionality.

The first local backend slice supports draft creation, validation, current-state or supplied-facts preview and lifecycle control without executing bookmark effects. Runtime readiness must remain unavailable until the durable M1 composition is installed. A saved desired state is not proof that the engine is running. The frontend later renders backend desired/effective state and reasons; it does not implement those decisions.

MCP Events is the preferred hosted wake adapter, not an admission engine or a condition for running M1. A reachable local worker uses the same durable job contract by polling. This is not protocol events/poll. A hosted compatibility failure blocks that adapter's claim, not unrelated local development.

## 2. Authoritative identities and inputs

Use serverUuid/collectionId/nodeId for canonical resource identity. Folder labels and paths are presentation or portable-install inputs, not runtime identity. Renames never rebind to a same-name folder. Revalidate current permissions, ownership, live ancestry and sync range before an effect.

Native browser IDs, native observations and their generation mapping stay in the extension. A device receipt names canonical Sync operation IDs. For observed create-then-move, join both operationId and placementOperationId before accepting placement satisfaction. Verify the committed node namespace, device generation and pinned rule/binding/bundle. A receipt is advisory evidence, not authorization and not proof of summary/tags completion.

Job input digests include canonical identity, required revisions, the input-field allowlist, task/output-contract identity and accepted predecessor outputs. Never satisfy a predecessor by merely copying its type name. Read inputs through automation.jobs.inputs with current authority; unavailable input remains unavailable. A broad node-read tool separately granted to the same credential is not restricted by a job-only allowlist. Restricted workflows need dedicated least-privilege connection authority, not just a target with a private label.

## 3. Preview, activation and manual intent

supplied preview validates the provided bounded facts. currentState preview reads up to 200 authorized current bookmarks using existing canonical reads; it does not require the new historical-facts pipeline. retainedHistory is separately capability-gated and uses stored event-time facts. Never substitute one mode for another without saying so.

Preview performs no bookmark mutation, job creation or network/model execution. Persist only a short-lived preview record bound to Owner, normalized definition, bindings, policy when present, sampled inputs, relevant revisions and options. Enable requires that exact unexpired preview; changes require a new preview. The canonical committed ordinal supplies the activation fence even before the automation source reader is mounted.

Explicit user folder selection and later manual edits take precedence over rules. A root destination is a documented heuristic for unsorted intake, not proof that the user made no selection. A receipt grace-period timeout is not evidence of consent. The source adapter derives intake disposition from its verified command/receipt path; imported, restored, projected or unknown intent is not moved automatically. When the baseline cannot distinguish an explicit choice from a default, preserve the location and report the limitation rather than guessing.

The 3 s native-observation window is a proposed debounce policy. It is not a guaranteed signal that a browser dialog has closed. Subsequent manual edits always invalidate a conflicting automated move.

## 4. Canonical facts, admission and pause

The inspected baseline writes collection-lock → canonical-plan → allocation → resource → operation → audit → outbox (R03). Facts capture is a proposed addition, not an existing export. Capture before-state from locked planning inputs before mutation, capture after-state from the resulting canonical operation, append private facts after audit, and keep outbox scheduling last in the same database transaction. Do not add private data to closed/public COLP event payloads.

Automation ingestion uses a durable ordered route and an independent persisted inspection position. Inspection advances across irrelevant operations, without treating gaps in relevant facts as missing canonical ordinals. Admission deduplicates by the exact configured source/rule revision identity and pins immutable configuration. One retry of the same source produces no second run or effect. A failing rule is isolated from other rules.

Pause stops new admission/effects according to the explicit lifecycle state. Persist the inspected/skipped interval; resume takes a fresh committed high-water fence rather than accidentally replaying everything accumulated while paused. Pre-pause pending work is held/cancelled/resumed explicitly without silently rebasing its configuration. Capture of canonical facts can continue independently of admission.

An offline extension cannot learn a new server pause instantaneously. Rule bundles carry paused, a monotonic settingsRevision, expiry, profile, complete rule set and digest. Apply a full snapshot atomically; reject stale settings and expire locally. An older bundle cannot unpause a device that has learned a newer pause. Document the remaining offline exposure window instead of claiming instantaneous revocation.

## 5. Deterministic placement and M1 Undo

M1 canonical placement is authorized by the Owner's enabled rule and existing canonical write checks. It is not governed by the M2 per-agent Manual/Trusted policy. Record a placement effect with original destination only when proven, canonical operation identity, before/after revisions and explanation. Namespace nullable target partitions with an explicit sentinel so SQL NULL uniqueness cannot allow duplicate M1 effects.

AW-51 exposes a single effectReceiptId for Undo. A safe M1 Undo is a compensating canonical move under current Owner authority and conservative resource/content fences. It never deletes the newly created bookmark, guesses an unobserved original location or restores an entire collection over unrelated changes. Missing provenance or intervening edits yields undoAvailable=false with a reason or a conflict, not force restore.

Pre-save browser placement may not leave a separate canonical pre-placement state. Do not invent one. Show an explanation even when safe Undo cannot be established. Actual extension compensation remains extension-owned; the backend tests only the canonical receipt it can prove.

## 6. Worker identity, claim and recovery

Catalog memberships are independently opted-in standard, automationManager and automationWorker sets. An unpaired worker must be able to redeem an Owner-issued single-use pairing grant without manager scope or a pre-existing target binding. Pairing is available through MCP and authenticated worker HTTP. Job tools become visible only after the binding is established. The same authorization is enforced on calls, not merely listings.

The job ledger, not the webhook ledger, issues access handles in both wake modes. Handles locate work under current authentication; they are not bearer grants. Queue pagination/cursors bind the target and principal. Setup and reconnect reconcile through jobs.list; a missing wake event does not erase a durable job.

Claim increments a generation fence and returns a lease token; heartbeat and submission require that same generation/token and current authority. An expired lease does not prove an external model call had no effect or cost. Retry only under the explicit safe/uncertain policy. Budget reservations, accepted output reuse and retries share job/input/contract identity. Cancellation or revocation prevents new effects; it cannot undo an already sent external request.

## 7. Typed results and existing plan integration

A typed result is a proposal, never arbitrary operations or trusted executable instructions. Validate task/output contract, allowed input revisions, predecessor results, output bounds and subtree constraints. Revalidate immediately before canonical effects. Source content and model output are untrusted.

Do not assume the existing change-plan coordinator accepts an enclosing job database transaction. Persist a stable plan command identity and committing state, invoke the existing idempotent coordinator without holding the job lock across external work, then reconcile the canonical operation/version into a durable effect receipt. A crash after commit must look up the same plan/command; it must not create another plan because the job still looks leased. Unknown outcome remains committing/uncertain.

Manual policy leads to awaitingApproval; Trusted follows the existing reversible-plan rules (R07). Existing Undo is collection-version based with content fences, not arbitrary field-selective rollback. To expose a single-effect Undo, isolate an undoable plan unit and preserve conservative conflict checks. Do not expose force=true from automation. A multi-step job can be partial while its committed effect receipts remain visible.

Accepted metadata and run-level review/digest text do not need a fake canonical mutation plan. Store their typed outputs and lineage; show unread state only through the backend read model. M3 read markers name the last output actually viewed, not a wall-clock cutoff that swallows a concurrent new output.

## 8. Events and dot compatibility

The OpenAI webhook compatibility profile and the experimental upstream draft are distinct references; chapter 05 records the selected method/schema/error contract. In particular, do not replace the documented OpenAI callback error with a draft's provisional code. The pinned SDK must preserve capabilities.events and the method envelope; a docs reference is not a runtime test.

Sign exact serialized bytes. Reuse occurrence ID/body across retries and refresh the signing timestamp/signature each attempt. Reject unverified or non-public callback destinations at connection time, with no redirects or forwarded COLP credentials. A 2xx callback response is delivery acceptance, not claim, success or committed effect. In this design, 410 deactivates the subscription and 413 terminates that oversized occurrence; neither authorizes deletion of the durable job.

Reconcile pending jobs at bootstrap/reconnect, retain retryable wake state, and keep delivery failure separate from job failure. A host can group multiple events and receive duplicates or out-of-order events. Never assume bookmark:job:webhook:host-task is a 1:1 mapping. Use the summary-only fixture for a one-job assertion; the broader academic fixture declares three tasks.

A dot is an officially documented hosted-agent surface, not a new COLP credential class. Work/dot availability, identity isolation and the chosen network topology require actual account-specific evidence. No such hosted lifecycle was executed during this document review. Local fixtures prove only the fixture path.

## 9. Later features must not leak into the local starter

M3 count batches require a durable ordered remainder per pinned rule/epoch/partition, distinct-member admission, exactly N members per emitted batch and crash/concurrency tests (AW-57). A counter that loses the remainder is not a completed batch engine.

Run-once start submits an unexpired previewId/previewDigest for the exact immutable member/revision/options set. More than the v1 bounded maximum requires a smaller selection or an explicitly designed paginated operation; never silently truncate or re-query.

Portable templates strip runtime collection/target/policy authority and use symbolic install slots. Installation binds current identities and creates a draft with fresh validation/preview. The research-catalog example uses synthetic dataset accessions and research-group entity keys, with accepted metadata predecessors, controlled vocabulary and non-broadcast restricted targets. No real institution, person or catalog access is implied.

## 10. Evidence required to mark a task done

Record the checkout, schema version, actual command and observed result for the packet. Include negative tests and the relevant crash window, not just a success response. Backend-only evidence never counts as frontend, browser-store or real-host evidence. Offline document validation does not count as a production evaluator, PostgreSQL transaction, extension lifecycle or dot compatibility test. Use the independently scoped gates in chapters 12 and 13.

---

<!-- Source chapter: 12-delivery-lanes.md -->

# Delivery Lanes and Frontend Handoff

**Status:** implementation ownership plan. All UI work is frontend work and is deferred in the backend-only path. tasks.json is the source of task IDs; file-ownership.json is the file ownership inventory. backend-batches.json is the dependency-closed local schedule.

## 1. Single ownership

| Lane | Owns | Does not own |
|---|---|---|
| contracts | Baseline evidence, contract review and vocabulary freeze (AW-01) | Product runtime files or UI |
| shared-core | Pure schemas, normalization, finite evaluator, arbitration and task contracts inside @know-n/colp/automation | Chrome/DOM/React/Node built-ins, network, database, provider-specific Events |
| backend | Server use cases, persistence, authorization, jobs, effects, OpenAPI producer artifacts, worker transport and Events adapters | React pages, frontend generated clients, browser local state or native bookmark APIs |
| web | Every Web screen, UI state, controls, strings, navigation, Web client generation and API consumption | Authoritative lifecycle, permission decisions, budgets or workflow scheduling |
| extension | Native mapping/capture/receipts, local bundle installation, Chrome lifecycle, extension UI and consumer integration | Canonical server identity, server authorization or server job transitions |
| worker-reference | Runnable host-neutral polling example and setup documentation (AW-32) | A guaranteed autonomous provider deployment or server-owned model executor |
| integration | Composition of lane-owned evidence into the M1/M2 product release gates | Reimplementing another lane to bypass a missing handoff |

For this local delivery, shared-core is part of the backend work budget even though its API is browser-compatible. Compatibility is tested by an isolated import/bundle fixture, not by developing the browser extension. The entire Known-Extension checkout remains untouched; this is a scheduling choice, not a claim that every extension line is UI.

## 2. Splits made from the uploaded mixed packets

| Existing packet retained for backend/core | Deferred consumer packet |
|---|---|
| AW-03 bounded profile; AW-04 exported core; AW-18 rule-bundle service | AW-49 extension installation, mapping and runtime profile |
| AW-17 canonical receipt ingestion | AW-50 extension local receipt persistence and Sync handoff |
| AW-25 plan approval and conservative Undo adapter | AW-52 Web approval/Undo controls |
| AW-26 target/profile/pairing service; AW-30 catalogs; AW-32 reference worker | AW-53 Agents screens and connection guide |
| AW-55 backend waiting/budget read model | AW-34 Web history; AW-54 extension status |
| AW-41 run-once preview/start service | AW-59 run-once UI |
| AW-57 count aggregation; AW-58 output/unread persistence | AW-45 Web digest screens; AW-60 extension badge |
| AW-36 template install/export; AW-38 upgrade/rollback | AW-37 install wizard; AW-65 upgrade/rollback UI |
| AW-48 later server-owned executor | AW-62 later extension background executor |

AW-51 explicitly owns the M1 placement explanation/Undo backend previously missing from the independent M1 release. AW-61 owns shared portable-template/entity-map semantics. AW-66 is the backend-only M1 acceptance gate; AW-64 is the backend polling/plan gate. Neither gate waits for a frontend or a real hosted callback.

## 3. What a backend handoff contains

Publish the versioned OpenAPI/JSON Schemas, bounded positive and negative fixtures, error/recovery semantics, auth scheme, pagination rules and actual backend tests. Provide representative states: draft, invalid/stale preview, active, paused, blocked dependency, capability unavailable, no safe Undo and conflicting newer edit. For M2 add unpaired/paired, no work, leased, uncertain, awaiting approval, committing, succeeded and delivery unavailable.

The backend owns the canonical schema source. Web and extension generate or adapt their clients in their own work. A UI must not guess missing fields by inspecting server tables or infer a workflow transition from a successful network request. Backend descriptions must distinguish desired state from observed effective state and delivery acceptance from job success.

Backend tests use real database fixtures and transport clients where those semantics matter; they do not require a screen. Frontend can start layout and mock integration after the relevant schema slice is frozen. Full consumer integration waits for the producer packet's acceptance, not merely its task ID appearing in a roadmap.

## 4. Merge order and shared files

Do not run two agents concurrently against the same schema fragment, SDK boundary or route manifest. Even within one lane, shared-file producers are merged serially or through a named integrator. The pure evaluator can proceed in parallel with persistence after the common types are stable. Every packet still honors its listed dependencies.

AW-01 owns review records; the backend owns the actual server OpenAPI fragment. Each task has its own evidence file. A cross-lane defect returns to the owning producer with a minimal failing fixture; consumers do not add private compatibility branches to conceal it.

Local package build/pack validation closes AW-04's backend deliverable. Public npm distribution precedes AW-49's release consumption but does not block local backend work. Migration filenames must sort after the actual database/repository head, even if a timestamp-looking head is ahead of the calendar.

## 5. Distinct gates

BE-1 completes configuration and preview only; no bookmark movement is claimed. AW-66 proves the durable M1 backend without UI or M2 services. AW-64 proves the local polling worker/plan lifecycle without Events. AW-02/AW-46 prove the selected Events profile and, separately, the actual hosted lifecycle. AW-63/AW-35 remain full product gates combining frontend, extension, backend and applicable host evidence. A backend milestone may be accepted without calling the full product shipped.

---

<!-- Source chapter: 13-backend-first.md -->

# Local Backend-First Implementation Order

**Decision:** begin with BE-1, the configuration/preview slice of M1, not with a hosted dot or a Web screen. This is a proposed execution order, not a record that any task has been implemented. The same order is machine-readable in [backend-batches.json](backend-batches.json).

## 1. First batch: BE-1

Target: an authenticated local API can create a deterministic placement rule, validate and preview it, and manage its lifecycle/health without changing a bookmark, running a model or depending on a frontend.

| Merge unit | Work packets, in order | Concrete output |
|---|---|---|
| 1. Freeze the backend slice | AW-01, AW-03 | Actual checkout facts, auth/error/migration/OpenAPI conventions, finite rule profile and fixture vocabulary |
| 2. Pure shared core | AW-04 → AW-05 → AW-06 → AW-07 | Optional automation package subpath, normalization/digests, bounded predicates, placement arbitration and task-graph validation |
| 3. Persistence and bindings | AW-09 → AW-08 | M1 migrations, backup/export coverage, immutable rules/bindings and dependency index using canonical folder identities |
| 4. Product services without a screen | AW-10 → AW-11 | CRUD, supplied/current-state preview, exact-preview activation, pause and dependency-health APIs with tests |

AW-09 can begin after AW-04, and AW-08 after AW-05 plus AW-09; their completion need not wait for all evaluator work if separate files are owned. Keep shared schema and manifest changes serialized. These merge units are smaller reviewable PRs, not one ten-packet commit.

Do not put AW-02 on BE-1's critical path. A disposable Events fixture can be explored after AW-01, but live-host availability, public HTTPS and callback setup cannot hold up deterministic backend work. This does not remove the later hosted compatibility gate.

## 2. BE-1 acceptance boundary

Use examples/m1-placement.json, m1-bindings.json, m1-rule-create.json and m1-preview-current-state.json. The rule has tasks=[], no executionPolicyId, no target and no model credential.

Through authenticated API integration tests, demonstrate draft creation; deterministic matching and conflict reporting; preview with no effects; enable rejection without an exact unexpired preview; invalidation after a semantic rule/binding edit; lifecycle/pause persistence; and a clear blocked/unavailable state when the runtime composition is not installed. Current-state preview uses the existing canonical read path, not an unimplemented historical-facts store.

Verify URL-prefix boundary cases, missing fields, unsupported profiles and the eight-task graph bound. Prove canonical folder identity survives a rename and cannot bind to a same-name replacement. Validate authority, If-Match, command idempotency and the repository's real auth/CSRF conventions. Test fresh install and upgrade from the actual migration head, plus restored pause state and secret-free export.

No bookmark move, ready worker job, Events subscription, model call or claimed browser behavior belongs to this batch. A desired enabled setting does not mean the execution engine is already active. Keep the runtime feature unavailable until BE-2 passes.

Backend source areas are packages/node/src/automation, packages/server, server contract/build artifacts, tests and required deployment scripts. Do not modify packages/web or Known-Extension. A future UI's request/response types are backend contracts; rendering, generated frontend clients, menus, labels, badges and interactive approval screens are frontend work.

## 3. Second batch: BE-2 — useful durable M1 backend

After BE-1, implement AW-13 → AW-14 → AW-15 → AW-16 → AW-17, then AW-51 → AW-33, with AW-18 independently ready after its configuration dependencies; close AW-66 last.

This adds committed facts, durable ordered ingestion, idempotent admission, runs/effect history, canonical device-receipt verification, server-intake placement, explanation, conservative single-effect Undo and backend bundle distribution. Native browser code is still deferred. Exercise canonical Sync/device fixtures at the transport boundary without calling them real browser evidence.

The acceptance narrative is: an eligible default-root bookmark is created through the canonical API; the matching rule places it in the bound Academic directory; one canonical effect and explanation are recorded; retry/restart does not move it twice; a newer manual move blocks a stale effect/Undo; pause/resume does not accidentally process the skipped interval. No agents, M2 policy tables or Events are needed.

AW-66 is the independent backend gate. AW-63 remains the full M1 product/browser gate and is deliberately not a prerequisite for backend progress.

## 4. Third batch: BE-3 — local polling worker

Implement AW-22, AW-23, AW-24, AW-25, AW-26, AW-30, AW-31, AW-32, AW-55 and AW-64, following tasks.json dependencies. The target/profile branch and the job/plan branch can proceed in parallel after their shared contracts are frozen.

Prove worker-only bootstrap → queue list → claim → allowlisted inputs → heartbeat → typed proposal → existing approval or Trusted plan → committed effect → recovery by the same plan identity. Use injected deterministic typed output for the first integration proof; a model key is not needed to verify orchestration. A real model test is additional evidence, not a substitute for the crash/idempotency suite.

Reuse existing approved credential/session mechanisms; do not add test-only production auth bypasses. Owner configuration and approval APIs can be exercised without building an Agents page. AW-64 depends on neither AW-29 nor any UI/host task. Job/budget telemetry is useful before delivery telemetry exists; unsupported delivery is reported as unavailable.

## 5. Fourth batch: BE-4 — hosted Events

Complete AW-02, AW-27, AW-28, AW-29, AW-44 and AW-46. Preserve the selected OpenAI webhook profile, independently verify the two network directions, callback challenge/signing, TTL/refresh/revocation, out-of-order/duplicate delivery and queue reconciliation. Separate protocol-fixture evidence from an actual Work/dot lifecycle.

This scheduling choice does not change Events from the preferred hosted wake mode. It proves the durable job engine first so that a provider callback or account issue cannot be confused with a rule/job/plan bug. Availability or identity limitations are explicit blockers for that host profile only.

## 6. Fifth batch and deferred work

BE-5 covers AW-41, AW-57 and AW-58: immutable run-once preview/start, exact count-batch aggregation and persisted run-level output/unread state. Templates, broadcast, CEL and extra executors retain their original later milestones; do not use them to enlarge BE-1.

All Web and extension implementation packets are deferred on this local backend path. That includes browser-only runtime integration even where it is not itself UI. Backend device APIs/fixtures are not deferred, because they define the eventual consumer boundary.

## 7. Copyable initial implementation brief

> Implement BE-1 only: AW-01, AW-03, AW-04, AW-05, AW-06, AW-07, AW-09, AW-08, AW-10 and AW-11, respecting the dependency graph and separate merge units above. Use the uploaded revised direction plus this reviewed contract. Treat shared-core as part of backend delivery. Do not change packages/web or Known-Extension and do not implement UI, hosted dot setup, Events delivery, model execution, batches or templates. Do not publish npm or rebase user work merely to begin; validate the local package/export surface. Start by verifying the current checkout's auth, error, OpenAPI and migration conventions. Use tasks=[] with no policy/target for M1, and supplied/current-state preview without historical ingestion. No actual bookmark effects until the durable M1 runtime is separately implemented and accepted. Deliver actual unit/API/database evidence, positive/negative fixtures and a bounded handoff for the later frontend. Never report a proposed test or mock host interaction as executed production behavior.

---

<!-- Source chapter: 14-review-findings.md -->

# Review Findings and Revision Summary

**Reviewed:** 2026-10-13. **Input authority:** the uploaded revised design pack. **Output:** corrected design/contracts and a separated implementation plan, not application code. The original overall direction is retained: pure deterministic intake, durable server orchestration, typed worker results through existing authorization/plans, and Events as the preferred hosted wake adapter with reachable-worker polling as an alternative.

## 1. Material corrections

| Finding in the supplied pack | Why it mattered | Revised contract / task |
|---|---|---|
| Hosted support, selected topology and COLP interoperability were not consistently separated | A documented provider feature could be mistaken for an already tested integration | Chapter 05 and provenance in chapter 08; AW-02/AW-46 distinguish real evidence from fixtures |
| OpenAI webhook profile and evolving experimental Events draft could be conflated | Method support and callback error numbers differ | Keep the documented OpenAI callback code/profile; do not import draft poll/push/control behavior |
| Worker catalog lacked a ready-queue list, and pairing depended on manager authority | A worker-only bootstrap/reconnect could not complete | automation.jobs.list plus worker-only MCP/HTTP pairing; 15 descriptors |
| Catalog selection behaved as mutually exclusive modes | Manager and worker permissions could not be composed clearly | Explicit catalogs[] with separate Owner opt-ins and scopes |
| M1 rule input required an M2 execution policy | The allegedly independent deterministic release needed a dummy agent configuration | Optional policy for M1, explicit null revision, tasks=[] and independent fixtures |
| Local receipt exposed browser-native observations/identities | Contradicted canonical/native separation and invited unverified satisfaction claims | Canonical-only receipt, server namespace and operation joins; only advisory classify.root satisfaction |
| Bundle contract omitted pause/settings state | Offline installations could keep using or reapply stale state | Full atomic snapshot, paused/settingsRevision and expiry; disconnected pause latency is explicit |
| Prefix matching could be approximated by contains | A condition could silently match unrelated paths | Literal startsWith in the bounded DSL and boundary fixtures |
| Capture/write-order description treated proposed facts as existing behavior | Risked modifying closed events or breaking transaction order | Preserve inspected canonical order; append private facts before final outbox scheduling |
| Source inspection, admission, pause and resume were not fully distinguished | Skipped intervals could be replayed unintentionally or inspection could stall | Durable inspected/skipped fences and fresh activation/resume high-water |
| Grace-period expiry/root placement was overinterpreted as user intent | Automation could override an explicit/manual choice | Verified source disposition; unknown/import/restore/projection not moved automatically |
| Plan effects were described as if an enclosing job transaction were already supported | A crash between canonical commit and job receipt could execute twice | Stable plan command plus committing/reconciliation; no presumed outer transaction API |
| Existing collection-version Undo was called effect-scoped without its constraints | Restoring one effect could revert unrelated changes | Conservative isolated plan unit for M2; separate compensating placement Undo for M1 (AW-51) |
| One bookmark, job, delivery and hosted run were presented too closely as 1:1 | Multiple declared tasks, retries and host event grouping invalidate that assumption | Separate summary-only one-job fixture from the broader three-task fixture |
| Run-once start repeated mutable selection rather than committing a pinned preview | Executed members could drift after the Owner reviewed them | previewId/previewDigest with immutable members, revisions and options |
| Count batching and digest persistence had no sufficiently explicit backend owner | UI work could conceal missing executable behavior | AW-57 aggregator and AW-58 output/unread storage, separate consumer tasks |
| Portable templates retained runtime identities or execution authority | Import could inadvertently bind to the wrong environment | Symbolic install slots, fresh binding and draft activation |
| Mixed packets combined service, Web and extension work | Each side could block or quietly reimplement the other | 66 single-lane packets; chapters 12/13; file-ownership.json |
| Package publication, live hosted M0 and full browser release gates blocked local backend progress | Local work inherited unnecessary external dependencies | Local package validation, BE-1–BE-5 schedule, AW-66 M1 backend gate, AW-64 polling gate |
| Current-state preview was in prose but not the wire enum | The first API slice could depend on an unbuilt historical-facts service | Explicit currentState mode with bounded canonical reads |
| Generated file map inferred “new” from a missing reviewer's local checkout | Existing paths could be mislabelled as new | Explicit verify-at-AW-01 status, never an absence-based repository claim |
| Informal catalog example was unsuitable for formal documentation | It obscured the reusable metadata/entity-map workflow | Synthetic institutional research dataset catalog, research-group directories and controlled vocabulary |

## 2. What was verified, and what was not

Primary OpenAI Events/dot references and the experimental MCP sketch were checked. Selected source was read at COLP commit 2ee8397cc20008e7865f2a080c91be2d38d323ae: canonical mutation order, the MCP SDK boundary, and agent policy/Undo. Foreground classification was read at the extension reference 28acb4965. Chapter 08 records the exact references and separates them from inherited baseline assertions.

The shared-chat body and local product-plan repository were not available as readable evidence. No codebase was rebased, deployed or modified. Remaining inherited repository paths/names are explicitly subject to checkout verification at AW-01 rather than silently presented as rechecked facts.

Only document/contract validation was executed here. Read validation/report.md for the actual check results. All AC acceptance scenarios remain planned_not_executed. There was no real database fault suite, browser lifecycle, model invocation, callback delivery, dot run or store approval during this review.

## 3. Using the revision

Begin at chapter 13 for backend-only local work. Read chapters 11 and 12 before implementing a packet. Use tasks.json and backend-batches.json for ownership/dependencies, OpenAPI/JSON Schemas for wire shapes, and the runnable validation scripts to catch drift after edits. Do not substitute prose, generated client assumptions or a provider demonstration for the canonical contract and test gates.

The corrected pack is a reviewed implementation plan with known external gates, not a guarantee that future code contains no defects. The remaining uncertainties are named and bounded so they cannot silently turn into claimed capabilities or runtime dependencies.
