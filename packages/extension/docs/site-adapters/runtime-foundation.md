# Reusable site adapter foundation

## Shared saving contract (October 25, 2026)

All adapters report source facts; the host owns copy policy, classification, bookmark creation and ordinary synchronization. A sync-range folder is a valid destination. The public workflow is one configuration and one import approval, independent of where synchronization executes the durable create.

The portable managed-copy identity is defined in `src/site-adapters/copy-identity.ts`. Within a destination library, a source copy is identified by site/identity version/content, source account and source collection. Each selected collection gets its own copy. A semantic copy is shared by content within that library and never uses a source collection as its identity. Private/account-local content includes the account in content identity. Native IDs, device IDs, rule IDs, titles, URLs, mapping paths and adapter installation IDs are not portable identity. One source collection has one active mapping per library; changing its folder is migration, not a new identity.

The saved-copy association and manual suppression must be shared across replicas. Authentication, page leases and executable native commands remain device-local. Sync-range creates require online coordination before native projection; offline work waits without creating competing copies. Unknown writes recover the original operation instead of issuing a replacement. User moves/edits preserve the bookmark and detach automatic placement; user deletion suppresses automatic reconstruction across devices. Source membership removal retains saved bookmarks. Partial reads never prove absence.

Allowing both purposes does not itself authorize classification. Automatic semantic creation is an explicit setting, uses the existing local classifier, excludes every mapped subtree, and has separate progress/retry from source saving. A failed classification never rolls back or repeats a successful source save. Source configuration changes and account/library changes fence pending writes. Legacy associations are adopted only with proof; ambiguous copies, missing receipts and changed roots remain reviewable.

Implementation is delivered as separate validated commits: portable identity; shared creation and recovery; normal save/import routing; semantic scheduling; user-edit/suppression handling; migration and configuration fences; browser acceptance.

Implemented October 24, 2026 following the foundation review. Bilibili remains the only implemented adapter. Isolation tests cover metadata and persisted records. Additional contract regression tests use a test-only DOM/post adapter with nonnumeric IDs, negative readback and stable cursors; it is not registered or shipped as a supported site. Site capabilities still require their own evidence before activation.

## Runtime and registration

[registry.ts](../../src/site-adapters/registry.ts) is the audited host composition point. Each [SiteDefinition](../../src/site-adapters/registry-types.ts) supplies identity/version, exact HTTPS matches, canonical identity checks, supported operations, script entries, resume strategy and optional read policy/community network origins. Unknown identities are unavailable. Duplicate installations/identity namespaces, unsupported host capabilities and invalid budgets are rejected by [registry validation](../../src/site-adapters/registry-validation.ts).

