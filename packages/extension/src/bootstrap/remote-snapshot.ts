import type { Collection, SnapshotNode } from '@know-n/colp/types';
import { syncSnapshotV02 } from '../generated/pull-effect-validators.js';
import { colpCredentialHeaders } from '../auth-client.js';
import { assertCredentialHostPermission, SERVER_HOST_PERMISSION_ERROR } from '../server-origin-permission.js';
import { readBoundedJson } from '../json-response.js';
import { sessionTransportBudget } from '../colp-transport-budget-browser.js';
import type { SyncScope } from '../sync-state-store.js';
import type { StoredCredential, StoredSession } from '../types.js';
import type { DurableSyncSnapshot } from '../durable-sync-engine-types.js';
import { consumeSnapshotV02Pages, snapshotV02RejectMessage } from '../snapshot-v02-consume.js';
import { digest, type RemoteNodeFact } from './matcher.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface CompleteRemoteSnapshot {
  readonly classificationProjection?:{readonly collection:Collection;readonly nodes:readonly SnapshotNode[]};
  readonly snapshotId: string; readonly revision: string; readonly syncCursor: string;
  readonly remoteFacts: readonly RemoteNodeFact[]; readonly pageCount: number; readonly identityDigest: string;
}

export async function loadCompleteRemoteSnapshot(input: {
  readonly classificationProjection?:boolean;
  readonly endpoint: string; readonly credential: Pick<StoredCredential, 'accessToken'>;
  readonly session: StoredSession; readonly scope: SyncScope; readonly fetcher?: typeof fetch;
  /** The extension origin is supplied by the caller; never derive it from the server URL. */
  readonly origin: string;
  readonly requestTimeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}): Promise<CompleteRemoteSnapshot> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.origin !== input.scope.serverOrigin || endpoint.username || endpoint.password || endpoint.hash
      || endpoint.search) throw new Error('snapshot_endpoint_invalid');
  if (!input.origin || /[\r\n\0]/u.test(input.origin)) throw new Error('snapshot_origin_invalid');
  const timeoutMs = input.requestTimeoutMilliseconds ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('snapshot_timeout_invalid');
  }
  const fetcher = input.fetcher ?? fetch; const pages: DurableSyncSnapshot[] = []; const pageDigests: string[] = [];
  let classificationBytes=0;
  const nodes: SnapshotNode[] = []; const seen = new Set<string>(); let pageCursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const url = new URL(endpoint); url.searchParams.set('sessionId', input.session.sessionId);
    url.searchParams.set('limit', String(PAGE_LIMIT)); if (pageCursor) url.searchParams.set('pageCursor', pageCursor);
    let response: Response; const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = mergeSignals(input.signal, timeout.signal);
    const snapshotInit: RequestInit = { method: 'GET', redirect: 'error', cache: 'no-store',
      credentials: 'omit', signal, headers: { Accept: 'application/json',
        ...colpCredentialHeaders(input.credential.accessToken), 'Known-Sync-Session': input.session.sessionId,
        'Collection-Protocol-Version': '0.2', Origin: input.origin } };
    try {
      await assertCredentialHostPermission(url.toString(), snapshotInit);
      response = await fetcher(url.toString(), snapshotInit);
    } catch (error) {
      if (error instanceof Error && error.message === SERVER_HOST_PERMISSION_ERROR) throw error;
      if (timeout.signal.aborted && !input.signal?.aborted) throw new Error('snapshot_timeout');
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new Error('offline');
    } finally { clearTimeout(timer); }
    if (response.status !== 200 || !jsonContentType(response)) throw new Error(await snapshotProblemCode(response));
    const document = await readWithTimeout(response, sessionTransportBudget(input.session).snapshotPageBytes,
      timeoutMs, input.signal);
    if(input.classificationProjection){classificationBytes+=new TextEncoder().encode(JSON.stringify(document)).length;
      if(classificationBytes>4*1024*1024)throw new Error('local_projection_context_limit');}
    if (!syncSnapshotV02(document)) throw new Error('snapshot_invalid');
    const page = document as DurableSyncSnapshot;
    validatePage(page, input.scope, pageNumber, pages[0]);
    pages.push(page);
    const accumulated = consumeSnapshotV02Pages(pages);
    if (!accumulated.ok) throw new Error(snapshotV02RejectMessage(accumulated.code));
    for (const node of page.nodes) {
      if (seen.has(node.id)) throw new Error('snapshot_node_duplicate');
      seen.add(node.id); nodes.push(node);
    }
    if(input.classificationProjection&&nodes.length>10000)throw new Error('local_projection_context_limit');
    pageDigests.push(digest(document));
    if (!page.page.hasMore) {
      if (page.page.nextCursor !== null) throw new Error('snapshot_chain_invalid');
      break;
    }
    if (!page.page.nextCursor) throw new Error('snapshot_chain_invalid');
    pageCursor = page.page.nextCursor;
    if (pageNumber === MAX_PAGES - 1) throw new Error('payload_too_large');
  }
  const first = pages[0]; const last = pages.at(-1);
  if (!first || !last || last.page.hasMore || last.page.nextCursor !== null) throw new Error('snapshot_incomplete');
  const rootId = first.collection.rootNodeId; const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(rootId) || nodes.filter((node) => node.id === rootId).length !== 1) throw new Error('snapshot_root_invalid');
  const root = byId.get(rootId)!;
  if (root.kind !== 'root' || root.parentId !== null || root.position !== null || root.folderRole !== 'root') {
    throw new Error('snapshot_root_invalid');
  }
  for (const node of nodes) if (node.parentId !== null && !byId.has(node.parentId)) throw new Error('snapshot_graph_incomplete');
  const children = new Map<string, string[]>();
  for (const node of nodes) if (node.parentId !== null) {
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node.id); else children.set(node.parentId, [node.id]);
  }
  const reachable = new Set<string>(); const pending = [rootId];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!;
    if (reachable.has(current)) throw new Error('snapshot_graph_cycle');
    reachable.add(current); pending.push(...(children.get(current) ?? []));
  }
  if (reachable.size !== nodes.length) throw new Error('snapshot_graph_unreachable');
  const complete = consumeSnapshotV02Pages(pages);
  if (!complete.ok || !complete.complete) throw new Error(complete.ok ? 'snapshot_incomplete' : snapshotV02RejectMessage(complete.code));
  const childrenRevisions = complete.parentRevisions;
  return { ...(input.classificationProjection?{classificationProjection:{collection:first.collection,nodes}}:{}),snapshotId: first.snapshotId, revision: first.revision, syncCursor: first.syncCursor,
    remoteFacts: nodes.map((node) => remoteFact(node, childrenRevisions)), pageCount: pages.length,
    identityDigest: digest({ snapshotId: first.snapshotId, revision: first.revision,
      syncCursor: first.syncCursor, pageDigests }) };
}

