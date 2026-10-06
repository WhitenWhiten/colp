import type { StrictOperation } from '../types/strict.js';

/** Native browser change kinds understood by the Sync adapter boundary. */
export type SyncBrowserEventType = 'create' | 'update' | 'move' | 'delete';
export type SyncBrowserNodeKind = 'folder' | 'bookmark' | 'separator' | 'alias' | 'root';

const BROWSER_EVENT_TYPES: readonly SyncBrowserEventType[] = Object.freeze([
  'create',
  'update',
  'move',
  'delete',
]);
const BROWSER_NODE_KINDS: readonly SyncBrowserNodeKind[] = Object.freeze([
  'folder',
  'bookmark',
  'separator',
  'alias',
  'root',
]);

/**
 * A browser notification. Browsers are not required to emit one notification
 * per descendant when a folder is removed; the folder notification is the
 * complete deletion signal.
 */
export interface SyncBrowserEvent<NodeId = string> {
  readonly type: SyncBrowserEventType;
  readonly nodeId: NodeId;
  readonly nodeKind: SyncBrowserNodeKind;
  readonly reason?: string;
}

export interface SyncBrowserDeleteTranslation<NodeId = string> {
  readonly type: 'delete_node' | 'delete_subtree';
  readonly targetId: NodeId;
  readonly payload: { readonly reason?: string };
}

export interface SyncBrowserEventOperationContext {
  readonly opId: string;
  readonly replicaId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly collectionId: string;
  readonly baseRevision: string;
  readonly source?: { readonly adapterProfile?: string; readonly nativeEvent?: string };
}

function hasNodeId(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim().length === 0) return false;
  return true;
}

function isValidNodeKind(value: unknown): value is SyncBrowserNodeKind {
  return typeof value === 'string' && (BROWSER_NODE_KINDS as readonly string[]).includes(value);
}

function isValidEventType(value: unknown): value is SyncBrowserEventType {
  return typeof value === 'string' && (BROWSER_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Converts a browser delete notification to its authoritative Sync intent.
 * A Folder is always represented by `delete_subtree`, even when the browser
 * only emits the Folder event and emits no child events.
 */
export function translateSyncBrowserDelete<NodeId = string>(
  event: Pick<SyncBrowserEvent<NodeId>, 'nodeId' | 'nodeKind' | 'reason'>,
): SyncBrowserDeleteTranslation<NodeId> {
  if (event === null || typeof event !== 'object') {
    throw new TypeError('A browser delete event must be an object.');
  }
  if (!('nodeId' in event) || !hasNodeId(event.nodeId)) {
    throw new TypeError('A browser delete event must include a nodeId.');
  }
  if (!('nodeKind' in event) || !isValidNodeKind(event.nodeKind)) {
    throw new TypeError('A browser delete event must include a valid nodeKind.');
  }
  if (event.nodeKind === 'root') {
    throw new TypeError('A browser Root deletion cannot be translated to a Node delete operation.');
  }
  const type = event.nodeKind === 'folder' ? 'delete_subtree' : 'delete_node';
  return Object.freeze({
    type,
    targetId: event.nodeId,
    payload: Object.freeze(event.reason === undefined ? {} : { reason: event.reason }),
  });
}

/** Generic event-to-operation intent translation. Non-delete events retain their native kind. */
export function translateSyncBrowserEvent<NodeId = string>(
  event: SyncBrowserEvent<NodeId>,
): SyncBrowserDeleteTranslation<NodeId> | { readonly type: Exclude<SyncBrowserEventType, 'delete'>; readonly targetId: NodeId } {
  if (event === null || typeof event !== 'object') {
    throw new TypeError('A browser event must be an object.');
  }
  if (!('type' in event) || !isValidEventType(event.type)) {
    throw new TypeError('A browser event must include a valid type.');
  }
  if (event.type === 'delete') return translateSyncBrowserDelete(event);

  // create / update / move: fail closed on incomplete notification shape.
  if (!('nodeId' in event) || !hasNodeId(event.nodeId)) {
    throw new TypeError('A browser event must include a nodeId.');
  }
  if (!('nodeKind' in event) || !isValidNodeKind(event.nodeKind)) {
    throw new TypeError('A browser event must include a valid nodeKind.');
  }
  return Object.freeze({ type: event.type, targetId: event.nodeId });
}

/** Builds a complete StrictOperation for a browser delete notification. */
export function translateSyncBrowserDeleteOperation(
  event: Pick<SyncBrowserEvent<string>, 'nodeId' | 'nodeKind' | 'reason'>,
  context: SyncBrowserEventOperationContext,
): Extract<StrictOperation, { readonly type: 'delete_node' | 'delete_subtree' }> {
  const intent = translateSyncBrowserDelete(event);
  return Object.freeze({
    opId: context.opId,
    replicaId: context.replicaId,
    sequence: context.sequence,
    type: intent.type,
    occurredAt: context.occurredAt,
    collectionId: context.collectionId,
    targetId: intent.targetId,
    baseRevision: context.baseRevision,
    payload: intent.payload,
    ...(context.source === undefined ? {} : { source: context.source }),
  }) as Extract<StrictOperation, { readonly type: 'delete_node' | 'delete_subtree' }>;
}
