# Database migrations

Production migrations use Kysely's `FileMigrationProvider` and PostgreSQL only.
Name files with a sortable UTC prefix, for example `202607220900_expand_example.ts`.

Migrations follow expand/contract deployment order: add backward-compatible structures,
deploy readers and writers, validate/backfill, then remove obsolete structures in a later
release. A migration must not make the currently deployed reader unable to start.

## Digest scheduler revision fence

Apply `202610210000_digest_run_schedule_revision.ts` before deploying the updated
scheduler. This additive migration leaves historical run revisions NULL; claim
revalidates their occurrences under the current schedule lock. Replace all old
scheduler workers to enable the fence everywhere. Keep the column on rollback;
an old worker does not enforce the new revision check.

## Bookmark preference rollout

`202610101400_bookmark_preferences.ts` adds the account preference table after
the existing main head `202610101300_credit_integrity_aggregates`. The unmerged
feature branch used the earlier `202610101000_bookmark_preferences` name; it was
rescheduled on integration so an existing main database can upgrade in order.
Apply this migration and deploy the preference API, including the
`Known-Bookmark-Session` response header, before releasing the updated extension.

## KNS-06 live mount `folder_role` and tombstone consume

`202610011800_nodes_folder_role_and_tombstone_consume.ts` is expand → backfill →
verify, then a payload trigger and the partial unique index
`nodes_live_special_folder_role_uidx` on `(collection_id, folder_role)` where the
Node is live and `folder_role` is one of `bookmarks-bar`, `other-bookmarks`,
or `mobile-bookmarks`. `custom` is not in that index.
`202610012100_recovered_unique_per_parent.ts` removes `recovered` from that
Collection-wide unique index and adds `nodes_live_recovered_parent_uidx` on
`(collection_id, parent_id)` for live `folder_role=recovered` rows. Existing
Recovered ids stay put; a second Recovered under a different parent is now
legal. After two live Recovered Folders exist in one Collection, the old
global unique index must not be recreated.
`202610011900_sync_effects_product_restore_origin.ts` drops the
`sync_operation_effects.origin_replica_id` FK so a Product-authored `restore_node`
can emit the same `node_restored` effect without inserting a fake device Replica.
Apply both before enabling KNS-06 writers. Rollback is developer-only and
destructive for the new column/index; drain restore writers first. Operators
must not log Node URL, title, or payload while inspecting these tables.

## Better Auth session token protection rollout

`202609280700_auth_session_token_protection.ts` adds the nullable
`auth_sessions."tokenLookupHash"` field used beside the versioned authenticated ciphertext in
`auth_sessions.token`. Existing rows remain untouched so N-1 binaries can run until the
application cutover. `202609280800_auth_session_token_lookup_index.ts` adds the partial unique
lookup index. On an `auth_sessions` relation larger than 64 MiB the transactional migration
refuses before taking a blocking index-build lock; run
`npm run db:indexes:online -- --only=auth_sessions_token_lookup_hash_uidx` after the column
expand, then rerun `db:migrate`.

Apply schema first, then replace the API fleet as one coordinated cutover. Once an N binary
writes `knst1` ciphertext, an N-1 binary cannot authenticate that session, so this application
change is not safe for mixed-version writers. Existing plaintext rows are admitted only when
`BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL` explicitly opens a bounded bridge; they naturally
expire and are never rewritten by the migration. Rotation prepends a new key version and
retains old keys through the longest session TTL. Application rollback keeps the additive
schema; after protected writes, rollback to an unprotected binary requires revoking those
sessions and forcing reauthentication. See
`docs/decisions/better-auth/session-token-at-rest-protection.md` for the complete procedure.

## Relation canonical create rollout

`202607250400_relations.ts` is the expand migration for P2B-10. Apply it before
deploying the Relation writer. During the N/N-1 window old API and Worker binaries
ignore the new table and do not claim `relation.created@1`; deploy the current Worker
before enabling Relation creation.

The first product release forbids a self relation and defines a live directed semantic
edge by `(collection_id, from_node_id, to_node_id, type)`. A reverse edge and a different
type are distinct. `label` is mutable descriptive metadata rather than edge identity, so
it cannot create parallel custom edges; soft deletion releases the partial unique key.
Both endpoints are resolved under the Collection lock. Until P2B-11 installs canonical
Relation cascades, deleting an endpoint with live Relations fails closed instead of
committing an orphan.

The writer persists relational owner fields and the complete canonical `payload_json`
in one transaction, with read-back equality before commit. Roll out the expand schema,
then the version-aware Worker, then the writer. For rollback, rollback the writer before
migrating down; dropping a populated `relations` table is destructive and is not an
application rollback strategy.

## Relation update and delete rollout

`202607250500_relation_mutation_cascade.ts` removes the P2B-10 endpoint-delete blocker
only after the P2B-11 writer is ready. Deploy the event-aware Worker first, then the
writer, drain all N-1 Node mutation writers, then apply the migration. The canonical
update lock order is Collection, Relation, then endpoint Node facts;
Node deletion holds the same Collection lock and locks incident
Relations in stable ID order before producing its canonical cascade plan.

Relation update and delete advance resource/content revisions and atomically write the
Operation, Audit, Outbox, Product receipt, and any public cache purge. Node deletion
adds each incident Relation to that same canonical cascade, with one tombstone,
resource revision, `relation.deleted@1` event, and aggregate evidence entry. The
Relation ID ledger is permanent and is never released or reused.

