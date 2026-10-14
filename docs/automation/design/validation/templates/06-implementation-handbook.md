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

{{TASK_INDEX}}

## 5. Work packets

{{WORK_PACKETS}}

## 6. Cross-cutting merge requirements

Every source mutation path is traced to exactly one admission. Any new feature that creates or moves bookmarks states whether it is user intake, import, restore, sync projection or an existing causal workflow step. Causation is set by the server effect gateway, never accepted from a client string.

New Product paths update the backend OpenAPI fragment, route manifest and gate lists, examples, drift and breaking checks together; frontend client generation remains in its own lane, and bump `info.version` of `colp-server-v1.yaml` additively with a new baseline snapshot (R24). MCP tools use closed schemas and the same services, with no Product session shortcuts. Webhooks are outbound infrastructure and never forwarded through public feeds.

Migrations follow §0 of the data model: prefix after the current head, forward-only, with operational notes. Rollbacks stop admission and delivery first. No live credentials, tokens, private bookmark bodies or personal examples enter fixtures.

New UI strings follow the existing localization practice of each surface (the extension has `check:i18n`; see Q4 for the web). CHANGELOG "Upgrade notes" names the automation migrations and the new flags.

## 7. Machine-readable handoff

[tasks.json](tasks.json) is the source of §4 and §5. [traceability.json](traceability.json) is generated from it and from [user-stories.json](user-stories.json). [acceptance-tests.json](acceptance-tests.json) is the source of the acceptance matrix. [api/operations.json](api/operations.json) is the HTTP inventory with milestones. `validation/build-docs.py` regenerates the derived sections and fails when the stories chapter disagrees with the JSON.
