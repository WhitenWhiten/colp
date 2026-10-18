import { buildAttentionReport } from './attention-report.js';
import { matchLocalRemote, bootstrapOpId, type LocalNodeFact, type RemoteNodeFact } from './matcher.js';
import type { ConfirmInput } from './coordinator.js';
import { digestJson, validateOperation } from '../bookmark-event-codec.js';
import type { BootstrapRunRecord, JsonObject, SyncScope, createSyncStateStore } from '../sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;
/** User-authorized local differences become ordinary authority-checked Push operations.
 * Deterministic IDs recover a worker interruption after any enqueue; no hint closes before rematching. */
export async function enqueueLocalMergeResolution(store: Store, scope: SyncScope, run: BootstrapRunRecord,
  input: ConfirmInput, itemId: string, evidenceDigest: string, assertCurrent?: () => Promise<void>) {
  const mappings = await store.listMappings(scope);
  const report = matchLocalRemote({ scopeKey: run.scopeKey, confirmationId: run.confirmationId,
    local: input.localFacts, remote: input.remoteFacts ?? [], mappings, mounts: input.mounts,
    rootNodeId: input.rootNodeId ?? null, bootstrapMode: 'merge', previewOnly: true });
  const current = buildAttentionReport(run, report, Date.now()).items.find(item => item.itemId === itemId);
  const item = run.attention?.items.find(item => item.itemId === itemId);
  if (!item || !current || current.evidenceDigest !== evidenceDigest || item.evidenceDigest !== evidenceDigest) throw new Error('bootstrap_confirmation_stale');
  const [nativeId, targetId] = current.nodeRefs ?? [];
  const local = input.localFacts.find(row => row.nativeId === nativeId);
  const remote = input.remoteFacts?.find(row => row.nodeId === targetId);
  if (!local || !remote || mappings.find(row => row.nativeId === nativeId)?.colpId !== targetId
      || local.managed || local.privateLocal || remote.managed) throw new Error('merge_identity_unproven');
  // input must be freshly scanned through the current selected/private boundary by the host.
  const operations = resolutionOperations(local, remote, input, mappings, itemId, evidenceDigest);
  const ids: string[] = [];
  for (const operation of operations) {
    const opId = String(operation.opId);
    await assertCurrent?.();
    await store.allocateSequenceAndEnqueue(scope, { opId, batchId: opId, idempotencyKey: opId,
      digest: 'sha256:pending', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: remote.revision, operationRevision: `local-${opId}`, status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload: operation },
    { validateOperation, digestOperation: digestJson });
    ids.push(opId);
  }
  return ids;
}
function resolutionOperations(local: LocalNodeFact, remote: RemoteNodeFact, input: ConfirmInput,
  mappings: readonly { nativeId: string; colpId: string }[], itemId: string, evidence: string): JsonObject[] {
  const operations: JsonObject[] = []; const occurredAt = new Date().toISOString();
  const base: Record<string, string | null> = {}; const value: Record<string, string | null> = {};
  if (local.title !== remote.title) { base.title = remote.title; value.title = local.title; }
  if (local.kind === 'bookmark' && local.url !== remote.url) { base.url = remote.url ?? null; value.url = local.url ?? ''; }
  const op = (type: string, payload: JsonObject) => ({ type, opId: bootstrapOpId(itemId, type, evidence),
    targetId: remote.nodeId, baseRevision: remote.revision, occurredAt, dependencies: [], payload });
  if (Object.keys(value).length) operations.push(op('update_node_content', { base, value }));
  const parentId = mappings.find(row => row.nativeId === local.parentNativeId)?.colpId;
  if (parentId && parentId !== remote.parentId) {
    const source = input.remoteFacts?.find(row => row.nodeId === remote.parentId);
    const target = input.remoteFacts?.find(row => row.nodeId === parentId);
    if (!source?.childrenRevision || !target?.childrenRevision || target.folderRole === 'root') throw new Error('merge_parent_unavailable');
    operations.push(op('move_node', { newParentId: parentId, baseSourceParentRevision: source.childrenRevision,
      baseTargetParentRevision: target.childrenRevision }));
  }
  return operations;
}
