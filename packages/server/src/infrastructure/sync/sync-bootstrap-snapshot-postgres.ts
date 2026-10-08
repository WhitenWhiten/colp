import { createHash, createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AuthoritativeParentRevision, Collection, SnapshotNode,
} from '@know-n/colp/types';
import type { VerifiedExtensionCredential } from '../../modules/identity/index.js';
import {
  INITIAL_SYNC_PULL_PURGE_BOUNDARY, SyncBootstrapSnapshotError,
  assertSyncBootstrapSnapshotGraph, buildSyncRouteAuthorityContext,
  createSyncBootstrapSnapshotService, syncPullCursorContext,
  type AttachmentExposurePolicyPort, type SyncBootstrapAuthority,
  type SyncBootstrapAuthorityResult, type SyncPullCursorContext,
  type SyncPullCursorKeyring, type SyncPullTuple,
} from '../../modules/sync/index.js';
import { rollbackTransaction, type DatabaseRuntime } from '../database/index.js';
import { SNAPSHOT_COMPLETED_AT_SQL, snapshotExpiresAtSql } from './sync-bootstrap-snapshot-clock.js';
import { snapshotPageByteBudget } from './sync-transport-budget.js';
import { mapSnapshotCollection as mapCollection, mapSnapshotNode, SnapshotDocumentError, snapshotParentRevisions, withSnapshotBinding, type SnapshotCollectionRow as CollectionRow, type SnapshotNodeRow as NodeRow } from '../collections/snapshot-document.js';
import { cleanupExpiredSnapshots, insertSnapshotNodeRows } from './sync-bootstrap-snapshot-persist.js';
import {
  confirmSnapshotOpenConflicts, freezeSnapshotOpenConflicts, readSnapshotOpenConflictPage,
  readVisiblePullUpper,
} from './sync-snapshot-conflict-recovery.js';
import { SNAPSHOT_TREE_CAPACITY } from '../../modules/collections/index.js';
import {
  orderSnapshotNodesParentFirst, snapshotMaterializationIdentity,
} from '../../modules/sync/index.js';

interface AuthorityRow {
  session_id: string; account_id: string; collection_id: string; replica_id: string;
  lease_generation: string; expires_at: Date; session_status: string; replica_state: SyncBootstrapAuthorityResult['replicaState'];
  replica_generation: string; binding_mode: SyncBootstrapAuthorityResult['bindingMode'];
  content_revision: string; policy_revision: string; root_node_id: string;
  credential_issuer: string; credential_id: string; credential_subject: string;
  protocol_version: '0.1' | '0.2';
  lifecycle_revision: string;
  binding_json: Record<string, unknown>;
}

interface StoredRow {
  snapshot_id: string; session_id: string; collection_id: string; replica_id: string; lease_generation: string;
  policy_revision: string; content_revision: string; binding_mode: SyncBootstrapAuthorityResult['bindingMode'];
  binding_root_node_id: string; snapshot_json: SnapshotStoredDocument;
  bootstrap_cursor: string; cursor_key_id: string; generated_at: Date; expires_at: Date;
  /** FIX-M-014: 1 = legacy inline-document rows, 2 = header + numbered node rows. */
  storage_version: number;
  /** FIX-M-014: total persisted node count; set for storage_version 2 rows only. */
  node_count: number | null;
}

/**
 * FIX-M-014 (SYNC-R09): the persisted Snapshot document. v2 rows store the
 * small header (collection + parent revisions + nodeCount) in `snapshot_json`
 * and one immutable row per Node in `sync_bootstrap_snapshot_nodes`; legacy
 * v1 rows keep the full inline `nodes` array and stay readable (versioned
 * read) until they expire.
 */
interface SnapshotStoredDocument {
  collection: Collection;
  parentRevisions?: AuthoritativeParentRevision[];
  /** v2 header only: total node count of the persisted node rows. */
  nodeCount?: number;
  /** v1 legacy rows only: the full node list was stored inline. */
  nodes?: SnapshotNode[];
}

/**
 * FIX-M-014: auditable Snapshot size caps (node count and serialized document
 * bytes). T-10 / ADR-0027: these are the SAME aggregate support numbers the
 * write-side admission uses, so a tree that is accepted can always be
 * materialized; they are not a second, independently chosen limit.
 */
const DEFAULT_MAX_SNAPSHOT_NODES: number = SNAPSHOT_TREE_CAPACITY.maxNodes;
const DEFAULT_MAX_SNAPSHOT_BYTES: number = SNAPSHOT_TREE_CAPACITY.maxAggregateBytes;

