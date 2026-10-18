import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { PullApplierOptions, PullNode } from './pull-applier-types.js';
import { mappingFor } from './pull-projection.js';
import { remoteDeleteMemberIds } from './remote-delete-policy.js';
import { SyncStateError } from './sync-state-store.js';

type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

/**
 * B7: a record that fails the store's codec. With a subject (a remote node)
 * the failure is about that item, so the item is set aside; without one it
 * still stops the replica.
 */
export const ITEM_CODEC_CODES: ReadonlySet<string> = new Set(['bounded_string_invalid', 'secret_field_forbidden',
  'i_json_invalid', 'record_too_large']);

interface Subject { readonly nodeId: string; readonly parentId?: string; readonly node?: PullNode;
  readonly deleted?: readonly string[] }

function subjectOf(event: OpEvent): Subject | null {
  const effect = event.effect;
  if (effect.kind === 'node_created' || effect.kind === 'node_restored' || effect.kind === 'node_moved') {
    return { nodeId: effect.node.id, parentId: effect.placement.parentId, node: effect.node };
  }
  if (effect.kind === 'node_content_updated') return { nodeId: effect.node.id, node: effect.node };
  if (effect.kind === 'node_deleted') return { nodeId: effect.tombstone.targetId, deleted: remoteDeleteMemberIds(event) };
  if (effect.kind === 'subtree_deleted') {
    return { nodeId: effect.rootTombstone.targetId, deleted: [effect.rootTombstone.targetId, ...remoteDeleteMemberIds(event)] };
  }
  return null;
}

/**
 * Runs before a staged event touches the browser. An event about a node that
 * is already set aside, or placed inside one, is set aside with it; a delete
 * of that node closes it. A node whose record cannot be stored is set aside
 * here, before a browser call could leave an unmapped bookmark behind.
 * Returns true when the event is settled and must not be applied.
 */
export async function setAsidePullItem(options: PullApplierOptions, eventId: string, event: OpEvent,
  now: number): Promise<boolean> {
  const subject = subjectOf(event); if (!subject) return false;
  const open = new Map((await options.store.listPullIssues(options.scope)).map((issue) => [issue.nodeId, issue]));
  const node = subject.node; const title = typeof node?.title === 'string' ? node.title : undefined;
  const self = open.get(subject.nodeId);
  if (self) {
    const resolveNodeIds = subject.deleted ? [...new Set(subject.deleted)].filter((id) => open.has(id)) : undefined;
    await options.store.setAsidePullEvent(options.scope, eventId, { code: self.code, nodeId: self.nodeId, now,
      ...(resolveNodeIds ? { resolveNodeIds } : {}) });
    return true;
  }
  if (subject.parentId !== undefined && open.has(subject.parentId)) {
    // Its folder is not in this browser, so it has nowhere to go; it waits as its own item.
    await options.store.setAsidePullEvent(options.scope, eventId, { code: 'parent_set_aside', nodeId: subject.nodeId,
      now, ...(title ? { title } : {}) });
    return true;
  }
  if (!node || (node.kind !== 'bookmark' && node.kind !== 'folder')) return false;
  try {
    options.store.probeMappingRecord(options.scope, mappingFor(node, `probe:${node.id}`, null,
      subject.parentId ?? null, null, `probe:${node.id}`));
    return false;
  } catch (error) {
    if (!(error instanceof SyncStateError) || !ITEM_CODEC_CODES.has(error.code)) throw error;
    await options.store.setAsidePullEvent(options.scope, eventId, { code: error.code, nodeId: node.id, now,
      ...(title ? { title } : {}) });
    return true;
  }
}
