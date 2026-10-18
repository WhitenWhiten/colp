import { setsAsidePullItem, syncFailureCode, classifySyncFailure } from './sync-failure-class.js';
import { readOpenSyncIssues, issueAncestry, dependsOnIssue } from './sync-issues.js';
import type { SyncPullEventV02, Warning } from '@know-n/colp/types';
import type { PullApplierOptions, PullNode } from './pull-applier-types.js';
import { mappingFor } from './pull-projection.js';
import { remoteDeleteMemberIds } from './remote-delete-policy.js';
import { SyncStateError, type PullIssueRecord, type SyncScope, type createSyncStateStore } from './sync-state-store.js';

type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

/**
 * B7: a record that fails the store's codec. With a subject (a remote node)
 * the failure is about that item, so the item is set aside; without one it
 * still stops the replica.
 */
export const ITEM_CODEC_CODES: ReadonlySet<string> = new Set(['bounded_string_invalid', 'secret_field_forbidden',
  'i_json_invalid', 'record_too_large']);

/** B6: past this many open Pull issues the replica stops; divergence is never silent or unbounded. */
export { OPEN_SYNC_ISSUE_CEILING as PULL_ISSUE_CEILING } from './sync-issue-ceiling.js';
/** The server's default Ack warning budget (`SYNC_ACK_MAX_WARNINGS`, `SYNC_ACK_MAX_WARNING_BYTES`). */
const ACK_WARNING_LIMIT = 8;
const ACK_WARNING_BYTES = 1_536;
const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;

interface Subject { readonly nodeId: string; readonly parentId?: string; readonly node?: PullNode;
  readonly deleted?: readonly string[] }

function subjectOf(event: OpEvent): Subject | null {
  const effect = event.effect;
  if (effect.kind === 'node_created' || effect.kind === 'node_restored' || effect.kind === 'node_moved') {
    return { nodeId: effect.node.id, parentId: effect.placement.parentId, node: effect.node };
  }
  if (effect.kind === 'node_content_updated') return { nodeId: effect.node.id, parentId: effect.node.parentId ?? undefined, node: effect.node };
  if (effect.kind === 'node_deleted') return { nodeId: effect.tombstone.targetId, deleted: remoteDeleteMemberIds(event) };
  if (effect.kind === 'subtree_deleted') {
    return { nodeId: effect.rootTombstone.targetId, deleted: [effect.rootTombstone.targetId, ...remoteDeleteMemberIds(event)] };
  }
  return null;
}

/**
 * Runs before a staged event touches the browser. An event about a node that
 * is already set aside, or placed inside one, is set aside with it. Deletes
 * use per-member protection and retain the issue evidence. A node whose record cannot be stored is set aside
 * here, before a browser call could leave an unmapped bookmark behind.
 * Returns true when the event is settled and must not be applied.
 */