For rollback, rollback the writer before restoring the temporary endpoint-delete trigger;
otherwise an N writer can wait behind the restored trigger and fail after producing a
valid canonical cascade plan. Tombstoned Relations remain authoritative retention data.

## Annotation canonical create rollout

`202607250100_annotations.ts` is the expand migration for P2B-04. Apply it before
deploying the Annotation writer. During the N/N-1 window the previous API and Worker
ignore the new table, while the new writer dual-writes relational owner fields and the
complete canonical `payload_json` in one transaction. The migration also expands the
resource-revision scope guard to recognize Annotation resources.

Roll out the expanded schema first, then deploy the current Worker that understands
`annotation.created@1`, and only then enable the new writer. An N-1 Worker intentionally
does not claim support for this new event version; no Annotation producer may run while
such a Worker can still claim new rows.

Do not enable the writer until the empty-database and upgrade-from-
`202607242200_public_profile_projection` migration evidence passes. For rollback,
rollback the writer before migrating down; dropping `annotations` after writes have
started destroys authoritative resources and is not an application rollback strategy.

The sortable chain begins with the authoritative Phase 1 schema and contains subsequent
expand, contract, correctness, and performance migrations.

## Publication Annotation projection rollout

`202607250300_publication_annotation_projection.ts` adds the partial expression index used
by the collection-wide Publication Annotation stream. Apply it before deploying the P2B-08
reader. Its exact C-collated `(subject_type, subject_id, id)` order is part of the signed
Snapshot cursor contract; changing the comparator requires a new comparator version and
expires existing continuations.

Retain first/middle/final `EXPLAIN (ANALYZE, BUFFERS)` evidence naming
`annotations_live_publication_keyset_idx` without a Sort or Annotation sequential scan.
Roll back the reader before dropping the index. The migration is expand-only and is safe for
N-1 binaries, which continue to ignore the additional index.

## Saved Resource authority rollout

`202607250800_saved_resources.ts` expands the schema for P2B-15 private product state. It
adds stable Account ownership, Collection/Node target identity, soft-delete time facts, a
partial live uniqueness constraint, and the
`(saved_at DESC, resource_type ASC, resource_id ASC)` ordering index. It
also permits privacy-minimal `audit_events` without a canonical Operation by requiring the
Operation and Collection foreign-key pair to be either both present or both absent.

Apply the migration before enabling Saved Resource commands. N-1 binaries ignore the new
table and continue writing Operation-backed audits. The Operation-less authority pair is
shared with Reading Progress and any future privacy-minimal module, so the down migration
never deletes audit rows: while any Operation-less audit row remains it refuses with
per-module counts before touching anything (restoring the old NOT NULL pair would require
destroying audit history), and otherwise drops the Saved Resource table and restores the
old constraints. Roll back the command producer before migrating down; dropping
authoritative Saved Resource history is not a data-preserving application rollback after
the capability has accepted writes. Production rollback keeps the expand schema installed
(forward recovery); the down path is a developer-only destructive boundary after the
counted Operation-less rows have been explicitly backed up and removed.

## Sync Replica authority rollout

`202607251200_sync_replica_facts.ts` is the P3-05 expand migration for authoritative
Device and Replica lifetime, generation, binding, lease, checkpoint, and status facts.
Apply it before enabling the Replica create writer. N-1 binaries ignore the added
tables, and no Sync route or Manifest `sync` claim is enabled by this migration.

Roll back the Replica writer before migrating down. Once a Replica has been created,
the lifetime ID and generation ledgers are permanent authority: dropping these tables
destroys the non-reuse proof and is not a data-preserving application rollback strategy.
Normal application rollback therefore leaves the expand migration installed.

## Sync Replica lifecycle rollout

`202607251300_sync_replica_lifecycle.ts` is the P3-06 expand migration. It adds an
internal monotonic `lifecycle_revision` compare-and-swap fence so commands that began
from the same Replica facts cannot both win after PostgreSQL row-lock serialization.
It also installs a terminal-retirement trigger that prevents any repository or manual
writer from clearing `retired_at` or changing a retired row back to a live status.

Apply the expand before deploying the lifecycle service. N-1 binaries ignore the new
column and preserve its default. Application rollback leaves the expand installed;
the `down` migration removes the trigger and fence and is only a development downgrade
boundary after all lifecycle writers are drained, not a data-preserving rollback plan.

## Sync Session authority rollout

`202607251400_sync_sessions.ts` is the P3-07 expand migration. It adds durable extension
credential evidence, immutable Session scope and Replica binding facts, encrypted exact-
replay receipts, and relational generation, Collection, Account, policy, and security-epoch
fences. Apply it after the P3-06 Replica lifecycle expand and before enabling the Session
application service. N-1 binaries ignore all added tables; this migration does not mount a
Sync HTTP route and does not authorize a Manifest `sync` claim.

