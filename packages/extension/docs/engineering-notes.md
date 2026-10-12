# Know-N extension: engineering notes

Implementation notes for contributors. The user-facing overview is in [README.md](../README.md).

Session-issued checkpoint cursors are treated as acknowledged when adopted at a confirmed
boundary or during authority refresh. The durable cursor records `evidence.sessionAuthority`,
and the engine records the same token in `lastPublishedCursor` and `lastAckedCursor`.
Further idle renewals may use that confirmation without a client-sent Ack; pending Acks,
incomplete Pull pages and unknown native results still block ordinary Session handoff.


Manifest V3 bookmark manager and optional browser connection for Know-N. Manual
and automatic saves, browser bookmark management, local history, HTML import and portable backups
work without a Know-N account or collection. Saving checks only native duplicates
and never waits for the server. AI folder suggestions and cloud sync are optional;
Know-N classification requires separate spending authorization. First launch
opens the browser's bookmarks.

Bookmarks → Export provides a portable HTML file or a versioned Know-N JSON
backup with folder descriptions, local history, device preferences, language and
AI configuration. Import restores into a new folder and keeps existing bookmarks.
Settings restore is optional and starts saving in manual mode. Keys and account
credentials are excluded; AI must be connected again. Restored history is read-only
and never replays commands. Backups support up to 32 MB and 100,000 records.

The build environment is selected explicitly:

```text
npm run build
npm run build:staging
npm run build:development
```

The `mv3-smoke` CI job also runs `npm run test:e2e:local-first` under xvfb. It covers
guest offline saving/import, native batch editing and deletion recovery after a
browser restart, stale folder-delete confirmations, accounts without a collection,
and a manual save while cloud session renewal remains pending. Connecting a sync
collection is an explicit settings action; the save popup never changes the binding.

Operators packing the latest production zip:

```text
npm run package
```

That compiles `dist/production`, verifies the release artifact, and writes `dist/known-extension-<version>.zip` with the files at the zip root, ready for the Chrome Web Store. Pushing an `extension-v<version>` tag runs the same steps in `.github/workflows/colp-extension-release.yml` and attaches the zip to a GitHub release.

## Store listing: optional host permissions

The extension declares optional host permissions for `https://*/*` and `http://*/*` so an owner can connect it to a bookmark server whose address is chosen after install. Chrome allows a later permission request only for a host pattern listed in the manifest, and a self-hosted origin is not known when the extension is published, so those two optional patterns are the declaration. They do not grant access to every site. Required host permissions stay the Know-N origins fixed at build time and are not moved into the optional list. When the owner saves a server in Options → Account, the extension requests only that one origin (`<scheme>://<host>/*`) from the save gesture, and Chrome prompts for that host alone. The extension has no content scripts and does not read or change other pages. The grant is used only to reach the chosen server for its protocol manifest, sign-in, and bookmark sync. Disconnecting that server removes the optional grant. `http://*/*` exists so a server the owner runs on their own computer can be granted the same way; the extension does not use it to browse the web.

Each artifact embeds one validated server/issuer configuration. Production source maps are disabled. The options page and service worker communicate through the closed `known.auth.*` message protocol; raw credentials never cross that boundary.

`npm run evidence:phase3-extension-auth-shell` builds the production artifact, loads it as an unpacked extension in Chromium, and scans the final files. It must fail when Chromium or the artifact is unavailable.

P3-29 keeps bookmark access optional. Only a trusted options-page action can grant or remove it; the worker checks
the current permission before every tree read. The options page receives a redacted folder view with ephemeral
references and can atomically configure selected and private-local boundaries in the P3-28 store. Revocation
preserves that authority, and regrant reconciles only the same Chrome native identity without guessing a replacement.
P3-30 registers listeners for the four Chrome bookmark mutation events and captures them only while the optional
permission is present. An allowed event is first filtered against the P3-29 boundary, then assigned a durable ingress ordinal. Folder,
Bookmark and Separator changes become one schema-validated COLP Operation each. The event inbox, sequence,
Operation, trusted projection dependency, mapping transition and outbound queue record are committed through the
P3-28 IndexedDB authority. Worker startup drains accepted events left pending by termination; wall-clock time is
Operation metadata and never the ordering authority.
Because `create_node` uses a server-selected Node ID, an event behind an unconfirmed local create, update, or move
remains in the durable ingress inbox. It receives no sequence or Operation ID until the provisional mapping is
replaced by the authoritative target ID and revision. No `pending-*` identity or `local-*` revision enters a COLP
Operation.