export async function setAsidePullItem(options: PullApplierOptions, eventId: string, event: OpEvent,
  now: number): Promise<boolean> {
  const subject = subjectOf(event); if (!subject) return false;
    const excluded = new Set(event.operation.source?.adapterProfile === 'known-conflict-resolution'
    ? await options.store.conflictResolutionExemptions(options.scope, { payload: event }) : []);
  const issues = await readOpenSyncIssues(options.store, options.scope,
    { resolvingRestoreOpId: event.operation.opId, excludeQueueOpIds: excluded });
  const open = new Map(issues.pull.map(issue => [issue.nodeId, issue]));
  const node = subject.node; const title = typeof node?.title === 'string' ? node.title : undefined;
  const mappings = await options.store.listMappings(options.scope);
  const targets = [subject.nodeId, ...(subject.parentId ? [subject.parentId] : [])];
  if (!subject.deleted) {
    const pendingDelete = issues.deletes.find(row => row.restoreOpId !== event.operation.opId && dependsOnIssue(targets, new Set([row.targetId]), issueAncestry(mappings)));
    if (pendingDelete) {
      await options.store.deferPullForRemoteDelete(options.scope, eventId, pendingDelete.decisionId);
      return true;
    }
  }
  const self = open.get(subject.nodeId);
  if (self) {
    // Mapped deletes must reach the member executor: it retains issue nodes and
    // their ancestors while deleting independent members. Unmapped issues keep
    // their evidence until repair, even after the remote tombstone.
    if (subject.deleted && (event.effect.kind === 'subtree_deleted'
      || await options.store.getMappingByColpId(options.scope, subject.nodeId))) return false;
    await options.store.setAsidePullEvent(options.scope, eventId, { code: self.code, nodeId: self.nodeId, now });
    return true;
  }
  if (!subject.deleted) {
    const mappings = await options.store.listMappings(options.scope);
    const targets = [subject.nodeId, ...(subject.parentId ? [subject.parentId] : [])];
    if (dependsOnIssue(targets, issues.roots, issueAncestry(mappings, issues.queue))) {
      // A target or ancestor has an unresolved issue; keep the native state and dependency evidence.
      await options.store.setAsidePullEvent(options.scope, eventId, { code: 'parent_set_aside', nodeId: subject.nodeId,
        now, ...(title ? { title } : {}) });
      return true;
    }
  }
  if (!node || (node.kind !== 'bookmark' && node.kind !== 'folder')) return false;
  try {
    options.store.probeMappingRecord(options.scope, mappingFor(node, `probe:${node.id}`, null,
      subject.parentId ?? null, null, `probe:${node.id}`));
    return false;
  } catch (error) {
    if (!(error instanceof SyncStateError) || classifySyncFailure(error.code, { nodeId: node.id })?.class !== 'item') throw error;
    await options.store.setAsidePullEvent(options.scope, eventId, { code: error.code, nodeId: node.id, now,
      ...(title ? { title } : {}) });
    return true;
  }
}

/**
 * B5: an event that fails about its own node before its browser call changed
 * anything is set aside with that node; the rest of the page applies and the
 * cursor moves on. Only an event that entered this pass staged or prepared
 * qualifies, and it must still be in one of those states at failure. A started
 * browser call may already have changed the browser in this or an earlier pass. Any other failure keeps its class (`freezesPull` or retry).
 * Returns true when the event is settled.
 */
export async function setAsideFailedPullItem(options: PullApplierOptions,
  entered: { readonly eventId?: unknown; readonly state?: unknown }, event: OpEvent, error: unknown,
  now: number): Promise<boolean> {
  const code = syncFailureCode(error);
  const subject = subjectOf(event); const eventId = String(entered.eventId);
  if (!subject || !setsAsidePullItem(code, { nodeId: subject.nodeId, eventId }) || !['staged', 'intent_prepared'].includes(String(entered.state))) return false;
  const current = await options.store.getPullEvent(options.scope, eventId);
  if (!current || !['staged', 'intent_prepared'].includes(String(current.state))) return false;
  const title = typeof subject.node?.title === 'string' ? subject.node.title : undefined;
  await options.store.setAsidePullEvent(options.scope, eventId, { code, nodeId: subject.nodeId, now,
    ...(title ? { title } : {}) });
  return true;
}

/**
 * Each open Pull issue goes out as an Ack warning (`path: /nodes/{nodeId}`),
 * oldest first, within the server's default warning budget, so the server
 * learns what this replica did not take in. The engine fixes them with the
 * durable Ack intent; they join its id only when present, so a changed set is
 * a new intent, never a reused one.
 */
export async function pullAckWarnings(store: Pick<ReturnType<typeof createSyncStateStore>, 'listPullIssues'>,
  scope: SyncScope): Promise<Warning[]> {
  const issues = await store.listPullIssues(scope).catch((): PullIssueRecord[] => []);
  const warnings: Warning[] = [];
  for (const issue of [...issues].sort((left, right) => left.firstSeenAt - right.firstSeenAt)) {
    if (!OPAQUE.test(issue.nodeId)) continue;
    const warning: Warning = { code: ITEM_CODEC_CODES.has(issue.code) ? 'record_invalid' : 'apply_set_aside',
      message: 'This browser set this node aside and did not apply it.', nodeId: issue.nodeId,
      path: `/nodes/${issue.nodeId}` };
    if (warnings.length === ACK_WARNING_LIMIT
        || JSON.stringify([...warnings, warning]).length > ACK_WARNING_BYTES) break;
    warnings.push(warning);
  }
  return warnings;
}