The receipt ciphertext is AES-256-GCM authenticated with a deployment key supplied to the
application. A positive key version is persisted and included with principal, scope,
idempotency key, fingerprint, Collection, Replica, and Session identity in the AAD;
raw bearer credentials, batch-binding secrets, and endpoint capabilities are never stored in
plaintext or Audit. Keep that key stable while receipts remain replayable; migrate retained
ciphertext before key rotation, or retain the old version until the replay lifetime has elapsed. Application
rollback leaves the expand installed. The migration `down` path drops authoritative Session
and replay history and is only a developer downgrade after all writers are drained, never a
data-preserving production rollback strategy.

## Live Editor keyset index rollout

`202607222800_live_editor_keyset_index.ts` adds the partial expression index used by
the Product Editor live-node keyset query. Apply this migration before deploying the
matching reader. The migration uses ordinary `CREATE INDEX` because Kysely runs the
migration chain transactionally; PostgreSQL permits reads while building it but blocks
writes to `nodes`, so schedule the migration during a bounded write-drain window and
monitor `pg_stat_progress_create_index` plus lock wait time.

After migration, run the PostgreSQL editor keyset integration test and retain its
`EXPLAIN (ANALYZE, BUFFERS)` JSON output. The accepted plan must name
`nodes_live_editor_keyset_idx` and contain neither a full `Sort` nor a `Seq Scan` of
`nodes`. Deploy the aligned reader only after that evidence passes. Roll back the reader
before migrating down; dropping the index changes performance only, not cursor ordering.

## Live sibling placement index rollout

`202608011000_nodes_live_sibling_position_c_idx.ts` adds the C-collated partial index used
by bounded sibling placement reads. Apply it before deploying the matching create/move
reader. The migration intentionally retains the existing live-sibling uniqueness index;
the new index changes query performance only and does not replace an integrity constraint.

Kysely executes the migration in a transaction, so this migration uses ordinary
`CREATE INDEX` rather than `CREATE INDEX CONCURRENTLY`. On a large `nodes` table it can
hold a write-conflicting lock for the duration of the index build. Before production
rollout, measure the build on production-shaped data, choose a bounded write-drain window,
set deployment lock/statement timeouts, and monitor `pg_stat_progress_create_index` plus
blocked writers. Abort the rollout if the approved lock window is exceeded; PostgreSQL
will roll back the transactional index build.

After migration, retain the live-sibling plan integration evidence naming
`nodes_live_sibling_position_c_idx` with no `nodes` sequential scan or explicit sort.
Deploy the aligned reader only after that evidence passes. For application rollback,
roll back the reader first and leave the additive index installed. Drop the index with
the migration `down` only in a separate approved window after every bounded-placement
reader has drained; the down path is performance rollback, not data recovery.

## Public Profile projection rollout

`202607242200_public_profile_projection.ts` is an expand migration for P2B-01. Before
deployment, audit existing handles for invalid characters and case-insensitive collisions;
the migration intentionally fails closed rather than choosing a public identity. After that
collision gate, it canonicalizes valid mixed-case rows to lowercase and keeps the expression
index as a database guard for all future writers.

Apply the migration before deploying the Profile facts and owner-scoped Publication readers.
Retain the real PostgreSQL contract evidence for both an empty database and an upgrade from
`202607242100_publication_directory_indexes`, plus the sufficient-cardinality
`EXPLAIN (ANALYZE, BUFFERS)` evidence naming both new indexes. Roll back the readers before
migrating down; removing these indexes changes lookup uniqueness/performance and must not
occur while the public projection is served.

## Publisher receipt retention rollout

`202607222900_publisher_receipt_retention.ts` backfills completed Publisher receipts with the
24-hour protocol minimum, adds the expiry constraint and cleanup index, and leaves in-progress rows
without expiry. Deploy it before enabling Worker cleanup. Roll back the Worker schedule before
migrating down so no process queries the removed expiry column.
`202607250600_relation_product_read.ts` adds separate live partial indexes for incoming and
outgoing Product Relation keyset reads. Deploy the indexes before the P2B-12 reader and
retain EXPLAIN evidence naming each index with no Relation Seq Scan or explicit Sort.

## Publication Relation projection rollout

`202607250700_publication_relation_projection.ts` adds the partial expression index for the
collection-wide Publication Relation stream. Its exact C-collated
`(from_node_id, to_node_id, type, id)` order is part of the versioned Snapshot sidecar
cursor contract. Deploy this index before the P2B-13 reader and expire continuations when
changing the comparator.

Retain first/middle/final `EXPLAIN (ANALYZE, BUFFERS)` evidence naming
`relations_live_publication_keyset_idx`, without a Relation sequential scan or explicit
Sort. Roll back the reader before dropping either Publication Relation index. N-1 binaries
ignore both indexes and continue to serve Snapshot pages without Relation includes.

## Sync Sequence lane and receipt rollout

`202607251600_sync_sequence_lanes.ts` is the P3-10 expand step. It creates one
Collection-scoped lane per Replica, a lifecycle-wide Operation-ID claim ledger, and the
deferred/terminal receipt ledger. The full stable operation result and its digest are stored
with the Session, lease generation, server-bound batch ID, endpoint identity, media type, and
canonical request digest. Database triggers require lanes to start at one, permit only a
single-step advance backed by a terminal receipt, reject terminal receipt mutation/deletion,
and keep deferred binding columns immutable.

