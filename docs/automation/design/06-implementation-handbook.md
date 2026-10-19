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
| AW-67 | M1 | M | Keep browser rules and apply them at save, below the account's rules | AW-19, AW-21 | AU-34 |
| AW-68 | M1 | M | Write and manage browser rules in Options › Automations | AW-54, AW-67 | AU-34 |
| AW-69 | M1 | M | Review browser rules against the account's rules | AW-49, AW-68 | AU-34 |
| AW-70 | M1 | S | Fill the web rule editor from a browser rule | AW-12 | AU-34 |
| AW-71 | M1 | S | Move a browser rule to the account | AW-69, AW-70 | AU-34 |
| AW-72 | M1 | S | Disconnect removes the account's automation data and keeps browser rules | AW-21, AW-67 | AU-34 |
| AW-73 | M1 | L | Keep this browser's rules as one ordered list, with preview, Run once and a configuration file | AW-67, AW-68 | AU-35 |
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

#### AW-67 — Keep browser rules and apply them at save, below the account's rules — M

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-19, AW-21. **Stories:** AU-34.

**Handoff:** docs/automation/evidence/aw-67.md: commands, build, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No star-button (observed-create) placement by browser rules in this packet; no server API.

**Read first:**
- `01-architecture.md`
- `packages/extension/src/automation/pre-save.ts`
- `packages/extension/src/sw/capture.ts`

**Files (new or modified):**
- `packages/extension/src/automation/browser-rules.ts`
- `packages/extension/src/automation/browser-rule-store.ts`
- `packages/extension/src/sw/automation-browser.ts`
- `packages/extension/src/automation/runtime-profile.ts`
- `packages/extension/src/automation/pre-save.ts`
- `packages/extension/src/automation/messages.ts`
- `packages/extension/src/capture/contracts.ts`
- `packages/extension/src/sw/capture.ts`
- `packages/extension/src/sw/automation.ts`
- `packages/extension/tests/automation-browser-rules.test.ts`
- `packages/extension/tests/automation-worker-browser-rules.test.ts`

**Steps:**
1. Store browser rules (an M1 RuleDefinition with no collection scope, plus a native folder id, on/off and revision) in the automation IndexedDB store; validate with validateM1Rule and keep the evaluator's normalized values.
2. Evaluate them with the shared core (evaluateLocalRules over native folders, priority 100) after the account bundle: any account outcome settles the save; otherwise a browser placement, keep, block or conflict is pinned on the capture task as a browser decision.
3. The popup's match preview, the save line and tags-only local classification read the browser decision the same way; no receipt is written and nothing is sent. Keep a short local log of browser placements for Options.

**Done when:**
- A signed-out save, an offline save and a save into an unsynced folder are placed by a matching browser rule; an explicit folder wins.
- With a matching account rule (placed, blocked or expired), browser rules are not consulted and the receipt path is unchanged.

#### AW-68 — Write and manage browser rules in Options › Automations — M

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-54, AW-67. **Stories:** AU-34.

**Handoff:** docs/automation/evidence/aw-68.md: commands, build, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `packages/extension/src/automation/options-pane.ts`
- `packages/extension/src/library-folder-picker.ts`
- `packages/extension/src/dialog.ts`

**Files (new or modified):**
- `packages/extension/src/automation/browser-rules-pane.ts`
- `packages/extension/src/automation/options-pane.ts`
- `packages/extension/options.html`
- `packages/extension/options.css`
- `packages/extension/_locales/en/messages.json`
- `packages/extension/_locales/zh_CN/messages.json`
- `packages/extension/scripts/shots-stub.mjs`
- `packages/extension/tests/automation-browser-pane.test.ts`
- `packages/extension/e2e/mv3-browser-rules.spec.ts`