Ingress ordering is domain progress, not a global stall (N-3, D-09). A placement that can still commit — blocked in
the inbox, or quarantined until dependency evidence changes — occupies its target parent, source parent, sibling
anchor, and same-parent reorder domain. A later placement that shares any of those cannot take an earlier sequence.
Two moves that reuse the same afterId cannot commit in reverse, and different targets that only share a parent
cannot pass each other. A targetId-only link is not that domain. An unrelated parent keeps progressing on this flush
and on later flushes, so a rejected dependency or a quarantined placement does not permanently block an unrelated
domain. A deterministic poison draft, or a quarantine whose dependency was rejected, never pins a domain: it will
not take a sequence ahead of later work. Content edits are not a placement domain.
The Operation validators are standalone code generated from the public `@know-n/colp/schema` entry;
the build fails on schema drift and the MV3 worker never performs Ajv runtime compilation or dynamic evaluation.

P3-31 drains one durable Operation at a time through the Manifest-discovered `syncPush` endpoint. A Replica-scoped
IndexedDB lease and monotonically fenced claim arbitrate alarms, startup, online wakeups and multiple extension
contexts. Timeout, disconnect and malformed/5xx outcomes retain the original opId, sequence, batchId,
Idempotency-Key, digest and Operation bytes. Terminal/deferred receipts and gap/blocked/unknown recovery state are
committed atomically with the queue transition. A terminal create result may replace its provisional browser mapping
only in that same transaction when the event, queue Operation, target identity and revision all prove the binding.

This stage does not call compact event batches, automatically resolve Conflicts, or declare a `sync` Profile claim.

## CI execution scope: which specs run under the default gate

`.github/workflows/colp-ci.yml` runs the `extension-sync-real-stack` job,
which executes `test:sync-real-stack` and then `npm run evidence:critical-mv3`. That
job is listed in `ci-gate`'s `needs`, so `evidence:critical-mv3` is the default CI
Playwright gate for MV3 journeys. `evidence:critical-mv3:inner` runs eight specs, in
this order:

```text
1. mv3-auth-shell.spec.ts            5. mv3-outbound-push.spec.ts
2. mv3-popup-save.spec.ts            6. mv3-durable-sync-engine.spec.ts
3. mv3-bookmark-manager.spec.ts      7. mv3-bookmark-event-queue.spec.ts
4. mv3-pull-applier.spec.ts          8. mv3-remote-delete-policy.spec.ts
```

`evidence:critical-mv3` builds with `config/e2e-fixture.json` and wraps the run in
`../server/scripts/with-postgres.mjs`, so the isolated Postgres database every
spec needs through the `e2e/real-stack.ts` fixture is provided by the wrapper and must
not be set up inside a spec. `with-xvfb.mjs` supplies the X server for the headed
Chromium profiles. After the eight specs the same script runs
`scripts/verify-release-artifact.mjs dist/production` and
`scripts/verify-bookmark-privacy-artifacts.mjs test-results`; the privacy scan fails
closed when `test-results` is empty, and it now also scans the traces, screenshots and
JSON reporter output of the four specs added here.

The four specs added in `B3-5` (`mv3-outbound-push`, `mv3-durable-sync-engine`,
`mv3-bookmark-event-queue`, `mv3-remote-delete-policy`) previously ran only through
their own `evidence:phase3-*` / `evidence:remote-delete-policy` scripts. Those scripts
run the same Playwright spec against the same fixture build plus the same artifact
verifiers, so the promotion adds those four specs to the default gate and nothing
else. Two details are deliberate:

- `evidence:phase3-durable-sync-engine` additionally runs
  `npm run test:phase3-durable-sync-engine` (the engine and store contract unit
  owners). Those suites produce no artifact the spec consumes and are not a runtime
  prerequisite, so they stay out of `evidence:critical-mv3:inner`; they still run in
  the extension `unit` job.