export function createPostgresSyncBootstrapSnapshotApplication(
  runtime: Pick<DatabaseRuntime, 'pool'>,
  options: { readonly cursorSecret: string | Uint8Array; readonly cursorKeyId?: string; readonly cursorTtlMs?: number;
    readonly pullCursorKeyring?: SyncPullCursorKeyring;
    readonly recoveryProofRetentionMs?: number;
    readonly now?: () => number; readonly recovery?: {
      recordSnapshotPage(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string;
        readonly snapshotId: string; readonly sequence: number; readonly startOffset: number;
        readonly endOffset: number; readonly complete: boolean; readonly responseDigest: string }): Promise<unknown>;
      issueCapability(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string;
        readonly snapshotId: string }): Promise<string>;
    };
    /**
     * FIX-L-033 (SYNC-R17): the Sync attachment-projection policy port. The
     * composition adapter maps the attachments exposure-eligibility gate onto
     * it; a missing or throwing policy fails closed and the Snapshot
     * attachment projection stays empty.
     */
    readonly attachmentExposure: AttachmentExposurePolicyPort;
    /** FIX-M-014: maximum Nodes per materialised Snapshot (fail closed with payload_too_large). */
    readonly maxSnapshotNodes?: number;
    /** FIX-M-014: maximum serialized document bytes per materialised Snapshot. */
    readonly maxSnapshotBytes?: number;
  },
) {
  const maxSnapshotNodes = options.maxSnapshotNodes ?? DEFAULT_MAX_SNAPSHOT_NODES;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(maxSnapshotNodes) || maxSnapshotNodes < 1) throw new TypeError('Invalid Sync Snapshot node limit.');
  if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1) throw new TypeError('Invalid Sync Snapshot byte limit.');
  return Object.freeze({
    async listOpenConflicts(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string;
      readonly snapshotId: string; readonly offset: number; readonly limit: number }) {
      return withSnapshotClient(runtime.pool, async (client) => {
        const authority = await loadAuthority(client, input.sessionId, input.credential);
        if (!authority) throw new SyncBootstrapSnapshotError('resource_not_found');
        return readSnapshotOpenConflictPage(client, authority, input);
      });
    },
    async confirmOpenConflicts(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string;
      readonly snapshotId: string; readonly conflictDigest: string }) {
      return withSnapshotClient(runtime.pool, async (client) => {
        const authority = await loadAuthority(client, input.sessionId, input.credential);
        if (!authority) throw new SyncBootstrapSnapshotError('resource_not_found');
        return confirmSnapshotOpenConflicts(client, authority, input);
      });
    },
    async query(input: { readonly credential: VerifiedExtensionCredential; readonly request: import('@know-n/colp/types').SyncSnapshotQuery }) {
      try {
        if (options.pullCursorKeyring?.destroyed) throw new SyncBootstrapSnapshotError('service_unavailable');
        const authority = createPostgresAuthority(runtime, input.credential,
          options.cursorTtlMs ?? 900_000, options.cursorKeyId ?? 'v1', options.cursorSecret,
          options.pullCursorKeyring, options.recoveryProofRetentionMs, options.recovery,
          maxSnapshotNodes, maxSnapshotBytes);
        return await createSyncBootstrapSnapshotService({ authority, cursorSecret: options.cursorSecret, ...(options.cursorKeyId ? { cursorKeyId: options.cursorKeyId } : {}), ...(options.cursorTtlMs ? { cursorTtlMs: options.cursorTtlMs } : {}), ...(options.now ? { now: options.now } : {}), attachmentExposure: options.attachmentExposure }).query(input.request);
      } catch (error: unknown) {
        if (error instanceof SyncBootstrapSnapshotError) throw error;
        if (isExpectedSnapshotAuthorityConstraint(error)) throw new SyncBootstrapSnapshotError('stale_replica');
        throw error;
      }
    },
  });
}

