import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import { assertLibraryDestination, createCanonicalMutationApplication } from '../../modules/collections/index.js';
import { createPostgresCanonicalMutationPorts } from '../collections/canonical-mutation-postgres-ports.js';
import { createPostgresNodeWritePort, createPostgresCollectionWritePort } from '../collections/repositories.js';
import { managedSavePorts, lockManagedLibrary } from './managed-copies.js';
import { parseManagedSave, parseManagedCopy, saveManagedCopy, recoverManagedCopy, observeManagedCopy, claimManagedSemantic, releaseManagedSemantic, type ManagedSaveState } from '../../modules/source-archives/index.js';
import { SOURCE_ARCHIVE_PROFILE, SourceArchiveError, object, text, integer, digest, sourceHash, parseSourceScope, parseSourceEdges, sourceInput, sourceConnectionKey,
  type SourceArchiveActor, type SourceArchiveApplication, type SourceScope, type SourceEdge, type SourceLease, type SourceFinalEffect, type SourceFinalReceipt, type SourceCanonicalMutation } from '../../modules/source-archives/index.js';
interface Connection { epoch: number; scope: SourceScope; lease: SourceLease | null }
interface Plan { sourceAccount: string; scope: SourceScope; epoch: number; digest: string; edges: SourceEdge[]; createdAt: number; receipt?: SourceFinalReceipt; cancelled?: boolean }
interface Binding { nodeId: string; parentId: string; title: string; url: string | null; revision: string }
interface State { version: 1; connections: Record<string, Connection>; plans: Record<string, Plan>; folders: Record<string, Binding>; copies: Record<string, Binding>; cancellations: Record<string, string>; managed?: ManagedSaveState }
const empty = (): State => ({ version: 1, connections: {}, plans: {}, folders: {}, copies: {}, cancellations: {} });
function reject(code: string, status = 409): never { throw new SourceArchiveError(code, status); }
const key = (...parts: unknown[]) => JSON.stringify(parts);
const own = <T>(r: Record<string, T>, k: string) => Object.hasOwn(r, k) ? r[k] : undefined;
/** One private account lock serializes epochs, logical reservations and immutable results.
 * Canonical mutations, revisions, audit, Sync invalidation and the result commit together. */