Both claims and receipts use `replica_lifetime` retention and remain present after retirement;
there is deliberately no cleanup or purge API. This preserves exact replay evidence and prevents
Replica deletion or Tombstone cleanup from reviving a Sequence or Operation identity. The `down`
path is developer-only destructive rollback: stop every Sequence writer first, and never use it
as a production receipt-retention strategy. N-1 binaries ignore these expand-only tables. P3-11
may compose Session/Replica/policy reauthorization and its evaluator through the exported
transaction object, but this migration does not mount Push transport or implement mutations.

## Sync canonical Node create rollout

`202607251700_sync_node_create.ts` is the P3-12 expand migration for canonical Sync create of
Folder, Bookmark, and Separator Nodes. Apply it before deploying the P3-12 writer. During the
N/N-1 window older binaries continue to understand Folder and Bookmark rows and must not be
selected for traffic that can create Separator rows; the current Sync Snapshot reader already
projects Separator without inventing a title or URL.

The writer remains behind the Session and Sequence admission gates. Sequence is the only owner
of the Operation ID, lane, and immutable receipt, while the existing canonical mutation writes
the Node, revision, Operation, Audit, Outbox, position, and payload authority in that same
database transaction. `SYNC_MANAGED_BOOKMARK_WRITES` defaults to `false`; enable it only for a
deployment whose trusted role and Replica write capability authorize managed-bookmark writes.

The `down` path deletes Separator rows and is therefore developer-only and non-data-preserving.
Rollback the writer before migrating down. A production rollback keeps the expand schema in
place and rolls application traffic back; it never uses downgrade as a data rollback strategy.

## Sync typed Node update rollout

`202607251800_sync_node_revision_history.ts` is the P3-13 expand migration. It backfills the
current canonical payload of every valid Node revision and installs an immutable,
Collection-scoped history table. The update evaluator never treats the client-supplied Base as
history: it loads this server-owned payload and the locked Current in the existing Sequence
transaction, compares the client Base field by field, and only then invokes the public COLP
three-way merge.

Apply the migration before deploying the update-capable writer. During the N/N-1 window older
writers ignore the history table, so route update traffic only to the current writer; current
Canonical Mutation writers append history for every newly produced Node revision. Retention is
at least the Replica/receipt lifetime and no cleanup is enabled in Phase 3. P3-13 originally
kept divergent or unprovable updates as deterministic deferred Sequence results; the P3-17
writer supersedes that temporary boundary with an atomic formal Conflict. This migration itself
deliberately does not create a Conflict table.

Rollback the writer before migrating down. Dropping immutable revision evidence can make an old
client Base impossible to prove and is not a data-preserving production rollback strategy.

## Sync durable Node tombstone rollout

`202607251900_sync_node_tombstones.ts` is the P3-15 expand migration. It records one immutable
membership row for every Node selected by a canonical single/subtree delete, while binding every
row to the retained live-resource identity, the canonical Operation, root target, delete revision,
commit ordinal, Pull cursor, affected count, and minimum retention deadline. The payload is a closed,
budgeted projection: it retains Node kind and unknown `extensions` needed for recovery while excluding
Bookmark URL, title, description, tags, and other content not required by deletion identity.

Apply the migration before deploying the delete-capable Sync writer. N-1 binaries ignore the table;
route delete traffic only to the current writer so a committed deletion cannot omit its Sync Tombstone.
P3-15 does not implement Ack or purge, and the immutable trigger deliberately rejects cleanup. ID ledger,
Operation, Audit, Sequence claims/receipts, and Tombstones survive resource deletion and application
rollback. Rollback the writer before migrating down; dropping Tombstones destroys recovery authority and
is only a developer rollback after all P3-15 writers are drained, never a production rollback strategy.

## Sync open Conflict rollout

`202607252000_sync_conflicts.ts` is the P3-17 expand migration for private, Pull-ready
Sync Conflict authority. A typed Node update that cannot be merged now consumes its
Sequence as a terminal `conflicted` result and atomically writes one Operation, one
`open` Conflict, one Audit event, one Outbox event, and the immutable receipt at the
same commit ordinal. The target Node and its revision remain unchanged.

Conflict Base, Current, and Incoming projections contain only field type, encoded byte
count, and SHA-256 summaries. Resolution source values are retained only in an
AAD-bound AES-256-GCM private payload using a purpose-separated key derived from the
deployment-provided Sync replay key. Its real key version is persisted and must remain
available while any open Conflict references it; the key is not derived from a database
Session secret. Raw titles, URLs, URL userinfo, and extension values are never stored in visible JSON, Operation,
Audit, Outbox, receipt, Problem, metric labels, or logs. Apply the migration before routing
update traffic to the P3-17 writer. N-1
binaries ignore the new table, and the Manifest still must not claim `sync`.

The private payload AAD binds Collection, Replica/lease generation, Session, Operation,
target, Conflict, ordinal, kind, fields, key version and Base/Current revisions. Private
columns are `bytea` and explicitly excluded from `PUBLIC` column reads. The current worker
has a durable source-verification route for the redacted Conflict Outbox envelope, so the
new handler is not retried as an unknown route and never projects private values.

The P3-17 table is immutable while Conflict resolution is unavailable. P3-18 must
replace that database guard only together with its canonical resolution transaction;
no application rollback may drop retained Conflict, Operation, Audit, Outbox, or
Sequence evidence. The `down` path is developer-only and destructive.

## Sync Pull stream rollout