function createPostgresAuthority(
  runtime: Pick<DatabaseRuntime, 'pool'>,
  credential: VerifiedExtensionCredential,
  ttl: number,
  cursorKeyId: string,
  cursorSecret: string | Uint8Array,
  pullCursorKeyring?: SyncPullCursorKeyring,
  recoveryProofRetentionMs?: number,
  recovery?: NonNullable<Parameters<typeof createPostgresSyncBootstrapSnapshotApplication>[1]['recovery']>,
  maxSnapshotNodes = DEFAULT_MAX_SNAPSHOT_NODES,
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
): SyncBootstrapAuthority {
  return Object.freeze({
    async load(input: { readonly sessionId: string; readonly snapshotId?: string; readonly limit: number;
      readonly offset?: number }) {
      const client = await runtime.pool.connect();
      let lockHeld = false;
      let releaseError: Error | undefined;
      try {
        await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [input.sessionId]);
        lockHeld = true;
        await client.query('begin isolation level repeatable read');
        const authority = await loadAuthority(client, input.sessionId, credential);
        if (!authority) throw new SyncBootstrapSnapshotError('resource_not_found');
        if (input.snapshotId) {
          const stored = await loadStored(client, input.snapshotId, authority, cursorKeyId,
            input.offset ?? 0, input.limit, false,
            snapshotPageByteBudget(authority.binding_json));
          await client.query('commit');
          return stored;
        }
        const databaseClock = await client.query<{ now: Date }>('select current_timestamp as now');
        const created = await materialize(client, authority, databaseClock.rows[0]!.now, ttl,
          cursorKeyId, cursorSecret, input.limit, pullCursorKeyring, recoveryProofRetentionMs,
          maxSnapshotNodes, maxSnapshotBytes);
        await client.query('commit');
        return created;
      } catch (error) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Sync bootstrap snapshot materialization');
        throw error;
      } finally {
        if (lockHeld) {
          try { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [input.sessionId]); }
          catch (error) { releaseError = error instanceof Error ? error : new Error('Failed to release Sync Snapshot lock'); }
        }
        client.release(releaseError);
      }
    },
    async markComplete(input: { readonly sessionId: string; readonly snapshotId: string }) {
      const client = await runtime.pool.connect();
      let lockHeld = false;
      let releaseError: Error | undefined;
      try {
        await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [input.sessionId]);
        lockHeld = true;
        await client.query('begin');
        const authority = await loadAuthority(client, input.sessionId, credential);
        if (!authority) throw new SyncBootstrapSnapshotError('authentication_required');
        if (authority.replica_state !== 'active' && authority.replica_state !== 'recovery_required') {
          throw new SyncBootstrapSnapshotError(authority.replica_state === 'retired' ? 'replica_retired' : 'stale_replica');
        }
        const result = await client.query(`update sync_bootstrap_snapshots set completed_at=${SNAPSHOT_COMPLETED_AT_SQL}
          where snapshot_id=$1 and session_id=$2 and account_id=$3 and collection_id=$4 and replica_id=$5
            and lease_generation=$6 and policy_revision=$7 and content_revision=$8
            and completed_at is null and expires_at>current_timestamp and ${SNAPSHOT_COMPLETED_AT_SQL}<expires_at`,
        [input.snapshotId, input.sessionId, authority.account_id, authority.collection_id, authority.replica_id,
          authority.replica_generation, authority.policy_revision, authority.content_revision]);
        if (result.rowCount !== 1) {
          const existing = await client.query(`select 1 from sync_bootstrap_snapshots
            where snapshot_id=$1 and session_id=$2 and account_id=$3 and collection_id=$4 and replica_id=$5
              and lease_generation=$6 and policy_revision=$7 and content_revision=$8
              and completed_at is not null and expires_at>current_timestamp`,
          [input.snapshotId, input.sessionId, authority.account_id, authority.collection_id, authority.replica_id,
            authority.replica_generation, authority.policy_revision, authority.content_revision]);
          if (existing.rowCount !== 1) throw new SyncBootstrapSnapshotError('snapshot_expired');
        }
        await client.query('commit');
      } catch (error) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Sync bootstrap snapshot completion');
        throw error;
      } finally {
        if (lockHeld) {
          try { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [input.sessionId]); }
          catch (error) { releaseError = error instanceof Error ? error : new Error('Failed to release Sync Snapshot completion lock'); }
        }
        client.release(releaseError);
      }
    },
    ...(recovery ? {
      async recordPage(input: { readonly sessionId: string; readonly snapshotId: string;
        readonly sequence: number; readonly startOffset: number; readonly endOffset: number;
        readonly complete: boolean; readonly responseDigest: string }) {
        await recovery.recordSnapshotPage({ credential, ...input });
      },
      async issueRecoveryCapability(input: { readonly sessionId: string; readonly snapshotId: string }) {
        return recovery.issueCapability({ credential, ...input });
      },
    } : {}),
  });
}