**Steps:**
1. Signed out, the pane leads with This browser's rules and a quiet line about the account's rules; signed in, the account's status card and rules come first and This browser's rules follow.
2. One dialog creates and edits a rule: name, when (site is, site ends with, title contains, URL path starts with; all or any) and where (the folder picker over this browser's folders). Rows read like the web's rule sentences, with an on/off switch, Edit and Delete.
3. Browser placements join This browser's activity tab.

**Done when:**
- Happy-dom pane tests cover the signed-out, signed-in and empty states and the editor's validation; screenshots in en and zh_CN.
- A real Chromium run under xvfb creates a rule in Options with no account and files an offline popup save into its folder.

#### AW-69 — Review browser rules against the account's rules — M

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-49, AW-68. **Stories:** AU-34.

**Handoff:** docs/automation/evidence/aw-69.md: commands, build, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `01-architecture.md`
- `packages/extension/src/automation/binding-projector.ts`
- `packages/extension/src/automation/runtime-profile.ts`

**Files (new or modified):**
- `packages/extension/src/automation/browser-overlap.ts`
- `packages/extension/src/sw/automation-browser.ts`
- `packages/extension/src/automation/browser-rules-pane.ts`
- `packages/extension/tests/automation-browser-overlap.test.ts`

**Steps:**
1. Label each browser rule against the bundle: duplicate, conflict, independent, local only, broken. Prove overlap with a witness page built from both rules' conditions; count it by replaying both sets over the most recent 2,000 bookmarks in this browser.
2. Show one notice when a duplicate or an unreviewed conflict exists, and a review dialog with Keep both, Use the account's and Remove; remember the choice against the account rule's id, revision and binding revision.

**Done when:**
- Static and replay overlap agree on the fixture set; a changed account rule brings its conflict back.
- No account rule or browser rule is changed by opening the review; only the Owner's choice changes a browser rule.

#### AW-70 — Fill the web rule editor from a browser rule — S

**Milestone:** M1. **Lane:** web. **Depends on:** AW-12. **Stories:** AU-34.

**Handoff:** docs/automation/evidence/aw-70.md: commands, build, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No new API operation; the extension only links to the page.

**Read first:**
- `packages/web/src/pages/automations/ruleDraft.ts`
- `packages/web/src/pages/automations/RuleEditor.tsx`

**Files (new or modified):**
- `packages/web/src/pages/automations/ruleDraft.ts`
- `packages/web/src/pages/automations/RuleEditor.tsx`
- `packages/web/src/pages/automations/ruleDraft.test.ts`
- `packages/web/src/pages/automations/RuleEditor.test.tsx`

**Steps:**
1. /automations/new accepts name, combinator and repeated condition=kind:value parameters next to collectionId and folderId, and seeds the form from them. Unknown kinds and empty values are dropped; nothing is created until Save.

**Done when:**
- The editor opened from a browser rule shows its name, conditions and folder; Preview and Turn on behave as for any new rule.

#### AW-71 — Move a browser rule to the account — S

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-69, AW-70. **Stories:** AU-34.

**Handoff:** docs/automation/evidence/aw-71.md: commands, build, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `01-architecture.md`
- `packages/extension/src/sw/automation.ts`

**Files (new or modified):**
- `packages/extension/src/automation/browser-rules.ts`
- `packages/extension/src/sw/automation-browser.ts`
- `packages/extension/src/automation/browser-rules-pane.ts`
- `packages/extension/src/sw/automation.ts`
- `packages/extension/tests/automation-browser-move.test.ts`

**Steps:**
1. Add mine to the account is offered only for a rule whose folder has an authoritative Sync mapping; it opens the filled-in web editor and marks the rule as moving.
2. After each bundle install, a moving rule that an enabled account rule duplicates retires itself; anything else leaves it in place.

**Done when:**
- Retirement happens only after the enabled duplicate is installed; a draft, a different rule or an unsynced folder leaves the browser rule working.

#### AW-72 — Disconnect removes the account's automation data and keeps browser rules — S

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-21, AW-67. **Stories:** AU-34.

**Handoff:** docs/automation/evidence/aw-72.md: commands, build, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.

**Read first:**
- `03-user-stories.md`
- `packages/extension/src/sw/auth.ts`

**Files (new or modified):**
- `packages/extension/src/sw/auth.ts`
- `packages/extension/src/sw/automation.ts`
- `packages/extension/src/automation/indexeddb-store.ts`
- `packages/extension/tests/automation-disconnect.test.ts`

**Steps:**
1. On sign-out, delete that account's bundle record, receipts, placement intents, server status, pause, device and badge state; leave browser rules and their log untouched.

**Done when:**
- AC-74: after disconnect the account's keys are gone and a browser rule still places a save.

#### AW-73 — Keep this browser's rules as one ordered list, with preview, Run once and a configuration file — L

**Milestone:** M1. **Lane:** extension. **Depends on:** AW-67, AW-68. **Stories:** AU-35.

**Handoff:** docs/automation/evidence/aw-73.md: commands, build, result, limitations

**Not in scope:** Do not change another lane's runtime files; open a contract issue and return the defect to its owner.; Do not mark planned acceptance as executed without the actual command, build and evidence.; No change to @know-n/colp/automation; no subscription fetching, rule-set import or risk alerts (later stages); no star-button placement by browser rules.

**Read first:**
- `01-architecture.md §7.5`
- `packages/extension/src/automation/browser-rules.ts`
- `packages/extension/src/sw/automation-browser.ts`

**Files (new or modified):**
- `packages/extension/src/automation/rule-list-store.ts`
- `packages/extension/src/automation/rule-conditions.ts`
- `packages/extension/src/automation/rule-list-flatten.ts`
- `packages/extension/src/automation/rule-list-decide.ts`
- `packages/extension/src/automation/public-suffix.ts`
- `packages/extension/scripts/generate-public-suffix.mjs`
- `packages/extension/src/automation/rule-list-pane.ts`
- `packages/extension/src/automation/rule-editor-dialog.ts`
- `packages/extension/src/automation/rule-set-dialog.ts`
- `packages/extension/src/automation/rule-preview.ts`
- `packages/extension/src/automation/rule-preview-pane.ts`
- `packages/extension/src/automation/run-once.ts`
- `packages/extension/src/automation/run-once-pane.ts`
- `packages/extension/src/sw/automation-run.ts`
- `packages/extension/src/automation/rules-config-format.ts`
- `packages/extension/src/automation/rules-config-pane.ts`
- `packages/extension/src/sw/automation-config.ts`
- `packages/extension/src/sw/automation-browser.ts`
- `packages/extension/src/automation/browser-rules.ts`
- `packages/extension/src/automation/browser-rule-store.ts`
- `packages/extension/src/automation/messages.ts`
- `packages/extension/src/capture/contracts.ts`
- `packages/extension/src/automation/options-pane.ts`
- `packages/extension/tests/automation-rule-list-store.test.ts`
- `packages/extension/tests/automation-rule-list-decide.test.ts`
- `packages/extension/tests/automation-rule-preview.test.ts`
- `packages/extension/tests/automation-run-once.test.ts`
- `packages/extension/tests/automation-rules-config.test.ts`
- `packages/extension/e2e/mv3-browser-rule-list.spec.ts`
- `packages/extension/e2e/mv3-browser-rule-run-once.spec.ts`

**Steps:**
1. Keep individual rules, one-level sets and subscription entries as one ordered list in the automation store (known.automation.browserRules.v2), every write one read-modify-write with a revision; move the v1 flat list once, in its order, and name the pairs whose order now decides.
2. Store each rule's conditions as the truth and compile them to the existing M1 operators (site is, site or its subdomains, title contains, path starts with, path is or is under); flatten the list and decide by first match: no match goes on, missing input is passed over and named, an error or an unbound role blocks, keep here keeps, a match with its folder places. Every decision carries the entry, its set or subscription, content version and list revision.
3. Options: one list with switches, Move up/down and dragging, sets, the editor's Then (folder, the set's role, keep here) and public-suffix help while editing; Recent activity names the entry and offers Open rule, Turn off and Add a rule above.
4. Try a page against the whole list (winner, passed over, shadowed, broad) and the recent bookmarks, comparing after each change; Run once over a folder with a 15-minute preview, a journal per run and Undo of what is still where the run left it; export and import known-rules-config/v1 with every folder chosen again.

**Done when:**
- The upper of two matching rules files the page, offline and signed out, and the order survives a restart; the shared core's contract is unchanged.
- Preview, Run once and Undo, and configuration import behave as AC-76 to AC-78 state; nothing in this packet calls a server.

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