`202607252200_sync_pull_stream.ts` is the P3-20 expand migration. It adds a private,
schema-validated COLP Operation projection and an immutable Conflict event projection,
then installs indexes matching the exclusive
`(commit_ordinal, stream_kind, stable_id)` comparator. Operation sorts before Conflict
at the same ordinal. The reader uses `UNION ALL` ordered index branches and a bounded
`limit + 1` probe; retained PostgreSQL evidence must show `Merge Append`, both Pull
indexes or the stricter unique Operation ordinal index, no sequential/bitmap fallback,
and no unbounded or spilled sort at representative volume.

Apply the migration before deploying the P3-20 writer/reader pair. Old writers do not
populate `operations.sync_wire_json`, so their non-Sync canonical Operations remain
intentionally absent instead of being guessed into approximate protocol documents.
The initial purge boundary is the explicit `(0, operation, "")` watermark and is MAC-
bound into every cursor; P3-23 will replace that deployment fact when purge authority
exists. This migration does not mount Pull HTTP, Ack, or purge behavior. Roll back the
reader and all projection writers before the developer-only down migration.

## Reading Progress rollout

`202607250900_reading_progress.ts` expands the private `reading-progress` authority after
Saved Resource. Deploy it before the P2B-18 command adapter. The database unique constraint
on `(account_id, resource_type, resource_id)` is the concurrent first-write arbiter; status,
five-decimal progress, revision, and server timestamps are constrained together. N-1 binaries
ignore the table. Roll back Reading Progress writers before migrating down because down removes
all explicit per-account progress state.

## PostgreSQL Search baseline rollout

`202607251000_postgres_search_baseline.ts` is the P2B-21 expand migration. It
installs `pg_trgm` in `public`, adds the default-false Collection
`allow_search_indexing` authority, backfills canonical Collection payloads, and
materializes stored English `tsvector`, normalized trigram text, and URL hosts.
Legacy URL hosts are extracted by the JavaScript standard `URL` parser during
migration; invalid, credential-bearing, non-HTTP(S), and null URLs materialize
as null.

The migration fails with an actionable database-owner command when `pg_trgm`
cannot be installed or is installed in an incompatible schema. There is no
unindexed `%LIKE%` fallback. Deploy the migration before the matching writer
and candidate reader. Existing Collections remain opted out, including public
ones, until an owner explicitly changes publication settings.

Kysely applies this migration transactionally, so the stored-column rewrite
and GIN builds cannot use `CONCURRENTLY`. Schedule a bounded write-drain window
and monitor relation rewrite/index-build progress and lock wait time. N-1
writers may omit the new payload member; readers interpret that omission only
as default false, and the first N writer mutation rematerializes it explicitly.

Retain the versioned quality corpus and the 8 x 10,000 Node evidence output,
including environment/data distribution, serial `max_parallel_workers=0`
method, first-query versus warmed-cache qualification, and first/middle/final
JSON plans. Roll back the reader and writer before migrating down. The down
migration removes search materialization and authority columns but deliberately
retains `pg_trgm`, which may be shared by later features.

## Profile and Annotation Search rollout

`202607251100_profile_annotation_search.ts` expands the direct PostgreSQL
candidate set for P2B-22. It adds stored, immutable Profile handle/display-name
materialization and bounded Annotation plain-text materialization. Annotation
HTML and Markdown targets are discarded, JSON is limited to an explicit set of
top-level scalar fields, control and bidirectional formatting characters are
removed, and the stored source is capped at 1,024 Unicode characters. These
facts remain candidate input only; deploy P2B-23 authorization before exposing
them through any Product route.

Apply the migration before deploying the four-branch candidate reader. The
Profile branch remains gated by an active account and an owned public opt-in
Collection. The Annotation branch applies its own public/live/type, Collection
opt-in, and subject/ancestor visibility predicates before ranking. Retain the
50,000-row-per-branch first/middle/final JSON plan evidence for Collection,
Node, Profile, and Annotation. Roll back the reader before migrating down;
down removes the generated columns, indexes, and sanitizer functions.

## Sync Ack rollout

`202607252300_sync_acknowledgements.ts` is the P3-22 expand migration. It adds
immutable, scope-complete evidence for every Pull cursor returned to a Replica,
immutable Idempotency-Key Ack receipts, and the missing stream-kind/stable-id
parts of the Replica checkpoint tuple. Cursor evidence stores only protocol
identity and ordering facts; credentials, warning text, bookmark content,
URLs, native browser IDs, and session secrets are not persisted.

Because P3-21 had no published-cursor Ack evidence or stable tie-breaker,
upgrade clears any non-retired legacy checkpoint instead of inventing an
ordering tuple; that Replica must Pull again. Retired checkpoints are retained
only as terminal history and receive inert tuple fields so the new row shape is
complete. Operators should account for the bounded re-Pull before rollout.

Deploy this migration before the P3-22 Pull writer and Ack endpoint. Pull and
evidence insertion share one transaction, while Ack receipt, conditional
checkpoint advancement, audit, and bounded lease renewal share another. The
down migration is developer-only destructive rollback after both P3-22 writers
are drained; it is not an online rollback strategy.

## Sync Tombstone purge rollout