/**
 * Lock this session before `accounts`. Snapshot inserts take FOR KEY SHARE on
 * `sync_sessions`; retire, ack, and sequence already lock that row FOR UPDATE
 * first. Locking the account first deadlocks (40P01).
 */
export const SYNC_BOOTSTRAP_SNAPSHOT_SESSION_LOCK_SQL =
  `select session_id from sync_sessions where session_id=$1 for update`;

/** Lock `accounts` after the session row so a security_epoch bump during REPEATABLE READ waits or raises 40001. */
export const SYNC_BOOTSTRAP_SNAPSHOT_AUTHORITY_SQL = `select s.session_id,s.account_id,s.collection_id,s.replica_id,s.lease_generation::text,
      s.expires_at,s.status as session_status,s.protocol_version,s.binding_json,r.status as replica_state,r.lease_generation::text as replica_generation,
      r.lifecycle_revision::text,
      b.binding_mode,c.content_revision,c.policy_revision,c.root_node_id,
      s.credential_issuer,s.credential_id,ec.subject as credential_subject
    from sync_sessions s
    join sync_session_scopes sc on sc.session_id=s.session_id and sc.scope='sync:bootstrap'
    join sync_session_bindings b on b.session_id=s.session_id
    join sync_replicas r on r.replica_id=s.replica_id and r.account_id=s.account_id and r.collection_id=s.collection_id
    join collections c on c.id=s.collection_id and c.deleted_at is null
    join accounts a on a.id=s.account_id
    join sync_extension_credentials ec on ec.issuer=s.credential_issuer and ec.credential_id=s.credential_id and ec.account_id=s.account_id
    where s.session_id=$1 and s.credential_issuer=$2 and s.credential_id=$3 and ec.subject=$4
      and ec.credential_digest=$5 and ec.revoked_at is null and s.status='active'
      and s.expires_at > current_timestamp and s.lease_generation=r.lease_generation
      and s.policy_revision=c.policy_revision
      and a.status='active'
      and a.security_epoch=s.account_security_epoch
      and a.security_epoch=ec.security_epoch
      and ec.credential_expires_at > current_timestamp
      and (r.status='recovery_required' or (r.status='active' and r.lease_expires_at > current_timestamp
        and s.lifecycle_revision = r.lifecycle_revision))
    for update of a`;

/** After the session and account locks. Retire locks the replica only after the account. */
export const SYNC_BOOTSTRAP_SNAPSHOT_REPLICA_LOCK_SQL =
  `select replica_id from sync_replicas where replica_id=$1 for update`;

async function loadAuthority(client: PoolClient, sessionId: string, credential: VerifiedExtensionCredential): Promise<AuthorityRow | null> {
  await client.query(SYNC_BOOTSTRAP_SNAPSHOT_SESSION_LOCK_SQL, [sessionId]);
  const result = await client.query<AuthorityRow>(SYNC_BOOTSTRAP_SNAPSHOT_AUTHORITY_SQL,
    [sessionId, credential.issuer, credential.credentialId, credential.subject, credential.credentialDigest]);
  const row = result.rows[0];
  if (!row) return null;
  // A lifecycle bump that committed after this repeatable-read snapshot raises 40001 here.
  await client.query(SYNC_BOOTSTRAP_SNAPSHOT_REPLICA_LOCK_SQL, [row.replica_id]);
  return row;
}