- `evidence:phase3-bookmark-events` additionally runs
  `verify-bookmark-privacy-artifacts.mjs`; `evidence:critical-mv3:inner` already runs
  that verifier, so it is not duplicated.

Because `evidence:critical-mv3:inner` now covers eight browser journeys in one
sequential `workers: 1` run, the `extension-sync-real-stack` job's 40 minute
`timeout-minutes` budget is the limit to watch when these specs grow. The workflow
itself needed no edit for this promotion: `extension-sync-real-stack` already runs
`npm run evidence:critical-mv3` and is already in `ci-gate`'s `needs`, so extending
the `package.json` spec list is enough to reach the gate. The step name in the
workflow still says "auth, popup, bookmark manager and pull journeys" and is now
narrower than what the step runs.

### `mv3-multi-device-recovery` stays out of the default gate

`e2e/mv3-multi-device-recovery.spec.ts` is not part of `evidence:critical-mv3` and
must not be added to it as-is. It is excluded from a plain `npx playwright test` run
by `playwright.config.ts`:

```ts
...(process.env.KNOWN_P3_38_RUNTIME ? {} : { testIgnore: 'mv3-multi-device-recovery.spec.ts' })
```

Its actual execution site is Know-N's backend CI, step "Phase 3 real extension
recovery artifact". Know-N's `phase3-multi-device-recovery-acceptance.mjs` runs it
against this package under `with-postgres.mjs --tls --isolated-owner`, and Know-N's
`phase3-evidence` job supplies the environment that step needs.

Cost of also putting it in `evidence:critical-mv3`: **not viable at low cost.** Three
blockers, each verified against the current sources:

1. The spec is un-runnable without a runner-provided environment. Its module body
   reads `KNOWN_P3_38_RUNTIME` and throws `runner_runtime_missing` when unset — the
   throw happens at module load, before any test body runs. It then consumes a runtime
   JSON (`origin`, `spki`, `extensionId`, `hostname`, `artifact`, `result`, `console`,
   `network`, `problems`, `screenshots`, `traces`, `markers`, `timeline`,
   `managedPolicyInHost`, `retentionAdvanceToken`, and more) plus `KNOWN_P3_38_SEED`.
   Only Know-N's `phase3-multi-device-recovery-runner.mjs` produces that
   runtime and those artifact paths, so `evidence:critical-mv3` would have to invoke
   the runner instead of `npx playwright test`.
2. It needs the full backend authority, not just a database. The acceptance run starts
   the real API (`dist/src/bootstrap/api.js`) with an OIDC issuer, generated keys and a
   managed policy, and drives pull-cursor TTL and lease expiry over the wire. That is
   Postgres plus a built backend server; `evidence:critical-mv3` only wraps the
   Playwright run in `with-postgres.mjs` (without `--tls`/`--isolated-owner`) after
   building the extension.
3. It is a long acceptance stage with fail-closed evidence rules
   (`phase3-multi-device-recovery-bindings.mjs`: `recoveryWaitMs` 601000,
   `PHASE3_ACCEPTANCE_LEASE_SECONDS` 600, evidence output refused when it already
   exists). It does not fit the `extension-sync-real-stack` job's 40 minute budget or
   its "extension e2e" semantics.

The spec is therefore gated by the Know-N backend job that owns its runner
environment rather than by `evidence:critical-mv3`.

Preconditions before this spec can enter the default extension gate: the
`extension-sync-real-stack` job would need to (a) install and build a pinned backend
artifact and a Playwright `backend-extension` toolchain, (b) run the P3-38 runner in
place of the raw `playwright test` call so `KNOWN_P3_38_RUNTIME` and the
`KNOWN_P3_38_*` artifact paths exist, (c) provide `DATABASE_URL` for
`--tls --isolated-owner` Postgres, and (d) carry a timeout budget above the 601 second
recovery wait plus the release-artifact and privacy verifiers. Until all four hold,
leaving the spec under `KNOWN_P3_38_RUNTIME` and running it from Know-N's backend
CI is the policy.