function validatePage(page: DurableSyncSnapshot, scope: SyncScope, pageNumber: number,
  first?: DurableSyncSnapshot): void {
  if (!page.complete || page.mode !== 'sync' || page.protocolVersion !== '0.2'
      || page.collection.id !== scope.collectionId || page.collection.revision !== page.revision
      || page.annotations.length !== 0
      || page.attachments.length !== 0 || page.relations.length !== 0 || page.tombstones.length !== 0) {
    throw new Error('snapshot_semantic_invalid');
  }
  if (page.page.sequence !== pageNumber + 1
      || page.page.hasMore !== (page.page.nextCursor !== null)) throw new Error('snapshot_chain_invalid');
  for (const node of page.nodes) {
    if (node.collectionId !== scope.collectionId || (node.parentId === null) !== (node.id === page.collection.rootNodeId)
        || (node.id === page.collection.rootNodeId && (node.kind !== 'root' || node.position !== null))
        || (node.id === page.collection.rootNodeId && node.folderRole !== 'root')
        || (node.id !== page.collection.rootNodeId && typeof node.position !== 'string')) {
      throw new Error('snapshot_semantic_invalid');
    }
  }
  const parents = page.parentRevisions;
  if (new Set(parents.map((item) => item.parentId)).size !== parents.length
      || parents.some((item) => typeof item.parentId !== 'string' || typeof item.childrenRevision !== 'string')) {
    throw new Error('snapshot_parent_authority_invalid');
  }
  if (first && (first.snapshotId !== page.snapshotId || first.revision !== page.revision
      || first.syncCursor !== page.syncCursor || first.collection.rootNodeId !== page.collection.rootNodeId
      || first.collection.id !== page.collection.id || digest(first.collection) !== digest(page.collection))) {
    throw new Error('snapshot_identity_conflict');
  }
}

function remoteFact(node: SnapshotNode, childrenRevisions: ReadonlyMap<string, string>): RemoteNodeFact {
  const role = 'folderRole' in node && typeof node.folderRole === 'string' ? node.folderRole : undefined;
  return { nodeId: node.id, parentId: node.parentId,
    kind: node.kind === 'bookmark' ? 'bookmark' : node.kind === 'separator' ? 'separator' : 'folder',
    title: node.title ?? '', ...(node.url ? { url: node.url } : {}), ...(role ? { folderRole: role } : {}),
    ...(node.kind === 'folder' ? { description: node.description ?? null } : {}),
    ...(node.kind === 'bookmark' ? { tags: [...node.tags ?? []] } : {}),
    ...(node.kind === 'bookmark' && node.extensions && Object.keys(node.extensions).length ? { extensions: node.extensions } : {}),
    revision: node.revision, ...(node.position === null ? {} : { position: node.position }),
    ...(childrenRevisions.get(node.id) ? { childrenRevision: childrenRevisions.get(node.id)! } : {}),
    ...(node.visibility === 'protected' ? { managed: true } : {}) };
}

async function snapshotProblemCode(response: Response): Promise<string> {
  if (response.status === 401) return 'authentication_required';
  if (response.status === 429) return 'rate_limited';
  try {
    const problem = await readBoundedJson(response.clone(), 128 * 1024, 'snapshot_problem_invalid');
    const code = problem && typeof problem === 'object' && !Array.isArray(problem)
      ? (problem as { readonly code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : 'snapshot_failed';
  } catch { return 'snapshot_failed'; }
}

function jsonContentType(response: Response): boolean {
  return /^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '');
}

function mergeSignals(left: AbortSignal | undefined, right: AbortSignal): AbortSignal {
  if (!left) return right;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([left, right]);
  const controller = new AbortController(); const abort = () => controller.abort();
  if (left.aborted || right.aborted) { controller.abort(); return controller.signal; }
  left.addEventListener('abort', abort, { once: true }); right.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

async function readWithTimeout(response: Response, maxBytes: number, timeoutMs: number,
  signal: AbortSignal | undefined): Promise<unknown> {
  const body = readBoundedJson(response, maxBytes, 'snapshot_invalid');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('snapshot_timeout')), timeoutMs);
  });
  const aborted = signal ? new Promise<never>((_resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('The operation was aborted', 'AbortError')); return; }
    signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
  }) : undefined;
  try { return await Promise.race([body, timeout, ...(aborted ? [aborted] : [])]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
