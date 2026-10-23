# Range, rejoin, and Recovered contracts (S-01)

Owner: extension storage/sync. This is the current contract. It is not an API freeze of
pre-S-01 code. Consumers land in FRR-01…05.

`native_mappings.projection` is the last Chrome-landed content, position, and revision. Detached,
private-local, and unmaterialized remote changes persist as `remote_observations` and must not be
written back as if Chrome applied them.

Writable-active means confirmed, reconciled, writable, and not private-local/managed/pending/unknown.
`status !== 'detached'` is not that test.

Ordinary folder selection preserves the browser ancestor graph. Unselected ancestors are
structure containers only: their siblings and other contents do not enter the range. A selected
ordinary folder is a local coverage mount and a normal remote Folder; it is not a root-level
`folderRole=custom` container. True custom browser roots retain independent Collection placement.
Selecting all at once and expanding a partial selection produce the same parent graph and retain
existing Node identities. Browser special roles remain unique.

Existing flattened ordinary mounts are not moved automatically. Reconfirming the folder range
rematches all mapped nodes and shows current device/cloud parent labels under local merge
attention. Uploading the device version and folder is an explicit, snapshot-bound choice; the
normal move operation, receipt and rematch close it. An independent remote move or concurrent
edit invalidates stale evidence and must be reviewed again. No copy/delete/recreate migration is
used. An unreadable browser tree preserves the previous report instead of treating it as empty.

Range adjustment uses subtree coverage, including explicit exclusions, rather than equality
between selected root IDs. Selecting a parent preserves its existing child mounts; clearing
selection stops both ordinary and role mounts while retaining their bindings and bookmarks.
Only a journaled `pendingShift` is a move. A user deselecting a folder is a removal.

Preview/confirm binds the normalized browser tree, including folders being removed, and the
current boundary version. Remote trash evidence is revalidated before range mutations. Concurrent
confirmations for one scope serialize; a successful confirmation consumes its preview once.
Stopping a shifted folder must also remove its selection (or exclude it beneath a selected parent).
Restoring a selected ancestor rejoins covered detached mounts using their pause baselines.
Canonical browser-role mounts bind to unique remote role facts. Local `local-root` reservations
are never remote identity evidence; their promotion updates the mapping, mount and root authority
in one transaction. An unavailable startup status retries without reopening onboarding or restoring
an old draft over completed sync settings.

`tests/range-lifecycle.test.ts` exercises the actual picker → runtime message → range planner →
IndexedDB/bootstrap path, plus later event capture and download eligibility. The focused browser
scenario `existing folder sync expands` in `e2e/mv3-first-run-sync.spec.ts` uses Chromium and the
real backend for partial sync → Sync all → clear → restore. Run browser tests through `with-xvfb.mjs`.

## Range Move conversion

| Remote Move source → destination | This device |
|---|---|
| active → active | Native move after permission, mount, parent/anchor, and generation checks |
| active → detached / unmounted / private-local | No destination write. Keep the local copy, exclude it, store the observation, drop the active mapping |
| detached / unmounted → active | Do not rewrite the old copy. Materialize an independent native at the active target bound to the same Node |
| inactive → inactive | Observation only. No Chrome mutation |
| Identity, ancestor, or permission unconfirmed | No Chrome mutation. Diagnostic dependency. Do not default to the bookmarks bar |

Folder crosses as the verified subtree. Pending local Operations keep their envelope and sequence.

Pure implementation: `src/scope-transition.ts`.

## Rejoin triple

Detach records `mount_bindings.pauseBaseline` (generation, boundaryVersion, last applied cursor,
completeness). Rejoin compares baseline B, local L, and remote R. Missing baselines are
`baseline_unknown` and stay visible; they are not guessed.

## Recovered uniqueness

Special roots `bookmarks-bar` / `other-bookmarks` / `mobile-bookmarks` stay unique per Collection+role.
`recovered` is unique per Collection+parent (the owning mount) and is a direct child of that mount,
including custom mounts. When the original mount is gone, a Collection-root recovered fallback may
exist under an explicit contract. Extension apply must not guess the bookmarks bar.

COLP spelling: `packages/node/src/sync/folder-role-contract.ts`. Backend unique index is
`nodes_live_recovered_parent_uidx` (FRR-05).

## Isolation

Unrelated Nodes are not marked failed together. Unknown browser side effects stay blocked; they are
not swallowed into terminal. Ack advances only a contiguous completed prefix. Legal duplicate content
is not an unknown side effect.

## Native call result (C-02)

Chrome and IndexedDB are not one transaction. Persist `started` before the API call. Named results:
`not_started | applied_with_evidence | absent | result_unknown | waiting_dependency | failed`.
A durable API-return nativeId may commit mapping. Parent/title/URL correlation is a candidate only.
Zero or one newcomer is not identity proof. Permission/managed errors are not `absent`. Missing v15
fields read as `unknown`, not `applied_with_evidence`. Owner includes scope, generation, command,
event, colpId, and substep. Pure classifier: `src/native-call-result.ts`.

## Page Ack boundary (C-03)

Only a server-issued whole-page `nextCursor` with Backend page evidence may be Acked. Do not Ack an
event cursor, skip an incomplete page, or rewind a published cursor. `currentPullMapping` is
page-local unpublished shadow. Preflight kinds live on `PULL_DEPENDENCY_KINDS` in
`src/scope-transition.ts`. Pure classifier: `src/pull-ack-boundary.ts`.

## Snapshot 0.2 pages (C-04)

Same Snapshot identity/cut/revision/collection across pages. Merge `parentRevisions` by parentId;
same parentId with a different revision is a conflict. Do not require per-page array equality.
Every page Folder/Root must carry childrenRevision. Final ring/orphan/uniqueness runs only on the
complete frozen tree. In-flight pages are immutable. colp `assembleSnapshotPages` remains 0.1;
use `accumulateSnapshotV02Pages` in `src/snapshot-v02-pages.ts`.

## Missing parent (C-05)

Unknown parent identity needs authority and must not Ack as `skip_unmounted`. Proven inactive remote
nodes are observation-only. Source-retained native + container is a durable exclusion with the
original identity and must not upload as the deleted/moved-out active remote Node.

## Logical operation vs HTTP attempt (C-01)

Logical replay identity binds server, account, Collection, Replica lifetime, sequence scope/number,
opId, atomic semantics, and canonical Operation bytes. `QueueOperation.attempt` is the HTTP attempt
slot (Session, batch, request date, tracing). `sequence_reuse` / `op_id_reused` is reconcile or
unknown, never "did not execute". Pure classifier: `src/logical-operation-identity.ts`.
