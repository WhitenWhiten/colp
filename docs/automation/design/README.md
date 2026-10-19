# COLP Automations — Design and Implementation Pack

**Language:** English. **Format:** Markdown, OpenAPI YAML and JSON contracts and examples.
**Version:** 0.2.1-design. **Date:** 2026-10-13. **Status:** proposed design, not deployed implementation.

This pack defines bookmark automation for COLP Server and the Known extension: deterministic rules that place a bookmark the moment it is saved, durable server-side runs, and enrichment jobs that the Owner's own agents complete through the approvals, history and Undo the product already has. MCP Events is an optional wake-up adapter for hosted bots on public servers, not the engine.

A [single-file complete design book](COLP-Automations-Complete.md) is generated from the chapters. Use the whole directory to keep relative links and machine-readable companions.

## Start here for local backend-only work

[13 Backend-first order](13-backend-first.md) recommends BE-1: AW-01, AW-03, AW-04–AW-11, with migrations before the binding implementation. It requires neither a frontend nor live Events, a dot account or npm publication. [11 Execution contract](11-execution-contract.md) pins safety and recovery boundaries; [12 Delivery lanes](12-delivery-lanes.md) separates producers and consumers; [14 Review findings](14-review-findings.md) records corrections and evidence limits. [backend-batches.json](backend-batches.json) is the machine-readable local schedule.

## Read in this order

| Document | What it contains |
|---|---|
| [03 User stories](03-user-stories.md) | 35 Owner, Browser and Agent stories with numbered acceptance, grouped by milestone; the worked M2 narrative |
| [01 Architecture](01-architecture.md) | Glossary, decisions, verified boundaries, deployment reality, scope by milestone, execution path, invariants |
| [02 Rule contract](02-rule-contract.md) | Rule language, bindings, task contracts, validation, example inventory |
| [04 API guide](04-api-guide.md) | Surfaces, verified session and CSRF scheme, errors, lifecycle sequences, operation inventory by milestone, repository integration |
| [05 MCP Events](05-mcp-events.md) | Conditional tool catalog and the MCP Events wake-up path (M2), polling as the per-target alternative, re-verified platform facts |
| [06 Implementation handbook](06-implementation-handbook.md) | Milestones M0–M4, how to work a packet, 73 work packets with Read first / Steps / Done when, generated from `tasks.json` |
| [07 Acceptance and operations](07-acceptance-operations.md) | 78 planned acceptance tests, test layers, security matrix, matters needing attention, runbooks, flags, release checklist |
| [08 Evidence and decisions](08-evidence-and-decisions.md) | Verified repository facts R01–R27, external references, ADRs including the ten new ones, gates G1–G10, open questions Q1–Q9 |
| [09 Data model](09-data-model.md) | Tables by milestone, transactions, state machines, retention, migration naming rule |
| [10 Module and file map](10-module-file-map.md) | Every file each packet creates or modifies, generated from `tasks.json` |

## Machine-readable artifacts

[Product, device and worker OpenAPI](api/automation.openapi.yaml) and [MCP Events OpenAPI](api/mcp-events.openapi.yaml); [operation inventory](api/operations.json) with milestones; [typed MCP tool catalog](api/mcp-tool-catalog.json) with 15 descriptors; [schemas](schemas/) (Draft 2020-12); [examples](examples/); [user-stories.json](user-stories.json), [tasks.json](tasks.json), [acceptance-tests.json](acceptance-tests.json) and the generated [traceability.json](traceability.json).

`tasks.json` is the single source for the handbook's packet sections and the file map. Edit it, then run the build. Edit the Markdown chapters directly for prose.

## Verification

```sh
python -m pip install -r validation/requirements.txt
python validation/build-docs.py      # regenerates 06 §4–5, 07 §1, 10, traceability.json, the complete book; checks 03 against the JSON
python validation/validate.py        # schemas, examples, fixtures, links, plan consistency; writes validation/report.md
```

The validator checks shapes, references, supplied examples, a small semantic fixture suite, links and planning consistency. It is not the production evaluator and not an end-to-end test. No repository was modified by producing this pack.

## Decided on 2026-10-14: rules in the browser (Q7)

Rules made in the extension now work with no server, as a layer below the account's rules: explicit folder, then account rules, then browser rules, then the local classifier. Overlaps are reviewed when a server is connected, and a browser rule reaches the account only through the web editor. See [01 §7.5](01-architecture.md#75-browser-rules-adr-a24-au-34), ADR-A24, AU-34 and packets AW-67–AW-72.

## Decided on 2026-10-18: one ordered list in the browser

The browser's rules become one list the Owner orders — rules, one-level sets and subscriptions — tried from the top, the first match deciding, with a preview across the list, Run once with Undo and a `known-rules-config/v1` file. The shared core does not change. See [01 §7.5](01-architecture.md#75-browser-rules-adr-a24-au-34), ADR-A25, AU-35 and packet AW-73; [examples/ruleset.json](examples/ruleset.json) and [examples/risklist.json](examples/risklist.json) show the formats the next stages import.