async function materialize(
  client: PoolClient,
  authority: AuthorityRow,
  generatedAt: Date,
  ttl: number,
  cursorKeyId: string,
  cursorSecret: string | Uint8Array,
  pullLimit: number,
  pullCursorKeyring?: SyncPullCursorKeyring,
  recoveryProofRetentionMs?: number,
  maxSnapshotNodes = DEFAULT_MAX_SNAPSHOT_NODES,
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
): Promise<SyncBootstrapAuthorityResult> {
  const collectionResult = await client.query<CollectionRow>(`select id,kind,title,summary,visibility,root_node_id,content_revision,
      created_at,updated_at,payload_json from collections where id=$1 and content_revision=$2 and policy_revision=$3`,
  [authority.collection_id, authority.content_revision, authority.policy_revision]);
  const row = collectionResult.rows[0];
  if (!row) throw new SyncBootstrapSnapshotError('snapshot_expired');
  const nodeResult = await client.query<NodeRow>(`select id,collection_id,parent_id,kind,is_root,title,url,position_token,visibility,
      resource_revision,children_revision,created_at,updated_at,payload_json from nodes where collection_id=$1 and deleted_at is null`,
  [authority.collection_id]);
  const orderedRows = orderSnapshotNodesParentFirst(nodeResult.rows, (node) => ({
    id: node.id, parentId: node.parent_id, isRoot: node.is_root, kind: node.kind, positionToken: node.position_token,
  }));
  if (!orderedRows.ok) throw new Error('Authoritative Sync Snapshot graph is not a parent-first tree');
  const collection = withSnapshotBinding(mapCollection(row), authority.binding_mode, authority.root_node_id);
  const nodes = orderedRows.ordered.map(mapNode);
  const parentRevisions = snapshotParentRevisions(orderedRows.ordered);
  const identity = snapshotMaterializationIdentity({
    protocolVersion: authority.protocol_version, sessionId: authority.session_id, replicaId: authority.replica_id,
    leaseGeneration: authority.lease_generation, contentRevision: authority.content_revision,
    policyRevision: authority.policy_revision, rootNodeId: authority.root_node_id,
  });
  const snapshotId = `snap_${identity}`;
  const cursorFacts = pullCursorKeyring
    ? await initialPullCursor(client, authority, generatedAt, pullLimit, pullCursorKeyring,
      recoveryProofRetentionMs)
    : undefined;
  const bootstrapCursor = cursorFacts?.cursor ?? `boot_${createHmac('sha256', cursorSecret)
    .update(`sync-bootstrap-ack-v1:${cursorKeyId}:${identity}`).digest('base64url').slice(0, 32)}`;
  const materialized: SyncBootstrapAuthorityResult = {
    sessionId: authority.session_id, collectionId: authority.collection_id, replicaId: authority.replica_id,
    leaseGeneration: Number(authority.lease_generation), sessionExpiresAt: authority.expires_at.toISOString(),
    replicaState: authority.replica_state, bindingMode: authority.binding_mode,
    bindingRootNodeId: authority.root_node_id, contentRevision: authority.content_revision,
    policyRevision: authority.policy_revision, bootstrapCursor, collection, nodes, parentRevisions,
    protocolVersion: authority.protocol_version,
    snapshotId, generatedAt: generatedAt.toISOString(),
    nodeCount: nodes.length,
  };
  // FIX-M-014 (SYNC-R09): auditable Snapshot size caps; a collection that
  // exceeds them fails closed before any durable row is written.
  if (nodes.length > maxSnapshotNodes) throw new SyncBootstrapSnapshotError('payload_too_large');
  const documentBytes = Buffer.byteLength(JSON.stringify({ collection, nodes, parentRevisions }));
  if (documentBytes > maxSnapshotBytes) throw new SyncBootstrapSnapshotError('payload_too_large');
  assertSyncBootstrapSnapshotGraph(materialized, snapshotId, generatedAt.toISOString());
  await client.query(`insert into resource_id_ledger(resource_id,resource_type) values ($1,'sync_bootstrap_snapshot') on conflict do nothing`, [snapshotId]);
  await cleanupExpiredSnapshots(client, authority.collection_id, snapshotId);
  // FIX-M-014: v2 rows persist the small header in snapshot_json plus one
  // numbered immutable row per Node; legacy v1 rows keep the full document.
  const inserted = await client.query(`insert into sync_bootstrap_snapshots(snapshot_id,session_id,account_id,collection_id,replica_id,lease_generation,
      policy_revision,content_revision,binding_mode,binding_root_node_id,snapshot_json,bootstrap_cursor,cursor_key_id,
      generated_at,expires_at,recovery_pull_page_limit,storage_version,node_count)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,current_timestamp,${snapshotExpiresAtSql('$14')},$15,2,$16) on conflict(snapshot_id) do nothing`,
  [snapshotId, authority.session_id, authority.account_id, authority.collection_id, authority.replica_id, authority.lease_generation,
    authority.policy_revision, authority.content_revision, authority.binding_mode, authority.root_node_id,
    JSON.stringify({ collection, parentRevisions, nodeCount: nodes.length }), bootstrapCursor, cursorKeyId, ttl,
    authority.replica_state === 'recovery_required' && pullCursorKeyring ? pullLimit : null, nodes.length]);
  if (inserted.rowCount !== 1) {
    // The Snapshot already exists (identical identity facts): the stored row
    // is authoritative, including any legacy v1 row from before the migration.
    return loadStored(client, snapshotId, authority, cursorKeyId, 0, pullLimit, true,
      snapshotPageByteBudget(authority.binding_json));
  }
  await insertSnapshotNodeRows(client, snapshotId, nodes);
  if (cursorFacts) await freezeSnapshotOpenConflicts(client, snapshotId, authority.collection_id, cursorFacts.tuple);
  return { ...materialized,
    snapshotPageBytes: snapshotPageByteBudget(authority.binding_json) };
}

