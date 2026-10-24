# Site adapter implementation and acceptance plan

Status: execution in progress; task results and blockers are tracked in [execution evidence](execution-evidence.md). Reviewed October 23, 2026 against COLP commit `364a124471da2bc1633e22b8936656e0ba28e865` and the uncommitted Bilibili evidence backfill. No production adapter runtime exists at this baseline.

Use this document to choose and finish the next implementation task. [README](README.md) owns architecture and invariants; [contracts.ts](contracts.ts) and [examples.ts](examples.ts) are draft protocol shapes; [Bilibili evidence](bilibili-feasibility.md) records observations, not integration acceptance. Change those documents together if implementation changes a contract. None of these documents grants permission to mutate a real site's account or a user's bookmark tree during testing.

## Start here

This Mac's [OrbStack runner is prepared and smoke-tested](local-environment.md). Use its commands and retained caches instead of rebuilding the environment from scratch. The user explicitly permits macOS ego-lite for real-site acceptance; automated Playwright suites still require Linux/xvfb.

1. Inspect `git status --short` and preserve existing work. Record the implementation commit and any working-tree changes relevant to the evidence. Recheck the touched integration points against the current checkout rather than assuming the review baseline is still current.
2. Start with SA-00 below, then SA-01 and SA-02. Use sanitized fixtures and a read-only inspector before enabling native writes. The standalone extension is a reference, not a runtime dependency to copy wholesale.
3. For each task, record the files changed, exact focused checks, actual outcomes, and remaining blockers. Complete its dependencies and exit criteria before enabling the next capability. A successful draft typecheck closes no runtime or real-site gate.
4. Keep development milestones distinct from release. The first internal slice is one Bilibili connection, one explicitly selected local root, `sourceAndSemantic`, and one confirmed addition to B. It still needs ingress validation, durable acceptance, reservations, native recovery, and zero model calls. The first distributable release still requires phases A–C, including the other copy policies and semantic integration.

Initial scope: bundled code on the tested `https://www.bilibili.com/*` origin, top-level non-incognito documents, video resources, local source settings, and browser rules. `space.bilibili.com`, non-video resources, DOM import fallback, background API reads, community installation, and cloud source management require their own evidence before activation. A missing capability is visible and unavailable; it does not justify broader permissions or silent fallback. Ordinary local saving remains available.

## Ordered work packages

