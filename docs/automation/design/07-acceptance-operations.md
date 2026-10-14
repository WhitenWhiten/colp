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