async function initialPullCursor(
  client: PoolClient, authority: AuthorityRow, generatedAt: Date, limit: number,
  keyring: SyncPullCursorKeyring, recoveryProofRetentionMs = 2_592_000_000,
): Promise<{ readonly cursor: string; readonly tuple: SyncPullTuple }> {
  const purgeResult = await client.query<{ commit_ordinal: string; stream_kind: number; stable_id: string }>(
    `select purged_through_commit_ordinal::text as commit_ordinal,
      purged_through_stream_kind as stream_kind,purged_through_stable_id as stable_id
    from sync_collection_purge_state where collection_id=$1`, [authority.collection_id],
  );
  const purgeRow = purgeResult.rows[0];
  const purgeBoundary: SyncPullTuple = purgeRow ? {
    commitOrdinal: purgeRow.commit_ordinal,
    streamKind: purgeRow.stream_kind === 0 ? 'operation' : 'conflict',
    stableId: purgeRow.stable_id,
  } : INITIAL_SYNC_PULL_PURGE_BOUNDARY;
  const upperTuple = await readVisiblePullUpper(
    (text, params) => client.query(text, params as never[]), authority.collection_id);
  const tuple = upperTuple && comparePullTuple(upperTuple, purgeBoundary) > 0
    ? upperTuple : purgeBoundary;
  const routeAuthority = buildSyncRouteAuthorityContext({ accountId: authority.account_id,
    collectionId: authority.collection_id, replicaId: authority.replica_id, sessionId: authority.session_id,
    leaseGeneration: authority.replica_state === 'recovery_required'
      ? (BigInt(authority.replica_generation) + 1n).toString() : authority.replica_generation,
    lifecycleRevision: authority.lifecycle_revision, policyRevision: authority.policy_revision,
    protocolVersion: authority.protocol_version });
  const context: SyncPullCursorContext = syncPullCursorContext(routeAuthority, purgeBoundary, limit);
  let cursor: string;
  try { cursor = keyring.sign({ ...context, tuple }); }
  catch { throw new SyncBootstrapSnapshotError('service_unavailable'); }
  const verified = keyring.verify(cursor, context);
  if (!verified.valid) throw new SyncBootstrapSnapshotError(verified.code, 'bootstrap_pull_cursor_keyring');
  const cursorDigest = createHash('sha256').update(cursor, 'utf8').digest('hex');
  const streamKind = tuple.streamKind === 'operation' ? 0 : 1;
  const purgeStreamKind = purgeBoundary.streamKind === 'operation' ? 0 : 1;
  // A recovery Snapshot stages the next-generation cursor in its immutable snapshot row.
  // Ack creates that generation and atomically activates evidence; before Ack the Session has no Pull scope.
  if (authority.replica_state === 'recovery_required') return { cursor, tuple };
  await client.query(`insert into sync_pull_cursor_evidence
    (cursor,cursor_digest,session_id,account_id,collection_id,replica_id,lease_generation,policy_revision,
     protocol_version,tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,cursor_expires_at,
     upper_commit_ordinal,upper_stream_kind,upper_stable_id,collection_revision,page_limit,
     purge_commit_ordinal,purge_stream_kind,purge_stable_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$10,$11,$12,$14,$15,$16,$17,$18)
    on conflict(replica_id,cursor_digest) do nothing`, [cursor, cursorDigest, authority.session_id,
    authority.account_id, authority.collection_id, authority.replica_id, authority.replica_generation,
    authority.policy_revision, authority.protocol_version, tuple.commitOrdinal, streamKind, tuple.stableId,
    new Date(verified.expiresAt), authority.content_revision, limit, purgeBoundary.commitOrdinal,
    purgeStreamKind, purgeBoundary.stableId]);
  const persisted = await client.query<{ cursor: string; session_id: string; collection_id: string }>(
    `select cursor,session_id,collection_id from sync_pull_cursor_evidence
      where replica_id=$1 and cursor_digest=$2`, [authority.replica_id, cursorDigest]);
  if (persisted.rows[0]?.cursor !== cursor || persisted.rows[0]?.session_id !== authority.session_id
      || persisted.rows[0]?.collection_id !== authority.collection_id) {
    throw new SyncBootstrapSnapshotError('internal_error');
  }
  const proofExpiresAt = new Date(Math.max(
    verified.expiresAt + 1,
    generatedAt.getTime() + recoveryProofRetentionMs,
  ));
  await client.query(`insert into sync_pull_cursor_recovery_proofs
    (cursor_digest,authority_session_id,authority_lifecycle_revision,account_id,collection_id,replica_id,
     lease_generation,policy_revision,protocol_version,page_limit,tuple_commit_ordinal,tuple_stream_kind,
     tuple_stable_id,upper_commit_ordinal,upper_stream_kind,upper_stable_id,purge_commit_ordinal,
     purge_stream_kind,purge_stable_id,cursor_expires_at,proof_expires_at,issued_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    on conflict(replica_id,cursor_digest) do nothing`, [cursorDigest, authority.session_id,
    authority.lifecycle_revision, authority.account_id, authority.collection_id, authority.replica_id,
    authority.replica_generation, authority.policy_revision, authority.protocol_version, limit,
    tuple.commitOrdinal, streamKind, tuple.stableId, purgeBoundary.commitOrdinal, purgeStreamKind,
    purgeBoundary.stableId, new Date(verified.expiresAt), proofExpiresAt, generatedAt]);
  const proof = await client.query<{ authority_session_id: string; lease_generation: string }>(
    `select authority_session_id,lease_generation::text from sync_pull_cursor_recovery_proofs
      where replica_id=$1 and cursor_digest=$2`, [authority.replica_id, cursorDigest]);
  if (proof.rows[0]?.authority_session_id !== authority.session_id
      || proof.rows[0]?.lease_generation !== authority.replica_generation) {
    throw new SyncBootstrapSnapshotError('invalid_cursor_scope', 'bootstrap_pull_recovery_proof');
  }
  return { cursor, tuple };
}