## Web preview of the popup

know-n.com serves a static, clearly labelled preview of this popup
(`/extension/popup`) for visitors who have not installed the extension. It shows
structure only — field labels and button copy — and must not copy popup logic or
hard-code internal sizes or version numbers. When `popup.html` gains, loses or
renames a field, tell the Know-N web maintainers so the preview changes with it.

## Languages

The extension ships English (`_locales/en`, the default) and Simplified
Chinese (`_locales/zh_CN`). Chrome picks the catalog from the browser's UI
language; there is no in-extension switch.

- Copy stays English at the call site: `t('area_key', 'English with $1', value)`
  and `tn('area_key', count, '$1 item', '$1 items')` from `src/i18n.ts`, or
  `data-i18n="key"` / `data-i18n-<attribute>="key"` in the HTML pages. Keys and
  English must be literals.
- The pinned language (Preferences) is fetched asynchronously, after modules
  evaluate. Never keep copy in a plain module-level `const X = t(…)`: assign it
  in `localized(() => { X = t(…); })` to an `export let`, and put anything derived
  from it in the same callback. The page bundles start from `src/entry/*.ts`,
  which wait for the language before loading the page module.
- `npm run i18n:write` regenerates `_locales/en/messages.json` from that copy;
  never edit it by hand except the manifest entries (`__MSG_…__`).
- Each Chinese entry keeps the English it was translated from as its
  `description`. `npm run check:i18n` (also in the unit tests) fails when the
  English catalog is stale or a Chinese entry is missing, stale or has
  different `$n` substitutions. `node scripts/i18n-catalog.mjs --todo` lists
  what needs translating; `--apply zh_CN <file.json>` merges `{ "key": "译文" }`.
- `import-preview.ts` must not touch `chrome`, so its warnings stay English
  there and are translated where options shows them (`importWarningCopy`).


## Replica rebuild and durable local decisions

A missing native Pull target or anchor stops at an explicit local-repair state.
Refreshing an active server Session cannot repair that Chrome identity. The
popup and Folders settings offer **重建本机同步副本** for this state and for
terminal identity or transport-budget failures. The preview reports unfinished
queue operations; confirmation archives the old local scope, including pending
reorders, then registers a new replica and opens folder/merge setup. Chrome
bookmarks and cloud contents are retained. Archived operations are not blindly
replayed; the user reviews the new sync boundary and merge preview. The old
server replica is left to its existing lease lifecycle.

The rebuild journal resumes after worker restarts and registration failures.
A journal from a revoked authority or another account cannot replace the current
binding. Scope retirement archives and removes its scoped diagnostic/reorder
rows as well as queue, mapping and receipt records.

Native-wait confirmation claims the original durable intent before Chrome create.
Cancellation is a terminal user decision; old settings tabs cannot bind/create
through the cancelled reference. A typed native id must exist under the expected
active, non-private parent and match the remote node before binding.

Same-parent reorder targets are durable before capture reports `staged`. Moves
are saved as individually bounded records in the same transaction, so a large
sibling set does not become one oversized operation record. Partial staging
replays the immutable events; returning to the baseline cancels the buffered
target. A failed timer flush schedules bookmark recovery. MV3's 30-second alarm
floor is a lower bound, not a maximum wait.

### Optional local classification

Preferences → Saving offers **Automatically generate suggestions in Manual mode**, off by default and saved for this browser. When enabled, each toolbar popup requests suggestions once from the selected local or server provider; server requests include the displayed credit quote. The user still chooses the suggested folder and tags, then saves explicitly. Editing the form or receiving an uncertain result never automatically starts another request. **Go to local classification** jumps directly from the manual-mode options to the provider settings. An enabled local provider shows a bold status and hides the already accepted disclosure checkbox; switching back to server classification restores it.

