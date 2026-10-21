import { bookmarkRepresentability } from './bookmark-event-codec.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { JsonObject, MappingInput, SyncScope } from './sync-state-store.js';
import type { PullNode } from './pull-applier-types.js';
import { digest, plainJson } from './pull-codec.js';

export type ChromeBookmarkUrlRejection = 'unsupported_url_scheme' | 'invalid_url';

/** Same writable-URL contract as local capture. Empty is the missing-url projection, not a scheme. */
export function rejectedChromeBookmarkUrl(url: string | undefined): ChromeBookmarkUrlRejection | null {
  if (url === undefined || url === '') return null;
  const reason = bookmarkRepresentability({ type: 'bookmark', title: 'bookmark', url });
  if (reason === 'supported') return null;
  return reason === 'unsupported_url_scheme' ? reason : 'invalid_url';
}

export class PullChromeUrlRejected extends Error {
  readonly code: ChromeBookmarkUrlRejection;
  constructor(code: ChromeBookmarkUrlRejection) {
    super(code); this.name = 'PullChromeUrlRejected'; this.code = code;
  }
}

/** Folders and separators have no bookmark URL. A rejected bookmark URL must not be written. */
export function assertChromeBookmarkWrite(node: { readonly kind: string; readonly url?: string }): void {
  if (node.kind !== 'bookmark') return;
  const code = rejectedChromeBookmarkUrl(node.url);
  if (code) throw new PullChromeUrlRejected(code);
}

type AsideStore = {
  getPullEvent(scope: SyncScope, eventId: string): Promise<{ readonly state?: unknown } | null | undefined>;
  setAsidePullEvent(scope: SyncScope, eventId: string, issue: {
    readonly code: string; readonly nodeId: string; readonly title?: string; readonly now: number;
  }): Promise<void>;
};

/** One remote node, while its pull event is still staged or prepared. The rest of the page continues. */
export async function setAsideRejectedChromeUrl(store: AsideStore, scope: SyncScope, eventId: string,
  event: { readonly effect: object }, error: unknown, now: number): Promise<boolean> {
  if (!(error instanceof PullChromeUrlRejected)) return false;
  const node = (event.effect as { node?: { id?: unknown; title?: unknown } }).node;
  if (!node || typeof node.id !== 'string') return false;
  const current = await store.getPullEvent(scope, eventId);
  if (!current || (current.state !== 'staged' && current.state !== 'intent_prepared')) return false;
  const title = typeof node.title === 'string' && node.title ? node.title : undefined;
  await store.setAsidePullEvent(scope, eventId, { code: error.code, nodeId: node.id, now, ...(title ? { title } : {}) });
  return true;
}

export function nodeContent(node: PullNode): JsonObject {
  if (node.kind === 'root' || node.kind === 'alias') throw new SyncFailureError('pull_node_kind_invalid');
  return node.kind === 'separator' ? {} : node.kind === 'bookmark'
    ? { title: node.title, url: node.url ?? '' } : { title: node.title };
}

export function projectionContent(node: PullNode): JsonObject {
  const extensions = node.extensions ?? {};
  const folderRole = node.kind === 'folder' && 'folderRole' in node
    && typeof (node as { readonly folderRole?: unknown }).folderRole === 'string'
    ? (node as { readonly folderRole: string }).folderRole : undefined;
  return { ...nodeContent(node),
    ...(folderRole ? { folderRole } : {}),
    ...(node.visibility && node.visibility !== 'private' ? { visibility: node.visibility } : {}),
    ...(Object.keys(extensions).length ? { extensions: plainJson(extensions) } : {}),
    ...(node.kind === 'folder' || node.description ? { description: node.description ?? null } : {}),
    ...(node.kind === 'bookmark' || node.tags?.length ? { tags: [...node.tags ?? []] } : {}) };
}

export function nativeContent(content: JsonObject): JsonObject {
  return { ...(typeof content.title === 'string' ? { title: content.title } : {}),
    ...(typeof content.url === 'string' ? { url: content.url } : {}) };
}

export function nodeCreate(node: PullNode): JsonObject {
  if (node.kind === 'root' || node.kind === 'alias') throw new SyncFailureError('pull_node_kind_invalid');
  return { kind: node.kind, ...nodeContent(node) };
}

export function chromeCreate(node: PullNode) {
  if (node.kind === 'root' || node.kind === 'alias' || node.kind === 'separator') {
    throw new SyncFailureError('pull_node_kind_invalid');
  }
  assertChromeBookmarkWrite(node);
  return node.kind === 'bookmark' ? { title: node.title, url: node.url ?? '' } : { title: node.title };
}

export function mappingFor(node: PullNode, nativeId: string, parentNativeId: string | null,
  parentColpId: string | null, childrenRevision: string | null, rootNativeId: string): MappingInput {
  if (node.kind === 'root' || node.kind === 'alias') throw new SyncFailureError('pull_node_kind_invalid');
  return { nativeId, colpId: node.id, rootNativeId,
    nodeKind: node.kind, ...(parentNativeId ? { parentNativeId } : {}), ...(parentColpId ? { parentColpId } : {}),
    projection: { revision: node.revision, resourceRevision: node.revision, childrenRevision,
      digest: digest(nodeContent(node)), contentDigest: digest(projectionContent(node)),
      content: projectionContent(node) } };
}