`202607310100_sync_tombstone_retention_config.ts` originally relaxed the Sync
tombstone database guard to the deployment-owned
`SYNC_TOMBSTONE_RETENTION_SECONDS` configuration. FIX-L-034 restores the
protocol floor: `202609030100_sync_tombstone_retention_contract.ts` re-adds
the thirty-day CHECK (`NOT VALID`, so existing rows are never purged or
rewritten early), and `SYNC_TOMBSTONE_RETENTION_SECONDS` below 2592000 is
rejected at configuration parse time. Deployments that ran a shorter configured
retention must raise the value to at least 2592000 and re-deploy before this
migration; the failed config parse is the pre-upgrade readiness warning, and
already-written short tombstones expire only at their own `purge_after`.
Product-owned collection deletion retention remains unchanged.

`202607252400_sync_tombstone_purge.ts` is the P3-23 expand migration. It creates
one Collection purge authority with a complete Pull tuple and atomic revision,
an immutable per-Node deletion/generation watermark, and a fenced lease used by
the existing Worker bootstrap. Existing and newly inserted Collections receive
an initial `(0, operation, "")` boundary.

The purge worker is disabled by default. Deploy this migration and the boundary-
aware Pull reader before setting `SYNC_TOMBSTONE_PURGE_ENABLED=true`. Each short
transaction locks the Collection, checks every `active` Replica's full checkpoint
tuple using database time, processes one bounded deletion event, and atomically
advances identity watermarks, compacts only Tombstone `extensions`, and advances
the Collection boundary. Tombstone rows, deleted Node authority, ID ledger,
Operation, revision history, and Audit rows remain intact.

Expired, recovery-required, and retired Replicas do not block purge. Their old
cursor evidence remains durable, so a later Pull behind the live boundary fails
with the recovery-required path; P3-24 owns Snapshot Bootstrap Ack recovery. The
down migration is developer-only and requires draining the purge worker and the
boundary-aware Pull reader first.

## Sync stale Replica recovery rollout

`202607252500_sync_snapshot_recovery.ts` is the P3-24 expand migration. It adds
short-lived recovery capability claims, immutable server-observed Snapshot page
evidence, and immutable Bootstrap Ack receipts. Deploy it before enabling the
recovery-aware Pull, Snapshot, and Ack composition. The recovery capability
keyring is purpose-isolated and must be configured independently from Pull,
Snapshot, Publication, Editor, and receipt-encryption keys.

Pull commits the full-tuple stale decision and `recovery_required` lifecycle
transition in one transaction. Recovery Snapshot pages remain the frozen P3-09
materialisation; only a contiguous server-observed range ending at the frozen
Node count can mint its `syncCursor` recovery capability. Bootstrap Ack then
revalidates Session, credential, policy, purge boundary, Snapshot revision and
page evidence while atomically inserting a fresh generation, moving the
checkpoint to the Snapshot boundary, terminating old Sessions, activating the
Replica, and storing receipt plus Audit. The down migration is developer-only;
drain all three recovery-aware routes before destructive rollback.

## Sync authoritative operation effect rollout

`202607252700_sync_operation_effects.ts` is the P3-32B expand migration. It adds
immutable COLP 0.2 operation effects, digest-chained subtree membership pages,
and a per-Collection cutover ordinal. Existing Collections cut over at one past
their highest committed Operation ordinal; new Collections start at ordinal 1.
Historical effects are never inferred. The migration also expands persisted
Session and Pull-cursor protocol-version checks from 0.1 to 0.1 or 0.2.

Apply the migration before deploying any writer or Session route that accepts
COLP 0.2. During the N/N-1 window, 0.1 Sessions continue to receive the exact
legacy Operation stream. A 0.2 Pull fails closed when its cursor precedes the
Collection cutover or when an effect, binding, digest, or page chain is missing
or inconsistent. Advertise 0.2 only when the effect-page endpoint is configured.

Canonical mutation, Operation projection, effect/page persistence, ordinal,
and Sequence receipt share the existing Sequence-owned transaction. Retention
deletes effect pages before effects only through the acknowledged purge fence;
active Replicas without a sufficient Ack continue to block that purge. Roll
back 0.2 routing and all effect writers before using the developer-only down
migration. Dropping effect authority is not a production data rollback.

## OIDC profile handle invariant

`202607270100_oidc_profile_handle_invariant.ts` backfills every active OIDC-bound
account missing a profile handle with opaque random material. Deferred constraint
triggers then require the handle at transaction commit, allowing account bootstrap
and handle rename to make their coordinated writes in either order within one
transaction. Deploy this migration with the matching identity application code;
rollback removes enforcement but deliberately retains generated handles.

## Product Sync Center reads

`202607280100_product_sync_center_reads.ts` is the P3-36 additive open Conflict keyset index migration.
Replica status reuses the P3-05 account/device/Replica index. It adds no telemetry or browser-local facts.

## Follow authority rollout

`202607280200_follows.ts` is the P5-02 expand migration. It adds only the free-social
Follow authority keyed by two stable identity-owned Profile IDs. Mutable handles are
not persisted in the binding. Database constraints reject self edges and duplicate
bindings, PostgreSQL supplies the immutable canonical time, Profile deletion cascades
edges, and an Account lifecycle trigger removes edges when either owner becomes inactive.