[Bilibili's adapter](../../src/site-adapters/bilibili/adapter.ts) implements the actual [SiteAdapter contract](../../src/site-adapters/contracts.ts). [content.ts](../../src/site-adapters/content.ts) composes its page factory with [page-runtime.ts](../../src/site-adapters/page-runtime.ts). The common runtime owns bootstrap, account checks before/after reads, lease renewal, reply correlation, command replay, deadlines, cancellation and cleanup. Site-specific HTTP operations and extraction stay under `bilibili/`.

[page-context.ts](../../src/site-adapters/page-context.ts) provides delegated events, scoped observers, bounded waits and cleanup. The registry currently permits observation, resolution and enumeration; injected capture controls and named background recipes are unavailable host capabilities, even if authored code requests them. A new site using DOM extraction can use the SDK without receiving bookmark/model authority.

Each host instance is constructed from its definition. Settings select the installation using the `adapterId` query parameter and management envelope. Script registration checks actual matches, worlds and entry paths rather than trusting an existing registration ID. The transport validates exact registered URL paths and aliases. Installed community packages resolve to an audited identity/permission profile; they do not extend the registry or choose native destinations.

## Identity and isolation

- Installation-scoped state: activation/read scheduling, leases, generation fences, inspection/catalog state, confirmation pause/queue, active import, cloud selection and recovery alarms. Existing Bilibili storage/port names are retained solely for compatibility.
- Connection identity: `(siteKey, identityVersion, accountId)`, with a stable connection ID. Authority is looked up by the actual connection, never by the currently selected settings page.
- Content identity: `(siteKey, identityVersion, itemId)`, independent of the source account. Semantic bindings, manual-edit handling and inspector queries use the complete identity.
- Shared execution: native commands, reservations and receipts remain in one private source database. Recovery wakes coalesce so installations cannot race the shared durable recovery cursor.

Source schema **3** adds an installation/state/ordinal observation index, an indexed connection lookup and versioned content-binding keys. Existing native proof, receipts, commands and unknown outcomes remain intact. Legacy connection keys are upgraded transactionally when their authority is next established. Database access is lazy; blocked upgrades can retry and abandoned open requests close their eventual handles. Unknown future schemas remain read-only/exportable.

Portable source section **v2** carries site/version explicitly; the surrounding bookmark backup remains v1. Old source v1 backups still parse as the legacy identity. Unknown source identities can be preserved as inert metadata, but cannot gain authority through restore. Rebinding validates the selected identity, account, exact imported root and fresh native proof. Gates for equal account IDs in different namespaces are independent.

## Planning and recovery invariants

AI eligibility changes invalidate old plans but do not invalidate an unchanged folder's historical creation receipt. Current root identity and policy are checked separately from that immutable receipt.

A source plan intent is persisted before folder/item reservations. Cancellation can therefore find preparation interrupted before either the plan or frozen-page checkpoint was written. Cancellation, consumer revocation and release occur in one transaction. Only reserved, never-submitted work with no remaining consumers is reclaimable; submitted/unknown commands retain their original identities and receipts. Cancelled intents cannot be revived by late preparation.

Restart-and-deduplicate resets traversal cycle history while retaining accepted entity identities. A registered stable-cursor reader resumes the last acknowledged cursor under a fresh lease. A stale cursor forces restart. Cursor-cycle detection still applies within each traversal.

Host deadlines settle reads even when adapter code ignores its signal. Timed-out contexts are discarded, preventing late replies from changing the current read. Installation read policies can adjust spacing, command/activation deadlines and attempt budgets within host bounds. Pacing remains durable across worker reconstruction.

Queries apply connection/identity scope before pagination budgets. Bounded dependency reads fail visibly at capacity rather than treating truncated results as a complete dependency set.

## Cloud identity contract

[Server identity registration](../../../server/src/modules/source-archives/site-registry.ts) owns canonical account/collection/item validation. The transaction and reservation implementation no longer contains Bilibili URL logic. Only Bilibili v1 is currently registered.

The server advertises supported identities in `profile.sites`. New identities must negotiate an exact site/version before submission. Requests that address a source account can additionally carry the paired `site` and `identityVersion` fields. Legacy requests without them address only Bilibili v1. Cloud connection, folder and copy keys include the namespace; historical Bilibili keys and immutable command digests remain compatible. Recovery/cancellation continue to address the original plan/digest, including after revocation.

## Adding a future adapter

1. Implement the bounded `SiteAdapter` in a site-local directory, with a canonical identity codec and validated message semantics.
2. Register its audited `SiteDefinition` and page factory. Add a classic build entry only if the site needs a separate entry/probe bundle. The current shared page bundle may compose multiple factories.
3. Declare only implemented/qualified capabilities, exact origins/paths, read budgets and resume behavior. The settings, ledger, import, native planner and semantic binding code need no site-specific branches.
4. If cloud support is desired, register the corresponding audited server identity codec and qualify that capability separately. Community support likewise requires an explicit registered network/identity profile.
5. Run focused contract/lifecycle/import/recovery checks with sanitized fixtures; apply real-site gates only with appropriate authorization.

The remediation and exact validation commands are recorded in [foundation evidence](evidence/foundation-remediation.json). No X or YouTube adapter was added.

## Review-fix commits

| Commit | Change |
| --- | --- |
| `41f79422` | preserve source folder reuse across AI policy changes |
| `e50af734` | release unsubmitted source reservations on cancellation |
| `baa8ec32` | scope cursor cycle detection to each import traversal |
| `74d50475` | run bundled adapters through a registered SDK host |
| `44ecb2c8` | isolate adapter installations and version source identities |
| `23580b93` | namespace cloud authority and register site identities |
| `285994eb` | enforce adapter deadlines capabilities and scoped registrations |
| `cfab088a` | retain plan ownership across interrupted import preparation |
| `1f04f876` | scope adapter reads before applying pagination budgets |
| `50df7220` | defer source database access and retry blocked upgrades |
| `21772b5d` | localize shared adapter capture controls |

Validation: 184/184 focused unit tests across 20 files, strict selected production/test type graphs, seven distinct browser scenarios exercised in staged runs, server import boundaries, lint, source-size and locale checks, and the 41-file production artifact verifier passed. Full-project TypeScript and unrelated suites were not run.

## Follow-up foundation review

The follow-up review fixes five shared-host defects: generated archive rules now admit `siteFavorite` as well as import/reconciliation; fresh membership reads resolve older conflicts without replacing facts received after dispatch; negative readback follows the registered capability; replay caches retain independent response snapshots; and navigation only persists changes for relevant tabs, deleting departed/closed tab state and pruning legacy orphan routes at startup.

Confirmation reads persist their baseline ordinal with the active command before dispatch. Positive/mixed results retain that baseline across item resolution and worker reconstruction. Authoritative merging and pending observations commit in one transaction; edges superseded after the baseline are omitted from the planning observation. Negative-only results do not require item resolution and create no native deletion. Readback also advances the live overlay fence so an older import cannot resurrect a verified absence. Unknown edges remain unchanged. Legacy in-flight hints without a baseline stop for retry instead of receiving authoritative merge semantics.

`tests/fixtures/site-adapters/posts.ts` supplies a separate test-only `SiteAdapter`: DOM confirmation, post resources, string account/collection/item IDs, qualified negative evidence and stable item-page cursors. Focused tests exercise it through the page SDK/runtime, archive configuration, confirmation queue and durable ledger. This supplements rather than replaces real-site qualification; X and YouTube remain unimplemented. Bundled Bilibili negative readback remains unavailable.

Follow-up checks and limits are recorded in [foundation follow-up evidence](evidence/foundation-follow-up.json).

## Document-scoped readers and capability subsets

`SiteDefinition.readScope` defaults to `document`. Host confirmation reads prefer the hint's exact document and route, including lease renewal on that document. They never switch a DOM reader to another tab. A missing document receives a bounded reconnect wait and then a visible `pageUnavailable` outcome. Only an explicitly qualified `account` reader may fall back to another document of the same source generation; Bilibili declares this profile. Import continuations also prefer their existing document, preserving their existing restart/resume fences.

Page runtime generation 5 retires older injected runtimes during an in-place upgrade. Every `SiteAdapterFactory` receives immutable `AdapterServices.readPolicy` before source detection. `spacingMs` controls command pacing and remains the default for `requestSpacingMs`; actual requests have separate spacing, timeout, retry, backoff, automatic-wait and response-byte budgets. `commandAttempts` controls host command retries. Host scheduling never spaces commands more closely than the request minimum. Bilibili's HTTP reader applies the supplied policy to bootstrap and every command-internal request. Site-specific endpoint and response projection code remains local to the adapter; applying this policy is part of adapter qualification, not a sandbox for arbitrary network code.

The shared feature map distinguishes primitives from workflows:

| Feature | Required capabilities |
| --- | --- |
| Live archive | `observeFavorites`, plus user-selected current stable collection facts |
| Import | `enumerateCollections` and `enumerateItems` |
| Hint confirmation | `observeFavorites`, `readMemberships` and `resolveItem` |
| Current-item inspection | `resolveItem` |

Observation-only adapters can emit `catalog.upsert` during DOM discovery. Archive settings display these facts explicitly as **observed only**, scoped to the current connection and installation/source generations. Historical or foreign catalog rows cannot populate this setup path. Enumeration-only adapters can configure imports without an `emit` capability: host ingestion of an already validated catalog uses a separate ledger entry point. Unsupported controls are hidden, existing jobs retain cancellation/recovery, and settings use item-neutral copy. These changes add no nested collection, injected capture-control or named background-reader capability.

Cloud scope reviews use a v2 key containing installation/identity, source connection and a cloud-owner digest (server, account, library, replica and generation). Old unscoped reviews are inert; users create fresh reviews. Committed plans, native proof and recovery receipts are unchanged. Parallel reviews and reverse-order approvals are tested through two real cloud runtime instances with a controlled server port.

The test-only DOM reader now reads account, item and membership attributes from each supplied document. Regression tests cover two same-site documents, disappearance of the hint origin, explicitly allowed account-wide fallback, parallel site queues with identical IDs and independent pauses, observation-only live planning, enumeration-only setup, UI capability gating, HTTP policy propagation, and cloud review isolation. Controlled Chromium coverage additionally sends a hint from the second Bilibili tab and verifies that its membership request runs in that tab. See [capability foundation evidence](evidence/foundation-capabilities.json).
