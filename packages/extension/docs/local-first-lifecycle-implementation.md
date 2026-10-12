# Extension local-first lifecycle

This PR connects the personal-sync lifecycle, metadata consent and device save diary to the shipped worker and options UI. Repository extraction remains a separate task.

## Personal sync

- Personal sync is persisted per server/account, with an explicit collection identity. Pause stops new transport/native projection admission, aborts admitted requests and preserves queued work. It does not sign out, stop subscriptions, disable local saving or change the selected AI provider.
- Resume and disconnect use single-use, expiring confirmations tied to account authority, policy revision, native identity/placement and pending work. Changed state requires another preview. A failed storage write leaves this worker stopped.
- Resume verifies the selected private bookmark collection through an authoritative listing, then recovers local edits before the engine reconciles cloud changes. Offline, incomplete or malformed evidence cannot reopen a stopped connection.
- Disconnect archives the old scope, queues and immutable attempts, then clears its active attachment. Native bookmarks and metadata remain. Reconnect uses a fresh replica and requires folder selection/merge review; archived commands are not replayed. Publication is serialized with authentication and checks the original generation.
- Logout migrates eligible visible native save facts, pauses personal sync and remembers only allowlisted non-secret connection configuration. Existing authority revocation, retirement and subscription cleanup remain enforced. Same-account login requires explicit Resume; another account cannot read or execute the old account's commands.
- A complete validated listing can mark a collection unavailable. Its identity remains visible for explicit disconnect/rebind. Missing targets never implicitly recreate cloud content or delete local bookmarks.

## Metadata consent and queue recovery

Consent is separate from a remote metadata binding and is scoped to exact server/account/collection identity. Missing, corrupt and unsupported consent denies transfer, including upgrades. The collection view displays this state and explains the fresh affirmative choice required after upgrading. The consent dialog also appears for an empty metadata store; Cancel and Keep local remain distinct.

Reconciliation, snapshot sidecar import, note dispatch and immutable COLP metadata dispatch check consent. Final synchronous checks fence the read-to-send microtask race. The switch does not wait for an HTTP response. Already dispatched requests cannot be recalled.

A denied queued metadata attempt enters a durable terminal recovery state instead of an automatic retry loop. Its bytes, identity and sequence are retained. The existing Reset sync UI explains the refusal and the pending-work impact; confirmation archives the old queue before opening a fresh setup scope. Advanced snapshot recovery cannot bypass this refusal. Fresh affirmative consent alone does not silently replay the frozen queue.

## Device save history

The device diary stores only confirmed native save identity, URL/title, source, original automatic-mode flag and timestamps. It carries no account/collection identity, credentials, tags/notes, AI decisions, billing authority or replayable cloud commands. Account-owned commands stay isolated. Device facts remain read-only after logout/account changes and do not fabricate AI/cloud outcomes.

History and JSON backup merge visible records by stable capture identity without duplicates. The diary retains 90 days. Eligible old native saves migrate on visible reads and before logout; other accounts' command histories are never queried. Optional diary failures do not turn a native save into a failed save or prevent logout.

Clear device save history removes the cross-sign-in diary and stores a durable clearing cutoff. Subsequent lazy migration cannot resurrect cleared facts. Bookmarks, backups and independently stored command/restored histories remain. This is a browser-profile feature, not isolation between people sharing the profile.

## Reinstallation metadata reassociation

The backup import dialog offers Restore metadata to existing bookmarks separately from importing a new tree. The worker validates the backup, matches unique full paths/kinds/exact URLs, excludes managed/subscription ancestry and confirms the current native/metadata state before writing sidecars. Old native ids alone never prove identity. It creates, moves and deletes no native bookmarks. Tags merge losslessly; current conflicting notes/descriptions are kept and reported. Repeating a restore is idempotent.

## Validation

Executed locally on this change: **410 focused Vitest tests** across 35 files, **33 Node lifecycle tests**, and **5 xvfb Chromium browser acceptance cases**. Typecheck, changed-file lint, i18n, source-size/token checks, production/development builds and the production release-artifact scan passed.

Focused canonical Vitest checks cover consent, durable history, migration, queue refusal/archive, confirmation/account fences, metadata reassociation, session reconnect, auth, UI and the affected Push/Pull/engine behavior. The 33 Node lifecycle contract tests are also wired into the package test command. Typecheck, changed-file lint, i18n, source-size/token checks and extension builds are required before merging.

Browser acceptance runs only under xvfb and closes its Chromium profiles, backend servers and temporary PostgreSQL containers. It covers pause/restart/resume with edits on both sides; disconnect/reconnect; offline logout, device facts and same-account reconnect; target deletion and recovery; immutable metadata retry refusal/reset; and offline metadata reassociation without duplicate bookmarks. The existing guest backup journey remains a regression gate.

GitHub runner jobs have reported an account payments/spending-limit failure before execution. Local verification is recorded separately and is not presented as passing GitHub CI.

## Separate follow-up work

- Extract a standalone extension repository and remove sibling private source/resource/generator dependencies.
- Make Know-N host permissions optional independently of core local functionality.
- Broaden acceptance to production deployment accounts, all subscription/account-switch variants, large profiles and actual uninstall/reinstall across extension identities. Current reassociation tests exercise changed ids and a metadata-empty extension against retained native bookmarks.