## Review changes in 0.2.1-design

This review corrects the supplied revision without replacing its overall architecture. It separates platform documentation from actual integration evidence, adds worker bootstrap/queue reconciliation, makes M1 contracts independent of M2, fixes receipt/pause/preview/Undo boundaries and splits mixed frontend/backend tasks. The full findings are in chapter 14. The following inherited history describes the input revision, not newly executed verification.

## Inherited revision history (context, not new verification)

Reviewed on 2026-10-12 against COLP `2ee8397` and Known-Extension `28acb4965`, and against the product plan in `~/known/colp-server`. The invariants of 0.1.0 are kept. The following changed, and why:

1. **Stories rewritten from the Owner's day, not the system's invariants.** Actors are the product plan's Owner, Browser and Agent; every story has numbered acceptance that names a screen or a command. Removed the copied boilerplate sentence under every story. New stories for real demand that had no home: the two-minute first rule (AU-01), bookmarks added on the web, phone or by an agent (AU-09), "why is it here" with single-effect Undo (AU-13), pause everything (AU-14), approvals reuse (AU-19), cost visibility and caps (AU-23), run once over existing bookmarks (AU-25), where a digest is read (AU-24), the reachability precondition for hosted bots (AU-26), and backup/export/uninstall (AU-33).
2. **MCP Events first, polling as a setting (ADR-A13, owner decision 2026-10-12).** Agents are woken through MCP Events when the server has a public HTTPS origin; each target has a wake mode (`events` or `poll`) proposed from the origin, so a loopback or LAN server (D26) still works with a polling agent (Claude Code routine, script). The worker contract is identical in both modes. The input plan placed AW-02 in M0. This review keeps the hosted-bot lifecycle as a gate for hosted M2 claims, while local backend work does not wait for it (chapter 13).
3. **Effects are change plans (ADR-A14).** Automation reuses per-agent Manual/Trusted policy, collection versions and Undo. No parallel approval system.
4. **Lean milestones.** M1 ships placement rules with no agent involvement and is useful on its own. Templates, broadcast, CEL and entity maps move to M4; scheduled batches, replay and extra executors to Later. Count batches stay in M3 together with run-once, which replaces historical replay for the common "organize what I already have" need.
5. **Verified facts replace placeholders.** Cookie `__Host-known_session`, header `x-csrf-token` with Origin allowlist, `Known-Command-Id`, flags `KNOWN_FEATURE_*` (not `COLP_FEATURE_*`), OpenAPI `fragments/`, web React pages (not a `features/*.ts` tree), the migration head and the ordering failure mode, pruned server classification. G2 is resolved; G8–G10 are new.
6. **Contract fixes.** `inputFields` no longer contains `abstract` (COLP has no such field; a worker fetches the page itself); `description` and `note` added. `broadcastAllowed` defaults to false in every non-broadcast example. Example descriptions and role names that were copy-pasted from the academic rule are corrected. New operations: pause, export, run-once preview and start. The research-catalog fixture uses placeholder entity labels instead of real people's names.
7. **Shared core inside `@know-n/colp` (ADR-A23, owner decision 2026-10-12).** No new npm package: the `automation` subpath is optional and outside conformance; one package release precedes the extension lockfile change.
8. **IDs that cannot collide** with the product plan (`AU-`, `AW-`, `AC-`), a glossary (Dot, Jev, worker, hosted bot), an open-questions list with owners and gates, a "matters needing attention" section, and build-time consistency checks between the stories, the tasks and the tests.

The 0.1.0-design pack is preserved unchanged at `~/ref/colp-automation-design-v0.1.0-design/` for comparison.

## Full product implementation path (not the local prerequisite chain)

For the full product, retain baseline/profile work and the Events compatibility spike. AW-02 gates hosted Events claims only; it does not block local M1 or polling. The new local execution order is chapter 13. M1 is AW-04 to AW-21 plus AW-33: shared core, rules API, web editor, facts and admission, extension pre-save and star-button paths, server-side intake. M2 is AW-22 to AW-32, AW-34, AW-35, AW-44 and AW-46: policy, claims, effect gateway through change plans, targets with wake mode on the Agents page, Events methods, callback verification and delivery, worker tools and both agent guides, release proof. The M2 proof is: arXiv → Academic with no folder request → receipt joined to the sync operation → one job in the summary-only fixture → a signed wake-up (possibly retried) → the hosted bot claims and submits → a change plan commits under the agent's policy → note and tags projected to both browsers → no re-intake; and the same job completed by a polling agent on a loopback server.

## Verification limits

This pack modifies documentation and contracts only. See chapter 08 for source provenance and validation/report.md for executed offline checks. All production acceptance tests remain planned. The shared-chat body and unsupplied local product-plan repository were not treated as readable evidence.