async function withSnapshotClient<T>(pool: { connect(): Promise<PoolClient> },
  run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await rollbackTransaction(error, () => client.query('rollback'), 'Sync snapshot conflict recovery');
    if (error instanceof SyncBootstrapSnapshotError) throw error;
    if (isExpectedSnapshotAuthorityConstraint(error)) throw new SyncBootstrapSnapshotError('stale_replica');
    throw error;
  } finally {
    client.release();
  }
}

async function loadStored(client: PoolClient, snapshotId: string, authority: AuthorityRow, cursorKeyId: string,
  offset: number, limit: number, full: boolean, snapshotPageBytes?: number): Promise<SyncBootstrapAuthorityResult> {
  const storedResult = await client.query<StoredRow>('select * from sync_bootstrap_snapshots where snapshot_id=$1 and session_id=$2 and expires_at>current_timestamp', [snapshotId, authority.session_id]);
  const stored = storedResult.rows[0];
  if (!stored) throw new SyncBootstrapSnapshotError('snapshot_expired');
  if (stored.cursor_key_id !== cursorKeyId) {
    throw new SyncBootstrapSnapshotError('invalid_cursor_scope', 'stored_snapshot_cursor_key');
  }
  if (stored.content_revision !== authority.content_revision || stored.policy_revision !== authority.policy_revision) throw new SyncBootstrapSnapshotError('snapshot_expired');
  if (stored.replica_id !== authority.replica_id || Number(stored.lease_generation) !== Number(authority.replica_generation)) throw new SyncBootstrapSnapshotError('stale_replica');
  const document = parseStoredDocument(stored.snapshot_json);
  if (Number(stored.storage_version) === 2) {
    const nodeCount = stored.node_count;
    if (nodeCount === null || !Number.isSafeInteger(nodeCount) || nodeCount < 0
        || document.nodeCount !== nodeCount) {
      throw new SyncBootstrapSnapshotError('internal_error');
    }
    const pageResult = await client.query<{ node_json: SnapshotNode }>(full
      ? `select node_json from sync_bootstrap_snapshot_nodes where snapshot_id=$1 order by node_index asc`
      : `select node_json from sync_bootstrap_snapshot_nodes where snapshot_id=$1 and node_index>=$2
          order by node_index asc limit $3`,
    full ? [snapshotId] : [snapshotId, offset, limit + 1]);
    const rows = pageResult.rows.map((row) => row.node_json);
    if (full) {
      if (rows.length !== nodeCount) throw new SyncBootstrapSnapshotError('internal_error');
      return result(authority, stored, document, rows, nodeCount, undefined, snapshotPageBytes);
    }
    const hasExtra = rows.length > limit;
    const pageNodes = hasExtra ? rows.slice(0, limit) : rows;
    if (offset > nodeCount || pageNodes.length < Math.min(limit, nodeCount - offset)) {
      throw new SyncBootstrapSnapshotError('internal_error');
    }
    return result(authority, stored, document, [], nodeCount, pageNodes, snapshotPageBytes);
  }
  // Legacy v1 row: the full document is stored inline; versioned read keeps
  // serving it exactly until the row expires (FIX-M-014).
  if (!Array.isArray(document.nodes)) throw new SyncBootstrapSnapshotError('internal_error');
  const legacyNodes = document.nodes;
  if (full) return result(authority, stored, document, legacyNodes, legacyNodes.length, undefined, snapshotPageBytes);
  const pageNodes = legacyNodes.slice(offset, offset + limit);
  if (offset > legacyNodes.length || pageNodes.length < Math.min(limit, legacyNodes.length - offset)) {
    throw new SyncBootstrapSnapshotError('internal_error');
  }
  return result(authority, stored, document, [], legacyNodes.length, pageNodes, snapshotPageBytes);
}