Apply the migration before deploying the P5-02 repository. N-1 binaries ignore the
table and can continue identity writes; the lifecycle locks serialize those writes with
new Follow inserts. Roll back all Follow writers before the developer-only down migration,
which destroys Follow authority. Forward recovery recreates an empty table; restore lost
authority from the database recovery source rather than inferring it from handles.

## Rebuildable social Feed projection rollout

`202607290100_social_feed_projections.ts` is the P5-10 expand migration. It adds
only the per-recipient `social_feed_items` projection and scoped
`social_feed_watermarks`; N-1 binaries ignore both tables. Feed rows contain stable
event, Profile, Collection, revision, ordering and discoverability-recheck facts.
They deliberately contain no title, summary, body, arbitrary payload or private
Collection content. The event/recipient binding has a single database winner and
visible rows use the frozen Feed cursor tuple index.

Feed items have an exact 90-day retention boundary and an irreversible
`visible -> withdrawn` lifecycle. Retention cleanup is bounded and cannot use a
caller-supplied future cutoff to shorten the window. Watermarks use a monotonic
commit ordinal plus a state revision CAS. Rebuilds separately record their captured
high watermark and replayed watermark, so live dual-apply may advance beyond the
capture while cutover remains forbidden until replay reaches it.

Apply this migration before P5-11 registers any Feed handler. The P5-10 repository
can atomically persist a bounded item batch with its watermark CAS, but this rollout
does not register a Worker or consume an event. Drain future Feed writers before the
developer-only down migration; rollback destroys only rebuildable projection state,
which must be reconstructed from retained social events, Follow authority and current
Publication discoverability.

## Notification authority rollout

`202607290200_notification_authority.ts` is the P5-16 expand migration. It adds private,
Account-owned preference, Notification and delivery-intent tables independently from the
rebuildable Feed projection. N-1 binaries ignore all three tables. Preferences have one
revision-fenced row per channel, with conservative in-app-on/email-off server defaults.
Notifications accept only the two free social MVP types and elect one durable winner for
each recipient/event/type identity. Delivery intents are owner-bound to their Notification
and never contain provider authentication material.

Notification identity and event facts are immutable. Read state is an irreversible revision
CAS, delivery state follows a revision-fenced transition graph, and 90-day Notification
retention cascades delivery intents. Actor facts require an active Account at write time; Account
lifecycle deletion removes both received and actor-referencing Notifications plus preferences.
Apply this migration before P5-17 registers
any Notification handler. Drain all later Notification writers before the developer-only down
migration; unlike Feed, this authority includes user read state and cannot be rebuilt from Feed.

## Sync Pull recovery proofs

`202607300100_sync_pull_recovery_proofs.ts` separates expired-cursor recovery authority from
Ack evidence. It stores only a SHA-256 cursor digest plus exact Replica/Collection/generation,
issuance lifecycle, policy/protocol/limit and tuple lineage, with an explicit proof deadline.
The same additive migration gives each recovery Snapshot a nullable page-limit staging field.
The Snapshot row holds the next-generation signed Pull cursor before Ack, but it is not Pull
authority: recovery Ack must create the generation and atomically materialize digest evidence
and proof before publishing that cursor as the Replica checkpoint.
Ordinary Session renewal is compatible because lifecycle revision may advance while lease
generation remains fixed; generation replacement is not compatible. Recovery additionally
requires exact equality with the current durable Ack checkpoint, so an unacknowledged issued
cursor is not recovery authority. Consumption and the
Replica recovery transition share one locked transaction. Expired unreferenced issued evidence
is removed, retained evidence loses its raw cursor, and superseded proofs are cleaned during
recovery completion or retirement. The newly active checkpoint keeps one bounded digest-only
proof until it is consumed or reaches retention expiry.

## Identity avatar URL HttpsUrl backfill

`202608090200_identity_avatar_url_backfill.ts` (FIX-M-003) nulls `profiles.avatar_url`
rows that violate the `HttpsUrl` contract (docs/08 §7.3: absolute https, no
userinfo, no fragment, no explicit non-default port, at most 2048 canonical
characters). The SQL predicate is a conservative approximation of the strict
WHATWG-URL application validator and errs toward clearing; the fail-closed
public-profile read adapter and the strict write path reject any value the
approximation cannot see. The cleanup is irreversible — developer-only down is
a documented no-op.

## Identity profile about

`202609060100_identity_profile_about.ts` expands `profiles` with a NOT NULL
`about text DEFAULT ''` column and `CHECK (length(about) <= 2000)`. Existing
rows receive the empty string. N-1 binaries ignore the column. Apply the
migration before deploying readers and writers that persist or project about
on `GET/PATCH /api/v1/me` and `GET /api/v1/profiles/{handle}`. Feed, Follow,
Search, and Collection-owner summaries stay compact (handle/displayName/avatar)
and do not carry about. Application rollback leaves the column installed; the
`down` path drops stored about text and is developer-only.

## MCP OAuth revocation store and security epoch

`202609010100_mcp_oauth_revocation_store.ts` (FIX-L-042) adds the shared
multi-instance MCP OAuth revocation surface: `mcp_oauth_revocations` stores
only one-way SHA-256 digests (issuer/subject/client/jti/credential) with an
idempotent unique index, and `mcp_oauth_security_epoch` is the singleton
rotatable epoch whose `effective_at` boundary retires every token issued
before a bump on all replicas. The seed row uses the default epoch
`known.mcp.oauth.v1` so a fresh deployment matches the dev/test provider
value.