Local classification is local-first and compiled on by default: the options panel (Preferences → Classification) and origin-scoped requestable host permissions ship in every build. It needs no Know-N account, collection or sync — only the user's provider key. `KNOWN_EXTENSION_CLASSIFICATION_LOCAL=false npm run build` builds without them. It supports four presets, each of which fills the endpoint, the model and the model candidates while keeping every field editable:
1. **TypeSafe (api.typesafe.ai)**, the default: Connects straight to `https://api.typesafe.ai/v1/systemone` with the user's own TypeSafe key.
2. **Cloudflare AI Gateway (BYOK)**: Connects to Cloudflare AI run. The upstream provider key (e.g. TypeSafe key) is configured directly in the user's CF Gateway under alias `default`; the extension only holds the Cloudflare API token.
3. **Vercel AI Gateway**: Connects to `https://ai-gateway.vercel.sh/typesafe/v1/systemone` (TypeSafe-compatible API) with the user's AI Gateway key and the `typesafe-ai/jev` model.
4. **Custom endpoint**: Connects to any user-specified endpoint that adheres to the classification request/response contract. Only response shape validation is performed. HTTPS is required for public hosts; plain HTTP is accepted only for loopback, private-range and `.local` hosts so a self-hosted classifier can run on the same machine or LAN, and the panel warns that the token and bookmark text then travel unencrypted.

The Cloudflare preset speaks Cloudflare's `{model, input}` envelope; the other presets post `{state, questions, model}` to `/v1/systemone`, so a custom endpoint must implement the native System One shape.

The options panel provides a "Test connection" button that executes a fixed synthetic probe to verify connectivity and immediately surfaces exact failure causes (such as HTTP 404, HTTP 422, or response schema mismatches). Host permissions are requested dynamically per exact origin pattern (`<scheme>://<origin>/*`). Arbitrary header templates, OpenRouter preset, bundled local shims, background provider retries, local automatic tags and local batches remain explicitly out of scope.

The options panel requires data disclosure and a trusted permission gesture. The API key and provider configuration persist in their own `chrome.storage.local` entry (schema v3), readable only by extension pages and the worker (the extension has no content scripts); the key never enters a Product/COLP request, IndexedDB, `storage.sync` or a page message, and a key left in `storage.session` by an earlier build is migrated on first read. The key belongs to this browser profile and the provider origin, not to an account or collection, so it works signed out and survives browser restarts and account or collection switches; re-opening the options page shows a saved key as a placeholder, and leaving the field blank keeps it for the same provider host. Switching back to server classification keeps the key but releases the provider's host permission, so it is unusable until local mode is enabled again (which re-requests the permission and reuses the saved key). A missing key never silently sends a preview through the server instead. The options page can explicitly switch back to server classification.

Local suggestions choose among this browser's own folders — the same set the popup picker offers (managed and read-only subscription subtrees are skipped; the built-in roots act as containers, capped at 10000 folders) — and return a native folder id the popup selects directly. The popup (`known.classification.local-preview`) shows the suggestion whether or not the user is signed in. When a collection is synced, a successful sync cycle may also cache a read-only projection (collection title, folder descriptions, tag vocabulary; bounded to 10000 nodes / 4 MiB / 60 seconds fresh). It only enriches local mode: descriptions are mapped onto native folders and tag suggestions appear; a missing or stale projection just means folder-only suggestions. Tags still need a synced folder to be saved, so a local-only save keeps the folder and drops the tags. Automatic save mode uses the same provider: with local mode on, each automatic save is classified over the browser's folders and the bookmark is moved into the chosen folder straight away (a `later` decision leaves it where it was saved). No account, collection, authorization or credits are involved; the user can still change the folder from the result panel, Saving › History or Know-N. Local classification runs on its own work lane, outside the Know-N authority fence, so signing out or in never fences or aborts it; an unexpected failure leaves a readable reason rather than a save stuck waiting. A user edit before the move wins, and a worker restart mid-call never repeats the provider request. Same-session command markers persist before dispatch and never retain raw provider responses.

Browser candidate/prompt/decision code in `src/generated/classification/` is generated from the Know-N server's pure policy. Know-N owns the generator and checks drift in its backend CI against this package; frozen fixtures there compare the exact request bodies and decisions. Do not edit the generated files here. No Extension production source imports backend application or SQL. Controlled Chromium/PostgreSQL acceptance is separate from the still-closed live-provider rollout gate.