export function createPostgresSourceArchives(db: Kysely<DatabaseSchema>, testHooks: { afterCanonicalCreate?: () => void } = {}): SourceArchiveApplication {
  const uow = createUnitOfWork(db);
  return { async execute(actor, raw) {
    const body = object(raw, ['version', 'action', 'input']);
    if (body.version !== 1) reject('source_profile_unsupported', 422);
    const action = text(body.action);
    if (action === 'classify') reject('classification_unavailable', 422);
    return uow.execute(async ({ transaction: tx }) => {
      // Session → account → private receipt row → replica gate → replicas → collection.
      // Holding the authority rows through commit fences concurrent credential/replica revocation.
      if (['configure', 'renew', 'preview', 'commit', 'managed.save', 'managed.semantic.claim'].includes(action)) {
        const sessions = await tx.selectFrom('sync_sessions').select('session_id').where('account_id', '=', actor.accountId)
          .where('credential_id', '=', actor.credentialId).where('credential_issuer', '=', actor.credentialIssuer)
          .where('status', '=', 'active').where('expires_at', '>', new Date()).orderBy('session_id').forShare().execute();
        if (!sessions.length) reject('source_replica_unavailable', 403);
      }
      await tx.selectFrom('accounts').select('id').where('id', '=', actor.accountId).forShare().executeTakeFirstOrThrow();
      await sql`INSERT INTO source_archive_accounts(account_id,state_json) VALUES(${actor.accountId},${JSON.stringify(empty())}::jsonb) ON CONFLICT DO NOTHING`.execute(tx);
      const found = await sql<{ state_json: State }>`SELECT state_json FROM source_archive_accounts WHERE account_id=${actor.accountId} FOR UPDATE`.execute(tx);
      const state = found.rows[0]!.state_json;
      if (state.version !== 1) reject('source_schema_unsupported', 503);
      const account = await tx.selectFrom('accounts').select(['subject_id', 'status', 'deleted_at']).where('id', '=', actor.accountId).executeTakeFirst();
      if (!account || account.status !== 'active' || account.deleted_at || account.subject_id !== actor.subjectId) reject('source_account_unavailable', 403);
      const now = async () => Number((await sql<{ at: string }>`SELECT extract(epoch FROM clock_timestamp()) * 1000 AS at`.execute(tx)).rows[0]!.at);
      const start = await now();
      const run = async (): Promise<unknown> => {
        if (action === 'managed.lookup' || action === 'managed.semantic.claim' || action === 'managed.semantic.release') {
          const i = object(body.input, action === 'managed.lookup' ? ['collectionId', 'copy']
            : action === 'managed.semantic.claim' ? ['collectionId', 'copy', 'ownerId', 'replicaId'] : ['collectionId', 'copy', 'claim']);
          const collectionId = text(i.collectionId), copy = parseManagedCopy(i.copy);
          await lockManagedLibrary(tx, actor.subjectId, collectionId);
          const managed = state.managed ??= { bindings: {}, receipts: {} };
          const binding = await observeManagedCopy(managed, collectionId, { kind: 'bookmark', copy }, managedSavePorts(tx, actor.subjectId, actor.accountId));
          if (action === 'managed.lookup') return { binding };
          if (action === 'managed.semantic.claim') {
            await assertReplica(tx, actor, text(i.replicaId), collectionId);
            return claimManagedSemantic(managed, collectionId, copy, text(i.ownerId));
          }
          const claim = object(i.claim, ['ownerId', 'revision']);
          releaseManagedSemantic(managed, collectionId, copy, { ownerId: text(claim.ownerId), revision: integer(claim.revision) });
          return { released: true };
        }
        if (action === 'managed.save') {
          const command = parseManagedSave(body.input);
          await assertReplica(tx, actor, command.replicaId, command.collectionId);
          const managed = state.managed ??= { bindings: {}, receipts: {} };
          return saveManagedCopy(managed, command, managedSavePorts(tx, actor.subjectId, actor.accountId));
        }
        if (action === 'managed.recover') {
          const i = object(body.input, ['commandId', 'digest']);
          return { receipt: recoverManagedCopy(state.managed ?? { bindings: {}, receipts: {} }, text(i.commandId), digest(i.digest)) };
        }
        if (action === 'managed.list') {
          const i = object(body.input, ['collectionId', 'after']); text(i.collectionId);
          if (i.after !== null) text(i.after, 4096);
          const bindings = Object.entries(state.managed?.bindings ?? {}).filter(([key, b]) => b.collectionId === i.collectionId && (i.after === null || key > String(i.after)))
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
          const page = bindings.slice(0, 100);
          return { bindings: page.map(([key, value]) => ({ key, ...value })), nextCursor: bindings.length > page.length ? page.at(-1)![0] : null };
        }
        if (action === 'status') { object(body.input, []); return { profile: SOURCE_ARCHIVE_PROFILE, connections: Object.values(state.connections).map(c => ({ sourceAccount: c.scope.sourceAccount, site: c.scope.site, identityVersion: c.scope.identityVersion, epoch: c.epoch, scope: c.scope, lease: c.lease ? { replicaId: c.lease.replicaId, expiresAt: c.lease.expiresAt } : null })) }; }
        if (action === 'configure') {
          const i = object(body.input, ['scope', 'replicaId', 'expectedEpoch', 'approvalDigest']);
          const scope = parseSourceScope(i.scope), replicaId = text(i.replicaId), expected = integer(i.expectedEpoch, 0);
          if (digest(i.approvalDigest) !== sourceHash({ scope, replicaId, expectedEpoch: expected })) reject('source_approval_mismatch');
          await assertReplica(tx, actor, replicaId, scope.collectionId);
          await lockScope(tx, actor, scope);
          await assertReplica(tx, actor, replicaId, scope.collectionId);
          const old = own(state.connections, sourceConnectionKey(scope));
          if ((old?.epoch ?? 0) !== expected) reject('source_epoch_conflict');
          if (old?.lease && old.lease.expiresAt > start && old.lease.replicaId !== replicaId) reject('source_authority_busy');
          if (!old && Object.keys(state.connections).length >= 128) reject('source_capacity', 507);
          const lease = { epoch: expected + 1, token: randomUUID(), replicaId, expiresAt: start + SOURCE_ARCHIVE_PROFILE.leaseMs };
          state.connections[sourceConnectionKey(scope)] = { scope, epoch: lease.epoch, lease }; return { lease, scopeDigest: sourceHash(scope) };
        }
        if (action === 'revoke') {
          const { input: i, source } = sourceInput(body.input, ['sourceAccount', 'expectedEpoch']); const c = own(state.connections, sourceConnectionKey(source));
          if (!c || c.epoch !== integer(i.expectedEpoch, 0)) reject('source_epoch_conflict');
          c.epoch++; c.lease = null; return { epoch: c.epoch, revoked: true };
        }
        if (action === 'recover' || action === 'cancel') {
          const i = object(body.input, ['planId', 'digest']); const p = own(state.plans, text(i.planId));
          const planId = text(i.planId), hash = digest(i.digest), cancelled = own(state.cancellations, planId);
          if (cancelled && cancelled !== hash) reject('source_command_reused');
          if (!p) {
            if (action !== 'cancel' && !cancelled) reject('source_plan_missing', 404);
            if (!cancelled && Object.keys(state.plans).length + Object.keys(state.cancellations).length >= 5000) reject('source_capacity', 507);
            state.cancellations[planId] = hash; return { state: 'cancelled', receipt: null };
          }
          if (p.digest !== hash) reject('source_command_reused');
          // Read-only recovery survives revocation; it grants no reconstruction authority.
          if (action === 'cancel' && !p.receipt) p.cancelled = true;
          return { state: p.receipt ? 'committed' : p.cancelled ? 'cancelled' : 'prepared', receipt: p.receipt ?? null };
        }
        const { input: i, source } = sourceInput(body.input, action === 'preview' ? ['sourceAccount', 'lease', 'planId', 'edges', 'scopeDigest']
          : action === 'commit' ? ['sourceAccount', 'lease', 'planId', 'digest'] : action === 'renew' ? ['sourceAccount', 'lease'] : []);
        if (!['preview', 'commit', 'renew'].includes(action)) reject('source_action_unsupported', 422);
        const sourceAccount = source.sourceAccount, connectionKey = sourceConnectionKey(source), c = own(state.connections, connectionKey);
        if (!c) reject('source_connection_missing', 404);
        const l = object(i.lease, ['replicaId', 'epoch', 'token', 'expiresAt']);
        if (!c.lease || c.epoch !== l.epoch || c.lease.token !== l.token || c.lease.replicaId !== l.replicaId || c.lease.expiresAt <= start) reject('source_lease_revoked');
        await assertReplica(tx, actor, c.lease.replicaId, c.scope.collectionId);
        if (action === 'renew') { c.lease.expiresAt = start + SOURCE_ARCHIVE_PROFILE.leaseMs; return { lease: c.lease }; }
        const planId = text(i.planId); if (!/^[a-f0-9-]{36}$/.test(planId)) reject('invalid_source_command', 422);
        const previous = own(state.plans, planId);
        if (action === 'preview') {
          if (digest(i.scopeDigest) !== sourceHash(c.scope)) reject('source_scope_changed');
          const edges = parseSourceEdges(i.edges, c.scope), hash = sourceHash({ planId, sourceAccount, scope: c.scope, epoch: c.epoch, edges });
          const cancelled = own(state.cancellations, planId); if (cancelled) reject(cancelled === hash ? 'source_plan_cancelled' : 'source_command_reused');
          if (previous?.cancelled) reject('source_plan_cancelled');
          if (previous) { if (previous.digest !== hash) reject('source_command_reused'); return { planId, digest: hash, edges: previous.edges, expiresAt: previous.createdAt + 600_000 }; }
          if (Object.keys(state.plans).length + Object.keys(state.cancellations).length >= 5_000) reject('source_capacity', 507);
          await lockScope(tx, actor, c.scope);
          state.plans[planId] = { sourceAccount, scope: c.scope, epoch: c.epoch, digest: hash, edges, createdAt: start };
          return { planId, digest: hash, edges, expiresAt: start + 600_000 };
        }
        if (!previous || sourceConnectionKey(previous.scope) !== connectionKey || previous.sourceAccount !== sourceAccount || previous.digest !== digest(i.digest)) reject('source_command_reused');
        if (previous.receipt) return previous.receipt;
        if (previous.cancelled) reject('source_plan_cancelled');
        if (previous.epoch !== c.epoch || sourceHash(previous.scope) !== sourceHash(c.scope) || previous.createdAt + 600_000 <= start) reject('source_plan_stale');
        await lockScope(tx, actor, c.scope);
        await assertReplica(tx, actor, c.lease.replicaId, c.scope.collectionId);
        const reader = createPostgresNodeWritePort(tx), canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, {
          invalidateSyncReplicasOnNodeMutation: true, replicaLocksAlreadyHeld: () => true,
        }));
        const verify = async (binding: Binding) => {
          const n = await reader.getNode(c.scope.collectionId, binding.nodeId);
          if (!n || n.deletedAt || n.parentId !== binding.parentId || n.title !== binding.title || n.url !== binding.url || n.resourceRevision !== binding.revision) reject('source_representation_needs_review');
          return binding;
        };
        const mutations: SourceCanonicalMutation[] = [];
        const create = async (parentId: string, title: string, url: string | null): Promise<{ binding: Binding; operationId: string }> => {
          if (await now() >= c.lease!.expiresAt) reject('source_lease_expired');
          const nodeId = randomUUID(), operationId = randomUUID();
          const result = await canonical.execute({ transaction: tx }, {
            operationId, collectionId: c.scope.collectionId, actor: { principalId: actor.accountId, principalType: 'account' },
            intakeDisposition: 'userSelected', automationContext: { origin: 'import' },
            mutation: { action: 'create', target: { collectionId: c.scope.collectionId, resourceId: nodeId, resourceKind: 'node' }, parentId,
              fields: { kindFields: { kind: url === null ? 'folder' : 'bookmark', title, url, description: null, tags: [], visibility: 'inherit' }, extensions: {} } },
          });
          mutations.push({ kind: url === null ? 'folder' : 'bookmark', nodeId, parentId, operationId, resourceRevision: result.allocation.resourceRevision!, contentRevision: result.allocation.contentRevision!, commitOrdinal: String(result.allocation.commitOrdinal) });
          testHooks.afterCanonicalCreate?.();
          return { binding: { nodeId, parentId, title, url, revision: result.allocation.resourceRevision! }, operationId };
        };
        const effects: SourceFinalEffect[] = [];
        for (const e of previous.edges) {
          const root = c.scope.roots.find(r => r.ruleId === e.ruleId && r.collectionIds.includes(e.collectionId))!;
          const folderKey = key(connectionKey, c.scope.collectionId, root.nodeId, e.collectionId);
          let folder = own(state.folders, folderKey);
          const copyKey = c.scope.policy.copies === 'sourceAndSemantic' ? key(connectionKey, e.itemId, c.scope.collectionId, root.nodeId, e.collectionId) : key(connectionKey, e.itemId, 'single');
          const old = own(state.copies, copyKey);
          if (folder) await verify(folder);
          if (old) { if (!folder) reject('source_representation_needs_review'); await verify(old); effects.push({ itemId: e.itemId, collectionId: e.collectionId, ruleId: e.ruleId, nodeId: old.nodeId, finalParentId: old.parentId, resourceRevision: old.revision, operationId: null, disposition: 'reused' }); continue; }
          if (Object.keys(state.copies).length >= 50_000 || Object.keys(state.folders).length >= 10_000) reject('source_capacity', 507);
          if (folder) await verify(folder);
          else { folder = (await create(root.nodeId, e.collectionTitle, null)).binding; state.folders[folderKey] = folder; }
          const saved = await create(folder.nodeId, e.title, e.url); state.copies[copyKey] = saved.binding;
          effects.push({ itemId: e.itemId, collectionId: e.collectionId, ruleId: e.ruleId, nodeId: saved.binding.nodeId, finalParentId: folder.nodeId, resourceRevision: saved.binding.revision, operationId: saved.operationId, disposition: 'created' });
        }
        if (await now() >= c.lease!.expiresAt) reject('source_lease_expired');
        const receipt: SourceFinalReceipt = { version: 1, planId, digest: previous.digest, epoch: c.epoch, collectionId: c.scope.collectionId, classification: 'disabled', effects, effectDigest: sourceHash(effects), mutations, mutationsDigest: sourceHash(mutations) };
        previous.receipt = receipt; return receipt;
      };
      const result = await run(); const encoded = JSON.stringify(state);
      if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) reject('source_capacity', 507);
      await sql`UPDATE source_archive_accounts SET state_json=${encoded}::jsonb, updated_at=clock_timestamp() WHERE account_id=${actor.accountId}`.execute(tx);
      return result;
    });
  } };
}
async function assertReplica(tx: DatabaseTransaction, actor: SourceArchiveActor, replicaId: string, collectionId: string) {
  const replica = await tx.selectFrom('sync_replicas').select(['account_id', 'collection_id', 'status', 'lease_expires_at'])
    .where('replica_id', '=', replicaId).executeTakeFirst();
  const session = await tx.selectFrom('sync_sessions').select('session_id').where('replica_id', '=', replicaId).where('account_id', '=', actor.accountId).where('credential_id', '=', actor.credentialId).where('credential_issuer', '=', actor.credentialIssuer).where('status', '=', 'active').where('expires_at', '>', new Date()).executeTakeFirst();
  if (!session || !replica || replica.account_id !== actor.accountId || replica.collection_id !== collectionId || replica.status === 'retired' || replica.status === 'expired' || replica.lease_expires_at.getTime() <= Date.now()) reject('source_replica_unavailable', 403);
}
async function lockScope(tx: DatabaseTransaction, actor: SourceArchiveActor, scope: SourceScope) {
  await lockActiveSyncReplicasForCollection(tx, scope.collectionId);
  const collection = await createPostgresCollectionWritePort(tx).lockForUpdate(scope.collectionId);
  if (!collection || collection.deletedAt || collection.ownerSubjectId !== actor.subjectId) reject('source_root_unavailable', 403);
  const nodes = createPostgresNodeWritePort(tx);
  for (const root of scope.roots) {
    const n = await nodes.getNode(scope.collectionId, root.nodeId);
    if (!n || n.deletedAt || n.kind !== 'folder' || n.resourceRevision !== root.resourceRevision) reject('source_root_changed');
    await assertLibraryDestination({ nodes }, collection, n);
  }
}
