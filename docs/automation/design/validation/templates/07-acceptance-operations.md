# Acceptance, Security, Operations and Rollout

**Important:** AC-01–AC-52 are required implementation tests, not tests executed while producing this pack. [validation/report.md](validation/report.md) records the checks actually performed on the artifacts. The matrix in §1 is generated from [acceptance-tests.json](acceptance-tests.json).

## 1. Acceptance matrix

{{ACCEPTANCE_MATRIX}}

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