Current task statuses are tracked in the execution evidence. SA-00–SA-07 are complete, with SA-02 explicitly limited to positive observation, av/BV video identity, and bounded read-only enumeration. Negative readback and human-action proof remain unavailable. Acceptance numbers below refer to the numbered [README matrix](README.md#implementation-sequence-and-acceptance); they identify tests a task must contribute, not results already obtained. Proposed module directories are listed in the [module map](README.md#module-responsibilities).

| Task / phase | Depends on | Implementation and existing touchpoints | Exit evidence |
| --- | --- | --- | --- |
| SA-00 / A: fixtures and contract decisions | None | Record prototype source fingerprints; choose the versioned Bilibili item/account/collection normalization; define closed runtime schemas and fixtures from the draft. Decide concrete read deadlines, byte limits, retry budgets, and queue limits before enabling reads. | Fixtures distinguish success, missing data, failure, partial traversal, and stale context; both accepted and rejected wire shapes are exercised. No IDs are inferred from labels or equal URLs. |
| SA-01 / A: bundled transport and lifecycle | SA-00 | Add classic adapter/probe build entries, optional scripting, narrow Chrome declarations, trusted storage setup, dedicated ingress/ports, leases, and disable/reconnect behavior. Touch [build](../../scripts/build.mjs), [manifest](../../manifest.base.json), [declarations](../../src/chrome.d.ts), and [management ingress](../../src/sw/messages.ts). | Controlled Chromium evidence for exact origins, sender validation, one initialization per generation, SPA/BFCache, stale replies, revocation, and page cleanup. Inspector produces no bookmark/model effects. Matrix 8, 9, 14. |
| SA-02 / A: Bilibili reader and confirmation | SA-01 | Implement `detectSource`, `resolveItem`, `readMemberships`, collection/item pages, and the bundled probe in the proposed Bilibili module. Follow the bounded page-reader sequence below. | Close or explicitly limit each Bilibili capability using gates A1–A6 in the evidence record. Import enumeration cannot stand in for negative membership readback. Matrix 5, 13, 22, 23. |
| SA-03 / B: durable source ledger | SA-00; SA-01 for transport integration | Add the separate source database, generation fences, observation receipts, import baseline/overlay merge, suppression, and item/folder reservations. Use the [existing IDB helpers](../../src/sync-state/idb.ts), keeping capture and Sync stores separate. | Fault tests prove commit-before-ack, same-request replay/conflict, live-during-import preservation, contradictory reports, and shared folder consumers. Matrix 4, 7, 17, 21, 23. |
| SA-04 / B: planned native execution | SA-03 | Add internal `executePlannedSave`, capture metadata migration, immutable command comparison, source outbox acknowledgment, folder intents, and receipt retention. Integrate [capture contracts](../../src/capture/contracts.ts), [store](../../src/capture/store.ts), [entry](../../src/sw/capture.ts), and [native recovery](../../src/sw/capture-native.ts). | Kill/restart around acceptance, command submission, and native receipt persistence. Unknown outcomes block replacement creates. Source archives bypass placement reevaluation and make zero folder/tag model calls. Matrix 12, 18, 19, 21. |
| SA-05 / B: rules and deterministic layout | SA-03, SA-04 | Add the v3 migration and source admission to [rule records](../../src/automation/rule-list-record.ts), [store](../../src/automation/rule-list-store.ts), [ordered evaluator](../../src/automation/rule-list-decide.ts), and [browser dispatch](../../src/sw/automation-browser.ts). Keep source fields outside the shared v1 Predicate. | Per-edge B/C admission, missing-root stop, source rename/manual edit fences, pause, and v1/v2 rollback/re-upgrade fixtures. Existing ordinary rule behavior remains covered. Matrix 1, 2, 6, 14, 15, 20, 24. |
| SA-06 / B: previewed import and live integration | SA-02–SA-05 | Add scan/checkpoint/preview/approval UI and bounded execution. Use [local import](../../src/local-import/coordinator.ts) as a recovery reference; retain source identity in the new source store. Join live and import effects through the same reservations. | Scan/ack/preview produce zero native import writes; stale approval cannot dispatch. Demonstrate partial preview, replayed page, live addition to an already-scanned collection, cancel, and restart-and-deduplicate. Matrix 4, 7, 17, 21, 25. |
| SA-07 / C: semantic binding and copy policies | SA-04–SA-06 | Add popup-first content binding, adoption, all copy policies, explicit existing-copy classification, and destination policy in [local taxonomy](../../src/classification-local-taxonomy.ts), [classification dispatch](../../src/sw/classification-local.ts), cache and application paths. | Both action orders under all policies, simultaneous source/semantic intents, manual selection, future descendant exclusion, and late/cached result rejection. Provider failure does not undo an archive. Matrix 2, 3, 10–13, 17–19, 22. |
| SA-08 / A–C: release and recovery | SA-01–SA-07 | Complete the site settings/inspector, repair/export, backup rebinding, capability reporting, supported-browser evidence, artifact checks, and small authorized real-site smoke. | Every applicable A–C acceptance case has evidence; no unsupported capability is advertised. Resolve all native-unknown results used by release fixtures or demonstrate the visible blocked state. All temporary services stop. |
| SA-09 / D: separately installed packages | SA-08 | Implement inert package validation, named USER_SCRIPT worlds, credential rotation, install/update consent, and revocation. Use the [distribution policy](README.md#package-provenance-and-installation-policy). | Package bytes/digest and grants are pinned; forged/stale and surviving-old-script messages cannot dispatch effects. Verify browser-version/toggle/update behavior, including matrix 16. Not a prerequisite for the bundled release. |
| SA-10 / E: account/cloud integration | SA-08 and negotiated backend contracts | Implement source admission, final-destination receipts, destination-policy enforcement, and cross-device authority with the backend owner. | Matrix 15 plus server/browser integration evidence. No generated JEV edits or root-as-final-parent receipts. Not a prerequisite for the local bundled release. |

Pure schema, ledger, and planning tests can progress while browser evidence is unavailable. They must use fixtures and keep their dependent live capabilities disabled. If SA-02 cannot establish stable identity or usable enumeration, pause the affected source capability; continue host work with fixtures rather than weakening its contract.

## Activation and injection sequence

Keep the setup path separate from the existing extension-page management channel:

1. In an extension page, enable the bundled site and request missing scripting/navigation and exact page-origin grants from that user action. Establish trusted storage access before injecting. Read-only inspection does not require an archive root; native archiving later requires bookmarks permission, a verified source connection, a root binding, and an enabled rule/policy.
2. Register the audited MAIN probe for `document_start` and the separate ISOLATED SDK/adapter bundle. Attach bundled code to already-open authorized documents with generation checks; show degraded observation/reload guidance when early requests were missed. Both injected artifacts are classic bundles, not the service worker's ESM output.
3. Run `detectSource` in the authorized page using a fixed, bounded account read. This happens before a lease exists: it must not call a host recipe that requires that lease. Before bootstrap, allow only the bundled detector's fixed account operation; no collection enumeration, arbitrary page-to-background proxy, bookmark writes, or model requests.
4. Send the source claim over the dedicated bootstrap channel. The host verifies sender/document/origin, registry version, enabled state, and the connected account. If the account is new or changed, present connection confirmation in an extension page; do not bind it from a viewed collection owner's ID. Only a matching source receives a document/route/source lease.
5. Open the verified port and invoke `start(ctx)`. The host issues page/identity/membership commands; the adapter replies with their exact identifiers. `AdapterContext.reader` / `NamedReader` is the optional host-recipe client. The initial Bilibili page reader is adapter-local code behind `detectSource` and the read methods, not a recursive call through that host client.
6. Enable live archiving separately from read-only inspection and separately from approving an import. On disable/account change/navigation, fence the affected work first, abort old contexts, and clean up scripts/listeners. A late reply cannot revive an old lease or expand approval.

The MAIN probe carries hints only. A fresh read can establish current membership but cannot prove that a human performed the reported action. Preserve the distinction between `favorite.confirmed`, existing `membership.observed` state, and an extension-owned capture request. Community execution follows SA-09; an official GitHub URL does not turn downloaded code into a bundled artifact.

## Bilibili reader implementation decisions

Use the observed endpoints in the [evidence record](bilibili-feasibility.md#evaluated-read-and-observation-path). These are implementation starting points, not current platform guarantees. The prototype's `/x/` page bridge, whole-response buffering, and worker-global caches are not the production reader boundary.

| Operation | Initial implementation rule | Failure / coverage rule |
| --- | --- | --- |
| Account detection | Fixed `nav` read in the granted page; project only sign-in state and stable account ID. Bind subsequent requests to the host-approved connection. | Signed-out/unknown or account mismatch invalidates automatic work; a public profile ID is not a logged-in account. |
| Collection catalog | Read the current account's catalog; preserve numeric source IDs separately from titles. Split the result into bounded SDK pages. | Missing/wrong-shaped `data.list` is `invalidData`, not an empty account. Cache loss invalidates local continuation. |
| Member enumeration | Read `resource/ids` using the observed request size of 1,000 IDs per API page; deduplicate resource identity and process bounded detail batches. | A duplicate-only/cyclic page, page budget exhaustion, malformed response, or uncertain termination is partial/error, never evidence of complete absence. |
| Item details | At most 100 IDs per request initially; project only supported item fields and stable canonical URLs. Keep original resource ID/type for correlation. | Distinguish invalid, unsupported, missing/inaccessible, and failed records. Do not interpret every `attr=1` as invalid or silently turn omitted details into complete coverage. |
| Live confirmation | Invalidate relevant cached membership data; perform a fresh scoped read for affected collections. Prioritize it between import requests through the same connection queue. | A successful write hint with delayed readback is pending/uncertain. Retries must fit the command deadline and source lease; failure is not a removal. |
| Absence/readback | Return exactly one present/absent/unknown edge per requested collection. Positive membership can use a fresh observed ID. | Default to `unknown` for a missing ID in best-effort pagination. Return `absent` only with separately validated fresh negative evidence for the requested scope; the prototype has not closed this gate. |

Keep API pages distinct from transport pages. The SDK currently proposes at most 100 entities and 512 KiB of UTF-8 JSON per page. A 1,000-ID API response must never be forwarded as a 1,000-entity SDK page. An adapter-local cursor can identify traversal, source page, and offset into a bounded buffer; a read command resolves only enough work for one bounded reply. Catalogs need the same splitting. Size limits apply even below the entity count limit.

Do not load an entire large collection before returning the first page. Cache only bounded intermediate data, bind it to the document/source generation, and use `restartAndDeduplicate` when that cache or page context is lost. Re-enumerate from the start and reuse host-persisted identities; do not apply the old numeric offset to a newly fetched list. Replaying an unacknowledged result in the same context returns the exact stored payload. Context loss issues new request identities under a fresh lease.

Use one request scheduler per connection across tabs, live reads, and import. Start with at least the observed 1.5 second spacing and one in-flight site request; this is a configurable conservative starting point, not a safe-rate guarantee. Live reads can take the next slot but cannot bypass pacing. Persist a cooldown deadline so a worker restart or new tab cannot reset it. Set explicit overall command deadlines and byte/page budgets; a timeout cancels the work rather than keeping a port alive indefinitely.

The host queue assigns bounded reads to one current document at a time; the bundled page reader enforces spacing within each command. Live hints enqueue confirmation reads instead of starting an independent fetch loop. Pre-bootstrap account detection uses a separate bounded site-activation budget because no connection has been established yet. This scheduling authority does not require background-origin fetch or expose an arbitrary fetch proxy.

Treat HTTP 412, business `-412`, and site challenges as visible pauses requiring later user retry. For 429, honor a valid `Retry-After`; if it exceeds the automatic retry budget, pause rather than shortening it. If the header is absent or invalid, use the configured backoff. Retry transient network/5xx failures only within the recorded attempt/deadline budget. Do not copy the prototype's immediate 412 retries. Offline, expired sessions, changed schemas, and unsupported reads stop the affected capability without claiming the source is empty.

All reads use fixed endpoint/method/parameter schemas, bounded response consumption before JSON parsing, and validated output. Do not replay `resource/deal`; the probe observes the site's write. If page CORS/session behavior changes, mark the reader unavailable. Background access or a DOM fallback is a separate evaluated capability, not an automatic escape path.

## Durable transitions and recovery

Use existing draft type names where defined. The state labels below describe behavior; SA-00 must close any missing runtime status/error schema before production code depends on it.

| Boundary | Persist before replying or dispatching | Resume behavior |
| --- | --- | --- |
| Observation acceptance | Envelope identity, payload digest, ordinal, and pending merge in one source-store transaction | Same identity/data returns the stored receipt; different data conflicts. Unacknowledged events lost with a page need later authorized reconciliation. |
| Import page acceptance | Correlated page digest, merge work, next cursor, and page receipt in one transaction | Replay cannot advance twice. A lost page context restarts enumeration with identity deduplication; late pages cannot extend a frozen preview. |
| Preview freeze | Collected-set digest, omissions/coverage, logical effects, dependency references, and pinned snapshots | Scanning is stopped. No write permission exists; changing the set, rule, policy, or affected ledger state requires a new preview. |
| Import commit | Exact preview ID/revision/digest and extension-page approval | Only covered effects can dispatch. A separately authorized live effect can make an unsent import effect stale and require preview refresh. |
| Native submission | Shared reservation/consumer, stable command ID, resolved payload digest, and outbox state | Retry the same command against durable executor receipts. Never replace `submitted`/`unknown` work by searching titles or URLs and creating again. |
| Native completion | Proven native receipt, representation binding, and source outbox acknowledgment | Keep executor receipts until acknowledged by the source store; pruning capture history must not break crash recovery. |
| Disable/cancel | Authorization/generation fence and stopped unsent work | Preserve confirmed writes and record late results. Cleanup is best effort; it is not the mechanism that revokes host effects. |

For a live addition during an import, durably accept it even if its collection was already scanned. The import's baseline protects newer live changes, and both paths join the same representation/folder reservations. No global `activeRun` branch may discard live work. If the live effect finishes after preview freeze, refresh the affected import preview rather than authorizing a duplicate or silently changing its digest.

| Visible condition | Allowed next action | Never do |
| --- | --- | --- |
| `sourceUnresolved` / signed out | Confirm or sign into the source, establish a new lease, and resume reads | Continue under a different account's connection |
| Rate limited / challenge | Stop reads, show cooldown/retry, retain accepted work | Tight retry loops, extra tabs to bypass pacing, or cookie copying |
| `pageUnavailable` / stale context | Reconnect or reload; restart-and-deduplicate when continuation cannot be proved | Accept the old lease's reply because navigation was expected |
| Partial / unsupported extraction | Show omissions; allow a frozen partial preview only after scanning stops | Treat missing entries as deletions or claim full coverage |
| Stale preview / changed root or rule | Regenerate and approve a new preview for unsent work | Reuse the old approval for different destinations or added items |
| Unknown native outcome | Recover the existing command/receipt or show manual review | Blindly create another folder/bookmark or release its reservation |
| Manual move/delete | Keep detached/suppressed state; offer explicit repair/adoption | Recreate a suppressed copy on the next import |
| Schema/version incompatibility | Disable dispatch and offer read-only repair/export | Reset the database or downgrade its schema to force activation |

Rollback starts by disabling adapter admission and unsent dispatch, then reconciling issued commands and preserving receipts. Restore previous bundled code only when its source/capture schemas are compatible. Otherwise keep source data read-only until a compatible build returns. Never lower generations, replay a backup outbox, delete unknown work, or restore v3 source rules into v2. The existing migration design also requires detecting legacy rule edits made while rolled back.

## Validation commands and evidence

Run commands from `packages/extension` unless noted otherwise. Use the lockfile's Node/tool versions and the repository's normal dependency setup; do not upgrade dependencies to make a documentation check pass. This checkout may have no `node_modules`; verify the executable exists before running a package-local command. Do not run the root `npm test`, the full extension `verify`, or broad E2E suites for documentation-only changes.

Documentation and typed examples:

```sh
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext --lib ES2023,DOM docs/site-adapters/contracts.ts docs/site-adapters/examples.ts
git diff --check -- docs/site-adapters
```

Check relative file links and heading anchors, including links in newly added/untracked Markdown. These checks validate documentation consistency only.

For implementation work, add focused tests for the new behavior, then select only the existing regression groups affected by the change:

| Changed boundary | Existing focused checks to extend/select |
| --- | --- |
| Permissions / build / ingress | `tests/manifest-security.test.ts`; after updating the exact permission contracts, run `npm run build` and `node scripts/verify-release-artifact.mjs dist/production`. The release verifier rejects development source maps. |
| Ordered rule migration / evaluation | `tests/automation-rule-list-store.test.ts`, `tests/automation-rule-list-decide.test.ts`; add source admission and rollback cases |
| Capture / native execution | `tests/capture-contracts.test.ts`, `tests/capture-pre-save.test.ts`, `tests/capture-native-existence.test.ts`, `tests/capture-apply-recovery.test.ts`; add planned-effect/folder crash cases |
| Destination policy / semantic copy | `tests/classification-local-taxonomy.test.ts`, `tests/capture-local-automatic.test.ts`, `tests/popup-classification-rule.test.ts`; add both action orders and forbidden cached/late results |
| Import / backup | `tests/local-import.test.ts`, `tests/local-backup.test.ts`; add source preview, suppressed copies, and disabled restored connections |

Invoke selected unit files with `node_modules/.bin/vitest run <explicit-test-files>`. The existing files are regression coverage, not substitutes for the new adapter tests. Record new test filenames when they are actually created; do not report a proposed filename as a passing check.

Automated Playwright/E2E execution must actually run under xvfb. The current [wrapper](../../scripts/with-xvfb.mjs) uses xvfb only on Linux and bypasses it when `KNOWN_E2E_HEADED=1`; invoking the wrapper on macOS does not meet the project instruction. Use the [prepared OrbStack runner](local-environment.md#commands-for-the-next-agent), which forces xvfb and provides xdotool for permission prompts. Otherwise mark automated browser acceptance unrun and continue fixture/unit work. Do not run Playwright directly on the current macOS host. The user's task-specific authorization separately permits real-site acceptance through macOS ego-lite.

For a focused browser run on that Linux runner, after building the artifact required by the selected spec:

```sh
test "$(uname -s)" = Linux && command -v xvfb-run && test -f "$SITE_ADAPTER_SPEC" && env -u KNOWN_E2E_HEADED xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' node node_modules/@playwright/test/cli.js test --project=core "$SITE_ADAPTER_SPEC"
```

Set `SITE_ADAPTER_SPEC` to one actual focused spec under `e2e/`; the file check prevents an empty selection from running the whole suite. Keep fixtures local and use the repository test harness for any necessary services. Stop test-launched browsers, contexts, and temporary services in teardown, including failure/cancellation paths; never stop unrelated user processes.

For real-site smoke, use ego-lite according to its installed skill, a small authorized account scenario, and a dedicated disposable local bookmark root. See the [real-site handoff](local-environment.md#real-site-acceptance-through-ego-lite) for authorization and readiness limits. Record native-UI actions separately from direct page-side API calls. Reuse the existing large import evidence as feasibility context; repeating thousands of writes is not an acceptance prerequisite. Keep account IDs, cookies, tokens, private titles, and full responses out of committed artifacts.

Each completed task should leave a concise evidence entry with these fields:

```text
Task / acceptance cases:
Implementation commit + relevant working-tree diff:
Adapter version/digest; fixture revision or site observation date:
OS/browser/version; execution world; actual xvfb runner (for E2E):
Preconditions and enabled capabilities:
Exact commands or authorized manual steps:
Expected / actual result; local evidence paths:
Coverage: unit / controlled browser / real site / not run:
Remaining limitations or blocked capability:
Cleanup result; next task:
```

For SA-08, map every matrix item to its evidence entry. Matrix 16 belongs to the deferred community release; matrix 15 still requires local rejection of unsupported cloud behavior, with positive cloud execution deferred to SA-10. An explicitly unavailable readback capability leaves conflicts unresolved; an untested negative result cannot be advertised as supported. Claims about the minimum Chrome version need matching browser evidence or an explicitly recorded unsupported range before release.