Apply this migration before deploying an API that opts into
`MCP_OAUTH_REVOCATION_STORE=postgres`; it is expand-only (new tables, no N-1
reader touches them). Production without the opt-in wires no verifier and
readiness reports MCP OAuth unavailable. The developer-only down migration
drops both tables; revocation rows are operator revocation evidence, so only
roll back before any revocations have been recorded.

## Better Auth 1.7 OAuth provider schema (T-02)

`202609230100_better_auth_oauth_provider_schema.ts` is the MCP OAuth built-in
issuer expand. It sits after `202609220100_collection_readable_replicas` and
does not splice into the B1 four-file + MFA freeze chain.

It adds `auth_accounts.issuer` as nullable, backfills existing rows (credential
→ `local:credential`; siwe → `local:siwe`; Google → `https://accounts.google.com`;
other OAuth → `local:oauth:` + encodeURIComponent(providerId)), then applies
`NOT NULL` and
unique index `auth_accounts_issuer_accountId_uidx`. It also creates the T-01
reviewed tables `auth_jwks`, `auth_oauth_client`, `auth_oauth_resource`,
`auth_oauth_client_resource`, `auth_oauth_access_token`,
`auth_oauth_refresh_token`, `auth_oauth_consent`, and
`auth_oauth_client_assertion` (modelName prefix `auth_oauth_*`; JWKS is
`auth_jwks`).

N-1 binaries ignore the new column and tables. Production does not run down.
The developer-only down refuses with `down refused` and per-table `count(*)`
while any oauth/jwks row remains; empty oauth tables may drop even when
`auth_accounts` still has rows.

## Anonymous OAuth DCR capacity registry

`202609260600_oauth_dcr_registration_capacity.ts` adds
`auth_oauth_dcr_registration`. Pending rows are short-lived cross-replica
capacity reservations; finalized rows bind the reservation to the Better Auth
`clientId`. The runtime reclaims only finalized rows created under this policy,
past their unused-retention deadline, and with no consent/access/refresh-token
evidence. Pre-existing unowned clients are conservatively backfilled as
non-reclaimable so they count toward the hard cap without being auto-deleted.

The developer-only down refuses while registry rows remain. Deploy this expand
before an issuer-enabled binary, because anonymous DCR admission fails closed
when it cannot reserve database capacity.

## Session-owned DCR reservation occupancy

`202609270200_oauth_dcr_owned_reservation_owner.ts` adds nullable
`ownerUserId` on `auth_oauth_dcr_registration`. Pending owned reservations
set that column and `clientId IS NULL` so they count toward per-user and
global owned caps without entering the anonymous `ownerUserId IS NULL`
ledger. Developer-only down refuses while any owned occupancy row remains,
then drops the index and column.

## Accounts subject_id alignment backfill (T-03 / ADR D3)

`202609230200_accounts_subject_id_backfill.ts` sits after the T-02 OAuth
expand and does not splice into the B1 four-file + MFA freeze chain.

It dry-runs for collisions first: if a mapped account's target
`auth_user_id` is already another account's `subject_id`, the migration
`RAISE EXCEPTION`s and the DO block aborts (no partial apply). Mapped
rows then set `accounts.subject_id := auth_user_account_map.auth_user_id`.
Unmapped rows are not updated. A second `up` is a no-op when already
aligned. Developer-only `down` is a documented no-op — reversing would
steal later application writes.

## Subject id reference cascade (T-03 follow-up)

`202609230300_subject_id_reference_cascade.ts` sits after the T-03 accounts
backfill. It rewrites the denormalized Know-N subject copies that T-03 left
behind (`collections.owner_subject_id`, `collection_members.subject_id`,
invite/export/classify/blob/attachment owner columns) so they match the
mapped Better Auth user.id. When `payload_json` already has
`ownerSubjectId`, the same statement `jsonb_set`s that derived copy so
canonical collection writes do not fail closed on an owner mismatch.

`202609230400_collection_payload_owner_subject_id.ts` repairs environments
that already applied the original column-only cascade. It is a no-op when
the payload owner already matches the column.

`202609230500_collection_catalog_and_node_payloads.ts` then moves seed
catalog `tags` / `language` off the collection payload root into
`extensions`, rematerializes catalog-only collection payloads, and
backfills missing node payloads so Library node creates can lock.

Remap pairs come from still-mismatched `accounts.subject_id` rows, or from
leftover `account_identities` / `legacy_oidc_identity_archive` subjects that
still appear on those copies after T-03 already rewrote `accounts`. External
identity subjects are not rewritten. A colliding target, a colliding
membership pair, a live Sync Session bound to the old principal, or a
collection owner that still matches no account `RAISE EXCEPTION`s and the
DO block aborts. A second `up` is a no-op when copies already match.
Developer-only `down` is a documented no-op.

## Realign mapped account subject ids after later seed

`202609270100_realign_mapped_account_subject_ids.ts` re-runs the T-03
cascade. A later demo seed apply writes `sub-uNN` again after those
one-shot migrations have already finished, so MCP JWT `sub`
(`seed-auser-uNN`) no longer matches `accounts.subject_id`. Seed apply
also invokes the same cascade after the auth phase. `down` is a
documented no-op.
