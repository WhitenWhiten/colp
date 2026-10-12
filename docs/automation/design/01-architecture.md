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