function parseStoredDocument(value: unknown): SnapshotStoredDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncBootstrapSnapshotError('internal_error');
  const document = value as SnapshotStoredDocument;
  if (!document.collection || typeof document.collection !== 'object' || Array.isArray(document.collection)) {
    throw new SyncBootstrapSnapshotError('internal_error');
  }
  if (document.nodes !== undefined && !Array.isArray(document.nodes)) throw new SyncBootstrapSnapshotError('internal_error');
  if (document.nodeCount !== undefined && (!Number.isSafeInteger(document.nodeCount) || document.nodeCount < 0)) {
    throw new SyncBootstrapSnapshotError('internal_error');
  }
  if (document.parentRevisions !== undefined && !Array.isArray(document.parentRevisions)) {
    throw new SyncBootstrapSnapshotError('internal_error');
  }
  return document;
}

function result(authority: AuthorityRow, stored: StoredRow, document: SnapshotStoredDocument,
  nodes: readonly SnapshotNode[], nodeCount: number,
  pageNodes?: readonly SnapshotNode[], snapshotPageBytes?: number): SyncBootstrapAuthorityResult {
  return Object.freeze({ sessionId: stored.session_id, collectionId: stored.collection_id, replicaId: stored.replica_id,
    leaseGeneration: Number(stored.lease_generation), sessionExpiresAt: authority.expires_at.toISOString(),
    replicaState: authority.replica_state, bindingMode: stored.binding_mode, bindingRootNodeId: stored.binding_root_node_id,
    contentRevision: stored.content_revision, policyRevision: stored.policy_revision, bootstrapCursor: stored.bootstrap_cursor,
    collection: structuredClone(document.collection),
    nodes: nodes.map((node) => structuredClone(node)),
    ...(pageNodes ? { pageNodes: pageNodes.map((node) => structuredClone(node)) } : {}),
    ...(document.parentRevisions ? { parentRevisions: structuredClone(document.parentRevisions) } : {}),
    nodeCount,
    protocolVersion: authority.protocol_version,
    snapshotId: stored.snapshot_id, generatedAt: stored.generated_at.toISOString(),
    ...(snapshotPageBytes === undefined ? {} : { snapshotPageBytes }) });
}

function comparePullTuple(left: SyncPullTuple, right: SyncPullTuple): number {
  const leftOrdinal = BigInt(left.commitOrdinal); const rightOrdinal = BigInt(right.commitOrdinal);
  if (leftOrdinal !== rightOrdinal) return leftOrdinal < rightOrdinal ? -1 : 1;
  const leftKind = left.streamKind === 'operation' ? 0 : 1;
  const rightKind = right.streamKind === 'operation' ? 0 : 1;
  if (leftKind !== rightKind) return leftKind < rightKind ? -1 : 1;
  return left.stableId < right.stableId ? -1 : left.stableId > right.stableId ? 1 : 0;
}

function isExpectedSnapshotAuthorityConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['23502', '23503', '23505', '23514', '23P01', '40001', '40P01'].includes(String(error.code));
}

function mapNode(row: NodeRow): SnapshotNode {
  try { return mapSnapshotNode(row); }
  catch (error) {
    if (error instanceof SnapshotDocumentError) throw new SyncBootstrapSnapshotError('internal_error', error.message);
    throw error;
  }
}
